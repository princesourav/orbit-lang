import { describe, expect, it } from 'vitest';
import { format, run } from './playground';

/**
 * The playground is the first thing most visitors will touch, and its whole
 * value is that the claims on the README can be checked live. These tests
 * assert that the demonstrations actually demonstrate what they promise —
 * a playground whose "XSS is a compile error" example quietly compiles would
 * be worse than having no playground.
 */

const HEAD = '---\npage shop\n---\n';

describe('playground: compiling and rendering', () => {
  it('renders a working template and escapes hostile data', () => {
    const result = run(`${HEAD}<h1>{collection.title}</h1>\n`);
    expect(result.failed).toBe(false);
    expect(result.errorCount).toBe(0);
    // The demo data deliberately contains & " < > so the escaping is visible.
    expect(result.html).toContain('&amp;');
    expect(result.html).toContain('&lt;Fresh&gt;');
    expect(result.html).not.toContain('<Fresh>');
  });

  it('reports every parse error at once, with code frames', () => {
    const result = run(`${HEAD}<p>a < b</p>\n<blink>x</blink>\n`);
    expect(result.failed).toBe(true);
    expect(result.errorCount).toBeGreaterThanOrEqual(2);
    expect(result.diagnostics).toContain('O1053');
    expect(result.diagnostics).toContain('O1081');
    expect(result.diagnostics).toContain('^');
  });
});

describe('playground: the examples prove what they claim', () => {
  it('rejects script, event handlers and iframes', () => {
    for (const bad of [
      '<script>alert(1)</script>',
      '<div onclick="steal()">x</div>',
      '<iframe src="//evil.example"></iframe>',
    ]) {
      const result = run(HEAD + bad + '\n');
      expect(result.failed, `${bad} must not compile`).toBe(true);
      expect(result.errorCount).toBeGreaterThan(0);
    }
  });

  it('rejects interpolation inside a style attribute', () => {
    const result = run(`${HEAD}<div style="color: {collection.title}">x</div>\n`);
    expect(result.failed).toBe(true);
  });

  it('accepts a plain String in href but neutralizes it at the sink', () => {
    // Deliberately NOT a compile error: Orbit never trusts a *type* to mean a
    // URL is safe. The scheme allowlist is applied where the value is emitted,
    // so a hostile string is defused at render time and reported.
    const result = run(`${HEAD}<a href={collection.title}>x</a>\n`);
    expect(result.failed).toBe(false);
    expect(result.html).toContain('href="#"');
    expect(result.html).not.toContain('javascript:');
    expect(result.warnings.join(' ')).toContain('O4900');
  });

  it('rejects an unguarded optional (the optional law)', () => {
    const result = run(
      `${HEAD}<for product of={collection.products}><p>{product.vendor}</p><empty><p>none</p></empty></for>\n`,
    );
    expect(result.failed).toBe(true);
    expect(result.diagnostics).toContain('O2104');
  });

  it('rejects a String used as a condition (no truthiness)', () => {
    const result = run(`${HEAD}<if {collection.title}><p>x</p></if>\n`);
    expect(result.failed).toBe(true);
    expect(result.diagnostics).toContain('O3007');
  });

  it('accepts the optional once it is narrowed or defaulted', () => {
    const result = run(
      `${HEAD}<for product of={collection.products}><p>{product.vendor ?? ""}</p><empty><p>none</p></empty></for>\n`,
    );
    expect(result.failed).toBe(false);
  });
});

describe('playground: the escaping panel', () => {
  it('labels each interpolation with the context its position implies', () => {
    const result = run(
      `${HEAD}<title>{collection.title}</title>\n<h1>{collection.title}</h1>\n<div data-label={collection.title}>x</div>\n`,
    );
    const contexts = result.sites.map((s) => s.context);
    expect(contexts).toContain('RCDATA');
    expect(contexts).toContain('TEXT');
    expect(contexts).toContain('ATTR');
  });

  it('marks URL attributes as a distinct sink', () => {
    const result = run(
      `${HEAD}<for product of={collection.products}><a href={product.url}>x</a><empty><p>n</p></empty></for>\n`,
    );
    expect(result.sites.map((s) => s.context)).toContain('URL-ATTR');
  });

  it('never reports a RAWTEXT context, because none is reachable', () => {
    const result = run(`${HEAD}<h1>{collection.title}</h1>\n`);
    expect(result.sites.map((s) => s.context)).not.toContain('RAWTEXT');
  });
});

describe('playground: supporting panels', () => {
  it('extracts a data access plan', () => {
    const result = run(
      `${HEAD}<for product of={collection.products}><p>{product.title}</p><empty><p>n</p></empty></for>\n`,
    );
    expect(result.plan).toContain('collection.products');
    expect(result.plan).toContain('collection.products[].title');
  });

  it('reports budget usage against the published caps', () => {
    const result = run(`${HEAD}<h1>{collection.title}</h1>\n`);
    expect(result.budgets.outputBytes).toBe(result.html.length);
    expect(result.budgets.outputMax).toBeGreaterThan(result.budgets.outputBytes);
  });

  it('formats a template, and refuses when it does not parse', () => {
    const ok = format(`${HEAD}<div>\n        <p>hi</p>\n</div>\n`);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.text).toContain('  <p>hi</p>');

    const bad = format(`${HEAD}<p>a < b</p>\n`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('O1053');
  });
});
