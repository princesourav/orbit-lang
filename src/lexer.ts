/**
 * Hand-rolled, linear scanner + expression lexer. No regex anywhere in this
 * package (W-04c): every classifier below is a plain char-code comparison and
 * every scan advances monotonically — O(n) by construction.
 */
import { OrbitParseError, type Pos, type Span } from './diagnostics';
import { LIMITS } from './limits';
import { PUNCTUATORS, type Token } from './tokens';

export function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

export function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

export function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

export function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

export function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

export interface ScannerState {
  pos: number;
  line: number;
  col: number;
}

/**
 * Character scanner with position tracking. The template parser drives this
 * directly for markup; `lexExpression` drives it inside `{ ... }` islands.
 */
export class Scanner {
  pos = 0;
  line = 1;
  col = 1;

  constructor(
    readonly src: string,
    readonly template: string = '<template>',
  ) {}

  eof(): boolean {
    return this.pos >= this.src.length;
  }

  peek(ahead = 0): string {
    return this.src[this.pos + ahead] ?? '';
  }

  next(): string {
    const c = this.src[this.pos] ?? '';
    this.pos += 1;
    if (c === '\n') {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    return c;
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  /** Consume `s` if the input starts with it. */
  match(s: string): boolean {
    if (!this.startsWith(s)) return false;
    for (let i = 0; i < s.length; i += 1) this.next();
    return true;
  }

  skipWhitespace(): void {
    while (!this.eof() && isWhitespace(this.peek())) this.next();
  }

  posNow(): Pos {
    return { offset: this.pos, line: this.line, col: this.col };
  }

  save(): ScannerState {
    return { pos: this.pos, line: this.line, col: this.col };
  }

  restore(state: ScannerState): void {
    this.pos = state.pos;
    this.line = state.line;
    this.col = state.col;
  }

  fail(code: string, message: string, suggestion?: string, at?: Pos): never {
    throw new OrbitParseError({
      code,
      severity: 'error',
      message,
      suggestion,
      template: this.template,
      span: { start: at ?? this.posNow(), end: at ?? this.posNow() },
    });
  }
}

function spanFrom(start: Pos, scanner: Scanner): Span {
  return { start, end: scanner.posNow() };
}

/**
 * Lex one expression island. The scanner must be positioned just AFTER the
 * opening `{`; on return it is positioned just after the matching `}` (which
 * is not included in the token list). Braces inside the expression (record
 * literals) are tracked by depth; string literals hide braces.
 */
export function lexExpression(scanner: Scanner): Token[] {
  const tokens: Token[] = [];
  let depth = 0;

  // The cap is checked AFTER each push, so exactly `maxExprTokens` tokens are
  // accepted and the (N+1)th is rejected — matching what O1002 says. Checking
  // before the push let N+1 tokens through whenever the expression ended on
  // the very next character.
  const push = (token: Token): void => {
    tokens.push(token);
    if (tokens.length > LIMITS.maxExprTokens) {
      scanner.fail(
        'O1002',
        `expression too long (more than ${LIMITS.maxExprTokens} tokens)`,
        'split the expression with <let>',
      );
    }
  };

  for (;;) {
    scanner.skipWhitespace();
    if (scanner.eof()) {
      scanner.fail('O1001', 'unterminated expression: missing closing `}`');
    }

    const start = scanner.posNow();
    const c = scanner.peek();

    if (c === '}') {
      if (depth === 0) {
        scanner.next(); // consume the terminator; not a token
        return tokens;
      }
      depth -= 1;
      scanner.next();
      push({ kind: 'punct', text: '}', span: spanFrom(start, scanner) });
      continue;
    }

    if (c === '{') {
      depth += 1;
      scanner.next();
      push({ kind: 'punct', text: '{', span: spanFrom(start, scanner) });
      continue;
    }

    if (c === '"') {
      push(lexString(scanner));
      continue;
    }

    if (c === '#') {
      push(lexColor(scanner));
      continue;
    }

    if (isDigit(c)) {
      push(lexNumber(scanner));
      continue;
    }

    if (isIdentStart(c)) {
      scanner.next();
      while (!scanner.eof() && (isIdentStart(scanner.peek()) || isDigit(scanner.peek()))) {
        scanner.next();
      }
      const text = scanner.src.slice(start.offset, scanner.pos);
      push({ kind: 'ident', text, span: spanFrom(start, scanner) });
      continue;
    }

    const punct = matchPunctuator(scanner);
    if (punct !== undefined) {
      push({ kind: 'punct', text: punct, span: spanFrom(start, scanner) });
      continue;
    }

    scanner.fail('O1003', `unexpected character ${JSON.stringify(c)} in expression`);
  }
}

function matchPunctuator(scanner: Scanner): string | undefined {
  for (const p of PUNCTUATORS) {
    if (scanner.startsWith(p)) {
      // `..` must win over `.`; PUNCTUATORS is ordered longest-first for the
      // multi-char operators, so a linear scan is correct.
      scanner.match(p);
      return p;
    }
  }
  return undefined;
}

function lexString(scanner: Scanner): Token {
  const start = scanner.posNow();
  scanner.next(); // opening quote
  let value = '';
  for (;;) {
    if (scanner.eof()) scanner.fail('O1004', 'unterminated string literal', undefined, start);
    const c = scanner.next();
    if (c === '"') break;
    if (c === '\n' || c === '\r') {
      scanner.fail('O1005', 'string literals cannot contain raw newlines', 'use \\n', start);
    }
    if (c === '\\') {
      const esc = scanner.next();
      if (esc === 'n') value += '\n';
      else if (esc === 't') value += '\t';
      else if (esc === 'r') value += '\r';
      else if (esc === '"') value += '"';
      else if (esc === '\\') value += '\\';
      else if (esc === '/') value += '/';
      else scanner.fail('O1006', `unknown string escape \\${esc}`, 'valid escapes: \\n \\t \\r \\" \\\\ \\/');
      continue;
    }
    value += c;
    if (value.length > LIMITS.maxStringLength) {
      scanner.fail('O1007', 'string literal exceeds the per-value string cap', undefined, start);
    }
  }
  return { kind: 'string', text: value, span: spanFrom(start, scanner) };
}

function lexColor(scanner: Scanner): Token {
  const start = scanner.posNow();
  scanner.next(); // '#'
  let hex = '';
  while (!scanner.eof() && isHexDigit(scanner.peek())) hex += scanner.next();
  if (hex.length !== 6) {
    scanner.fail('O1008', `color literals are exactly #rrggbb (got #${hex})`, undefined, start);
  }
  return { kind: 'color', text: `#${hex.toLowerCase()}`, span: spanFrom(start, scanner) };
}

// ---------------------------------------------------------------------------
// Numeric literal hygiene (shared with the frontmatter literal parser)
// ---------------------------------------------------------------------------

export interface LiteralProblem {
  code: string;
  message: string;
  suggestion?: string;
}

/** Drop leading zeros, keeping at least one digit ("007" -> "7", "000" -> "0"). */
function stripLeadingZeros(digits: string): string {
  let i = 0;
  while (i < digits.length - 1 && digits[i] === '0') i += 1;
  return digits.slice(i);
}

/**
 * A literal is accepted only if the double it parses to prints back to the
 * digits the author wrote. `toFixed` is exact for the fraction width we allow
 * (the digit cap is checked first, so it is always <= 100) and never switches
 * to exponent form below 1e21, which the cap also excludes.
 */
function roundTripsExactly(intDigits: string, fracDigits: string | undefined, value: number): boolean {
  const normalizedInt = stripLeadingZeros(intDigits);
  if (fracDigits === undefined) return String(value) === normalizedInt;
  return value.toFixed(fracDigits.length) === `${normalizedInt}.${fracDigits}`;
}

/**
 * Validate a decimal literal's digits. Numbers in Orbit are IEEE-754 doubles,
 * so a literal that is too wide, or that rounds to a different value than the
 * one written, is REJECTED rather than silently mis-evaluated: `Number(digits)`
 * on its own quietly turns 400 digits into `Infinity` and
 * `9007199254740993` into `9007199254740992`.
 *
 * Returns `undefined` when the literal is exact.
 */
export function numberLiteralProblem(
  intDigits: string,
  fracDigits?: string,
): LiteralProblem | undefined {
  const digitCount = intDigits.length + (fracDigits?.length ?? 0);
  if (digitCount > LIMITS.maxNumberDigits) {
    return {
      code: 'O1024',
      message: `numeric literal has ${digitCount} digits (the limit is ${LIMITS.maxNumberDigits})`,
      suggestion: 'Orbit numbers are IEEE-754 doubles; a wider literal cannot be represented',
    };
  }
  const text = fracDigits === undefined ? intDigits : `${intDigits}.${fracDigits}`;
  const value = Number(text);
  if (!Number.isFinite(value) || !roundTripsExactly(intDigits, fracDigits, value)) {
    return {
      code: 'O1025',
      message: `numeric literal ${text} cannot be represented exactly (it would round to ${String(value)})`,
      suggestion: `write ${String(value)} if that is what you meant, or keep integers within ±${String(Number.MAX_SAFE_INTEGER)}`,
    };
  }
  return undefined;
}

function lexNumber(scanner: Scanner): Token {
  const start = scanner.posNow();
  while (!scanner.eof() && isDigit(scanner.peek())) scanner.next();
  const intDigits = scanner.src.slice(start.offset, scanner.pos);
  // `1..5` — the first '.' belongs to the range operator, not the number.
  if (scanner.peek() === '.' && isDigit(scanner.peek(1))) {
    scanner.next();
    const fracFrom = scanner.pos;
    while (!scanner.eof() && isDigit(scanner.peek())) scanner.next();
    const fracDigits = scanner.src.slice(fracFrom, scanner.pos);
    const problem = numberLiteralProblem(intDigits, fracDigits);
    if (problem !== undefined) scanner.fail(problem.code, problem.message, problem.suggestion, start);
    return { kind: 'float', text: `${intDigits}.${fracDigits}`, span: spanFrom(start, scanner) };
  }
  const problem = numberLiteralProblem(intDigits);
  if (problem !== undefined) scanner.fail(problem.code, problem.message, problem.suggestion, start);
  return { kind: 'int', text: intDigits, span: spanFrom(start, scanner) };
}
