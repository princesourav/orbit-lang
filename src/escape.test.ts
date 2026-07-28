import { describe, expect, it } from 'vitest';
import {
  escapeAttr,
  escapeRcdata,
  escapeText,
  frozenMap,
  isForbiddenKey,
  isHexColorLiteral,
  parseSrcsetCandidates,
  sanitizeSrcset,
  sanitizeUrl,
  serializeJsonLd,
  srcsetDescriptorValid,
} from './escape';
import { OrbitRenderError } from './diagnostics';
import { htmlValue } from './host';

describe('TEXT context', () => {
  it('escapes & < > and leaves quotes alone', () => {
    expect(escapeText('a & b <s> "q" \'x\'')).toBe('a &amp; b &lt;s&gt; "q" \'x\'');
  });
});

describe('RCDATA context', () => {
  it('escapes & and < (character references are decoded in RCDATA)', () => {
    expect(escapeRcdata('</title><script>&')).toBe('&lt;/title>&lt;script>&amp;');
  });
});

describe('ATTR context', () => {
  it('escapes & " < >', () => {
    expect(escapeAttr('a"b<c>d&e')).toBe('a&quot;b&lt;c&gt;d&amp;e');
  });

  it('breakout attempt stays inert inside double quotes', () => {
    expect(escapeAttr('" onmouseover="alert(1)')).toBe('&quot; onmouseover=&quot;alert(1)');
  });

  it("escapes ' too, so the double-quoting invariant is not load-bearing (W-08a)", () => {
    // The emitter always double-quotes, which made `'` technically safe — but
    // by CONVENTION, in one call site, not by construction. Locked here: a
    // future single-quoted emitter would still be safe.
    expect(escapeAttr("' onmouseover='alert(1)")).toBe('&#39; onmouseover=&#39;alert(1)');
    expect(escapeAttr("it's")).toBe('it&#39;s');
    expect(escapeAttr(`a'b"c<d>e&f`)).toBe('a&#39;b&quot;c&lt;d&gt;e&amp;f');
  });

  it('leaves everything else byte-identical (determinism)', () => {
    expect(escapeAttr('/products/x?a=1#top ✓')).toBe('/products/x?a=1#top ✓');
  });
});

