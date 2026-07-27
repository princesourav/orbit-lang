import { describe, expect, it } from 'vitest';
import { OrbitAstError } from './diagnostics';
import { render } from './interpreter';
import {
  astAuthMessage,
  loadCheckedAst,
  serializeProgram,
  signAst,
  timingSafeEqualBytes,
  unsafe_loadTrustedAst,
  validateAstStructure,
  verifyAstTag,
  type AstAuthContext,
  type HmacFn,
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

describe('poisoned-AST prototype keys (W-36d)', () => {
  function templateBody(data: Record<string, unknown>) {
    const templates = data['templates'] as Record<string, { body: Record<string, unknown>[] }>;
    const first = Object.values(templates)[0];
    if (first === undefined) throw new Error('no template');
    return first.body;
  }

  it('rejects member access to __proto__ / constructor / prototype', () => {
    for (const property of ['__proto__', 'constructor', 'prototype']) {
      const data = roundTrip();
      templateBody(data).push({
        kind: 'interpolation',
        span: fakeSpan(),
        expr: {
          kind: 'member',
          property,
          optional: false,
          span: fakeSpan(),
          object: { kind: 'ident', name: 'collection', span: fakeSpan() },
        },
      } as unknown as Record<string, unknown>);
      const found = validateAstStructure(data);
      expect(found.some((d) => d.message.includes(property)), property).toBe(true);
      expect(() => loadCheckedAst(data, { trust: 'verify' })).toThrowError(OrbitAstError);
    }
  });

  it('rejects reserved record-literal field keys and let bindings', () => {
    const withField = roundTrip();
    templateBody(withField).push({
      kind: 'interpolation',
      span: fakeSpan(),
      expr: {
        kind: 'record',
        span: fakeSpan(),
        fields: [{ key: '__proto__', value: { kind: 'int', value: 1, span: fakeSpan() } }],
      },
    } as unknown as Record<string, unknown>);
    expect(validateAstStructure(withField).some((d) => d.message.includes('__proto__'))).toBe(true);

    const withLet = roundTrip();
    templateBody(withLet).push({
      kind: 'let',
      name: 'constructor',
      expr: { kind: 'int', value: 1, span: fakeSpan() },
      span: fakeSpan(),
    } as unknown as Record<string, unknown>);
    expect(validateAstStructure(withLet).some((d) => d.message.includes('let binding'))).toBe(true);
  });

  it('rejects a color literal that is 7 chars starting with # but not hex', () => {
    const data = roundTrip();
    templateBody(data).push({
      kind: 'interpolation',
      span: fakeSpan(),
      expr: { kind: 'color', value: '#<scrip"', span: fakeSpan() },
    } as unknown as Record<string, unknown>);
    expect(validateAstStructure(data).some((d) => d.message.includes('color literal'))).toBe(true);
  });
});

describe('stored-AST authentication helper (host supplies the primitive)', () => {
  const CTX: AstAuthContext = { storeId: 'store_42', themeVersionId: 'tv_7' };

  /**
   * A deterministic stand-in for a real HMAC. NOT a MAC — it exists only to
   * prove the engine's canonicalization and comparison behave; a host wires
   * in `crypto.createHmac('sha256', key)`.
   */
  function fakeHmac(key: string): HmacFn {
    return (message) => {
      const acc = new Uint8Array(16);
      for (let i = 0; i < key.length; i += 1) acc[i % 16] = ((acc[i % 16] ?? 0) + key.charCodeAt(i)) & 0xff;
      for (let i = 0; i < message.length; i += 1) {
        const slot = i % 16;
        acc[slot] = (((acc[slot] ?? 0) * 31 + (message[i] ?? 0) + i) >>> 0) & 0xff;
      }
      return acc;
    };
  }

  const hmac = fakeHmac('k1');
  const AST = '{"orbit":1,"templates":{}}';

  it('canonicalization is length-prefixed, so field boundaries cannot shift', () => {
    // ("ab","c") and ("a","bc") must NOT produce the same message: a plain
    // concatenation scheme would let a tenant forge a tag for another tuple.
    const a = astAuthMessage({ storeId: 'ab', themeVersionId: 'c' }, AST);
    const b = astAuthMessage({ storeId: 'a', themeVersionId: 'bc' }, AST);
    expect(timingSafeEqualBytes(a, b)).toBe(false);
    expect(a.length).toBe(b.length); // same total bytes, different layout
  });

  it('is domain separated and deterministic', () => {
    const message = astAuthMessage(CTX, AST);
    expect(Array.from(message.slice(4, 4 + 'orbit.ast-auth.v1'.length)))
      .toEqual(Array.from('orbit.ast-auth.v1').map((c) => c.charCodeAt(0)));
    expect(Array.from(astAuthMessage(CTX, AST))).toEqual(Array.from(message));
  });

  it('encodes non-ASCII and astral characters as UTF-8 without TextEncoder', () => {
    const withEmoji = astAuthMessage({ storeId: '🛒', themeVersionId: 'ü' }, AST);
    const bytes = Array.from(withEmoji);
    expect(bytes).toContain(0xf0); // 4-byte sequence lead for U+1F6D2
    expect(bytes).toContain(0xc3); // 2-byte sequence lead for U+00FC
    // Length prefixes reflect BYTE counts, not UTF-16 code-unit counts.
    const domainLen = 'orbit.ast-auth.v1'.length;
    expect(withEmoji[4 + domainLen + 3]).toBe(4); // storeId '🛒' is 4 bytes
  });

  it('signs and verifies a round trip', () => {
    const tag = signAst(CTX, AST, hmac);
    expect(verifyAstTag(CTX, AST, tag, hmac)).toBe(true);
    expect(verifyAstTag(CTX, AST, signAst(CTX, AST, hmac), hmac)).toBe(true);
  });

  it('detects tampering with the AST bytes', () => {
    const tag = signAst(CTX, AST, hmac);
    expect(verifyAstTag(CTX, '{"orbit":1,"templates":{"X":1}}', tag, hmac)).toBe(false);
    expect(verifyAstTag(CTX, AST + ' ', tag, hmac)).toBe(false);
  });

  it('detects tampering with the store or theme version (replay across tenants)', () => {
    const tag = signAst(CTX, AST, hmac);
    expect(verifyAstTag({ storeId: 'store_43', themeVersionId: 'tv_7' }, AST, tag, hmac)).toBe(false);
    expect(verifyAstTag({ storeId: 'store_42', themeVersionId: 'tv_6' }, AST, tag, hmac)).toBe(false);
  });

  it('detects a tampered tag and a wrong key', () => {
    const tag = signAst(CTX, AST, hmac);
    const flipped = Uint8Array.from(tag);
    flipped[0] = ((flipped[0] ?? 0) ^ 0x01) & 0xff;
    expect(verifyAstTag(CTX, AST, flipped, hmac)).toBe(false);
    expect(verifyAstTag(CTX, AST, tag, fakeHmac('k2'))).toBe(false);
  });

  it('accepts raw bytes as well as strings, identically', () => {
    const bytes = Uint8Array.from(Array.from(AST).map((c) => c.charCodeAt(0)));
    expect(verifyAstTag(CTX, bytes, signAst(CTX, AST, hmac), hmac)).toBe(true);
  });

  it('returns false — never throws — when the host primitive throws', () => {
    const throwing: HmacFn = () => {
      throw new Error('hsm unavailable');
    };
    expect(verifyAstTag(CTX, AST, signAst(CTX, AST, hmac), throwing)).toBe(false);
  });

  it('constant-time compare is correct for length, prefix and full matches', () => {
    const a = Uint8Array.from([1, 2, 3]);
    expect(timingSafeEqualBytes(a, Uint8Array.from([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualBytes(a, Uint8Array.from([1, 2, 4]))).toBe(false);
    expect(timingSafeEqualBytes(a, Uint8Array.from([9, 2, 3]))).toBe(false);
    expect(timingSafeEqualBytes(a, Uint8Array.from([1, 2]))).toBe(false);
    expect(timingSafeEqualBytes(a, Uint8Array.from([1, 2, 3, 4]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('the engine holds no key material: the key only ever exists in the host closure', () => {
    // The whole API surface takes a function, never bytes of a key.
    expect(signAst.length).toBe(3);
    expect(verifyAstTag.length).toBe(4);
    const src = `${astAuthMessage.toString()}${verifyAstTag.toString()}${signAst.toString()}`;
    expect(src.includes('require(')).toBe(false);
    expect(src.includes('node:crypto')).toBe(false);
  });
});

function fakeSpan() {
  return { start: { offset: 0, line: 1, col: 1 }, end: { offset: 0, line: 1, col: 1 } };
}
