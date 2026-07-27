/**
 * Property-based URL-sink safety.
 *
 * The URL attribute table is the one place where a data value is emitted into
 * a position the browser will *dereference*. Escaping is not enough there: a
 * perfectly-escaped `javascript:alert(1)` is still a perfectly-working XSS.
 * So the sink applies a closed SCHEME ALLOWLIST, and the claim is universal —
 * "for any string whatsoever, the value that lands in href/src/action/... is
 * either the neutral placeholder or a URL whose scheme is allowed".
 *
 * The oracle is written FRESH here rather than by calling `sanitizeUrl`,
 * because an oracle that shares an implementation with the thing it checks
 * proves only that the implementation equals itself. It re-derives the scheme
 * the way a browser would: strip C0 controls and DEL (which is what defeats a
 * tab-split `java<TAB>script:`), trim, then read up to the first `:` that
 * precedes any `/`, `?` or `#`.
 *
 * Generation is biased toward obfuscation — control-character splits, mixed
 * case, leading whitespace, protocol-relative prefixes, `data:` variants —
 * because uniformly random strings essentially never produce a scheme at all.
 * Control characters are built with `String.fromCharCode` rather than written
 * as literals so this file stays readable in every editor and diff tool.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { URL_ATTRS } from './allowlists';
import { sanitizeUrl } from './escape';
import { render } from './interpreter';
import { type SourceFile } from './parser';
import { compileOk } from './test-host.helper';

// ---------------------------------------------------------------------------
// Hostile URL generation
// ---------------------------------------------------------------------------

const ch = (code: number): string => String.fromCharCode(code);

/** C0 controls + DEL: exactly the bytes a URL parser drops before scheming. */
const CONTROL_CHARS: readonly string[] = [
  0x00, 0x01, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1f, 0x7f,
].map(ch);

const NUL = ch(0x00);
const TAB = ch(0x09);
const LF = ch(0x0a);
const CR = ch(0x0d);

const DANGEROUS_SCHEMES = [
  'javascript',
  'JaVaScRiPt',
  'JAVASCRIPT',
  'vbscript',
  'data',
  'file',
  'blob',
  'view-source',
];

const KNOWN_PAYLOADS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  '  javascript:alert(1)',
  `java${TAB}script:alert(1)`,
  `java${LF}script:alert(1)`,
  `java${CR}script:alert(1)`,
  `java${NUL}script:alert(1)`,
  `${TAB}javascript:alert(1)`,
  'data:text/html,<script>alert(1)</script>',
  'data:text/html;base64,PHNjcmlwdD4=',
  'data:image/svg+xml,<svg onload=alert(1)>',
  'data:image/png;base64,iVBORw0KGgo=',
  '//evil.example/x',
  ' //evil.example/x',
  `${NUL}//evil.example`,
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'view-source:https://example.com',
  'blob:https://example.com/uuid',
  'https://example.com/ok?a=1#b',
  'mailto:a@example.com',
  'tel:+15551234',
  '/relative/path',
  './rel',
  '../up',
  '#anchor',
  '?q=1',
  'plainpath',
  '',
  '   ',
  'a.jpg 1x, javascript:alert(1) 2x',
  'a.jpg 1x, b.jpg 2x',
];

/** Splice control characters into a scheme name: the classic filter bypass. */
const obfuscatedScheme = fc
  .tuple(
    fc.constantFrom(...DANGEROUS_SCHEMES),
    fc.array(fc.constantFrom(...CONTROL_CHARS), { minLength: 1, maxLength: 4 }),
    fc.constantFrom('alert(1)', 'msgbox(1)', 'text/html,<b>', 'image/png;base64,AAA'),
  )
  .map(([scheme, noise, tail]) => {
    let out = '';
    for (let i = 0; i < scheme.length; i += 1) {
      out += scheme[i] ?? '';
      const inject = noise[i % noise.length];
      if (inject !== undefined && i % 2 === 0) out += inject;
    }
    return `${out}:${tail}`;
  });

const URL_ALPHABET: readonly string[] = [
  ...CONTROL_CHARS,
  ':',
  '/',
  '.',
  ',',
  ';',
  '<',
  '>',
  '"',
  'j',
  'a',
  'v',
  's',
  'c',
  'r',
  'i',
  'p',
  't',
  'd',
  'h',
];

const hostileUrl = fc.oneof(
  { arbitrary: fc.constantFrom(...KNOWN_PAYLOADS), weight: 4 },
  { arbitrary: obfuscatedScheme, weight: 4 },
  { arbitrary: fc.string({ unit: fc.constantFrom(...URL_ALPHABET), maxLength: 30 }), weight: 3 },
  { arbitrary: fc.string({ maxLength: 40 }), weight: 2 },
  { arbitrary: fc.webUrl(), weight: 1 },
);

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

