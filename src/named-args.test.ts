import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { formatTemplate } from './formatter';
import { parseTemplate } from './parser';
import { render } from './interpreter';
import { assertValidHostFilters, bindHostFilterArgs, type HostFilterDecl } from './host';
import { t } from './types';
import { cardSource, compile, compileOk, HOST_FILTERS } from './test-host.helper';

/**
 * Named filter arguments.
 *
 * The failure this prevents is positional rot. A host filter grows `width`,
 * then `crop`, then `quality`; every theme in the wild has frozen the
 * positions, and `imgTag(cover, 800, 2, true)` says nothing about which knob is
 * which. Names make the call site self-describing and let a host add a knob
 * without renumbering the rest.
 *
 * Names bind to a host filter's OPTIONAL parameters only. Required parameters
 * are the subject of the call, there are few of them, and naming them is
 * ceremony rather than clarity.
 */

function errors(body: string) {
  return compile([cardSource(body)]).result.diagnostics.filter((d) => d.severity === 'error');
}

function firstParseError(body: string) {
  const source = `---\ncomponent Card\nprops {\n  product: Product\n}\n---\n${body}`;
  const result = parseTemplate(source, 'card.orbit');
  return result.ok ? undefined : result.diagnostics[0];
}

const COLLECTION = {
  title: 'All',
  products: [
    {
      title: 'Widget',
      url: '/products/widget',
      vendor: null,
      price: { amountMinor: 19900, currency: 'INR' },
      compareAt: null,
      isNew: false,
      cover: { key: 'k' },
      tags: [],
      rating: null,
    },
  ],
};

/**
 * Render a page whose only expression is the given `imgTag(p.cover, …)` call,
 * and return the href it produced. What the impl writes into the URL is a
 * readable record of which value landed in which slot.
 */
function hrefOf(expr: string): string {
  const program = compileOk([
    {
      name: 'pages/collection.orbit',
      source: `---\npage collection\n---\n<for p of={collection.products}><a href={${expr}}>x</a></for>\n`,
    },
  ]);
  const out = render(program, 'collection', {
    hostFilters: HOST_FILTERS,
    bindings: { collection: COLLECTION },
  });
  if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
  const start = out.html.indexOf('"') + 1;
  // The URL sink escaped the `&` separators, as it should; decode them so the
  // assertions read as URLs rather than as a test of the escaper.
  return out.html.slice(start, out.html.indexOf('"', start)).split('&amp;').join('&');
}

const IMAGE_GLOBAL: HostFilterDecl[] = HOST_FILTERS;

describe('binding names to parameters', () => {
  it('accepts a named optional argument', () => {
    expect(errors('<img src={imgTag(product.cover, width: 800)} alt=""/>')).toEqual([]);
  });

  it('accepts names in any order, since order is the thing being replaced', () => {
    expect(errors('<img src={imgTag(product.cover, quality: 80, width: 400)} alt=""/>')).toEqual([]);
  });

  it('accepts a mix of positional and named', () => {
    expect(errors('<img src={imgTag(product.cover, 800, crop: "center")} alt=""/>')).toEqual([]);
  });

  it('accepts names after a pipe, where the subject is the positional argument', () => {
    expect(errors('<img src={product.cover |> imgTag(width: 800)} alt=""/>')).toEqual([]);
  });

  it('type-checks a named argument against its declared type', () => {
    const [e] = errors('<img src={imgTag(product.cover, width: "big")} alt=""/>');
    expect(e?.code).toBe('O2101');
    // Named, so the message says which knob — not "argument 2".
    expect(e?.message).toContain('`width`');
    expect(e?.message).toContain('Int');
  });

  it('still says "argument N" for a positional parameter', () => {
    const [e] = errors('<img src={imgUrl(product.cover, "big")} alt=""/>');
    expect(e?.code).toBe('O2101');
    expect(e?.message).toContain('argument 2');
  });
});

