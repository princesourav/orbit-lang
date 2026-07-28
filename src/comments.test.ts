import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { formatTemplate } from './formatter';
import { parseProgram, parseTemplate } from './parser';
import { render } from './interpreter';
import { loadCheckedAst, serializeProgram } from './validate-ast';
import { compileOk, HOST_FILTERS } from './test-host.helper';

/**
 * Comments are retained in the AST.
 *
 * This exists because of a real regression that shipped: the parser discarded
 * comments, so `orbit fmt` deleted every comment in a file. It destroyed the
 * explanatory comments in all six shipped examples and no test noticed, because
 * a comment changes no rendered byte — the format-check gate passed happily on
 * the stripped output.
 *
 * Two properties are load-bearing and pull in opposite directions:
 *
 *   1. A comment must SURVIVE a format round trip. That is the bug.
 *   2. A comment must NEVER reach the output. It is not markup, and its
 *      contents are frequently internal — a comment leaking into a page would
 *      be a worse bug than the one being fixed.
 */

const HEAD = '---\npage p\n---\n';

function parseOrThrow(source: string) {
  const result = parseTemplate(source, 'c.orbit');
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '));
  }
  return result.template;
}

describe('comments reach the AST', () => {
  it('keeps both comment forms as nodes', () => {
    const t = parseOrThrow(`${HEAD}{# orbit #}<p>x</p><!-- html -->`);
    expect(t.body.map((n) => n.kind)).toEqual(['comment', 'element', 'comment']);
  });

  it('distinguishes the two forms so the formatter can restore what was written', () => {
    const t = parseOrThrow(`${HEAD}{# a #}<!-- b -->`);
    const nodes = t.body as Array<{ html: boolean; value: string }>;
    expect(nodes[0]!.html).toBe(false);
    expect(nodes[0]!.value).toBe(' a ');
    expect(nodes[1]!.html).toBe(true);
    expect(nodes[1]!.value).toBe(' b ');
  });

  it('charges the node budget, since a comment is a node like any other', () => {
    const without = parseOrThrow(`${HEAD}<p>x</p>`).nodeCount;
    const with_ = parseOrThrow(`${HEAD}{# c #}<p>x</p>`).nodeCount;
    expect(with_).toBe(without + 1);
  });

  it('caps a runaway comment rather than accumulating it unbounded', () => {
    const huge = 'x'.repeat(300_000);
    const result = parseTemplate(`${HEAD}{# ${huge} #}`, 'c.orbit');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]!.code).toBe('O1054');
  });

  it('still rejects an unterminated comment', () => {
    expect(parseTemplate(`${HEAD}{# never closed`, 'c.orbit').ok).toBe(false);
    expect(parseTemplate(`${HEAD}<!-- never closed`, 'c.orbit').ok).toBe(false);
  });

  it('does not treat {# as a comment inside verbatim', () => {
    const t = parseOrThrow(`${HEAD}<code verbatim>{# not a comment #}</code>`);
    const code = t.body[0] as { children: Array<{ kind: string }> };
    expect(code.children.every((c) => c.kind !== 'comment')).toBe(true);
  });
});

describe('comments never reach the output', () => {
  it('renders nothing for either form', () => {
    const program = compileOk([
      { name: 'p.orbit', source: `${HEAD}{# internal note #}<p>hi</p><!-- also internal -->` },
    ]);
    const out = render(program, 'p', { hostFilters: HOST_FILTERS });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.html).toBe('<p>hi</p>');
      expect(out.html).not.toContain('internal');
    }
  });

  it('leaks nothing even when the comment contains markup-shaped text', () => {
    // A comment body is never escaped, because it is never emitted. If that
    // ever changed, this is the test that would catch it.
    const program = compileOk([
      { name: 'p.orbit', source: `${HEAD}{# <script>alert(1)</script> #}<p>hi</p>` },
    ]);
    const out = render(program, 'p', { hostFilters: HOST_FILTERS });
    expect(out.ok && out.html).toBe('<p>hi</p>');
  });
});

describe('comments survive a format round trip', () => {
  const CASES = [
    '{# leading #}<p>x</p>',
    '<p>x</p>{# trailing #}',
    '<div>{# nested #}<p>x</p></div>',
    '<!-- html form -->\n<p>x</p>',
    '{# one #}\n{# two #}\n<p>x</p>',
    '<if {true}>{# inside a branch #}<p>x</p></if>',
    '<for i of={[1, 2]}>{# in a loop #}<p>x</p><empty><p>none</p></empty></for>',
  ];

  for (const body of CASES) {
    it(`round-trips: ${body.slice(0, 40)}`, () => {
      const formatted = formatTemplate(parseOrThrow(HEAD + body));
      // Either comment form counts; the point is that one survived.
      expect(formatted.includes('#}') || formatted.includes('-->')).toBe(true);
      const again = formatTemplate(parseOrThrow(formatted));
      expect(again).toBe(formatted);
    });
  }

  it('preserves the comment body verbatim, without reflowing it', () => {
    // Reflowing prose inside a comment would be a second, unasked-for edit.
    const body = '{#   spaced   and\n   multi-line   #}<p>x</p>';
    const formatted = formatTemplate(parseOrThrow(HEAD + body));
    expect(formatted).toContain('   spaced   and\n   multi-line   ');
  });

  it('never loses a comment, for any arrangement', () => {
    const piece = fc.constantFrom(
      '{# a #}',
      '<!-- b -->',
      '<p>text</p>',
      '<div><span>x</span></div>',
      '{# c #}',
    );
    fc.assert(
      fc.property(fc.array(piece, { minLength: 1, maxLength: 6 }), (parts) => {
        const source = HEAD + parts.join('');
        const before = (source.match(/\{#/g) ?? []).length + (source.match(/<!--/g) ?? []).length;
        const formatted = formatTemplate(parseOrThrow(source));
        const after =
          (formatted.match(/\{#/g) ?? []).length + (formatted.match(/<!--/g) ?? []).length;
        expect(after).toBe(before);
      }),
      { numRuns: 200 },
    );
  });
});

describe('comments in a stored AST', () => {
  it('round-trips through serialize and verified load', () => {
    const parsed = parseProgram([{ name: 'p.orbit', source: `${HEAD}{# kept #}<p>x</p>` }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const json = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));
    const back = loadCheckedAst(json, { trust: 'verify' });
    expect([...back.templates.values()][0]!.body.map((n) => n.kind)).toEqual(['comment', 'element']);
  });

  it('rejects a poisoned comment node', () => {
    // A comment cannot reach a sink, but every field of every node in an
    // executable artifact is checked — an unchecked field is one some later
    // code path may start trusting.
    const parsed = parseProgram([{ name: 'p.orbit', source: `${HEAD}{# ok #}<p>x</p>` }]);
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const base = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));

    const withValue = JSON.parse(JSON.stringify(base));
    withValue.templates.p.body[0].value = { evil: true };
    expect(() => loadCheckedAst(withValue, { trust: 'verify' })).toThrow(/comment node value/);

    const withoutFlag = JSON.parse(JSON.stringify(base));
    delete withoutFlag.templates.p.body[0].html;
    expect(() => loadCheckedAst(withoutFlag, { trust: 'verify' })).toThrow(/html flag/);
  });
});
