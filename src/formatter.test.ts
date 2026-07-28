import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { formatProgram, formatTemplate } from './formatter';
import { parseProgram, parseTemplate } from './parser';
import { serializeProgram } from './validate-ast';
import { render } from './interpreter';
import { compileOk, HOST_FILTERS } from './test-host.helper';

/**
 * Tests for the canonical formatter.
 *
 * Two properties carry the whole feature, and both are asserted as properties
 * rather than examples because the interesting failures are inputs nobody
 * thought to write by hand:
 *
 *   1. **Idempotence** — `format(format(x)) === format(x)`. Without it, a
 *      format-on-save loop rewrites files forever and `--check` in CI is a
 *      coin flip.
 *   2. **Rendering preservation** — formatting must not change output bytes.
 *      Whitespace is semantic in HTML, and the parser keeps boundary spaces,
 *      so a newline inserted in the wrong place silently changes a page.
 */

function parseOrThrow(source: string, name = 'fmt.orbit') {
  const result = parseTemplate(source, name);
  if (!result.ok) {
    throw new Error(
      `fixture does not parse: ${result.diagnostics.map((d) => `${d.code} ${d.message}`).join('; ')}`,
    );
  }
  return result.template;
}

function fmt(source: string): string {
  return formatTemplate(parseOrThrow(source));
}

const HEAD = '---\ncomponent Card\n---\n';

describe('formatter: canonical output', () => {
  it('normalizes indentation to two spaces', () => {
    const out = fmt(`${HEAD}<div>\n        <p>hi</p>\n</div>`);
    // The `orbit` pragma is written even when the source omitted it: absent
    // means the default, so stating it changes no meaning and makes every
    // formatted template say which language version it targets.
    expect(out).toBe('---\norbit 2026\ncomponent Card\n---\n<div>\n  <p>hi</p>\n</div>\n');
  });

  it('keeps a short element on one line', () => {
    expect(fmt(`${HEAD}<p>hello</p>`)).toContain('<p>hello</p>');
  });

  it('always ends with exactly one newline', () => {
    for (const body of ['<p>a</p>', '<p>a</p>\n\n\n', '<div><p>a</p></div>']) {
      const out = fmt(HEAD + body);
      expect(out.endsWith('\n')).toBe(true);
      expect(out.endsWith('\n\n')).toBe(false);
    }
  });

  it('breaks long attribute lists one per line, all or nothing', () => {
    const long = `${HEAD}<a href="https://example.com/a/very/long/path/that/keeps/going/onwards" class="button button--primary button--large" id="cta">go</a>`;
    const out = fmt(long);
    expect(out).toContain('<a\n');
    expect(out).toContain('\n  href=');
    expect(out).toContain('\n  class=');
    expect(out).toContain('\n  id=');
  });

  it('preserves author order in frontmatter blocks', () => {
    // Order is documentation — sorting would destroy the author's grouping.
    const src = '---\ncomponent Card\nprops {\n  zebra: String\n  apple: Int\n}\n---\n<p>x</p>';
    const out = fmt(src);
    expect(out.indexOf('zebra')).toBeLessThan(out.indexOf('apple'));
  });

  it('emits no tab characters', () => {
    const out = fmt(`${HEAD}<div>\n\t<p>tabbed</p>\n</div>`);
    expect(out).not.toContain('\t');
  });
});

describe('formatter: expressions', () => {
  const exprOf = (e: string) => {
    const out = fmt(`${HEAD}<p>{${e}}</p>`);
    const start = out.indexOf('{');
    return out.slice(start + 1, out.lastIndexOf('}'));
  };

  it('spaces binary operators and keeps member access tight', () => {
    expect(exprOf('a.b+c.d')).toBe('a.b + c.d');
  });

  it('drops redundant parentheses', () => {
    expect(exprOf('(a + b)')).toBe('a + b');
  });

  it('keeps parentheses that are load-bearing', () => {
    expect(exprOf('(a + b) * c')).toBe('(a + b) * c');
    expect(exprOf('a + b * c')).toBe('a + b * c');
  });

  it('prints the pipe as the loosest operator without inventing parentheses', () => {
    // `|>` is loosest as of v0.2, so `a + b |> f` pipes the whole sum and needs
    // no parentheses to reparse identically.
    expect(exprOf('a + b |> upper')).toBe('a + b |> upper');
  });

  it('round-trips pipes with arguments', () => {
    expect(exprOf('title |> truncate(40)')).toBe('title |> truncate(40)');
  });

  it('round-trips chained pipes', () => {
    expect(exprOf('title |> trim |> upper')).toBe('title |> trim |> upper');
  });

  it('round-trips ternary and coalesce', () => {
    expect(exprOf('a ?? "x"')).toBe('a ?? "x"');
    expect(exprOf('flag ? "y" : "n"')).toBe('flag ? "y" : "n"');
  });

  it('escapes string literals so they read back identically', () => {
    expect(exprOf('"quote \\" and \\\\ back"')).toBe('"quote \\" and \\\\ back"');
  });

  it('keeps optional chaining distinct from plain access', () => {
    expect(exprOf('a?.b')).toBe('a?.b');
    expect(exprOf('a.b')).toBe('a.b');
  });
});

