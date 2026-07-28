/**
 * Typed AST node kinds. Node-count and depth caps are enforced at
 * CONSTRUCTION (the parser calls `NodeBudget` for every node it makes), so an
 * over-cap template never finishes parsing — there is no post-hoc walk that a
 * bug could skip.
 */
import { OrbitParseError, type Span } from './diagnostics';
import { LIMITS } from './limits';

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expr =
  | { kind: 'ident'; name: string; span: Span }
  | { kind: 'int'; value: number; span: Span }
  | { kind: 'float'; value: number; span: Span }
  | { kind: 'string'; value: string; span: Span }
  | { kind: 'bool'; value: boolean; span: Span }
  | { kind: 'none'; span: Span }
  | { kind: 'color'; value: string; span: Span }
  | { kind: 'list'; items: Expr[]; span: Span }
  | { kind: 'record'; fields: { key: string; value: Expr }[]; span: Span }
  | { kind: 'range'; start: Expr; end: Expr; span: Span }
  | { kind: 'member'; object: Expr; property: string; optional: boolean; span: Span }
  | { kind: 'index'; object: Expr; index: Expr; span: Span }
  | { kind: 'call'; callee: string; args: Expr[]; viaPipe: boolean; span: Span }
  | { kind: 'unary'; op: '!' | '-'; operand: Expr; span: Span }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr; span: Span }
  | { kind: 'coalesce'; left: Expr; right: Expr; span: Span }
  | { kind: 'cond'; test: Expr; then: Expr; else: Expr; span: Span };

export type BinaryOp =
  | '*'
  | '/'
  | '%'
  | '+'
  | '-'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||';

export const EXPR_KINDS: readonly string[] = [
  'ident',
  'int',
  'float',
  'string',
  'bool',
  'none',
  'color',
  'list',
  'record',
  'range',
  'member',
  'index',
  'call',
  'unary',
  'binary',
  'coalesce',
  'cond',
];

// ---------------------------------------------------------------------------
// Template body nodes
// ---------------------------------------------------------------------------

/** One part of an attribute value: static text or an interpolation island. */
export type AttrPart = { kind: 'text'; value: string } | { kind: 'expr'; expr: Expr };

export interface Attr {
  name: string;
  span: Span;
  /**
   * - 'parts': quoted value with optional islands (`class="card {x}"`)
   * - 'expr': whole-attribute expression (`href={product.url}`)
   * - 'bare': flag attribute (`disabled` / bare component prop = true)
   * - 'conditional': `name?={boolExpr}` — emitted when the Bool is true
   */
  value:
    | { form: 'parts'; parts: AttrPart[] }
    | { form: 'expr'; expr: Expr }
    | { form: 'bare' }
    | { form: 'conditional'; expr: Expr };
  /** Statically known: this attribute is in the closed URL-attribute table. */
  isUrl: boolean;
}

export type Node =
  | { kind: 'text'; value: string; span: Span }
  | { kind: 'interpolation'; expr: Expr; span: Span }
  /**
   * A source comment, retained so the formatter can put it back.
   *
   * Comments used to be skipped by the parser, which meant they were absent
   * from the AST and `orbit fmt` deleted every one of them — silently, and
   * without failing any test, because a comment changes no rendered byte. That
   * is data loss in a tool authors are told to run on save.
   *
   * A comment node NEVER renders. `html: true` distinguishes `<!-- … -->` from
   * `{# … #}` so the formatter restores the form the author wrote; both are
   * equally invisible in output.
   */
  | { kind: 'comment'; value: string; html: boolean; span: Span }
  | ElementNode
  | IfNode
  | ForNode
  | LetNode
  | ComponentCallNode
  | SlotNode
  | JsonLdNode;

export interface ElementNode {
  kind: 'element';
  tag: string;
  attrs: Attr[];
  children: Node[];
  /** Content model the parser resolved for this element. */
  content: 'normal' | 'rcdata' | 'rawtext' | 'void';
  span: Span;
}

