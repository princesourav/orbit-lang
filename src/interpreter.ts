/**
 * Stateless tree-walk interpreter over CHECKED ASTs.
 *
 * Runtime discipline (W-04, W-06, W-17, W-32):
 * - ONE global fuel counter, charged per emitted UTF-16 code unit plus a
 *   fixed per-element cost — a byte budget, not an op budget
 * - ONE global iteration counter threaded through component calls and slot
 *   expansion (no per-loop reset, so nesting cannot multiply budgets)
 * - per-value caps at every filter step (string ≤ LIMITS.maxStringLength,
 *   list ≤ LIMITS.maxListItems)
 * - wall-clock deadline via an injectable `now()` (used ONLY to abort — no
 *   time value can reach the output; determinism holds: same program + data
 *   + options → same bytes)
 * - the interpreter holds NO cache and NO module state; memoization belongs
 *   to closed adapters, never here
 * - dynamic cap trips FAIL the render with template/line/col — a partial
 *   page is never returned
 */
import {
  groupSlotChildren,
  type Attr,
  type Expr,
  type Node,
  type Program,
  type SettingDecl,
  type Template,
  type TypeExpr,
} from './ast';
import { OrbitRenderError, type RenderWarning, type Span } from './diagnostics';
import {
  escapeAttr,
  escapeRcdata,
  escapeText,
  frozenMap,
  isForbiddenKey,
  isHexColorLiteral,
  sanitizeSrcset,
  sanitizeUrl,
  serializeJsonLd,
} from './escape';
import { bindHostFilterArgs, isHtmlValue, htmlValue, type HostFilterDecl } from './host';
import { LIMITS } from './limits';
import { DEFAULT_LOCALE, STDLIB, type FilterRuntime, type LocaleData } from './stdlib';

/**
 * What happens when the URL sink rejects a value (`href={product.url}` where
 * the data says `javascript:…`).
 *
 * - `'placeholder'` — emit a neutral value (`#`, or `""` for `srcset`) and
 *   record an O4900 `RenderWarning`. The page still renders. This is the
 *   default because it is v0.1's behavior.
 * - `'error'` — fail the render with O4037, like every other integrity
 *   violation in the engine. Recommended for production: a blocked URL almost
 *   always means the DATA is wrong, and a silent `#` hides that for months.
 */
export type UrlPolicy = 'placeholder' | 'error';

export interface RenderOptions {
  /** Host filter implementations (money, img, …). */
  hostFilters?: readonly HostFilterDecl[];
  /** Top-level data bindings for page templates (host-resolved). */
  bindings?: Record<string, unknown>;
  /** Props when rendering a component entry directly. */
  props?: Record<string, unknown>;
  /** Merchant settings values, keyed by template name. */
  settings?: Record<string, Record<string, unknown>>;
  /** Production deployments configure LOWER values; these are spec minimums. */
  fuel?: number;
  maxIterations?: number;
  maxOutput?: number;
  deadlineMs?: number;
  /** Injected clock for the deadline ONLY (defaults to Date.now). */
  now?: () => number;
  locale?: LocaleData;
  /** Sink policy for blocked URLs. Defaults to `'placeholder'` (W-11d). */
  urlPolicy?: UrlPolicy;
}

export interface RenderErrorInfo {
  code: string;
  message: string;
  template?: string;
  line?: number;
  col?: number;
}

export type RenderResult =
  | { ok: true; html: string; warnings: RenderWarning[] }
  | { ok: false; error: RenderErrorInfo; warnings: RenderWarning[] };

/**
 * Per-render warning cap. Warnings are accumulated in memory and returned to
 * the host, so an unbounded list is an unbounded allocation inside a fuel
 * budget that does not charge for it. Engine-local constant (not in
 * limits.ts) because nothing outside the interpreter observes it.
 */
const MAX_RENDER_WARNINGS = 100;

interface Scope {
  vars: Map<string, unknown>;
  parent?: Scope;
}

interface SlotFill {
  nodes: Node[];
  scope: Scope;
  frame?: Frame;
  template: string;
}

interface Frame {
  slots: Map<string, SlotFill>;
  depth: number;
}

interface EmitCtx {
  rcdata: boolean;
}

const RANGE_BRAND = '__orbitRange';

interface RangeValue {
  readonly __orbitRange: true;
  readonly start: number;
  readonly end: number;
}

function isRangeValue(v: unknown): v is RangeValue {
  return v !== null && typeof v === 'object' && (v as { __orbitRange?: unknown }).__orbitRange === true;
}

