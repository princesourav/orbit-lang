import { describe, expect, it } from 'vitest';

import { formatTemplate } from './formatter';
import { parseTemplate } from './parser';
import { render } from './interpreter';
import { extractAccessPlan } from './host';
import { loadCheckedAst, serializeProgram } from './validate-ast';
import { parseProgram } from './parser';
import { cardSource, compile, compileOk, HOST_FILTERS, pageSource } from './test-host.helper';

/**
 * `<match>` / `<case>` — exhaustiveness over string-literal unions.
 *
 * This is the construct whose value is a diagnostic that does not exist yet.
 * A union is a closed set the host declared; when a variant is added, every
 * `<match>` that does not handle it fails the check BY NAME. The failure it
 * replaces is a theme that silently renders nothing for a badge type someone
 * added last week.
 *
 * Which is why a union scrutinee may not carry a default arm, and a plain
 * `String` must. One rule: a default is required exactly when exhaustiveness is
 * impossible, and rejected exactly when it is possible.
 */

const SETTINGS = 'settings {\n  badge: Select("new", "sale", "restock") = "new"\n}\n';

function errors(body: string, frontmatter = SETTINGS) {
  return compile([cardSource(body, frontmatter)]).result.diagnostics.filter(
    (d) => d.severity === 'error',
  );
}

function firstParseError(body: string) {
  const source = `---\ncomponent Card\nprops {\n  product: Product\n}\n${SETTINGS}---\n${body}`;
  const result = parseTemplate(source, 'card.orbit');
  return result.ok ? undefined : result.diagnostics[0];
}

const ALL_THREE =
  '<match {settings.badge}>' +
  '<case "new"><b>New</b></case>' +
  '<case "sale"><b>Sale</b></case>' +
  '<case "restock"><b>Back</b></case>' +
  '</match>';

describe('exhaustiveness over a union', () => {
  it('accepts a match that handles every variant', () => {
    expect(errors(ALL_THREE)).toEqual([]);
  });

  it('names the missing variants — the acceptance criterion for this feature', () => {
    const [e] = errors(
      '<match {settings.badge}><case "new"><b>New</b></case></match>',
    );
    expect(e?.code).toBe('O2108');
    expect(e?.message).toContain('"sale"');
    expect(e?.message).toContain('"restock"');
    expect(e?.message).not.toContain('"new"');
  });

  it('offers the arms to add as a fix-it', () => {
    const [e] = errors('<match {settings.badge}><case "new"><b>N</b></case></match>');
    expect(e?.suggestion).toContain('<case "sale">');
    expect(e?.suggestion).toContain('<case "restock">');
  });

  it('rejects a default arm on a union, because it would switch the check off', () => {
    const [e] = errors(
      '<match {settings.badge}><case "new"><b>N</b></case><case default><b>?</b></case></match>',
    );
    expect(e?.code).toBe('O2110');
    expect(e?.message).toContain('exhaustiveness');
  });

  it('rejects a default arm even when every variant is already listed', () => {
    // Redundant today, silently absorbing tomorrow's variant. That is the
    // whole failure mode, so it is rejected while it is still harmless.
    const [e] = errors(
      ALL_THREE.replace('</match>', '<case default><b>?</b></case></match>'),
    );
    expect(e?.code).toBe('O2110');
  });
});

describe('unreachable arms', () => {
  it('rejects a value that is not one of the variants, and suggests the near one', () => {
    const [e] = errors(
      ALL_THREE.replace('<case "restock">', '<case "restok">').replace('Back</b></case>', 'Back</b></case><case "restock"><b>B</b></case>'),
    );
    expect(e?.code).toBe('O2109');
    expect(e?.suggestion).toContain('restock');
  });

  it('rejects the same value twice', () => {
    const [e] = errors(
      ALL_THREE.replace('</match>', '<case "new"><b>again</b></case></match>'),
    );
    expect(e?.code).toBe('O2109');
    expect(e?.message).toContain('already handled');
  });

  it('rejects an arm after the default arm', () => {
    const [e] = errors(
      '<match {product.title}><case default><b>?</b></case><case "x"><b>x</b></case></match>',
    );
    expect(e?.code).toBe('O2109');
    expect(e?.message).toContain('after the default');
  });

  it('rejects two default arms', () => {
    const [e] = errors(
      '<match {product.title}><case default><b>a</b></case><case default><b>b</b></case></match>',
    );
    expect(e?.code).toBe('O2109');
  });
});

