/**
 * The bring-your-own-object-model seam.
 *
 * The engine has zero I/O and zero ambient authority; everything a template
 * can see arrives through this interface: a TypeRegistry (declared object
 * model), host filters (typed, taint-flagged), and data resolved by the host
 * from an AccessPlan the engine extracts statically.
 *
 * Security split (W-34): the ENGINE guarantees termination, escaping and no
 * ambient authority; the HOST guarantees authorization and data scoping.
 * `Html` is not host-declarable — the only Html producers are host filters
 * explicitly flagged `unsafeHtml: true`, which the checker warns on.
 */
import { groupSlotChildren, type Expr, type Node, type Program, type Template } from './ast';
import { type Type, type TypeRegistry } from './types';
import { STDLIB } from './stdlib';

// ---------------------------------------------------------------------------
// Host filters
// ---------------------------------------------------------------------------

export interface HostFilterDecl {
  /** camelCase filter name; must not collide with the stdlib. */
  name: string;
  params: readonly Type[];
  optionalParams?: readonly Type[];
  returns: Type;
  /**
   * Required when `returns` is Html. Flags that this filter's output is
   * emitted UNESCAPED — the host owns sanitization; the checker warns at
   * every use site (W-34a).
   */
  unsafeHtml?: boolean;
  impl(args: readonly unknown[]): unknown;
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
    for (const p of [...d.params, ...(d.optionalParams ?? [])]) {
      if (containsHtmlType(p)) {
        throw new Error(`host filter ${JSON.stringify(d.name)}: Html cannot be a parameter type (W-34)`);
      }
    }
    if (d.returns.kind === 'html') {
      if (d.unsafeHtml !== true) {
        throw new Error(
          `host filter ${JSON.stringify(d.name)} returns Html and must be flagged unsafeHtml: true (W-34)`,
        );
      }
    } else if (containsHtmlType(d.returns)) {
      throw new Error(`host filter ${JSON.stringify(d.name)}: Html may only be the top-level return type`);
    } else if (d.unsafeHtml === true) {
      throw new Error(`host filter ${JSON.stringify(d.name)}: unsafeHtml is only valid on Html-returning filters`);
    }
  }
}

// ---------------------------------------------------------------------------
// Html runtime brand
// ---------------------------------------------------------------------------

/** Runtime carrier for Html values so a plain string can never be emitted raw. */
export interface HtmlValue {
  readonly __orbitHtml: string;
}

export function unsafeHtmlValue(html: string): HtmlValue {
  return { __orbitHtml: html };
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
 * Call this on CHECKED programs only — extraction assumes an acyclic
 * component graph.
 */
export interface AccessPlan {
  paths: readonly string[];
}

type Sym = string | null; // symbolic origin path, or opaque

class PlanExtractor {
  private readonly paths = new Set<string>();

  constructor(private readonly program: Program) {}

  extract(entry: string): AccessPlan {
    const template = this.program.templates.get(entry);
    if (template === undefined) {
      throw new Error(`unknown template ${JSON.stringify(entry)}`);
    }
    const env = new Map<string, Sym>();
    if (template.templateKind === 'page') {
      // Page globals are the roots; their names are host-defined.
      this.seedRoots(template, env);
    }
    this.walkNodes(template.body, env, 0);
    return { paths: [...this.paths].sort() };
  }

  private seedRoots(template: Template, env: Map<string, Sym>): void {
    // Every free identifier in a checked page resolves to a page global (or
    // `settings`, which is data-opaque). We seed lazily: unknown idents are
    // treated as roots named after themselves, except `settings`.
    void template;
    env.set('settings', null);
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
          loopEnv.set(node.item, subject !== null ? `${subject}[]` : null);
          if (node.index !== undefined) loopEnv.set(node.index, null);
          this.walkNodes(node.children, loopEnv, depth);
          if (node.emptyChildren !== undefined) this.walkNodes(node.emptyChildren, env, depth);
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
          propEnv.set('settings', null);
          for (const prop of node.props) {
            let sym: Sym = null;
            if (prop.value.form === 'expr') sym = this.walkExpr(prop.value.expr, env);
            else if (prop.value.form === 'conditional') this.walkExpr(prop.value.expr, env);
            propEnv.set(prop.name, sym);
          }
          // Slot content reads caller data — walk it in the caller env. The
          // grouping mirrors the interpreter so nothing is missed.
          const grouped = groupSlotChildren(node.children);
          for (const nodesInSlot of grouped.slots.values()) {
            this.walkNodes(nodesInSlot, env, depth);
          }
          for (const mixedNode of grouped.mixed) this.walkNodes([mixedNode], env, depth);
          if (callee !== undefined) {
            for (const decl of callee.props) {
              if (!propEnv.has(decl.name)) propEnv.set(decl.name, null);
            }
            this.walkNodes(callee.body, propEnv, depth + 1);
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
        if (env.has(expr.name)) return env.get(expr.name) ?? null;
        // Free identifier in a page = page-global root.
        this.paths.add(expr.name);
        return expr.name;
      }
      case 'member': {
        const base = this.walkExpr(expr.object, env);
        if (base === null) return null;
        const path = `${base}.${expr.property}`;
        this.paths.add(path);
        return path;
      }
      case 'index': {
        const base = this.walkExpr(expr.object, env);
        this.walkExpr(expr.index, env);
        if (base === null) return null;
        const path = `${base}[]`;
        this.paths.add(path);
        return path;
      }
      case 'call': {
        for (const arg of expr.args) this.walkExpr(arg, env);
        return null;
      }
      case 'list': {
        for (const item of expr.items) this.walkExpr(item, env);
        return null;
      }
      case 'record': {
        for (const field of expr.fields) this.walkExpr(field.value, env);
        return null;
      }
      case 'range':
        this.walkExpr(expr.start, env);
        this.walkExpr(expr.end, env);
        return null;
      case 'unary':
        this.walkExpr(expr.operand, env);
        return null;
      case 'binary':
        this.walkExpr(expr.left, env);
        this.walkExpr(expr.right, env);
        return null;
      case 'coalesce':
        this.walkExpr(expr.left, env);
        this.walkExpr(expr.right, env);
        return null;
      case 'cond':
        this.walkExpr(expr.test, env);
        this.walkExpr(expr.then, env);
        this.walkExpr(expr.else, env);
        return null;
      default:
        return null;
    }
  }
}

export function extractAccessPlan(program: Program, entry: string): AccessPlan {
  return new PlanExtractor(program).extract(entry);
}
