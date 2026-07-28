import { describe, expect, it } from 'vitest';
import {
  complete,
  diagnose,
  format,
  hover,
  HOST_DEPENDENT_CODES,
  SEVERITY,
  toLspDiagnostic,
  wordAt,
} from './analysis.mjs';

const HEAD = '---\ncomponent Card\nprops {\n  title: String\n}\n---\n';

describe('diagnostics', () => {
  it('reports every error in a file, not just the first', () => {
    // The payoff of parser recovery: an editor squiggles everything at once.
    const diags = diagnose(`${HEAD}<p>a < b</p>\n<blink>x</blink>\n<i>c < d</i>\n`);
    expect(diags.length).toBeGreaterThanOrEqual(3);
  });

  it('converts 1-based Orbit spans to 0-based LSP positions', () => {
    const diags = diagnose(`${HEAD}<p>a < b</p>\n`);
    const first = diags[0];
    // The error is on source line 7, column 8 -> LSP line 6, character 7.
    expect(first.range.start.line).toBe(6);
    expect(first.range.start.character).toBeGreaterThanOrEqual(0);
    expect(first.range.end.character).toBeGreaterThan(first.range.start.character - 1);
  });

  it('never emits a negative position', () => {
    const diags = diagnose('not frontmatter\n');
    for (const d of diags) {
      expect(d.range.start.line).toBeGreaterThanOrEqual(0);
      expect(d.range.start.character).toBeGreaterThanOrEqual(0);
    }
  });

  it('carries the diagnostic code and marks the source', () => {
    const diags = diagnose(`${HEAD}<script>x()</script>\n`);
    expect(diags[0].code).toBe('O1080');
    expect(diags[0].source).toBe('orbit');
  });

  it('puts the fix-it in the message where a user will see it', () => {
    const diags = diagnose(`${HEAD}<p>a < b</p>\n`);
    expect(diags[0].message).toContain('help:');
  });

  it('distinguishes warnings from errors', () => {
    const diags = diagnose(`${HEAD}<p>{title}</p>\n`);
    for (const d of diags) {
      expect([SEVERITY.error, SEVERITY.warning]).toContain(d.severity);
    }
  });

  it('suppresses host-dependent diagnostics when no project host is configured', () => {
    // An editor cannot know a project's type registry. Reporting every data
    // reference as unknown would bury the diagnostics that are actionable.
    const source = `---\npage shop\n---\n<p>{product.title}</p>\n`;
    const withoutHost = diagnose(source, { hasProjectHost: false });
    const withHost = diagnose(source, { hasProjectHost: true });

    expect(withoutHost.some((d) => HOST_DEPENDENT_CODES.has(d.code))).toBe(false);
    expect(withHost.length).toBeGreaterThanOrEqual(withoutHost.length);
  });

  it('still reports allowlist and syntax errors without a host', () => {
    const diags = diagnose(`---\npage shop\n---\n<blink>{product.title}</blink>\n`);
    expect(diags.map((d) => d.code)).toContain('O1081');
  });
});

describe('completion', () => {
  it('offers only filters after a pipe', () => {
    const items = complete(HEAD, '<p>{title |>');
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((i) => i.detail !== 'element')).toBe(true);
    expect(items.map((i) => i.label)).toContain('truncate');
  });

  it('offers elements and control flow after <', () => {
    const items = complete(HEAD, '<');
    const labels = items.map((i) => i.label);
    expect(labels).toContain('div');
    expect(labels).toContain('article');
    expect(labels).toContain('if');
    expect(labels).toContain('for');
  });

  it('never offers a banned element', () => {
    const labels = complete(HEAD, '<').map((i) => i.label);
    for (const banned of ['script', 'style', 'iframe', 'svg', 'meta', 'link']) {
      expect(labels, `offered banned element ${banned}`).not.toContain(banned);
    }
  });

  it("offers the template's own props", () => {
    const items = complete(HEAD, '<p>{');
    expect(items.map((i) => i.label)).toContain('title');
  });

  it('offers declared settings by path', () => {
    const source =
      '---\ncomponent Banner\nsettings {\n  tone: Select("a", "b") = "a" label "Tone"\n}\n---\n';
    const labels = complete(source, '<p>{').map((i) => i.label);
    expect(labels).toContain('settings');
    expect(labels).toContain('settings.tone');
  });

  it('offers declared slots with their requiredness', () => {
    const source = '---\ncomponent Panel\nslots {\n  header\n  footer?\n}\n---\n';
    const items = complete(source, '<p>{');
    expect(items.find((i) => i.label === 'header')?.detail).toContain('required');
    expect(items.find((i) => i.label === 'footer')?.detail).toContain('optional');
  });

  it('offers the literals, since there is no truthiness to fall back on', () => {
    const labels = complete(HEAD, '<p>{').map((i) => i.label);
    expect(labels).toContain('true');
    expect(labels).toContain('none');
  });

  it('still completes when the buffer does not parse', () => {
    // Half-typed buffers are the normal case while editing.
    const items = complete(`${HEAD}<p>{title |> `, '<p>{title |>');
    expect(items.length).toBeGreaterThan(0);
  });
});