export function render(program: Program, entry: string, options: RenderOptions = {}): RenderResult {
  const rt = new Interpreter(program, options);
  try {
    const html = rt.renderEntry(entry);
    return { ok: true, html, warnings: rt.warnings };
  } catch (err) {
    if (err instanceof OrbitRenderError) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          template: err.template ?? rt.currentTemplate,
          line: err.span?.start.line,
          col: err.span?.start.col,
        },
        warnings: rt.warnings,
      };
    }
    throw err;
  }
}

class Interpreter {
  readonly warnings: RenderWarning[] = [];
  currentTemplate = '<render>';

  private readonly out: string[] = [];
  private outLen = 0;
  private fuel: number;
  private iterations = 0;
  private readonly maxIterations: number;
  private readonly maxOutput: number;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly hostFilters: ReadonlyMap<string, HostFilterDecl>;
  private readonly locale: LocaleData;
  private readonly urlPolicy: UrlPolicy;

  constructor(
    private readonly program: Program,
    private readonly options: RenderOptions,
  ) {
    this.fuel = options.fuel ?? LIMITS.defaultFuel;
    this.maxIterations = options.maxIterations ?? LIMITS.defaultMaxIterations;
    this.maxOutput = options.maxOutput ?? LIMITS.defaultMaxOutput;
    this.deadlineMs = options.deadlineMs ?? LIMITS.defaultDeadlineMs;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    // Frozen null-prototype view: a filter name from the AST can never resolve
    // to an inherited member of the lookup object (see `frozenMap`).
    this.hostFilters = frozenMap((options.hostFilters ?? []).map((f) => [f.name, f] as const));
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.urlPolicy = options.urlPolicy ?? 'placeholder';
  }

  renderEntry(entry: string): string {
    const template = this.program.templates.get(entry);
    if (template === undefined) {
      throw new OrbitRenderError('O4016', `unknown template ${JSON.stringify(entry)}`);
    }
    this.currentTemplate = template.name;
    const vars = new Map<string, unknown>();
    if (template.templateKind === 'page') {
      // Page bindings have no declared type IN THE AST (page globals live in
      // the host's TypeRegistry, which the interpreter does not receive), so
      // the engine cannot shape-check them here; the checker did that against
      // the registry at compile time.
      const bindings = this.options.bindings;
      if (bindings !== undefined) {
        for (const [k, v] of Object.entries(bindings)) {
          if (isForbiddenKey(k)) continue;
          vars.set(k, v);
        }
      }
    } else {
      this.validateEntryProps(template);
      for (const decl of template.props) {
        const provided = pick(this.options.props, decl.name);
        vars.set(decl.name, provided !== undefined ? provided : this.defaultPropValue(decl.defaultValue));
      }
    }
    vars.set('settings', this.resolveSettings(template));
    this.renderNodes(template.body, { vars }, undefined, { rcdata: false }, template.name);
    return this.out.join('');
  }

  // -- budget plumbing ------------------------------------------------------

  private fail(code: string, message: string, span?: Span): never {
    throw new OrbitRenderError(code, message, this.currentTemplate, span);
  }

  /** Structured, span-carrying warning (see `RenderWarning`), capped. */
  private warn(code: string, message: string, span?: Span): void {
    if (this.warnings.length > MAX_RENDER_WARNINGS) return;
    if (this.warnings.length === MAX_RENDER_WARNINGS) {
      this.warnings.push({
        code: 'O4909',
        message: `warning list truncated at ${MAX_RENDER_WARNINGS} entries`,
        template: this.currentTemplate,
      });
      return;
    }
    this.warnings.push({
      code,
      message,
      template: this.currentTemplate,
      line: span?.start.line,
      col: span?.start.col,
    });
  }

  private emit(s: string, span?: Span): void {
    if (s === '') return;
    this.fuel -= s.length;
    if (this.fuel < 0) this.fail('O4001', 'render fuel exhausted (output byte budget)', span);
    this.outLen += s.length;
    if (this.outLen > this.maxOutput) {
      this.fail('O4004', `output exceeds ${this.maxOutput} characters`, span);
    }
    this.out.push(s);
  }

  private chargeElement(span: Span): void {
    this.fuel -= LIMITS.perElementFuelCost;
    if (this.fuel < 0) this.fail('O4001', 'render fuel exhausted (element budget)', span);
    this.checkDeadline(span);
  }

  private chargeIteration(span: Span): void {
    this.iterations += 1;
    if (this.iterations > this.maxIterations) {
      this.fail('O4002', `global iteration budget of ${this.maxIterations} exhausted`, span);
    }
    this.checkDeadline(span);
  }

