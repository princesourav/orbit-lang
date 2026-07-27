/**
 * HTML-strict recursive-descent template parser + Pratt expression parser.
 *
 * Structural guarantees enforced HERE, not later (fail-at-parse posture):
 * - well-formed tree: every non-void element explicitly closed, matching tags
 * - closed element/attribute allowlists; URL attributes statically marked
 * - no interpolation in RAWTEXT (no RAWTEXT elements exist in the allowlist
 *   at all) and none inside `style` attributes (W-08, W-09)
 * - no dynamic attribute names, no spread (W-12) — the grammar has no syntax
 *   for either
 * - `<else-if>` / `<else>` are SIBLING tags of `<if>` (product correction)
 * - `<empty>` is only valid as the last child of `<for>`
 * - node-count / depth caps charged at construction via `NodeBudget`
 */
import {
  type Attr,
  type AttrPart,
  type Expr,
  type ForNode,
  type IfNode,
  type Node,
  NodeBudget,
  type PropDecl,
  type Program,
  type SettingControl,
  type SettingDecl,
  type SlotDecl,
  type Template,
  type TypeExpr,
} from './ast';
import {
  attrAllowed,
  attrRejection,
  BANNED_ELEMENTS,
  ELEMENT_ALLOWLIST,
  RCDATA_ELEMENTS,
  URL_ATTRS,
  VOID_ELEMENTS,
} from './allowlists';
import { type Diagnostic, OrbitParseError, type Pos, type Span } from './diagnostics';
import { isDigit, isIdentPart, isIdentStart, lexExpression, Scanner } from './lexer';
import { LIMITS } from './limits';
import { type Token } from './tokens';

// ---------------------------------------------------------------------------
// Expression parser (Pratt / recursive descent over lexed tokens)
// ---------------------------------------------------------------------------

