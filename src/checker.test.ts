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

  // Both opaques reaching a stdlib filter used to report O2060, which made
  // that code mean "Money is terminal" AND "Image is terminal" while O2061
  // already meant the latter. Each opaque now keeps one code in every context.
  it('Image reaching a stdlib filter reports O2061, not Money’s O2060', () => {
    const imageErr = errorsOf([cardSource('<p>{upper(product.cover)}</p>')])[0];
    expect(imageErr?.code).toBe('O2061');
    expect(imageErr?.message).toContain('Image');
    const moneyErr = errorsOf([cardSource('<p>{upper(product.price)}</p>')])[0];
    expect(moneyErr?.code).toBe('O2060');
    expect(moneyErr?.message).toContain('Money');
  });
});

describe('Html terminality', () => {
  it('renders in element content with NO warning for a sanitizer filter', () => {
    // The sanctioned path must be silent. A real theme calls a sanitizer at
    // dozens of sites; warning on each one buries the diagnostic that means
    // "a human must look here" under diagnostics that mean "this is correct".
    const files = [cardSource('<div>{richtext(product.title)}</div>')];
    expectCodes(files, []);
    expect(warningsOf(files).map((d) => d.code)).not.toContain('O2071');
  });

  it('warns at every use site of a trustedHtml filter', () => {
    const files = [cardSource('<div>{rawHtml(product.title)}</div>')];
    expectCodes(files, []);
    expect(warningsOf(files).map((d) => d.code)).toContain('O2071');
  });

  it('stays silent across ten sanitizer calls, and warns ten times for trustedHtml', () => {
    const ten = (fn: string) => Array.from({ length: 10 }, () => `<div>{${fn}(product.title)}</div>`).join('');
    expect(warningsOf([cardSource(ten('richtext'))]).filter((d) => d.code === 'O2071')).toHaveLength(0);
    expect(warningsOf([cardSource(ten('rawHtml'))]).filter((d) => d.code === 'O2071')).toHaveLength(10);
  });

  it('points the trustedHtml warning at the declaration, not the template', () => {
    // Nothing the template author writes resolves this; only the embedder can.
    const warning = warningsOf([cardSource('<div>{rawHtml(product.title)}</div>')]).find(
      (d) => d.code === 'O2071',
    );
    expect(warning?.suggestion).toContain('where "rawHtml" is declared');
  });

  it('never in attributes, bindings, non-transform filters, mistyped props or RCDATA', () => {
    expect(errorsOf([cardSource('<div title={richtext(product.title)}>x</div>')])[0]?.code).toBe('O2076');
    expect(errorsOf([cardSource('<let x={richtext(product.title)}/>')])[0]?.code).toBe('O2079');
    expect(errorsOf([cardSource('<p>{upper(richtext(product.title))}</p>')])[0]?.code).toBe('O2063');
    expect(errorsOf([cardSource('<title>{richtext(product.title)}</title>')])[0]?.code).toBe('O2075');
    // Html into a String prop is still rejected — only an Html prop accepts it.
    const files: SourceFile[] = [
      cardSource('<Inner text={richtext(product.title)}/>'),
      { name: 'inner.orbit', source: '---\ncomponent Inner\nprops { text: String }\n---\n<p>{text}</p>' },
    ];
    expect(errorsOf(files)[0]?.code).toBe('O2011');
  });

  describe('crossing a component boundary', () => {
    const richText = (body: string): SourceFile => ({
      name: 'rich-text.orbit',
      source: `---\ncomponent RichText\nprops {\n  content: Html\n}\n---\n${body}\n`,
    });

    it('accepts Html passed to a prop declared Html', () => {
      // The load-bearing case: a shared RichText component owning prose
      // typography, instead of inlining the sanitizer call at every site.
      expectCodes(
        [cardSource('<RichText content={richtext(product.title)}/>'), richText('<div class="prose">{content}</div>')],
        [],
      );
    });

    it('forwards an Html prop to another component', () => {
      expectCodes(
        [
          cardSource('<RichText content={richtext(product.title)}/>'),
          richText('<Inner content={content}/>'),
          { name: 'inner.orbit', source: '---\ncomponent Inner\nprops {\n  content: Html\n}\n---\n<div>{content}</div>' },
        ],
        [],
      );
    });

    it('keeps every sink closed INSIDE the callee', () => {
      // The guarantee that makes A3 safe: restrictions are keyed on the type
      // at the sink, so they apply to a prop exactly as to a filter result.
      const at = (body: string) =>
        errorsOf([cardSource('<RichText content={richtext(product.title)}/>'), richText(body)])[0]?.code;
      expect(at('<div title={content}>x</div>')).toBe('O2076');
      expect(at('<let x={content}/>')).toBe('O2079');
      expect(at('<p>{upper(content)}</p>')).toBe('O2063');
      expect(at('<title>{content}</title>')).toBe('O2075');
    });

    it('rejects Html inside an optional or a list prop type', () => {
      // Optionality belongs on the String before sanitization, so the
      // sanitizer decides what empty input produces.
      const decl = (type: string) =>
        errorsOf([{ name: 'x.orbit', source: `---\ncomponent X\nprops {\n  content: ${type}\n}\n---\n<p>ok</p>` }])[0];
      expect(decl('Html?')?.code).toBe('O2011');
      expect(decl('List<Html>')?.code).toBe('O2011');
      expect(decl('Html?')?.suggestion).toContain('?? ""');
    });

    it('allows Html in both branches of a ternary', () => {
      // No soundness reason to forbid it: both branches are element-content
      // only, unification gives Html, and every sink check still applies.
      expectCodes(
        [cardSource('<div>{product.isNew ? richtext(product.title) : richtext(product.vendor ?? "")}</div>')],
        [],
      );
    });
  });

  describe('htmlTransform filters', () => {
    it('accepts Html as the first argument', () => {
      expectCodes([cardSource('<div>{richtext(product.title) |> truncateHtml(200)}</div>')], []);
    });

    it('is silent — the trust decision was made upstream', () => {
      const warnings = warningsOf([cardSource('<div>{richtext(product.title) |> truncateHtml(200)}</div>')]);
      expect(warnings.map((d) => d.code)).not.toContain('O2071');
    });

    it('still rejects Html for a filter that did not declare the obligation', () => {
      expect(errorsOf([cardSource('<p>{richtext(product.title) |> upper}</p>')])[0]?.code).toBe('O2063');
    });

    it('preserves the trustedHtml warning through a transform', () => {
      const warnings = warningsOf([cardSource('<div>{rawHtml(product.title) |> truncateHtml(200)}</div>')]);
      expect(warnings.map((d) => d.code)).toContain('O2071');
    });
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

  // v0.1 validated only "is the default inside the bounds?", so an inverted or
  // zero-step Range produced a control no merchant UI can render.
  describe('Range control validation', () => {
    it('rejects min > max with a swap fix-it (O2018)', () => {
      const errors = errorsOf([cardSource('<p>x</p>', 'settings {\n  per: Range(48, 12) = 24\n}\n')]);
      expect(errors[0]?.code).toBe('O2018');
      expect(errors[0]?.suggestion).toContain('Range(12, 48');
    });

    it('rejects step <= 0 (O2019)', () => {
      const zero = errorsOf([cardSource('<p>x</p>', 'settings {\n  per: Range(0, 48, step: 0) = 24\n}\n')]);
      expect(zero[0]?.code).toBe('O2019');
      expect(zero[0]?.suggestion).toContain('step: 1');
      expect(
        errorsOf([cardSource('<p>x</p>', 'settings {\n  per: Range(0, 48, step: -4) = 24\n}\n')])[0]?.code,
      ).toBe('O2019');
    });

    it('warns when the step never reaches max (O2020)', () => {
      const warnings = warningsOf([cardSource('<p>x</p>', 'settings {\n  per: Range(0, 50, step: 12) = 24\n}\n')]);
      expect(warnings[0]?.code).toBe('O2020');
      expect(warnings[0]?.suggestion).toContain('48');
    });

    it('accepts a well-formed Range with no diagnostics', () => {
      const { result } = compile([cardSource('<p>x</p>', 'settings {\n  per: Range(12, 48, step: 12) = 24\n}\n')]);
      expect(result.diagnostics).toEqual([]);
      expect(
        compile([cardSource('<p>x</p>', 'settings {\n  per: Range(1, 5) = 3\n}\n')]).result.diagnostics,
      ).toEqual([]);
    });
  });
});

describe('page props are rejected (O2017)', () => {
  it('rejects a props block on a page with a pageGlobals fix-it', () => {
    const errors = errorsOf([pageSource('<p>x</p>', 'props {\n  title: String\n}\n')]);
    expect(errors[0]?.code).toBe('O2017');
    expect(errors[0]?.message).toContain('"title"');
    expect(errors[0]?.suggestion).toContain('pageGlobals');
  });

  it('reports every declared page prop, not just the first', () => {
    const errors = errorsOf([pageSource('<p>x</p>', 'props {\n  a: String\n  b: Int\n}\n')]);
    expect(errors.map((d) => d.code)).toEqual(['O2017', 'O2017']);
  });

  it('page props are not injected into scope — the prop stays unbound', () => {
    const errors = errorsOf([pageSource('<p>{title}</p>', 'props {\n  title: String\n}\n')]);
    expect(errors.map((d) => d.code)).toEqual(['O2017', 'O2030']);
  });

  it('components keep their props', () => {
    expectCodes([cardSource('<p>{product.title}</p>')], []);
  });
});

describe('distinct diagnostic codes (v0.5 publishes the code index)', () => {
  const inner: SourceFile = {
    name: 'inner2.orbit',
    source: '---\ncomponent Inner2\nprops {\n  label: String\n  flag: Bool = false\n}\n---\n<p>{label}</p>',
  };

  it('O2082 is only "no such prop"; ?= on a real prop is O2092', () => {
    expect(errorsOf([inner, cardSource('<Inner2 label="x" nope={1}/>')])[0]?.code).toBe('O2082');
    const conditional = errorsOf([inner, cardSource('<Inner2 label="x" flag?={showVendor}/>')]);
    expect(conditional[0]?.code).toBe('O2092');
    expect(conditional[0]?.suggestion).toContain('flag={someBoolExpr}');
  });

  it('O2072 is only the redundant ??; the redundant ?. is O2093', () => {
    expect(
      warningsOf([cardSource('<p>{product.title ?? "x"}</p>')]).map((d) => d.code),
    ).toEqual(['O2072']);
    expect(
      warningsOf([cardSource('<p>{product?.title}</p>')]).map((d) => d.code),
    ).toEqual(['O2093']);
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
