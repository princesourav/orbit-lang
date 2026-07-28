import { describe, expect, it } from 'vitest';
import { render, type RenderOptions } from './interpreter';
import { compileOk, HOST_FILTERS, money, pageSource, cardSource } from './test-host.helper';
import { type SourceFile } from './parser';
import { type RenderWarning } from './diagnostics';
import { unsafe_loadTrustedAst, serializeProgram } from './validate-ast';
import { t } from './types';
import { DEFAULT_LOCALE, STDLIB } from './stdlib';

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

function renderOkPage(
  files: readonly SourceFile[],
  options: RenderOptions = {},
): { html: string; warnings: RenderWarning[] } {
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
  const HOSTILE = [pageSource('<a href={first(collection.products)?.url ?? "#"}>x</a>')];
  const HOSTILE_BINDINGS = {
    collection: { title: 'x', products: [product({ url: 'javascript:alert(1)' })] },
  };

  it('blocks unsafe URLs at the sink, emits # and records a STRUCTURED warning', () => {
    const { html, warnings } = renderOkPage(HOSTILE, { bindings: HOSTILE_BINDINGS });
    expect(html).toBe('<a href="#">x</a>');
    const blocked = warnings.filter((w) => w.code === 'O4900');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.message).toContain('blocked unsafe URL in href');
    expect(blocked[0]?.template).toBe('collection');
    expect(blocked[0]?.line).toBeGreaterThan(0);
    expect(blocked[0]?.col).toBeGreaterThan(0);
  });

  it("urlPolicy: 'placeholder' is the default (backwards compatible)", () => {
    const explicit = renderOkPage(HOSTILE, { bindings: HOSTILE_BINDINGS, urlPolicy: 'placeholder' });
    const implicit = renderOkPage(HOSTILE, { bindings: HOSTILE_BINDINGS });
    expect(explicit.html).toBe(implicit.html);
  });

  it("urlPolicy: 'error' fails the render with O4037 instead of hiding a data bug", () => {
    const result = renderPage(HOSTILE, { bindings: HOSTILE_BINDINGS, urlPolicy: 'error' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4037');
    expect(result.error.message).toContain('href');
    expect(result.error.template).toBe('collection');
    expect(result.error.line).toBeGreaterThan(0);
  });

  it("urlPolicy: 'error' leaves safe URLs alone", () => {
    const { html } = renderOkPage(HOSTILE, {
      bindings: { collection: { title: 'x', products: [product({ url: '/ok' })] } },
      urlPolicy: 'error',
    });
    expect(html).toBe('<a href="/ok">x</a>');
  });
});