describe('URL-ATTR context (W-11)', () => {
  const ok = (raw: string, attr = 'href') => {
    const r = sanitizeUrl(raw, attr);
    if (!r.ok) throw new Error(`expected ok: ${raw} (${r.reason})`);
    return r.url;
  };
  const blocked = (raw: string, attr = 'href') => {
    const r = sanitizeUrl(raw, attr);
    if (r.ok) throw new Error(`expected block: ${raw}`);
    return r.reason;
  };

  it('allows http/https/mailto/tel/relative/#/?', () => {
    expect(ok('https://x.example/p')).toBe('https://x.example/p');
    expect(ok('http://x.example')).toBe('http://x.example');
    expect(ok('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(ok('tel:+911234')).toBe('tel:+911234');
    expect(ok('/products/x')).toBe('/products/x');
    expect(ok('./x')).toBe('./x');
    expect(ok('../x')).toBe('../x');
    expect(ok('#top')).toBe('#top');
    expect(ok('?page=2')).toBe('?page=2');
    expect(ok('products/x')).toBe('products/x');
    expect(ok('')).toBe('');
  });

  it('blocks javascript:, case tricks and control-char splits', () => {
    expect(blocked('javascript:alert(1)')).toContain('javascript');
    expect(blocked('JaVaScRiPt:alert(1)')).toContain('javascript');
    expect(blocked('java\tscript:alert(1)')).toContain('javascript'); // tab stripped FIRST, then matched
    expect(blocked(' javascript:alert(1)')).toContain('javascript');
    expect(blocked('vbscript:x')).toContain('vbscript');
  });

  it('blocks protocol-relative //', () => {
    expect(blocked('//evil.example')).toContain('protocol-relative');
  });

  it('data: only as data:image/* and only in src', () => {
    expect(ok('data:image/png;base64,AAAA', 'src')).toBe('data:image/png;base64,AAAA');
    expect(blocked('data:image/png;base64,AAAA', 'href')).toContain('data:');
    expect(blocked('data:text/html,<script>x</script>', 'src')).toContain('data:');
  });

  it('strips control characters everywhere and trims spaces', () => {
    expect(ok('  /a\nb  ')).toBe('/ab');
  });
});

describe('srcset is a candidate list (W-11c)', () => {
  const ok = (raw: string): string => {
    const r = sanitizeSrcset(raw);
    if (!r.ok) throw new Error(`expected ok: ${raw} (${r.reason})`);
    return r.url;
  };
  const blocked = (raw: string): string => {
    const r = sanitizeSrcset(raw);
    if (r.ok) throw new Error(`expected block: ${raw} (got ${JSON.stringify(r.url)})`);
    return r.reason;
  };

  describe('candidate splitting', () => {
    it('splits on whitespace-then-comma, per WHATWG', () => {
      expect(parseSrcsetCandidates('/a.jpg 1x, /b.jpg 2x')).toEqual([
        { url: '/a.jpg', descriptor: '1x' },
        { url: '/b.jpg', descriptor: '2x' },
      ]);
      expect(parseSrcsetCandidates('/a.jpg,/b.jpg')).toEqual([{ url: '/a.jpg,/b.jpg', descriptor: '' }]);
      expect(parseSrcsetCandidates('/a.jpg, /b.jpg')).toEqual([
        { url: '/a.jpg', descriptor: '' },
        { url: '/b.jpg', descriptor: '' },
      ]);
      expect(parseSrcsetCandidates('   ')).toEqual([]);
      expect(parseSrcsetCandidates('')).toEqual([]);
      expect(parseSrcsetCandidates(',,,')).toEqual([]);
    });

    it('tolerates runs of separators and newlines without backtracking', () => {
      expect(parseSrcsetCandidates('\n /a.jpg\t400w ,,\r\n /b.jpg  800w \n')).toEqual([
        { url: '/a.jpg', descriptor: '400w' },
        { url: '/b.jpg', descriptor: '800w' },
      ]);
    });
  });

  describe('descriptors', () => {
    it('accepts Nw and Nx (and fractional x), rejects everything else', () => {
      for (const good of ['', '1x', '2x', '1.5x', '400w', '1920w', '10x']) {
        expect(srcsetDescriptorValid(good), good).toBe(true);
      }
      for (const bad of ['1y', 'x', 'w', '0x', '0w', '00w', '1.5w', '-2x', '+2x', '1..5x', '2 x', '1e3x', '1X', '2W']) {
        expect(srcsetDescriptorValid(bad), bad).toBe(false);
      }
    });
  });

  describe('per-candidate URL sanitization', () => {
    it('passes safe candidates and re-serializes canonically', () => {
      expect(ok('/a.jpg 1x, /b.jpg 2x')).toBe('/a.jpg 1x, /b.jpg 2x');
      expect(ok('  /a.jpg   1x ,   /b.jpg   2x  ')).toBe('/a.jpg 1x, /b.jpg 2x');
      expect(ok('https://cdn.example/a.jpg 400w')).toBe('https://cdn.example/a.jpg 400w');
      expect(ok('/only.jpg')).toBe('/only.jpg');
      expect(ok('')).toBe('');
      expect(ok('   ')).toBe('');
    });

    it('checks EVERY candidate, not just the first (the v0.1 hole)', () => {
      expect(blocked('/a.jpg 1x, javascript:alert(1) 2x')).toContain('candidate 2');
      expect(blocked('/a.jpg 1x, /b.jpg 2x, vbscript:x 3x')).toContain('candidate 3');
      expect(blocked('javascript:alert(1) 1x, /b.jpg 2x')).toContain('candidate 1');
    });

    it('applies the same scheme allowlist src gets — including control-char splits', () => {
      // Non-whitespace control chars are stripped INSIDE a candidate, so the
      // classic `java\x01script:` split is still caught by the scheme check…
      expect(blocked('javascript:alert(1) 1x')).toContain('javascript');
      // …while ASCII whitespace is a srcset separator, so `java\tscript:` is
      // rejected as a malformed candidate rather than a bad scheme. Blocked
      // either way; what matters is that nothing gets through.
      expect(blocked('java\tscript:alert(1) 1x')).toBeTruthy();
      const nul = String.fromCharCode(1);
      expect(blocked(`java${nul}script:alert(1) 1x`)).toContain('javascript');
      expect(blocked('//evil.example 1x')).toContain('protocol-relative');
      expect(ok('data:image/png;base64,AAAA 1x')).toBe('data:image/png;base64,AAAA 1x');
      expect(blocked('data:text/html,<script>x</script> 1x')).toContain('data:');
    });

    it('rejects the WHOLE attribute when any candidate fails (fail closed)', () => {
      const r = sanitizeSrcset('/good.jpg 1x, javascript:bad 2x, /also-good.jpg 3x');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain('candidate 2');
    });

    it('rejects invalid descriptors on otherwise-safe URLs', () => {
      expect(blocked('/a.jpg 1x, /b.jpg 2y')).toContain('descriptor');
      expect(blocked('/a.jpg banana')).toContain('descriptor');
    });

    it('caps the candidate count', () => {
      const many = Array.from({ length: 200 }, (_v, i) => `/a${String(i)}.jpg ${String(i + 1)}w`).join(', ');
      expect(blocked(many)).toContain('candidates');
    });

    it('is deterministic: same input, byte-identical output', () => {
      const input = ' /a.jpg  1x ,, /b.jpg 2x ';
      expect(sanitizeSrcset(input)).toEqual(sanitizeSrcset(input));
    });
  });
});

describe('untrusted-key and value guards', () => {
  it('names exactly the three reserved property names', () => {
    expect(isForbiddenKey('__proto__')).toBe(true);
    expect(isForbiddenKey('constructor')).toBe(true);
    expect(isForbiddenKey('prototype')).toBe(true);
    for (const fine of ['title', 'proto', '__proto', 'Constructor', '', 'toString']) {
      expect(isForbiddenKey(fine), fine).toBe(false);
    }
  });

  it('validates all six hex digits of a color, not just # and length', () => {
    for (const good of ['#000000', '#ffffff', '#AABBCC', '#a1b2c3', '#DeadBe']) {
      expect(isHexColorLiteral(good), good).toBe(true);
    }
    // The v0.1 check ('#' + length 7) accepted every one of these.
    for (const bad of ['#<scrip"', '#zzzzzz', '#gggggg', '# 12345', '#12-456', '#1234 6', 'aabbccd', '#12345', '#1234567', '', '#']) {
      expect(isHexColorLiteral(bad), bad).toBe(false);
    }
  });
});

describe('frozenMap (registry hardening)', () => {
  const map = frozenMap<number>([
    ['a', 1],
    ['b', 2],
  ]);

  it('behaves like a ReadonlyMap', () => {
    expect(map.get('a')).toBe(1);
    expect(map.has('b')).toBe(true);
    expect(map.size).toBe(2);
    expect([...map.keys()]).toEqual(['a', 'b']);
    expect([...map.values()]).toEqual([1, 2]);
    expect([...map.entries()]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect([...map]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    const seen: string[] = [];
    map.forEach((_v, k) => seen.push(k));
    expect(seen).toEqual(['a', 'b']);
  });

  it('never resolves a user-controlled key to an inherited member', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
      expect(map.get(key), key).toBeUndefined();
      expect(map.has(key), key).toBe(false);
    }
  });

  it('is frozen, null-prototype and exposes no mutator', () => {
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.getPrototypeOf(map)).toBeNull();
    const asAny = map as unknown as Record<string, unknown>;
    expect(asAny['set']).toBeUndefined();
    expect(asAny['delete']).toBeUndefined();
    expect(asAny['clear']).toBeUndefined();
  });
});

describe('JSON-LD context (W-10)', () => {
  it('escapes </script>, <!--, & and JS line separators as \\uXXXX', () => {
    const json = serializeJsonLd({ name: '</script><!--  &' });
    expect(json).toBe('{"name":"\\u003c\\/script\\u003e\\u003c!--\\u2028\\u2029\\u0026"}');
    expect(json.includes('</')).toBe(false);
    expect(json.includes('<!--')).toBe(false);
  });

  it('serializes primitives, lists, records; null for none; skips undefined', () => {
    expect(serializeJsonLd({ a: 1, b: [true, 'x'], c: null, d: undefined })).toBe('{"a":1,"b":[true,"x"],"c":null}');
  });

  it('rejects Html values, non-finite numbers and over-deep nesting', () => {
    expect(() => serializeJsonLd({ x: htmlValue('<b>') })).toThrowError(OrbitRenderError);
    expect(() => serializeJsonLd({ x: Infinity })).toThrowError(OrbitRenderError);
    let deep: unknown = 'x';
    for (let i = 0; i < 20; i += 1) deep = [deep];
    expect(() => serializeJsonLd(deep)).toThrowError(OrbitRenderError);
  });
});
