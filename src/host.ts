/**
 * The bring-your-own-object-model seam.
 *
 * The engine has zero I/O and zero ambient authority; everything a template
 * can see arrives through this interface: a TypeRegistry (declared object
 * model), host filters (typed, taint-flagged), and data resolved by the host
 * from an AccessPlan the engine extracts statically.
 *
 * Security split: the ENGINE guarantees termination, escaping and no ambient
 * authority; the HOST guarantees authorization and data scoping.
 *
 * `Html` is not host-declarable as a data type — the only producers are host
 * filters, and each must declare which of three obligations it takes on. The
 * template author cannot introduce an unescaped sink, choose one, or opt out of
 * escaping at a call site; that decision is fixed at embed time.
 */
import {
  groupSlotChildren,
  type CallArg,
  type Expr,
  type Node,
  type Program,
  type Template,
} from './ast';
import { type Type, type TypeRegistry } from './types';
import { STDLIB } from './stdlib';

// ---------------------------------------------------------------------------
// Host filters
// ---------------------------------------------------------------------------

/**
 * An optional parameter of a host filter.
 *
 * Optional parameters are NAMED because their order is the thing that rots.
 * A filter grows `width`, then `crop`, then `quality`, and every theme in the
 * wild has already frozen the positions; `img(x, 800, 2, true)` then means
 * whatever the fourth slot happened to be. Names let a call site say which knob
 * it is turning, and let the host add a knob without renumbering the others.
 *
 * Required parameters are deliberately NOT named: there are few of them, they
 * are the subject of the call, and `truncate(text: body, length: 40)` is
 * ceremony, not clarity.
 */
export interface HostFilterParam {
  /** camelCase; this is the name a template writes before the `:`. */
  name: string;
  type: Type;
}

export interface HostFilterDecl {
  /** camelCase filter name; must not collide with the stdlib. */
  name: string;
  params: readonly Type[];
  optionalParams?: readonly HostFilterParam[];
  returns: Type;

  /*
   * Exactly one of the three flags below is REQUIRED when `returns` is Html,
   * and none is valid otherwise.
   *
   * One flag used to cover all of this, which conflated risks that call for
   * different responses. A filter that sanitizes untrusted input is the
   * sanctioned path and should be silent; a filter that passes through markup
   * the host has decided to trust is the one a reviewer must actually look at.
   * Warning on both trains everyone to ignore the warning.
   *
   * Each flag names a distinct obligation the HOST takes on:
   */

  /**
   * Input is untrusted; output is safe by construction because this filter
   * sanitizes it.
   *
   * **Obligation: actually sanitize.** The engine cannot verify this and does
   * not try — it is the host's assertion, made once at embed time.
   *
   * Use sites are not warned: this is the sanctioned path, and a diagnostic on
   * correct code is noise that devalues the diagnostics that matter.
   */
  sanitizer?: true;

  /**
   * Input is trusted by host fiat and emitted raw, without sanitization.
   *
   * **Obligation: ensure the input is trusted** — that it comes from a source
   * the host controls, not from a merchant, a customer, or a model.
   *
   * Every use site is warned (`O2071` at check time, `O4902` at render time).
   * That warning list is the audit surface for unescaped output.
   */
  trustedHtml?: true;

  /**
   * Html in, Html out: a transform over markup whose trust was already
   * established upstream by a `sanitizer` or `trustedHtml` filter.
   *
   * **Obligation: preserve well-formedness.** This is not a formality. Naive
   * truncation slices mid-tag and yields `<a href="` — which does not merely
   * lose content, it changes how everything after it parses. The conformance
   * suite checks this obligation with a real HTML parser rather than leaving
   * it to documentation.
   *
   * Use sites are not warned: the trust decision was made upstream, and this
   * filter adds no new one.
   */
  htmlTransform?: true;

  impl(args: readonly unknown[]): unknown;
}

/**
 * Why a call site's arguments do not bind to a filter's parameters.
 *
 * `index` is an index into the WRITTEN argument list, so a diagnostic can point
 * at the argument the author typed rather than at a slot number they never saw.
 */
export type ArgBindProblem =
  | { kind: 'tooFew'; min: number; got: number }
  | { kind: 'tooMany'; max: number; got: number }
  | { kind: 'unknownName'; index: number }
  /** `slot` was already filled by written argument `firstIndex`. */
  | { kind: 'duplicate'; index: number; slot: number; firstIndex: number };

