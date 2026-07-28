import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { formatTemplate } from './formatter';
import { parseTemplate } from './parser';
import { render } from './interpreter';
import { customPropertyValueOk, isCustomPropertyName } from './escape';
import { t, type Type } from './types';
import { cardSource, compile, compileOk, HOST_FILTERS, pageSource } from './test-host.helper';

/**
 * The typed custom-property sink — `--accent={settings.accent}`.
 *
 * Phase D found 14 blocks carrying a merchant `Color` setting with nowhere to
 * go: interpolated `style` is banned and should be, `Color` is unbounded so it
 * cannot become a class, and CSS cannot read a data attribute as a colour.
 *
 * This is the narrowest mechanism that closes them. Design and the full
 * argument: docs/design/custom-properties.md.
 */

const SETTINGS = 'settings {\n  accent: Color = #1a73e8 label "Accent"\n  label: Text = "hi" label "Label"\n}\n';

function errors(body: string, frontmatter = SETTINGS) {
  return compile([cardSource(body, frontmatter)]).result.diagnostics.filter(
    (d) => d.severity === 'error',
  );
}

function firstParseError(body: string) {
  const source = `---\ncomponent Card\nprops {\n  product: Product\n}\n${SETTINGS}---\n${body}`;
  const result = parseTemplate(source, 'card.orbit');
  return result.ok ? undefined : result.diagnostics[0];
}

function renderBody(body: string, settings: Record<string, unknown> = { accent: '#1a73e8' }) {
  const program = compileOk([pageSource(body, SETTINGS)]);
  return render(program, 'collection', {
    hostFilters: HOST_FILTERS,
    bindings: { collection: { title: 'c', products: [] } },
    settings: { collection: { label: 'hi', ...settings } },
  });
}

function htmlOf(body: string, settings?: Record<string, unknown>) {
  const out = renderBody(body, settings);
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  return out.html;
}

describe('the surface form', () => {
  it('emits a Color setting as a CSS custom property', () => {
    expect(htmlOf('<div --accent={settings.accent}>x</div>')).toBe(
      '<div style="--accent:#1a73e8">x</div>',
    );
  });

  it('emits several properties as one style attribute, in written order', () => {
    // Two `style` attributes on one element is a document browsers resolve by
    // keeping the first, silently dropping the second declaration.
    const html = htmlOf(
      '<div --b={settings.accent} --a={settings.accent}>x</div>',
    );
    expect(html).toBe('<div style="--b:#1a73e8;--a:#1a73e8">x</div>');
    expect(html.split('style=').length - 1).toBe(1);
  });

  it('merges with a static style attribute, static half first', () => {
    const html = htmlOf('<div style="display:grid" --accent={settings.accent}>x</div>');
    expect(html).toBe('<div style="display:grid;--accent:#1a73e8">x</div>');
  });

  it('does not double the separator when the static half ends with one', () => {
    expect(htmlOf('<div style="display:grid; " --accent={settings.accent}>x</div>')).toBe(
      '<div style="display:grid;--accent:#1a73e8">x</div>',
    );
  });

  it('leaves a static style attribute alone when there are no properties', () => {
    expect(htmlOf('<div style="display:grid">x</div>')).toBe('<div style="display:grid">x</div>');
  });

  it('is not confusable with an attribute: no attribute may begin with a hyphen', () => {
    // The allowlist is closed and its only open families are data-* and aria-*,
    // so `--accent` cannot collide with an attribute that exists, one that
    // could be added, or one the allowlist would ever admit.
    expect(firstParseError('<div -accent={settings.accent}>x</div>')?.code).toBe('O1113');
  });
});

