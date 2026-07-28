import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFragment } from 'parse5';

/**
 * Differential testing against a real WHATWG HTML parser.
 *
 * The conformance corpus captures its expected output from this
 * implementation, which is the standard bootstrapping problem for a first
 * conformance suite: it proves the engine is self-consistent, not that it is
 * right. A suite that only checks an implementation against itself will happily
 * enshrine a bug.
 *
 * This closes that gap with an oracle this project did not write. Every
 * escaping case is rendered, then fed to parse5 — the parser Node's ecosystem
 * uses, implementing the WHATWG tree-construction algorithm — and the resulting
 * DOM is checked against what the escaping rules PROMISE:
 *
 *   * a value interpolated into text must survive as text, not become markup;
 *   * a value interpolated into an attribute must read back byte-identical;
 *   * no payload may introduce an element the template did not write;
 *   * a URL sink must never yield a javascript:, data:(non-image) or
 *     protocol-relative URL, whatever the input.
 *
 * If Orbit's escaper and a real browser parser ever disagree about what a
 * rendered page means, this fails — which is precisely the class of bug
 * (context confusion) that autoescaping is supposed to prevent and that
 * repeatedly escapes hand-written test suites.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(HERE, 'cases');

function loadCategory(name) {
  const file = path.join(CASES_DIR, `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).cases;
}

const CATEGORIES = readdirSync(CASES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => path.basename(f, '.json'));

/** Every element name appearing anywhere in a parsed fragment. */
function elementNames(node, out = new Set()) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) out.add(child.tagName);
    elementNames(child, out);
    if (child.content) elementNames(child.content, out);
  }
  return out;
}

/** Concatenated text content of a parsed fragment. */
function textOf(node, parts = []) {
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text') parts.push(child.value);
    textOf(child, parts);
  }
  return parts.join('');
}

/** Find the first element with the given tag name. */
function findElement(node, tagName) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName === tagName) return child;
    const nested = findElement(child, tagName);
    if (nested) return nested;
  }
  return undefined;
}

function attrOf(element, name) {
  return element?.attrs?.find((a) => a.name === name)?.value;
}

/** The payload a case bound into `data.text`. */
function payloadOf(testCase) {
  return testCase.bindings?.data?.text;
}

/** U+0000, named so it is visible in this source rather than an invisible byte. */
const NUL_CHAR = String.fromCharCode(0);

/**
 * Compare payloads with U+0000 removed from both sides.
 *
 * Orbit emits a NUL faithfully; the WHATWG parser does not keep it, and what it
 * does instead **depends on the context**: in body character data a NUL token is
 * a parse error and is IGNORED, while in an attribute value it is REPLACED with
 * U+FFFD. Re-implementing that table here in order to "normalize" properly
 * would mean this suite carrying its own copy of the HTML spec — the exact
 * duplication an external oracle exists to avoid.
 *
 * So NUL is excluded from the equality comparison and given its own explicit
 * test below, which pins the divergence per context rather than hiding it. It is
 * a fidelity difference, not a security one: a NUL cannot terminate an
 * attribute, close an element or open a tag, and every structural assertion in
 * this file still holds with the NUL payloads included.
 */
function withoutNul(text) {
  if (text === undefined) return undefined;
  // Both characters are dropped, from both sides, because the parser's choice
  // between them is the context-dependent part: body text loses the NUL
  // entirely, an attribute value and RCDATA get U+FFFD in its place. No payload
  // in the corpus contains a genuine U+FFFD, so nothing real is masked.
  return text.split(NUL_CHAR).join('').split('�').join('');
}

const DANGEROUS_ELEMENTS = ['script', 'iframe', 'object', 'embed', 'style', 'svg', 'math'];

