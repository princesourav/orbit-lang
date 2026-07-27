import { describe, expect, it } from 'vitest';
import { cardSource, compile, pageSource } from './test-host.helper';
import { type SourceFile } from './parser';

function errorsOf(files: readonly SourceFile[]) {
  const { result } = compile(files);
  return result.diagnostics.filter((d) => d.severity === 'error');
}

function warningsOf(files: readonly SourceFile[]) {
  const { result } = compile(files);
  return result.diagnostics.filter((d) => d.severity === 'warning');
}

function expectCodes(files: readonly SourceFile[], codes: string[]) {
  expect(errorsOf(files).map((d) => d.code)).toEqual(codes);
}

describe('no truthiness (O3007)', () => {
  it('rejects non-Bool <if> conditions', () => {
    expectCodes([cardSource('<if {product.title}><p>x</p></if>')], ['O3007']);
  });

  it('rejects optional conditions with a != none fix-it', () => {
    const errors = errorsOf([cardSource('<if {product.vendor}><p>x</p></if>')]);
    expect(errors[0]?.code).toBe('O3007');
    expect(errors[0]?.suggestion).toContain('product.vendor != none');
  });

  it('requires Bool on both sides of && and ||', () => {
    expectCodes([cardSource('<if {showVendor && product.title}><p>x</p></if>')], ['O3007']);
  });
});

describe('the optional law (O2104)', () => {
  it('rejects interpolating an optional without a fallback', () => {
    const errors = errorsOf([cardSource('<p>{product.vendor}</p>')]);
    expect(errors[0]?.code).toBe('O2104');
    expect(errors[0]?.suggestion).toContain('product.vendor ?? ');
  });

  it('?? satisfies the law', () => {
    expectCodes([cardSource('<p>{product.vendor ?? "-"}</p>')], []);
  });

  it('flow-narrowing via != none satisfies the law', () => {
    expectCodes([cardSource('<if {product.vendor != none}><p>{product.vendor}</p></if>')], []);
  });

  it('narrowing propagates through && to the right operand and body', () => {
    expectCodes(
      [cardSource('<if {showVendor && product.vendor != none}><p>{product.vendor}</p></if>')],
      [],
    );
  });

  it('|| does NOT narrow (escape attempt)', () => {
    const errors = errorsOf([
      cardSource('<if {product.vendor != none || product.rating != none}><p>{product.vendor}</p></if>'),
    ]);
    expect(errors.map((d) => d.code)).toEqual(['O2104']);
  });

  it('== none narrows the else branch', () => {
    expectCodes(
      [cardSource('<if {product.vendor == none}><p>-</p></if><else><p>{product.vendor}</p></else>')],
      [],
    );
  });

  it('else-if conditions see prior branches’ false-narrowing', () => {
    expectCodes(
      [cardSource('<if {product.vendor == none}><p>-</p></if><else-if {product.vendor != ""}><p>{product.vendor}</p></else-if>')],
      [],
    );
  });

  it('member access on an optional base needs ?. or narrowing', () => {
    const errors = errorsOf([pageSource('<p>{first(collection.products).title}</p>')]);
    expect(errors[0]?.code).toBe('O2104');
  });

  it('?. produces an optional that still needs a fallback at the sink', () => {
    expectCodes([pageSource('<p>{first(collection.products)?.title ?? "-"}</p>')], []);
  });

  it('optionals cannot flow into filters or arithmetic', () => {
    expectCodes([cardSource('<p>{upper(product.vendor)}</p>')], ['O2104']);
    expectCodes([cardSource('<p>{product.rating + 1}</p>')], ['O2104']);
  });

  it('list indexing is optional (out-of-range is none)', () => {
    expectCodes([cardSource('<p>{product.tags[0]}</p>')], ['O2104']);
    expectCodes([cardSource('<p>{product.tags[0] ?? "-"}</p>')], []);
  });
});

describe('unknown names carry suggestions', () => {
  it('did-you-mean on properties', () => {
    const errors = errorsOf([cardSource('<p>{product.titel}</p>')]);
    expect(errors[0]?.code).toBe('O2031');
    expect(errors[0]?.suggestion).toContain('title');
  });

  it('unknown identifier and unknown filter', () => {
    expect(errorsOf([cardSource('<p>{produkt.title}</p>')])[0]?.code).toBe('O2030');
    const errors = errorsOf([cardSource('<p>{product.title |> uper}</p>')]);
    expect(errors[0]?.code).toBe('O2070');
    expect(errors[0]?.suggestion).toContain('upper');
  });
});

