/**
 * End-to-end conformance: the product-card + collection-page example from the
 * design doc (Orbit-ified), rendered byte-exact against a fake host.
 */
import { describe, expect, it } from 'vitest';
import { extractAccessPlan } from './host';
import { render } from './interpreter';
import { type SourceFile } from './parser';
import { compileOk, HOST_FILTERS, money } from './test-host.helper';

const PRODUCT_CARD: SourceFile = {
  name: 'components/product-card.orbit',
  source: `{# components/product-card.orbit #}
---
component ProductCard
props {
  product: Product
  showVendor: Bool = false
}
settings {
  imageRatio: Select("square", "portrait") = "square" label "Image ratio"
}
slots { badge? }
---
<article class="card card--{settings.imageRatio}">
  <a href={product.url}>
    <img src={imgUrl(product.cover, 480)} alt={product.title}>
    <slot name="badge"/>
    <h3>{product.title}</h3>
    <if {showVendor && product.vendor != none}>
      <p class="card__vendor">{product.vendor}</p>
    </if>
    <p class="card__price">{money(product.price)}<if {product.compareAt != none}>{" "}<s>{money(product.compareAt)}</s></if></p>
  </a>
</article>
`,
};

const COLLECTION_PAGE: SourceFile = {
  name: 'pages/collection.orbit',
  source: `{# pages/collection.orbit #}
---
page collection
settings {
  showVendors: Toggle = false label "Show vendor names"
}
---
<section class="collection">
  <h1>{collection.title}</h1>
  <div class="cos-grid" style="--cols: 3">
    <for product of={collection.products} limit={24}>
      <ProductCard product={product} showVendor={settings.showVendors}>
        <if {product.isNew}><span slot="badge" class="badge">New</span></if>
      </ProductCard>
      <empty><p>Nothing here yet.</p></empty>
    </for>
  </div>
</section>
`,
};

const aurora = {
  title: 'Aurora <Runner>',
  url: '/products/aurora-runner',
  vendor: 'Löwe & Co',
  price: money(129900),
  compareAt: money(159900),
  isNew: true,
  cover: { key: 'aurora.jpg' },
  tags: [],
  rating: null,
};

const basalt = {
  title: 'Basalt Slide',
  url: 'javascript:alert(1)', // hostile data: must be neutralized at the sink
  vendor: null,
  price: money(49900),
  compareAt: null,
  isNew: false,
  cover: { key: 'basalt.jpg' },
  tags: [],
  rating: null,
};

const CARD_1 =
  '<article class="card card--square">' +
  '<a href="/products/aurora-runner">' +
  '<img src="/img/aurora.jpg?w=480" alt="Aurora &lt;Runner&gt;">' +
  '<span class="badge">New</span>' +
  '<h3>Aurora &lt;Runner&gt;</h3>' +
  '<p class="card__vendor">Löwe &amp; Co</p>' +
  '<p class="card__price">₹1299.00 <s>₹1599.00</s></p>' +
  '</a></article>';

const CARD_2 =
  '<article class="card card--square">' +
  '<a href="#">' +
  '<img src="/img/basalt.jpg?w=480" alt="Basalt Slide">' +
  '<h3>Basalt Slide</h3>' +
  '<p class="card__price">₹499.00</p>' +
  '</a></article>';

describe('product card + collection page (design example, Orbit-ified)', () => {
  const program = compileOk([PRODUCT_CARD, COLLECTION_PAGE]);

  it('renders byte-exact HTML with escaping, slots, settings and URL defense', () => {
    const result = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'Sneakers & "Boots" <Fresh>', products: [aurora, basalt] } },
      settings: { collection: { showVendors: true } },
    });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(result.html).toBe(
      '<section class="collection">' +
        '<h1>Sneakers &amp; "Boots" &lt;Fresh&gt;</h1>' +
        '<div class="cos-grid" style="--cols: 3">' +
        CARD_1 +
        CARD_2 +
        '</div></section>',
    );
    expect(result.warnings.filter((w) => w.includes('blocked unsafe URL'))).toHaveLength(1);
  });

  it('renders the <empty> fallback for an empty catalog', () => {
    const result = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'Empty', products: [] } },
    });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(result.html).toBe(
      '<section class="collection"><h1>Empty</h1><div class="cos-grid" style="--cols: 3"><p>Nothing here yet.</p></div></section>',
    );
  });

  it('merchant settings flow: defaults hide vendors, provided values show them', () => {
    const noSettings = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'x', products: [aurora] } },
    });
    if (!noSettings.ok) throw new Error('render failed');
    expect(noSettings.html).not.toContain('card__vendor');
  });

  it('is deterministic byte-for-byte across repeated renders', () => {
    const opts = {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 't', products: [aurora, basalt] } },
      settings: { collection: { showVendors: true } },
    };
    const a = render(program, 'collection', opts);
    const b = render(program, 'collection', opts);
    if (!a.ok || !b.ok) throw new Error('render failed');
    expect(a.html).toBe(b.html);
  });

  it('extracts the exact AccessPlan the render touches (declare-then-fetch)', () => {
    const plan = extractAccessPlan(program, 'collection');
    expect(plan.paths).toEqual([
      'collection',
      'collection.products',
      'collection.products[].compareAt',
      'collection.products[].cover',
      'collection.products[].isNew',
      'collection.products[].price',
      'collection.products[].title',
      'collection.products[].url',
      'collection.products[].vendor',
      'collection.title',
    ]);
  });
});