  private checkDeadline(span?: Span): void {
    if (this.now() - this.startedAt > this.deadlineMs) {
      this.fail('O4003', `render exceeded the ${this.deadlineMs}ms wall-clock deadline`, span);
    }
  }

  private capString(s: string, span?: Span): string {
    if (s.length > LIMITS.maxStringLength) {
      this.fail('O4005', `intermediate string exceeds ${LIMITS.maxStringLength} characters`, span);
    }
    return s;
  }

  private capList<T>(l: readonly T[], span?: Span): readonly T[] {
    if (l.length > LIMITS.maxListItems) {
      this.fail('O4006', `intermediate list exceeds ${LIMITS.maxListItems} items`, span);
    }
    return l;
  }

  // -- settings / props -----------------------------------------------------

  private defaultPropValue(def: Expr | undefined): unknown {
    if (def === undefined) return null;
    return this.evalExpr(def, { vars: new Map() });
  }

  private resolveSettings(template: Template): Record<string, unknown> {
    const provided = pick(this.options.settings, template.name);
    // Null-prototype: `settings` is indexed by AST-supplied names.
    const out = Object.create(null) as Record<string, unknown>;
    for (const decl of template.settings) {
      const value = isRecordValue(provided) ? pick(provided, decl.name) : undefined;
      if (value !== undefined && this.settingValueValid(decl, value)) {
        out[decl.name] = value;
      } else {
        if (value !== undefined) {
          this.warn(
            'O4901',
            `setting ${template.name}.${decl.name}: provided value is invalid for its ${decl.setting.control} control; using the declared default`,
            decl.span,
          );
        }
        out[decl.name] = this.evalExpr(decl.defaultValue, { vars: new Map() });
      }
    }
    return out;
  }

  private settingValueValid(decl: SettingDecl, value: unknown): boolean {
    switch (decl.setting.control) {
      case 'text':
        return typeof value === 'string' && value.length <= LIMITS.maxStringLength;
      case 'toggle':
        return typeof value === 'boolean';
      case 'select':
        return typeof value === 'string' && decl.setting.options.includes(value);
      case 'range':
        return (
          typeof value === 'number' &&
          Number.isInteger(value) &&
          value >= decl.setting.min &&
          value <= decl.setting.max
        );
      case 'color':
        // v0.1 accepted any 7-character string starting with '#', so the
        // merchant-controlled value `#<scrip"` passed as a Color and reached
        // the attribute sink. All six characters must be hex digits.
        return typeof value === 'string' && isHexColorLiteral(value);
    }
  }

  // -- component-entry prop validation (W-34b) ------------------------------

  /**
   * Props supplied at a COMPONENT ENTRY come from the host, not from a checked
   * call site, so nothing has verified them against the declared prop types.
   * This is a deliberately SHALLOW check — O(declared props), never a walk of
   * the data — mirroring `settingValueValid`: it catches "you passed a string
   * where the template declared `List<Product>`", not "element 4,912 of this
   * list is missing a field".
   *
   * Host object/opaque types (`Product`, `Money`, …) have a host-private
   * representation the engine cannot inspect, so for those the only assertion
   * the engine can honestly make is "not none".
   */
  private validateEntryProps(template: Template): void {
    const supplied = this.options.props;
    for (const decl of template.props) {
      const value = pick(supplied, decl.name);
      if (value === undefined) {
        if (decl.defaultValue === undefined && decl.type.kind !== 'optional') {
          this.fail(
            'O4038',
            `component entry ${JSON.stringify(template.name)}: required prop ${JSON.stringify(decl.name)} of type ${typeExprToString(decl.type)} was not supplied and has no default`,
            decl.span,
          );
        }
        continue;
      }
      if (!propShapeValid(decl.type, value)) {
        this.fail(
          'O4038',
          `component entry ${JSON.stringify(template.name)}: prop ${JSON.stringify(decl.name)} expects ${typeExprToString(decl.type)}, got ${shapeName(value)}`,
          decl.span,
        );
      }
    }
    if (supplied !== undefined) {
      const declared = new Set(template.props.map((p) => p.name));
      for (const key of Object.keys(supplied)) {
        if (!declared.has(key)) {
          this.warn(
            'O4903',
            `component entry ${JSON.stringify(template.name)}: prop ${JSON.stringify(key)} is not declared by the component and was ignored`,
            template.span,
          );
        }
      }
    }
  }

  // -- node rendering ---------------------------------------------------------

