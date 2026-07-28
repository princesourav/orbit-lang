/**
 * Every `.orbit` file in this directory must parse and check with ZERO errors.
 *
 * The examples are documentation, and documentation that no longer compiles is
 * worse than none — so this test walks the directory, compiles every template
 * as ONE program (components resolve across files), and fails on any error
 * diagnostic. Warnings are allowed and asserted on separately: the article
 * example deliberately calls an `unsafeHtml` host filter, which must warn.
 *
 * It lives here, next to the examples, rather than in `src/`, for one concrete
 * reason: the engine's tsconfig sets `"types": []` on purpose, so no file it
 * typechecks may import `node:fs`. A `.mjs` test outside `src/` reads the
 * directory without weakening that guarantee.
 *
 * The fake host below is modelled on `src/test-host.helper.ts` — it is exactly
 * the bring-your-own-object-model seam a real embedder implements.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseProgram } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { extractAccessPlan } from '../src/host.ts';
import { render } from '../src/interpreter.ts';
import { formatProgram } from '../src/formatter.ts';
import { serializeProgram } from '../src/validate-ast.ts';
import { t, TypeRegistry } from '../src/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The fake host
// ---------------------------------------------------------------------------

function makeRegistry() {
  const registry = new TypeRegistry();
  registry.defineObject('Product', {
    title: t.string(),
    handle: t.string(),
    url: t.url(),
    vendor: t.optional(t.string()),
    price: t.money(),
    compareAt: t.optional(t.money()),
    available: t.bool(),
    cover: t.image(),
    tags: t.list(t.string()),
    rating: t.optional(t.float()),
  });
  registry.defineObject('Collection', {
    title: t.string(),
    description: t.optional(t.string()),
    url: t.url(),
    productCount: t.int(),
    products: t.list(t.object('Product')),
  });
  registry.defineObject('Author', {
    name: t.string(),
    url: t.optional(t.url()),
    avatar: t.optional(t.image()),
  });
  registry.defineObject('Article', {
    title: t.string(),
    handle: t.string(),
    url: t.url(),
    publishedAt: t.string(),
    excerpt: t.optional(t.string()),
    bodyHtml: t.string(),
    tags: t.list(t.string()),
    author: t.object('Author'),
  });
  return registry;
}

const HOST_FILTERS = [
  {
    name: 'money',
    params: [t.money()],
    returns: t.moneyText(),
    impl: (args) => {
      const m = args[0];
      return `$${(m.amountMinor / 100).toFixed(2)}`;
    },
  },
  {
    name: 'imgUrl',
    params: [t.image(), t.int()],
    returns: t.url(),
    impl: (args) => `/cdn/${args[0].key}?w=${String(args[1])}`,
  },
  {
    // Stand-in for a sanitizer-backed rich-text sink. Unsafe BY CONTRACT: the
    // host promises the value was sanitized at write time.
    name: 'richtext',
    params: [t.string()],
    returns: t.html(),
    unsafeHtml: true,
    impl: (args) => String(args[0]),
  },
];

const PAGE_GLOBALS = {
  shopName: t.string(),
  collection: t.object('Collection'),
  article: t.object('Article'),
  articles: t.list(t.object('Article')),
  pageNumber: t.int(),
  totalPages: t.int(),
  prevUrl: t.optional(t.url()),
  nextUrl: t.optional(t.url()),
};

// ---------------------------------------------------------------------------
// Sample data (shapes match the registry above)
// ---------------------------------------------------------------------------

const money = (amountMinor) => ({ amountMinor, currency: 'USD' });

const product = (n, extra = {}) => ({
  title: `Product ${n}`,
  handle: `product-${n}`,
  url: `/products/product-${n}`,
  vendor: 'Northwind',
  price: money(1999),
  compareAt: null,
  available: true,
  cover: { key: `product-${n}.jpg` },
  tags: ['new', 'cotton'],
  rating: 4.5,
  ...extra,
});

const author = {
  name: 'Ada Lovelace',
  url: '/authors/ada',
  avatar: { key: 'ada.jpg' },
};

const article = {
  title: 'How we build storefronts',
  handle: 'how-we-build',
  url: '/blog/how-we-build',
  publishedAt: '2026-03-04T09:30:00',
  excerpt: 'A short tour of the stack.',
  bodyHtml: '<p>Sanitized rich text.</p>',
  tags: ['engineering', 'behind the scenes'],
  author,
};

const BINDINGS = {
  shopName: 'Northwind Supply',
  collection: {
    title: 'Everyday carry',
    description: 'Things we use daily.',
    url: '/collections/everyday-carry',
    productCount: 3,
    products: [product(1), product(2, { compareAt: money(2999), rating: null }), product(3, { vendor: null })],
  },
  article,
  articles: [article],
  pageNumber: 2,
  totalPages: 5,
  prevUrl: '/collections/everyday-carry?page=1',
  nextUrl: '/collections/everyday-carry?page=3',
};

// ---------------------------------------------------------------------------
// Discovery + compilation
// ---------------------------------------------------------------------------

function orbitFiles(dir = HERE, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(abs).isDirectory()) {
      out.push(...orbitFiles(abs, rel));
      continue;
    }
    if (entry.endsWith('.orbit')) out.push({ name: rel, source: readFileSync(abs, 'utf8') });
  }
  return out;
}

const FILES = orbitFiles();

function compileAll() {
  const parsed = parseProgram(FILES);
  if (!parsed.ok) {
    const detail = parsed.diagnostics.map((d) => `${d.code} ${d.template ?? ''}: ${d.message}`).join('\n');
    throw new Error(`examples failed to parse:\n${detail}`);
  }
  const result = check(parsed.program, {
    registry: makeRegistry(),
    hostFilters: HOST_FILTERS,
    pageGlobals: PAGE_GLOBALS,
  });
  return { program: parsed.program, result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('examples/', () => {
  it('contains .orbit files (a silent empty directory is not a pass)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(6);
  });

  it('every example parses', () => {
    for (const file of FILES) {
      const parsed = parseProgram([file]);
      expect(parsed.ok, `${file.name} failed to parse`).toBe(true);
    }
  });

  it('the whole example set checks with zero errors', () => {
    const { result } = compileAll();
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    const detail = errors.map((d) => `${d.code} ${d.template ?? ''}:${d.span?.start.line ?? '?'} ${d.message}`);
    expect(detail).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the only check warning is the documented unsafeHtml one', () => {
    const { result } = compileAll();
    const warnings = result.diagnostics.filter((d) => d.severity === 'warning');
    expect(warnings.map((d) => d.code)).toEqual(['O2071']);
  });

  it('declares every template the README names', () => {
    const { program } = compileAll();
    const names = [...program.templates.keys()].sort();
    expect(names).toEqual(['Panel', 'ProductCard', 'PromoBanner', 'article', 'collection', 'index']);
  });

  it('renders every page example to HTML', () => {
    const { program } = compileAll();
    for (const entry of ['collection', 'article', 'index']) {
      const out = render(program, entry, {
        hostFilters: HOST_FILTERS,
        bindings: BINDINGS,
        now: () => 0,
      });
      expect(out.ok, `${entry}: ${out.ok ? '' : `${out.error.code} ${out.error.message}`}`).toBe(true);
      expect(out.html.length).toBeGreaterThan(0);
      // No sink may emit a raw script-opening sequence except the engine's own
      // json-ld wrapper, which is emitted verbatim by the interpreter.
      const scripts = out.html.split('<script').length - 1;
      expect(scripts).toBe(entry === 'article' ? 1 : 0);
    }
  });

  it('renders deterministically (same program + data -> same bytes)', () => {
    const { program } = compileAll();
    const once = render(program, 'collection', { hostFilters: HOST_FILTERS, bindings: BINDINGS, now: () => 0 });
    const twice = render(program, 'collection', { hostFilters: HOST_FILTERS, bindings: BINDINGS, now: () => 0 });
    expect(once.ok && twice.ok).toBe(true);
    expect(once.html).toBe(twice.html);
  });

  it('the collection example has a static access plan the host can pre-fetch', () => {
    const { program } = compileAll();
    const plan = extractAccessPlan(program, 'collection');
    expect(plan.paths).toContain('collection.products');
    expect(plan.paths).toContain('collection.products[].title');
    expect(plan.paths).toContain('nextUrl');
  });

  it('the article example emits an unsafeHtml render warning at runtime', () => {
    const { program } = compileAll();
    const out = render(program, 'article', { hostFilters: HOST_FILTERS, bindings: BINDINGS, now: () => 0 });
    expect(out.ok).toBe(true);
    expect(out.warnings.map((w) => w.code)).toContain('O4902');
  });

  it('every example is already in canonical format', () => {
    // The examples are the formatter's most honest test: they were written by
    // hand, not generated to please it. If `orbit fmt` would rewrite them,
    // either the examples drifted or the canon changed — both need a human.
    const { program } = compileAll();
    const formatted = formatProgram(program);
    for (const file of FILES) {
      const parsed = parseProgram([file]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const name = [...parsed.program.templates.keys()][0];
      // Compare with line endings normalized: git may check these out as CRLF
      // on Windows, and that is not a formatting defect.
      const onDisk = file.source.split('\r\n').join('\n');
      expect(formatted.get(name), `${file.name} is not canonically formatted`).toBe(onDisk);
    }
  });

  it('formatting never changes what an example renders', () => {
    const { program } = compileAll();
    const formatted = formatProgram(program);
    const refiles = [...formatted].map(([name, source]) => ({ name: `${name}.orbit`, source }));
    const reparsed = parseProgram(refiles);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;

    // Spans move when text moves; structure must not.
    const strip = (v) =>
      JSON.parse(JSON.stringify(v, (k, x) => (k === 'span' || k === 'nodeCount' ? undefined : x)));
    expect(strip(serializeProgram(reparsed.program))).toEqual(strip(serializeProgram(program)));

    for (const entry of ['collection', 'article']) {
      const before = render(program, entry, { hostFilters: HOST_FILTERS, bindings: BINDINGS, now: () => 0 });
      const after = render(reparsed.program, entry, { hostFilters: HOST_FILTERS, bindings: BINDINGS, now: () => 0 });
      expect(before.ok && after.ok).toBe(true);
      if (before.ok && after.ok) expect(after.html).toBe(before.html);
    }
  });
});