class ExprParser {
  private i = 0;
  private depth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly template: string,
    private readonly at: Span,
  ) {}

  parseFull(): Expr {
    const expr = this.parseTernary();
    const t = this.peek();
    if (t !== undefined) {
      this.fail('O1010', `unexpected ${JSON.stringify(t.text)} after expression`, undefined, t.span);
    }
    return expr;
  }

  private peek(ahead = 0): Token | undefined {
    return this.tokens[this.i + ahead];
  }

  private next(): Token {
    const t = this.tokens[this.i];
    if (t === undefined) {
      this.fail('O1011', 'unexpected end of expression');
    }
    this.i += 1;
    return t;
  }

  private isPunct(text: string, ahead = 0): boolean {
    const t = this.peek(ahead);
    return t !== undefined && t.kind === 'punct' && t.text === text;
  }

  private expectPunct(text: string): Token {
    const t = this.peek();
    if (t === undefined || t.kind !== 'punct' || t.text !== text) {
      this.fail('O1012', `expected ${JSON.stringify(text)}${t !== undefined ? ` but found ${JSON.stringify(t.text)}` : ''}`, undefined, t?.span);
    }
    return this.next();
  }

  private fail(code: string, message: string, suggestion?: string, span?: Span): never {
    throw new OrbitParseError({
      code,
      severity: 'error',
      message,
      suggestion,
      template: this.template,
      span: span ?? this.tokens[this.i - 1]?.span ?? this.at,
    });
  }

  private guard<T>(fn: () => T): T {
    this.depth += 1;
    if (this.depth > LIMITS.maxExprDepth) {
      this.fail('O1009', `expression nesting exceeds depth ${LIMITS.maxExprDepth}`, 'split the expression with <let>');
    }
    const out = fn();
    this.depth -= 1;
    return out;
  }

  private spanOf(from: Expr, to: Expr): Span {
    return { start: from.span.start, end: to.span.end };
  }

  private parseTernary(): Expr {
    return this.guard(() => {
      const test = this.parseCoalesce();
      if (!this.isPunct('?') || this.isPunct('?.')) return test;
      this.next();
      const then = this.parseTernary();
      this.expectPunct(':');
      const elseE = this.parseTernary();
      return { kind: 'cond', test, then, else: elseE, span: this.spanOf(test, elseE) };
    });
  }

  private parseCoalesce(): Expr {
    let left = this.parseOr();
    while (this.isPunct('??')) {
      this.next();
      const right = this.parseOr();
      left = { kind: 'coalesce', left, right, span: this.spanOf(left, right) };
    }
    return left;
  }

  private parseBinaryLevel(ops: readonly string[], sub: () => Expr): Expr {
    let left = sub();
    for (;;) {
      const t = this.peek();
      if (t === undefined || t.kind !== 'punct' || !ops.includes(t.text)) return left;
      this.next();
      const right = sub();
      left = {
        kind: 'binary',
        op: t.text as never,
        left,
        right,
        span: this.spanOf(left, right),
      };
    }
  }

  private parseOr(): Expr {
    return this.parseBinaryLevel(['||'], () => this.parseAnd());
  }

  private parseAnd(): Expr {
    return this.parseBinaryLevel(['&&'], () => this.parseEquality());
  }

  private parseEquality(): Expr {
    return this.parseBinaryLevel(['==', '!='], () => this.parseComparison());
  }

  private parseComparison(): Expr {
    return this.parseBinaryLevel(['<', '<=', '>', '>='], () => this.parseRange());
  }

  private parseRange(): Expr {
    const left = this.parseAdditive();
    if (!this.isPunct('..')) return left;
    this.next();
    const right = this.parseAdditive();
    return { kind: 'range', start: left, end: right, span: this.spanOf(left, right) };
  }

  private parseAdditive(): Expr {
    return this.parseBinaryLevel(['+', '-'], () => this.parseMultiplicative());
  }

  private parseMultiplicative(): Expr {
    return this.parseBinaryLevel(['*', '/', '%'], () => this.parsePipe());
  }

  private parsePipe(): Expr {
    {
      let left = this.parseUnary();
      while (this.isPunct('|>')) {
        this.next();
        const t = this.peek();
        if (t === undefined || t.kind !== 'ident') {
          this.fail('O1013', 'the right side of |> must be a filter name', 'write x |> upper or x |> truncate(40)', t?.span);
        }
        this.next();
        const args: Expr[] = [left];
        let end = t.span.end;
        if (this.isPunct('(')) {
          this.next();
          if (!this.isPunct(')')) {
            for (;;) {
              args.push(this.parseTernary());
              if (this.isPunct(',')) {
                this.next();
                continue;
              }
              break;
            }
          }
          end = this.expectPunct(')').span.end;
        }
        left = {
          kind: 'call',
          callee: t.text,
          args,
          viaPipe: true,
          span: { start: left.span.start, end },
        };
      }
      return left;
    }
  }

  private parseUnary(): Expr {
    return this.guard(() => {
      const t = this.peek();
      if (t !== undefined && t.kind === 'punct' && (t.text === '!' || t.text === '-')) {
        this.next();
        const operand = this.parseUnary();
        return {
          kind: 'unary',
          op: t.text as '!' | '-',
          operand,
          span: { start: t.span.start, end: operand.span.end },
        };
      }
      return this.parsePostfix();
    });
  }

  private parsePostfix(): Expr {
    {
      let expr = this.parsePrimary();
      for (;;) {
        if (this.isPunct('.') || this.isPunct('?.')) {
          const optional = this.isPunct('?.');
          this.next();
          const prop = this.peek();
          if (prop === undefined || prop.kind !== 'ident') {
            this.fail('O1014', 'expected a property name after ' + (optional ? '?.' : '.'), undefined, prop?.span);
          }
          this.next();
          expr = {
            kind: 'member',
            object: expr,
            property: prop.text,
            optional,
            span: { start: expr.span.start, end: prop.span.end },
          };
          continue;
        }
        if (this.isPunct('[')) {
          this.next();
          const index = this.parseTernary();
          if (index.kind === 'string') {
            this.fail(
              'O1015',
              'dynamic member access is not supported',
              'use a static property: obj.name',
              index.span,
            );
          }
          const close = this.expectPunct(']');
          expr = {
            kind: 'index',
            object: expr,
            index,
            span: { start: expr.span.start, end: close.span.end },
          };
          continue;
        }
        if (this.isPunct('(')) {
          if (expr.kind !== 'ident') {
            this.fail(
              'O1016',
              'method calls are not supported',
              'use pipes instead: value |> filter(args)',
            );
          }
          this.next();
          const args: Expr[] = [];
          if (!this.isPunct(')')) {
            for (;;) {
              args.push(this.parseTernary());
              if (this.isPunct(',')) {
                this.next();
                continue;
              }
              break;
            }
          }
          const close = this.expectPunct(')');
          expr = {
            kind: 'call',
            callee: expr.name,
            args,
            viaPipe: false,
            span: { start: expr.span.start, end: close.span.end },
          };
          continue;
        }
        return expr;
      }
    }
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t === undefined) this.fail('O1011', 'unexpected end of expression');
    if (t.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number(t.text), span: t.span };
    }
    if (t.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number(t.text), span: t.span };
    }
    if (t.kind === 'string') {
      this.next();
      return { kind: 'string', value: t.text, span: t.span };
    }
    if (t.kind === 'color') {
      this.next();
      return { kind: 'color', value: t.text, span: t.span };
    }
    if (t.kind === 'ident') {
      this.next();
      if (t.text === 'true' || t.text === 'false') {
        return { kind: 'bool', value: t.text === 'true', span: t.span };
      }
      if (t.text === 'none') return { kind: 'none', span: t.span };
      return { kind: 'ident', name: t.text, span: t.span };
    }
    if (t.kind === 'punct' && t.text === '(') {
      this.next();
      const inner = this.parseTernary();
      this.expectPunct(')');
      return inner;
    }
    if (t.kind === 'punct' && t.text === '[') {
      this.next();
      const items: Expr[] = [];
      if (!this.isPunct(']')) {
        for (;;) {
          items.push(this.parseTernary());
          if (this.isPunct(',')) {
            this.next();
            continue;
          }
          break;
        }
      }
      const close = this.expectPunct(']');
      return { kind: 'list', items, span: { start: t.span.start, end: close.span.end } };
    }
    if (t.kind === 'punct' && t.text === '{') {
      this.next();
      const fields: { key: string; value: Expr }[] = [];
      if (!this.isPunct('}')) {
        for (;;) {
          const key = this.peek();
          if (key === undefined || (key.kind !== 'ident' && key.kind !== 'string')) {
            this.fail('O1017', 'expected a record key', undefined, key?.span);
          }
          this.next();
          this.expectPunct(':');
          const value = this.parseTernary();
          fields.push({ key: key.text, value });
          if (this.isPunct(',')) {
            this.next();
            continue;
          }
          break;
        }
      }
      const close = this.expectPunct('}');
      return { kind: 'record', fields, span: { start: t.span.start, end: close.span.end } };
    }
    this.fail('O1018', `unexpected ${JSON.stringify(t.text)} in expression`, undefined, t.span);
  }
}

export function parseExprTokens(tokens: Token[], template: string, at: Span): Expr {
  return new ExprParser(tokens, template, at).parseFull();
}

// ---------------------------------------------------------------------------
// Template parser
// ---------------------------------------------------------------------------

const CONTROL_TAGS: ReadonlySet<string> = new Set([
  'if',
  'else-if',
  'else',
  'for',
  'empty',
  'let',
  'slot',
  'json-ld',
]);

interface BodyCtx {
  depth: number;
  /** Preserve whitespace exactly (inside <pre> subtrees). */
  preserve: boolean;
  /** `verbatim` attr: `{` is literal text; no interpolation in this subtree. */
  verbatim: boolean;
}

class TemplateParser {
  private readonly s: Scanner;
  private readonly budget: NodeBudget;

  constructor(
    source: string,
    private readonly template: string,
  ) {
    this.s = new Scanner(source, template);
    this.budget = new NodeBudget(template);
  }