  private renderNodes(nodes: readonly Node[], scopeIn: Scope, frame: Frame | undefined, ctx: EmitCtx, templateName: string): void {
    let scope = scopeIn;
    for (const node of nodes) {
      switch (node.kind) {
        case 'text':
          this.emit(ctx.rcdata ? escapeRcdata(node.value) : escapeText(node.value), node.span);
          break;
        case 'interpolation': {
          const value = this.evalExpr(node.expr, scope);
          if (isHtmlValue(value)) {
            if (ctx.rcdata) this.fail('O4034', 'Html cannot render inside <title>/<textarea>', node.span);
            /*
             * Only TRUSTED Html warns.
             *
             * A sanitizer's output is the sanctioned path and is silent, so
             * this list stays a real audit surface rather than a census of
             * every rich-text field on the page. The flag travels on the value
             * because by the time it reaches this sink it may have crossed a
             * component boundary and been transformed — there is nothing here
             * to look the filter up by.
             */
            if (value.__orbitTrusted === true) {
              this.warn('O4902', 'emitted raw Html from a trustedHtml host filter', node.span);
            }
            this.emit(value.__orbitHtml, node.span);
            break;
          }
          const s = this.stringify(value, node.span);
          this.emit(ctx.rcdata ? escapeRcdata(s) : escapeText(s), node.span);
          break;
        }
        case 'element':
          this.renderElement(node, scope, frame, ctx, templateName);
          break;
        case 'if': {
          let rendered = false;
          for (const branch of node.branches) {
            if (this.evalBool(branch.cond, scope)) {
              this.renderNodes(branch.children, scope, frame, ctx, templateName);
              rendered = true;
              break;
            }
          }
          if (!rendered && node.elseChildren !== undefined) {
            this.renderNodes(node.elseChildren, scope, frame, ctx, templateName);
          }
          break;
        }
        case 'for':
          this.renderFor(node, scope, frame, ctx, templateName);
          break;
        case 'let': {
          const value = this.evalExpr(node.expr, scope);
          const vars = new Map<string, unknown>();
          vars.set(node.name, value);
          scope = { vars, parent: scope };
          break;
        }
        case 'component':
          this.renderComponent(node.name, node.props, node.children, node.span, scope, frame, templateName);
          break;
        case 'slot': {
          const fill = frame?.slots.get(node.name);
          if (fill !== undefined) {
            const prevTemplate = this.currentTemplate;
            this.currentTemplate = fill.template;
            this.renderNodes(fill.nodes, fill.scope, fill.frame, ctx, fill.template);
            this.currentTemplate = prevTemplate;
          }
          break;
        }
        case 'json-ld': {
          const value = this.evalExpr(node.expr, scope);
          let json: string;
          try {
            json = serializeJsonLd(value);
          } catch (err) {
            if (err instanceof OrbitRenderError) {
              throw new OrbitRenderError(err.code, err.message, this.currentTemplate, node.span);
            }
            throw err;
          }
          this.chargeElement(node.span);
          this.emit('<script type="application/ld+json">', node.span);
          this.emit(json, node.span);
          this.emit('</script>', node.span);
          break;
        }
      }
    }
  }

  private renderElement(
    node: Node & { kind: 'element' },
    scope: Scope,
    frame: Frame | undefined,
    ctx: EmitCtx,
    templateName: string,
  ): void {
    this.chargeElement(node.span);
    this.emit(`<${node.tag}`, node.span);
    for (const attr of node.attrs) {
      if (attr.name === 'slot' || attr.name === 'verbatim') continue;
      this.renderAttr(attr, scope, node.span);
    }
    this.emit('>', node.span);
    if (node.content === 'void') return;
    const childCtx: EmitCtx = { rcdata: node.content === 'rcdata' };
    this.renderNodes(node.children, scope, frame, childCtx, templateName);
    this.emit(`</${node.tag}>`, node.span);
  }

  private renderAttr(attr: Attr, scope: Scope, span: Span): void {
    switch (attr.value.form) {
      case 'bare':
        this.emit(` ${attr.name}`, span);
        return;
      case 'conditional': {
        const v = this.evalExpr(attr.value.expr, scope);
        if (v === true) this.emit(` ${attr.name}`, span);
        else if (v !== false && v !== null) this.fail('O4022', `conditional attribute ${attr.name}?= needs a Bool`, attr.span);
        return;
      }
      case 'expr': {
        const raw = this.stringify(this.assertNotHtml(this.evalExpr(attr.value.expr, scope), attr.span), attr.span);
        this.emitAttrValue(attr, raw, span);
        return;
      }
      case 'parts': {
        let raw = '';
        for (const part of attr.value.parts) {
          if (part.kind === 'text') raw += part.value;
          else raw += this.stringify(this.assertNotHtml(this.evalExpr(part.expr, scope), attr.span), attr.span);
          this.capString(raw, attr.span);
        }
        this.emitAttrValue(attr, raw, span);
        return;
      }
    }
  }

