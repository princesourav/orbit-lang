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
    const blocked = result.warnings.filter((w) => w.code === 'O4900');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.message).toContain('blocked unsafe URL in href');
    expect(blocked[0]?.template).toBe('ProductCard');
    expect(blocked[0]?.line).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// AccessPlan soundness (v0.5 LSP + fragment-cache keys depend on it)
// ---------------------------------------------------------------------------

describe('AccessPlan soundness', () => {
  const plan = (files: readonly SourceFile[], entry: string): readonly string[] =>
    extractAccessPlan(compileOk(files), entry).paths;

  describe('component entries seed props as roots, not page globals', () => {
    const CARD: SourceFile = {
      name: 'components/card.orbit',
      source: `---
component Card
props {
  product: Product
  showVendor: Bool = false
}
settings {
  ratio: Select("a", "b") = "a"
}
---
<article class="r--{settings.ratio}"><h3>{product.title}</h3><if {showVendor}><p>{product.vendor ?? "-"}</p></if></article>`,
    };

    it('records prop-rooted paths and never invents a data root for `settings`', () => {
      const paths = plan([CARD], 'Card');
      expect(paths).toEqual(['product', 'product.title', 'product.vendor', 'showVendor']);
      expect(paths).not.toContain('settings');
      expect(paths.some((p) => p.startsWith('settings.'))).toBe(false);
    });

    it('a free identifier inside a component body is never treated as a root', () => {
      // Every free name in a checked component is a prop or `settings`; the
      // page-global fallback must not apply here.
      const paths = plan([CARD], 'Card');
      for (const p of paths) {
        expect(p === 'product' || p.startsWith('product') || p === 'showVendor').toBe(true);
      }
    });
  });

  describe('default-prop expressions', () => {
    const DEFAULTED: SourceFile = {
      name: 'components/defaulted.orbit',
      source: `---
component Defaulted
props {
  label: String = "hi"
  size: Int = 3
}
---
<p>{label}{size}</p>`,
    };

    it('component-entry defaults are walked, not skipped', () => {
      expect(plan([DEFAULTED], 'Defaulted')).toEqual(['label', 'size']);
    });

    it('an omitted prop at a CALL site still contributes its default', () => {
      const page: SourceFile = {
        name: 'pages/collection.orbit',
        source: '---\npage collection\n---\n<Defaulted size={size(collection.products)}/>',
      };
      const paths = plan([DEFAULTED, page], 'collection');
      expect(paths).toContain('collection');
      expect(paths).toContain('collection.products');
    });
  });

  describe('paths are NOT dropped through filters (over-approximate, never under)', () => {
    it('first(products).title stays in the plan', () => {
      const page: SourceFile = {
        name: 'pages/collection.orbit',
        source: '---\npage collection\n---\n<p>{first(collection.products)?.title ?? "-"}</p>',
      };
      const paths = plan([page], 'collection');
      // The sound answer is the element form; the list form is the harmless
      // over-approximation that keeps the extractor filter-agnostic.
      expect(paths).toContain('collection.products[].title');
      expect(paths).toContain('collection.products');
      // v0.1 recorded only `collection.products` and silently lost `.title`.
      expect(paths.some((p) => p.endsWith('.title'))).toBe(true);
    });

    it('a chained filter pipeline keeps the base path', () => {
      const page: SourceFile = {
        name: 'pages/collection.orbit',
        source:
          '---\npage collection\n---\n<for p of={sortBy(collection.products, "title")}><p>{p.title}</p></for>',
      };
      const paths = plan([page], 'collection');
      expect(paths).toContain('collection.products');
      expect(paths.some((p) => p.includes('.title'))).toBe(true);
    });

    it('never explodes: a long filter chain stays bounded', () => {
      const page: SourceFile = {
        name: 'pages/collection.orbit',
        source:
          '---\npage collection\n---\n<p>{first(reverse(sortBy(reverse(sortBy(collection.products, "title")), "title")))?.title ?? "-"}</p>',
      };
      const paths = plan([page], 'collection');
      expect(paths.length).toBeLessThan(64);
      expect(paths.some((p) => p.includes('.title'))).toBe(true);
    });
  });

  describe('slot nesting and let rebinding', () => {
    const INNER: SourceFile = {
      name: 'components/inner.orbit',
      source: '---\ncomponent Inner\nprops {\n  product: Product\n}\nslots { body? }\n---\n<div><h4>{product.title}</h4><slot name="body"/></div>',
    };
    const OUTER: SourceFile = {
      name: 'components/outer.orbit',
      source: '---\ncomponent Outer\nprops {\n  product: Product\n}\nslots { wrap? }\n---\n<section>{product.url}<slot name="wrap"/></section>',
    };

    it('slot-in-slot content is walked in the CALLER scope at every level', () => {
      const page: SourceFile = {
        name: 'pages/collection.orbit',
        source: `---
page collection
---
<for p of={collection.products}>
  <Outer product={p}>
    <div slot="wrap">
      <Inner product={p}>
        <span slot="body">{p.vendor ?? "-"}</span>
      </Inner>
    </div>
  </Outer>
</for>`,
      };
      const paths = plan([INNER, OUTER, page], 'collection');
      // Outer's own body, Inner's own body, and the innermost fill (which
      // reads CALLER data, two component boundaries out) must all appear.
      expect(paths).toContain('collection.products[].url');
      expect(paths).toContain('collection.products[].title');
      expect(paths).toContain('collection.products[].vendor');
    });

    it('let rebinding aliases correctly and does not leak the old binding', () => {
      const page: SourceFile = {
        name: 'pages/collection.orbit',
        source: `---
page collection
---
<let p={first(collection.products)}/>
<p>{p?.title ?? "-"}</p>
<let p={first(collection.products)}/>
<p>{p?.vendor ?? "-"}</p>`,
      };
      const paths = plan([page], 'collection');
      expect(paths).toContain('collection.products[].title');
      expect(paths).toContain('collection.products[].vendor');
      // `p` is a let binding, never a data root of its own.
      expect(paths).not.toContain('p');
      expect(paths.some((path) => path.startsWith('p.'))).toBe(false);
    });

    it('a let that shadows a loop item resolves to the loop item, not a root', () => {
      const page: SourceFile = {
        name: 'pages/collection.orbit',
        source: `---
page collection
---
<for item of={collection.products}><let alias={item}/><p>{alias.title}</p></for>`,
      };
      const paths = plan([page], 'collection');
      expect(paths).toContain('collection.products[].title');
      expect(paths).not.toContain('alias');
      expect(paths).not.toContain('item');
    });
  });

  it('is deterministic and sorted', () => {
    const page: SourceFile = {
      name: 'pages/collection.orbit',
      source: '---\npage collection\n---\n<p>{collection.title}</p><p>{size(collection.products)}</p>',
    };
    const once = plan([page], 'collection');
    const twice = plan([page], 'collection');
    expect(once).toEqual(twice);
    expect([...once]).toEqual([...once].sort());
  });
});
