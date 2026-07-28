/**
 * Diagnostic and error carriers shared by lexer, parser, checker, interpreter.
 *
 * Engine-local on purpose: the open engine has zero dependency on platform
 * error packages. Every diagnostic carries a stable code, a span (line/col)
 * and, wherever we can compute one, a suggestion — "no silent failure mode
 * exists anywhere in the language".
 */

export interface Pos {
  /** 0-based byte-ish offset into the source (UTF-16 code units). */
  offset: number;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  col: number;
}

export interface Span {
  start: Pos;
  end: Pos;
}

export type Severity = 'error' | 'warning';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  template?: string;
  span?: Span;
  suggestion?: string;
}

export function spanAt(pos: Pos, end?: Pos): Span {
  return { start: pos, end: end ?? pos };
}

export function formatDiagnostic(d: Diagnostic): string {
  const where =
    d.span !== undefined
      ? `${d.template ?? '<template>'}:${d.span.start.line}:${d.span.start.col}`
      : (d.template ?? '<template>');
  const help = d.suggestion !== undefined ? `\n help: ${d.suggestion}` : '';
  return `${d.severity}[${d.code}]: ${d.message}\n  --> ${where}${help}`;
}

// ---------------------------------------------------------------------------
// Code frames (rustc / Elm tradition)
// ---------------------------------------------------------------------------

/**
 * Rendering knobs for `codeFrame` / `formatDiagnosticWithSource`.
 *
 * Colour is OPT-IN, never auto-detected: this module has no I/O and no
 * `process`, so it cannot know whether the sink is a TTY, a CI log or an LSP
 * `Diagnostic.message`. The host decides.
 */
export interface CodeFrameOptions {
  /** Emit ANSI SGR escapes. Default `false` — plain text everywhere. */
  color?: boolean;
  /** Extra source lines shown before and after the span. Default `0`. */
  contextLines?: number;
  /** Columns a TAB advances to when expanded for alignment. Default `4`. */
  tabWidth?: number;
  /** Max display columns of source shown per line; longer lines are windowed
   *  around the span. Default `100`. */
  maxWidth?: number;
  /** Max fully rendered lines of a multi-line span before eliding the middle.
   *  Default `4`. */
  maxSpanLines?: number;
}

interface ResolvedFrameOptions {
  color: boolean;
  contextLines: number;
  tabWidth: number;
  maxWidth: number;
  maxSpanLines: number;
}

function resolveOptions(o: CodeFrameOptions | undefined): ResolvedFrameOptions {
  return {
    color: o?.color ?? false,
    contextLines: clampInt(o?.contextLines, 0, 0, 20),
    tabWidth: clampInt(o?.tabWidth, 4, 1, 16),
    maxWidth: clampInt(o?.maxWidth, 100, 24, 1000),
    maxSpanLines: clampInt(o?.maxSpanLines, 4, 1, 100),
  };
}

function clampInt(v: number | undefined, fallback: number, lo: number, hi: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  const n = Math.trunc(v);
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

const ANSI_RESET = '\u001b[0m';
const ANSI_BOLD = '\u001b[1m';
const ANSI_RED = '\u001b[31m';
const ANSI_YELLOW = '\u001b[33m';
const ANSI_BLUE = '\u001b[34m';
const ANSI_CYAN = '\u001b[36m';

function paint(on: boolean, code: string, s: string): string {
  return on ? `${code}${s}${ANSI_RESET}` : s;
}

/**
 * Split into lines WITHOUT regex, matching how `Scanner` counts lines: only
 * `\n` starts a new line, so a CRLF file numbers identically and the trailing
 * `\r` is dropped for display only.
 */
export function splitSourceLines(source: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') {
      let end = i;
      if (end > start && source[end - 1] === '\r') end -= 1;
      lines.push(source.slice(start, end));
      start = i + 1;
    }
  }
  let end = source.length;
  if (end > start && source[end - 1] === '\r') end -= 1;
  lines.push(source.slice(start, end));
  return lines;
}

/** Roughly-East-Asian-Wide test. Hand-rolled ranges; no regex, no Intl. */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Combining marks and joiners occupy no column of their own. */
function isZeroWidthCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff
  );
}