  private assertNotHtml(v: unknown, span: Span): unknown {
    if (isHtmlValue(v)) this.fail('O4023', 'Html cannot appear in attributes', span);
    return v;
  }

  private emitAttrValue(attr: Attr, raw: string, span: Span): void {
    if (attr.isUrl) {
      // `srcset` is a comma-separated CANDIDATE LIST, not a URL: each
      // candidate is sanitized independently (W-11c).
      const checked = attr.name === 'srcset' ? sanitizeSrcset(raw) : sanitizeUrl(raw, attr.name);
      if (!checked.ok) {
        if (this.urlPolicy === 'error') {
          this.fail('O4037', `blocked unsafe URL in ${attr.name}: ${checked.reason}`, span);
        }
        this.warn('O4900', `blocked unsafe URL in ${attr.name}: ${checked.reason}`, span);
        // A blank candidate list is the only neutral srcset; '#' would be a
        // single relative candidate the browser would actually try to fetch.
        this.emit(attr.name === 'srcset' ? ` ${attr.name}=""` : ` ${attr.name}="#"`, span);
        return;
      }
      this.emit(` ${attr.name}="${escapeAttr(checked.url)}"`, span);
      return;
    }
    this.emit(` ${attr.name}="${escapeAttr(raw)}"`, span);
  }

  private renderFor(node: Node & { kind: 'for' }, scope: Scope, frame: Frame | undefined, ctx: EmitCtx, templateName: string): void {
    const subject = this.evalExpr(node.subject, scope);
    const limit = node.limit !== undefined ? this.evalInt(node.limit, scope) : LIMITS.defaultLoopLimit;

    const iterate = (count: number, valueAt: (i: number) => unknown): void => {
      for (let i = 0; i < count; i += 1) {
        this.chargeIteration(node.span);
        const vars = new Map<string, unknown>();
        vars.set(node.item, valueAt(i));
        if (node.index !== undefined) vars.set(node.index, i);
        this.renderNodes(node.children, { vars, parent: scope }, frame, ctx, templateName);
      }
    };

    if (Array.isArray(subject)) {
      const count = Math.min(subject.length, limit, LIMITS.maxLoopLimit);
      if (count === 0) {
        if (node.emptyChildren !== undefined) this.renderNodes(node.emptyChildren, scope, frame, ctx, templateName);
        return;
      }
      iterate(count, (i) => subject[i]);
      return;
    }
    if (isRangeValue(subject)) {
      const count = Math.min(Math.max(0, subject.end - subject.start + 1), limit, LIMITS.maxLoopLimit);
      if (count === 0) {
        if (node.emptyChildren !== undefined) this.renderNodes(node.emptyChildren, scope, frame, ctx, templateName);
        return;
      }
      iterate(count, (i) => subject.start + i);
      return;
    }
    this.fail('O4024', '<for> subject is not a list or range', node.span);
  }

  private renderComponent(
    name: string,
    props: readonly Attr[],
    children: readonly Node[],
    span: Span,
    scope: Scope,
    frame: Frame | undefined,
    callerTemplate: string,
  ): void {
    const template = this.program.templates.get(name);
    if (template === undefined) this.fail('O4016', `unknown component ${JSON.stringify(name)}`, span);
    const depth = (frame?.depth ?? 0) + 1;
    if (depth > LIMITS.maxComponentDepth) {
      this.fail('O4015', `component nesting exceeds depth ${LIMITS.maxComponentDepth}`, span);
    }
    this.chargeIteration(span);

    const vars = new Map<string, unknown>();
    const givenProps = new Map<string, unknown>();
    for (const prop of props) {
      if (prop.value.form === 'bare') givenProps.set(prop.name, true);
      else if (prop.value.form === 'expr') givenProps.set(prop.name, this.evalExpr(prop.value.expr, scope));
      else if (prop.value.form === 'parts') {
        let s = '';
        for (const part of prop.value.parts) if (part.kind === 'text') s += part.value;
        givenProps.set(prop.name, s);
      }
    }
    for (const decl of template.props) {
      const given = givenProps.get(decl.name);
      vars.set(decl.name, given !== undefined ? given : this.defaultPropValue(decl.defaultValue));
    }
    vars.set('settings', this.resolveSettings(template));

    const grouped = groupSlotChildren([...children]);
    const slots = new Map<string, SlotFill>();
    for (const [slotName, nodes] of grouped.slots) {
      slots.set(slotName, { nodes, scope, frame, template: callerTemplate });
    }

    const prevTemplate = this.currentTemplate;
    this.currentTemplate = template.name;
    this.renderNodes(template.body, { vars }, { slots, depth }, { rcdata: false }, template.name);
    this.currentTemplate = prevTemplate;
  }

