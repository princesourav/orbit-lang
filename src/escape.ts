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
 * This module is also the home of the leaf-level SINK GUARDS shared by the
 * runtime seam — `sanitizeUrl`, `sanitizeSrcset`, `isForbiddenKey`,
 * `isHexColorLiteral` — and of `frozenMap`, the registry-hardening primitive.
 * They live here because escape.ts imports nothing but `diagnostics` and
 * `limits`, so every other module can depend on it without a cycle.
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

/**
 * Attribute values. The interpreter always emits them inside DOUBLE quotes,
 * so `'` is not strictly required — but that invariant lived in one call site
 * (`emitAttrValue`) and was enforced by convention, not by the type system.
 * We escape `'` as well: cheap insurance that makes `escapeAttr` safe in a
 * single-quoted context too, so a future emitter cannot silently break it.
 * (W-08a; locked by a test in escape.test.ts.)
 */
export function escapeAttr(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (c === '&') out += '&amp;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
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
// URL-ATTR: srcset is a CANDIDATE LIST, not a URL (W-11c)
// ---------------------------------------------------------------------------

/**
 * Engine-local cap: `srcset` candidate lists longer than this are refused
 * outright rather than sanitized one by one. Defined here (not in limits.ts)
 * because escape.ts owns the srcset sink.
 */
const MAX_SRCSET_CANDIDATES = 64;

export interface SrcsetCandidate {
  url: string;
  /** `` | `<int>w` | `<number>x` — already trimmed, not yet validated. */
  descriptor: string;
}

function isSrcsetSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

/**
 * WHATWG "parse a srcset attribute", minus the descriptor semantics: collect
 * a run of non-whitespace as the URL; if it ended in commas the candidate has
 * no descriptor; otherwise everything up to the next comma is the descriptor.
 * Linear, no regex, no backtracking.
 */
export function parseSrcsetCandidates(raw: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length) {
      const c = raw[i] ?? '';
      if (!isSrcsetSpace(c) && c !== ',') break;
      i += 1;
    }
    if (i >= raw.length) break;
    const urlStart = i;
    while (i < raw.length && !isSrcsetSpace(raw[i] ?? '')) i += 1;
    let url = raw.slice(urlStart, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      while (url.endsWith(',')) url = url.slice(0, -1);
    } else {
      while (i < raw.length && isSrcsetSpace(raw[i] ?? '')) i += 1;
      const dStart = i;
      while (i < raw.length && raw[i] !== ',') i += 1;
      descriptor = raw.slice(dStart, i).trim();
      if (i < raw.length) i += 1; // consume the separating comma
    }
    if (url !== '') out.push({ url, descriptor });
    if (out.length > MAX_SRCSET_CANDIDATES) return out;
  }
  return out;
}

/** `<int>w` or `<number>x`; digits only, value must be non-zero. No regex. */
export function srcsetDescriptorValid(d: string): boolean {
  if (d === '') return true;
  const unit = d[d.length - 1];
  if (unit !== 'w' && unit !== 'x') return false;
  const num = d.slice(0, d.length - 1);
  if (num.length === 0) return false;
  let digits = 0;
  let dots = 0;
  let nonZero = false;
  for (let i = 0; i < num.length; i += 1) {
    const code = num.charCodeAt(i);
    if (code === 0x2e) {
      if (unit !== 'x') return false; // width descriptors are integers
      dots += 1;
      if (dots > 1) return false;
      continue;
    }
    if (code < 0x30 || code > 0x39) return false;
    digits += 1;
    if (code !== 0x30) nonZero = true;
  }
  return digits > 0 && nonZero;
}

/**
 * Sanitizes a whole `srcset` value. Each candidate URL is checked
 * INDEPENDENTLY against the same scheme allowlist `src` gets (srcset is the
 * plural of src; treating it as one opaque URL — as v0.1 did — meant
 * `a.jpg 1x, javascript:alert(1) 2x` passed the scheme check on the first
 * token alone).
 *
 * Fail-closed: if ANY candidate's URL or descriptor is rejected, the whole
 * attribute is rejected and the caller's `urlPolicy` decides between a blank
 * attribute and a hard render failure. The returned value is re-serialized
 * canonically (`url desc, url desc`) so output stays deterministic.
 */
export function sanitizeSrcset(raw: string): UrlCheck {
  const candidates = parseSrcsetCandidates(raw);
  if (candidates.length === 0) return { ok: true, url: '' };
  if (candidates.length > MAX_SRCSET_CANDIDATES) {
    return { ok: false, reason: `srcset has more than ${MAX_SRCSET_CANDIDATES} candidates` };
  }
  let out = '';
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    const checked = sanitizeUrl(candidate.url, 'src');
    if (!checked.ok) {
      return { ok: false, reason: `srcset candidate ${i + 1}: ${checked.reason}` };
    }
    if (checked.url === '') {
      return { ok: false, reason: `srcset candidate ${i + 1} is empty after sanitization` };
    }
    if (!srcsetDescriptorValid(candidate.descriptor)) {
      return {
        ok: false,
        reason: `srcset candidate ${i + 1} has an invalid descriptor ${JSON.stringify(candidate.descriptor.slice(0, 24))} (expected Nw or Nx)`,
      };
    }
    if (out !== '') out += ', ';
    out += candidate.descriptor === '' ? checked.url : `${checked.url} ${candidate.descriptor}`;
  }
  return { ok: true, url: out };
}

