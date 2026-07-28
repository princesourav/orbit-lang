/**
 * Property-based access-plan SOUNDNESS.
 *
 * `extractAccessPlan` is the declare-then-fetch contract: the host reads the
 * plan, fetches exactly those paths, and hands the result to `render`. The
 * plan is allowed to OVER-approximate (a wasted fetch) but must never
 * UNDER-approximate — a path the interpreter reads at runtime and the plan
 * failed to name is data the host never fetched, so it renders as a hole or an
 * O4012, in production, on a page nobody tested.
 *
 * Everything downstream leans on this: LSP completions, and later fragment
 * cache keys derived from the plan. A cache key that omits a path the render
 * actually depends on is a correctness bug that serves one merchant's data to
 * another. So the property here is the one that matters most in the suite:
 *
 *     reads(render(program, data)) ⊆ paths(extractAccessPlan(program))
 *
 * The left side is measured, not assumed. `data` is a tree of plain objects
 * whose fields are ACCESSOR properties that append their own path to a set
 * when read. No Proxy is involved — the engine reads host data with
 * `Object.hasOwn` followed by an ordinary property get, so a getter defined
 * with `Object.defineProperty` observes exactly the reads the interpreter
 * performs and nothing else. (The ENGINE still depends on no host behavior:
 * the recording lives entirely in this test's data.)
 *
 * Recorded paths use the plan's own vocabulary: `a.b` for a field and `a[]`
 * for "an element of the list a", so the two sides are directly comparable.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { extractAccessPlan } from './host';
import { render } from './interpreter';
import { type SourceFile } from './parser';
import { compileOk, HOST_FILTERS, money } from './test-host.helper';

// ---------------------------------------------------------------------------
// Recording data: getters that log the path they were read through
// ---------------------------------------------------------------------------

type Reads = Set<string>;

/**
 * Build an object whose every field records `${base}.${field}` when read.
 * Values are produced lazily and then CACHED, so repeated reads return the
 * identical object — otherwise a template that mentions `p.tags` twice would
 * see two different arrays and renders could not be compared for determinism.
 */
function recording(
  reads: Reads,
  base: string,
  fields: Readonly<Record<string, () => unknown>>,
): Record<string, unknown> {
  const cache = new Map<string, unknown>();
  const obj: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    Object.defineProperty(obj, key, {
      enumerable: true,
      configurable: true,
      get: (): unknown => {
        reads.add(`${base}.${key}`);
        if (!cache.has(key)) {
          const make = fields[key];
          cache.set(key, make === undefined ? null : make());
        }
        return cache.get(key) ?? null;
      },
    });
  }
  return obj;
}

/**
 * A `Product` from the test host's registry. Money and Image are OPAQUE leaf
 * types: the host filters that consume them (`money`, `imgUrl`) reach inside,
 * but those reads are the host's own business and are not paths the plan
 * describes — so leaves are plain objects, not recording ones.
 */
function recordingProduct(reads: Reads, base: string, seed: number): Record<string, unknown> {
  return recording(reads, base, {
    title: () => `Product ${String(seed)}`,
    // Deliberately hostile in one of three: the URL sink must still fire, and
    // a blocked URL must not change what was READ.
    url: () => (seed % 3 === 0 ? 'javascript:alert(1)' : `/products/p-${String(seed)}`),
    vendor: () => (seed % 2 === 0 ? `Vendor ${String(seed)}` : null),
    price: () => money(1000 * (seed + 1)),
    compareAt: () => (seed % 2 === 1 ? money(2000 * (seed + 1)) : null),
    isNew: () => seed % 2 === 0,
    cover: () => ({ key: `p-${String(seed)}.jpg` }),
    tags: () => [`tag-${String(seed)}`, 'sale'],
    rating: () => (seed % 4 === 0 ? null : (seed % 5) + 0.5),
  });
}

function recordingCollection(reads: Reads, base: string, productCount: number): Record<string, unknown> {
  return recording(reads, base, {
    title: () => `Collection ${String(productCount)}`,
    products: () =>
      Array.from({ length: productCount }, (_, i) => recordingProduct(reads, `${base}.products[]`, i)),
  });
}

// ---------------------------------------------------------------------------
// Plan coverage
// ---------------------------------------------------------------------------

/**
 * Is `path` named by the plan? Either literally, or by a `base.**` wildcard —
 * the extractor's documented degradation when the symbolic base set overflows.
 */