describe('scrutinee types', () => {
  it('requires a default arm on a plain String, which is not a closed set', () => {
    const [e] = errors('<match {product.title}><case "x"><b>x</b></case></match>');
    expect(e?.code).toBe('O2111');
  });

  it('accepts a String with a default arm', () => {
    expect(errors('<match {product.title}><case "x"><b>x</b></case><case default><b>?</b></case></match>')).toEqual([]);
  });

  it('rejects a Bool and points at <if>', () => {
    const [e] = errors('<match {product.isNew}><case default><b>?</b></case></match>');
    expect(e?.code).toBe('O2107');
    expect(e?.suggestion).toContain('<if>');
  });

  it('rejects an Int', () => {
    expect(errors('<match {1}><case default><b>?</b></case></match>')[0]?.code).toBe('O2107');
  });

  it('does not exempt the subject from the optional law', () => {
    const [e] = errors('<match {product.vendor}><case default><b>?</b></case></match>');
    expect(e?.code).toBe('O2104');
  });

  it('checks the arms even when the subject is bad, so one mistake is not two rounds', () => {
    const found = errors('<match {product.isNew}><case default><b>{product.vendor}</b></case></match>');
    expect(found.map((d) => d.code)).toContain('O2107');
    expect(found.map((d) => d.code)).toContain('O2104');
  });
});

describe('grammar', () => {
  it('rejects <match> without a subject', () => {
    expect(firstParseError('<match><case default><b>x</b></case></match>')?.code).toBe('O1107');
  });

  it('rejects markup between the arms', () => {
    // Rejected at the arm boundary rather than allowed through and reported as
    // some downstream type error, which is where a stray `<p>` would otherwise
    // surface.
    const d = firstParseError('<match {product.title}><p>stray</p><case default><b>x</b></case></match>');
    expect(d?.code).toBe('O1108');
  });

  it('rejects an interpolation between the arms', () => {
    expect(
      firstParseError('<match {product.title}>{product.title}<case default><b>x</b></case></match>')?.code,
    ).toBe('O1108');
  });

  it('allows comments between the arms, which are trivia', () => {
    expect(
      errors('<match {product.title}>{# pick one #}<case default><b>x</b></case></match>'),
    ).toEqual([]);
  });

  it('rejects <case> outside a <match>', () => {
    const d = firstParseError('<case "x"><b>x</b></case>');
    expect(d?.code).toBe('O1109');
    expect(d?.suggestion).toContain('<match');
  });

  it('rejects a <case> value that is neither a literal nor `default`', () => {
    expect(firstParseError('<match {product.title}><case x><b>x</b></case></match>')?.code).toBe('O1110');
  });

  it('rejects an empty <match>', () => {
    expect(firstParseError('<match {product.title}></match>')?.code).toBe('O1111');
  });

  it('rejects an unterminated <match>', () => {
    expect(firstParseError('<match {product.title}><case default><b>x</b></case>')?.code).toBe('O1050');
  });

  it('nests: an arm may contain any node, including another match', () => {
    const nested =
      '<match {settings.badge}>' +
      '<case "new"><match {product.title}><case default><b>t</b></case></match></case>' +
      '<case "sale"><b>S</b></case>' +
      '<case "restock"><b>R</b></case>' +
      '</match>';
    expect(errors(nested)).toEqual([]);
  });
});

describe('rendering', () => {
  const renderMatch = (settingValue: string) => {
    const program = compileOk([pageSource(ALL_THREE, SETTINGS)]);
    const out = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'c', products: [] } },
      settings: { collection: { badge: settingValue } },
    });
    if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
    return out.html;
  };

  it('renders the arm whose value matches', () => {
    expect(renderMatch('new')).toBe('<b>New</b>');
    expect(renderMatch('sale')).toBe('<b>Sale</b>');
    expect(renderMatch('restock')).toBe('<b>Back</b>');
  });

  it('renders the default arm when nothing matches', () => {
    const program = compileOk([
      pageSource('<match {collection.title}><case "a"><b>A</b></case><case default><b>?</b></case></match>'),
    ]);
    const out = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'zzz', products: [] } },
    });
    if (!out.ok) throw new Error(out.error.code);
    expect(out.html).toBe('<b>?</b>');
  });

  const BANNER = '<match {banner.style}><case "info"><b>i</b></case><case "warn"><b>w</b></case></match>';

  it('renders the arm matching a host-declared union value', () => {
    const program = compileOk([pageSource(BANNER)]);
    const out = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'c', products: [] }, banner: { style: 'warn', text: 't' } },
    });
    if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
    expect(out.html).toBe('<b>w</b>');
  });

  it('fails the render when the host supplies a value outside the declared union', () => {
    // The checker proved the arms cover the type, so an unmatched value means
    // the data contradicts its own declaration. Rendering nothing would hide a
    // host bug behind a blank spot on the page.
    const program = compileOk([pageSource(BANNER)]);
    const out = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'c', products: [] }, banner: { style: 'danger', text: 't' } },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('O4040');
    expect(out.error.message).toContain('danger');
  });

  it('charges the node budget, so a match cannot be free', () => {
    const program = compileOk([pageSource(ALL_THREE, SETTINGS)]);
    const out = render(program, 'collection', {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'c', products: [] } },
      settings: { collection: { badge: 'new' } },
      fuel: 3,
    });
    expect(out.ok).toBe(false);
  });
});