  parse(): Template {
    const start = this.s.posNow();
    this.skipLeadingTrivia();
    const fm = this.parseFrontmatter();
    const body = this.parseNodes(undefined, { depth: 0, preserve: false, verbatim: false });
    return {
      kind: 'template',
      name: fm.name,
      templateKind: fm.templateKind,
      props: fm.props,
      settings: fm.settings,
      slots: fm.slots,
      body,
      nodeCount: this.budget.count,
      span: { start, end: this.s.posNow() },
    };
  }

  // -- shared helpers -------------------------------------------------------

  private fail(code: string, message: string, suggestion?: string, at?: Pos): never {
    this.s.fail(code, message, suggestion, at);
  }

  private island(): Expr {
    // scanner must be positioned just after `{`
    const at = this.s.posNow();
    const tokens = lexExpression(this.s);
    return parseExprTokens(tokens, this.template, { start: at, end: this.s.posNow() });
  }

  private readIdent(what: string): string {
    if (!isIdentStart(this.s.peek())) {
      this.fail('O1020', `expected ${what}`);
    }
    const from = this.s.pos;
    this.s.next();
    while (isIdentPart(this.s.peek())) this.s.next();
    return this.s.src.slice(from, this.s.pos);
  }

  private readTagName(): string {
    const from = this.s.pos;
    if (!isIdentStart(this.s.peek())) this.fail('O1021', 'expected a tag name after <');
    this.s.next();
    while (isIdentPart(this.s.peek()) || this.s.peek() === '-') this.s.next();
    return this.s.src.slice(from, this.s.pos);
  }

  private skipComment(): void {
    // positioned at `{#`
    const at = this.s.posNow();
    this.s.match('{#');
    for (;;) {
      if (this.s.eof()) this.fail('O1022', 'unterminated {# comment #}', undefined, at);
      if (this.s.match('#}')) return;
      this.s.next();
    }
  }

  private skipHtmlComment(): void {
    const at = this.s.posNow();
    this.s.match('<!--');
    for (;;) {
      if (this.s.eof()) this.fail('O1023', 'unterminated <!-- comment -->', undefined, at);
      if (this.s.match('-->')) return;
      this.s.next();
    }
  }

  private skipLeadingTrivia(): void {
    for (;;) {
      this.s.skipWhitespace();
      if (this.s.startsWith('{#')) {
        this.skipComment();
        continue;
      }
      return;
    }
  }

  /** Skip whitespace and comments; returns true if anything was skipped. */
  private skipTrivia(): void {
    for (;;) {
      this.s.skipWhitespace();
      if (this.s.startsWith('{#')) {
        this.skipComment();
        continue;
      }
      if (this.s.startsWith('<!--')) {
        this.skipHtmlComment();
        continue;
      }
      return;
    }
  }

  // -- frontmatter ----------------------------------------------------------

  private parseFrontmatter(): {
    name: string;
    templateKind: 'component' | 'page';
    props: PropDecl[];
    settings: SettingDecl[];
    slots: SlotDecl[];
  } {
    if (!this.s.match('---')) {
      this.fail(
        'O1030',
        'every template starts with a frontmatter header',
        'begin the file with --- then `component Name` or `page name`',
      );
    }
    let name: string | undefined;
    let templateKind: 'component' | 'page' | undefined;
    const props: PropDecl[] = [];
    const settings: SettingDecl[] = [];
    const slots: SlotDecl[] = [];

    for (;;) {
      this.s.skipWhitespace();
      if (this.s.eof()) this.fail('O1031', 'unterminated frontmatter (missing closing ---)');
      if (this.s.match('---')) break;
      const at = this.s.posNow();
      const keyword = this.readIdent('a frontmatter keyword');
      if (keyword === 'component' || keyword === 'page') {
        if (templateKind !== undefined) this.fail('O1032', 'duplicate component/page declaration', undefined, at);
        this.s.skipWhitespace();
        const n = this.readIdent(`a ${keyword} name`);
        const first = n[0] ?? '';
        if (keyword === 'component' && (first < 'A' || first > 'Z')) {
          this.fail('O1033', 'component names are PascalCase', `write: component ${n[0]?.toUpperCase() ?? ''}${n.slice(1)}`, at);
        }
        if (keyword === 'page' && first >= 'A' && first <= 'Z') {
          this.fail('O1034', 'page names are lowercase', `write: page ${n.toLowerCase()}`, at);
        }
        name = n;
        templateKind = keyword;
        continue;
      }
      if (keyword === 'props') {
        this.parseBlock(() => props.push(this.parsePropDecl()));
        continue;
      }
      if (keyword === 'settings') {
        this.parseBlock(() => settings.push(this.parseSettingDecl()));
        continue;
      }
      if (keyword === 'slots') {
        this.parseBlock(() => slots.push(this.parseSlotDecl()));
        continue;
      }
      this.fail(
        'O1035',
        `unknown frontmatter keyword ${JSON.stringify(keyword)}`,
        'valid keywords: component, page, props, settings, slots',
        at,
      );
    }
    if (name === undefined || templateKind === undefined) {
      this.fail('O1036', 'frontmatter must declare `component Name` or `page name`');
    }
    // consume the newline after the closing ---
    if (this.s.peek() === '\r') this.s.next();
    if (this.s.peek() === '\n') this.s.next();
    return { name, templateKind, props, settings, slots };
  }

  private parseBlock(entry: () => void): void {
    this.s.skipWhitespace();
    if (!this.s.match('{')) this.fail('O1037', 'expected { to open the block');
    for (;;) {
      this.s.skipWhitespace();
      while (this.s.match(',')) this.s.skipWhitespace();
      if (this.s.eof()) this.fail('O1038', 'unterminated frontmatter block');
      if (this.s.match('}')) return;
      entry();
    }
  }

