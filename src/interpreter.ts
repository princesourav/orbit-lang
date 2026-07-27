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
} from './ast';
import { OrbitRenderError, type Span } from './diagnostics';
import { escapeAttr, escapeRcdata, escapeText, sanitizeUrl, serializeJsonLd } from './escape';
import { isHtmlValue, unsafeHtmlValue, type HostFilterDecl } from './host';
import { LIMITS } from './limits';
import { DEFAULT_LOCALE, STDLIB, type FilterRuntime, type LocaleData } from './stdlib';

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
}

export interface RenderErrorInfo {
  code: string;
  message: string;
  template?: string;
  line?: number;
  col?: number;
}

export type RenderResult =
  | { ok: true; html: string; warnings: string[] }
  | { ok: false; error: RenderErrorInfo; warnings: string[] };

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
  readonly warnings: string[] = [];
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
  private readonly hostFilters: Map<string, HostFilterDecl>;
  private readonly locale: LocaleData;

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
    this.hostFilters = new Map((options.hostFilters ?? []).map((f) => [f.name, f]));
    this.locale = options.locale ?? DEFAULT_LOCALE;
  }

  renderEntry(entry: string): string {
    const template = this.program.templates.get(entry);
    if (template === undefined) {
      throw new OrbitRenderError('O4016', `unknown template ${JSON.stringify(entry)}`);
    }
    this.currentTemplate = template.name;
    const vars = new Map<string, unknown>();
    if (template.templateKind === 'page') {
      for (const [k, v] of Object.entries(this.options.bindings ?? {})) vars.set(k, v);
    } else {
      for (const decl of template.props) {
        const provided = this.options.props?.[decl.name];
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
    const provided = this.options.settings?.[template.name] ?? {};
    const out: Record<string, unknown> = {};
    for (const decl of template.settings) {
      const value = provided[decl.name];
      if (value !== undefined && this.settingValueValid(decl, value)) {
        out[decl.name] = value;
      } else {
        if (value !== undefined) {
          this.warnings.push(
            `setting ${template.name}.${decl.name}: provided value is invalid for its control; using the declared default`,
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
        return typeof value === 'string' && value.length === 7 && value.startsWith('#');
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
      const checked = sanitizeUrl(raw, attr.name);
      if (!checked.ok) {
        this.warnings.push(
          `${this.currentTemplate}:${span.start.line}:${span.start.col} blocked unsafe URL in ${attr.name}: ${checked.reason}`,
        );
        this.emit(` ${attr.name}="#"`, span);
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
        const out: Record<string, unknown> = {};
        for (const field of expr.fields) out[field.key] = this.evalExpr(field.value, scope);
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
        const args = expr.args.map((a) => this.evalExpr(a, scope));
        return this.applyFilter(expr.callee, args, expr.span);
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
      const result = host.impl(args);
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
        return unsafeHtmlValue(result);
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
