/**
 * The host a CommerceOS-like platform would supply for the Aurora port.
 *
 * Phase D measures whether real storefronts can be built in a closed world.
 * That question is only answerable against a REALISTIC host: a host with an
 * unlimited filter surface would make any gap disappear, and a host with none
 * would manufacture gaps that no platform would actually have.
 *
 * So the rule used here: a filter is allowed if a platform would plausibly ship
 * it as part of its object model — formatting, image transformation, sanitizing
 * merchant markdown. A filter invented specifically to paper over a language
 * gap is NOT allowed, and every place the port wanted one is recorded in
 * docs/evaluation/closed-world.md instead.
 */
import { t, TypeRegistry } from '../../src/types.ts';

export function makeRegistry() {
  const registry = new TypeRegistry();

  registry.defineObject('Money', {});

  registry.defineObject('Product', {
    title: t.string(),
    url: t.url(),
    vendor: t.optional(t.string()),
    price: t.money(),
    compareAt: t.optional(t.money()),
    cover: t.image(),
    available: t.bool(),
    // The platform's own closed set — exactly what <match> checks against.
    badge: t.union('none', 'new', 'sale', 'low-stock'),
    rating: t.optional(t.float()),
    reviewCount: t.int(),
    descriptionHtml: t.string(),
    optionName: t.string(),
    optionValues: t.list(t.string()),
  });

  registry.defineObject('Collection', {
    title: t.string(),
    description: t.string(),
    url: t.url(),
    products: t.list(t.object('Product')),
    productCount: t.int(),
  });

  registry.defineObject('MenuItem', {
    label: t.string(),
    url: t.url(),
    current: t.bool(),
  });

  registry.defineObject('Review', {
    author: t.string(),
    rating: t.int(),
    body: t.string(),
    dateText: t.string(),
  });

  registry.defineObject('Shop', {
    name: t.string(),
    logo: t.image(),
    cartCount: t.int(),
    searchUrl: t.url(),
    cartUrl: t.url(),
    accountUrl: t.url(),
  });

  registry.defineObject('Crumb', {
    label: t.string(),
    url: t.url(),
  });

  return registry;
}

export const HOST_FILTERS = [
  {
    // Money is terminal: it renders only through a host formatter.
    name: 'money',
    params: [t.money()],
    returns: t.moneyText(),
    impl: ([m]) => `₹${(m.amountMinor / 100).toFixed(2)}`,
  },
  {
    // The named-argument case from B1, and what a real image CDN looks like.
    name: 'imgUrl',
    params: [t.image(), t.int()],
    optionalParams: [
      { name: 'crop', type: t.string() },
      { name: 'format', type: t.string() },
    ],
    returns: t.url(),
    impl: ([img, w, crop, format]) => {
      let url = `/cdn/${img.key}?w=${String(w)}`;
      if (crop !== undefined && crop !== null) url += `&crop=${String(crop)}`;
      if (format !== undefined && format !== null) url += `&fm=${String(format)}`;
      return url;
    },
  },
  {
    // Merchant markdown in, safe markup out. The sanctioned path: silent.
    name: 'richtext',
    params: [t.string()],
    returns: t.html(),
    sanitizer: true,
    impl: ([s]) => `<p>${String(s).split('<').join('&lt;')}</p>`,
  },
  {
    name: 'percentOff',
    params: [t.money(), t.money()],
    returns: t.int(),
    impl: ([now, was]) => Math.round((1 - now.amountMinor / was.amountMinor) * 100),
  },
];

export const PAGE_GLOBALS = {
  shop: t.object('Shop'),
  menu: t.list(t.object('MenuItem')),
  collection: t.object('Collection'),
  product: t.object('Product'),
  reviews: t.list(t.object('Review')),
  crumbs: t.list(t.object('Crumb')),
  featured: t.list(t.object('Product')),
};

const money = (amountMinor) => ({ amountMinor, currency: 'INR' });

const product = (i, over = {}) => ({
  title: `Product ${i}`,
  url: `/products/p${i}`,
  vendor: 'Aurora',
  price: money(199900),
  compareAt: null,
  cover: { key: `p${i}.jpg` },
  available: true,
  badge: 'none',
  rating: 4.5,
  reviewCount: 12,
  descriptionHtml: 'A **fine** product.',
  optionName: 'Size',
  optionValues: ['S', 'M', 'L'],
  ...over,
});

export const BINDINGS = {
  shop: {
    name: 'Aurora Threads',
    logo: { key: 'logo.svg' },
    cartCount: 2,
    searchUrl: '/search',
    cartUrl: '/cart',
    accountUrl: '/account',
  },
  menu: [
    { label: 'Shop', url: '/collections/all', current: true },
    { label: 'Journal', url: '/blogs/journal', current: false },
    { label: 'About', url: '/pages/about', current: false },
  ],
  collection: {
    title: 'All products',
    description: 'Everything we make.',
    url: '/collections/all',
    products: [product(1), product(2, { badge: 'sale', compareAt: money(249900) }), product(3, { badge: 'new' })],
    productCount: 3,
  },
  featured: [product(1), product(2, { badge: 'low-stock' })],
  product: product(1, { badge: 'sale', compareAt: money(249900) }),
  reviews: [
    { author: 'A. Rao', rating: 5, body: 'Excellent.', dateText: '12 March' },
    { author: 'B. Singh', rating: 4, body: 'Good, runs small.', dateText: '2 April' },
  ],
  crumbs: [
    { label: 'Home', url: '/' },
    { label: 'All products', url: '/collections/all' },
  ],
};