  // -- expressions ------------------------------------------------------------

  private evalBool(expr: Expr, scope: Scope): boolean {
    const v = this.evalExpr(expr, scope);
    if (typeof v !== 'boolean') this.fail('O4025', 'condition did not evaluate to a Bool', expr.span);
    return v;
  }

  private evalInt(expr: Expr, scope: Scope): number {
    const v = this.evalExpr(expr, scope);
    if (typeof v !== 'number' || !Number.isFinite(v)) this.fail('O4026', 'expected an Int', expr.span);
    return Math.trunc(v);
  }

  private evalExpr(expr: Expr, scope: Scope): unknown {
    switch (expr.kind) {
      case 'int':
      case 'float':
        return expr.value;
      case 'string':
        return expr.value;
      case 'bool':
        return expr.value;
      case 'none':
        return null;
      case 'color':
        return expr.value;
      case 'ident': {
        let s: Scope | undefined = scope;
        while (s !== undefined) {
          if (s.vars.has(expr.name)) return s.vars.get(expr.name) ?? null;
          s = s.parent;
        }
        this.fail('O4010', `unbound identifier ${JSON.stringify(expr.name)}`, expr.span);
      }
      case 'list': {
        const out = expr.items.map((item) => this.evalExpr(item, scope));
        this.capList(out, expr.span);
        return out;
      }
      case 'record': {
        // Null-prototype: record literals are keyed by AST-supplied names and
        // are later re-indexed by member access.
        const out = Object.create(null) as Record<string, unknown>;
        for (const field of expr.fields) {
          if (isForbiddenKey(field.key)) {
            this.fail('O4039', `record field ${JSON.stringify(field.key)} is a reserved property name`, expr.span);
          }
          out[field.key] = this.evalExpr(field.value, scope);
        }
        return out;
      }
      case 'range': {
        const start = this.evalInt(expr.start, scope);
        const end = this.evalInt(expr.end, scope);
        const value: RangeValue = { [RANGE_BRAND]: true, start, end };
        return value;
      }
      case 'member': {
        const obj = this.evalExpr(expr.object, scope);
        if (obj === null || obj === undefined) {
          if (expr.optional) return null;
          this.fail('O4011', `accessed property ${JSON.stringify(expr.property)} of none`, expr.span);
        }
        if (typeof obj !== 'object' || Array.isArray(obj)) {
          this.fail('O4011', `value has no property ${JSON.stringify(expr.property)}`, expr.span);
        }
        if (isForbiddenKey(expr.property)) {
          this.fail(
            'O4039',
            `property ${JSON.stringify(expr.property)} is a reserved name and can never be read from data`,
            expr.span,
          );
        }
        // OWN properties only: an inherited member is not data. Orbit has no
        // dynamic member access, so this can only trip on a hand-built AST or
        // on host data carrying behavior on its prototype — both of which
        // should read as absent, not as a live JS object.
        if (!Object.hasOwn(obj, expr.property)) return null;
        const v = (obj as Record<string, unknown>)[expr.property];
        return v === undefined ? null : v;
      }
      case 'index': {
        const obj = this.evalExpr(expr.object, scope);
        const idx = this.evalInt(expr.index, scope);
        if (!Array.isArray(obj)) this.fail('O4024', 'only lists can be indexed', expr.span);
        if (idx < 0 || idx >= obj.length) return null;
        return obj[idx] ?? null;
      }
      case 'call': {
        this.checkDeadline(expr.span);
        // Written order, always: a reader expects the leftmost argument to be
        // evaluated first, and the slot a value lands in is a separate question
        // from when it is computed.
        const written = expr.args.map((a) => this.evalExpr(a.value, scope));
        return this.applyFilter(expr.callee, this.placeArgs(expr, written), expr.span);
      }
      case 'unary': {
        const v = this.evalExpr(expr.operand, scope);
        if (expr.op === '!') {
          if (typeof v !== 'boolean') this.fail('O4025', 'operand of ! is not a Bool', expr.span);
          return !v;
        }
        if (typeof v !== 'number') this.fail('O4026', 'operand of unary - is not a number', expr.span);
        return -v;
      }
      case 'binary':
        return this.evalBinary(expr, scope);
      case 'coalesce': {
        const left = this.evalExpr(expr.left, scope);
        return left === null || left === undefined ? this.evalExpr(expr.right, scope) : left;
      }
      case 'cond':
        return this.evalBool(expr.test, scope) ? this.evalExpr(expr.then, scope) : this.evalExpr(expr.else, scope);
    }
  }

