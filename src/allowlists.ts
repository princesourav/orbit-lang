/**
 * Closed element / attribute / URL-attribute tables (W-12, W-11).
 *
 * These are ALLOWLISTS, not denylists: anything absent is rejected at parse
 * time. The banned tables exist only to give better error messages for the
 * constructs attackers (and confused developers) reach for first. Structural
 * re-validation (`validate-ast.ts`) re-checks stored ASTs against the same
 * tables, so a poisoned AST row cannot smuggle an element the parser would
 * have refused (W-36).
 */

export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'br',
  'col',
  'hr',
  'img',
  'input',
  'source',
  'track',
  'wbr',
]);

/** Escapable-raw-text elements: interpolation allowed, RCDATA-escaped. */
export const RCDATA_ELEMENTS: ReadonlySet<string> = new Set(['title', 'textarea']);

export const ELEMENT_ALLOWLIST: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'audio',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'button',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'main',
  'mark',
  'menu',
  'meter',
  'nav',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'section',
  'select',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

/** Elements rejected with a dedicated reason (everything else absent from the
 * allowlist gets the generic "not in the element allowlist" error). */
export const BANNED_ELEMENTS: ReadonlyMap<string, string> = new Map([
  ['script', 'scripts cannot appear in templates; client behavior ships as platform runtime islands'],
  ['style', 'ship CSS as a theme asset; <style> (RAWTEXT) is not allowed in templates'],
  ['iframe', 'embedded browsing contexts are not allowed'],
  ['object', 'plugin containers are not allowed'],
  ['embed', 'plugin containers are not allowed'],
  ['base', '<base> rewrites every relative URL on the page'],
  ['meta', 'document metadata is host-owned; declare it through the host, not markup'],
  ['link', 'external resource links are host-owned; declare fonts/styles through the host'],
  ['template', 'inert template containers defeat static analysis'],
  ['noscript', 'noscript re-parses its content in a second context'],
  ['svg', 'svg re-admits script, foreignObject and javascript: xlink URLs'],
  ['math', 'MathML re-admits script contexts'],
  ['frame', 'frames are not allowed'],
  ['frameset', 'frames are not allowed'],
  ['applet', 'plugin containers are not allowed'],
  ['portal', 'embedded browsing contexts are not allowed'],
]);

/** Closed URL-attribute table (W-11b): value is URL-context, sink-sanitized. */
export const URL_ATTRS: ReadonlySet<string> = new Set([
  'href',
  'src',
  'srcset',
  'action',
  'formaction',
  'poster',
  'cite',
]);

const GLOBAL_ATTRS: ReadonlySet<string> = new Set([
  'id',
  'class',
  'title',
  'lang',
  'dir',
  'role',
  'tabindex',
  'hidden',
  'slot',
  'style', // static text only — any interpolation in style is a parse error (W-09)
  'verbatim', // engine marker: disables interpolation in the subtree; never emitted
]);

const SPECIFIC_ATTRS: ReadonlySet<string> = new Set([
  ...URL_ATTRS,
  'target',
  'rel',
  'download',
  'hreflang',
  'type',
  'sizes',
  'alt',
  'width',
  'height',
  'loading',
  'decoding',
  'fetchpriority',
  'method',
  'enctype',
  'novalidate',
  'name',
  'value',
  'placeholder',
  'required',
  'disabled',
  'checked',
  'readonly',
  'multiple',
  'selected',
  'for',
  'rows',
  'cols',
  'wrap',
  'min',
  'max',
  'step',
  'maxlength',
  'minlength',
  'autocomplete',
  'inputmode',
  'list',
  'accept',
  'colspan',
  'rowspan',
  'scope',
  'headers',
  'start',
  'reversed',
  'datetime',
  'open',
  'controls',
  'muted',
  'loop',
  'playsinline',
  'preload',
  'autoplay',
  'label',
  'kind',
  'srclang',
  'default',
  'form',
  'formmethod',
  'formenctype',
  'high',
  'low',
  'optimum',
  'span',
]);

/**
 * Returns a rejection reason for attribute names that are banned outright,
 * before the allowlist is consulted.
 */
/**
 * Attribute name shapes RESERVED for a future version of the language.
 *
 * Distinct from `attrRejection`, which lists things banned on their merits.
 * These are not banned — they are unclaimed syntax being claimed now, while it
 * is free. A theme that used `on:` or `@` for something else would stop
 * compiling the day events land, and by then themes exist.
 *
 * Reported separately so the author is told "reserved, not implemented" rather
 * than "namespaced attributes are not allowed", which is true of `on:click`
 * and tells them nothing.
 */
export function reservedAttrSyntax(name: string): string | undefined {
  if (name.startsWith('on:')) {
    return 'the `on:name` attribute form is reserved for a future version of Orbit and is not implemented';
  }
  if (name.startsWith('@')) {
    return 'the `@name` attribute form is reserved for a future version of Orbit and is not implemented';
  }
  return undefined;
}

export function attrRejection(name: string): string | undefined {
  if (name.length > 2 && name.startsWith('on')) {
    return 'event-handler attributes (on*) are not allowed';
  }
  if (name === 'srcdoc') return 'srcdoc embeds a nested document and is not allowed';
  if (name === 'ping') return 'ping beacons are not allowed';
  if (name === 'background' || name === 'longdesc') {
    return 'legacy URL attributes are not allowed';
  }
  if (name.includes(':')) return 'namespaced attributes (xlink:*, xml:*) are not allowed';
  return undefined;
}

/** Closed attribute allowlist: global + per-element specifics + data-/aria- families. */
export function attrAllowed(name: string): boolean {
  if (attrRejection(name) !== undefined) return false;
  if (GLOBAL_ATTRS.has(name) || SPECIFIC_ATTRS.has(name)) return true;
  if (name.startsWith('data-') && name.length > 5) return true;
  if (name.startsWith('aria-') && name.length > 5) return true;
  return false;
}