describe('the three ways a name can be wrong', () => {
  it('rejects a positional argument after a named one, in the grammar (O1102)', () => {
    // A grammar rule rather than a check: once a name has been given, the slot
    // a following positional would fill is not determined by where it sits.
    const d = firstParseError('<img src={imgTag(product.cover, width: 8, "center")} alt=""/>');
    expect(d?.code).toBe('O1102');
    expect(d?.suggestion).toContain('width');
  });

  it('rejects an unknown name and suggests a near one (O2105)', () => {
    const [e] = errors('<img src={imgTag(product.cover, widht: 800)} alt=""/>');
    expect(e?.code).toBe('O2105');
    expect(e?.suggestion).toContain('width');
  });

  it('lists the accepted names when nothing is close enough to suggest', () => {
    const [e] = errors('<img src={imgTag(product.cover, zzzzzz: 800)} alt=""/>');
    expect(e?.code).toBe('O2105');
    expect(e?.suggestion).toContain('width:');
    expect(e?.suggestion).toContain('crop:');
  });

  it('rejects a name on a filter that declares no optional parameters', () => {
    const [e] = errors('<img src={imgUrl(product.cover, width: 800)} alt=""/>');
    expect(e?.code).toBe('O2105');
    expect(e?.message).toContain('positional');
  });

  it('rejects a name on a stdlib filter, which has no parameter list to bind to', () => {
    const [e] = errors('<p>{product.title |> truncate(length: 40)}</p>');
    expect(e?.code).toBe('O2105');
    expect(e?.message).toContain('host-filter');
  });

  it('rejects the same name twice (O2106)', () => {
    const [e] = errors('<img src={imgTag(product.cover, width: 8, width: 9)} alt=""/>');
    expect(e?.code).toBe('O2106');
    expect(e?.message).toContain('twice');
  });

  it('rejects a name that a positional argument already filled (O2106)', () => {
    // Same parameter, two arguments — but a different mistake from naming it
    // twice, and the only one of the two with a positional to delete.
    const [e] = errors('<img src={imgTag(product.cover, 800, width: 400)} alt=""/>');
    expect(e?.code).toBe('O2106');
    expect(e?.message).toContain('positionally');
  });

  it('counts arity on POSITIONAL arguments, so names cannot pad it out', () => {
    const [e] = errors('<img src={imgTag(width: 800)} alt=""/>');
    expect(e?.code).toBe('O2100');
    expect(e?.message).toContain('positional');
  });

  it('mentions the names in the arity message when the call used none', () => {
    const [e] = errors('<img src={imgTag()} alt=""/>');
    expect(e?.code).toBe('O2100');
    expect(e?.suggestion).toContain('width:');
  });
});

describe('a named argument reaches the slot it names', () => {
  it('places a single named argument in its own slot, not the next one', () => {
    // The bug this catches: `quality:` landing in `width:`'s position because
    // the interpreter passed arguments in written order.
    expect(hrefOf('imgTag(p.cover, quality: 80)')).toBe('/img/k?q=80');
  });

  it('leaves a skipped middle optional as none, not as a shifted value', () => {
    expect(hrefOf('imgTag(p.cover, width: 400, quality: 80)')).toBe('/img/k?w=400&q=80');
  });

  it('reorders named arguments into declaration order', () => {
    expect(hrefOf('imgTag(p.cover, quality: 80, crop: "c", width: 400)')).toBe('/img/k?w=400&c=c&q=80');
  });

  it('passes a purely positional call exactly as written', () => {
    expect(hrefOf('imgTag(p.cover, 400)')).toBe('/img/k?w=400');
  });

  it('passes nothing extra when no optional is given', () => {
    expect(hrefOf('imgTag(p.cover)')).toBe('/img/k');
  });
});

describe('the formatter', () => {
  const fmt = (body: string) => {
    const source = `---\ncomponent Card\nprops {\n  product: Product\n}\n---\n${body}\n`;
    const parsed = parseTemplate(source, 'card.orbit');
    if (!parsed.ok) throw new Error(parsed.diagnostics.map((d) => d.code).join(', '));
    return formatTemplate(parsed.template);
  };

  it('prints `name: value` and round-trips', () => {
    const out = fmt('<img src={imgTag(product.cover, width: 800, crop: "center")} alt=""/>');
    expect(out).toContain('imgTag(product.cover, width: 800, crop: "center")');
    expect(fmt(out.split('---\n')[2] ?? '')).toBeTruthy();
  });

  it('is idempotent over named arguments', () => {
    const once = fmt('<img src={imgTag(product.cover,quality:80,width:400)} alt=""/>');
    const parsed = parseTemplate(once, 'card.orbit');
    if (!parsed.ok) throw new Error('reformat did not parse');
    expect(formatTemplate(parsed.template)).toBe(once);
  });

  it('keeps names through a pipe', () => {
    expect(fmt('<img src={product.cover |> imgTag(width: 800)} alt=""/>')).toContain(
      'product.cover |> imgTag(width: 800)',
    );
  });

  it('preserves the written order of names rather than sorting them', () => {
    // Sorting would be a canonicalization the AST cannot represent as a
    // difference, and would silently rewrite the author's grouping.
    expect(fmt('<img src={imgTag(product.cover, quality: 80, width: 400)} alt=""/>')).toContain(
      'quality: 80, width: 400',
    );
  });
});