export interface IfBranch {
  cond: Expr;
  children: Node[];
  span: Span;
}

export interface IfNode {
  kind: 'if';
  branches: IfBranch[]; // <if> then any <else-if> siblings, in order
  elseChildren?: Node[];
  span: Span;
}

export interface ForNode {
  kind: 'for';
  item: string;
  index?: string;
  subject: Expr;
  /** Compile-time literal; checker enforces <= LIMITS.maxLoopLimit. */
  limit?: Expr;
  children: Node[];
  emptyChildren?: Node[];
  span: Span;
}

export interface LetNode {
  kind: 'let';
  name: string;
  expr: Expr;
  span: Span;
}

export interface ComponentCallNode {
  kind: 'component';
  name: string;
  props: Attr[];
  children: Node[];
  span: Span;
}

export interface SlotNode {
  kind: 'slot';
  name: string; // 'default' for <slot/>
  span: Span;
}

export interface JsonLdNode {
  kind: 'json-ld';
  expr: Expr;
  span: Span;
}

export const NODE_KINDS: readonly string[] = [
  'text',
  'interpolation',
  'comment',
  'element',
  'if',
  'for',
  'let',
  'component',
  'slot',
  'json-ld',
];

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Type expressions as written in frontmatter; resolved by the checker. */
export type TypeExpr =
  | { kind: 'name'; name: string; span: Span }
  | { kind: 'list'; inner: TypeExpr; span: Span }
  | { kind: 'optional'; inner: TypeExpr; span: Span };

export interface PropDecl {
  name: string;
  type: TypeExpr;
  defaultValue?: Expr;
  span: Span;
}

export type SettingControl =
  | { control: 'text' }
  | { control: 'select'; options: string[] }
  | { control: 'range'; min: number; max: number; step: number }
  | { control: 'toggle' }
  | { control: 'color' };

export interface SettingDecl {
  name: string;
  setting: SettingControl;
  defaultValue: Expr;
  label?: string;
  span: Span;
}

export interface SlotDecl {
  name: string;
  required: boolean;
  span: Span;
}

export interface Template {
  kind: 'template';
  /** Component name (PascalCase) or page name (lowercase). */
  name: string;
  templateKind: 'component' | 'page';
  props: PropDecl[];
  settings: SettingDecl[];
  slots: SlotDecl[];
  body: Node[];
  nodeCount: number;
  span: Span;
}

export interface Program {
  /** Keyed by template name (component name / page name). */
  templates: Map<string, Template>;
}

// ---------------------------------------------------------------------------
// Construction caps
// ---------------------------------------------------------------------------

/**
 * Every parser-constructed node passes through here. Depth is the element/
 * control-flow nesting depth at construction time.
 */
export class NodeBudget {
  count = 0;

  constructor(readonly template: string) {}

  charge(span: Span, depth: number): void {
    this.count += 1;
    if (this.count > LIMITS.maxAstNodesPerTemplate) {
      throw new OrbitParseError({
        code: 'O1100',
        severity: 'error',
        message: `template exceeds ${LIMITS.maxAstNodesPerTemplate} AST nodes`,
        template: this.template,
        span,
      });
    }
    if (depth > LIMITS.maxElementDepth) {
      throw new OrbitParseError({
        code: 'O1101',
        severity: 'error',
        message: `element nesting exceeds depth ${LIMITS.maxElementDepth}`,
        template: this.template,
        span,
      });
    }
  }
}

/**
 * Where one child of a component call renders.
 *
 * - `named`        — `slot="x"`, directly or agreed on by a whole wrapper
 * - `default`      — renderable content carrying no slot name
 * - `mixed`        — a control-flow wrapper whose branches disagree (error)
 * - `unattributed` — the node contributes no slot signal at all (text,
 *                    `<let>`, an empty wrapper); the caller decides
 *
 * This tagged type replaces the v0.1 sentinel strings, which were NUL-prefixed
 * values (`"\0a"`, `"\0default"`) smuggled through the same `Set<string>` as
 * real slot names and tested three call sites away with `startsWith("\0")`.
 * Nothing but a comment stopped a slot name from colliding with them.
 */
