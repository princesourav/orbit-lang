/**
 * Type checker ("type system lite") over parsed templates.
 *
 * The load-bearing rules:
 * - NO truthiness: <if> conditions and &&/|| operands must be Bool (O3007)
 * - THE OPTIONAL LAW: a T? cannot be used where T is needed without `??` or
 *   flow-narrowing via `x != none` in the guarding <if> (O2104, with fix-it)
 * - terminal branded types: Html is element-content-only (never a prop,
 *   binding, operand or attribute — W-13); Money admits no operators, no
 *   interpolation, no stdlib filters (W-23); MoneyText renders but admits no
 *   filters (W-24); Image is host-filter-input only (W-21b)
 * - component prop/slot contracts; acyclic component graph
 * - loop limits and range bounds are compile-time literals (W-05a)
 *
 * Output: a diagnostics list with spans — the checker never throws on bad
 * templates.
 *
 * DIAGNOSTIC CODE RANGES (about to become documented public API — v0.5 ships
 * the error-code index, v1.0 freezes the codes, so every code means exactly
 * one thing and codes are never recycled):
 *   O1xxx  lexer + parser (syntax, allowlists, structural caps)
 *   O2xxx  checker (signatures, types, contracts, filters)
 *   O3xxx  checker, truthiness rules
 *   O4xxx  interpreter + escaping (runtime)
 *   O5xxx  AST re-validation on load
 */
import {
  groupSlotChildren,
  type Attr,
  type Expr,
  type Node,
  type Program,
  type SettingControl,
  type Template,
  type TypeExpr,
} from './ast';
import { type Diagnostic, type Span } from './diagnostics';
import { type HostFilterDecl } from './host';
import { LIMITS } from './limits';
import { STDLIB, STDLIB_FILTER_NAMES, type FilterArg } from './stdlib';
import {
  assignable,
  isOpaqueNamed,
  t,
  type Type,
  type TypeRegistry,
  typeToString,
  unwrapOptional,
} from './types';

export interface CheckOptions {
  registry: TypeRegistry;
  hostFilters?: readonly HostFilterDecl[];
  /** Top-level bindings available to `page` templates. */
  pageGlobals?: Record<string, Type>;
}

export interface CheckResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

interface Scope {
  vars: Map<string, Type>;
  parent?: Scope;
}

interface TemplateSig {
  kind: 'component' | 'page';
  props: Map<string, { type: Type; required: boolean }>;
  settingsType: Type;
  /** name -> required. Includes 'default' when the body has <slot/>. */
  declaredSlots: Map<string, boolean>;
}

type ContentCtx = 'text' | 'rcdata';

export function check(program: Program, options: CheckOptions): CheckResult {
  const checker = new Checker(program, options);
  checker.run();
  const ok = checker.diagnostics.every((d) => d.severity !== 'error');
  return { ok, diagnostics: checker.diagnostics };
}

class Checker {
  readonly diagnostics: Diagnostic[] = [];
  private readonly registry: TypeRegistry;
  private readonly hostFilters: Map<string, HostFilterDecl>;
  private readonly pageGlobals: Record<string, Type>;
  private readonly sigs = new Map<string, TemplateSig>();
  private currentTemplate = '<template>';

  constructor(
    private readonly program: Program,
    options: CheckOptions,
  ) {
    this.registry = options.registry;
    this.hostFilters = new Map((options.hostFilters ?? []).map((f) => [f.name, f]));
    this.pageGlobals = options.pageGlobals ?? {};
  }

  run(): void {
    for (const template of this.program.templates.values()) {
      this.currentTemplate = template.name;
      this.sigs.set(template.name, this.buildSig(template));
    }
    this.checkAcyclic();
    for (const template of this.program.templates.values()) {
      this.currentTemplate = template.name;
      this.checkTemplate(template);
    }
  }

  // -- diagnostics ----------------------------------------------------------

  private report(code: string, message: string, span: Span, suggestion?: string, severity: 'error' | 'warning' = 'error'): void {
    this.diagnostics.push({ code, severity, message, suggestion, template: this.currentTemplate, span });
  }