describe('the corpus is well formed', () => {
  it('covers every category the manifest lists', () => {
    const manifest = JSON.parse(readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
    expect(manifest.categories.map((c) => c.name).sort()).toEqual([...CATEGORIES].sort());
    const total = CATEGORIES.reduce((n, c) => n + loadCategory(c).length, 0);
    expect(total).toBe(manifest.totalCases);
  });

  it('is large enough to be meaningful', () => {
    const total = CATEGORIES.reduce((n, c) => n + loadCategory(c).length, 0);
    expect(total).toBeGreaterThanOrEqual(500);
  });

  it('gives every case a concrete expectation', () => {
    for (const category of CATEGORIES) {
      for (const testCase of loadCategory(category)) {
        expect(testCase.expect, `${testCase.id} has no expectation`).toBeDefined();
        expect(['html', 'parse-error', 'check-error', 'render-error']).toContain(
          testCase.expect.kind,
        );
        if (testCase.expect.kind === 'html') {
          expect(typeof testCase.expect.html).toBe('string');
        } else {
          expect(testCase.expect.code, `${testCase.id} has no code`).toMatch(/^O\d{4}$/);
        }
      }
    }
  });
});

describe('TEXT context: a payload stays text', () => {
  const cases = loadCategory('escaping-text').filter((c) => c.expect.kind === 'html');

  it('has cases', () => expect(cases.length).toBeGreaterThan(20));

  for (const testCase of cases) {
    it(testCase.id, () => {
      const payload = payloadOf(testCase);
      const dom = parseFragment(testCase.expect.html);

      // A real parser must see exactly the elements the template wrote.
      const elements = elementNames(dom);
      expect([...elements], `payload introduced elements: ${testCase.id}`).toEqual(['p']);

      // And the payload must come back out of the text unchanged.
      expect(withoutNul(textOf(dom))).toBe(withoutNul(payload));
    });
  }
});

describe('ATTR context: a payload reads back byte-identical', () => {
  const cases = loadCategory('escaping-attr').filter((c) => c.expect.kind === 'html');

  it('has cases', () => expect(cases.length).toBeGreaterThan(20));

  for (const testCase of cases) {
    it(testCase.id, () => {
      const payload = payloadOf(testCase);
      const dom = parseFragment(testCase.expect.html);
      const div = findElement(dom, 'div');

      expect(div, `no div parsed for ${testCase.id}`).toBeDefined();
      // The attacker's goal in an attribute is to add an attribute. There must
      // be exactly the one the template wrote.
      expect(div.attrs.map((a) => a.name)).toEqual(['data-x']);
      expect(withoutNul(attrOf(div, 'data-x'))).toBe(withoutNul(payload));
      expect([...elementNames(dom)]).toEqual(['div']);
    });
  }
});

describe('RCDATA context: a payload cannot close its element', () => {
  for (const [category, tag] of [
    ['escaping-rcdata-title', 'title'],
    ['escaping-rcdata-textarea', 'textarea'],
  ]) {
    const cases = loadCategory(category).filter((c) => c.expect.kind === 'html');

    describe(tag, () => {
      it('has cases', () => expect(cases.length).toBeGreaterThan(20));

      for (const testCase of cases) {
        it(testCase.id, () => {
          const payload = payloadOf(testCase);
          const dom = parseFragment(testCase.expect.html);
          const element = findElement(dom, tag);

          expect(element, `no ${tag} parsed for ${testCase.id}`).toBeDefined();
          // RCDATA holds text only. If the payload had closed the element
          // early, the parser would report siblings after it or nested tags.
          expect([...elementNames(dom)]).toEqual([tag]);
          expect(withoutNul(textOf(element))).toBe(withoutNul(payload));
        });
      }
    });
  }
});

describe('URL sinks: no dangerous scheme survives', () => {
  const SINKS = [
    ['url-href', 'a', 'href'],
    ['url-src', 'img', 'src'],
    ['url-action', 'form', 'action'],
    ['url-poster', 'video', 'poster'],
    ['url-cite', 'blockquote', 'cite'],
  ];

  for (const [category, tag, attr] of SINKS) {
    const cases = loadCategory(category).filter((c) => c.expect.kind === 'html');

    describe(`${tag}[${attr}]`, () => {
      it('has cases', () => expect(cases.length).toBeGreaterThan(20));

      for (const testCase of cases) {
        it(testCase.id, () => {
          const dom = parseFragment(testCase.expect.html);
          const element = findElement(dom, tag);
          expect(element, `no ${tag} parsed for ${testCase.id}`).toBeDefined();

          const emitted = attrOf(element, attr) ?? '';
          const normalized = emitted.toLowerCase().split(/[\s -]/).join('');

          expect(normalized.startsWith('javascript:'), `javascript: survived in ${testCase.id}`).toBe(false);
          expect(normalized.startsWith('vbscript:')).toBe(false);
          expect(normalized.startsWith('//'), `protocol-relative survived in ${testCase.id}`).toBe(false);

          if (normalized.startsWith('data:')) {
            // data: is permitted only as an image, and only in src.
            expect(attr).toBe('src');
            expect(normalized.startsWith('data:image/')).toBe(true);
          }

          // No payload may smuggle in an extra attribute or element.
          expect(element.attrs.map((a) => a.name).sort()).toEqual(
            tag === 'img' ? ['alt', attr].sort() : [attr],
          );
          for (const dangerous of DANGEROUS_ELEMENTS) {
            expect([...elementNames(dom)]).not.toContain(dangerous);
          }
        });
      }
    });
  }
});

describe('srcset: every candidate is sanitized independently', () => {
  const cases = loadCategory('url-srcset').filter((c) => c.expect.kind === 'html');

  for (const testCase of cases) {
    it(testCase.id, () => {
      const dom = parseFragment(testCase.expect.html);
      const img = findElement(dom, 'img');
      expect(img).toBeDefined();
      const emitted = (attrOf(img, 'srcset') ?? '').toLowerCase();
      expect(emitted.includes('javascript:'), `javascript: survived in ${testCase.id}`).toBe(false);
    });
  }
});

describe('JSON-LD: the payload cannot close the script element', () => {
  const cases = loadCategory('escaping-jsonld').filter((c) => c.expect.kind === 'html');

  it('has cases', () => expect(cases.length).toBeGreaterThan(20));

  for (const testCase of cases) {
    it(testCase.id, () => {
      const html = testCase.expect.html;
      // The engine emits its own <script type="application/ld+json"> wrapper.
      // Exactly one script element must exist, and its content must be JSON
      // that parses — a payload that had escaped would break one or the other.
      const opens = html.split('<script').length - 1;
      const closes = html.split('</script').length - 1;
      expect(opens, `${testCase.id} opened ${opens} script elements`).toBe(1);
      expect(closes).toBe(1);

      const start = html.indexOf('>', html.indexOf('<script')) + 1;
      const end = html.indexOf('</script');
      const json = html.slice(start, end);
      expect(() => JSON.parse(json), `${testCase.id} emitted invalid JSON`).not.toThrow();

      // And the payload round-trips through the JSON exactly.
      expect(JSON.parse(json).name).toBe(payloadOf(testCase));
    });
  }
});

describe('the one known divergence: U+0000', () => {
  /**
   * Pinned explicitly rather than normalized away.
   *
   * Orbit emits a NUL exactly as bound. A browser does not keep it, and what it
   * does depends on the context. That is a real difference between "the bytes
   * Orbit produced" and "the DOM a user gets", and a conformance suite that
   * silently smoothed it over would have nothing to say the next time an
   * engine-versus-platform disagreement mattered.
   *
   * It is not a security issue: a NUL cannot terminate an attribute, close an
   * element, or open a tag, which the structural assertions above confirm across
   * every context.
   */
  const nulCase = (category) =>
    loadCategory(category).find((c) => c.id.endsWith('/nul') && c.expect.kind === 'html');

  it('Orbit emits the NUL byte unchanged', () => {
    const testCase = nulCase('escaping-text');
    expect(testCase).toBeDefined();
    expect(testCase.expect.html.includes(NUL_CHAR)).toBe(true);
  });

  it('a browser DROPS it in body text', () => {
    const testCase = nulCase('escaping-text');
    const text = textOf(parseFragment(testCase.expect.html));
    expect(text).toBe('ab');
    expect(text.includes(NUL_CHAR)).toBe(false);
    expect(text.includes('�')).toBe(false);
  });

  it('a browser REPLACES it with U+FFFD in an attribute value', () => {
    const testCase = nulCase('escaping-attr');
    const div = findElement(parseFragment(testCase.expect.html), 'div');
    expect(attrOf(div, 'data-x')).toBe('a�b');
  });

  it('a browser REPLACES it with U+FFFD in RCDATA', () => {
    const testCase = nulCase('escaping-rcdata-title');
    const title = findElement(parseFragment(testCase.expect.html), 'title');
    expect(textOf(title)).toBe('a�b');
  });

  it('and in no context does it create structure', () => {
    for (const category of ['escaping-text', 'escaping-attr', 'escaping-rcdata-title']) {
      for (const testCase of loadCategory(category)) {
        if (testCase.expect.kind !== 'html') continue;
        if (!String(payloadOf(testCase) ?? '').includes(NUL_CHAR)) continue;
        const names = elementNames(parseFragment(testCase.expect.html));
        expect(names.size, `${testCase.id} produced extra elements`).toBe(1);
      }
    }
  });
});

describe('banned constructs never render', () => {
  it('every banned element is rejected before rendering', () => {
    for (const testCase of loadCategory('banned-element')) {
      expect(testCase.expect.kind, `${testCase.id} rendered`).not.toBe('html');
      expect(testCase.expect.code).toBe('O1080');
    }
  });

  it('every banned attribute is rejected before rendering', () => {
    for (const testCase of loadCategory('banned-attribute')) {
      expect(testCase.expect.kind, `${testCase.id} rendered`).not.toBe('html');
    }
  });

  it('no rendered case anywhere produces a script or an event handler', () => {
    /*
     * Asked of the PARSER, not of the string.
     *
     * A substring search is the wrong question here and gives a false positive:
     * the payload `" onerror="alert(1)` interpolated into a quoted attribute is
     * correctly escaped to `&quot; onerror=&quot;alert(1)`, so the bytes
     * ` onerror=` legitimately appear inside an attribute VALUE while creating
     * no attribute at all. What matters is whether a browser ends up with an
     * event handler, and only a real parser can answer that.
     */
    for (const category of CATEGORIES) {
      for (const testCase of loadCategory(category)) {
        if (testCase.expect.kind !== 'html') continue;

        const dom = parseFragment(testCase.expect.html);
        const names = elementNames(dom);

        // The engine's own <json-ld> wrapper is the sole legitimate script.
        if (category !== 'escaping-jsonld') {
          expect(names.has('script'), `${testCase.id} produced a script element`).toBe(false);
        }
        for (const dangerous of ['iframe', 'object', 'embed', 'svg', 'math']) {
          expect(names.has(dangerous), `${testCase.id} produced <${dangerous}>`).toBe(false);
        }

        const handlers = [];
        const walk = (node) => {
          for (const child of node.childNodes ?? []) {
            for (const attr of child.attrs ?? []) {
              if (attr.name.toLowerCase().startsWith('on')) handlers.push(attr.name);
            }
            walk(child);
          }
        };
        walk(dom);
        expect(handlers, `${testCase.id} produced event handlers`).toEqual([]);
      }
    }
  });
});
