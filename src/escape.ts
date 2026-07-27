/**
 * Context-aware escaping. Six contexts total (W-08):
 *
 *   TEXT      — normal element content            → escapeText
 *   RCDATA    — <title>/<textarea> content        → escapeRcdata
 *   ATTR      — double-quoted attribute values    → escapeAttr
 *   URL-ATTR  — closed URL-attribute table        → sanitizeUrl THEN escapeAttr
 *   JSON-LD   — <json-ld> serialization           → serializeJsonLd
 *   RAWTEXT   — unreachable BY CONSTRUCTION: no RAWTEXT element (<script>,
 *               <style>) exists in the element allowlist at all, so there is
 *               no code path that could emit into one.
 *
 * No regex anywhere; every function is a single linear pass.
 */
import { OrbitRenderError } from './diagnostics';
import { LIMITS } from './limits';

export function escapeText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else out += c;
  }
  return out;
}

/** RCDATA decodes character references, so &amp; and &lt; are sufficient. */
export function escapeRcdata(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else out += c;
  }
  return out;
}

/** Values are always emitted inside double quotes. */
export function escapeAttr(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (c === '&') out += '&amp;';
    else if (c === '"') out += '&quot;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// URL-ATTR: sink-side scheme allowlist (W-11)
// ---------------------------------------------------------------------------

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const SAFE_SCHEMES: readonly string[] = ['http', 'https', 'mailto', 'tel'];

/**
 * Applied at the SINK, never trusted from the type (W-11a):
 * - strips C0 control characters and DEL first (defeats java\tscript: splits)
 * - allows http/https/mailto/tel, site-relative, ./ ../ ?query #anchor
 * - rejects protocol-relative //
 * - rejects data: except data:image/* and only in `src`
 */
export function sanitizeUrl(raw: string, attrName: string): UrlCheck {
  let s = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) continue; // control chars, incl. tab/newline
    s += raw[i] ?? '';
  }
  s = s.trim();
  if (s === '') return { ok: true, url: '' };
  if (s.startsWith('//')) return { ok: false, reason: 'protocol-relative URLs are not allowed' };
  if (s.startsWith('/') || s.startsWith('#') || s.startsWith('?') || s.startsWith('./') || s.startsWith('../')) {
    return { ok: true, url: s };
  }
  // Find a scheme: a ':' occurring before any '/', '?' or '#'.
  let colon = -1;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (c === '/' || c === '?' || c === '#') break;
    if (c === ':') {
      colon = i;
      break;
    }
  }
  if (colon === -1) return { ok: true, url: s }; // bare relative path
  const scheme = s.slice(0, colon).toLowerCase();
  if (SAFE_SCHEMES.includes(scheme)) return { ok: true, url: s };
  if (scheme === 'data') {
    if (attrName === 'src' && s.toLowerCase().startsWith('data:image/')) {
      return { ok: true, url: s };
    }
    return { ok: false, reason: 'data: URLs are only allowed as data:image/* in src' };
  }
  return { ok: false, reason: `scheme ${JSON.stringify(scheme)} is not allowed` };
}

// ---------------------------------------------------------------------------
// JSON-LD serializer (W-10)
// ---------------------------------------------------------------------------

/**
 * Primitives, records and lists ONLY. Strings escape `<`, `>`, `&`, `/`,
 * U+2028 and U+2029 as \uXXXX unconditionally, so the emitted script body can
 * never contain `</script`, `<!--`, or a JS line separator.
 */
export function serializeJsonLd(value: unknown): string {
  return serialize(value, 0);
}

function serialize(value: unknown, depth: number): string {
  if (depth > LIMITS.maxJsonLdDepth) {
    throw new OrbitRenderError('O4030', `json-ld nesting exceeds depth ${LIMITS.maxJsonLdDepth}`);
  }
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OrbitRenderError('O4031', 'json-ld numbers must be finite');
    }
    return String(value);
  }
  if (typeof value === 'string') return jsonString(value);
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ',';
      out += serialize(value[i], depth + 1);
    }
    return out + ']';
  }
  if (typeof value === 'object') {
    if (typeof (value as { __orbitHtml?: unknown }).__orbitHtml === 'string') {
      throw new OrbitRenderError('O4032', 'Html values cannot appear in json-ld');
    }
    let out = '{';
    let first = true;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (!first) out += ',';
      first = false;
      out += jsonString(k) + ':' + serialize(v, depth + 1);
    }
    return out + '}';
  }
  throw new OrbitRenderError('O4033', `json-ld admits primitives, records and lists only (found ${typeof value})`);
}

function hex4(code: number): string {
  const h = code.toString(16);
  return '\\u' + '0000'.slice(h.length) + h;
}

function jsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    const code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 0x20) out += hex4(code);
    else if (c === '<' || c === '>' || c === '&') out += hex4(code);
    else if (c === '/') out += '\\/';
    else if (code === 0x2028 || code === 0x2029) out += hex4(code);
    else out += c;
  }
  return out + '"';
}
