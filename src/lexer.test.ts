import { describe, expect, it } from 'vitest';
import { OrbitParseError } from './diagnostics';
import { lexExpression, Scanner } from './lexer';

function lex(exprBody: string) {
  // lexExpression expects the scanner positioned just AFTER the opening `{`.
  return lexExpression(new Scanner(exprBody));
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

  it('carries line/col spans', () => {
    const tokens = lex('a +\n  b}');
    expect(tokens[2]?.span.start.line).toBe(2);
    expect(tokens[2]?.span.start.col).toBe(3);
  });
});