/**
 * `slotOf[i]` is the parameter slot written argument `i` fills. Slots run
 * `params` first, then `optionalParams`.
 */
export type ArgBinding =
  | { ok: true; slotOf: readonly number[] }
  | { ok: false; problem: ArgBindProblem };

/**
 * Bind a call site's arguments to a host filter's parameters.
 *
 * Shared by the checker and the interpreter on purpose. If the two computed
 * slots independently they could disagree, and a disagreement here means an
 * argument type-checked in one position and was passed in another — the kind of
 * bug that produces a correctly-typed program with wrong output.
 */
export function bindHostFilterArgs(decl: HostFilterDecl, args: readonly CallArg[]): ArgBinding {
  const min = decl.params.length;
  const optional = decl.optionalParams ?? [];
  const max = min + optional.length;

  const slotOf: number[] = [];
  const filledBy: (number | undefined)[] = new Array<number | undefined>(max).fill(undefined);
  let positional = 0;

  for (let i = 0; i < args.length; i += 1) {
    const label = args[i]?.label;
    if (label === undefined) {
      slotOf.push(positional);
      if (positional < max) filledBy[positional] = i;
      positional += 1;
      continue;
    }
    const which = optional.findIndex((p) => p.name === label.name);
    if (which < 0) return { ok: false, problem: { kind: 'unknownName', index: i } };
    const slot = min + which;
    const firstIndex = filledBy[slot];
    if (firstIndex !== undefined) {
      return { ok: false, problem: { kind: 'duplicate', index: i, slot, firstIndex } };
    }
    filledBy[slot] = i;
    slotOf.push(slot);
  }

  // Arity is judged on POSITIONAL count: named arguments each land in a
  // distinct optional slot, so they can neither overflow nor satisfy a
  // required parameter.
  if (positional > max) return { ok: false, problem: { kind: 'tooMany', max, got: positional } };
  if (positional < min) return { ok: false, problem: { kind: 'tooFew', min, got: positional } };
  return { ok: true, slotOf };
}

/** The declared type of parameter `slot`, or undefined if there is no such slot. */
export function paramTypeAt(decl: HostFilterDecl, slot: number): Type | undefined {
  const required = decl.params[slot];
  if (required !== undefined) return required;
  return decl.optionalParams?.[slot - decl.params.length]?.type;
}

/** How to refer to parameter `slot` in a message: its name if it has one. */
export function describeParam(decl: HostFilterDecl, slot: number): string {
  const optional = decl.optionalParams?.[slot - decl.params.length];
  return optional !== undefined ? `\`${optional.name}\`` : `argument ${slot + 1}`;
}

/** The names a call site may use, in declaration order. */
export function namedParamsOf(decl: HostFilterDecl): readonly string[] {
  return (decl.optionalParams ?? []).map((p) => p.name);
}

/** The three Html obligations, in declaration order. */
const HTML_FLAGS = ['sanitizer', 'trustedHtml', 'htmlTransform'] as const;

/** Which Html obligation a filter declared, if any. */
export type HtmlObligation = (typeof HTML_FLAGS)[number];

export function htmlObligationOf(decl: HostFilterDecl): HtmlObligation | undefined {
  return HTML_FLAGS.find((flag) => decl[flag] === true);
}

/** True when a filter's Html output must be warned about at every use site. */
export function warnsAtUseSite(decl: HostFilterDecl): boolean {
  return decl.trustedHtml === true;
}

function containsHtmlType(type: Type): boolean {
  switch (type.kind) {
    case 'html':
      return true;
    case 'optional':
      return containsHtmlType(type.inner);
    case 'list':
      return containsHtmlType(type.element);
    case 'record':
      return Object.values(type.fields).some(containsHtmlType);
    default:
      return false;
  }
}

function isCamelCaseIdent(name: string): boolean {
  const first = name[0];
  if (first === undefined || first < 'a' || first > 'z') return false;
  for (let i = 1; i < name.length; i += 1) {
    const c = name[i] ?? '';
    const ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    if (!ok) return false;
  }
  return true;
}

/**
 * Host-programming-error validation (throws — these are bugs in the embedder,
 * not template diagnostics).
 */