const SAFE_SCHEMES = ['http', 'https', 'mailto', 'tel'];

function stripControls(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue;
    out += s[i] ?? '';
  }
  return out;
}

/**
 * The scheme a BROWSER would act on, not the one the string appears to have.
 * `undefined` means "no scheme" — a relative reference, which is inert.
 */
function effectiveScheme(value: string): string | undefined {
  const s = stripControls(value).trim();
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '/' || c === '?' || c === '#') return undefined;
    if (c === ':') return s.slice(0, i).toLowerCase();
  }
  return undefined;
}

function assertInertUrl(value: string, attrName: string): void {
  // Whatever survived must be free of the control characters that let an
  // attacker re-form a scheme inside the browser's own parser.
  expect(stripControls(value)).toBe(value);
  // Protocol-relative URLs inherit the page scheme and point off-origin.
  expect(value.startsWith('//')).toBe(false);
  const scheme = effectiveScheme(value);
  if (scheme === undefined) return; // relative reference: inert
  if (scheme === 'data') {
    // `data:` survives in exactly one place: an image in `src`.
    expect(attrName).toBe('src');
    expect(value.toLowerCase().startsWith('data:image/')).toBe(true);
    return;
  }
  expect(SAFE_SCHEMES).toContain(scheme);
}

// ---------------------------------------------------------------------------
// The sink function, in isolation
// ---------------------------------------------------------------------------