interface LaidOutLine {
  /** Tabs expanded, control characters replaced; safe to print. */
  text: string;
  /** Display column (0-based) before each UTF-16 unit of `text`. */
  displayAt: number[];
  /** `text` index for each UTF-16 index of the ORIGINAL line. */
  srcToText: number[];
  /** Total display width. */
  width: number;
}

/**
 * Expand one source line for display and build the two index maps a caret run
 * needs. Columns in a `Pos` are 1-based UTF-16 units (that is what `Scanner`
 * counts), while carets must line up with DISPLAY columns — tabs, wide CJK
 * glyphs, surrogate pairs and combining marks all break the 1:1 assumption.
 */
function layoutLine(line: string, tabWidth: number): LaidOutLine {
  let text = '';
  const displayAt: number[] = [];
  const srcToText: number[] = new Array<number>(line.length + 1);
  let width = 0;
  let i = 0;
  while (i < line.length) {
    srcToText[i] = text.length;
    const ch = line[i] ?? '';
    if (ch === '\t') {
      const advance = tabWidth - (width % tabWidth);
      for (let k = 0; k < advance; k += 1) {
        displayAt.push(width + k);
        text += ' ';
      }
      width += advance;
      i += 1;
      continue;
    }
    const unit = line.charCodeAt(i);
    let cp = unit;
    let units = 1;
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < line.length) {
      const lo = line.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = (unit - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
        units = 2;
      }
    }
    const w = isZeroWidthCodePoint(cp) ? 0 : isWideCodePoint(cp) ? 2 : 1;
    // Control characters would scramble the frame; show a space instead.
    const printable = cp < 0x20 || cp === 0x7f ? ' ' : line.slice(i, i + units);
    for (let k = 0; k < printable.length; k += 1) displayAt.push(width);
    text += printable;
    if (units === 2) srcToText[i + 1] = text.length - printable.length;
    width += w;
    i += units;
  }
  srcToText[line.length] = text.length;
  displayAt.push(width);
  return { text, displayAt, srcToText, width };
}

function displayColumn(layout: LaidOutLine, col: number): number {
  const idx = col - 1;
  const clamped = idx < 0 ? 0 : idx > layout.srcToText.length - 1 ? layout.srcToText.length - 1 : idx;
  const textIdx = layout.srcToText[clamped] ?? layout.text.length;
  return layout.displayAt[textIdx] ?? layout.width;
}

interface WindowedLine {
  text: string;
  /** Display columns dropped from the left (already including the ellipsis). */
  shift: number;
}

const ELLIPSIS = '...';

/** Window a long line around [caretFrom, caretTo) so the span stays visible. */
function windowLine(
  layout: LaidOutLine,
  caretFrom: number,
  caretTo: number,
  maxWidth: number,
): WindowedLine {
  if (layout.width <= maxWidth) return { text: layout.text, shift: 0 };
  const span = caretTo - caretFrom;
  const room = maxWidth - ELLIPSIS.length * 2;
  const lead = span >= room ? Math.floor(room / 4) : Math.floor((room - span) / 2);
  let from = caretFrom - lead;
  if (from < 0) from = 0;
  if (from + room > layout.width) from = Math.max(0, layout.width - room);
  const to = from + room;
  let out = '';
  for (let j = 0; j < layout.text.length; j += 1) {
    const at = layout.displayAt[j] ?? 0;
    if (at < from) continue;
    if (at >= to) break;
    out += layout.text[j] ?? '';
  }
  const leftCut = from > 0;
  const rightCut = to < layout.width;
  const prefix = leftCut ? ELLIPSIS : '';
  return {
    text: prefix + out + (rightCut ? ELLIPSIS : ''),
    shift: from - prefix.length,
  };
}

interface CaretRow {
  line: number;
  /** 1-based UTF-16 columns; `to` is exclusive. */
  from: number;
  to: number;
}

/** Which columns of which lines the span covers, one row per rendered line. */
function caretRows(span: Span, lines: readonly string[], maxSpanLines: number): CaretRow[] {
  const firstLine = span.start.line;
  const lastLine = Math.max(firstLine, span.end.line);
  const rows: CaretRow[] = [];
  const emit = (line: number): void => {
    const text = lines[line - 1] ?? '';
    const from = line === firstLine ? span.start.col : 1;
    const to = line === lastLine ? span.end.col : text.length + 1;
    rows.push({ line, from, to: Math.max(to, from + 1) });
  };
  if (lastLine - firstLine + 1 <= maxSpanLines) {
    for (let line = firstLine; line <= lastLine; line += 1) emit(line);
    return rows;
  }
  emit(firstLine);
  rows.push({ line: -1, from: 0, to: 0 }); // elision marker
  emit(lastLine);
  return rows;
}