describe('srcset is a candidate list, not a URL (W-11c)', () => {
  const files = [pageSource('<img src="/a.jpg" srcset={collection.title} alt="x">')];
  const withSrcset = (srcset: string, options: RenderOptions = {}) =>
    renderPage(files, { bindings: { collection: { title: srcset, products: [] } }, ...options });

  const okSrcset = (srcset: string): string => {
    const r = withSrcset(srcset);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.html;
  };

  it('passes a well-formed multi-candidate list through, canonically re-serialized', () => {
    expect(okSrcset('/a.jpg 1x, /b.jpg 2x')).toContain('srcset="/a.jpg 1x, /b.jpg 2x"');
    expect(okSrcset('/a.jpg 400w,/b.jpg 800w')).toContain('srcset="/a.jpg 400w, /b.jpg 800w"');
    expect(okSrcset('/only.jpg')).toContain('srcset="/only.jpg"');
    expect(okSrcset('  /a.jpg   1.5x  ,   /b.jpg  ')).toContain('srcset="/a.jpg 1.5x, /b.jpg"');
    // A trailing comma ends a descriptor-less candidate (WHATWG rule); a
    // comma with no whitespace after it stays INSIDE the URL token.
    expect(okSrcset('/a.jpg, /b.jpg 2x')).toContain('srcset="/a.jpg, /b.jpg 2x"');
    expect(okSrcset('/a,b.jpg 2x')).toContain('srcset="/a,b.jpg 2x"');
  });

  it('blocks a hostile scheme hiding in a NON-FIRST candidate (the v0.1 hole)', () => {
    const result = withSrcset('/a.jpg 1x, javascript:alert(1) 2x');
    if (!result.ok) throw new Error('expected placeholder policy to succeed');
    expect(result.html).toContain('srcset=""');
    expect(result.html).not.toContain('javascript');
    const blocked = result.warnings.filter((w) => w.code === 'O4900');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.message).toContain('candidate 2');
  });

  it('rejects malformed descriptors without regex backtracking', () => {
    for (const bad of ['/a.jpg 1y', '/a.jpg xx', '/a.jpg 0w', '/a.jpg 1.5w', '/a.jpg -2x', '/a.jpg 2 x']) {
      const r = withSrcset(bad);
      if (!r.ok) throw new Error('expected placeholder policy to succeed');
      expect(r.html, bad).toContain('srcset=""');
    }
  });

  it("fails the whole attribute under urlPolicy: 'error'", () => {
    const result = withSrcset('/a.jpg 1x, vbscript:x 2x', { urlPolicy: 'error' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4037');
    expect(result.error.message).toContain('srcset');
  });

  it('blanks (never "#"-fills) a rejected srcset so no candidate is fetched', () => {
    const r = withSrcset('//evil.example 1x');
    if (!r.ok) throw new Error('expected placeholder policy to succeed');
    expect(r.html).toContain('srcset=""');
    expect(r.html).not.toContain('srcset="#"');
  });
});

describe('host filters are untrusted foreign code (W-34c)', () => {
  const boomFilters = [
    ...HOST_FILTERS,
    {
      name: 'boom',
      params: [t.string()],
      returns: t.string(),
      impl: (): never => {
        throw new TypeError('host internals: db pool exhausted at /srv/app/db.ts:41');
      },
    },
  ];

  const files = [pageSource('<p>{boom(collection.title)}</p>')];

  it('a throwing host filter becomes O4036, not an unhandled exception', () => {
    const program = compileOk(files, boomFilters);
    const result = render(program, 'collection', {
      hostFilters: boomFilters,
      bindings: { collection: { title: 'x', products: [] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4036');
    expect(result.error.template).toBe('collection');
    expect(result.error.line).toBeGreaterThan(0);
  });

  it('names the filter and the throw kind, but never the host message or stack', () => {
    const program = compileOk(files, boomFilters);
    const result = render(program, 'collection', {
      hostFilters: boomFilters,
      bindings: { collection: { title: 'x', products: [] } },
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('"boom"');
    expect(result.error.message).toContain('TypeError');
    expect(result.error.message).not.toContain('db pool');
    expect(result.error.message).not.toContain('db.ts');
  });

  it('a non-Error throw is handled too', () => {
    const filters = [
      ...HOST_FILTERS,
      { name: 'boom', params: [t.string()], returns: t.string(), impl: (): never => { throw 'a bare string'; } },
    ];
    const program = compileOk(files, filters);
    const result = render(program, 'collection', {
      hostFilters: filters,
      bindings: { collection: { title: 'x', products: [] } },
    });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('O4036');
    expect(result.error.message).not.toContain('a bare string');
  });

  it('the deadline is checked AROUND the call, so a slow filter aborts the render', () => {
    // The clock only advances while the host filter is running: with the
    // v0.1 code (charge output only) this rendered fine.
    let clock = 0;
    const slow = [
      ...HOST_FILTERS,
      {
        name: 'slow',
        params: [t.string()],
        returns: t.string(),
        impl: (args: readonly unknown[]): string => {
          clock += 10_000;
          return String(args[0]);
        },
      },
    ];
    const program = compileOk([pageSource('<p>{slow(collection.title)}</p>')], slow);
    const result = render(program, 'collection', {
      hostFilters: slow,
      bindings: { collection: { title: 'x', products: [] } },
      now: () => clock,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4003');
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

  it('falls back to declared defaults on invalid values, with a structured warning', () => {
    const { html, warnings } = renderOkPage(files, {
      bindings: { collection: COLLECTION },
      settings: { collection: { variant: 'zzz' } },
    });
    expect(html).toBe('<p class="v--a">hi</p>');
    const invalid = warnings.filter((w) => w.code === 'O4901');
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.message).toContain('collection.variant');
    expect(invalid[0]?.line).toBeGreaterThan(0);
  });

  it('a Color setting must be six real hex digits, not just "#" + length 7', () => {
    const colorFiles = [
      pageSource('<p class="c">{settings.brand}</p>', 'settings {\n  brand: Color = #112233\n}\n'),
    ];
    const good = renderOkPage(colorFiles, {
      bindings: { collection: COLLECTION },
      settings: { collection: { brand: '#AABBCC' } },
    });
    expect(good.html).toBe('<p class="c">#AABBCC</p>');
    expect(good.warnings).toHaveLength(0);

    // `#<scrip"` is exactly 7 characters and starts with '#'.
    for (const hostile of ['#<scrip"', '#zzzzzz', '#12345', '#1234567', 'aabbccd']) {
      const bad = renderOkPage(colorFiles, {
        bindings: { collection: COLLECTION },
        settings: { collection: { brand: hostile } },
      });
      expect(bad.html, hostile).toBe('<p class="c">#112233</p>');
      expect(bad.warnings.map((w) => w.code), hostile).toContain('O4901');
    }
  });
});

describe('warnings are structured and bounded', () => {
  it('records an O4902 when a trustedHtml filter emits raw HTML', () => {
    const { html, warnings } = renderOkPage([pageSource('<div>{rawHtml(collection.title)}</div>')], {
      bindings: { collection: { title: '<b>x</b>', products: [] } },
    });
    expect(html).toBe('<div><b>x</b></div>');
    expect(warnings.map((w) => w.code)).toContain('O4902');
  });

  it('stays silent for a sanitizer filter, so the warning list is an audit surface', () => {
    // Ten calls, zero warnings. A list that includes every correct rich-text
    // field is a census, not an audit.
    const body = Array.from({ length: 10 }, () => '<div>{richtext(collection.title)}</div>').join('');
    const { html, warnings } = renderOkPage([pageSource(body)], {
      bindings: { collection: { title: '<b>x</b>', products: [] } },
    });
    expect(html).toContain('<b>x</b>');
    expect(warnings.map((w) => w.code)).not.toContain('O4902');
  });

  it('carries the trusted marker across a component boundary', () => {
    // The obligation travels ON the value: by the time it reaches the sink it
    // has crossed a prop boundary, and there is nothing there to look up.
    const { warnings } = renderOkPage(
      [
        pageSource('<RichText content={rawHtml(collection.title)}/>'),
        { name: 'rich.orbit', source: '---\ncomponent RichText\nprops {\n  content: Html\n}\n---\n<div>{content}</div>' },
      ],
      { bindings: { collection: { title: '<b>x</b>', products: [] } } },
    );
    expect(warnings.map((w) => w.code)).toContain('O4902');
  });

  it('does not invent a warning for sanitized Html crossing a component boundary', () => {
    const { html, warnings } = renderOkPage(
      [
        pageSource('<RichText content={richtext(collection.title)}/>'),
        { name: 'rich.orbit', source: '---\ncomponent RichText\nprops {\n  content: Html\n}\n---\n<div>{content}</div>' },
      ],
      { bindings: { collection: { title: '<b>x</b>', products: [] } } },
    );
    expect(html).toBe('<div><b>x</b></div>');
    expect(warnings.map((w) => w.code)).not.toContain('O4902');
  });

  it('caps the warning list and says so instead of growing without bound', () => {
    const { warnings } = renderOkPage(
      [pageSource('<for p of={collection.products}><a href={p.url}>x</a></for>')],
      {
        bindings: {
          collection: {
            title: 'x',
            products: Array.from({ length: 250 }, () => product({ url: 'javascript:alert(1)' })),
          },
        },
      },
    );
    expect(warnings.length).toBeLessThanOrEqual(101);
    expect(warnings[warnings.length - 1]?.code).toBe('O4909');
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

describe('component-entry props are runtime-validated (W-34b)', () => {
  const TYPED: SourceFile = {
    name: 'components/typed.orbit',
    source: `---
component Typed
props {
  title: String
  count: Int
  ratio: Float
  flag: Bool
  hue: Color
  tags: List<String>
  note: String?
  fallback: Int = 7
}
---
<p>{title}{count}</p>`,
  };

  const OK_PROPS = {
    title: 'a',
    count: 1,
    ratio: 1.5,
    flag: true,
    hue: '#aabbcc',
    tags: ['x'],
  };

  function renderTyped(props: Record<string, unknown>) {
    return render(compileOk([TYPED]), 'Typed', { hostFilters: HOST_FILTERS, props });
  }

  it('accepts a well-shaped prop set (optionals and defaults may be omitted)', () => {
    const result = renderTyped(OK_PROPS);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(result.html).toBe('<p>a1</p>');
  });

  it('fails with O4038 naming the prop and the expected vs actual shape', () => {
    const cases: [string, unknown, string][] = [
      ['title', 42, 'String'],
      ['count', 1.5, 'Int'],
      ['count', '3', 'Int'],
      ['ratio', 'x', 'Float'],
      ['flag', 'true', 'Bool'],
      ['hue', '#<scrip"', 'Color'],
      ['tags', 'x', 'List<String>'],
      ['tags', { 0: 'x' }, 'List<String>'],
      ['note', 5, 'String?'],
    ];
    for (const [prop, value, expected] of cases) {
      const result = renderTyped({ ...OK_PROPS, [prop]: value });
      expect(result.ok, `${prop}=${JSON.stringify(value)}`).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('O4038');
      expect(result.error.message).toContain(JSON.stringify(prop));
      expect(result.error.message).toContain(expected);
      expect(result.error.message).toContain('got ');
    }
  });

  it('Int is accepted where Float is declared (matching `assignable`)', () => {
    const result = renderTyped({ ...OK_PROPS, ratio: 2 });
    expect(result.ok).toBe(true);
  });

  it('a required prop with no default cannot simply be omitted', () => {
    const { title: _omitted, ...rest } = OK_PROPS;
    const result = renderTyped(rest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('O4038');
    expect(result.error.message).toContain('required prop "title"');
  });

  it('optionals accept none explicitly; declared defaults still apply', () => {
    const result = renderTyped({ ...OK_PROPS, note: null });
    expect(result.ok).toBe(true);
  });

  it('validation is O(props): a huge list prop is not walked', () => {
    const huge = Array.from({ length: 200_000 }, (_v, i) => String(i));
    const result = renderTyped({ ...OK_PROPS, tags: huge });
    expect(result.ok).toBe(true);
  });

  it('warns (O4903) about supplied props the component never declared', () => {
    const result = renderTyped({ ...OK_PROPS, nope: 1 });
    if (!result.ok) throw new Error('expected success');
    expect(result.warnings.map((w) => w.code)).toContain('O4903');
  });

  it('host object/opaque props are checked for presence only (representation is host-private)', () => {
    const card = cardSource('<p>{product.title}</p>');
    const program = compileOk([card]);
    const missing = render(program, 'Card', { hostFilters: HOST_FILTERS, props: { product: null } });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe('O4038');

    const present = render(program, 'Card', { hostFilters: HOST_FILTERS, props: { product: product() } });
    expect(present.ok).toBe(true);
  });
});

describe('prototype pollution cannot reach anything (W-36d)', () => {
  it('a filter named __proto__ / constructor / prototype resolves to nothing', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(STDLIB.get(name)).toBeUndefined();
      expect(STDLIB.has(name)).toBe(false);
    }
  });

  it('the stdlib registry is frozen and exposes no mutator', () => {
    const asAny = STDLIB as unknown as Record<string, unknown>;
    expect(asAny['set']).toBeUndefined();
    expect(asAny['delete']).toBeUndefined();
    expect(asAny['clear']).toBeUndefined();
    expect(Object.isFrozen(STDLIB)).toBe(true);
    expect(Object.getPrototypeOf(STDLIB)).toBeNull();
  });

  it('member access to a reserved property fails with O4039, never returns Object.prototype', () => {
    for (const property of ['__proto__', 'constructor', 'prototype']) {
      const program = poisonedMemberProgram(property);
      const result = render(program, 'collection', {
        hostFilters: HOST_FILTERS,
        bindings: { collection: COLLECTION },
      });
      expect(result.ok, property).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('O4039');
    }
  });

  it('inherited members are invisible: only OWN data properties are readable', () => {
    const proto = { secret: 'leaked' };
    const data = Object.create(proto) as Record<string, unknown>;
    data['title'] = 'own';
    data['products'] = [];
    const result = renderPage([pageSource('<p>{collection.title}</p>')], {
      bindings: { collection: data },
    });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(result.html).toBe('<p>own</p>');
    expect(result.html).not.toContain('leaked');
  });

  it('a prop named __proto__ supplied by the host is ignored, not merged', () => {
    const program = compileOk([cardSource('<p>{product.title}</p>')]);
    const props = JSON.parse('{"product": {"title": "ok"}, "__proto__": {"polluted": true}}') as Record<
      string,
      unknown
    >;
    const result = render(program, 'Card', { hostFilters: HOST_FILTERS, props });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    expect(result.html).toBe('<p>ok</p>');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('sortBy/where keys cannot reach the prototype chain', () => {
    const sortBy = STDLIB.get('sortBy');
    const where = STDLIB.get('where');
    const rt = {
      fail: (code: string, message: string): never => {
        throw new Error(`${code}: ${message}`);
      },
      capString: (s: string) => s,
      capList: <T,>(l: readonly T[]) => l,
      locale: DEFAULT_LOCALE,
    };
    const items = [{ a: 1 }, { a: 2 }];
    expect(sortBy?.eval([items, 'constructor'], rt)).toEqual(items);
    expect(where?.eval([items, '__proto__', Object.prototype], rt)).toEqual([]);
    expect(where?.eval([items, 'prototype', undefined], rt)).toEqual([]);
  });
});

/** Rewrites the page's first interpolation into `collection.<property>`. */
function poisonedMemberProgram(property: string) {
  const program = compileOk([pageSource('<p>{collection.title}</p>')]);
  const data = JSON.parse(JSON.stringify(serializeProgram(program))) as {
    templates: Record<string, { body: unknown[] }>;
  };
  // <p>{…}</p> — the interpolation is the element's only child.
  const element = data.templates['collection']?.body[0] as { children: { expr: { property: string } }[] };
  const child = element.children[0];
  if (child === undefined) throw new Error('unexpected AST shape');
  child.expr.property = property;
  return unsafe_loadTrustedAst(data);
}

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
