/**
 * Orbit benchmark harness.
 *
 * Deliberately narrow. It measures ONE thing — CPU time to render a
 * representative product-listing page on the current engine — because that is
 * the number the edge story depends on and the only performance claim this
 * project is currently entitled to make.
 *
 * What it is not:
 *
 *   * **Not a comparison.** No Liquid, no Nunjucks, no Handlebars. A
 *     cross-engine table is easy to produce and almost always misleading:
 *     different feature sets, different escaping work, and a scenario chosen
 *     (however unconsciously) by whoever wrote it. If Orbit ever publishes
 *     comparative numbers, it will be on a scenario suite someone else defined.
 *   * **Not a claim of speed.** The engine is a tree-walking interpreter. A
 *     bytecode VM is future work, and until it exists the honest position is
 *     "fast enough for a page render at the edge", which is what this measures.
 *
 * The scenario is fixed in code and the output includes the machine and runtime
 * so a reported number can be reproduced or disputed.
 *
 * Usage:
 *   npx vite-node bench/bench.mjs -- [--iterations N] [--json]
 */
import os from 'node:os';
import process from 'node:process';

import { parseProgram } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { render } from '../src/interpreter.ts';
import { serializeProgram, loadCheckedAst } from '../src/validate-ast.ts';
import { extractAccessPlan } from '../src/host.ts';
import { t, TypeRegistry } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Scenario: a product listing, the page a commerce platform renders most
// ---------------------------------------------------------------------------

const CARD = `---
component ProductCard
props {
  product: Product
  showVendor: Bool = false
}
---
<article class="card">
  <a class="card__link" href={product.url}>
    <img class="card__image" src={product.image} alt={product.title} loading="lazy"/>
    <h3 class="card__title">{product.title |> truncate(60)}</h3>
  </a>
  <if {showVendor && product.vendor != none}>
    <p class="card__vendor">{product.vendor}</p>
  </if>
  <p class="card__price">{product.price |> money}</p>
  <if {(product.tags |> size) > 0}>
    <ul class="card__tags">
      <for tag of={product.tags} limit={4}>
        <li class="card__tag">{tag}</li>
        <empty><li class="card__tag">untagged</li></empty>
      </for>
    </ul>
  </if>
  <button class="card__cta" type="button" disabled?={!product.available}>
    <if {product.available}>Add to cart</if>
    <else>Sold out</else>
  </button>
</article>
`;

const PAGE = `---
page collection
settings {
  columns: Range(1, 6, step: 1) = 4 label "Columns"
  showVendors: Toggle = true label "Show vendors"
}
---
<section class="collection">
  <h1 class="collection__title">{collection.title}</h1>
  <div class="collection__grid" data-columns={settings.columns}>
    <for product of={collection.products} limit={48}>
      <ProductCard product={product} showVendor={settings.showVendors}/>
      <empty><p class="collection__empty">Nothing here yet.</p></empty>
    </for>
  </div>
</section>
`;

function makeRegistry() {
  const registry = new TypeRegistry();
  registry.defineObject('Product', {
    title: t.string(),
    url: t.url(),
    image: t.url(),
    vendor: t.optional(t.string()),
    price: t.money(),
    available: t.bool(),
    tags: t.list(t.string()),
  });
  registry.defineObject('Collection', {
    title: t.string(),
    products: t.list(t.object('Product')),
  });
  return registry;
}

const HOST_FILTERS = [
  {
    name: 'money',
    params: [t.money()],
    returns: t.moneyText(),
    impl: ([value]) => {
      const m = value;
      return `₹${(m.amountMinor / 100).toFixed(2)}`;
    },
  },
];

/** 48 products — a full listing page, which is the case that matters. */
function makeBindings(count = 48) {
  const products = Array.from({ length: count }, (_, i) => ({
    title: `Product ${i} — a reasonably long merchandising title`,
    url: `/products/product-${i}`,
    image: `/cdn/product-${i}.jpg`,
    vendor: i % 3 === 0 ? null : `Vendor ${i % 7}`,
    price: { amountMinor: 9900 + i * 137, currency: 'INR' },
    available: i % 5 !== 0,
    tags: ['new', 'sale', 'featured', 'limited'].slice(0, (i % 4) + 1),
  }));
  return { collection: { title: 'Sneakers & "Boots" <Fresh>', products } };
}

// ---------------------------------------------------------------------------

function compile() {
  const parsed = parseProgram([
    { name: 'card.orbit', source: CARD },
    { name: 'collection.orbit', source: PAGE },
  ]);
  if (!parsed.ok) {
    throw new Error(parsed.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  }
  const checked = check(parsed.program, {
    registry: makeRegistry(),
    hostFilters: HOST_FILTERS,
    pageGlobals: { collection: t.object('Collection') },
  });
  const errors = checked.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map((d) => `${d.code} ${d.message}`).join('\n'));
  }
  return parsed.program;
}

/** Median is reported rather than mean: one GC pause should not set the number. */
function measure(label, fn, iterations) {
  // Warm up so JIT compilation is not counted as render cost.
  for (let i = 0; i < Math.min(50, iterations); i += 1) fn();

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const at = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
  return {
    label,
    iterations,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    minMs: samples[0],
  };
}

export function runBench({ iterations = 500 } = {}) {
  const program = compile();
  const bindings = makeBindings();
  const options = { bindings, hostFilters: HOST_FILTERS, settings: {} };

  const first = render(program, 'collection', options);
  if (!first.ok) throw new Error(`${first.error.code}: ${first.error.message}`);

  const serialized = serializeProgram(program);
  const serializedJson = JSON.stringify(serialized);

  const results = [
    measure('render (48 products)', () => render(program, 'collection', options), iterations),
    measure('parse + check', () => compile(), Math.max(20, Math.floor(iterations / 10))),
    measure(
      'loadCheckedAst (verify)',
      () => loadCheckedAst(JSON.parse(serializedJson), { trust: 'verify' }),
      Math.max(20, Math.floor(iterations / 5)),
    ),
    measure(
      'extractAccessPlan',
      () => extractAccessPlan(program, 'collection'),
      Math.max(20, Math.floor(iterations / 5)),
    ),
  ];

  return {
    scenario: 'collection page, 48 product cards',
    outputBytes: first.html.length,
    runtime: `${process.release?.name ?? 'node'} ${process.version}`,
    platform: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    results,
  };
}

export { CARD, PAGE, makeBindings, makeRegistry, HOST_FILTERS, compile };
