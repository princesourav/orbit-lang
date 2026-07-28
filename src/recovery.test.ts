import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseProgram, parseTemplate } from './parser';
import { serializeProgram } from './validate-ast';
import { LIMITS } from './limits';

/**
 * Tests for parser error recovery.
 *
 * The feature is "one parse pass reports every problem in the file", but the
 * property that actually matters is the one underneath it: a template that
 * needed recovery is never usable. Recovery collects diagnostics; it does not
 * produce a salvaged tree. The security tests below exist because the
 * tempting alternative — an AST containing error placeholder nodes — creates a
 * standing risk that some later code path renders a half-parsed template.
 */

const head = (name = 'Broken') => `---\ncomponent ${name}\n---\n`;

function diagnosticsFor(body: string, name = 'broken.orbit') {
  const result = parseTemplate(head() + body, name);
  return result.ok ? [] : result.diagnostics;
}

describe('parser error recovery', () => {
  it('reports every independent error in one pass, not just the first', () => {
    const diags = diagnosticsFor(
      ['<p>a < b</p>', '<div>fine</div>', '<span>c < d</span>', '<em>e < f</em>'].join('\n'),
    );
    expect(diags.length).toBeGreaterThanOrEqual(3);
    expect(diags.every((d) => d.code === 'O1053')).toBe(true);
    // Distinct lines — three separate mistakes, not one reported three times.
    const lines = diags.map((d) => d.span?.start.line);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('reports diagnostics in source order', () => {
    const diags = diagnosticsFor(['<p>a < b</p>', '<blink>x</blink>', '<i>c < d</i>'].join('\n'));
    const offsets = diags.map((d) => d.span?.start.offset ?? 0);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it('keeps parsing after a banned element and finds later errors', () => {
    const diags = diagnosticsFor(['<script>alert(1)</script>', '<p>later < error</p>'].join('\n'));
    expect(diags.map((d) => d.code)).toContain('O1080');
    expect(diags.map((d) => d.code)).toContain('O1053');
  });

  it('does not report the closing tag of an element it already rejected', () => {
    // `<script>…</script>` is one mistake. Reporting a stray `</script>` after
    // it trains authors to ignore everything past the first diagnostic.
    const diags = diagnosticsFor('<script>alert(1)</script>');
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('O1080');
    expect(diags.some((d) => d.code === 'O1052')).toBe(false);
  });

  it('suppresses exactly as many orphaned closers as there were bad openers', () => {
    const diags = diagnosticsFor(
      ['<blink>one</blink>', '<blink>two</blink>', '</blink>'].join('\n'),
    );
    // Two bad openers are reported; their two closers are swallowed; the third
    // closer is genuinely stray and must still be reported.
    expect(diags.filter((d) => d.code === 'O1081')).toHaveLength(2);
    expect(diags.filter((d) => d.code === 'O1052')).toHaveLength(1);
  });

  it('still reports a genuinely stray closing tag', () => {
    const diags = diagnosticsFor('<p>fine</p>\n</div>');
    expect(diags.map((d) => d.code)).toContain('O1052');
  });

  it('reports the same first diagnostic a fail-fast parser would have', () => {
    // Recovery must not change what the first error IS — only what follows it.
    const diags = diagnosticsFor('<p>a < b</p>\n<blink>x</blink>');
    expect(diags[0]!.code).toBe('O1053');
    expect(diags[0]!.span?.start.line).toBe(4);
  });

  it('caps the number of recovered errors instead of working without bound', () => {
    const body = '<p>a < b</p>\n'.repeat(LIMITS.maxParseErrorsPerTemplate + 50);
    const diags = diagnosticsFor(body);
    expect(diags.length).toBeLessThanOrEqual(LIMITS.maxParseErrorsPerTemplate + 1);
    expect(diags.length).toBeGreaterThan(1);
  });

  it('fails the whole file when frontmatter is damaged, without inventing body errors', () => {
    // The header declares the template's name, props and slots. Recovering past
    // a broken one would make every later diagnostic guesswork.
    const result = parseTemplate('not frontmatter at all\n<p>x</p>', 'bad.orbit');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]!.code).toBe('O1030');
    }
  });

  it('collects errors across files in a program', () => {
    const result = parseProgram([
      { name: 'a.orbit', source: head('A') + '<p>a < b</p>\n<i>c < d</i>' },
      { name: 'b.orbit', source: head('B') + '<blink>x</blink>' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.filter((d) => d.template === 'a.orbit').length).toBeGreaterThan(1);
      expect(result.diagnostics.some((d) => d.template === 'b.orbit')).toBe(true);
    }
  });
});

describe('recovery is not a salvage path', () => {
  it('never returns a template when any error was recovered', () => {
    const result = parseTemplate(head() + '<p>a < b</p>\n<div>ok</div>', 'x.orbit');
    expect(result.ok).toBe(false);
    // `template` must not be reachable on the failure branch at all.
    expect((result as unknown as { template?: unknown }).template).toBeUndefined();
  });

  it('never yields a program a caller could serialize or render', () => {
    const result = parseProgram([
      { name: 'a.orbit', source: head('A') + '<p>a < b</p>\n<em>c < d</em>' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // There is no program object to hand to serializeProgram; assert the
      // failure shape rather than trusting the type system alone, since a
      // future refactor could reintroduce a partial tree.
      expect((result as unknown as { program?: unknown }).program).toBeUndefined();
      expect(() =>
        serializeProgram((result as unknown as { program: never }).program),
      ).toThrow();
    }
  });

  it('a file whose only error is recovered is still a failure', () => {
    // One error, recovered, then a clean tail — the file must not "pass".
    const result = parseTemplate(head() + '<p>a < b</p>', 'x.orbit');
    expect(result.ok).toBe(false);
  });
});

describe('recovery terminates', () => {
  it('makes forward progress on adversarial input', () => {
    // Characters chosen to sit on the boundaries recovery keys off of: a
    // resync that failed to consume any of these would spin forever.
    const nasty = fc
      .array(fc.constantFrom('<', '>', '{', '}', '/', '"', '\n', 'a', '#'), { maxLength: 120 })
      .map((chars) => chars.join(''));
    fc.assert(
      fc.property(nasty, (body) => {
        const result = parseTemplate(head() + body, 'fuzz.orbit');
        // The only requirement is that it RETURNS. Either outcome is fine.
        expect(typeof result.ok).toBe('boolean');
        if (!result.ok) {
          expect(result.diagnostics.length).toBeGreaterThan(0);
          expect(result.diagnostics.length).toBeLessThanOrEqual(
            LIMITS.maxParseErrorsPerTemplate + 1,
          );
        }
      }),
      { numRuns: 400 },
    );
  });

  it('terminates on unterminated constructs at EOF', () => {
    for (const body of ['<div>', '<p>{', '{unclosed', '<div><span>', '<p>a < b', '</']) {
      const result = parseTemplate(head() + body, 'eof.orbit');
      expect(result.ok).toBe(false);
    }
  });

  it('terminates on deeply nested unclosed elements', () => {
    const result = parseTemplate(head() + '<div>'.repeat(60), 'deep.orbit');
    expect(result.ok).toBe(false);
  });

  it('never emits a diagnostic without a span', () => {
    // The code-frame renderer needs a span; a span-less diagnostic silently
    // degrades to location-only output.
    const diags = diagnosticsFor(['<p>a < b</p>', '<blink>x</blink>', '<i>c < d</i>'].join('\n'));
    expect(diags.every((d) => d.span !== undefined)).toBe(true);
  });
});
