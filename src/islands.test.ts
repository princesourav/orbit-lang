import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { formatTemplate } from './formatter';
import { parseProgram, parseTemplate, type SourceFile } from './parser';
import { render } from './interpreter';
import { extractAccessPlan } from './host';
import { LIMITS } from './limits';
import { loadCheckedAst, serializeProgram } from './validate-ast';
import { compile, compileOk, HOST_FILTERS } from './test-host.helper';

/**
 * Server islands: `<Component defer/>`.
 *
 * The reason is caching, not interactivity. A cart-count badge in a shared
 * header puts `cart.count` in every page's access plan, and a page whose plan
 * contains personalized data cannot be cached for anyone. Deferring the badge
 * takes it out of the page's plan and into its own.
 *
 * The engine's whole contribution is a placeholder and a manifest. Transport,
 * signing and caching policy stay with the host — the engine has no I/O and no
 * key material, and a signing scheme baked in is one every embedder must accept.
 */

const CART: SourceFile = { name: 'components/cart-count.orbit', source: `---
component CartCount
props {
  cart: Collection
  label: String = "Cart"
}
---
<span class="cart">{label} {cart.title}</span>
` };

const PLAIN: SourceFile = { name: 'components/plain.orbit', source: `---
component Plain
---
<span class="plain">hi</span>
` };

function page(body: string, extra: readonly SourceFile[] = []): SourceFile[] {
  return [
    ...extra,
    { name: 'pages/collection.orbit', source: `---\npage collection\n---\n${body}\n` },
  ];
}

const BINDINGS = { collection: { title: 'All', products: [], productCount: 7 } };

function renderPage(body: string, extra: readonly SourceFile[] = [], options = {}) {
  const program = compileOk(page(body, extra));
  return render(program, 'collection', { hostFilters: HOST_FILTERS, bindings: BINDINGS, ...options });
}

function errors(body: string, extra: readonly SourceFile[] = []) {
  return compile(page(body, extra)).result.diagnostics.filter((d) => d.severity === 'error');
}