describe('what cannot reach the sink', () => {
  it('rejects a String, which has no lexical form to enumerate', () => {
    const [e] = errors('<div --accent={settings.label}>x</div>');
    expect(e?.code).toBe('O2115');
    expect(e?.message).toContain('Color');
  });

  it('names the type it found, so the message is actionable', () => {
    const [e] = errors('<div --accent={product.title}>x</div>');
    expect(e?.code).toBe('O2115');
    expect(e?.message).toContain('String');
  });

  it('rejects an interpolated property name at parse time', () => {
    // A dynamic property name is a new injection surface for the same reason a
    // dynamic attribute name would be.
    expect(firstParseError('<div --{settings.label}={settings.accent}>x</div>')?.code).toBe('O1113');
  });

  it('rejects a bare or quoted value: a static property belongs in the stylesheet', () => {
    expect(firstParseError('<div --accent>x</div>')?.code).toBe('O1113');
    expect(firstParseError('<div --accent="#fff">x</div>')?.code).toBe('O1113');
  });

  it('rejects an empty property name', () => {
    expect(firstParseError('<div --={settings.accent}>x</div>')?.code).toBe('O1113');
  });

  it('does NOT loosen O1095: interpolated style is still a parse error', () => {
    // The carve-out is exactly this one form and nothing wider. `style="{x}"`
    // puts an arbitrary string in a CSS DECLARATION position, where it can
    // close the declaration and open another.
    expect(firstParseError('<div style="color: {settings.accent}">x</div>')?.code).toBe('O1095');
    expect(firstParseError('<div style={settings.accent}>x</div>')?.code).toBe('O1095');
  });
});

describe('the admitted set is closed, not merely small', () => {
  /**
   * Driven from the exhaustive list of type KINDS rather than a hand-picked
   * sample.
   *
   * A sample proves the sampled types are rejected. It does not prove the set
   * is closed, and it silently stops covering the language the day someone adds
   * a type. This fails when a new kind appears, until somebody decides in
   * writing which side of the line it is on.
   */
  const ALL_KINDS: ReadonlyArray<[string, Type]> = [
    ['int', t.int()],
    ['float', t.float()],
    ['string', t.string()],
    ['bool', t.bool()],
    ['color', t.color()],
    ['none', t.none()],
    ['invalid', t.invalid()],
    ['optional', t.optional(t.color())],
    ['list', t.list(t.color())],
    ['record', t.record({ a: t.color() })],
    ['union', t.union('a', 'b')],
    ['range', t.range()],
    ['object', t.object('Product')],
    ['opaque', t.opaque('Money')],
    ['html', t.html()],
  ];

  /** The v1 allow list, and the one place it is written down in a test. */
  const ADMITTED = new Set(['color']);

  it('enumerates every kind in the Type union', () => {
    // If `Type` grows a member and this list does not, the next assertion is
    // no longer exhaustive and would pass while covering less.
    const kinds = new Set(ALL_KINDS.map(([, type]) => type.kind));
    expect(kinds).toEqual(
      new Set([
        'int', 'float', 'string', 'bool', 'color', 'none', 'invalid',
        'optional', 'list', 'record', 'union', 'range', 'object', 'opaque', 'html',
      ]),
    );
  });

  it('admits exactly the allowed kinds and rejects every other one', () => {
    // Each kind is put through a real prop of that type, checked for real.
    for (const [name, type] of ALL_KINDS) {
      if (type.kind === 'invalid' || type.kind === 'none') continue; // not declarable
      const declared = typeDeclarationFor(type);
      if (declared === undefined) continue;
      const found = compile([
        {
          name: 'components/probe.orbit',
          source:
            `---\ncomponent Probe\nprops {\n  v: ${declared}\n}\n---\n` +
            '<div --accent={v}>x</div>\n',
        },
      ]).result.diagnostics.filter((d) => d.severity === 'error');

      const shouldAdmit = ADMITTED.has(type.kind);
      if (shouldAdmit) {
        expect(found, `${name} should be admitted`).toEqual([]);
        continue;
      }
      // Rejected is the property. WHICH diagnostic depends on how the type
      // fails: `Color?` trips the optional law first, and that message is more
      // useful than a generic "wrong type for this sink" would be.
      expect(found.length, `${name} should be rejected`).toBeGreaterThan(0);
      expect(
        found.some((d) => d.code === 'O2115' || d.code === 'O2104'),
        `${name} rejected for the wrong reason: ${found.map((d) => d.code).join(',')}`,
      ).toBe(true);
    }
  });

  /** How a kind is spelled in a `props` block, or undefined if it cannot be. */
  function typeDeclarationFor(type: Type): string | undefined {
    switch (type.kind) {
      case 'int':
        return 'Int';
      case 'float':
        return 'Float';
      case 'string':
        return 'String';
      case 'bool':
        return 'Bool';
      case 'color':
        return 'Color';
      case 'optional':
        return 'Color?';
      case 'list':
        return 'List<Color>';
      case 'object':
        return 'Product';
      case 'opaque':
        return 'Money';
      case 'html':
        return 'Html';
      default:
        // record / union / range are not spellable as a prop declaration; they
        // are covered by the settings and expression paths instead.
        return undefined;
    }
  }

  it('rejects a union, which is a String-shaped type the sink must not admit', () => {
    // Reachable via a Select setting rather than a prop declaration, and worth
    // its own case: a union widens to String, so a sink that tested
    // "assignable to String" instead of "kind is color" would let it through.
    const frontmatter = 'settings {\n  tone: Select("a", "b") = "a"\n}\n';
    const [e] = errors('<div --accent={settings.tone}>x</div>', frontmatter);
    expect(e?.code).toBe('O2115');
  });
});