export type SlotTarget =
  | { kind: 'named'; name: string }
  | { kind: 'default' }
  | { kind: 'mixed' }
  | { kind: 'unattributed' };

const SLOT_DEFAULT: SlotTarget = { kind: 'default' };
const SLOT_MIXED: SlotTarget = { kind: 'mixed' };
const SLOT_UNATTRIBUTED: SlotTarget = { kind: 'unattributed' };

/**
 * Fold the slot signals of a control-flow wrapper's children into one target.
 * Disagreement — two different names, or a name alongside unnamed content —
 * is `mixed`; a wrapper that names nothing stays `unattributed` so the caller
 * can apply its own default-slot rule.
 */
function foldSlotTargets(children: readonly Node[]): SlotTarget {
  const names = new Set<string>();
  let sawMixed = false;
  let sawDefault = false;
  for (const child of children) {
    const target = slotNameOf(child);
    if (target.kind === 'mixed') sawMixed = true;
    else if (target.kind === 'named') names.add(target.name);
    else if (target.kind === 'default') sawDefault = true;
  }
  if (sawMixed) return SLOT_MIXED;
  if (names.size === 0) return SLOT_UNATTRIBUTED;
  if (names.size > 1 || sawDefault) return SLOT_MIXED;
  const only = [...names][0];
  return only === undefined ? SLOT_UNATTRIBUTED : { kind: 'named', name: only };
}

/**
 * Slot attribution: children of a component call are grouped into named
 * slots. `slot="x"` on a direct element child assigns it; control-flow
 * wrappers (<if>/<for>) are TRANSPARENT — if every element they can render
 * carries the same slot name, the whole wrapper attributes to that slot
 * (product-review correction: conditional badges must work).
 */
export function slotNameOf(node: Node): SlotTarget {
  if (node.kind === 'element') {
    const attr = node.attrs.find((a) => a.name === 'slot');
    if (attr !== undefined && attr.value.form === 'parts' && attr.value.parts.length === 1) {
      const only = attr.value.parts[0];
      if (only !== undefined && only.kind === 'text') return { kind: 'named', name: only.value };
    }
    return SLOT_DEFAULT;
  }
  if (node.kind === 'component') return SLOT_DEFAULT;
  if (node.kind === 'if') {
    const children: Node[] = [];
    for (const branch of node.branches) children.push(...branch.children);
    if (node.elseChildren !== undefined) children.push(...node.elseChildren);
    return foldSlotTargets(children);
  }
  if (node.kind === 'for') return foldSlotTargets(node.children);
  return SLOT_UNATTRIBUTED;
}

export interface GroupedSlots {
  /** slot name -> nodes assigned to it ('default' for unnamed content). */
  slots: Map<string, Node[]>;
  /** Nodes whose slot attribution was ambiguous (checker errors). */
  mixed: Node[];
}

export function groupSlotChildren(children: Node[]): GroupedSlots {
  const slots = new Map<string, Node[]>();
  const mixed: Node[] = [];
  const push = (name: string, node: Node): void => {
    const list = slots.get(name);
    if (list === undefined) slots.set(name, [node]);
    else list.push(node);
  };
  for (const child of children) {
    const target = slotNameOf(child);
    if (target.kind === 'mixed') {
      mixed.push(child);
      continue;
    }
    if (target.kind === 'named') {
      push(target.name, child);
      continue;
    }
    // Whitespace-only text between slot fills should not force a default slot.
    if (child.kind === 'text' && child.value.trim() === '') continue;
    push('default', child);
  }
  return { slots, mixed };
}