describe('the placeholder', () => {
  it('emits an inert custom element instead of the component', () => {
    const out = renderPage('<CartCount defer/>', [CART]);
    if (!out.ok) throw new Error(out.error.code);
    expect(out.html).toBe('<orbit-island data-island="i0"></orbit-island>');
    // The component itself did not render.
    expect(out.html).not.toContain('class="cart"');
  });

  it('renders the children as fallback inside the placeholder', () => {
    // A page whose second pass never happens shows this and nothing else. That
    // is the failure mode worth designing for.
    const out = renderPage('<CartCount defer><span class="skeleton">…</span></CartCount>', [CART]);
    if (!out.ok) throw new Error(out.error.code);
    expect(out.html).toBe(
      '<orbit-island data-island="i0"><span class="skeleton">…</span></orbit-island>',
    );
  });

  it('numbers islands in document order, deterministically', () => {
    const out = renderPage('<CartCount defer/><Plain/><CartCount defer/>', [CART, PLAIN]);
    if (!out.ok) throw new Error(out.error.code);
    expect(out.html).toContain('data-island="i0"');
    expect(out.html).toContain('data-island="i1"');
    // Ids come from a counter, not from data: an id derived from bindings would
    // be both attacker-reachable and a cache key that moves when it must not.
    const again = renderPage('<CartCount defer/><Plain/><CartCount defer/>', [CART, PLAIN]);
    if (!again.ok) throw new Error(again.error.code);
    expect(again.html).toBe(out.html);
  });

  it('cannot occur in RCDATA at all, because a tag there is literal text', () => {
    // Not a rule islands added — `<title>` content is text, so the parser never
    // produces a component node inside one. Asserted so the reason stays
    // recorded rather than being rediscovered as a missing guard.
    const out = renderPage('<title><CartCount defer/></title>', [CART]);
    if (!out.ok) throw new Error(out.error.code);
    expect(out.html).toBe('<title>&lt;CartCount defer/></title>');
    expect(out.islands).toEqual([]);
  });

  it('caps the number of islands, since each is a second request', () => {
    const many = '<CartCount defer/>'.repeat(LIMITS.maxIslandsPerRender + 1);
    const out = renderPage(many, [CART]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('O4042');
  });
});

describe('the manifest', () => {
  it('records the component, its resolved props and whether it has a fallback', () => {
    const out = renderPage('<CartCount defer label="Bag"><i>…</i></CartCount>', [CART]);
    if (!out.ok) throw new Error(out.error.code);
    expect(out.islands).toHaveLength(1);
    expect(out.islands[0]).toMatchObject({
      id: 'i0',
      component: 'CartCount',
      props: { label: 'Bag' },
      hasFallback: true,
    });
  });

  it('carries the paths the island reads, so the host can fetch exactly those', () => {
    const out = renderPage('<CartCount defer/>', [CART]);
    if (!out.ok) throw new Error(out.error.code);
    expect(out.islands[0]?.paths).toContain('cart.title');
  });

  it('is empty when nothing is deferred', () => {
    const out = renderPage('<CartCount cart={collection}/>', [CART]);
    if (!out.ok) throw new Error(out.error.code);
    expect(out.islands).toEqual([]);
  });

  it('survives a failed render, so per-island work already done is not lost', () => {
    // Two islands, then a budget trip. A host that caches per-island work must
    // still get the manifest for what was already resolved.
    const out = renderPage('<CartCount defer/><CartCount defer/><p>{collection.title}</p>', [CART], {
      fuel: 60,
    });
    expect(out.ok).toBe(false);
    expect(out.islands.length).toBeGreaterThan(0);
  });
});

describe('the access plan partitions', () => {
  it('keeps a deferred component out of the page plan — the whole point', () => {
    const program = compileOk(page('<CartCount defer/>', [CART]));
    const plan = extractAccessPlan(program, 'collection');
    // The page never reads productCount, so it never has to fetch it.
    expect(plan.paths).toEqual([]);
    expect(plan.islands).toEqual([{ component: 'CartCount', paths: ['cart', 'cart.title'] }]);
  });

  it('puts the same paths in the page plan when the component is NOT deferred', () => {
    const program = compileOk(page('<CartCount cart={collection}/>', [CART]));
    const plan = extractAccessPlan(program, 'collection');
    expect(plan.paths).toContain('collection.title');
    expect(plan.islands).toEqual([]);
  });

  it('keeps a prop expression in the page plan, because the first pass evaluates it', () => {
    const program = compileOk(page('<CartCount defer label={collection.title}/>', [CART]));
    const plan = extractAccessPlan(program, 'collection');
    expect(plan.paths).toContain('collection.title');
  });

  it('partitions: the page plan shrinks, and the two sets never overlap', () => {
    /*
     * The property the feature rests on.
     *
     * The brief stated it as "main ∪ islands equals the undeferred plan", which
     * held only while an island's every input came from the page. Once an
     * unsupplied prop is host-resolved — which is what makes deferring take
     * anything OUT of the page's plan — the island's paths are rooted at its own
     * prop names, so the two plans are not comparable path-for-path.
     *
     * What must still hold, and is what a host depends on:
     *   1. deferring never ADDS a path to the page plan, and
     *   2. no path is in both the page plan and an island's.
     *
     * Together those are the partition: whatever the page still fetches, it is
     * a subset of what it fetched before, and nothing is fetched twice.
     */
    const bodies = [
      '<CartCount defer/>',
      '<CartCount defer/><CartCount cart={collection}/>',
      '<div><CartCount defer/></div>',
      '<if {collection.title != ""}><CartCount defer/></if>',
      '<for p of={collection.products}><CartCount defer/></for>',
      '<CartCount defer label={collection.title}/>',
      '<CartCount defer/><p>{collection.title}</p>',
      '<Plain/><CartCount defer/>',
      '<CartCount defer/><CartCount defer/>',
    ];
    fc.assert(
      fc.property(fc.constantFrom(...bodies), (body) => {
        const deferred = extractAccessPlan(compileOk(page(body, [CART, PLAIN])), 'collection');
        const inline = extractAccessPlan(
          compileOk(page(body.split('<CartCount defer').join('<CartCount cart={collection}'), [CART, PLAIN])),
          'collection',
        );

        // 1. Deferring only ever removes.
        for (const path of deferred.paths) expect(inline.paths).toContain(path);

        // 2. Disjoint, page against every island and islands against each other.
        const seen = new Set(deferred.paths);
        for (const island of deferred.islands) {
          for (const path of island.paths) {
            expect(seen.has(path)).toBe(false);
            seen.add(path);
          }
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe('what cannot cross the pass boundary', () => {
  const HTML_PROP: SourceFile = { name: 'components/rich-island.orbit', source: `---
component RichIsland
props {
  content: Html
}
---
<div>{content}</div>
` };

  const OUTER: SourceFile = { name: 'components/outer.orbit', source: `---
component Outer
---
<div><CartCount defer/></div>
` };

  const MIDDLE: SourceFile = { name: 'components/middle.orbit', source: `---
component Middle
---
<div><Outer/></div>
` };

  const SLOTTED: SourceFile = { name: 'components/slotted.orbit', source: `---
component Slotted
slots {
  side?
}
---
<div><slot name="side"/></div>
` };

  it('rejects an Html prop, which cannot be serialized without losing its obligation', () => {
    const [e] = errors('<RichIsland defer content={richtext("x")}/>', [HTML_PROP]);
    expect(e?.code).toBe('O2112');
    expect(e?.suggestion).toContain('sanitizer');
  });

  it('allows the same Html prop when the component is not deferred', () => {
    expect(errors('<RichIsland content={richtext("x")}/>', [HTML_PROP])).toEqual([]);
  });

  it('rejects a directly nested island', () => {
    const [e] = errors('<Outer defer/>', [CART, OUTER]);
    expect(e?.code).toBe('O2113');
    expect(e?.message).toContain('CartCount');
  });

  it('rejects an island nested several components deep', () => {
    // Unbounded latency is unbounded however many components it hides behind.
    const [e] = errors('<Middle defer/>', [CART, OUTER, MIDDLE]);
    expect(e?.code).toBe('O2113');
  });

  it('rejects a slot fill, which would silently become fallback instead', () => {
    const [e] = errors('<Slotted defer><p slot="side">x</p></Slotted>', [SLOTTED]);
    expect(e?.code).toBe('O2114');
  });

  it('accepts the same fill when the component is not deferred', () => {
    expect(errors('<Slotted><p slot="side">x</p></Slotted>', [SLOTTED])).toEqual([]);
  });
});

describe('grammar', () => {
  const bad = (body: string) => {
    const result = parseTemplate(`---\npage p\n---\n${body}\n`, 'p.orbit');
    return result.ok ? undefined : result.diagnostics[0];
  };

  it('rejects a valued defer, since the placeholder is unconditional', () => {
    const d = bad('<CartCount defer="true"/>');
    expect(d?.code).toBe('O1112');
    expect(d?.suggestion).toContain('<if>');
  });

  it('does not pass defer through as a prop', () => {
    const parsed = parseProgram(page('<CartCount defer label="Bag"/>', [CART]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const node = [...parsed.program.templates.values()].find((t) => t.name === 'collection')?.body[0];
    expect(node?.kind).toBe('component');
    if (node?.kind !== 'component') return;
    expect(node.defer).toBe(true);
    expect(node.props.map((p) => p.name)).toEqual(['label']);
  });
});

describe('the rest of the pipeline', () => {
  it('round-trips through the formatter', () => {
    const source = '---\norbit 2026\npage p\n---\n<CartCount defer label="Bag"/>\n';
    const parsed = parseTemplate(source, 'p.orbit');
    if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.code);
    const out = formatTemplate(parsed.template);
    expect(out).toContain('<CartCount defer label="Bag"/>');
    expect(out).toBe(source);
  });

  it('round-trips through serialize and verified load', () => {
    const parsed = parseProgram(page('<CartCount defer/>', [CART]));
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const json = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));
    const back = loadCheckedAst(json, { trust: 'verify' });
    const node = [...back.templates.values()].find((t) => t.name === 'collection')?.body[0];
    expect(node?.kind === 'component' && node.defer).toBe(true);
  });

  it('refuses a stored tree with no defer flag', () => {
    // Omitting it would render the component inline and drop it from the
    // manifest: a personalized fragment quietly baked into a cacheable page.
    const parsed = parseProgram(page('<CartCount defer/>', [CART]));
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const json = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));
    delete json.templates.collection.body[0].defer;
    expect(() => loadCheckedAst(json, { trust: 'verify' })).toThrow();
  });
});