  private evalBinary(expr: Expr & { kind: 'binary' }, scope: Scope): unknown {
    const { op } = expr;
    if (op === '&&') return this.evalBool(expr.left, scope) && this.evalBool(expr.right, scope);
    if (op === '||') return this.evalBool(expr.left, scope) || this.evalBool(expr.right, scope);
    if (op === '==' || op === '!=') {
      const l = this.evalExpr(expr.left, scope);
      const r = this.evalExpr(expr.right, scope);
      const ln = l === null || l === undefined ? null : l;
      const rn = r === null || r === undefined ? null : r;
      const eq = ln === rn;
      return op === '==' ? eq : !eq;
    }
    const l = this.evalExpr(expr.left, scope);
    const r = this.evalExpr(expr.right, scope);
    if (typeof l !== 'number' || typeof r !== 'number') {
      this.fail('O4026', `operator ${op} needs numbers`, expr.span);
    }
    switch (op) {
      case '<':
        return l < r;
      case '<=':
        return l <= r;
      case '>':
        return l > r;
      case '>=':
        return l >= r;
      case '+':
        return l + r;
      case '-':
        return l - r;
      case '*':
        return l * r;
      case '/':
        if (r === 0) this.fail('O4013', 'division by zero', expr.span);
        return l / r;
      case '%':
        if (r === 0) this.fail('O4013', 'modulo by zero', expr.span);
        return Math.trunc(l) % Math.trunc(r);
      default:
        this.fail('O4027', `unknown operator ${String(op)}`, expr.span);
    }
  }

  /**
   * Move written arguments into parameter slots.
   *
   * A skipped optional in the middle of the list arrives as `null`, which is
   * unambiguous: the optional law means no argument can ever BE null, so a null
   * in a slot can only mean "not supplied". Trailing skipped optionals are left
   * off entirely, so a call written positionally passes exactly the array it
   * always did.
   */
  private placeArgs(expr: Expr & { kind: 'call' }, written: readonly unknown[]): readonly unknown[] {
    const decl = this.hostFilters.get(expr.callee);
    if (decl === undefined) return written;
    const binding = bindHostFilterArgs(decl, expr.args);
    // The checker rejected anything that does not bind, and a stored AST is
    // re-checked on load; an unbindable call cannot reach here.
    if (!binding.ok) return written;
    if (binding.slotOf.every((slot, i) => slot === i)) return written;

    const slots: unknown[] = [];
    let highest = -1;
    for (let i = 0; i < written.length; i += 1) {
      const slot = binding.slotOf[i];
      if (slot === undefined) continue;
      while (slots.length <= slot) slots.push(null);
      slots[slot] = written[i];
      if (slot > highest) highest = slot;
    }
    return slots.slice(0, highest + 1);
  }