function coveredBy(plan: readonly string[], path: string): boolean {
  if (plan.includes(path)) return true;
  for (const entry of plan) {
    if (!entry.endsWith('.**')) continue;
    const base = entry.slice(0, entry.length - '.**'.length);
    if (path === base || path.startsWith(`${base}.`) || path.startsWith(`${base}[`)) return true;
  }
  return false;
}

function missingPaths(plan: readonly string[], reads: Reads): string[] {
  return [...reads].filter((p) => !coveredBy(plan, p)).sort();
}

// ---------------------------------------------------------------------------
// A grammar of well-typed page bodies over the test host's object model
// ---------------------------------------------------------------------------

/**
 * Snippets valid where `p` is an element of an UNFILTERED product list, i.e.
 * still nominally a `Product`. Passing `p` to a `Product`-typed prop only
 * typechecks here — see the pinned type-erasure test at the bottom.
 */
const PRODUCT_SNIPPETS = [
  '<h3>{p.title}</h3>',
  '<a href={p.url}>go</a>',
  '<img src={imgUrl(p.cover, 480)} alt={p.title}>',
  '<p>{money(p.price)}</p>',
  '<if {p.compareAt != none}><s>{money(p.compareAt)}</s></if>',
  '<if {p.vendor != none}><span>{p.vendor}</span></if>',
  '<if {p.isNew}><b>new</b></if>',
  '<p>{p.tags |> join(", ")}</p>',
  '<p>{p.tags |> size}</p>',
  '<p>{p.tags[0] ?? "none"}</p>',
  '<p>{p.rating ?? 0}</p>',
  '<p title={p.title |> upper}>{p.title |> truncate(8)}</p>',
  '<p>{p.vendor ?? p.title}</p>',
  '<Card product={p}></Card>',
  '<Card product={p} showVendor={p.isNew}><if {p.isNew}><span slot="badge">New</span></if></Card>',
  '<Card product={p}><em slot="badge">{p.title |> lower}</em></Card>',
];

/** Snippets valid at page level, where the `collection` global is in scope. */
const PAGE_SNIPPETS = [
  '<h1>{collection.title}</h1>',
  '<p>{collection.products |> size}</p>',
  '<p>{first(collection.products)?.title ?? "-"}</p>',
  '<p>{last(collection.products)?.vendor ?? "-"}</p>',
  '<p>{collection.products[0]?.title ?? "-"}</p>',
  '<if {collection.title != ""}><p>named</p></if>',
];

/** Every snippet that does not pass `p` on to a nominally-typed prop. */
const FIELD_ONLY_SNIPPETS = PRODUCT_SNIPPETS.filter((s) => !s.includes('<Card'));

/**
 * The list expressions a `<for>` may iterate.
 *
 * `sortBy`/`where` are absent on purpose: they read a field named by a string
 * literal, which the extractor does not record — a real under-approximation,
 * pinned by its own test at the bottom of this file rather than left to sink
 * the generative property.
 */
const FILTERED_LIST_EXPRS = [
  'reverse(collection.products)',
  'reverse(reverse(collection.products))',
];

const loopBody = (snippets: readonly string[]): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...snippets), { minLength: 1, maxLength: 3 }).map((xs) => xs.join(''));

const emptyBlock = fc.constantFrom('', '<empty><p>none</p></empty>');

const forBlock = fc.oneof(
  // Un-filtered subject: `p` is still a `Product`, so components are in play.
  fc
    .tuple(loopBody(PRODUCT_SNIPPETS), emptyBlock)
    .map(([body, empty]) => `<for p of={collection.products}>${body}${empty}</for>`),
  // Filtered subject: field reads only (a filter erases the nominal type).
  fc
    .tuple(fc.constantFrom(...FILTERED_LIST_EXPRS), loopBody(FIELD_ONLY_SNIPPETS), emptyBlock)
    .map(([subject, body, empty]) => `<for p of={${subject}}>${body}${empty}</for>`),
);

const pageBody = fc
  .array(fc.oneof(fc.constantFrom(...PAGE_SNIPPETS), forBlock), { minLength: 1, maxLength: 4 })
  .map((xs) => `<section>${xs.join('')}</section>`);

