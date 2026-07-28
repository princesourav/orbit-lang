/**
 * The canonical Orbit formatter.
 *
 * There is exactly one canonical form and no options to configure it. That is
 * a deliberate gofmt-style choice: formatting arguments are a tax every team
 * pays forever, and a template language whose selling point is "the compiler
 * decides" has no business shipping a style debate.
 *
 * ## The canon
 *
 *   * Two-space indentation. Tabs never appear in output.
 *   * Lines are kept under `MAX_WIDTH` (100) where breaking is legal.
 *   * Attributes stay on the tag line while they fit; past that, every
 *     attribute moves to its own line and `>` closes on its own line. It is
 *     all-or-nothing — partially broken attribute lists read worse than either
 *     extreme and produce noisy diffs when one attribute is added.
 *   * Frontmatter blocks keep author order. Order is documentation: props are
 *     usually listed in the order a caller thinks about them, and sorting
 *     alphabetically would destroy that for no gain.
 *   * Expressions are printed with minimal parentheses — one space around
 *     binary operators, none inside brackets or around `.`.
 *   * `<pre>` and `verbatim` subtrees are reproduced exactly.
 *
 * ## Whitespace is semantic, so the formatter is rendering-preserving
 *
 * This is the whole difficulty. The parser collapses each run of whitespace to
 * a single space and **keeps boundary spaces**: `"  hi  "` becomes `" hi "`,
 * while a run that is entirely whitespace is dropped. So where the formatter
 * may insert a newline is not a style question — it changes output bytes.
 *
 * A break between two adjacent items is legal only when it cannot change the
 * collapsed result:
 *
 *   * the item before it is text already ending in a space, or
 *   * the item after it is text already starting with a space, or
 *   * neither side is text at all — the inserted whitespace then forms a
 *     whitespace-only run, which the parser drops.
 *
 * Everything else must hug. `<p>hello</p>` cannot become `<p>\n  hello\n</p>`,
 * because that renders as `" hello "`. `formatProgram` is verified to be both
 * idempotent and byte-identical under render; see `formatter.test.ts`.
 */
import type {
  Attr,
  AttrPart,
  Expr,
  Node,
  PropDecl,
  SettingDecl,
  SlotDecl,
  Template,
  TypeExpr,
} from './ast';
import type { Program } from './ast';

const INDENT = '  ';
const MAX_WIDTH = 100;

// ---------------------------------------------------------------------------
// Expression printing
// ---------------------------------------------------------------------------

/**
 * Binding power per expression form, loosest to tightest. Mirrors the parser's
 * descent chain (`parseTernary` -> `parseCoalesce` -> `parsePipe` -> `parseOr`
 * -> ... -> postfix); if that chain changes, this table must change with it or
 * the formatter will emit expressions that reparse differently.
 */
const PREC = {
  cond: 1,
  coalesce: 2,
  pipe: 3,
  or: 4,
  and: 5,
  equality: 6,
  comparison: 7,
  range: 8,
  additive: 9,
  multiplicative: 10,
  unary: 11,
  postfix: 12,
  atom: 13,
} as const;

function binaryPrec(op: string): number {
  switch (op) {
    case '||':
      return PREC.or;
    case '&&':
      return PREC.and;
    case '==':
    case '!=':
      return PREC.equality;
    case '<':
    case '<=':
    case '>':
    case '>=':
      return PREC.comparison;
    case '+':
    case '-':
      return PREC.additive;
    default:
      return PREC.multiplicative;
  }
}

function precOf(e: Expr): number {
  switch (e.kind) {
    case 'cond':
      return PREC.cond;
    case 'coalesce':
      return PREC.coalesce;
    case 'call':
      return e.viaPipe ? PREC.pipe : PREC.postfix;
    case 'binary':
      return binaryPrec(e.op);
    case 'range':
      return PREC.range;
    case 'unary':
      return PREC.unary;
    case 'member':
    case 'index':
      return PREC.postfix;
    default:
      return PREC.atom;
  }
}

/** Escape a string literal exactly as the lexer will read it back. */
function quote(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\r':
        out += '\\r';
        break;
      default:
        out += ch;
    }
  }
  return out + '"';
}

/**
 * Record keys are parsed from either an identifier or a string literal, and
 * the AST keeps only the resulting text — so the formatter has to decide which
 * form reads back correctly. JSON-LD makes this load-bearing rather than
 * cosmetic: `{"@type": "Article"}` is ordinary payload, and emitting `@type`
 * bare produces a file that no longer parses.
 */