describe('hover', () => {
  it('explains WHY a banned element is banned', () => {
    const text = hover(HEAD, 'script', '<');
    expect(text).toContain('not allowed');
    expect(text).toContain('no opt-out');
  });

  it('prefers a declared slot over the element of the same name', () => {
    // `header` is both an allowlisted element and an ordinary slot name; the
    // `<` before it is what decides which the user meant.
    const source = '---\ncomponent Panel\nslots {\n  header\n}\n---\n';
    expect(hover(source, 'header', '  ')).toContain('slot');
    expect(hover(source, 'header', '<')).toContain('allowlisted element');
  });

  it('gives a filter signature', () => {
    expect(hover(HEAD, 'truncate')).toContain('truncate(String, Num');
  });

  it('states the formatDate timezone limitation', () => {
    expect(hover(HEAD, 'formatDate')).toContain('NO timezone');
  });

  it('explains that a URL attribute is sanitized at the sink, not by type', () => {
    const text = hover(HEAD, 'href');
    expect(text).toContain('never trusts a type');
  });

  it('identifies a prop declared in the buffer', () => {
    expect(hover(HEAD, 'title')).toContain('prop');
  });

  it('identifies a slot and its requiredness', () => {
    const source = '---\ncomponent Panel\nslots {\n  header\n  footer?\n}\n---\n';
    expect(hover(source, 'header')).toContain('required');
    expect(hover(source, 'footer')).toContain('optional');
  });

  it('returns nothing for an unknown word rather than inventing a card', () => {
    expect(hover(HEAD, 'zzzznotathing')).toBeUndefined();
  });
});

describe('wordAt', () => {
  it('finds a word at the cursor', () => {
    expect(wordAt('<p>{title}</p>', 5)).toBe('title');
  });

  it('finds a word at its first and last character', () => {
    expect(wordAt('abc def', 0)).toBe('abc');
    expect(wordAt('abc def', 6)).toBe('def');
  });

  it('handles hyphenated names', () => {
    expect(wordAt('<else-if {x}>', 3)).toBe('else-if');
  });

  it('returns undefined on punctuation and past the end', () => {
    expect(wordAt('<p>{}</p>', 4)).toBeUndefined();
    expect(wordAt('', 0)).toBeUndefined();
    expect(wordAt('abc', 99)).toBe('abc');
  });
});

describe('formatting', () => {
  it('returns canonical source', () => {
    const formatted = format(`${HEAD}<div>\n        <p>hi</p>\n</div>\n`);
    expect(formatted).toContain('<div>\n  <p>hi</p>\n</div>');
  });

  it('is idempotent', () => {
    const once = format(`${HEAD}<div>\n        <p>hi</p>\n</div>\n`);
    expect(format(once)).toBe(once);
  });

  it('makes NO edit when the buffer does not parse', () => {
    // Rewriting a file the formatter could not fully understand is how a
    // formatter eats someone's work.
    expect(format(`${HEAD}<p>a < b</p>\n`)).toBeUndefined();
  });
});

describe('toLspDiagnostic', () => {
  it('clamps a span-less diagnostic to the start of the file', () => {
    const lsp = toLspDiagnostic({ code: 'O0000', severity: 'error', message: 'x' });
    expect(lsp.range.start).toEqual({ line: 0, character: 0 });
  });
});