describe('sanitizeUrl: scheme allowlist holds for every input', () => {
  const attrNames = [...URL_ATTRS].filter((n) => n !== 'srcset');

  it('accepts nothing whose effective scheme is outside the allowlist', () => {
    fc.assert(
      fc.property(hostileUrl, fc.constantFrom(...attrNames), (raw, attr) => {
        const checked = sanitizeUrl(raw, attr);
        if (checked.ok) assertInertUrl(checked.url, attr);
        else expect(typeof checked.reason).toBe('string');
      }),
      { numRuns: 600 },
    );
  });

  it('is idempotent: re-sanitizing an accepted URL yields the same URL', () => {
    // A sink that changed its answer on a second pass would mean the emitted
    // value is not a fixed point, i.e. the "sanitized" form is still parseable
    // into something else.
    fc.assert(
      fc.property(hostileUrl, fc.constantFrom(...attrNames), (raw, attr) => {
        const once = sanitizeUrl(raw, attr);
        if (!once.ok) return;
        const twice = sanitizeUrl(once.url, attr);
        expect(twice.ok).toBe(true);
        if (twice.ok) expect(twice.url).toBe(once.url);
      }),
      { numRuns: 400 },
    );
  });

  it('never lets `data:` through outside `src`', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('data', 'DATA', 'DaTa'),
        fc.constantFrom('image/png;base64,AAA', 'text/html,<b>', 'image/svg+xml,<svg>'),
        fc.constantFrom(...attrNames.filter((n) => n !== 'src')),
        (scheme, tail, attr) => {
          expect(sanitizeUrl(`${scheme}:${tail}`, attr).ok).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the value that actually reaches the document
// ---------------------------------------------------------------------------

interface UrlCase {
  attr: string;
  source: string;
  /** What `urlPolicy: 'placeholder'` emits when the value is refused. */
  placeholder: string;
}

const URL_CASES: readonly UrlCase[] = [
  { attr: 'href', source: '<a href={u}>x</a>', placeholder: '#' },
  { attr: 'src', source: '<img src={u} alt="a">', placeholder: '#' },
  { attr: 'poster', source: '<video poster={u}></video>', placeholder: '#' },
  { attr: 'cite', source: '<blockquote cite={u}>x</blockquote>', placeholder: '#' },
  { attr: 'action', source: '<form action={u}></form>', placeholder: '#' },
  { attr: 'formaction', source: '<button formaction={u}>x</button>', placeholder: '#' },
  { attr: 'srcset', source: '<img srcset={u} alt="a">', placeholder: '' },
];

/** Every URL attribute in the closed table is covered by a case above. */
it('covers the whole URL-attribute table', () => {
  expect(new Set(URL_CASES.map((c) => c.attr))).toEqual(new Set(URL_ATTRS));
});

function componentFor(c: UrlCase): SourceFile {
  return {
    name: `components/url-${c.attr}.orbit`,
    source: `---\ncomponent UrlCase\nprops {\n  u: String\n}\n---\n${c.source}`,
  };
}

const DECODE: ReadonlyArray<readonly [string, string]> = [
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
];

function decodeAttr(s: string): string {
  let out = '';
  let i = 0;
  outer: while (i < s.length) {
    if (s[i] === '&') {
      for (const [entity, replacement] of DECODE) {
        if (s.startsWith(entity, i)) {
          out += replacement;
          i += entity.length;
          continue outer;
        }
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/**
 * Pull `name="…"` out of the rendered markup. Unambiguous because the sink
 * escapes `"` to `&quot;`, so the first raw quote after the opener is the
 * closer — a fact the companion escaping suite proves independently.
 */
function attrValue(html: string, name: string): string {
  const opener = ` ${name}="`;
  const start = html.indexOf(opener);
  expect(start).toBeGreaterThanOrEqual(0);
  const from = start + opener.length;
  const end = html.indexOf('"', from);
  expect(end).toBeGreaterThanOrEqual(0);
  return decodeAttr(html.slice(from, end));
}

/**
 * Split a rendered srcset back into its candidate URLs.
 *
 * NOT a naive split on `,`: a URL may legally contain commas, and WHATWG
 * srcset tokenization takes a run of non-whitespace as the URL — so
 * `http://a/,//b` is ONE candidate to a browser, not two. The sink
 * re-serializes canonically as `url desc, url desc` with each URL guaranteed
 * whitespace-free, so splitting on the comma-space joiner is exact.
 */
function srcsetUrls(value: string): string[] {
  const out: string[] = [];
  for (const candidate of value.split(', ')) {
    const trimmed = candidate.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    out.push(space === -1 ? trimmed : trimmed.slice(0, space));
  }
  return out;
}

describe('render: every URL attribute is inert for arbitrary data', () => {
  for (const testCase of URL_CASES) {
    const program = compileOk([componentFor(testCase)]);

    it(`${testCase.attr}: emits the placeholder or an allowlisted scheme`, () => {
      fc.assert(
        fc.property(hostileUrl, (u) => {
          const result = render(program, 'UrlCase', { props: { u } });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const value = attrValue(result.html, testCase.attr);
          if (value === testCase.placeholder) return; // refused, neutralized
          if (testCase.attr === 'srcset') {
            for (const url of srcsetUrls(value)) assertInertUrl(url, 'src');
            return;
          }
          assertInertUrl(value, testCase.attr);
        }),
        { numRuns: 450 },
      );
    });

    it(`${testCase.attr}: a refusal is always reported as a warning`, () => {
      // Silent neutralization is a support nightmare — a merchant whose data
      // is wrong must be able to see that the engine dropped it.
      fc.assert(
        fc.property(hostileUrl, (u) => {
          const result = render(program, 'UrlCase', { props: { u } });
          if (!result.ok) return;
          const accepted =
            testCase.attr === 'srcset' ? sanitizeUrl(u, 'src').ok : sanitizeUrl(u, testCase.attr).ok;
          if (accepted) return; // nothing to report
          expect(result.warnings.some((w) => w.code === 'O4900')).toBe(true);
        }),
        { numRuns: 200 },
      );
    });

    it(`${testCase.attr}: urlPolicy 'error' fails closed instead of emitting`, () => {
      fc.assert(
        fc.property(hostileUrl, (u) => {
          const strict = render(program, 'UrlCase', { props: { u }, urlPolicy: 'error' });
          if (strict.ok) {
            // Succeeded, so the value was accepted: it must still be inert.
            const value = attrValue(strict.html, testCase.attr);
            if (testCase.attr === 'srcset') {
              for (const url of srcsetUrls(value)) assertInertUrl(url, 'src');
            } else if (value !== testCase.placeholder) {
              assertInertUrl(value, testCase.attr);
            }
            return;
          }
          expect(strict.error.code).toBe('O4037');
        }),
        { numRuns: 200 },
      );
    });
  }
});

describe('render: interpolated URL parts cannot smuggle a scheme', () => {
  // A URL built by CONCATENATION is the interesting case: the template writes
  // a safe-looking prefix and the data supplies the rest. The sink sees the
  // joined string, so the guarantee must survive the join.
  const program = compileOk([
    {
      name: 'components/urlparts.orbit',
      source:
        '---\ncomponent UrlParts\nprops {\n  u: String\n}\n---\n<a href="/go?to={u}">x</a><a href="{u}/tail">y</a>',
    },
  ]);

  it('holds for both a leading and a trailing data segment', () => {
    fc.assert(
      fc.property(hostileUrl, (u) => {
        const result = render(program, 'UrlParts', { props: { u } });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        let searchFrom = 0;
        for (let n = 0; n < 2; n += 1) {
          const opener = ' href="';
          const start = result.html.indexOf(opener, searchFrom);
          expect(start).toBeGreaterThanOrEqual(0);
          const from = start + opener.length;
          const end = result.html.indexOf('"', from);
          const value = decodeAttr(result.html.slice(from, end));
          searchFrom = end;
          if (value === '#') continue;
          assertInertUrl(value, 'href');
        }
      }),
      { numRuns: 300 },
    );
  });
});
