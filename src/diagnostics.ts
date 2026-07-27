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