  private suggestName(name: string, candidates: Iterable<string>): string | undefined {
    let best: string | undefined;
    let bestDist = 3;
    for (const c of candidates) {
      const d = editDistance(name, c, 2);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best !== undefined ? `did you mean \`${best}\`?` : undefined;
  }

  // -- signatures -----------------------------------------------------------

  private buildSig(template: Template): TemplateSig {
    const props = new Map<string, { type: Type; required: boolean }>();
    for (const decl of template.props) {
      // v0.2 decision: a `page` cannot declare props. Nothing ever passes them
      // (a page is an entry point, not a callee), so before this diagnostic a
      // declared page prop was silently dead and only surfaced downstream as a
      // generic "unknown identifier". Page-prop semantics are unspecified and
      // v1.0 freezes the surface, so this rejects rather than guesses.
      if (template.templateKind === 'page') {
        this.report(
          'O2017',
          `page ${JSON.stringify(template.name)} cannot declare props (prop ${JSON.stringify(decl.name)}) — pages are entry points, not callees`,
          decl.span,
          `remove the props block; the host supplies page data as top-level bindings (\`pageGlobals\` in CheckOptions), so \`${decl.name}\` should be declared there`,
        );
      }
      if (props.has(decl.name)) {
        this.report('O2010', `duplicate prop ${JSON.stringify(decl.name)}`, decl.span);
        continue;
      }
      const type = this.resolveTypeExpr(decl.type);
      if (type.kind === 'html') {
        this.report('O2011', 'Html cannot be a prop type (it is element-content-only)', decl.span);
      }
      let required = type.kind !== 'optional';
      if (decl.defaultValue !== undefined) {
        required = false;
        const dt = this.literalType(decl.defaultValue);
        if (!assignable(dt, type)) {
          this.report(
            'O2012',
            `default for prop ${JSON.stringify(decl.name)} is ${typeToString(dt)}, expected ${typeToString(type)}`,
            decl.span,
          );
        }
      }
      props.set(decl.name, { type, required });
    }

    const settingsFields: Record<string, Type> = {};
    const seenSettings = new Set<string>();
    for (const decl of template.settings) {
      if (seenSettings.has(decl.name)) {
        this.report('O2013', `duplicate setting ${JSON.stringify(decl.name)}`, decl.span);
        continue;
      }
      seenSettings.add(decl.name);
      const type = settingType(decl.setting);
      settingsFields[decl.name] = type;
      this.checkSettingControl(decl.name, decl.setting, decl.span);
      this.checkSettingDefault(decl.name, decl.setting, decl.defaultValue, decl.span);
    }

    const declaredSlots = new Map<string, boolean>();
    for (const decl of template.slots) {
      if (declaredSlots.has(decl.name)) {
        this.report('O2014', `duplicate slot ${JSON.stringify(decl.name)}`, decl.span);
        continue;
      }
      declaredSlots.set(decl.name, decl.required);
    }
    if (hasDefaultSlotNode(template.body) && !declaredSlots.has('default')) {
      declaredSlots.set('default', false);
    }

    return {
      kind: template.templateKind,
      props,
      settingsType: t.record(settingsFields),
      declaredSlots,
    };
  }

  /**
   * Validate the CONTROL itself, independently of its default. A `Range` whose
   * bounds are inverted or whose step is zero produces a control no merchant
   * UI can render (and, for step 0, an infinite stepper); checking only that
   * the default sat inside the bounds let all of that through.
   */
  private checkSettingControl(name: string, control: SettingControl, span: Span): void {
    if (control.control !== 'range') return;
    if (control.min > control.max) {
      this.report(
        'O2018',
        `setting ${JSON.stringify(name)}: Range min (${control.min}) is greater than max (${control.max})`,
        span,
        `write Range(${control.max}, ${control.min}${control.step === 1 ? '' : `, step: ${control.step}`})`,
      );
      return;
    }
    if (control.step <= 0) {
      this.report(
        'O2019',
        `setting ${JSON.stringify(name)}: Range step must be greater than 0 (found ${control.step})`,
        span,
        'write step: 1',
      );
      return;
    }
    // Cheap reachability check: with a step that does not divide the span, the
    // declared maximum is not selectable.
    const spanSize = control.max - control.min;
    if (spanSize % control.step !== 0) {
      this.report(
        'O2020',
        `setting ${JSON.stringify(name)}: step ${control.step} never reaches max (${control.min}..${control.max} is ${spanSize} wide)`,
        span,
        `use a step that divides ${spanSize}, or set max to ${control.min + Math.floor(spanSize / control.step) * control.step}`,
        'warning',
      );
    }
  }

  private checkSettingDefault(name: string, control: SettingControl, def: Expr, span: Span): void {
    switch (control.control) {
      case 'text':
        if (def.kind !== 'string') this.report('O2015', `setting ${JSON.stringify(name)}: Text default must be a string`, span);
        return;
      case 'toggle':
        if (def.kind !== 'bool') this.report('O2015', `setting ${JSON.stringify(name)}: Toggle default must be true or false`, span);
        return;
      case 'color':
        if (def.kind !== 'color') this.report('O2015', `setting ${JSON.stringify(name)}: Color default must be a #rrggbb literal`, span);
        return;
      case 'select':
        if (def.kind !== 'string' || !control.options.includes(def.value)) {
          this.report(
            'O2015',
            `setting ${JSON.stringify(name)}: Select default must be one of ${control.options.map((o) => JSON.stringify(o)).join(', ')}`,
            span,
          );
        }
        return;
      case 'range':
        if (def.kind !== 'int' || def.value < control.min || def.value > control.max) {
          this.report('O2015', `setting ${JSON.stringify(name)}: Range default must be an Int within ${control.min}–${control.max}`, span);
        }
        return;
    }
  }

  private resolveTypeExpr(te: TypeExpr): Type {
    switch (te.kind) {
      case 'optional':
        return t.optional(this.resolveTypeExpr(te.inner));
      case 'list':
        return t.list(this.resolveTypeExpr(te.inner));
      case 'name': {
        if (te.name === 'Html') return t.html();
        const resolved = this.registry.resolveName(te.name);
        if (resolved === undefined) {
          this.report('O2016', `unknown type ${JSON.stringify(te.name)}`, te.span, this.suggestName(te.name, this.registry.typeNames()));
          return t.invalid();
        }
        return resolved;
      }
    }
  }

  private literalType(expr: Expr): Type {
    switch (expr.kind) {
      case 'int':
        return t.int();
      case 'float':
        return t.float();
      case 'string':
        return t.string();
      case 'bool':
        return t.bool();
      case 'color':
        return t.color();
      case 'none':
        return t.none();
      default:
        return t.invalid();
    }
  }

  // -- acyclicity -----------------------------------------------------------

  private checkAcyclic(): void {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, stack: string[]): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) {
        const from = stack.indexOf(name);
        const cycle = [...stack.slice(from), name].join(' -> ');
        const template = this.program.templates.get(name);
        if (template !== undefined) {
          this.currentTemplate = name;
          this.report('O2091', `component cycle: ${cycle}`, template.span);
        }
        return;
      }
      visiting.add(name);
      const template = this.program.templates.get(name);
      if (template !== undefined) {
        for (const callee of collectComponentCalls(template.body)) {
          visit(callee, [...stack, name]);
        }
      }
      visiting.delete(name);
      done.add(name);
    };
    for (const name of this.program.templates.keys()) visit(name, []);
  }

  // -- template body --------------------------------------------------------

  private checkTemplate(template: Template): void {
    const sig = this.sigs.get(template.name);
    if (sig === undefined) return;
    const vars = new Map<string, Type>();
    if (template.templateKind === 'page') {
      for (const [name, type] of Object.entries(this.pageGlobals)) vars.set(name, type);
    } else {
      for (const [name, prop] of sig.props) vars.set(name, prop.type);
    }
    vars.set('settings', sig.settingsType);
    const scope: Scope = { vars };
    this.checkNodes(template.body, scope, new Set(), 'text', template);
  }

  private checkNodes(nodes: readonly Node[], scopeIn: Scope, narrowed: ReadonlySet<string>, ctx: ContentCtx, template: Template): void {
    let scope = scopeIn;
    for (const node of nodes) {
      switch (node.kind) {
        case 'text':
          break;
        case 'interpolation': {
          const type = this.typeOf(node.expr, scope, narrowed);
          if (type.kind === 'optional') {
            this.reportOptionalLaw(node.expr, type, node.span);
            break;
          }
          this.checkPrintable(type, node.span, ctx);
          break;
        }
        case 'element': {
          this.checkAttrs(node.attrs, scope, narrowed);
          const childCtx: ContentCtx = node.content === 'rcdata' ? 'rcdata' : 'text';
          this.checkNodes(node.children, scope, narrowed, childCtx, template);
          break;
        }
        case 'if': {
          let accumulatedFalse = new Set<string>(narrowed);
          for (const branch of node.branches) {
            const condType = this.typeOf(branch.cond, scope, accumulatedFalse);
            this.requireBool(condType, branch.cond, '<if> condition');
            const branchNarrow = new Set(accumulatedFalse);
            for (const p of narrowTrue(branch.cond)) branchNarrow.add(p);
            this.checkNodes(branch.children, scope, branchNarrow, ctx, template);
            const f = new Set(accumulatedFalse);
            for (const p of narrowFalse(branch.cond)) f.add(p);
            accumulatedFalse = f;
          }
          if (node.elseChildren !== undefined) {
            this.checkNodes(node.elseChildren, scope, accumulatedFalse, ctx, template);
          }
          break;
        }
        case 'for': {
          const subjectType = this.typeOf(node.subject, scope, narrowed);
          let itemType: Type = t.invalid();
          if (subjectType.kind === 'optional') {
            this.reportOptionalLaw(node.subject, subjectType, node.span);
          } else if (subjectType.kind === 'list') {
            itemType = subjectType.element;
          } else if (subjectType.kind === 'range') {
            itemType = t.int();
          } else if (subjectType.kind !== 'invalid') {
            this.report('O2077', `<for> needs a List or Range, found ${typeToString(subjectType)}`, node.span);
          }
          if (node.limit !== undefined) {
            if (node.limit.kind !== 'int' || node.limit.value < 1 || node.limit.value > LIMITS.maxLoopLimit) {
              this.report(
                'O2078',
                `limit must be a literal Int between 1 and ${LIMITS.maxLoopLimit}`,
                node.limit.span ?? node.span,
              );
            }
          }
          const loopVars = new Map<string, Type>();
          loopVars.set(node.item, itemType);
          if (node.index !== undefined) loopVars.set(node.index, t.int());
          this.checkNodes(node.children, { vars: loopVars, parent: scope }, pruneNarrowed(narrowed, [node.item, node.index]), ctx, template);
          if (node.emptyChildren !== undefined) {
            this.checkNodes(node.emptyChildren, scope, narrowed, ctx, template);
          }
          break;
        }
        case 'let': {
          const type = this.typeOf(node.expr, scope, narrowed);
          if (type.kind === 'html') {
            this.report('O2079', 'Html cannot be bound with <let> (element-content only)', node.span);
          }
          const vars = new Map<string, Type>();
          vars.set(node.name, type.kind === 'html' ? t.invalid() : type);
          scope = { vars, parent: scope };
          narrowed = pruneNarrowed(narrowed, [node.name]);
          break;
        }
        case 'component':
          this.checkComponentCall(node.name, node.props, node.children, node.span, scope, narrowed, ctx, template);
          break;
        case 'slot': {
          if (template.templateKind !== 'component') {
            this.report('O2088', '<slot> is only valid inside components', node.span);
            break;
          }
          const sig = this.sigs.get(template.name);
          if (node.name !== 'default' && sig !== undefined && !sig.declaredSlots.has(node.name)) {
            this.report(
              'O2089',
              `slot ${JSON.stringify(node.name)} is not declared in frontmatter`,
              node.span,
              `add \`slots { ${node.name}? }\` to the frontmatter`,
            );
          }
          break;
        }
        case 'json-ld': {
          const type = this.typeOf(node.expr, scope, narrowed);
          if (!jsonSafe(type)) {
            this.report(
              'O2090',
              `json-ld admits primitives, records and lists only (found ${typeToString(type)})`,
              node.span,
              'project values into a record of primitives first',
            );
          }
          break;
        }
      }
    }
  }

  private checkAttrs(attrs: readonly Attr[], scope: Scope, narrowed: ReadonlySet<string>): void {
    for (const attr of attrs) {
      switch (attr.value.form) {
        case 'bare':
          break;
        case 'conditional': {
          const type = this.typeOf(attr.value.expr, scope, narrowed);
          this.requireBool(type, attr.value.expr, `conditional attribute ${JSON.stringify(attr.name)}`);
          break;
        }
        case 'expr': {
          const type = this.typeOf(attr.value.expr, scope, narrowed);
          this.checkAttrValueType(type, attr, attr.value.expr);
          break;
        }
        case 'parts': {
          for (const part of attr.value.parts) {
            if (part.kind !== 'expr') continue;
            const type = this.typeOf(part.expr, scope, narrowed);
            this.checkAttrValueType(type, attr, part.expr);
          }
          break;
        }
      }
    }
  }

  private checkAttrValueType(type: Type, attr: Attr, expr: Expr): void {
    if (type.kind === 'invalid') return;
    if (type.kind === 'optional') {
      this.reportOptionalLaw(expr, type, expr.span);
      return;
    }
    if (type.kind === 'html') {
      this.report('O2076', 'Html cannot appear in attributes (element-content only)', expr.span);
      return;
    }
    if (isOpaqueNamed(type, 'Money')) {
      this.report('O2060', 'Money cannot be rendered directly; pass it to a host money filter', expr.span);
      return;
    }
    if (isOpaqueNamed(type, 'Image')) {
      this.report('O2061', 'Image is an opaque handle; pass it to a host image filter', expr.span);
      return;
    }
    if (attr.isUrl) {
      const ok = type.kind === 'string' || type.kind === 'union' || isOpaqueNamed(type, 'Url');
      if (!ok) {
        this.report(
          'O2064',
          `URL attribute ${JSON.stringify(attr.name)} needs a Url or String, found ${typeToString(type)}`,
          expr.span,
        );
      }
      return;
    }
    const ok =
      type.kind === 'string' ||
      type.kind === 'int' ||
      type.kind === 'float' ||
      type.kind === 'bool' ||
      type.kind === 'color' ||
      type.kind === 'union' ||
      isOpaqueNamed(type, 'MoneyText') ||
      isOpaqueNamed(type, 'Url');
    if (!ok) {
      this.report('O2074', `cannot render a ${typeToString(type)} in an attribute`, expr.span);
    }
  }

  private checkComponentCall(
    name: string,
    props: readonly Attr[],
    children: readonly Node[],
    span: Span,
    scope: Scope,
    narrowed: ReadonlySet<string>,
    ctx: ContentCtx,
    template: Template,
  ): void {
    const sig = this.sigs.get(name);
    if (sig === undefined) {
      this.report('O2080', `unknown component ${JSON.stringify(name)}`, span, this.suggestName(name, this.program.templates.keys()));
      return;
    }
    if (sig.kind === 'page') {
      this.report('O2081', `${JSON.stringify(name)} is a page and cannot be called as a component`, span);
      return;
    }
    const provided = new Set<string>();
    for (const prop of props) {
      const decl = sig.props.get(prop.name);
      if (decl === undefined) {
        this.report('O2082', `component ${name} has no prop ${JSON.stringify(prop.name)}`, prop.span, this.suggestName(prop.name, sig.props.keys()));
        continue;
      }
      provided.add(prop.name);
      let argType: Type;
      if (prop.value.form === 'bare') {
        argType = t.bool();
      } else if (prop.value.form === 'expr') {
        argType = this.typeOf(prop.value.expr, scope, narrowed);
      } else if (prop.value.form === 'parts') {
        argType = t.string(); // parser guarantees static-text-only parts
      } else {
        // Distinct from O2082 ("no such prop"): the prop exists, the SYNTAX is
        // wrong. `?=` is the conditional-attribute form and has no meaning on
        // a component prop.
        this.report(
          'O2092',
          `prop ${JSON.stringify(prop.name)} cannot use ?= (that form is for conditional HTML attributes)`,
          prop.span,
          `write ${prop.name}={someBoolExpr}`,
        );
        continue;
      }
      if (argType.kind === 'html') {
        this.report('O2011', 'Html cannot be passed as a prop (element-content only)', prop.span);
        continue;
      }
      if (argType.kind === 'optional' && decl.type.kind !== 'optional') {
        const expr = prop.value.form === 'expr' ? prop.value.expr : undefined;
        this.reportOptionalLaw(expr, argType, prop.span);
        continue;
      }
      if (!assignable(argType, decl.type)) {
        this.report(
          'O2083',
          `prop ${JSON.stringify(prop.name)} expects ${typeToString(decl.type)}, found ${typeToString(argType)}`,
          prop.span,
        );
      }
    }
    for (const [propName, decl] of sig.props) {
      if (decl.required && !provided.has(propName)) {
        this.report('O2084', `missing required prop ${JSON.stringify(propName)} on <${name}>`, span);
      }
    }
    // Slot contracts.
    const grouped = groupSlotChildren([...children]);
    for (const mixed of grouped.mixed) {
      this.report(
        'O2085',
        'ambiguous slot attribution: every element a control-flow wrapper can render must target the same slot',
        mixed.span,
      );
    }
    for (const slotName of grouped.slots.keys()) {
      if (!sig.declaredSlots.has(slotName)) {
        this.report(
          'O2086',
          slotName === 'default'
            ? `component ${name} declares no default slot`
            : `component ${name} has no slot named ${JSON.stringify(slotName)}`,
          span,
          slotName === 'default' ? undefined : this.suggestName(slotName, sig.declaredSlots.keys()),
        );
      }
    }
    for (const [slotName, required] of sig.declaredSlots) {
      if (required && !grouped.slots.has(slotName)) {
        this.report('O2087', `slot ${JSON.stringify(slotName)} on <${name}> is required`, span);
      }
    }
    // Slot content is checked lexically, in the CALLER's scope.
    this.checkNodes([...children], scope, narrowed, ctx, template);
  }

  // -- printability + Bool + optional law -------------------------------------

  private checkPrintable(type: Type, span: Span, ctx: ContentCtx): void {
    switch (type.kind) {
      case 'invalid':
      case 'string':
      case 'int':
      case 'float':
      case 'bool':
      case 'color':
      case 'union':
        return;
      case 'html':
        if (ctx === 'rcdata') {
          this.report('O2075', 'Html cannot render inside <title>/<textarea>', span);
        }
        return;
      case 'optional':
        this.reportOptionalLaw(undefined, type, span);
        return;
      case 'opaque':
        if (type.name === 'MoneyText' || type.name === 'Url') return;
        if (type.name === 'Money') {
          this.report('O2060', 'Money cannot be rendered directly; pass it to a host money filter', span);
          return;
        }
        if (type.name === 'Image') {
          this.report('O2061', 'Image is an opaque handle; pass it to a host image filter', span);
          return;
        }
        this.report('O2074', `cannot render a value of type ${typeToString(type)}`, span);
        return;
      default:
        this.report('O2074', `cannot render a value of type ${typeToString(type)}`, span);
    }
  }

  private requireBool(type: Type, expr: Expr, what: string): void {
    if (type.kind === 'bool' || type.kind === 'invalid') return;
    if (type.kind === 'optional') {
      const path = pathOf(expr);
      this.report(
        'O3007',
        `${what} must be Bool, found ${typeToString(type)}`,
        expr.span,
        path !== undefined ? `write {${path} != none}` : 'compare against none: {value != none}',
      );
      return;
    }
    this.report(
      'O3007',
      `${what} must be Bool, found ${typeToString(type)} (there is no truthiness)`,
      expr.span,
      type.kind === 'string' ? 'write an explicit comparison, e.g. {value != ""}' : undefined,
    );
  }

  private reportOptionalLaw(expr: Expr | undefined, type: Type, span: Span): void {
    const inner = typeToString(unwrapOptional(type));
    const path = expr !== undefined ? pathOf(expr) : undefined;
    const fallback = path ?? 'value';
    this.report(
      'O2104',
      `optional value used without a fallback (\`${typeToString(type)}\`) — decide what happens when it is absent`,
      span,
      `use {${fallback} ?? ${defaultFallbackFor(inner)}} or wrap in <if {${fallback} != none}>`,
    );
  }

  // -- expressions ------------------------------------------------------------

  private typeOf(expr: Expr, scope: Scope, narrowed: ReadonlySet<string>): Type {
    switch (expr.kind) {
      case 'int':
        return t.int();
      case 'float':
        return t.float();
      case 'string':
        return t.string();
      case 'bool':
        return t.bool();
      case 'color':
        return t.color();
      case 'none':
        return t.none();
      case 'ident': {
        const found = lookup(scope, expr.name);
        if (found === undefined) {
          this.report('O2030', `unknown identifier ${JSON.stringify(expr.name)}`, expr.span, this.suggestName(expr.name, scopeNames(scope)));
          return t.invalid();
        }
        if (found.kind === 'optional' && narrowed.has(expr.name)) return found.inner;
        return found;
      }
      case 'list': {
        let element: Type = t.invalid();
        for (const item of expr.items) {
          const it = this.typeOf(item, scope, narrowed);
          element = element.kind === 'invalid' ? it : this.unify(element, it, item.span);
        }
        return t.list(element);
      }
      case 'record': {
        const fields: Record<string, Type> = {};
        const seen = new Set<string>();
        for (const field of expr.fields) {
          if (seen.has(field.key)) {
            this.report('O2033', `duplicate record key ${JSON.stringify(field.key)}`, field.value.span);
            continue;
          }
          seen.add(field.key);
          fields[field.key] = this.typeOf(field.value, scope, narrowed);
        }
        return t.record(fields);
      }
      case 'range': {
        const okBound = (e: Expr): boolean => e.kind === 'int' || (e.kind === 'unary' && e.op === '-' && e.operand.kind === 'int');
        if (!okBound(expr.start) || !okBound(expr.end)) {
          this.report('O2050', 'range bounds must be literal integers (a..b)', expr.span, 'loop over a host-resolved list for dynamic counts');
          return t.invalid();
        }
        // Also verify the range is not absurdly large at compile time.
        const startV = literalIntValue(expr.start);
        const endV = literalIntValue(expr.end);
        if (startV !== undefined && endV !== undefined && endV - startV + 1 > LIMITS.maxLoopLimit) {
          this.report('O2051', `range spans more than ${LIMITS.maxLoopLimit} values`, expr.span);
          return t.invalid();
        }
        return t.range();
      }
      case 'member':
        return this.typeOfMember(expr, scope, narrowed);
      case 'index': {
        const objType = this.typeOf(expr.object, scope, narrowed);
        const idxType = this.typeOf(expr.index, scope, narrowed);
        if (idxType.kind !== 'int' && idxType.kind !== 'invalid') {
          this.report('O2034', `list index must be Int, found ${typeToString(idxType)}`, expr.index.span);
        }
        if (objType.kind === 'invalid') return t.invalid();
        if (objType.kind === 'optional') {
          this.reportOptionalLaw(expr.object, objType, expr.span);
          return t.invalid();
        }
        if (objType.kind !== 'list') {
          this.report('O2035', `only lists can be indexed (found ${typeToString(objType)}) — dynamic member access is not supported`, expr.span);
          return t.invalid();
        }
        return t.optional(objType.element); // out-of-range is none
      }
      case 'call':
        return this.typeOfCall(expr, scope, narrowed);
      case 'unary': {
        const operand = this.typeOf(expr.operand, scope, narrowed);
        if (operand.kind === 'invalid') return t.invalid();
        if (expr.op === '!') {
          this.requireBool(operand, expr.operand, 'operand of !');
          return t.bool();
        }
        if (operand.kind === 'int' || operand.kind === 'float') return operand;
        if (operand.kind === 'optional') this.reportOptionalLaw(expr.operand, operand, expr.span);
        else this.report('O2036', `unary - needs Int or Float, found ${typeToString(operand)}`, expr.span);
        return t.invalid();
      }
      case 'binary':
        return this.typeOfBinary(expr, scope, narrowed);
      case 'coalesce': {
        const left = this.typeOf(expr.left, scope, narrowed);
        const right = this.typeOf(expr.right, scope, narrowed);
        if (left.kind !== 'optional' && left.kind !== 'invalid' && left.kind !== 'none') {
          // O2072 is the redundant-`??` warning ONLY; the redundant-`?.`
          // warning is O2093 (they were the same code before v0.2).
          this.report('O2072', `left of ?? is never none (${typeToString(left)})`, expr.left.span, undefined, 'warning');
          return left;
        }
        if (left.kind === 'none' || left.kind === 'invalid') return right;
        return this.unify(left.inner, right, expr.span);
      }
      case 'cond': {
        const test = this.typeOf(expr.test, scope, narrowed);
        this.requireBool(test, expr.test, 'ternary condition');
        const thenNarrow = new Set(narrowed);
        for (const p of narrowTrue(expr.test)) thenNarrow.add(p);
        const elseNarrow = new Set(narrowed);
        for (const p of narrowFalse(expr.test)) elseNarrow.add(p);
        const thenT = this.typeOf(expr.then, scope, thenNarrow);
        const elseT = this.typeOf(expr.else, scope, elseNarrow);
        return this.unify(thenT, elseT, expr.span);
      }
    }
  }

  private typeOfMember(expr: Expr & { kind: 'member' }, scope: Scope, narrowed: ReadonlySet<string>): Type {
    const objType = this.typeOf(expr.object, scope, narrowed);
    if (objType.kind === 'invalid') return t.invalid();

    let base: Type = objType;
    let resultOptional = false;
    if (objType.kind === 'optional') {
      if (expr.optional) {
        base = objType.inner;
        resultOptional = true;
      } else {
        this.reportOptionalLaw(expr.object, objType, expr.span);
        return t.invalid();
      }
    } else if (expr.optional) {
      // Distinct from O2072 (redundant `??`): this is a redundant `?.`.
      this.report('O2093', `?. on a value that is never none (${typeToString(objType)})`, expr.span, 'use plain . here', 'warning');
    }

    let fieldType: Type | undefined;
    if (base.kind === 'object') {
      const fields = this.registry.fieldsOf(base.name);
      fieldType = fields?.[expr.property];
      if (fieldType === undefined) {
        this.report(
          'O2031',
          `\`${base.name}\` has no property \`${expr.property}\``,
          expr.span,
          this.suggestName(expr.property, Object.keys(fields ?? {})),
        );
        return t.invalid();
      }
    } else if (base.kind === 'record') {
      fieldType = base.fields[expr.property];
      if (fieldType === undefined) {
        this.report('O2031', `record has no key \`${expr.property}\``, expr.span, this.suggestName(expr.property, Object.keys(base.fields)));
        return t.invalid();
      }
    } else if (isOpaqueNamed(base, 'Money')) {
      this.report('O2060', 'Money exposes no properties — money math is not expressible in templates', expr.span);
      return t.invalid();
    } else {
      this.report('O2032', `${typeToString(base)} has no properties`, expr.span, base.kind === 'list' ? 'use size(list) or a <for> loop' : undefined);
      return t.invalid();
    }

    let result = resultOptional ? t.optional(fieldType) : fieldType;
    const path = pathOf(expr);
    if (result.kind === 'optional' && path !== undefined && narrowed.has(path)) {
      result = result.inner;
    }
    return result;
  }

  private typeOfBinary(expr: Expr & { kind: 'binary' }, scope: Scope, narrowed: ReadonlySet<string>): Type {
    const { op } = expr;
    if (op === '&&' || op === '||') {
      const leftT = this.typeOf(expr.left, scope, narrowed);
      this.requireBool(leftT, expr.left, `left of ${op}`);
      // Right side of && sees the left side's narrowing.
      const rightNarrow = new Set(narrowed);
      if (op === '&&') for (const p of narrowTrue(expr.left)) rightNarrow.add(p);
      const rightT = this.typeOf(expr.right, scope, rightNarrow);
      this.requireBool(rightT, expr.right, `right of ${op}`);
      return t.bool();
    }
    if (op === '==' || op === '!=') {
      const leftT = this.typeOf(expr.left, scope, narrowed);
      const rightT = this.typeOf(expr.right, scope, narrowed);
      return this.typeOfEquality(expr, leftT, rightT);
    }
    // Arithmetic + comparisons: numeric only.
    const leftT = this.typeOf(expr.left, scope, narrowed);
    const rightT = this.typeOf(expr.right, scope, narrowed);
    for (const [operandExpr, type] of [
      [expr.left, leftT],
      [expr.right, rightT],
    ] as const) {
      if (type.kind === 'invalid') return t.invalid();
      if (type.kind === 'optional') {
        this.reportOptionalLaw(operandExpr, type, operandExpr.span);
        return t.invalid();
      }
      if (isOpaqueNamed(type, 'Money')) {
        this.report('O2060', 'Money admits no operators — use precomputed display facts from the host model', operandExpr.span);
        return t.invalid();
      }
      if (type.kind !== 'int' && type.kind !== 'float') {
        this.report(
          'O2037',
          `operator ${op} needs Int or Float, found ${typeToString(type)}`,
          operandExpr.span,
          type.kind === 'string' && op === '+' ? 'strings compose via interpolation: {a}{b}' : undefined,
        );
        return t.invalid();
      }
    }
    if (op === '<' || op === '<=' || op === '>' || op === '>=') return t.bool();
    if (op === '%') {
      if (leftT.kind !== 'int' || rightT.kind !== 'int') {
        this.report('O2037', '% needs Int operands', expr.span);
        return t.invalid();
      }
      return t.int();
    }
    if (op === '/') return t.float(); // division always yields Float; round() to get an Int
    return leftT.kind === 'int' && rightT.kind === 'int' ? t.int() : t.float();
  }

  private typeOfEquality(expr: Expr & { kind: 'binary' }, leftT: Type, rightT: Type): Type {
    if (leftT.kind === 'invalid' || rightT.kind === 'invalid') return t.bool();
    const leftNone = leftT.kind === 'none';
    const rightNone = rightT.kind === 'none';
    if (leftNone || rightNone) {
      const other = leftNone ? rightT : leftT;
      if (other.kind !== 'optional' && other.kind !== 'none') {
        this.report('O2065', `comparing ${typeToString(other)} to none is always ${expr.op === '==' ? 'false' : 'true'}`, expr.span, undefined, 'warning');
      }
      return t.bool();
    }
    const comparable = (type: Type): boolean =>
      type.kind === 'int' ||
      type.kind === 'float' ||
      type.kind === 'string' ||
      type.kind === 'bool' ||
      type.kind === 'color' ||
      type.kind === 'union' ||
      type.kind === 'optional';
    if (!comparable(leftT) || !comparable(rightT)) {
      const money = isOpaqueNamed(unwrapOptional(leftT), 'Money') || isOpaqueNamed(unwrapOptional(rightT), 'Money');
      this.report(
        'O2066',
        money
          ? 'Money has no equality — compare precomputed flags from the host model'
          : `cannot compare ${typeToString(leftT)} and ${typeToString(rightT)}`,
        expr.span,
      );
      return t.bool();
    }
    const l = unwrapOptional(leftT);
    const r = unwrapOptional(rightT);
    if (!assignable(l, r) && !assignable(r, l) && !(isNumericKind(l) && isNumericKind(r))) {
      this.report('O2066', `cannot compare ${typeToString(leftT)} and ${typeToString(rightT)}`, expr.span);
    }
    return t.bool();
  }

  private typeOfCall(expr: Expr & { kind: 'call' }, scope: Scope, narrowed: ReadonlySet<string>): Type {
    const argTypes: FilterArg[] = expr.args.map((a) => ({ expr: a, type: this.typeOf(a, scope, narrowed) }));

    // Terminality rules first (W-13, W-24): these hold for EVERY filter.
    for (const arg of argTypes) {
      if (arg.type.kind === 'html') {
        this.report('O2063', 'Html cannot be a filter operand', arg.expr.span);
        return t.invalid();
      }
      if (isOpaqueNamed(arg.type, 'MoneyText')) {
        this.report('O2062', 'MoneyText admits no filters — it only renders', arg.expr.span);
        return t.invalid();
      }
      if (arg.type.kind === 'optional') {
        this.reportOptionalLaw(arg.expr, arg.type, arg.expr.span);
        return t.invalid();
      }
    }

    const host = this.hostFilters.get(expr.callee);
    if (host !== undefined) {
      const min = host.params.length;
      const max = min + (host.optionalParams?.length ?? 0);
      if (expr.args.length < min || expr.args.length > max) {
        this.report('O2100', `${expr.callee} takes ${min === max ? String(min) : `${min}–${max}`} arguments, got ${expr.args.length}`, expr.span);
        return t.invalid();
      }
      const declared = [...host.params, ...(host.optionalParams ?? [])];
      for (let i = 0; i < argTypes.length; i += 1) {
        const arg = argTypes[i];
        const want = declared[i];
        if (arg === undefined || want === undefined) continue;
        if (!assignable(arg.type, want)) {
          this.report('O2101', `${expr.callee}: argument ${i + 1} must be ${typeToString(want)}, found ${typeToString(arg.type)}`, arg.expr.span);
          return t.invalid();
        }
      }
      if (host.unsafeHtml === true) {
        this.report(
          'O2071',
          `host filter ${JSON.stringify(expr.callee)} returns raw Html — its output is NOT escaped`,
          expr.span,
          'ensure the host sanitizes this value at write time',
          'warning',
        );
      }
      return host.returns;
    }

    const stdlib = STDLIB.get(expr.callee);
    if (stdlib !== undefined) {
      // Stdlib filters never accept branded opaques (Money/Image/Url stay terminal).
      // O2060 is the Money-terminality code and O2061 the Image-terminality
      // code EVERYWHERE else in the checker; reporting both here under O2060
      // made one code mean two things and duplicated O2061's meaning.
      for (const arg of argTypes) {
        if (isOpaqueNamed(arg.type, 'Money')) {
          this.report('O2060', 'Money can only be passed to host filters that declare it', arg.expr.span);
          return t.invalid();
        }
        if (isOpaqueNamed(arg.type, 'Image')) {
          this.report('O2061', 'Image can only be passed to host filters that declare it', arg.expr.span);
          return t.invalid();
        }
      }
      // Flatten nominal objects to records so list filters can see fields.
      const flattened = argTypes.map((a) => ({ expr: a.expr, type: this.flattenObjects(a.type) }));
      return stdlib.check({
        args: flattened,
        span: expr.span,
        template: this.currentTemplate,
        report: (d) => this.diagnostics.push(d),
      });
    }

    this.report(
      'O2070',
      `unknown filter ${JSON.stringify(expr.callee)}`,
      expr.span,
      this.suggestName(expr.callee, [...STDLIB_FILTER_NAMES, ...this.hostFilters.keys()]),
    );
    return t.invalid();
  }

  /** Replace List<Object>/Object with structural records for filter checks. */
  private flattenObjects(type: Type): Type {
    if (type.kind === 'object') {
      const fields = this.registry.fieldsOf(type.name);
      return fields !== undefined ? t.record(fields) : type;
    }
    if (type.kind === 'list') return t.list(this.flattenObjects(type.element));
    if (type.kind === 'optional') return t.optional(this.flattenObjects(type.inner));
    return type;
  }

  private unify(a: Type, b: Type, span: Span): Type {
    if (a.kind === 'invalid') return b;
    if (b.kind === 'invalid') return a;
    if (assignable(a, b)) return b;
    if (assignable(b, a)) return a;
    if (isNumericKind(a) && isNumericKind(b)) return t.float();
    // A Url may fall back to a plain String (sinks sanitize either way).
    if ((isOpaqueNamed(a, 'Url') && b.kind === 'string') || (isOpaqueNamed(b, 'Url') && a.kind === 'string')) {
      return t.string();
    }
    if (a.kind === 'none' && b.kind !== 'none') return t.optional(b);
    if (b.kind === 'none' && a.kind !== 'none') return t.optional(a);
    this.report('O2073', `branches have incompatible types: ${typeToString(a)} vs ${typeToString(b)}`, span);
    return t.invalid();
  }
}