  private parseTypeExpr(): TypeExpr {
    const at = this.s.posNow();
    const name = this.readIdent('a type name');
    let type: TypeExpr;
    if (name === 'List') {
      if (!this.s.match('<')) this.fail('O1039', 'List needs an element type: List<T>');
      const inner = this.parseTypeExpr();
      if (!this.s.match('>')) this.fail('O1039', 'List needs an element type: List<T>');
      type = { kind: 'list', inner, span: { start: at, end: this.s.posNow() } };
    } else {
      type = { kind: 'name', name, span: { start: at, end: this.s.posNow() } };
    }
    while (this.s.peek() === '?') {
      this.s.next();
      type = { kind: 'optional', inner: type, span: { start: at, end: this.s.posNow() } };
    }
    return type;
  }

  /** Literal-only frontmatter values: numbers, strings, bools, none, colors. */
  private parseLiteral(): Expr {
    const at = this.s.posNow();
    const c = this.s.peek();
    if (c === '"') {
      this.s.next();
      let value = '';
      for (;;) {
        if (this.s.eof()) this.fail('O1004', 'unterminated string literal', undefined, at);
        const ch = this.s.next();
        if (ch === '"') break;
        if (ch === '\n' || ch === '\r') this.fail('O1005', 'string literals cannot contain raw newlines', 'use \\n', at);
        if (ch === '\\') {
          const esc = this.s.next();
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === '"') value += '"';
          else if (esc === '\\') value += '\\';
          else this.fail('O1006', `unknown string escape \\${esc}`);
          continue;
        }
        value += ch;
      }
      return { kind: 'string', value, span: { start: at, end: this.s.posNow() } };
    }
    if (c === '#') {
      this.s.next();
      let hex = '';
      while (isHex(this.s.peek())) hex += this.s.next();
      if (hex.length !== 6) this.fail('O1008', `color literals are exactly #rrggbb (got #${hex})`, undefined, at);
      return { kind: 'color', value: `#${hex.toLowerCase()}`, span: { start: at, end: this.s.posNow() } };
    }
    if (c === '-' || isDigit(c)) {
      let neg = false;
      if (c === '-') {
        neg = true;
        this.s.next();
      }
      let digits = '';
      while (isDigit(this.s.peek())) digits += this.s.next();
      if (digits === '') this.fail('O1040', 'expected a number');
      if (this.s.peek() === '.' && isDigit(this.s.peek(1))) {
        this.s.next();
        let frac = '';
        while (isDigit(this.s.peek())) frac += this.s.next();
        const v = Number(`${digits}.${frac}`);
        return { kind: 'float', value: neg ? -v : v, span: { start: at, end: this.s.posNow() } };
      }
      const v = Number(digits);
      return { kind: 'int', value: neg ? -v : v, span: { start: at, end: this.s.posNow() } };
    }
    if (isIdentStart(c)) {
      const word = this.readIdent('a literal');
      if (word === 'true' || word === 'false') {
        return { kind: 'bool', value: word === 'true', span: { start: at, end: this.s.posNow() } };
      }
      if (word === 'none') return { kind: 'none', span: { start: at, end: this.s.posNow() } };
      this.fail('O1041', `expected a literal value, found ${JSON.stringify(word)}`, 'frontmatter defaults are literals: numbers, strings, true/false, none, #colors', at);
    }
    this.fail('O1041', 'expected a literal value', 'frontmatter defaults are literals: numbers, strings, true/false, none, #colors', at);
  }

  private parsePropDecl(): PropDecl {
    const at = this.s.posNow();
    const name = this.readIdent('a prop name');
    if (name === 'settings') this.fail('O1042', '`settings` is a reserved binding name', undefined, at);
    this.s.skipWhitespace();
    if (!this.s.match(':')) this.fail('O1043', `prop ${JSON.stringify(name)} needs a type`, `write: ${name}: String`);
    this.s.skipWhitespace();
    const type = this.parseTypeExpr();
    let defaultValue: Expr | undefined;
    const save = this.s.save();
    this.s.skipWhitespace();
    if (this.s.peek() === '=') {
      this.s.next();
      this.s.skipWhitespace();
      defaultValue = this.parseLiteral();
    } else {
      this.s.restore(save);
    }
    return { name, type, defaultValue, span: { start: at, end: this.s.posNow() } };
  }

  private parseSettingDecl(): SettingDecl {
    const at = this.s.posNow();
    const name = this.readIdent('a setting name');
    this.s.skipWhitespace();
    if (!this.s.match(':')) this.fail('O1044', `setting ${JSON.stringify(name)} needs a control type`, `write: ${name}: Text = "..."`);
    this.s.skipWhitespace();
    const control = this.readIdent('a setting control');
    let setting: SettingControl;
    if (control === 'Text') setting = { control: 'text' };
    else if (control === 'Toggle') setting = { control: 'toggle' };
    else if (control === 'Color') setting = { control: 'color' };
    else if (control === 'Select') {
      if (!this.s.match('(')) this.fail('O1045', 'Select needs options: Select("a", "b")');
      const options: string[] = [];
      for (;;) {
        this.s.skipWhitespace();
        const lit = this.parseLiteral();
        if (lit.kind !== 'string') this.fail('O1045', 'Select options are string literals', undefined, lit.span.start);
        options.push(lit.value);
        this.s.skipWhitespace();
        if (this.s.match(',')) continue;
        if (this.s.match(')')) break;
        this.fail('O1045', 'Select needs options: Select("a", "b")');
      }
      setting = { control: 'select', options };
    } else if (control === 'Range') {
      if (!this.s.match('(')) this.fail('O1046', 'Range needs bounds: Range(min, max, step)');
      const nums: number[] = [];
      for (;;) {
        this.s.skipWhitespace();
        if (this.s.startsWith('step')) {
          this.readIdent('step');
          this.s.skipWhitespace();
          if (!this.s.match(':')) this.fail('O1046', 'write step: N');
          this.s.skipWhitespace();
        }
        const lit = this.parseLiteral();
        if (lit.kind !== 'int') this.fail('O1046', 'Range bounds are integers', undefined, lit.span.start);
        nums.push(lit.value);
        this.s.skipWhitespace();
        if (this.s.match(',')) continue;
        if (this.s.match(')')) break;
        this.fail('O1046', 'Range needs bounds: Range(min, max, step)');
      }
      const [min, max, step] = [nums[0], nums[1], nums[2] ?? 1];
      if (min === undefined || max === undefined) this.fail('O1046', 'Range needs at least min and max', undefined, at);
      setting = { control: 'range', min, max, step };
    } else {
      this.fail(
        'O1047',
        `unknown setting control ${JSON.stringify(control)}`,
        'valid controls: Text, Select(...), Range(min, max, step), Toggle, Color',
        at,
      );
    }
    this.s.skipWhitespace();
    if (!this.s.match('=')) this.fail('O1048', `setting ${JSON.stringify(name)} needs a default`, `write: ${name}: ... = <default>`);
    this.s.skipWhitespace();
    const defaultValue = this.parseLiteral();
    let label: string | undefined;
    const save = this.s.save();
    this.s.skipWhitespace();
    if (this.s.startsWith('label')) {
      // Lookahead: `label "..."` is a label; `label: Text = …` is the NEXT
      // setting declaration (label is not a reserved name).
      const word = this.readIdent('label');
      this.s.skipWhitespace();
      if (word === 'label' && this.s.peek() === '"') {
        const lit = this.parseLiteral();
        if (lit.kind !== 'string') this.fail('O1049', 'label must be a string literal', undefined, lit.span.start);
        label = lit.value;
      } else {
        this.s.restore(save);
      }
    } else {
      this.s.restore(save);
    }
    return { name, setting, defaultValue, label, span: { start: at, end: this.s.posNow() } };
  }

  private parseSlotDecl(): SlotDecl {
    const at = this.s.posNow();
    const name = this.readIdent('a slot name');
    let required = true;
    if (this.s.peek() === '?') {
      this.s.next();
      required = false;
    }
    return { name, required, span: { start: at, end: this.s.posNow() } };
  }

  // -- body -----------------------------------------------------------------

  private parseNodes(closeTag: string | undefined, ctx: BodyCtx, forCollector?: { empty?: Node[] }): Node[] {
    const nodes: Node[] = [];
    for (;;) {
      if (this.s.eof()) {
        if (closeTag !== undefined) {
          this.fail('O1050', `missing closing tag </${closeTag}>`);
        }
        return nodes;
      }
      if (this.s.startsWith('</')) {
        const save = this.s.save();
        this.s.match('</');
        const name = this.readTagName();
        this.s.skipWhitespace();
        if (!this.s.match('>')) this.fail('O1051', `malformed closing tag </${name}`);
        if (closeTag !== undefined && name === closeTag) return nodes;
        this.s.restore(save);
        this.fail(
          'O1052',
          closeTag !== undefined
            ? `expected </${closeTag}> but found </${name}>`
            : `stray closing tag </${name}>`,
        );
      }
      if (this.s.startsWith('<!--')) {
        this.skipHtmlComment();
        continue;
      }
      if (!ctx.verbatim && this.s.startsWith('{#')) {
        this.skipComment();
        continue;
      }
      if (!ctx.verbatim && this.s.peek() === '{') {
        const at = this.s.posNow();
        this.s.next();
        const expr = this.island();
        const span = { start: at, end: this.s.posNow() };
        this.budget.charge(span, ctx.depth);
        nodes.push({ kind: 'interpolation', expr, span });
        continue;
      }
      if (this.s.peek() === '<') {
        const nxt = this.s.peek(1);
        if (!isIdentStart(nxt)) {
          this.fail('O1053', 'unescaped `<` in text', 'write {"<"} for a literal less-than sign');
        }
        const node = this.parseTag(ctx, forCollector, closeTag);
        if (node !== undefined) {
          if (node.kind === 'if') this.mergeElseSiblings(node, ctx);
          nodes.push(node);
        }
        continue;
      }
      nodes.push(...this.parseText(ctx));
    }
  }

  private parseText(ctx: BodyCtx): Node[] {
    const at = this.s.posNow();
    let raw = '';
    while (!this.s.eof()) {
      const c = this.s.peek();
      if (c === '<') break;
      if (c === '{' && !ctx.verbatim) break;
      raw += this.s.next();
      if (raw.length > LIMITS.maxStringLength) {
        this.fail('O1054', 'text run exceeds the per-value string cap', undefined, at);
      }
    }
    const span = { start: at, end: this.s.posNow() };
    if (!ctx.preserve) {
      const collapsed = collapseWhitespace(raw);
      if (collapsed === '' || isAllWhitespace(collapsed)) return [];
      this.budget.charge(span, ctx.depth);
      return [{ kind: 'text', value: collapsed, span }];
    }
    if (raw === '') return [];
    this.budget.charge(span, ctx.depth);
    return [{ kind: 'text', value: raw, span }];
  }

  private parseTag(ctx: BodyCtx, forCollector: { empty?: Node[] } | undefined, closeTag: string | undefined): Node | undefined {
    const at = this.s.posNow();
    this.s.next(); // '<'
    const name = this.readTagName();

    if (CONTROL_TAGS.has(name)) {
      switch (name) {
        case 'if':
          return this.parseIf(at, ctx);
        case 'for':
          return this.parseFor(at, ctx);
        case 'let':
          return this.parseLet(at, ctx);
        case 'slot':
          return this.parseSlot(at, ctx);
        case 'json-ld':
          return this.parseJsonLd(at, ctx);
        case 'empty': {
          if (forCollector === undefined || closeTag !== 'for') {
            this.fail('O1055', '<empty> is only valid inside <for>', undefined, at);
          }
          if (forCollector.empty !== undefined) {
            this.fail('O1056', 'duplicate <empty> in <for>', undefined, at);
          }
          this.s.skipWhitespace();
          if (!this.s.match('>')) this.fail('O1057', '<empty> takes no attributes', undefined, at);
          forCollector.empty = this.parseNodes('empty', { ...ctx }, undefined);
          // <empty> must be the LAST child: only trivia allowed before </for>.
          this.skipTrivia();
          if (!this.s.startsWith('</for')) {
            this.fail('O1058', '<empty> must be the last child of <for>', 'move <empty> after every repeated child', at);
          }
          return undefined;
        }
        case 'else-if':
        case 'else':
          this.fail('O1059', `<${name}> without a preceding <if> sibling`, 'write <if {cond}>…</if><else-if {cond}>…</else-if><else>…</else>', at);
          break;
        default:
          break;
      }
    }

    const first = name[0] ?? '';
    if (first >= 'A' && first <= 'Z') return this.parseComponent(name, at, ctx);
    return this.parseElement(name, at, ctx);
  }

  private mergeElseSiblings(node: IfNode, ctx: BodyCtx): void {
    for (;;) {
      const save = this.s.save();
      this.skipTrivia();
      if (this.s.startsWith('<else-if')) {
        const at = this.s.posNow();
        this.s.match('<else-if');
        this.s.skipWhitespace();
        if (!this.s.match('{')) this.fail('O1060', '<else-if> needs a condition: <else-if {cond}>');
        const cond = this.island();
        this.s.skipWhitespace();
        if (!this.s.match('>')) this.fail('O1060', 'malformed <else-if {cond}>');
        const children = this.parseNodes('else-if', { ...ctx, depth: ctx.depth + 1 });
        node.branches.push({ cond, children, span: { start: at, end: this.s.posNow() } });
        continue;
      }
      if (this.s.startsWith('<else')) {
        this.s.match('<else');
        this.s.skipWhitespace();
        if (!this.s.match('>')) this.fail('O1061', 'malformed <else>');
        node.elseChildren = this.parseNodes('else', { ...ctx, depth: ctx.depth + 1 });
        node.span = { start: node.span.start, end: this.s.posNow() };
        return;
      }
      this.s.restore(save);
      return;
    }
  }

  private parseIf(at: Pos, ctx: BodyCtx): IfNode {
    this.s.skipWhitespace();
    if (!this.s.match('{')) this.fail('O1062', '<if> needs a condition: <if {cond}>', undefined, at);
    const cond = this.island();
    this.s.skipWhitespace();
    if (!this.s.match('>')) this.fail('O1062', 'malformed <if {cond}>', undefined, at);
    const children = this.parseNodes('if', { ...ctx, depth: ctx.depth + 1 });
    const span = { start: at, end: this.s.posNow() };
    this.budget.charge(span, ctx.depth);
    return { kind: 'if', branches: [{ cond, children, span }], span };
  }

  private parseFor(at: Pos, ctx: BodyCtx): ForNode {
    this.s.skipWhitespace();
    const item = this.readIdent('a loop variable');
    let index: string | undefined;
    this.s.skipWhitespace();
    if (this.s.match(',')) {
      this.s.skipWhitespace();
      index = this.readIdent('an index variable');
      this.s.skipWhitespace();
    }
    const kw = this.readIdent('`of`');
    if (kw !== 'of') this.fail('O1063', `expected \`of\` in <for>, found ${JSON.stringify(kw)}`, '<for item, i of={expr} limit={n}>');
    if (!this.s.match('=')) this.fail('O1063', 'expected of={expr}');
    if (!this.s.match('{')) this.fail('O1063', 'expected of={expr}');
    const subject = this.island();
    this.s.skipWhitespace();
    let limit: Expr | undefined;
    if (this.s.startsWith('limit')) {
      this.readIdent('limit');
      if (!this.s.match('=')) this.fail('O1064', 'expected limit={n}');
      if (!this.s.match('{')) this.fail('O1064', 'expected limit={n}');
      limit = this.island();
      this.s.skipWhitespace();
    }
    if (!this.s.match('>')) this.fail('O1065', 'malformed <for> tag');
    const collector: { empty?: Node[] } = {};
    const children = this.parseNodes('for', { ...ctx, depth: ctx.depth + 1 }, collector);
    const span = { start: at, end: this.s.posNow() };
    this.budget.charge(span, ctx.depth);
    return { kind: 'for', item, index, subject, limit, children, emptyChildren: collector.empty, span };
  }

  private parseLet(at: Pos, ctx: BodyCtx): Node {
    this.s.skipWhitespace();
    const name = this.readIdent('a binding name');
    if (name === 'settings') this.fail('O1042', '`settings` is a reserved binding name', undefined, at);
    if (!this.s.match('=')) this.fail('O1066', '<let> needs a value: <let name={expr}/>');
    if (!this.s.match('{')) this.fail('O1066', '<let> needs a value: <let name={expr}/>');
    const expr = this.island();
    this.s.skipWhitespace();
    if (!this.s.match('/>')) this.fail('O1067', '<let> is self-closing: <let name={expr}/>');
    const span = { start: at, end: this.s.posNow() };
    this.budget.charge(span, ctx.depth);
    return { kind: 'let', name, expr, span };
  }

  private parseSlot(at: Pos, ctx: BodyCtx): Node {
    this.s.skipWhitespace();
    let name = 'default';
    if (this.s.startsWith('name')) {
      this.readIdent('name');
      if (!this.s.match('="')) this.fail('O1068', 'slot names are static: <slot name="badge"/>');
      let value = '';
      for (;;) {
        if (this.s.eof()) this.fail('O1068', 'unterminated slot name');
        const c = this.s.next();
        if (c === '"') break;
        value += c;
      }
      name = value;
      this.s.skipWhitespace();
    }
    if (!this.s.match('/>')) this.fail('O1069', '<slot> is self-closing (no fallback content in v0)');
    const span = { start: at, end: this.s.posNow() };
    this.budget.charge(span, ctx.depth);
    return { kind: 'slot', name, span };
  }

  private parseJsonLd(at: Pos, ctx: BodyCtx): Node {
    this.s.skipWhitespace();
    if (!this.s.match('>')) this.fail('O1070', '<json-ld> takes no attributes');
    this.s.skipWhitespace();
    if (!this.s.match('{')) this.fail('O1071', '<json-ld> contains exactly one { record expression }');
    const expr = this.island();
    this.s.skipWhitespace();
    if (!this.s.match('</json-ld>')) this.fail('O1071', '<json-ld> contains exactly one { record expression }');
    const span = { start: at, end: this.s.posNow() };
    this.budget.charge(span, ctx.depth);
    return { kind: 'json-ld', expr, span };
  }

  // -- elements and components ----------------------------------------------

  private parseComponent(name: string, at: Pos, ctx: BodyCtx): Node {
    const props = this.parseAttrs(true, name);
    for (const p of props) {
      if (p.name === 'slot') {
        this.fail('O1072', 'components cannot carry slot=; wrap the call in an element', undefined, at);
      }
    }
    this.s.skipWhitespace();
    if (this.s.match('/>')) {
      const span = { start: at, end: this.s.posNow() };
      this.budget.charge(span, ctx.depth);
      return { kind: 'component', name, props, children: [], span };
    }
    if (!this.s.match('>')) this.fail('O1073', `malformed <${name}> tag`);
    const children = this.parseNodes(name, { ...ctx, depth: ctx.depth + 1 });
    const span = { start: at, end: this.s.posNow() };
    this.budget.charge(span, ctx.depth);
    return { kind: 'component', name, props, children, span };
  }

  private parseElement(tag: string, at: Pos, ctx: BodyCtx): Node {
    const banned = BANNED_ELEMENTS.get(tag);
    if (banned !== undefined) {
      this.fail('O1080', `<${tag}> is not allowed: ${banned}`, undefined, at);
    }
    if (!ELEMENT_ALLOWLIST.has(tag)) {
      this.fail('O1081', `<${tag}> is not in the element allowlist`, undefined, at);
    }
    const attrs = this.parseAttrs(false, tag);
    const isVoid = VOID_ELEMENTS.has(tag);
    const isRcdata = RCDATA_ELEMENTS.has(tag);

    this.s.skipWhitespace();
    if (this.s.match('/>')) {
      if (!isVoid) {
        this.fail('O1082', `<${tag}> is not a void element`, `write <${tag}>…</${tag}>`, at);
      }
      const span = { start: at, end: this.s.posNow() };
      this.budget.charge(span, ctx.depth);
      return { kind: 'element', tag, attrs, children: [], content: 'void', span };
    }
    if (!this.s.match('>')) this.fail('O1083', `malformed <${tag}> tag`);

    if (isVoid) {
      const span = { start: at, end: this.s.posNow() };
      this.budget.charge(span, ctx.depth);
      return { kind: 'element', tag, attrs, children: [], content: 'void', span };
    }

    if (isRcdata) {
      const children = this.parseRcdataChildren(tag, ctx);
      const span = { start: at, end: this.s.posNow() };
      this.budget.charge(span, ctx.depth);
      return { kind: 'element', tag, attrs, children, content: 'rcdata', span };
    }

    const verbatim = attrs.some((a) => a.name === 'verbatim');
    const childCtx: BodyCtx = {
      depth: ctx.depth + 1,
      preserve: ctx.preserve || tag === 'pre' || verbatim,
      verbatim: ctx.verbatim || verbatim,
    };
    const children = this.parseNodes(tag, childCtx);
    const span = { start: at, end: this.s.posNow() };
    this.budget.charge(span, ctx.depth);
    return { kind: 'element', tag, attrs, children, content: 'normal', span };
  }

  /** RCDATA (<title>, <textarea>): text + interpolation only; exact whitespace. */
  private parseRcdataChildren(tag: string, ctx: BodyCtx): Node[] {
    const nodes: Node[] = [];
    const close = `</${tag}`;
    let text = '';
    let textStart = this.s.posNow();
    const flush = (): void => {
      if (text !== '') {
        const span = { start: textStart, end: this.s.posNow() };
        this.budget.charge(span, ctx.depth + 1);
        nodes.push({ kind: 'text', value: text, span });
        text = '';
      }
    };
    for (;;) {
      if (this.s.eof()) this.fail('O1050', `missing closing tag </${tag}>`);
      if (this.s.startsWith(close)) {
        flush();
        this.s.match(close);
        this.s.skipWhitespace();
        if (!this.s.match('>')) this.fail('O1051', `malformed closing tag </${tag}`);
        return nodes;
      }
      if (this.s.startsWith('{#')) {
        flush();
        this.skipComment();
        textStart = this.s.posNow();
        continue;
      }
      if (this.s.peek() === '{') {
        flush();
        const at = this.s.posNow();
        this.s.next();
        const expr = this.island();
        const span = { start: at, end: this.s.posNow() };
        this.budget.charge(span, ctx.depth + 1);
        nodes.push({ kind: 'interpolation', expr, span });
        textStart = this.s.posNow();
        continue;
      }
      text += this.s.next();
      if (text.length > LIMITS.maxStringLength) {
        this.fail('O1054', 'text run exceeds the per-value string cap', undefined, textStart);
      }
    }
  }

  private parseAttrs(isComponent: boolean, tag: string): Attr[] {
    const attrs: Attr[] = [];
    const seen = new Set<string>();
    for (;;) {
      this.s.skipWhitespace();
      const c = this.s.peek();
      if (c === '>' || c === '/' || this.s.eof()) return attrs;
      const at = this.s.posNow();
      const name = this.readAttrName(isComponent);
      if (attrs.length >= LIMITS.maxAttrsPerElement) {
        this.fail('O1084', `more than ${LIMITS.maxAttrsPerElement} attributes on one element`, undefined, at);
      }
      if (seen.has(name)) this.fail('O1085', `duplicate attribute ${JSON.stringify(name)}`, undefined, at);
      seen.add(name);

      if (!isComponent) {
        const reason = attrRejection(name);
        if (reason !== undefined) this.fail('O1086', `attribute ${JSON.stringify(name)} is not allowed: ${reason}`, undefined, at);
        if (!attrAllowed(name)) {
          this.fail('O1087', `attribute ${JSON.stringify(name)} is not in the attribute allowlist`, 'use a data-* attribute for custom data', at);
        }
      }
      const isUrl = !isComponent && URL_ATTRS.has(name);

      let value: Attr['value'];
      if (this.s.startsWith('?=')) {
        this.s.match('?=');
        if (!this.s.match('{')) this.fail('O1088', `conditional attribute needs an expression: ${name}?={cond}`, undefined, at);
        value = { form: 'conditional', expr: this.island() };
      } else if (this.s.peek() === '=') {
        this.s.next();
        const q = this.s.peek();
        if (q === '{') {
          this.s.next();
          value = { form: 'expr', expr: this.island() };
        } else if (q === '"') {
          this.s.next();
          value = { form: 'parts', parts: this.parseAttrParts(name, at) };
        } else if (q === "'") {
          this.fail('O1089', 'attribute values are double-quoted', `write ${name}="..."`, at);
        } else {
          this.fail('O1090', 'attribute values must be quoted or an {expression}', `write ${name}="..." or ${name}={expr}`, at);
        }
      } else {
        value = { form: 'bare' };
      }

      if (!isComponent) {
        this.validateElementAttr(tag, name, value, at);
      } else if (value.form === 'parts') {
        const hasExpr = value.parts.some((p) => p.kind === 'expr');
        if (hasExpr) {
          this.fail('O1091', 'component props take whole expressions, not text with islands', `write ${name}={expr}`, at);
        }
      }
      attrs.push({ name, span: { start: at, end: this.s.posNow() }, value, isUrl });
    }
  }

  private readAttrName(isComponent: boolean): string {
    const at = this.s.posNow();
    const from = this.s.pos;
    if (!isIdentStart(this.s.peek())) this.fail('O1092', 'expected an attribute name');
    this.s.next();
    if (isComponent) {
      while (isIdentPart(this.s.peek())) this.s.next();
    } else {
      while (isIdentPart(this.s.peek()) || this.s.peek() === '-' || this.s.peek() === ':') this.s.next();
    }
    const name = this.s.src.slice(from, this.s.pos);
    if (!isComponent && name !== name.toLowerCase()) {
      this.fail('O1093', `attribute names are lowercase (got ${JSON.stringify(name)})`, undefined, at);
    }
    return name;
  }

  private parseAttrParts(attrName: string, at: Pos): AttrPart[] {
    const parts: AttrPart[] = [];
    let text = '';
    const flush = (): void => {
      if (text !== '') {
        parts.push({ kind: 'text', value: text });
        text = '';
      }
    };
    for (;;) {
      if (this.s.eof()) this.fail('O1094', `unterminated attribute value for ${JSON.stringify(attrName)}`, undefined, at);
      const c = this.s.peek();
      if (c === '"') {
        this.s.next();
        flush();
        return parts;
      }
      if (c === '{') {
        this.s.next();
        flush();
        parts.push({ kind: 'expr', expr: this.island() });
        continue;
      }
      text += this.s.next();
      if (text.length > LIMITS.maxStringLength) {
        this.fail('O1054', 'attribute value exceeds the per-value string cap', undefined, at);
      }
    }
  }

  private validateElementAttr(tag: string, name: string, value: Attr['value'], at: Pos): void {
    if (name === 'style') {
      const dynamic =
        value.form === 'expr' ||
        value.form === 'conditional' ||
        (value.form === 'parts' && value.parts.some((p) => p.kind === 'expr'));
      if (dynamic) {
        this.fail(
          'O1095',
          'interpolation inside style attributes is not allowed (W-09)',
          'select a class from a static set, or use a host cssVar helper',
          at,
        );
      }
    }
    if (name === 'slot') {
      const ok = value.form === 'parts' && value.parts.length === 1 && value.parts[0]?.kind === 'text';
      if (!ok) this.fail('O1096', 'slot= must be a static name: slot="badge"', undefined, at);
    }
    if (name === 'verbatim' && value.form !== 'bare') {
      this.fail('O1097', 'verbatim is a bare marker attribute', `write <${tag} verbatim>`, at);
    }
  }
}