function printRecordKey(key: string): string {
  if (key.length === 0) return quote(key);
  if (!isIdentStartChar(key[0]!)) return quote(key);
  for (let i = 1; i < key.length; i += 1) {
    if (!isIdentPartChar(key[i]!)) return quote(key);
  }
  return key;
}

function isIdentStartChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isIdentPartChar(c: string): boolean {
  return isIdentStartChar(c) || (c >= '0' && c <= '9');
}

/** Render a number the way the lexer accepts it: no exponent, no leading dot. */
function numberLiteral(value: number, isFloat: boolean): string {
  if (!Number.isFinite(value)) {
    // The parser cannot produce these, but a hand-built AST could; refusing is
    // better than emitting `Infinity`, which is not valid Orbit.
    throw new Error(`cannot format non-finite number literal: ${String(value)}`);
  }
  if (!isFloat) return String(value);
  const s = String(value);
  return s.includes('.') ? s : `${s}.0`;
}

function printExpr(e: Expr, minPrec = 0): string {
  const text = printExprInner(e);
  return precOf(e) < minPrec ? `(${text})` : text;
}

function printExprInner(e: Expr): string {
  switch (e.kind) {
    case 'ident':
      return e.name;
    case 'int':
      return numberLiteral(e.value, false);
    case 'float':
      return numberLiteral(e.value, true);
    case 'string':
      return quote(e.value);
    case 'bool':
      return e.value ? 'true' : 'false';
    case 'none':
      return 'none';
    case 'color':
      return e.value;
    case 'list':
      return `[${e.items.map((i) => printExpr(i)).join(', ')}]`;
    case 'record':
      return `{${e.fields.map((f) => `${printRecordKey(f.key)}: ${printExpr(f.value)}`).join(', ')}}`;
    case 'range':
      // Non-associative: both sides bind at additive level.
      return `${printExpr(e.start, PREC.additive)}..${printExpr(e.end, PREC.additive)}`;
    case 'member':
      return `${printExpr(e.object, PREC.postfix)}${e.optional ? '?.' : '.'}${e.property}`;
    case 'index':
      return `${printExpr(e.object, PREC.postfix)}[${printExpr(e.index)}]`;
    case 'call':
      return printCall(e);
    case 'unary':
      return `${e.op}${printExpr(e.operand, PREC.unary)}`;
    case 'binary': {
      const p = binaryPrec(e.op);
      // Left-associative: the right operand needs one more level to keep its
      // own grouping when reparsed.
      return `${printExpr(e.left, p)} ${e.op} ${printExpr(e.right, p + 1)}`;
    }
    case 'coalesce': {
      /*
       * A pipe on the right of `??` is ALWAYS parenthesised, even though
       * precedence does not require it.
       *
       * `|>` binds tighter than `??`, so `a ?? "" |> richtext` pipes only the
       * FALLBACK and leaves `a` untouched — and without parentheses the two
       * groupings print identically, so a reader cannot tell which one is in
       * effect. Printing the parentheses makes the grouping visible at the
       * cost of two characters. It is not a style preference: this exact
       * expression, written against a sanitizer, silently leaves merchant
       * input unsanitized in the branch that matters.
       */
      const right =
        e.right.kind === 'call' && e.right.viaPipe
          ? `(${printExprInner(e.right)})`
          : printExpr(e.right, PREC.coalesce + 1);
      return `${printExpr(e.left, PREC.coalesce)} ?? ${right}`;
    }
    case 'cond':
      // Right-associative, so the branches may sit at the loosest level.
      return `${printExpr(e.test, PREC.cond + 1)} ? ${printExpr(e.then, PREC.cond)} : ${printExpr(e.else, PREC.cond)}`;
  }
}

function printCall(e: Extract<Expr, { kind: 'call' }>): string {
  if (!e.viaPipe) {
    return `${e.callee}(${e.args.map((a) => printExpr(a)).join(', ')})`;
  }
  // A pipe is stored as a call whose FIRST argument is the piped subject, so
  // printing it back as `subject |> filter(rest)` is what round-trips.
  const [subject, ...rest] = e.args;
  const head = subject === undefined ? '' : printExpr(subject, PREC.pipe);
  const tail = rest.length > 0 ? `(${rest.map((a) => printExpr(a)).join(', ')})` : '';
  return `${head} |> ${e.callee}${tail}`;
}

// ---------------------------------------------------------------------------
// Whitespace legality
// ---------------------------------------------------------------------------

function isTextNode(n: Node | undefined): n is Extract<Node, { kind: 'text' }> {
  return n !== undefined && n.kind === 'text';
}

