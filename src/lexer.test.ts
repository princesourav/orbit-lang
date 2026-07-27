import { describe, expect, it } from 'vitest';
import { OrbitParseError } from './diagnostics';
import { lexExpression, numberLiteralProblem, Scanner } from './lexer';
import { LIMITS } from './limits';

function lex(exprBody: string) {
  // lexExpression expects the scanner positioned just AFTER the opening `{`.
  return lexExpression(new Scanner(exprBody));
}

function codeOf(exprBody: string): string {
  try {
    lex(exprBody);
  } catch (err) {
    if (err instanceof OrbitParseError) return err.diagnostic.code;
    throw err;
  }
  throw new Error('expected a lex error');
}

describe('expression lexer', () => {
  it('lexes identifiers, members and pipes', () => {
    const tokens = lex('product.title |> upper}');
    expect(tokens.map((t) => `${t.kind}:${t.text}`)).toEqual([
      'ident:product',
      'punct:.',
      'ident:title',
      'punct:|>',
      'ident:upper',
    ]);
  });

  it('distinguishes ranges from floats', () => {
    expect(lex('1..5}').map((t) => `${t.kind}:${t.text}`)).toEqual(['int:1', 'punct:..', 'int:5']);
    expect(lex('1.5}').map((t) => `${t.kind}:${t.text}`)).toEqual(['float:1.5']);
  });

  it('lexes multi-char operators greedily', () => {
    expect(lex('a ?? b ?. c <= d != e}').map((t) => t.text)).toEqual(['a', '??', 'b', '?.', 'c', '<=', 'd', '!=', 'e']);
  });

  it('decodes string escapes and rejects raw newlines', () => {
    const [tok] = lex('"a\\n\\"b\\\\"}');
    expect(tok?.kind).toBe('string');
    expect(tok?.text).toBe('a\n"b\\');
    expect(() => lex('"a\nb"}')).toThrowError(OrbitParseError);
  });

  it('normalizes color literals and rejects short hex', () => {
    expect(lex('#A1B2C3}')[0]).toMatchObject({ kind: 'color', text: '#a1b2c3' });
    expect(() => lex('#fff}')).toThrowError(OrbitParseError);
  });

  it('tracks record-literal brace depth', () => {
    const tokens = lex('{a: 1}}');
    expect(tokens.map((t) => t.text)).toEqual(['{', 'a', ':', '1', '}']);
  });

  it('fails on an unterminated expression with O1001', () => {
    try {
      lex('product.title');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OrbitParseError);
      expect((err as OrbitParseError).diagnostic.code).toBe('O1001');
    }
  });

  // The cap is checked after each push, so the boundary is exact: N tokens
  // lex, N+1 do not. Before v0.2 the check ran before the push, which let
  // maxExprTokens + 1 through while the message claimed the limit was N.
  describe('expression token cap (O1002)', () => {
    const tokens = (n: number) => Array.from({ length: n }, () => 'a').join(' ') + '}';

    it('accepts exactly maxExprTokens tokens', () => {
      expect(lex(tokens(LIMITS.maxExprTokens))).toHaveLength(LIMITS.maxExprTokens);
    });

    it('rejects maxExprTokens + 1 tokens', () => {
      expect(codeOf(tokens(LIMITS.maxExprTokens + 1))).toBe('O1002');
    });

    it('counts punctuation and record braces too', () => {
      // '{' + ('a' ':' '1' ',') * k ... every token pushed is charged.
      const inner = Array.from({ length: LIMITS.maxExprTokens }, (_, i) => `a${i}: 1`).join(', ');
      expect(codeOf(`{${inner}}}`)).toBe('O1002');
    });
  });

  describe('numeric literal hygiene (O1024 / O1025)', () => {
    it('rejects literals past the digit cap', () => {
      expect(codeOf(`${'9'.repeat(400)}}`)).toBe('O1024');
      expect(codeOf(`0.${'1'.repeat(LIMITS.maxNumberDigits)}1}`)).toBe('O1024');
    });

    it('rejects literals that do not round-trip exactly', () => {
      expect(codeOf('9007199254740993}')).toBe('O1025');
      expect(codeOf('1.00000000000000001}')).toBe('O1025');
    });

    it('keeps `1..5` a range, not a float', () => {
      expect(lex('1..5}').map((t) => t.text)).toEqual(['1', '..', '5']);
    });

    it('numberLiteralProblem is exact at the digit-cap boundary', () => {
      expect(numberLiteralProblem('1'.repeat(LIMITS.maxNumberDigits))?.code).toBe('O1025');
      expect(numberLiteralProblem('1'.repeat(LIMITS.maxNumberDigits + 1))?.code).toBe('O1024');
      expect(numberLiteralProblem('0', '0'.repeat(LIMITS.maxNumberDigits - 2) + '1')).toBeUndefined();
      expect(numberLiteralProblem(String(Number.MAX_SAFE_INTEGER))).toBeUndefined();
    });
  });

  it('carries line/col spans', () => {
    const tokens = lex('a +\n  b}');
    expect(tokens[2]?.span.start.line).toBe(2);
    expect(tokens[2]?.span.start.col).toBe(3);
  });
});