describe('Money terminality (W-23/W-24)', () => {
  it('Money cannot render, has no properties, admits no operators', () => {
    expect(errorsOf([cardSource('<p>{product.price}</p>')])[0]?.code).toBe('O2060');
    expect(errorsOf([cardSource('<p>{product.price.amountMinor}</p>')])[0]?.code).toBe('O2060');
    expect(errorsOf([cardSource('<if {product.price == product.price}><p>x</p></if>')])[0]?.code).toBe('O2066');
  });

  it('Money cannot reach stdlib filters, only declared host filters', () => {
    expect(errorsOf([cardSource('<p>{upper(product.price)}</p>')])[0]?.code).toBe('O2060');
    expectCodes([cardSource('<p>{money(product.price)}</p>')], []);
  });

  it('MoneyText renders (incl. attributes) but admits no filters', () => {
    expectCodes([cardSource('<p data-price={money(product.price)}>{money(product.price)}</p>')], []);
    expect(errorsOf([cardSource('<p>{money(product.price) |> upper}</p>')])[0]?.code).toBe('O2062');
  });

  it('Image is opaque: never rendered, only host-filter input', () => {
    expect(errorsOf([cardSource('<p>{product.cover}</p>')])[0]?.code).toBe('O2061');
    expectCodes([cardSource('<img src={imgUrl(product.cover, 480)} alt={product.title}>')], []);
  });
});

describe('Html terminality (W-13)', () => {
  it('renders only in element content, with a warning at the unsafe filter', () => {
    const files = [cardSource('<div>{richtext(product.title)}</div>')];
    expectCodes(files, []);
    expect(warningsOf(files).map((d) => d.code)).toContain('O2071');
  });

  it('never in attributes, bindings, filters, props or RCDATA', () => {
    expect(errorsOf([cardSource('<div title={richtext(product.title)}>x</div>')])[0]?.code).toBe('O2076');
    expect(errorsOf([cardSource('<let x={richtext(product.title)}/>')])[0]?.code).toBe('O2079');
    expect(errorsOf([cardSource('<p>{upper(richtext(product.title))}</p>')])[0]?.code).toBe('O2063');
    expect(errorsOf([cardSource('<title>{richtext(product.title)}</title>')])[0]?.code).toBe('O2075');
    const files: SourceFile[] = [
      cardSource('<Inner text={richtext(product.title)}/>'),
      { name: 'inner.orbit', source: '---\ncomponent Inner\nprops { text: String }\n---\n<p>{text}</p>' },
    ];
    expect(errorsOf(files)[0]?.code).toBe('O2011');
  });
});

describe('json-ld typing (W-10)', () => {
  it('accepts records of primitives/lists', () => {
    expectCodes(
      [cardSource('<json-ld>{ {name: product.title, tags: product.tags, ok: true} }</json-ld>')],
      [],
    );
  });

  it('rejects Money, MoneyText, Html and nominal objects at type level', () => {
    expect(errorsOf([cardSource('<json-ld>{ {price: product.price} }</json-ld>')])[0]?.code).toBe('O2090');
    expect(errorsOf([cardSource('<json-ld>{ {p: money(product.price)} }</json-ld>')])[0]?.code).toBe('O2090');
    expect(errorsOf([cardSource('<json-ld>{ {p: product} }</json-ld>')])[0]?.code).toBe('O2090');
  });
});

describe('component contracts', () => {
  const inner: SourceFile = {
    name: 'inner.orbit',
    source: '---\ncomponent Inner\nprops {\n  label: String\n  count: Int = 0\n}\nslots { badge }\n---\n<p>{label}<slot name="badge"/></p>',
  };

  it('checks required props, unknown props and types', () => {
    expect(errorsOf([inner, cardSource('<Inner><span slot="badge">b</span></Inner>')])[0]?.code).toBe('O2084');
    const unknown = errorsOf([inner, cardSource('<Inner label="x" wat={1}><span slot="badge">b</span></Inner>')]);
    expect(unknown[0]?.code).toBe('O2082');
    expect(errorsOf([inner, cardSource('<Inner label={3}><span slot="badge">b</span></Inner>')])[0]?.code).toBe('O2083');
    expectCodes([inner, cardSource('<Inner label={product.title} count={2}><span slot="badge">b</span></Inner>')], []);
  });

  it('enforces slot contracts: required, undeclared, no-default', () => {
    expect(errorsOf([inner, cardSource('<Inner label="x"/>')])[0]?.code).toBe('O2087');
    expect(
      errorsOf([inner, cardSource('<Inner label="x"><span slot="badge">b</span><span slot="nope">c</span></Inner>')])[0]?.code,
    ).toBe('O2086');
    expect(
      errorsOf([inner, cardSource('<Inner label="x"><span slot="badge">b</span><p>stray default</p></Inner>')])[0]?.code,
    ).toBe('O2086');
  });

  it('slot attribution propagates through <if> wrappers, mixed targets are errors', () => {
    expectCodes(
      [inner, cardSource('<Inner label="x"><if {showVendor}><span slot="badge">b</span></if></Inner>')],
      [],
    );
    const mixed = errorsOf([
      inner,
      cardSource('<Inner label="x"><if {showVendor}><span slot="badge">b</span><span slot="other">c</span></if></Inner>'),
    ]);
    expect(mixed.map((d) => d.code)).toContain('O2085');
  });

  it('pages are unreachable as components (lowercase = element namespace) and cycles are detected', () => {
    expect(errorsOf([pageSource('<p>x</p>'), cardSource('<Collection/>')]).map((d) => d.code)).toContain('O2080');
    const a: SourceFile = { name: 'a.orbit', source: '---\ncomponent Alpha\n---\n<div><Beta/></div>' };
    const b: SourceFile = { name: 'b.orbit', source: '---\ncomponent Beta\n---\n<div><Alpha/></div>' };
    expect(errorsOf([a, b]).map((d) => d.code)).toContain('O2091');
  });

  it('pages cannot use <slot>', () => {
    expect(errorsOf([pageSource('<slot/>')])[0]?.code).toBe('O2088');
  });
});

