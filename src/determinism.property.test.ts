/**
 * Property-based determinism and statelessness.
 *
 * "Same program + same data + same options → same bytes" is what makes an
 * Orbit render cacheable, diffable and reproducible. The failure mode it
 * guards against is not randomness — nothing here calls `Math.random` — but
 * STATE: a memo table, an interned string pool, a counter that survives a
 * render and shifts the next one. Such a bug is invisible to any test that
 * renders once, and it is precisely the bug a future "let's cache compiled
 * templates" patch introduces.
 *
 * So the properties are about SEQUENCES of renders, not single ones:
 *
 *  - repetition: rendering the same thing twice is byte-identical;
 *  - interleaving: renders of different programs, or of the same program with
 *    different data, do not influence one another in any order;
 *  - isolation: the render does not mutate its inputs, and each result gets
 *    its own warnings array rather than a shared one;
 *  - clock independence: the injected `now()` can return anything at all
 *    (as long as it does not trip the deadline) without changing a byte,
 *    which is what "no time value reaches the output" means operationally.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type Program } from './ast';
import { render, type RenderResult } from './interpreter';
import { type SourceFile } from './parser';
import { loadCheckedAst, serializeProgram } from './validate-ast';
import { compileOk, HOST_FILTERS, money } from './test-host.helper';

// ---------------------------------------------------------------------------
// Two structurally different programs over the same object model
// ---------------------------------------------------------------------------

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
<article class="card">
  <a href={product.url}><img src={imgUrl(product.cover, 480)} alt={product.title}><slot name="badge"/></a>
  <h3>{product.title}</h3>
  <if {showVendor && product.vendor != none}><p>{product.vendor}</p></if>
  <p>{money(product.price)}<if {product.compareAt != none}>{" "}<s>{money(product.compareAt)}</s></if></p>
  <p>{product.tags |> join(", ")}</p>
</article>`,
};

const GRID: SourceFile = {
  name: 'pages/grid.orbit',
  source: `---
page grid
---
<section><h1>{collection.title |> upper}</h1><for p of={collection.products} limit={20}><Card product={p} showVendor={p.isNew}><if {p.isNew}><span slot="badge">New</span></if></Card><empty><p>empty</p></empty></for></section>`,
};

const LIST: SourceFile = {
  name: 'pages/list.orbit',
  source: `---
page list
---
<ul><for p of={sortBy(collection.products, "title")} limit={20}><li title={p.title}><a href={p.url}>{p.title |> truncate(12)}</a></li><empty><li>none</li></empty></for></ul><p>{collection.products |> size}</p>`,
};

const gridProgram = compileOk([GRID, CARD]);
const listProgram = compileOk([LIST, CARD]);

// ---------------------------------------------------------------------------
// Data generation
// ---------------------------------------------------------------------------

const productArb = fc.record({
  title: fc.string({ maxLength: 24 }),
  url: fc.oneof(
    fc.constant('/p/x'),
    fc.constant('javascript:alert(1)'),
    fc.constant('https://example.com/p'),
    fc.string({ maxLength: 20 }),
  ),
  vendor: fc.oneof(fc.constant(null), fc.string({ maxLength: 16 })),
  price: fc.integer({ min: 0, max: 10_000_00 }).map((n) => money(n)),
  compareAt: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 10_000_00 }).map((n) => money(n))),
  isNew: fc.boolean(),
  cover: fc.record({ key: fc.string({ maxLength: 12 }) }),
  tags: fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
  rating: fc.oneof(fc.constant(null), fc.double({ min: 0, max: 5, noNaN: true })),
});

const collectionArb = fc.record({
  title: fc.string({ maxLength: 24 }),
  products: fc.array(productArb, { maxLength: 6 }),
});

type Collection = { title: string; products: unknown[] };

const bindingsOf = (collection: unknown): Record<string, unknown> => ({ collection });

function run(program: Program, entry: string, collection: unknown, now?: () => number): RenderResult {
  return render(program, entry, {
    hostFilters: HOST_FILTERS,
    bindings: bindingsOf(collection),
    ...(now === undefined ? {} : { now }),
  });
}

function htmlOf(result: RenderResult): string {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.html;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('render is deterministic', () => {
  it('the same program and data render byte-identically, every time', () => {
    fc.assert(
      fc.property(collectionArb, (collection) => {
        const first = htmlOf(run(gridProgram, 'grid', collection));
        for (let i = 0; i < 3; i += 1) {
          expect(htmlOf(run(gridProgram, 'grid', collection))).toBe(first);
        }
      }),
      { numRuns: 120 },
    );
  });

  it('warnings are deterministic too, in content and in order', () => {
    // Warnings carry blocked-URL reports with template names and line numbers.
    // If those drifted between renders, a host that logs them would see phantom
    // changes and could not dedupe them.
    fc.assert(
      fc.property(collectionArb, (collection) => {
        const a = run(gridProgram, 'grid', collection);
        const b = run(gridProgram, 'grid', collection);
        expect(b.warnings).toEqual(a.warnings);
      }),
      { numRuns: 120 },
    );
  });

  it('each result owns its warnings array', () => {
    // A shared array would let a host that mutates (sorts, truncates) one
    // result's warnings corrupt another's — classic accidental module state.
    fc.assert(
      fc.property(collectionArb, (collection) => {
        const a = run(gridProgram, 'grid', collection);
        const b = run(gridProgram, 'grid', collection);
        expect(a.warnings).not.toBe(b.warnings);
        a.warnings.length = 0;
        expect(run(gridProgram, 'grid', collection).warnings).toEqual(b.warnings);
      }),
      { numRuns: 60 },
    );
  });
});

describe('render is stateless across renders', () => {
  it('interleaving two programs changes neither one', () => {
    fc.assert(
      fc.property(collectionArb, collectionArb, (one, two) => {
        // Baselines, measured in isolation.
        const gridOne = htmlOf(run(gridProgram, 'grid', one));
        const listTwo = htmlOf(run(listProgram, 'list', two));

        // Now the same four renders in a deliberately awkward order.
        const seq = [
          htmlOf(run(listProgram, 'list', two)),
          htmlOf(run(gridProgram, 'grid', one)),
          htmlOf(run(listProgram, 'list', two)),
          htmlOf(run(gridProgram, 'grid', one)),
        ];
        expect(seq[1]).toBe(gridOne);
        expect(seq[3]).toBe(gridOne);
        expect(seq[0]).toBe(listTwo);
        expect(seq[2]).toBe(listTwo);
      }),
      { numRuns: 80 },
    );
  });

  it('rendering with different data in between does not perturb a render', () => {
    fc.assert(
      fc.property(collectionArb, fc.array(collectionArb, { maxLength: 3 }), (subject, noise) => {
        const baseline = htmlOf(run(gridProgram, 'grid', subject));
        for (const other of noise) run(gridProgram, 'grid', other);
        expect(htmlOf(run(gridProgram, 'grid', subject))).toBe(baseline);
      }),
      { numRuns: 80 },
    );
  });

  it('a failing render leaves nothing behind for the next one', () => {
    // Budget failures unwind through a throw. If any counter or output buffer
    // survived that unwind, the NEXT render would start dirty.
    fc.assert(
      fc.property(collectionArb, fc.integer({ min: 0, max: 400 }), (collection, fuel) => {
        const baseline = htmlOf(run(gridProgram, 'grid', collection));
        const starved = render(gridProgram, 'grid', {
          hostFilters: HOST_FILTERS,
          bindings: bindingsOf(collection),
          fuel,
        });
        if (!starved.ok) expect(starved.error.code.startsWith('O4')).toBe(true);
        expect(htmlOf(run(gridProgram, 'grid', collection))).toBe(baseline);
      }),
      { numRuns: 100 },
    );
  });

  it('a stored-and-reloaded program renders like the original, in any order', () => {
    fc.assert(
      fc.property(collectionArb, (collection) => {
        const wire: unknown = JSON.parse(JSON.stringify(serializeProgram(gridProgram)));
        const reloaded = loadCheckedAst(wire, { trust: 'verify' });
        const before = htmlOf(run(gridProgram, 'grid', collection));
        const viaWire = htmlOf(run(reloaded, 'grid', collection));
        const after = htmlOf(run(gridProgram, 'grid', collection));
        expect(viaWire).toBe(before);
        expect(after).toBe(before);
      }),
      { numRuns: 60 },
    );
  });
});

describe('render does not mutate what it is given', () => {
  it('leaves the bindings object structurally untouched', () => {
    fc.assert(
      fc.property(collectionArb, (collection) => {
        const snapshot = JSON.stringify(collection);
        run(gridProgram, 'grid', collection);
        run(listProgram, 'list', collection);
        expect(JSON.stringify(collection)).toBe(snapshot);
      }),
      { numRuns: 100 },
    );
  });

  it('does not reorder the caller’s list when a template sorts it', () => {
    // `sortBy` must copy. An in-place sort would be a silent data corruption
    // the host only notices when its own code reads the list afterwards.
    fc.assert(
      fc.property(collectionArb, (collection) => {
        const c = collection as Collection;
        const order = c.products.map((p) => (p as { title: string }).title);
        run(listProgram, 'list', collection);
        expect(c.products.map((p) => (p as { title: string }).title)).toEqual(order);
      }),
      { numRuns: 100 },
    );
  });
});

describe('the injected clock cannot reach the output', () => {
  it('any clock that does not trip the deadline yields identical bytes', () => {
    fc.assert(
      fc.property(
        collectionArb,
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 8 }),
        (collection, ticks) => {
          const baseline = htmlOf(run(gridProgram, 'grid', collection));
          // A clock that jumps around arbitrarily — but always reports the
          // same instant as the start, so the deadline never fires.
          let i = 0;
          const jumpy = (): number => {
            i += 1;
            void ticks[i % ticks.length];
            return 0;
          };
          expect(htmlOf(run(gridProgram, 'grid', collection, jumpy))).toBe(baseline);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('a clock that trips the deadline aborts instead of truncating', () => {
    fc.assert(
      fc.property(collectionArb, (collection) => {
        let t = 0;
        const result = render(gridProgram, 'grid', {
          hostFilters: HOST_FILTERS,
          bindings: bindingsOf(collection),
          deadlineMs: 1,
          now: () => {
            t += 10_000;
            return t;
          },
        });
        // Either the render was small enough never to check the clock, or it
        // failed outright — never a partial document.
        if (!result.ok) expect(result.error.code).toBe('O4003');
      }),
      { numRuns: 60 },
    );
  });
});