  private applyFilter(name: string, args: readonly unknown[], span: Span): unknown {
    const filterRt: FilterRuntime = {
      fail: (code, message) => this.fail(code, message, span),
      capString: (s) => this.capString(s, span),
      capList: (l) => {
        this.capList(l, span);
        return l;
      },
      locale: this.locale,
    };
    const host = this.hostFilters.get(name);
    if (host !== undefined) {
      // Host filter implementations are FOREIGN CODE inside the engine's
      // budget. Two things follow.
      //
      // (1) Deadline before AND after. v0.1 only byte-charged the filter's
      //     output, so a filter that blocked for a second blew the wall-clock
      //     deadline and was noticed only once it returned. Checking on both
      //     sides means a slow filter trips O4003 at the first call boundary
      //     after it, and the render aborts instead of running to completion.
      // (2) A throw is a RENDER failure, not an unhandled exception. v0.1 let
      //     it escape `render()` entirely, past OrbitRenderError handling and
      //     past the `{ ok: false }` contract. We name the filter and the
      //     thrown value's constructor; the message and stack are the host's
      //     internals and are deliberately not surfaced.
      this.checkDeadline(span);
      let result: unknown;
      try {
        result = host.impl(args);
      } catch (err) {
        this.fail(
          'O4036',
          `host filter ${JSON.stringify(name)} threw ${describeThrown(err)}; host filters must handle their own failures`,
          span,
        );
      }
      this.checkDeadline(span);
      if (typeof result === 'string') this.capString(result, span);
      if (Array.isArray(result)) this.capList(result, span);
      // Byte-charge filter output so "produce huge, emit nothing" still burns fuel.
      if (typeof result === 'string') {
        this.fuel -= result.length;
        if (this.fuel < 0) this.fail('O4001', 'render fuel exhausted (filter output)', span);
      }
      if (host.returns.kind === 'html') {
        if (typeof result !== 'string') {
          this.fail('O4035', `host filter ${JSON.stringify(name)} declared Html but returned a non-string`, span);
        }
        return htmlValue(result, host.trustedHtml === true);
      }
      return result === undefined ? null : result;
    }
    const stdlib = STDLIB.get(name);
    if (stdlib === undefined) this.fail('O4028', `unknown filter ${JSON.stringify(name)}`, span);
    const result = stdlib.eval(args, filterRt);
    if (typeof result === 'string') {
      this.fuel -= result.length;
      if (this.fuel < 0) this.fail('O4001', 'render fuel exhausted (filter output)', span);
    }
    return result;
  }

  private stringify(value: unknown, span: Span): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) this.fail('O4029', 'cannot render a non-finite number', span);
      return String(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value === null || value === undefined) {
      this.fail('O4012', 'rendered value is none — data violated its declared type', span);
    }
    this.fail('O4014', 'cannot render a structured value', span);
  }
}

// ---------------------------------------------------------------------------
// Host-object access helpers
// ---------------------------------------------------------------------------

function isRecordValue(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Read `key` from a HOST-supplied plain object. Reserved names and inherited
 * members are invisible: `pick(props, '__proto__')` is `undefined`, never
 * `Object.prototype`.
 */
function pick(source: Record<string, unknown> | undefined, key: string): unknown {
  if (source === undefined || source === null) return undefined;
  if (isForbiddenKey(key)) return undefined;
  if (!Object.hasOwn(source, key)) return undefined;
  return source[key];
}

/** Names the thrown value's kind WITHOUT leaking the host's message or stack. */
function describeThrown(err: unknown): string {
  if (err instanceof Error) {
    let name = 'Error';
    try {
      const n: unknown = err.name;
      if (typeof n === 'string' && n.length > 0 && n.length <= 64) name = n;
    } catch {
      // a hostile `name` getter changes nothing: we fall back to 'Error'
    }
    return `a ${name}`;
  }
  return `a non-Error value of type ${typeof err}`;
}

// ---------------------------------------------------------------------------
// Shallow prop-shape validation (component entries)
// ---------------------------------------------------------------------------

function typeExprToString(te: TypeExpr): string {
  switch (te.kind) {
    case 'name':
      return te.name;
    case 'list':
      return `List<${typeExprToString(te.inner)}>`;
    case 'optional':
      return `${typeExprToString(te.inner)}?`;
  }
}

/** The shape the engine actually received, for the error message. */
function shapeName(v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (Array.isArray(v)) return 'List';
  switch (typeof v) {
    case 'string':
      return 'String';
    case 'boolean':
      return 'Bool';
    case 'number':
      return Number.isInteger(v) ? 'Int' : 'Float';
    case 'object':
      return 'Record';
    default:
      return typeof v;
  }
}

/**
 * O(1) per prop. Lists are checked for array-ness only — the elements are
 * NOT walked, so validating a 5,000-item catalog prop costs one `isArray`.
 */
function propShapeValid(te: TypeExpr, v: unknown): boolean {
  if (te.kind === 'optional') {
    return v === null || v === undefined ? true : propShapeValid(te.inner, v);
  }
  if (v === null || v === undefined) return false;
  if (te.kind === 'list') return Array.isArray(v);
  switch (te.name) {
    case 'Int':
      return typeof v === 'number' && Number.isInteger(v);
    case 'Float':
      // Int is assignable to Float (see types.ts `assignable`).
      return typeof v === 'number' && Number.isFinite(v);
    case 'String':
      return typeof v === 'string';
    case 'Bool':
      return typeof v === 'boolean';
    case 'Color':
      return typeof v === 'string' && isHexColorLiteral(v);
    default:
      // Host object / opaque type: the representation is host-private, so
      // "present" is the strongest honest assertion the engine can make.
      return true;
  }
}