// ---------------------------------------------------------------------------
// Narrowing + small helpers
// ---------------------------------------------------------------------------

function isNumericKind(type: Type): boolean {
  return type.kind === 'int' || type.kind === 'float';
}

function lookup(scope: Scope | undefined, name: string): Type | undefined {
  while (scope !== undefined) {
    const found = scope.vars.get(name);
    if (found !== undefined) return found;
    scope = scope.parent;
  }
  return undefined;
}

function scopeNames(scope: Scope | undefined): string[] {
  const names: string[] = [];
  while (scope !== undefined) {
    names.push(...scope.vars.keys());
    scope = scope.parent;
  }
  return names;
}

/** Narrowable path of an expression: dotted ident/member chain (no ?., no index). */
export function pathOf(expr: Expr): string | undefined {
  if (expr.kind === 'ident') return expr.name;
  if (expr.kind === 'member' && !expr.optional) {
    const base = pathOf(expr.object);
    return base !== undefined ? `${base}.${expr.property}` : undefined;
  }
  return undefined;
}

/** Paths proven non-none when `expr` evaluates true. */
export function narrowTrue(expr: Expr): Set<string> {
  if (expr.kind === 'binary') {
    if (expr.op === '!=') {
      const path = noneComparisonPath(expr);
      return path !== undefined ? new Set([path]) : new Set();
    }
    if (expr.op === '&&') {
      const out = narrowTrue(expr.left);
      for (const p of narrowTrue(expr.right)) out.add(p);
      return out;
    }
    if (expr.op === '||') {
      // Only paths narrowed by BOTH sides survive (W: narrowing escape via ||).
      const left = narrowTrue(expr.left);
      const right = narrowTrue(expr.right);
      const out = new Set<string>();
      for (const p of left) if (right.has(p)) out.add(p);
      return out;
    }
  }
  if (expr.kind === 'unary' && expr.op === '!') return narrowFalse(expr.operand);
  return new Set();
}

