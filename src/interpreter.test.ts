import { describe, expect, it } from 'vitest';
import { render, type RenderOptions } from './interpreter';
import { compileOk, HOST_FILTERS, money, pageSource, cardSource } from './test-host.helper';
import { type SourceFile } from './parser';

function product(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Widget',
    url: '/products/widget',
    vendor: null,
    price: money(19900),
    compareAt: null,
    isNew: false,
    cover: { key: 'w.jpg' },
    tags: ['a', 'b'],
    rating: null,
    ...overrides,
  };
}

function renderPage(files: readonly SourceFile[], options: RenderOptions = {}) {
  const program = compileOk(files);
  return render(program, 'collection', { hostFilters: HOST_FILTERS, ...options });
}

function renderOkPage(files: readonly SourceFile[], options: RenderOptions = {}): { html: string; warnings: string[] } {
  const result = renderPage(files, options);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

const COLLECTION = { title: 'All', products: [product()] };

describe('rendering basics', () => {
  it('escapes text, attributes and RCDATA per context', () => {
    const { html } = renderOkPage(
      [pageSource('<title>{collection.title} & more</title><h1 data-t="{collection.title}">{collection.title}</h1>')],
      { bindings: { collection: { title: 'A<&>"B', products: [] } } },
    );
    expect(html).toBe('<title>A&lt;&amp;>"B &amp; more</title><h1 data-t="A&lt;&amp;&gt;&quot;B">A&lt;&amp;&gt;"B</h1>');
  });

  it('renders if/else-if/else, let scoping and conditional attributes', () => {
    const { html } = renderOkPage(
      [
        pageSource(
          '<let n={size(collection.products)}/><if {n == 0}><p>none</p></if><else-if {n == 1}><p>one</p></else-if><else><p>many</p></else><button disabled?={n == 1}>buy</button>',
        ),
      ],
      { bindings: { collection: COLLECTION } },
    );
    expect(html).toBe('<p>one</p><button disabled>buy</button>');
  });

  it('renders loops with index, limit and <empty> fallback', () => {
    const files = [
      pageSource('<ul><for tag, i of={first(collection.products)?.tags ?? []} limit={2}><li>{i}:{tag}</li><empty><li>empty</li></empty></for></ul>'),
    ];
    expect(renderOkPage(files, { bindings: { collection: COLLECTION } }).html).toBe('<ul><li>0:a</li><li>1:b</li></ul>');
    expect(renderOkPage(files, { bindings: { collection: { title: 'x', products: [] } } }).html).toBe('<ul><li>empty</li></ul>');
  });

  it('emits json-ld through the escaping serializer', () => {
    const { html } = renderOkPage(
      [pageSource('<json-ld>{ {name: collection.title} }</json-ld>')],
      { bindings: { collection: { title: '</script>', products: [] } } },
    );
    expect(html).toBe('<script type="application/ld+json">{"name":"\\u003c\\/script\\u003e"}</script>');
  });

  it('renders Html host-filter output raw (the one unescaped sink)', () => {
    const { html } = renderOkPage(
      [pageSource('<div>{richtext(collection.title)}</div>')],
      { bindings: { collection: { title: '<b>bold</b>', products: [] } } },
    );
    expect(html).toBe('<div><b>bold</b></div>');
  });
});

describe('URL sink discipline (W-11)', () => {
  it('blocks unsafe URLs at the sink, emits # and records a warning', () => {
    const { html, warnings } = renderOkPage(
      [pageSource('<a href={first(collection.products)?.url ?? "#"}>x</a>')],
      { bindings: { collection: { title: 'x', products: [product({ url: 'javascript:alert(1)' })] } } },
    );
    expect(html).toBe('<a href="#">x</a>');
    expect(warnings.some((w) => w.includes('blocked unsafe URL'))).toBe(true);
  });
});

describe('settings resolution (W-20)', () => {
  const files = [
    pageSource('<p class="v--{settings.variant}">{settings.label}</p>', 'settings {\n  variant: Select("a", "b") = "a"\n  label: Text = "hi"\n}\n'),
  ];

  it('uses provided values when valid', () => {
    const { html } = renderOkPage(files, {
      bindings: { collection: COLLECTION },
      settings: { collection: { variant: 'b', label: 'yo' } },
    });
    expect(html).toBe('<p class="v--b">yo</p>');
  });

  it('falls back to declared defaults on invalid values, with a warning', () => {
    const { html, warnings } = renderOkPage(files, {
      bindings: { collection: COLLECTION },
      settings: { collection: { variant: 'zzz' } },
    });
    expect(html).toBe('<p class="v--a">hi</p>');
    expect(warnings.some((w) => w.includes('collection.variant'))).toBe(true);
  });
});

describe('budget trips fail cleanly with template/line/col (W-05)', () => {
  it('fuel exhaustion trips O4001', () => {
    const result = renderPage(
      [pageSource('<for i of={1..250}><p>some longer chunk of text {i}</p></for>')],
      { bindings: { collection: COLLECTION }, fuel: 500 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4001');
    expect(result.error.template).toBe('collection');
    expect(result.error.line).toBeGreaterThan(0);
  });

  it('the iteration counter is GLOBAL across component boundaries (W-06)', () => {
    const inner: SourceFile = {
      name: 'inner.orbit',
      source: '---\ncomponent Inner\n---\n<for j of={1..250}><span>.</span></for>',
    };
    const result = renderPage(
      [pageSource('<for i of={1..250}><Inner/></for>'), inner],
      { bindings: { collection: COLLECTION }, fuel: 100_000_000, maxIterations: 10_000 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4002');
  });

  it('wall-clock deadline trips O4003 via the injected clock', () => {
    let calls = 0;
    const result = renderPage(
      [pageSource('<for i of={1..250}><p>{i}</p></for>')],
      {
        bindings: { collection: COLLECTION },
        now: () => {
          calls += 1;
          return calls === 1 ? 0 : 10_000;
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4003');
  });

  it('output cap trips O4004', () => {
    const result = renderPage(
      [pageSource('<for i of={1..250}><p>xxxxxxxxxxxxxxxxxxxx</p></for>')],
      { bindings: { collection: COLLECTION }, maxOutput: 200 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4004');
  });

  it('division by zero is a render error, not Infinity in the output', () => {
    const result = renderPage(
      [pageSource('<p>{10 / size(collection.products)}</p>')],
      { bindings: { collection: { title: 'x', products: [] } } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4013');
  });

  it('data violating declared types fails loudly (O4012), never renders blanks', () => {
    const result = renderPage(
      [pageSource('<p>{first(collection.products)?.title ?? "-"}</p><p>{collection.title}</p>')],
      { bindings: { collection: { title: null, products: [] } } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4012');
  });
});

describe('determinism + statelessness (W-17, W-32)', () => {
  const files = [
    pageSource('<h1>{collection.title}</h1><for p of={collection.products}><p>{p.title}: {money(p.price)}</p></for>'),
  ];

  it('same program + data + options => byte-identical output', () => {
    const opts: RenderOptions = { bindings: { collection: COLLECTION } };
    const a = renderOkPage(files, opts).html;
    const b = renderOkPage(files, opts).html;
    expect(a).toBe(b);
  });

  it('back-to-back renders for different stores share no state', () => {
    const program = compileOk(files);
    const storeA = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'Store A', products: [product({ title: 'Alpha' })] } },
    });
    const storeB = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'Store B', products: [product({ title: 'Beta', price: money(100) })] } },
    });
    if (!storeA.ok || !storeB.ok) throw new Error('render failed');
    expect(storeA.html).toContain('Alpha');
    expect(storeA.html).not.toContain('Beta');
    expect(storeB.html).toContain('Beta');
    expect(storeB.html).not.toContain('Alpha');
    expect(storeB.html).not.toContain('Store A');
  });
});

describe('components and slots at runtime', () => {
  it('props default when omitted; slot content renders in the caller scope', () => {
    const files: SourceFile[] = [
      cardSource(
        '<article><h3>{product.title}</h3><if {showVendor}><em>{product.vendor ?? "-"}</em></if><slot name="badge"/></article>',
        'slots { badge? }\n',
      ),
      pageSource('<for p of={collection.products}><Card product={p}><if {p.isNew}><span slot="badge">New</span></if></Card></for>'),
    ];
    const { html } = renderOkPage(files, {
      bindings: { collection: { title: 'x', products: [product({ isNew: true })] } },
    });
    expect(html).toBe('<article><h3>Widget</h3><span>New</span></article>');
  });
});