describe('the formatter', () => {
  const fmt = (body: string) => {
    const source = `---\ncomponent Card\nprops {\n  product: Product\n}\n${SETTINGS}---\n${body}\n`;
    const parsed = parseTemplate(source, 'card.orbit');
    if (!parsed.ok) throw new Error(parsed.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '));
    return formatTemplate(parsed.template);
  };

  it('puts every arm on its own line, even when it would fit', () => {
    // A `<match>` enumerates a closed set; the column IS the documentation.
    const out = fmt(ALL_THREE);
    expect(out).toContain('<match {settings.badge}>\n');
    expect(out).toContain('  <case "new">');
    expect(out).toContain('  <case "sale">');
    expect(out).toContain('</match>');
  });

  it('prints a default arm as `<case default>`', () => {
    expect(fmt('<match {product.title}><case default><b>x</b></case></match>')).toContain(
      '<case default>',
    );
  });

  it('is idempotent', () => {
    const once = fmt(ALL_THREE);
    const parsed = parseTemplate(once, 'card.orbit');
    if (!parsed.ok) throw new Error('reformat did not parse');
    expect(formatTemplate(parsed.template)).toBe(once);
  });

  it('does not change what renders', () => {
    const before = compileOk([pageSource(ALL_THREE, SETTINGS)]);
    const source = formatTemplate([...before.templates.values()][0]!);
    const after = compileOk([{ name: 'pages/collection.orbit', source }]);
    const opts = {
      hostFilters: HOST_FILTERS,
      bindings: { collection: { title: 'c', products: [] } },
      settings: { collection: { badge: 'sale' } },
    };
    const a = render(before, 'collection', opts);
    const b = render(after, 'collection', opts);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.html).toBe(a.html);
  });
});

describe('the rest of the pipeline knows about match', () => {
  it('puts every arm in the access plan, since data selects which one runs', () => {
    const program = compileOk([
      pageSource(
        '<match {collection.title}>' +
          '<case "a"><p>{collection.products |> size}</p></case>' +
          '<case default><b>?</b></case>' +
          '</match>',
        '',
      ),
    ]);
    const plan = extractAccessPlan(program, 'collection');
    expect(plan.paths).toContain('collection.title');
    expect(plan.paths).toContain('collection.products');
  });

  it('round-trips through serialize and verified load', () => {
    const parsed = parseProgram([pageSource(ALL_THREE, SETTINGS)]);
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const json = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));
    const back = loadCheckedAst(json, { trust: 'verify' });
    const node = [...back.templates.values()][0]!.body[0];
    expect(node?.kind).toBe('match');
  });

  it('refuses a stored arm that is neither a value nor a default', () => {
    const parsed = parseProgram([pageSource(ALL_THREE, SETTINGS)]);
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const json = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));
    json.templates.collection.body[0].cases[0].match = 'whatever';
    expect(() => loadCheckedAst(json, { trust: 'verify' })).toThrow();
  });

  it('refuses a stored default arm that also carries a value', () => {
    // Both arms would then be selectable, and the interpreter's lookup would
    // pick a different one than the checker reasoned about.
    const parsed = parseProgram([pageSource(ALL_THREE, SETTINGS)]);
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const json = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));
    json.templates.collection.body[0].cases[0] = {
      match: 'default',
      value: 'new',
      children: [],
      span: json.templates.collection.body[0].cases[0].span,
    };
    expect(() => loadCheckedAst(json, { trust: 'verify' })).toThrow();
  });
});