/** Paths proven non-none when `expr` evaluates false. */
export function narrowFalse(expr: Expr): Set<string> {
  if (expr.kind === 'binary') {
    if (expr.op === '==') {
      const path = noneComparisonPath(expr);
      return path !== undefined ? new Set([path]) : new Set();
    }
    if (expr.op === '||') {
      const out = narrowFalse(expr.left);
      for (const p of narrowFalse(expr.right)) out.add(p);
      return out;
    }
    if (expr.op === '&&') {
      const left = narrowFalse(expr.left);
      const right = narrowFalse(expr.right);
      const out = new Set<string>();
      for (const p of left) if (right.has(p)) out.add(p);
      return out;
    }
  }
  if (expr.kind === 'unary' && expr.op === '!') return narrowTrue(expr.operand);
  return new Set();
}

function noneComparisonPath(expr: Expr & { kind: 'binary' }): string | undefined {
  if (expr.right.kind === 'none') return pathOf(expr.left);
  if (expr.left.kind === 'none') return pathOf(expr.right);
  return undefined;
}

function pruneNarrowed(narrowed: ReadonlySet<string>, names: readonly (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const path of narrowed) {
    const root = path.split('.')[0] ?? path;
    if (!names.includes(root)) out.add(path);
  }
  return out;
}

