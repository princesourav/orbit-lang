import { describe, expect, it } from 'vitest';
import { OrbitAstError } from './diagnostics';
import { render } from './interpreter';
import {
  loadCheckedAst,
  serializeProgram,
  unsafe_loadTrustedAst,
  validateAstStructure,
} from './validate-ast';
import { compileOk, HOST_FILTERS, money, pageSource } from './test-host.helper';

const FILES = [pageSource('<h1>{collection.title}</h1><for p of={collection.products} limit={24}><p>{p.title}</p></for>')];

function roundTrip() {
  const program = compileOk(FILES);
  // Simulate the DB: serialize to plain JSON bytes and back.
  return JSON.parse(JSON.stringify(serializeProgram(program))) as Record<string, unknown>;
}

const BINDINGS = {
  collection: {
    title: 'All',
    products: [
      { title: 'A', url: '/a', vendor: null, price: money(1), compareAt: null, isNew: false, cover: { key: 'a' }, tags: [], rating: null },
    ],
  },
};

describe('serialize -> store -> loadCheckedAst round trip', () => {
  it('renders byte-identically after the round trip', () => {
    const program = compileOk(FILES);
    const direct = render(program, 'collection', { hostFilters: HOST_FILTERS, bindings: BINDINGS });
    const loaded = loadCheckedAst(roundTrip(), { trust: 'verify' });
    const after = render(loaded, 'collection', { hostFilters: HOST_FILTERS, bindings: BINDINGS });
    if (!direct.ok || !after.ok) throw new Error('render failed');
    expect(after.html).toBe(direct.html);
    expect(after.html).toBe('<h1>All</h1><p>A</p>');
  });

  it('validateAstStructure returns [] for a well-formed program', () => {
    expect(validateAstStructure(roundTrip())).toEqual([]);
  });
});

describe('poisoned-AST defenses (W-36)', () => {
  function templateOf(data: Record<string, unknown>) {
    const templates = data['templates'] as Record<string, { body: Record<string, unknown>[] }>;
    const first = Object.values(templates)[0];
    if (first === undefined) throw new Error('no template');
    return first;
  }

  it('rejects an injected <script> element even though the parser could never produce one', () => {
    const data = roundTrip();
    templateOf(data).body[0] = {
      kind: 'element',
      tag: 'script',
      attrs: [],
      children: [{ kind: 'text', value: 'alert(1)', span: fakeSpan() }],
      content: 'normal',
      span: fakeSpan(),
    } as unknown as Record<string, unknown>;
    expect(() => loadCheckedAst(data, { trust: 'verify' })).toThrowError(OrbitAstError);
    expect(validateAstStructure(data).some((d) => d.message.includes('<script>'))).toBe(true);
  });

  it('rejects unknown node kinds and unknown expression kinds', () => {
    const bad1 = roundTrip();
    templateOf(bad1).body.push({ kind: 'raw-html', value: '<b>' } as unknown as Record<string, unknown>);
    expect(validateAstStructure(bad1).length).toBeGreaterThan(0);

    const bad2 = roundTrip();
    templateOf(bad2).body.push({
      kind: 'interpolation',
      expr: { kind: 'eval', code: 'x' },
      span: fakeSpan(),
    } as unknown as Record<string, unknown>);
    expect(validateAstStructure(bad2).length).toBeGreaterThan(0);
  });

  it('rejects event-handler attributes and over-cap loop limits', () => {
    const withOnClick = roundTrip();
    templateOf(withOnClick).body.push({
      kind: 'element',
      tag: 'div',
      attrs: [{ name: 'onclick', span: fakeSpan(), value: { form: 'bare' }, isUrl: false }],
      children: [],
      content: 'normal',
      span: fakeSpan(),
    } as unknown as Record<string, unknown>);
    expect(validateAstStructure(withOnClick).some((d) => d.message.includes('onclick'))).toBe(true);

    const bigLimit = roundTrip();
    const forNode = templateOf(bigLimit).body[1] as { limit?: unknown };
    forNode.limit = { kind: 'int', value: 100_000, span: fakeSpan() };
    expect(validateAstStructure(bigLimit).some((d) => d.message.includes('limit'))).toBe(true);
  });

  it('rejects rawtext content and non-void content mismatches', () => {
    const data = roundTrip();
    (templateOf(data).body[0] as { content?: unknown }).content = 'rawtext';
    expect(validateAstStructure(data).length).toBeGreaterThan(0);
  });

  it('rejects wrong format versions and empty roots', () => {
    expect(validateAstStructure({ orbit: 2, templates: {} }).length).toBeGreaterThan(0);
    expect(validateAstStructure(null).length).toBeGreaterThan(0);
    expect(validateAstStructure({ orbit: 1 }).length).toBeGreaterThan(0);
  });
});

describe('unsafe_loadTrustedAst (host verified HMAC out-of-band)', () => {
  it('skips structural validation by design — the name is the warning', () => {
    const data = roundTrip();
    const templates = data['templates'] as Record<string, { body: unknown[] }>;
    const first = Object.values(templates)[0];
    first?.body.push({ kind: 'raw-html', value: '<b>' });
    // loadCheckedAst refuses…
    expect(() => loadCheckedAst(data, { trust: 'verify' })).toThrowError(OrbitAstError);
    // …unsafe_loadTrustedAst loads it (and would fail only at render time).
    const program = unsafe_loadTrustedAst(data);
    expect(program.templates.size).toBe(1);
  });

  it('still refuses structurally absent templates', () => {
    expect(() => unsafe_loadTrustedAst({ nope: true })).toThrowError(OrbitAstError);
  });
});

function fakeSpan() {
  return { start: { offset: 0, line: 1, col: 1 }, end: { offset: 0, line: 1, col: 1 } };
}
