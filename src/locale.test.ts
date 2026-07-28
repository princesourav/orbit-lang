import { describe, expect, it } from 'vitest';
import { render } from './interpreter';
import { compileOk, HOST_FILTERS } from './test-host.helper';
import { DEFAULT_LOCALE, type LocaleData } from './stdlib';

/**
 * Locale-data injection for `formatDate`.
 *
 * The engine has no clock, no timezone database and no CLDR data, and it is not
 * going to acquire any: all three would make output depend on the host's
 * environment and break the determinism guarantee. What it has instead is a
 * seam — the host supplies month names, and the same program plus the same
 * locale data produces the same bytes anywhere.
 *
 * These tests pin the seam and, just as importantly, pin what it does NOT do,
 * because the limitation is documented in the filter reference and needs to
 * stay true.
 */

const FRENCH: LocaleData = {
  months: [
    'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
  ],
  monthsShort: ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'],
};

/**
 * Rendered through a COMPONENT entry with a prop, rather than a page global —
 * the shared test host declares only `collection`, and a date fixture has no
 * business being added to it.
 */
function renderWith(pattern: string, iso: string, locale?: LocaleData) {
  const program = compileOk([
    {
      name: 'date.orbit',
      source:
        '---\ncomponent DateLine\nprops {\n  stamp: String\n}\n---\n' +
        `<p>{stamp |> formatDate(${JSON.stringify(pattern)})}</p>\n`,
    },
  ]);
  const result = render(program, 'DateLine', {
    hostFilters: HOST_FILTERS,
    props: { stamp: iso },
    ...(locale === undefined ? {} : { locale }),
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.html;
}

describe('formatDate locale injection', () => {
  it('defaults to English month names', () => {
    expect(renderWith('MMMM', '2026-07-28T10:30:00Z')).toBe('<p>July</p>');
    expect(renderWith('MMM', '2026-07-28T10:30:00Z')).toBe('<p>Jul</p>');
  });

  it('uses host-supplied month names when given', () => {
    expect(renderWith('MMMM', '2026-07-28T10:30:00Z', FRENCH)).toBe('<p>juillet</p>');
    expect(renderWith('MMM', '2026-01-15T00:00:00Z', FRENCH)).toBe('<p>janv</p>');
  });

  it('keeps numeric tokens locale-independent', () => {
    // Only month NAMES are localized. Digits are digits, and making them
    // locale-dependent would mean carrying numbering-system data.
    for (const locale of [undefined, FRENCH]) {
      expect(renderWith('YYYY-MM-DD', '2026-07-28T10:30:00Z', locale)).toBe('<p>2026-07-28</p>');
    }
  });

  it('is deterministic: same program, same locale, same bytes', () => {
    const once = renderWith('MMMM D, YYYY', '2026-07-28T10:30:00Z', FRENCH);
    const twice = renderWith('MMMM D, YYYY', '2026-07-28T10:30:00Z', FRENCH);
    expect(twice).toBe(once);
  });

  it('does not leak locale between renders', () => {
    // The interpreter is stateless; a render with injected data must not
    // affect the next one.
    renderWith('MMMM', '2026-07-28T10:30:00Z', FRENCH);
    expect(renderWith('MMMM', '2026-07-28T10:30:00Z')).toBe('<p>July</p>');
  });

  it('exposes the default locale so a host can extend rather than replace it', () => {
    expect(DEFAULT_LOCALE.months).toHaveLength(12);
    expect(DEFAULT_LOCALE.monthsShort).toHaveLength(12);
    const partial: LocaleData = { ...DEFAULT_LOCALE, months: FRENCH.months };
    expect(renderWith('MMMM MMM', '2026-07-28T10:30:00Z', partial)).toBe('<p>juillet Jul</p>');
  });
});

describe('what locale injection deliberately does NOT do', () => {
  it('applies no timezone conversion', () => {
    // Documented in docs/reference/filters.md. The engine has no timezone
    // database and no clock; a host that needs a viewer's local time converts
    // before binding. Formatting the value as given is the only behaviour that
    // can be deterministic.
    const utc = renderWith('HH:mm', '2026-07-28T10:30:00Z');
    const offset = renderWith('HH:mm', '2026-07-28T10:30:00+05:30');
    expect(utc).toBe('<p>10:30</p>');
    expect(offset).toBe('<p>10:30</p>');
  });

  it('falls back to the month number when locale data is short', () => {
    const broken: LocaleData = { months: ['Jan'], monthsShort: ['Jan'] };
    // Rather than throwing or emitting "undefined", the number is used.
    expect(renderWith('MMMM', '2026-07-28T10:30:00Z', broken)).toBe('<p>7</p>');
  });
});