describe('loops and ranges (W-05a)', () => {
  it('subject must be a List or Range', () => {
    expect(errorsOf([cardSource('<for x of={product.title}><p>{x}</p></for>')])[0]?.code).toBe('O2077');
    expectCodes([cardSource('<for tag of={product.tags}><p>{tag}</p></for>')], []);
    expectCodes([cardSource('<for i of={1..5}><p>{i}</p></for>')], []);
  });

  it('limit must be a literal within the cap', () => {
    expect(errorsOf([cardSource('<for t of={product.tags} limit={showVendor ? 1 : 2}><p>{t}</p></for>')])[0]?.code).toBe('O2078');
    expect(errorsOf([cardSource('<for t of={product.tags} limit={9999}><p>{t}</p></for>')])[0]?.code).toBe('O2078');
  });

  it('range bounds must be literal ints and span <= the loop cap', () => {
    const files = [cardSource('<let n={5}/><for i of={1..n}><p>{i}</p></for>')];
    expect(errorsOf(files)[0]?.code).toBe('O2050');
    expect(errorsOf([cardSource('<for i of={1..9999}><p>{i}</p></for>')])[0]?.code).toBe('O2051');
  });
});

describe('settings typing', () => {
  it('select settings are string-literal unions usable as strings', () => {
    expectCodes(
      [
        cardSource('<div class="card--{settings.ratio}"><if {settings.ratio == "wide"}><p>w</p></if></div>', 'settings {\n  ratio: Select("square", "wide") = "square"\n}\n'),
      ],
      [],
    );
  });

  it('bad defaults are rejected', () => {
    expect(
      errorsOf([cardSource('<p>x</p>', 'settings {\n  ratio: Select("a", "b") = "c"\n}\n')])[0]?.code,
    ).toBe('O2015');
    expect(
      errorsOf([cardSource('<p>x</p>', 'settings {\n  per: Range(12, 48) = 60\n}\n')])[0]?.code,
    ).toBe('O2015');
  });
});

describe('operators', () => {
  it('no string concatenation via +', () => {
    const errors = errorsOf([cardSource('<p>{product.title + "!"}</p>')]);
    expect(errors[0]?.code).toBe('O2037');
    expect(errors[0]?.suggestion).toContain('interpolation');
  });

  it('/ yields Float; % needs Ints', () => {
    expectCodes([cardSource('<p>{10 / 4}</p>')], []);
    expect(errorsOf([cardSource('<p>{10.5 % 2}</p>')])[0]?.code).toBe('O2037');
  });

  it('comparing incompatible types is an error; none vs non-optional warns', () => {
    expect(errorsOf([cardSource('<if {product.title == 3}><p>x</p></if>')])[0]?.code).toBe('O2066');
    const warnings = warningsOf([cardSource('<if {product.title != none}><p>x</p></if>')]);
    expect(warnings.map((d) => d.code)).toContain('O2065');
  });

  it('?? on a never-none left side warns', () => {
    const warnings = warningsOf([cardSource('<p>{product.title ?? "x"}</p>')]);
    expect(warnings.map((d) => d.code)).toContain('O2072');
  });
});

describe('URL attribute typing (W-11)', () => {
  it('URL attributes accept Url and String, not Int', () => {
    expectCodes([cardSource('<a href={product.url}>x</a>')], []);
    expectCodes([cardSource('<a href="/products/{product.title |> slugify}">x</a>')], []);
    expect(errorsOf([cardSource('<a href={3}>x</a>')])[0]?.code).toBe('O2064');
  });
});