// ---------------------------------------------------------------------------
// Untrusted-key and value-shape guards
// ---------------------------------------------------------------------------

/**
 * Property names that must never be used to index a host-supplied object.
 * Orbit has no dynamic member access, so these can only arrive from a
 * hand-written or poisoned AST — but `obj["constructor"]` reaching the Object
 * constructor is exactly the class of bug that turns "no dynamic access" into
 * a false claim, so the runtime refuses them structurally.
 */
export function isForbiddenKey(name: string): boolean {
  return name === '__proto__' || name === 'constructor' || name === 'prototype';
}

/** `#rrggbb`, all six characters real hex digits. Character codes, no regex. */
export function isHexColorLiteral(s: string): boolean {
  if (s.length !== 7) return false;
  if (s.charCodeAt(0) !== 0x23) return false;
  for (let i = 1; i < 7; i += 1) {
    const c = s.charCodeAt(i);
    const digit = c >= 0x30 && c <= 0x39;
    const lower = c >= 0x61 && c <= 0x66;
    const upper = c >= 0x41 && c <= 0x46;
    if (!digit && !lower && !upper) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// CSS-CUSTOM-PROPERTY — the seventh context
// ---------------------------------------------------------------------------

/**
 * The value half of `--accent={settings.accent}`.
 *
 * A seventh context rather than a reuse of ATTR, because a custom property is
 * substituted by the browser into arbitrary later CSS positions — a `color`, a
 * `background`, inside `calc()`, inside a `url()` if some stylesheet says so.
 * What is inert in an attribute is not automatically inert there.
 *
 * The analysis is short because the context is defined by what may ENTER it:
 *
 *     #  exactly one, position 0
 *     0-9 a-f A-F  exactly six, positions 1-6
 *     everything else  cannot be emitted at all
 *
 * So there is no escape function here. An escaper transforms hostile input into
 * safe output; this REFUSES it. That difference is the whole safety argument,
 * and it is why the design does not generalise to `Length` or `FontFamily`,
 * whose lexical forms cannot be written as a table this short.
 *
 * The declared type is deliberately not taken as evidence. `isHexColorLiteral`
 * is applied to merchant settings and component-entry props, but a `Color`
 * arriving as a page binding or as a field of a host object reaches a sink
 * unvalidated — so a sink that trusted the type would inherit that hole. This
 * is the same rule URLs already follow: checked at the sink, never trusted from
 * the type.
 */
export function customPropertyValueOk(value: unknown): value is string {
  return typeof value === 'string' && isHexColorLiteral(value);
}

/**
 * A CSS custom property NAME, as written in the template.
 *
 * Static by construction — the parser never lets one be interpolated — so this
 * is a structural re-check for stored trees rather than a runtime guard against
 * template input.
 */
export function isCustomPropertyName(name: string): boolean {
  if (!name.startsWith('--') || name.length < 3) return false;
  for (let i = 2; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    const digit = c >= 0x30 && c <= 0x39;
    const lower = c >= 0x61 && c <= 0x7a;
    const upper = c >= 0x41 && c <= 0x5a;
    const dash = c === 0x2d;
    const underscore = c === 0x5f;
    if (!digit && !lower && !upper && !dash && !underscore) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Registry hardening
// ---------------------------------------------------------------------------

/**
 * A frozen, null-prototype, structurally-immutable `ReadonlyMap` view.
 *
 * Two properties matter. (1) Lookups go through `Map`, so a user-controlled
 * key like `__proto__` or `constructor` can never resolve to an inherited
 * member — `frozenMap(...).get('constructor')` is `undefined`, full stop.
 * (2) The returned object is frozen and exposes no mutators, so a registry
 * cannot be extended after construction: `(STDLIB as {set?: unknown}).set`
 * is `undefined`, not a working `Map.prototype.set`.
 */
export function frozenMap<V>(entries: readonly (readonly [string, V])[]): ReadonlyMap<string, V> {
  const inner = new Map<string, V>(entries);
  const view = {
    get size(): number {
      return inner.size;
    },
    get: (key: string): V | undefined => inner.get(key),
    has: (key: string): boolean => inner.has(key),
    forEach: (
      cb: (value: V, key: string, map: ReadonlyMap<string, V>) => void,
      thisArg?: unknown,
    ): void => {
      inner.forEach((v, k) => {
        cb.call(thisArg, v, k, out);
      });
    },
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
  };
  Object.setPrototypeOf(view, null);
  const out = Object.freeze(view) as unknown as ReadonlyMap<string, V>;
  return out;
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