function literalIntValue(expr: Expr): number | undefined {
  if (expr.kind === 'int') return expr.value;
  if (expr.kind === 'unary' && expr.op === '-' && expr.operand.kind === 'int') return -expr.operand.value;
  return undefined;
}

function settingType(control: SettingControl): Type {
  switch (control.control) {
    case 'text':
      return t.string();
    case 'toggle':
      return t.bool();
    case 'color':
      return t.color();
    case 'select':
      return t.union(...control.options);
    case 'range':
      return t.int();
  }
}

function jsonSafe(type: Type): boolean {
  switch (type.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'color':
    case 'union':
    case 'none':
    case 'invalid':
      return true;
    case 'optional':
      return jsonSafe(type.inner);
    case 'list':
      return jsonSafe(type.element);
    case 'record':
      return Object.values(type.fields).every(jsonSafe);
    case 'opaque':
      return type.name === 'Url';
    default:
      return false;
  }
}

function hasDefaultSlotNode(nodes: readonly Node[]): boolean {
  for (const node of nodes) {
    if (node.kind === 'slot' && node.name === 'default') return true;
    if (node.kind === 'element' && hasDefaultSlotNode(node.children)) return true;
    if (node.kind === 'if') {
      for (const b of node.branches) if (hasDefaultSlotNode(b.children)) return true;
      if (node.elseChildren !== undefined && hasDefaultSlotNode(node.elseChildren)) return true;
    }
    if (node.kind === 'for') {
      if (hasDefaultSlotNode(node.children)) return true;
      if (node.emptyChildren !== undefined && hasDefaultSlotNode(node.emptyChildren)) return true;
    }
  }
  return false;
}

function collectComponentCalls(nodes: readonly Node[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: readonly Node[]): void => {
    for (const node of list) {
      switch (node.kind) {
        case 'component':
          out.add(node.name);
          walk(node.children);
          break;
        case 'element':
          walk(node.children);
          break;
        case 'if':
          for (const b of node.branches) walk(b.children);
          if (node.elseChildren !== undefined) walk(node.elseChildren);
          break;
        case 'for':
          walk(node.children);
          if (node.emptyChildren !== undefined) walk(node.emptyChildren);
          break;
        default:
          break;
      }
    }
  };
  walk(nodes);
  return out;
}

/** Bounded edit distance (no regex, O(len^2) with tiny caps). */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (a.length > 32 || b.length > 32) return max + 1;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j += 1) prev.push(j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
    }
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

function defaultFallbackFor(inner: string): string {
  if (inner === 'String') return '""';
  if (inner === 'Int' || inner === 'Float') return '0';
  if (inner === 'Bool') return 'false';
  return '<fallback>';
}