function isHex(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

function isAllWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') return false;
  }
  return true;
}

/** Collapse runs of whitespace to one space (HTML-aware default). */
function collapseWhitespace(s: string): string {
  let out = '';
  let inWs = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      inWs = true;
      continue;
    }
    if (inWs && out !== '') out += ' ';
    if (inWs && out === '') out += ' ';
    inWs = false;
    out += c;
  }
  if (inWs) out += ' ';
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; template: Template }
  | { ok: false; diagnostics: Diagnostic[] };

export function parseTemplate(source: string, templateName = '<template>'): ParseResult {
  try {
    const template = new TemplateParser(source, templateName).parse();
    return { ok: true, template };
  } catch (err) {
    if (err instanceof OrbitParseError) {
      return { ok: false, diagnostics: [err.diagnostic] };
    }
    throw err;
  }
}

export interface SourceFile {
  /** File path or logical name — used in diagnostics only. */
  name: string;
  source: string;
}

export type ProgramResult =
  | { ok: true; program: Program }
  | { ok: false; diagnostics: Diagnostic[] };

export function parseProgram(files: readonly SourceFile[]): ProgramResult {
  const templates = new Map<string, Template>();
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    const parsed = parseTemplate(file.source, file.name);
    if (!parsed.ok) {
      diagnostics.push(...parsed.diagnostics);
      continue;
    }
    const existing = templates.get(parsed.template.name);
    if (existing !== undefined) {
      diagnostics.push({
        code: 'O1098',
        severity: 'error',
        message: `duplicate template name ${JSON.stringify(parsed.template.name)}`,
        template: file.name,
        span: parsed.template.span,
      });
      continue;
    }
    templates.set(parsed.template.name, parsed.template);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, program: { templates } };
}