const CARD: SourceFile = {
  name: 'components/card.orbit',
  source: `---
component Card
props {
  product: Product
  showVendor: Bool = false
}
slots { badge? }
---
<article>
  <a href={product.url}><slot name="badge"/></a>
  <h4>{product.title}</h4>
  <if {showVendor && product.vendor != none}><p>{product.vendor}</p></if>
  <p>{money(product.price)}</p>
</article>`,
};

const generatedPage = pageBody.map(
  (body): SourceFile => ({
    name: 'pages/collection.orbit',
    source: `---\npage collection\n---\n${body}`,
  }),
);

// ---------------------------------------------------------------------------
// The soundness property
// ---------------------------------------------------------------------------

interface RunOutcome {
  plan: readonly string[];
  reads: Reads;
  ok: boolean;
}

function runRecorded(file: SourceFile, productCount: number): RunOutcome {
  const program = compileOk([file, CARD]);
  const plan = extractAccessPlan(program, 'collection').paths;
  const reads: Reads = new Set();
  const result = render(program, 'collection', {
    hostFilters: HOST_FILTERS,
    bindings: { collection: recordingCollection(reads, 'collection', productCount) },
  });
  return { plan, reads, ok: result.ok };
}

describe('the read recorder observes what the interpreter actually reads', () => {
  /**
   * A property of the form "recorded ⊆ planned" is vacuously true if nothing
   * is ever recorded, so the instrument is validated on a template whose reads
   * are known exactly. (The second, independent guard against vacuity is the
   * `sortBy`/`where` pair at the bottom of this file: the recorder catches a
   * path the plan misses, which it could not do if it saw nothing.)
   */
  it('records exactly the fields a fixed template touches, and no others', () => {
    const file: SourceFile = {
      name: 'pages/collection.orbit',
      source:
        '---\npage collection\n---\n<h1>{collection.title}</h1><for p of={collection.products}><h3>{p.title}</h3><p>{p.tags |> join(",")}</p></for>',
    };
    const program = compileOk([file]);
    const reads: Reads = new Set();
    const result = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: recordingCollection(reads, 'collection', 2) },
    });
    expect(result.ok).toBe(true);
    expect([...reads].sort()).toEqual([
      'collection.products',
      'collection.products[].tags',
      'collection.products[].title',
      'collection.title',
    ]);
    // ...and the plan covers every one of them.
    expect(missingPaths(extractAccessPlan(program, 'collection').paths, reads)).toEqual([]);
  });

  it('records nothing at all when the template reads nothing', () => {
    const file: SourceFile = {
      name: 'pages/collection.orbit',
      source: '---\npage collection\n---\n<p>static</p>',
    };
    const reads: Reads = new Set();
    render(compileOk([file]), 'collection', {
      bindings: { collection: recordingCollection(reads, 'collection', 2) },
    });
    expect([...reads]).toEqual([]);
  });
});