/**
 * The source excerpt for one span: gutter, the offending line(s), and a caret
 * run under the exact columns the span covers. Returns `undefined` when the
 * span cannot be located in `source` (empty file, line past the end), so the
 * caller can fall back to the location-only format.
 */
export function codeFrame(
  source: string,
  span: Span,
  label?: string,
  options?: CodeFrameOptions,
): string | undefined {
  const opt = resolveOptions(options);
  const built = buildFrame(source, span, label, opt);
  return built?.frame;
}

interface BuiltFrame {
  frame: string;
  gutterWidth: number;
  /** True when `label` was placed next to the caret rather than dropped. */
  labelInline: boolean;
}

function buildFrame(
  source: string,
  span: Span,
  label: string | undefined,
  opt: ResolvedFrameOptions,
): BuiltFrame | undefined {
  const lines = splitSourceLines(source);
  const rows = caretRows(span, lines, opt.maxSpanLines);
  const first = rows[0];
  if (first === undefined || first.line < 1 || first.line > lines.length) return undefined;

  const contextFrom = Math.max(1, first.line - opt.contextLines);
  const lastRow = rows[rows.length - 1];
  const lastLine = lastRow === undefined ? first.line : Math.max(first.line, lastRow.line);
  const contextTo = Math.min(lines.length, lastLine + opt.contextLines);
  const gutterWidth = String(contextTo).length;
  const bar = paint(opt.color, ANSI_BLUE, '|');
  const pad = ' '.repeat(gutterWidth);
  const out: string[] = [];
  const push = (s: string): void => {
    out.push(trimEnd(s));
  };

  push(`${pad} ${bar}`);
  for (let line = contextFrom; line < first.line; line += 1) {
    push(`${gutter(line, gutterWidth, opt)} ${bar} ${layoutLine(lines[line - 1] ?? '', opt.tabWidth).text}`);
  }

  let labelInline = false;
  for (const row of rows) {
    if (row.line === -1) {
      push(paint(opt.color, ANSI_BLUE, `${pad}...`));
      continue;
    }
    const raw = lines[row.line - 1] ?? '';
    const layout = layoutLine(raw, opt.tabWidth);
    const caretFrom = displayColumn(layout, row.from);
    const caretTo = Math.max(caretFrom + 1, displayColumn(layout, row.to));
    const win = windowLine(layout, caretFrom, caretTo, opt.maxWidth);
    push(`${gutter(row.line, gutterWidth, opt)} ${bar} ${win.text}`);
    const isLast = row === rows[rows.length - 1];
    const start = Math.max(0, caretFrom - win.shift);
    const run = Math.max(1, caretTo - caretFrom);
    let caret = `${' '.repeat(start)}${'^'.repeat(run)}`;
    if (isLast && label !== undefined && start + run + 1 + label.length <= opt.maxWidth + gutterWidth) {
      caret += ` ${label}`;
      labelInline = true;
    }
    push(`${pad} ${bar} ${paint(opt.color, ANSI_RED, caret)}`);
  }

  for (let line = lastLine + 1; line <= contextTo; line += 1) {
    push(`${gutter(line, gutterWidth, opt)} ${bar} ${layoutLine(lines[line - 1] ?? '', opt.tabWidth).text}`);
  }
  return { frame: out.join('\n'), gutterWidth, labelInline };
}

function gutter(line: number, width: number, opt: ResolvedFrameOptions): string {
  const n = String(line);
  return paint(opt.color, ANSI_BLUE, `${' '.repeat(Math.max(0, width - n.length))}${n}`);
}

function trimEnd(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s[end - 1];
    if (c !== ' ' && c !== '\t') break;
    end -= 1;
  }
  return s.slice(0, end);
}

