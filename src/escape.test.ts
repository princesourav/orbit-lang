import { describe, expect, it } from 'vitest';
import {
  escapeAttr,
  escapeRcdata,
  escapeText,
  sanitizeUrl,
  serializeJsonLd,
} from './escape';
import { OrbitRenderError } from './diagnostics';
import { unsafeHtmlValue } from './host';

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
    expect(() => serializeJsonLd({ x: unsafeHtmlValue('<b>') })).toThrowError(OrbitRenderError);
    expect(() => serializeJsonLd({ x: Infinity })).toThrowError(OrbitRenderError);
    let deep: unknown = 'x';
    for (let i = 0; i < 20; i += 1) deep = [deep];
    expect(() => serializeJsonLd(deep)).toThrowError(OrbitRenderError);
  });
});