describe('formatter: whitespace is preserved exactly', () => {
  it('does not break a line where doing so would add a space', () => {
    // `<p>hello</p>` must never become `<p>\n  hello\n</p>`: that renders as
    // " hello " instead of "hello".
    const out = fmt(`${HEAD}<p>hello</p>`);
    expect(out).toContain('<p>hello</p>');
  });

  it('may break where the text already carries boundary spaces', () => {
    const out = fmt(`${HEAD}<div> <p>a</p> </div>`);
    expect(out).toContain('<div>');
  });

  it('reproduces a pre subtree exactly', () => {
    const src = `${HEAD}<pre>  keep\n   this\n</pre>`;
    const out = fmt(src);
    expect(out).toContain('  keep\n   this\n');
  });

  it('does not reflow RCDATA content', () => {
    const out = fmt(`${HEAD}<title>My  Page</title>`);
    // Whatever the parser stored is what must come back out.
    const inner = out.slice(out.indexOf('<title>') + 7, out.indexOf('</title>'));
    expect(inner.includes('\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * Template bodies chosen to sit on the boundaries the formatter reasons about:
 * text with and without boundary spaces, nested elements, mixed content,
 * control flow, and long attribute lists.
 */
const BODY_SNIPPETS = [
  '<p>hello</p>',
  '<p> spaced </p>',
  '<p>Hello <b>world</b>!</p>',
  '<p>Hello <b>world</b> !</p>',
  '<div><p>a</p><p>b</p></div>',
  '<div> <p>a</p> <p>b</p> </div>',
  '<p>{title}</p>',
  '<p>text {title} more</p>',
  '<p>{title |> upper}</p>',
  '<p>{a + b |> upper}</p>',
  '<if {flag}><p>yes</p></if>',
  '<if {flag}><p>yes</p></if><else><p>no</p></else>',
  '<for item of={items}><p>{item}</p><empty><p>none</p></empty></for>',
  '<let x={title}/>',
  '<slot/>',
  '<slot name="header"/>',
  '<img src="/a.png" alt="a"/>',
  '<a href="/x" class="button button--primary button--large button--wide" id="cta">go</a>',
  '<ul><li>one</li><li>two</li></ul>',
  '<pre>  raw\n  text\n</pre>',
  '<title>Page</title>',
  '<p>a<br/>b</p>',
  '<section><div><span>deep</span></div></section>',
];

const bodyArb = fc
  .array(fc.constantFrom(...BODY_SNIPPETS), { minLength: 1, maxLength: 5 })
  .map((parts) => parts.join(''));

describe('formatter: properties', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        const once = fmt(HEAD + body);
        const twice = formatTemplate(parseOrThrow(once));
        expect(twice).toBe(once);
      }),
      { numRuns: 200 },
    );
  });

  it('produces output that still parses', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        const once = fmt(HEAD + body);
        expect(parseTemplate(once, 'fmt.orbit').ok).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('preserves the AST: the formatted source serializes identically', () => {
    fc.assert(
      fc.property(bodyArb, (body) => {
        const original = parseProgram([{ name: 'a.orbit', source: HEAD + body }]);
        expect(original.ok).toBe(true);
        if (!original.ok) return;

        const formatted = formatProgram(original.program).get('Card')!;
        const reparsed = parseProgram([{ name: 'a.orbit', source: formatted }]);
        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) return;

        // Spans legitimately move; the structure must not. Serializing both
        // and comparing after stripping spans is the cheapest sound check.
        const strip = (v: unknown): unknown =>
          JSON.parse(
            JSON.stringify(v, (key, value) =>
              key === 'span' || key === 'nodeCount' ? undefined : value,
            ),
          );
        expect(strip(serializeProgram(reparsed.program))).toEqual(
          strip(serializeProgram(original.program)),
        );
      }),
      { numRuns: 150 },
    );
  });
});

describe('formatter: rendering is byte-identical', () => {
  /**
   * The property that makes the formatter safe to run on a production theme:
   * whatever it does to the source, the page must not move by one byte.
   */
  it('renders identically before and after formatting', () => {
    const bodies = [
      '<p>hello</p>',
      '<p> spaced </p>',
      '<p>Hello <b>world</b>!</p>',
      '<div><p>a</p><p>b</p></div>',
      '<div>   <p>a</p>   <p>b</p>   </div>',
      '<ul><li>one</li><li>two</li></ul>',
      '<p>a<br/>b</p>',
      '<pre>  raw\n  text\n</pre>',
      '<section><div><span>deep</span></div></section>',
      '<p>text before<b>bold</b>text after</p>',
      '<p>text before <b>bold</b> text after</p>',
    ];

    for (const body of bodies) {
      const source = `---\npage sample\n---\n${body}`;
      const before = compileOk([{ name: 'sample.orbit', source }]);

      const formatted = formatProgram(before).get('sample')!;
      const after = compileOk([{ name: 'sample.orbit', source: formatted }]);

      const renderOpts = { hostFilters: HOST_FILTERS, bindings: {} };
      const r1 = render(before, 'sample', renderOpts);
      const r2 = render(after, 'sample', renderOpts);

      expect(r1.ok, `original must render: ${body}`).toBe(true);
      expect(r2.ok, `formatted must render: ${body}`).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r2.html, `formatting changed rendering for: ${body}`).toBe(r1.html);
      }
    }
  });
});