/**
 * THE RECOMMENDED WAY TO SHOW A DIAGNOSTIC. Prints the rustc-style header, the
 * `-->` location, a source excerpt with a caret run under the span, and the
 * fix-it — inline beside the caret when it fits, on a `help:` line when it
 * does not.
 *
 * Falls back to `formatDiagnostic` when there is no span or the span does not
 * resolve in `source` (a stored AST, a diagnostic about a whole file).
 */
export function formatDiagnosticWithSource(
  d: Diagnostic,
  source: string,
  options?: CodeFrameOptions,
): string {
  if (d.span === undefined) return formatDiagnostic(d);
  const opt = resolveOptions(options);
  const built = buildFrame(source, d.span, d.suggestion, opt);
  if (built === undefined) return formatDiagnostic(d);
  const severityColor = d.severity === 'error' ? ANSI_RED : ANSI_YELLOW;
  const head =
    paint(opt.color, ANSI_BOLD, paint(opt.color, severityColor, `${d.severity}[${d.code}]`)) +
    paint(opt.color, ANSI_BOLD, `: ${d.message}`);
  const pad = ' '.repeat(built.gutterWidth);
  const where = `${d.template ?? '<template>'}:${d.span.start.line}:${d.span.start.col}`;
  const arrow = `${pad}${paint(opt.color, ANSI_BLUE, '-->')} ${where}`;
  const bar = paint(opt.color, ANSI_BLUE, '|');
  const tail =
    d.suggestion !== undefined && !built.labelInline
      ? `\n${pad} ${bar}\n${paint(opt.color, ANSI_CYAN, 'help')}: ${d.suggestion}`
      : '';
  return `${head}\n${arrow}\n${built.frame}${tail}`;
}

/**
 * Format a whole batch — the shape a CLI or the LSP wants. `sources` maps the
 * `template` field of a diagnostic to that file's text; a diagnostic whose
 * source is missing degrades to the location-only format instead of vanishing.
 */
export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  sources: ReadonlyMap<string, string>,
  options?: CodeFrameOptions,
): string {
  const parts: string[] = [];
  for (const d of diagnostics) {
    const src = d.template === undefined ? undefined : sources.get(d.template);
    parts.push(src === undefined ? formatDiagnostic(d) : formatDiagnosticWithSource(d, src, options));
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Render warnings
// ---------------------------------------------------------------------------

/**
 * A non-fatal runtime finding, shaped like a diagnostic so hosts can ROUTE it
 * programmatically (to a theme-developer console, a lint dashboard, a metric)
 * instead of pattern-matching English.
 *
 * v0.1 pushed bare strings; a host had to `.includes('blocked unsafe URL')` to
 * find anything, which is not an API. Warnings now carry the same
 * `code` + `message` + template/line/col shape as `RenderErrorInfo`.
 *
 * Codes are stable and namespaced O49xx (render, non-fatal):
 *   O4900  a URL was blocked at the sink and replaced with a placeholder
 *   O4901  a merchant setting value was invalid; the declared default was used
 *   O4902  an `unsafeHtml` host filter's output was emitted raw
 *   O4903  a prop supplied at a component entry is not declared
 *   O4909  the warning list hit its per-render cap and was truncated
 */
export interface RenderWarning {
  code: string;
  message: string;
  template?: string;
  /** 1-based line of the responsible AST node, when one is known. */
  line?: number;
  /** 1-based column of the responsible AST node, when one is known. */
  col?: number;
}

export function formatRenderWarning(w: RenderWarning): string {
  const where =
    w.line !== undefined
      ? `${w.template ?? '<template>'}:${w.line}:${w.col ?? 1}`
      : (w.template ?? '<template>');
  return `warning[${w.code}]: ${w.message}\n  --> ${where}`;
}

/** Thrown internally by the parser; callers receive `{ ok: false, diagnostics }`. */
export class OrbitParseError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(formatDiagnostic(diagnostic));
    this.name = 'OrbitParseError';
  }
}

/** Thrown by the interpreter; callers receive `{ ok: false, error }`. */
export class OrbitRenderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly template?: string,
    readonly span?: Span,
  ) {
    super(message);
    this.name = 'OrbitRenderError';
  }
}

/** Thrown by `loadCheckedAst` when structural re-validation fails. */
export class OrbitAstError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join('\n'));
    this.name = 'OrbitAstError';
  }
}
