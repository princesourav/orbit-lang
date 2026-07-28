/**
 * The conformance host — the single normative definition.
 *
 * Every case in the corpus compiles and renders against exactly this host, and
 * `README.md` specifies it in prose so a non-JavaScript implementation can
 * reproduce it. Both the generator and the runner import from here rather than
 * declaring their own copy: two copies of a normative definition is one copy
 * and one bug waiting to happen, and it produced exactly that during the Html
 * trust-model change — the generator gained three filters and the runner did
 * not, so 19 cases failed against a host that no longer matched.
 */
import { t, TypeRegistry } from '../src/types.ts';

/** Fields shared by `Item` and `Data`, so the two stay in step. */
const ITEM_FIELDS = {
  text: t.string(),
  url: t.url(),
  note: t.optional(t.string()),
  count: t.int(),
  ratio: t.float(),
  flag: t.bool(),
  tags: t.list(t.string()),
};

export function makeRegistry() {
  const registry = new TypeRegistry();
  registry.defineObject('Item', { ...ITEM_FIELDS });
  registry.defineObject('Data', { ...ITEM_FIELDS, items: t.list(t.object('Item')) });
  return registry;
}

export const HOST_FILTERS = [
  {
    name: 'shout',
    params: [t.string()],
    returns: t.string(),
    impl: ([s]) => String(s).toUpperCase(),
  },

  /*
   * One filter per Html obligation. The DECLARATIONS are what the checker and
   * interpreter key their behaviour on; the `impl`s are specified exactly so
   * expected output bytes are reproducible by another implementation.
   */
  {
    /** Untrusted in, safe out. Silent at every use site. */
    name: 'richtext',
    params: [t.string()],
    returns: t.html(),
    sanitizer: true,
    // Specified: wrap the input in <p>…</p> and replace every '<' with '&lt;'.
    // A pass-through would make every escaping case vacuous, so this sanitizer
    // does something observable.
    //   ""        -> "<p></p>"
    //   "a<b"     -> "<p>a&lt;b</p>"
    impl: ([s]) => `<p>${String(s).split('<').join('&lt;')}</p>`,
  },
  {
    /** Trusted by host fiat, emitted raw. Warns at every use site. */
    name: 'rawHtml',
    params: [t.string()],
    returns: t.html(),
    trustedHtml: true,
    // Specified: identity. The host asserts the input is already trusted.
    //   ""        -> ""
    //   "<b>x"    -> "<b>x"
    impl: ([s]) => String(s),
  },
  {
    /** Html in, Html out. Silent, obligated to preserve well-formedness. */
    name: 'truncateHtml',
    params: [t.html(), t.int()],
    returns: t.html(),
    htmlTransform: true,
    // Specified: if the markup is at most `max` characters, return it
    // unchanged. Otherwise cut at the LAST '>' at or before `max`, keeping
    // that '>', so a tag is never sliced open. If there is no such '>',
    // return the empty string rather than a fragment of a tag.
    //   ("<p>hello</p>", 6)  -> "<p>"
    //   ("<p>hi</p>", 99)    -> "<p>hi</p>"
    //   ("abcdef", 3)        -> ""
    impl: ([html, max]) => {
      const source = html.__orbitHtml;
      const limit = Number(max);
      if (source.length <= limit) return source;
      const cut = source.lastIndexOf('>', limit);
      return cut === -1 ? '' : source.slice(0, cut + 1);
    },
  },
];

export const PAGE_GLOBALS = { data: t.object('Data') };