describe('host declarations', () => {
  const base = { name: 'f', params: [t.string()], returns: t.string(), impl: () => '' };

  it('requires optional parameter names to be camelCase identifiers', () => {
    expect(() =>
      assertValidHostFilters([{ ...base, optionalParams: [{ name: 'Max-Width', type: t.int() }] }]),
    ).toThrow(/camelCase/);
  });

  it('rejects two optional parameters with the same name', () => {
    expect(() =>
      assertValidHostFilters([
        { ...base, optionalParams: [{ name: 'w', type: t.int() }, { name: 'w', type: t.int() }] },
      ]),
    ).toThrow(/duplicate optional parameter/);
  });

  it('still refuses Html as an optional parameter type', () => {
    expect(() =>
      assertValidHostFilters([{ ...base, optionalParams: [{ name: 'body', type: t.html() }] }]),
    ).toThrow(/Html cannot be an optional parameter/);
  });
});

describe('the binder itself', () => {
  const decl: HostFilterDecl = {
    name: 'f',
    params: [t.string()],
    optionalParams: [
      { name: 'a', type: t.int() },
      { name: 'b', type: t.int() },
      { name: 'c', type: t.int() },
    ],
    returns: t.string(),
    impl: () => '',
  };
  const span = { start: { line: 1, col: 1, offset: 0 }, end: { line: 1, col: 1, offset: 0 } };
  const positional = () => ({ value: { kind: 'int' as const, value: 0, span } });
  const named = (name: string) => ({ label: { name, span }, value: { kind: 'int' as const, value: 0, span } });

  it('is a permutation: every argument lands in exactly one distinct slot', () => {
    // The property that makes the interpreter's placement safe. If two
    // arguments could share a slot, one would silently overwrite the other.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom('a', 'b', 'c'), { maxLength: 3 }),
        fc.integer({ min: 0, max: 1 }),
        (names, extraPositional) => {
          // Positionals fill required slots first, then optionals in order, so
          // only names not already covered positionally can be used.
          const covered = ['a', 'b', 'c'].slice(0, extraPositional);
          const usable = names.filter((n) => !covered.includes(n));
          const args = [
            positional(),
            ...Array.from({ length: extraPositional }, positional),
            ...usable.map(named),
          ];
          const bound = bindHostFilterArgs(decl, args);
          expect(bound.ok).toBe(true);
          if (!bound.ok) return;
          expect(bound.slotOf.length).toBe(args.length);
          expect(new Set(bound.slotOf).size).toBe(args.length);
          for (const slot of bound.slotOf) {
            expect(slot).toBeGreaterThanOrEqual(0);
            expect(slot).toBeLessThan(4);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reports the WRITTEN index of the offending argument, not its slot', () => {
    const bound = bindHostFilterArgs(decl, [positional(), named('c'), named('zzz')]);
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.problem).toEqual({ kind: 'unknownName', index: 2 });
  });

  it('names the earlier argument when one slot is filled twice', () => {
    const bound = bindHostFilterArgs(decl, [positional(), positional(), named('a')]);
    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.problem).toEqual({ kind: 'duplicate', index: 2, slot: 1, firstIndex: 1 });
  });
});

describe('nothing about named arguments loosens the language', () => {
  it('does not let a name smuggle Html past the terminality rule', () => {
    const [e] = errors('<p>{imgTag(product.cover, crop: rawHtml("<b>x</b>"))}</p>');
    expect(e?.code).toBe('O2063');
  });

  it('does not exempt a named argument from the optional law', () => {
    const [e] = errors('<img src={imgTag(product.cover, crop: product.vendor)} alt=""/>');
    expect(e?.code).toBe('O2104');
  });

  it('leaves the host filter list unchanged in shape', () => {
    // A guard against a named-argument path that quietly accepts a decl the
    // host validator would reject.
    expect(() => assertValidHostFilters(IMAGE_GLOBAL)).not.toThrow();
  });
});