describe('access plan over-approximates every read the interpreter performs', () => {
  it('records no path outside the plan, for any generated page', () => {
    fc.assert(
      fc.property(generatedPage, fc.integer({ min: 0, max: 3 }), (file, productCount) => {
        const { plan, reads, ok } = runRecorded(file, productCount);
        expect(ok).toBe(true);
        const missing = missingPaths(plan, reads);
        // Failure message names the offending paths AND the plan, because a
        // shrunk counterexample is only useful if you can see both sides.
        expect(
          missing,
          `paths read but not planned: ${JSON.stringify(missing)}\nplan: ${JSON.stringify(plan)}`,
        ).toEqual([]);
      }),
      { numRuns: 600 },
    );
  });

  it('holds for an empty catalog, where only the roots are touched', () => {
    fc.assert(
      fc.property(generatedPage, (file) => {
        const { plan, reads } = runRecorded(file, 0);
        expect(missingPaths(plan, reads)).toEqual([]);
      }),
      { numRuns: 120 },
    );
  });

  it('is stable: the plan does not depend on the data', () => {
    // The plan is STATIC. If it varied with data the host could not fetch
    // before rendering, which is the entire point of extracting it.
    fc.assert(
      fc.property(generatedPage, (file) => {
        const program = compileOk([file, CARD]);
        const a = extractAccessPlan(program, 'collection').paths;
        const b = extractAccessPlan(program, 'collection').paths;
        expect(b).toEqual(a);
      }),
      { numRuns: 120 },
    );
  });

  it('names the root global whenever anything under it is read', () => {
    fc.assert(
      fc.property(generatedPage, fc.integer({ min: 1, max: 3 }), (file, n) => {
        const { plan, reads } = runRecorded(file, n);
        if (reads.size === 0) return;
        expect(plan).toContain('collection');
      }),
      { numRuns: 100 },
    );
  });

  it('is sorted and duplicate-free', () => {
    // Hosts key caches and dedupe fetches off this array; an unsorted or
    // duplicated plan makes two identical programs look different.
    fc.assert(
      fc.property(generatedPage, (file) => {
        const plan = extractAccessPlan(compileOk([file, CARD]), 'collection').paths;
        expect([...plan]).toEqual([...new Set(plan)].sort());
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Component entries: props are their own roots
// ---------------------------------------------------------------------------

describe('access plan soundness for a component entry', () => {
  const program = compileOk([CARD]);

  it('covers every read when the component is rendered directly', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.integer({ min: 0, max: 5 }), (showVendor, seed) => {
        const plan = extractAccessPlan(program, 'Card').paths;
        const reads: Reads = new Set();
        const result = render(program, 'Card', {
          hostFilters: HOST_FILTERS,
          props: { product: recordingProduct(reads, 'product', seed), showVendor },
        });
        expect(result.ok).toBe(true);
        expect(missingPaths(plan, reads)).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it('seeds each declared prop as a root even when the body never reads it', () => {
    const plan = extractAccessPlan(program, 'Card').paths;
    expect(plan).toContain('product');
    expect(plan).toContain('showVendor');
  });
});

// ---------------------------------------------------------------------------
// A known gap, pinned so it cannot widen silently
// ---------------------------------------------------------------------------

describe('sortBy/where key fields are NOT in the plan (known under-approximation)', () => {
  /**
   * `sortBy(products, "title")` READS `products[].title` at runtime — the
   * filter indexes each element by the literal key — but the extractor treats
   * a call's non-identifier arguments as opaque and records nothing for the
   * key. A host that fetched exactly the plan would sort by `null` (stdlib
   * `fieldValue` returns null for an absent own-property) and `where` would
   * filter everything out.
   *
   * This is an UNDER-approximation, the one direction the documented contract
   * forbids, so it is a real defect rather than a design choice. It is pinned
   * here — rather than left to fail inside the generative property above,
   * which would take the whole suite red — so that the day the extractor
   * learns about literal filter keys, this test fails and gets deleted.
   *
   * Fix sketch (owner of host.ts): in `walkExpr`'s `call` case, when the
   * callee is `sortBy`/`where` and `args[1]` is a string literal, record
   * `elementOf(base) + "." + key` for every base of `args[0]`.
   */
  const keyedPage = (expr: string): SourceFile => ({
    name: 'pages/collection.orbit',
    source: `---\npage collection\n---\n<for p of={${expr}}><p>{p.title}</p></for>`,
  });

  it('sortBy: the sort key is read at runtime but absent from the plan', () => {
    const file = keyedPage('sortBy(collection.products, "vendor")');
    const program = compileOk([file]);
    const plan = extractAccessPlan(program, 'collection').paths;
    const reads: Reads = new Set();
    const result = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: recordingCollection(reads, 'collection', 3) },
    });
    expect(result.ok).toBe(true);
    expect(reads.has('collection.products[].vendor')).toBe(true);
    expect(coveredBy(plan, 'collection.products[].vendor')).toBe(false);
  });

  it('where: the predicate field is read at runtime but absent from the plan', () => {
    const file = keyedPage('where(collection.products, "isNew", true)');
    const program = compileOk([file]);
    const plan = extractAccessPlan(program, 'collection').paths;
    const reads: Reads = new Set();
    const result = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: recordingCollection(reads, 'collection', 3) },
    });
    expect(result.ok).toBe(true);
    expect(reads.has('collection.products[].isNew')).toBe(true);
    expect(coveredBy(plan, 'collection.products[].isNew')).toBe(false);
  });
});

describe('list filters erase the nominal element type (known checker gap)', () => {
  /**
   * `<for p of={collection.products}><Card product={p}/></for>` typechecks;
   * putting ANY list filter in between — `reverse`, `sortBy`, `where` — does
   * not, because the filter's return type is `List<record>` and a structural
   * record is not assignable to the nominal `Product` the prop declares.
   *
   * Found by the generative property above, which produced exactly that
   * template. It is not a security defect, but it makes the most ordinary
   * thing a merchant does with a product grid — sort it — fail to compile
   * with an error whose text ("expects Product, found {title: String, …}")
   * shows two types that look the same, which is the worst kind of error to
   * receive. Pinned here so the day filters preserve nominal element types,
   * this test fails and gets deleted.
   */
  const withSubject = (subject: string): SourceFile => ({
    name: 'pages/collection.orbit',
    source: `---\npage collection\n---\n<for p of={${subject}}><Card product={p}></Card></for>`,
  });

  it('accepts an un-filtered subject', () => {
    expect(() => compileOk([withSubject('collection.products'), CARD])).not.toThrow();
  });

  for (const subject of [
    'reverse(collection.products)',
    'sortBy(collection.products, "title")',
    'where(collection.products, "isNew", true)',
  ]) {
    it(`rejects ${subject} with O2083`, () => {
      expect(() => compileOk([withSubject(subject), CARD])).toThrow(/O2083/);
    });
  }
});

// ---------------------------------------------------------------------------
// Server islands: containment holds PER UNIT, not just for the whole page
// ---------------------------------------------------------------------------

/**
 * Deferral splits one render into two, and the safety argument has to split
 * with it.
 *
 * The property asserted when islands landed — deferral never adds a path to
 * the page plan, and no path is in both — is monotonicity plus disjointness.
 * Those describe how the two SETS relate; neither says a set is sound. A
 * partition of two unsound halves is still a partition. What makes the
 * declare-then-fetch contract survive deferral is that containment holds for
 * every unit the host renders separately:
 *
 *     reads(render(unit)) ⊆ paths(plan(unit))    for the page AND each island
 *
 * The page half is covered above. This is the island half, and without it a
 * host could fetch exactly what an island's manifest asked for and still find
 * the island reading something it never fetched — as an O4012 in the second
 * request, on a fragment nobody tested.
 */
const ISLAND: SourceFile = {
  name: 'components/island-card.orbit',
  source: `---
component IslandCard
props {
  product: Product
  showVendor: Bool = false
}
---
<article>
  <h4>{product.title}</h4>
  <if {showVendor && product.vendor != none}><p>{product.vendor}</p></if>
  <p>{money(product.price)}</p>
  <p>{product.tags |> size} tags</p>
</article>`,
};

const DEFERRING_PAGE: SourceFile = {
  name: 'pages/collection.orbit',
  source: '---\npage collection\n---\n<IslandCard defer showVendor={true}/>\n',
};

describe('access plan soundness for a deferred island', () => {
  const program = compileOk([DEFERRING_PAGE, ISLAND]);

  it('the manifest names every path the second pass will read', () => {
    // The host fetches from the MANIFEST, so the manifest is the thing that
    // has to be sound — not the plan the page happened to be extracted with.
    const first = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: {},
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.islands).toHaveLength(1);
    const manifest = first.islands[0];
    if (manifest === undefined) return;

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (seed) => {
        const reads: Reads = new Set();
        // Pass 2, exactly as a host performs it: the component as its own
        // entry, the manifest's props supplied, everything else host-resolved.
        const second = render(program, manifest.component, {
          hostFilters: HOST_FILTERS,
          props: {
            ...manifest.props,
            product: recordingProduct(reads, 'product', seed),
          },
        });
        expect(second.ok).toBe(true);
        expect(missingPaths(manifest.paths, reads)).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it('the page never reads what it deferred, so its own plan stays sound too', () => {
    // The other half of the partition, measured rather than assumed: if the
    // first pass touched the island's data, deferring would have bought
    // nothing and the page plan would be under-approximating.
    const reads: Reads = new Set();
    const out = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { product: recordingProduct(reads, 'product', 1) },
    });
    expect(out.ok).toBe(true);
    expect([...reads]).toEqual([]);
    expect(missingPaths(extractAccessPlan(program, 'collection').paths, reads)).toEqual([]);
  });

  it('a prop the page DID supply is not left for the host to fetch twice', () => {
    // `showVendor` travels in the manifest as a resolved value, so it must not
    // also appear as a path the host is told to go and get.
    const out = render(program, 'collection', { hostFilters: HOST_FILTERS, bindings: {} });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.islands[0]?.props).toMatchObject({ showVendor: true });
    expect(out.islands[0]?.paths ?? []).not.toContain('showVendor');
  });
});