/**
 * May a newline be inserted between `before` and `after` without changing what
 * the template renders? `undefined` stands for a tag boundary (the open tag on
 * the left, the close tag on the right), which is never a text node.
 *
 * See the module comment: the parser collapses whitespace runs and drops
 * whitespace-only ones, which is exactly what makes the third case safe.
 */
function breakAllowed(before: Node | undefined, after: Node | undefined): boolean {
  const beforeIsText = isTextNode(before);
  const afterIsText = isTextNode(after);
  if (!beforeIsText && !afterIsText) return true;
  if (beforeIsText && before.value.endsWith(' ')) return true;
  if (afterIsText && after.value.startsWith(' ')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function printAttrPart(p: AttrPart): string {
  return p.kind === 'text' ? p.value : `{${printExpr(p.expr)}}`;
}

function printAttr(a: Attr): string {
  switch (a.value.form) {
    case 'bare':
      return a.name;
    case 'expr':
      return `${a.name}={${printExpr(a.value.expr)}}`;
    case 'conditional':
      return `${a.name}?={${printExpr(a.value.expr)}}`;
    case 'parts':
      return `${a.name}="${a.value.parts.map(printAttrPart).join('')}"`;
  }
}

/**
 * Render a tag's opening. Attributes stay inline while the line fits; past
 * that they all move down, one per line.
 */
function printOpenTag(name: string, attrs: readonly Attr[], indent: string, selfClose: boolean): string {
  const close = selfClose ? '/>' : '>';
  if (attrs.length === 0) return `${indent}<${name}${close}`;

  const printed = attrs.map(printAttr);
  const inline = `${indent}<${name} ${printed.join(' ')}${close}`;
  if (inline.length <= MAX_WIDTH && !inline.includes('\n')) return inline;

  const inner = indent + INDENT;
  const lines = printed.map((p) => `${inner}${p}`);
  return `${indent}<${name}\n${lines.join('\n')}\n${indent}${close}`;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

interface Ctx {
  /** Inside `<pre>` or a `verbatim` subtree: reproduce source exactly. */
  preserve: boolean;
}

/** Print one node with no surrounding indentation (used for inline runs). */
function printNodeInline(n: Node, ctx: Ctx): string {
  switch (n.kind) {
    case 'text':
      return n.value;
    case 'interpolation':
      return `{${printExpr(n.expr)}}`;
    case 'slot':
      return n.name === 'default' ? '<slot/>' : `<slot name="${n.name}"/>`;
    case 'let':
      return `<let ${n.name}={${printExpr(n.expr)}}/>`;
    case 'json-ld':
      return `<json-ld>{${printExpr(n.expr)}}</json-ld>`;
    case 'element': {
      if (n.content === 'void') return printOpenTag(n.tag, n.attrs, '', true);
      const open = printOpenTag(n.tag, n.attrs, '', false);
      const inner = n.children.map((c) => printNodeInline(c, ctx)).join('');
      return `${open}${inner}</${n.tag}>`;
    }
    case 'component': {
      if (n.children.length === 0) return printOpenTag(n.name, n.props, '', true);
      const open = printOpenTag(n.name, n.props, '', false);
      const inner = n.children.map((c) => printNodeInline(c, ctx)).join('');
      return `${open}${inner}</${n.name}>`;
    }
    case 'if': {
      // `<else-if>` and `<else>` are SIBLINGS of `</if>`, not children of it —
      // the parser merges the sibling run into one IfNode. Each branch
      // therefore closes its own tag.
      let out = '';
      n.branches.forEach((b, i) => {
        const tag = i === 0 ? 'if' : 'else-if';
        out += `<${tag} {${printExpr(b.cond)}}>`;
        out += b.children.map((c) => printNodeInline(c, ctx)).join('');
        out += `</${tag}>`;
      });
      if (n.elseChildren !== undefined) {
        out += '<else>' + n.elseChildren.map((c) => printNodeInline(c, ctx)).join('') + '</else>';
      }
      return out;
    }
    case 'for': {
      const binding = n.index === undefined ? n.item : `${n.item}, ${n.index}`;
      const limit = n.limit === undefined ? '' : ` limit={${printExpr(n.limit)}}`;
      let out = `<for ${binding} of={${printExpr(n.subject)}}${limit}>`;
      out += n.children.map((c) => printNodeInline(c, ctx)).join('');
      if (n.emptyChildren !== undefined) {
        out += '<empty>' + n.emptyChildren.map((c) => printNodeInline(c, ctx)).join('') + '</empty>';
      }
      return out + '</for>';
    }
  }
}

/**
 * Print a run of sibling nodes, breaking lines only where `breakAllowed` says
 * it is safe. Returns lines WITHOUT a trailing newline.
 */
function printChildren(children: readonly Node[], indent: string, ctx: Ctx): string[] {
  if (children.length === 0) return [];

  const lines: string[] = [];
  let current = '';
  let currentStarted = false;

  const flush = (): void => {
    if (currentStarted) {
      lines.push(indent + current);
      current = '';
      currentStarted = false;
    }
  };

  for (let i = 0; i < children.length; i += 1) {
    const node = children[i]!;
    const prev = i === 0 ? undefined : children[i - 1]!;
    const canBreakHere = i === 0 ? breakAllowed(undefined, node) : breakAllowed(prev, node);

    if (canBreakHere) flush();

    const block = printNodeBlock(node, indent, ctx);
    if (block !== undefined && !currentStarted) {
      // The node renders as its own indented block; emit it directly.
      lines.push(...block);
      continue;
    }

    // Inline: append to the line being built. Text that sits at a legal break
    // is emitted trimmed, because the newline plus indentation already
    // supplies the space the collapsed value carries.
    let piece = printNodeInline(node, ctx);
    if (node.kind === 'text') {
      const trimLeft = canBreakHere && !currentStarted;
      const nextNode = children[i + 1];
      const trimRight = breakAllowed(node, nextNode) && i === children.length - 1;
      if (trimLeft && piece.startsWith(' ')) piece = piece.slice(1);
      if (trimRight && piece.endsWith(' ')) piece = piece.slice(0, -1);
    }
    current += piece;
    currentStarted = true;
  }

  flush();
  return lines;
}

/**
 * Print a node as one or more indented lines, or `undefined` when the node has
 * no multi-line form and must be appended inline by the caller.
 */
function printNodeBlock(n: Node, indent: string, ctx: Ctx): string[] | undefined {
  if (ctx.preserve) return undefined;

  switch (n.kind) {
    case 'text':
    case 'interpolation':
      return undefined;

    case 'slot':
    case 'let':
    case 'json-ld':
      return [indent + printNodeInline(n, ctx)];

    case 'element': {
      if (n.content === 'void') return [printOpenTag(n.tag, n.attrs, indent, true)];
      const preserve = n.tag === 'pre' || hasVerbatim(n.attrs);
      const childCtx: Ctx = preserve ? { preserve: true } : ctx;

      // RCDATA and preserved subtrees must not gain whitespace at all.
      if (preserve || n.content === 'rcdata') {
        const inner = n.children.map((c) => printNodeInline(c, childCtx)).join('');
        return [`${printOpenTag(n.tag, n.attrs, indent, false)}${inner}</${n.tag}>`];
      }
      return wrapBlock(printOpenTag(n.tag, n.attrs, indent, false), `${indent}</${n.tag}>`, n.children, indent, childCtx);
    }

    case 'component': {
      if (n.children.length === 0) return [printOpenTag(n.name, n.props, indent, true)];
      return wrapBlock(printOpenTag(n.name, n.props, indent, false), `${indent}</${n.name}>`, n.children, indent, ctx);
    }

    case 'if': {
      // See printNodeInline: each branch is its own sibling element.
      const out: string[] = [];
      const branchBlock = (tag: string, open: string, children: readonly Node[]): void => {
        const inline = `${indent}${open}${children.map((c) => printNodeInline(c, ctx)).join('')}</${tag}>`;
        const canBreak =
          children.length === 0 ||
          (breakAllowed(undefined, children[0]) && breakAllowed(children[children.length - 1], undefined));
        if (!canBreak || inline.length <= MAX_WIDTH) {
          out.push(inline);
          return;
        }
        out.push(`${indent}${open}`);
        out.push(...printChildren(children, indent + INDENT, ctx));
        out.push(`${indent}</${tag}>`);
      };

      n.branches.forEach((b, i) => {
        const tag = i === 0 ? 'if' : 'else-if';
        branchBlock(tag, `<${tag} {${printExpr(b.cond)}}>`, b.children);
      });
      if (n.elseChildren !== undefined) {
        branchBlock('else', '<else>', n.elseChildren);
      }
      return out;
    }

    case 'for': {
      const binding = n.index === undefined ? n.item : `${n.item}, ${n.index}`;
      const limit = n.limit === undefined ? '' : ` limit={${printExpr(n.limit)}}`;
      const out: string[] = [`${indent}<for ${binding} of={${printExpr(n.subject)}}${limit}>`];
      out.push(...printChildren(n.children, indent + INDENT, ctx));
      if (n.emptyChildren !== undefined) {
        out.push(`${indent}<empty>`);
        out.push(...printChildren(n.emptyChildren, indent + INDENT, ctx));
        out.push(`${indent}</empty>`);
      }
      out.push(`${indent}</for>`);
      return out;
    }
  }
}

function hasVerbatim(attrs: readonly Attr[]): boolean {
  return attrs.some((a) => a.name === 'verbatim');
}

/**
 * Lay out an element or component: keep it on one line when that is legal and
 * fits, otherwise indent the children between the tags.
 */
function wrapBlock(
  open: string,
  close: string,
  children: readonly Node[],
  indent: string,
  ctx: Ctx,
): string[] {
  const first = children[0];
  const last = children[children.length - 1];
  const canOpenBreak = children.length === 0 || breakAllowed(undefined, first);
  const canCloseBreak = children.length === 0 || breakAllowed(last, undefined);

  const inlineChildren = children.map((c) => printNodeInline(c, ctx)).join('');
  const oneLine = `${open}${inlineChildren}${close.trimStart()}`;

  // Hugging is mandatory when a break would alter rendering, regardless of width.
  if (!canOpenBreak || !canCloseBreak) return [oneLine];

  /*
   * An element whose children are all structural — no text, no interpolation —
   * always breaks, even when it would fit. `<div><p>a</p><p>b</p></div>` on one
   * line is legal and short, but nesting is the thing a reader scans an HTML
   * template for, and collapsing it hides the shape of the page.
   *
   * Mixed content does NOT trip this: `<p>Hello <b>world</b>!</p>` contains an
   * element child, but its surrounding text carries no boundary spaces, so
   * `breakAllowed` has already refused to break and the checks above returned.
   * The two rules compose — legality first, then layout.
   */
  const structuralOnly =
    children.length > 0 &&
    children.every((c) => c.kind !== 'text' && c.kind !== 'interpolation');

  if (!structuralOnly && !open.includes('\n') && oneLine.length <= MAX_WIDTH) return [oneLine];

  return [open, ...printChildren(children, indent + INDENT, ctx), close];
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function printType(t: TypeExpr): string {
  switch (t.kind) {
    case 'name':
      return t.name;
    case 'list':
      return `List<${printType(t.inner)}>`;
    case 'optional':
      return `${printType(t.inner)}?`;
  }
}

function printProp(p: PropDecl): string {
  const base = `${INDENT}${p.name}: ${printType(p.type)}`;
  return p.defaultValue === undefined ? base : `${base} = ${printExpr(p.defaultValue)}`;
}

function printSetting(s: SettingDecl): string {
  let control: string;
  switch (s.setting.control) {
    case 'text':
      control = 'Text';
      break;
    case 'toggle':
      control = 'Toggle';
      break;
    case 'color':
      control = 'Color';
      break;
    case 'select':
      control = `Select(${s.setting.options.map(quote).join(', ')})`;
      break;
    case 'range':
      control = `Range(${s.setting.min}, ${s.setting.max}, step: ${s.setting.step})`;
      break;
  }
  const label = s.label === undefined ? '' : ` label ${quote(s.label)}`;
  return `${INDENT}${s.name}: ${control} = ${printExpr(s.defaultValue)}${label}`;
}

function printSlot(s: SlotDecl): string {
  return `${INDENT}${s.name}${s.required ? '' : '?'}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format one template into canonical form. Operates on the checked AST, so a
 * template that does not parse cannot be formatted — call `parseTemplate`
 * first and report its diagnostics instead.
 */
export function formatTemplate(template: Template): string {
  const out: string[] = ['---'];
  out.push(`${template.templateKind} ${template.name}`);

  if (template.props.length > 0) {
    out.push('props {');
    out.push(...template.props.map(printProp));
    out.push('}');
  }
  if (template.settings.length > 0) {
    out.push('settings {');
    out.push(...template.settings.map(printSetting));
    out.push('}');
  }
  if (template.slots.length > 0) {
    out.push('slots {');
    out.push(...template.slots.map(printSlot));
    out.push('}');
  }
  out.push('---');
  out.push(...printChildren(template.body, '', { preserve: false }));

  // Exactly one trailing newline: every POSIX tool expects it and its absence
  // produces a spurious diff on the last line forever after.
  let text = out.join('\n');
  while (text.endsWith('\n')) text = text.slice(0, -1);
  return text + '\n';
}

/** Format every template in a program, keyed by template name. */
export function formatProgram(program: Program): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, template] of program.templates) {
    out.set(name, formatTemplate(template));
  }
  return out;
}