export function assertValidHostFilters(decls: readonly HostFilterDecl[]): void {
  const seen = new Set<string>();
  for (const d of decls) {
    if (!isCamelCaseIdent(d.name)) {
      throw new Error(`host filter names are camelCase identifiers (got ${JSON.stringify(d.name)})`);
    }
    if (STDLIB.has(d.name)) {
      throw new Error(`host filter ${JSON.stringify(d.name)} collides with a stdlib filter`);
    }
    if (seen.has(d.name)) {
      throw new Error(`duplicate host filter ${JSON.stringify(d.name)}`);
    }
    seen.add(d.name);

    const declared = HTML_FLAGS.filter((flag) => d[flag] === true);
    const obligation = declared[0];

    /*
     * Html as a PARAMETER is permitted in exactly one shape: the first
     * parameter of an `htmlTransform` filter. Everywhere else it stays banned,
     * because a filter taking Html anywhere else is asking to interleave
     * trusted markup with untrusted arguments — precisely the confusion the
     * type exists to prevent.
     */
    const optional = d.optionalParams ?? [];
    const optionalNames = new Set<string>();
    for (const p of optional) {
      if (!isCamelCaseIdent(p.name)) {
        throw new Error(
          `host filter ${JSON.stringify(d.name)}: optional parameter names are camelCase identifiers (got ${JSON.stringify(p.name)})`,
        );
      }
      if (optionalNames.has(p.name)) {
        throw new Error(
          `host filter ${JSON.stringify(d.name)}: duplicate optional parameter ${JSON.stringify(p.name)}`,
        );
      }
      optionalNames.add(p.name);
    }

    d.params.forEach((p, i) => {
      const isTransformSubject = obligation === 'htmlTransform' && i === 0;
      if (isTransformSubject) {
        if (p.kind !== 'html') {
          throw new Error(
            `host filter ${JSON.stringify(d.name)}: htmlTransform requires its first parameter to be Html`,
          );
        }
        return;
      }
      if (containsHtmlType(p)) {
        throw new Error(
          `host filter ${JSON.stringify(d.name)}: Html may only be the first parameter, and only on an htmlTransform filter`,
        );
      }
    });
    for (const p of optional) {
      if (containsHtmlType(p.type)) {
        throw new Error(
          `host filter ${JSON.stringify(d.name)}: Html cannot be an optional parameter type`,
        );
      }
    }

    if (d.returns.kind === 'html') {
      if (declared.length === 0) {
        throw new Error(
          `host filter ${JSON.stringify(d.name)} returns Html and must declare exactly one of ` +
            `sanitizer, trustedHtml or htmlTransform — see HostFilterDecl for what each obligates the host to`,
        );
      }
      if (declared.length > 1) {
        throw new Error(
          `host filter ${JSON.stringify(d.name)} declares ${declared.join(' and ')}; exactly one is allowed ` +
            `(they name different obligations, so claiming two states nothing)`,
        );
      }
      if (obligation === 'htmlTransform' && d.params.length === 0) {
        throw new Error(
          `host filter ${JSON.stringify(d.name)}: htmlTransform takes Html and returns Html, so it needs an Html first parameter`,
        );
      }
    } else if (containsHtmlType(d.returns)) {
      throw new Error(`host filter ${JSON.stringify(d.name)}: Html may only be the top-level return type`);
    } else if (declared.length > 0) {
      throw new Error(
        `host filter ${JSON.stringify(d.name)}: ${declared.join(' and ')} ${declared.length > 1 ? 'are' : 'is'} only valid on an Html-returning filter`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Html runtime brand
// ---------------------------------------------------------------------------

/** Runtime carrier for Html values so a plain string can never be emitted raw. */
export interface HtmlValue {
  readonly __orbitHtml: string;
  /**
   * Set when the value came from a `trustedHtml` filter.
   *
   * The obligation travels WITH the value rather than being looked up at the
   * emit site, because an Html value can now cross a component prop boundary
   * and the interpreter has no way to ask, at the point of emission, which
   * filter produced something three components ago.
   */
  readonly __orbitTrusted?: true;
}

/**
 * Brand a string as Html.
 *
 * Called by the engine on a declared-Html filter's return value; a host filter
 * `impl` returns a plain string and the engine brands it. The name carries no
 * "unsafe" warning because the obligation lives on the DECLARATION — the flag
 * says which promise the host made, and this only carries the result.
 */
export function htmlValue(html: string, trusted = false): HtmlValue {
  return trusted ? { __orbitHtml: html, __orbitTrusted: true } : { __orbitHtml: html };
}

export function isHtmlValue(v: unknown): v is HtmlValue {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { __orbitHtml?: unknown }).__orbitHtml === 'string'
  );
}

// ---------------------------------------------------------------------------
// The host interface
// ---------------------------------------------------------------------------

export interface OrbitHost {
  registry: TypeRegistry;
  filters: readonly HostFilterDecl[];
  /** Types of the top-level bindings available to `page` templates. */
  pageGlobals?: Record<string, Type>;
}

// ---------------------------------------------------------------------------
// AccessPlan extraction (declare-then-fetch)
// ---------------------------------------------------------------------------

/**
 * The exact data paths a render will touch, extracted statically. Soundness
 * rests on the language having NO dynamic member access: every path a
 * template can read is spelled out in the AST. `[]` marks element traversal.
 *
 * SOUNDNESS CONTRACT (v0.5 LSP completions and later fragment-cache keys
 * depend on it): the plan may OVER-approximate — naming a path the render
 * turns out not to read is a wasted fetch — but it must never
 * UNDER-approximate, because a host fetches exactly what the plan names and a
 * missing path renders as a hole (or an O4012 failure).
 *
 * `**` is the one wildcard: `products.**` means "every path under
 * `products`". It appears only when filter chaining exceeds the internal base
 * cap, which no realistic template reaches; it exists so the extractor can
 * degrade to over-approximation instead of silently dropping paths.
 */
export interface AccessPlan {
  paths: readonly string[];
}

/**
 * A symbolic value origin: the set of data paths this expression could have
 * come from. Empty = opaque (a literal, a scalar filter result, `settings`).
 *
 * A SET, not a single path, because filters erase the list/element
 * distinction: `first(products)` is `products[]` but `sortBy(products,"x")`
 * is still `products`, and the extractor cannot tell which without a
 * per-filter effect table it would have to keep in sync with every host
 * filter. Carrying both candidates keeps the result sound for either.
 */
type Sym = readonly string[];

const OPAQUE: Sym = [];

/** Filter chaining doubles the base set; past this we degrade to `base.**`. */
const MAX_SYM_BASES = 16;

/** `products` → `products[]`; a wildcard already covers its own elements. */
function elementOf(base: string): string {
  return base.endsWith('.**') ? base : `${base}[]`;
}

class PlanExtractor {
  private readonly paths = new Set<string>();
  /**
   * True while walking a PAGE body, where a free identifier is a page global
   * (a data root). False inside component bodies, where every free identifier
   * is a prop or `settings` — treating one as a root there invented paths the
   * host cannot resolve.
   */
  private rootsAllowed = true;

  constructor(private readonly program: Program) {}

  extract(entry: string): AccessPlan {
    const template = this.program.templates.get(entry);
    if (template === undefined) {
      throw new Error(`unknown template ${JSON.stringify(entry)}`);
    }
    const env = new Map<string, Sym>();
    env.set('settings', OPAQUE); // merchant settings are not host data
    if (template.templateKind === 'page') {
      this.rootsAllowed = true;
    } else {
      // COMPONENT ENTRY: the host supplies the props, so each declared prop
      // is its own root — `product.title` is the path `product.title`, not a
      // path under some page global. v0.1 seeded nothing here, so free prop
      // names fell through to the page-global branch and the plan both
      // invented roots and dropped `settings`.
      this.rootsAllowed = false;
      this.seedComponentProps(template, env);
    }
    this.walkNodes(template.body, env, 0);
    return { paths: [...this.paths].sort() };
  }

  private seedComponentProps(template: Template, env: Map<string, Sym>): void {
    const defaultEnv = new Map<string, Sym>([['settings', OPAQUE]]);
    for (const decl of template.props) {
      env.set(decl.name, [decl.name]);
      this.paths.add(decl.name);
      // Default-prop expressions run when the prop is omitted, so whatever
      // they read is needed too.
      if (decl.defaultValue !== undefined) this.walkExpr(decl.defaultValue, defaultEnv);
    }
  }

  private walkNodes(nodes: readonly Node[], envIn: Map<string, Sym>, depth: number): void {
    if (depth > 32) throw new Error('component nesting too deep for plan extraction');
    let env = envIn;
    for (const node of nodes) {
      switch (node.kind) {
        case 'text':
          break;
        case 'interpolation':
          this.walkExpr(node.expr, env);
          break;
        case 'element': {
          for (const attr of node.attrs) {
            if (attr.value.form === 'expr' || attr.value.form === 'conditional') {
              this.walkExpr(attr.value.expr, env);
            } else if (attr.value.form === 'parts') {
              for (const part of attr.value.parts) {
                if (part.kind === 'expr') this.walkExpr(part.expr, env);
              }
            }
          }
          this.walkNodes(node.children, env, depth);
          break;
        }
        case 'if': {
          for (const branch of node.branches) {
            this.walkExpr(branch.cond, env);
            this.walkNodes(branch.children, env, depth);
          }
          if (node.elseChildren !== undefined) this.walkNodes(node.elseChildren, env, depth);
          break;
        }
        case 'for': {
          const subject = this.walkExpr(node.subject, env);
          if (node.limit !== undefined) this.walkExpr(node.limit, env);
          const loopEnv = new Map(env);
          loopEnv.set(node.item, subject.map(elementOf));
          if (node.index !== undefined) loopEnv.set(node.index, OPAQUE);
          this.walkNodes(node.children, loopEnv, depth);
          if (node.emptyChildren !== undefined) this.walkNodes(node.emptyChildren, env, depth);
          break;
        }
        case 'match': {
          // Every arm is reachable as far as the plan is concerned: the host
          // must be able to serve whichever one the data selects.
          this.walkExpr(node.subject, env);
          for (const arm of node.cases) this.walkNodes(arm.children, env, depth);
          break;
        }
        case 'let': {
          const sym = this.walkExpr(node.expr, env);
          env = new Map(env);
          env.set(node.name, sym);
          break;
        }
        case 'component': {
          const callee = this.program.templates.get(node.name);
          const propEnv = new Map<string, Sym>();
          propEnv.set('settings', OPAQUE);
          for (const prop of node.props) {
            let sym: Sym = OPAQUE;
            if (prop.value.form === 'expr') sym = this.walkExpr(prop.value.expr, env);
            else if (prop.value.form === 'conditional') this.walkExpr(prop.value.expr, env);
            else if (prop.value.form === 'parts') {
              for (const part of prop.value.parts) {
                if (part.kind === 'expr') this.walkExpr(part.expr, env);
              }
            }
            propEnv.set(prop.name, sym);
          }
          // Slot content reads CALLER data (the interpreter renders a fill in
          // the scope it was written in), so it is walked in the caller env,
          // with the caller's root policy. Nested component calls inside a
          // fill recurse through this same case, which is what makes
          // slot-in-slot nesting work.
          const grouped = groupSlotChildren(node.children);
          for (const nodesInSlot of grouped.slots.values()) {
            this.walkNodes(nodesInSlot, env, depth);
          }
          for (const mixedNode of grouped.mixed) this.walkNodes([mixedNode], env, depth);
          if (callee !== undefined) {
            for (const decl of callee.props) {
              if (propEnv.has(decl.name)) continue;
              // Omitted prop: the DEFAULT expression runs instead, so its
              // reads belong in the plan and its origin becomes the prop's.
              const sym =
                decl.defaultValue !== undefined
                  ? this.walkExpr(decl.defaultValue, new Map<string, Sym>([['settings', OPAQUE]]))
                  : OPAQUE;
              propEnv.set(decl.name, sym);
            }
            const prevRoots = this.rootsAllowed;
            this.rootsAllowed = false; // inside a component, no free roots exist
            this.walkNodes(callee.body, propEnv, depth + 1);
            this.rootsAllowed = prevRoots;
          }
          break;
        }
        case 'slot':
          break;
        case 'json-ld':
          this.walkExpr(node.expr, env);
          break;
      }
    }
  }

  private walkExpr(expr: Expr, env: Map<string, Sym>): Sym {
    switch (expr.kind) {
      case 'ident': {
        const bound = env.get(expr.name);
        if (bound !== undefined) return bound;
        if (!this.rootsAllowed) return OPAQUE;
        // Free identifier in a page = page-global root.
        this.paths.add(expr.name);
        return [expr.name];
      }
      case 'member': {
        const base = this.walkExpr(expr.object, env);
        return this.derive(base, (b) => `${b}.${expr.property}`);
      }
      case 'index': {
        const base = this.walkExpr(expr.object, env);
        this.walkExpr(expr.index, env);
        // Both forms: `products[0]` is `products[]`, but `[a, b][0]` (a list
        // LITERAL) is `a` or `b` themselves. Keeping both is the cheap sound
        // answer for an uncommon construct.
        const out: string[] = [];
        for (const b of base) {
          const elem = elementOf(b);
          this.paths.add(elem);
          out.push(elem, b);
        }
        return this.capBases(out);
      }
      case 'call': {
        // Filters used to make a value OPAQUE, which silently dropped
        // `first(products).title` from the plan — an UNDER-approximation, the
        // one failure mode the plan may not have. A filter's result now keeps
        // its arguments' bases, in both the list form (`sortBy`, `where`,
        // `reverse`) and the element form (`first`, `last`), so a following
        // `.title` records `products.title` AND `products[].title`. The host
        // may over-fetch one of them; it will not miss the real one.
        const bases: string[] = [];
        for (const arg of expr.args) {
          for (const base of this.walkExpr(arg.value, env)) {
            bases.push(base, elementOf(base));
          }
        }
        return this.capBases(bases);
      }
      case 'list': {
        // The value is a list whose ELEMENTS have these origins; the `index`
        // case knows to consider both the element and the `[]` form.
        const bases: string[] = [];
        for (const item of expr.items) bases.push(...this.walkExpr(item, env));
        return this.capBases(bases);
      }
      case 'record': {
        for (const field of expr.fields) this.walkExpr(field.value, env);
        return OPAQUE;
      }
      case 'range':
        this.walkExpr(expr.start, env);
        this.walkExpr(expr.end, env);
        return OPAQUE;
      case 'unary':
        this.walkExpr(expr.operand, env);
        return OPAQUE;
      case 'binary':
        this.walkExpr(expr.left, env);
        this.walkExpr(expr.right, env);
        return OPAQUE;
      case 'coalesce': {
        // `a ?? b` yields one of the two — both origins are live.
        const left = this.walkExpr(expr.left, env);
        const right = this.walkExpr(expr.right, env);
        return this.capBases([...left, ...right]);
      }
      case 'cond': {
        this.walkExpr(expr.test, env);
        const thenSym = this.walkExpr(expr.then, env);
        const elseSym = this.walkExpr(expr.else, env);
        return this.capBases([...thenSym, ...elseSym]);
      }
      default:
        return OPAQUE;
    }
  }

  /** Extend every base of `sym`, recording each derived path. */
  private derive(sym: Sym, extend: (base: string) => string): Sym {
    if (sym.length === 0) return OPAQUE;
    const out: string[] = [];
    for (const base of sym) {
      if (base.endsWith('.**')) {
        // Already a wildcard: everything below it is covered.
        this.paths.add(base);
        out.push(base);
        continue;
      }
      const path = extend(base);
      this.paths.add(path);
      out.push(path);
    }
    return this.capBases(out);
  }

  /**
   * Deduplicate and bound the base set. On overflow EVERY base is recorded as
   * a `base.**` wildcard first, so truncating the returned set afterwards
   * cannot lose anything: any path a dropped base could still have produced
   * (`dropped.title`, `dropped[].x`, …) is already covered by `dropped.**`.
   * Over-approximation, never a drop.
   */
  private capBases(bases: readonly string[]): Sym {
    if (bases.length === 0) return OPAQUE;
    const unique = [...new Set(bases)];
    if (unique.length <= MAX_SYM_BASES) return unique;
    const wildcards = new Set<string>();
    for (const base of unique) {
      const root = base.endsWith('.**') ? base : `${base}.**`;
      wildcards.add(root);
      this.paths.add(root);
    }
    return [...wildcards].slice(0, MAX_SYM_BASES);
  }
}

export function extractAccessPlan(program: Program, entry: string): AccessPlan {
  return new PlanExtractor(program).extract(entry);
}