describe('the value is validated AT THE SINK, not trusted from the type', () => {
  /**
   * `isHexColorLiteral` guards merchant settings and component-entry props, but
   * a `Color` arriving as a page binding or as a field of a host object reaches
   * a sink unvalidated. A sink that trusted the declared type would inherit
   * that hole — so it revalidates, exactly as the URL sink does.
   */
  const HOSTILE = [
    'red; --x:evil',
    '#0a0a0a; background:url(javascript:alert(1))',
    '#fff',
    '#zzzzzz',
    'red',
    '#0a0a0a"',
    '#0a0a0a}</style><script>alert(1)</script>',
    'var(--other)',
    'expression(alert(1))',
    '',
    '#0a0a0a\n',
  ];

  it('never emits a malformed merchant setting, because it falls back first', () => {
    // Settings are already guarded: an invalid value is replaced by the
    // declared default and reported as O4901. So this path never reaches the
    // sink with bad bytes — asserted so that if the fallback is ever removed,
    // the failure shows up here rather than as CSS on a page.
    for (const bad of HOSTILE) {
      const out = renderBody('<div --accent={settings.accent}>x</div>', { accent: bad });
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect(out.html).toBe('<div style="--accent:#1a73e8">x</div>');
    }
  });

  it('fails on a Color reaching the sink through the path nothing else guards', () => {
    // Component-entry props are shape-validated (O4038) and settings fall back.
    // A `Color` arriving as a FIELD OF A HOST OBJECT is validated nowhere
    // upstream — the hole J0c found, and the reason this sink revalidates
    // instead of trusting the declared type.
    const program = compileOk([pageSource('<div --accent={banner.tint}>x</div>')]);
    for (const bad of HOSTILE) {
      const out = render(program, 'collection', {
        hostFilters: HOST_FILTERS,
        bindings: {
          collection: { title: 'c', products: [] },
          banner: { style: 'info', text: 't', tint: bad },
        },
      });
      expect(out.ok, `should reject ${JSON.stringify(bad)}`).toBe(false);
      if (out.ok) continue;
      expect(out.error.code).toBe('O4044');
    }
  });

  it('accepts every well-formed Color, in either case', () => {
    const program = compileOk([
      {
        name: 'components/probe.orbit',
        source: '---\ncomponent Probe\nprops {\n  c: Color\n}\n---\n<div --accent={c}>x</div>\n',
      },
    ]);
    for (const good of ['#000000', '#ffffff', '#FFFFFF', '#1a73e8', '#AbCdEf']) {
      const out = render(program, 'Probe', { hostFilters: HOST_FILTERS, props: { c: good } });
      expect(out.ok, good).toBe(true);
      if (out.ok) expect(out.html).toBe(`<div style="--accent:${good}">x</div>`);
    }
  });
});

describe('property: nothing through this sink can escape the declaration', () => {
  /**
   * The test that would have caught the v0.1 hollow validator, which accepted
   * any seven-character string beginning with `#`.
   *
   * Generators deliberately include values that WOULD break out if the
   * validator were soft — `#";x:y`, `#}</sty`, `#a:b;c:` are all seven
   * characters starting with `#`.
   */
  // Through the host-object path: the one route to the sink with no upstream
  // validation, so the property measures the sink and not a guard above it.
  const program = compileOk([pageSource('<div --accent={banner.tint}>x</div>')]);

  const renderWith = (tint: string) =>
    render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: {
        collection: { title: 'c', products: [] },
        banner: { style: 'info', text: 't', tint },
      },
    });

  it('emits nothing that closes the declaration, the attribute or the element', () => {
    const sevenCharHash = fc
      .stringMatching(/^[ -~]{6}$/)
      .map((rest) => `#${rest}`);
    const anyString = fc.string({ maxLength: 24 });

    fc.assert(
      fc.property(fc.oneof(sevenCharHash, anyString), (value) => {
        const out = renderWith(value);
        if (!out.ok) {
          expect(out.error.code).toBe('O4044');
          return;
        }
        // If it rendered, the value was a real colour and the output is exactly
        // the one declaration — no second declaration, no attribute breakout,
        // no tag.
        expect(out.html).toBe(`<div style="--accent:${value}">x</div>`);
        expect(customPropertyValueOk(value)).toBe(true);
        for (const forbidden of [';', '"', "'", '<', '>', '(', ')', '\\', '/', ':', '}', '{']) {
          expect(value.includes(forbidden)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('the validator itself admits exactly #rrggbb', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (s) => {
        const ok = customPropertyValueOk(s);
        const shouldBe =
          s.length === 7 &&
          s[0] === '#' &&
          [...s.slice(1)].every((ch) => '0123456789abcdefABCDEF'.includes(ch));
        expect(ok).toBe(shouldBe);
      }),
      { numRuns: 500 },
    );
  });

  it('the name validator admits only CSS idents after `--`', () => {
    expect(isCustomPropertyName('--a')).toBe(true);
    expect(isCustomPropertyName('--brand-accent_2')).toBe(true);
    expect(isCustomPropertyName('--')).toBe(false);
    expect(isCustomPropertyName('-a')).toBe(false);
    expect(isCustomPropertyName('accent')).toBe(false);
    for (const bad of ['--a;b', '--a:b', '--a b', '--a"', '--a}', '--a(']) {
      expect(isCustomPropertyName(bad), bad).toBe(false);
    }
  });
});

describe('the formatter', () => {
  it('round-trips a custom property', () => {
    const source =
      `---\norbit 2026\ncomponent Card\n${SETTINGS}---\n<div --accent={settings.accent}>x</div>\n`;
    const parsed = parseTemplate(source, 'card.orbit');
    if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.code);
    expect(formatTemplate(parsed.template)).toBe(source);
  });

  it('keeps several properties in written order rather than sorting them', () => {
    const source =
      `---\norbit 2026\ncomponent Card\n${SETTINGS}---\n<div --z={settings.accent} --a={settings.accent}>x</div>\n`;
    const parsed = parseTemplate(source, 'card.orbit');
    if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.code);
    expect(formatTemplate(parsed.template)).toContain('--z={settings.accent} --a={settings.accent}');
  });
});
