/**
 * Fake host for tests: a small commerce-ish object model + typed host
 * filters. This is exactly the bring-your-own-object-model seam a real
 * embedder implements; nothing here ships in the build.
 */
import { check, type CheckResult } from './checker';
import { type Diagnostic } from './diagnostics';
import { type HostFilterDecl } from './host';
import { parseProgram, type SourceFile } from './parser';
import { type Program } from './ast';
import { t, TypeRegistry, type Type } from './types';

export function makeRegistry(): TypeRegistry {
  const registry = new TypeRegistry();
  registry.defineObject('Product', {
    title: t.string(),
    url: t.url(),
    vendor: t.optional(t.string()),
    price: t.money(),
    compareAt: t.optional(t.money()),
    isNew: t.bool(),
    cover: t.image(),
    tags: t.list(t.string()),
    rating: t.optional(t.float()),
  });
  registry.defineObject('Collection', {
    title: t.string(),
    products: t.list(t.object('Product')),
  });
  // A host-declared string-literal union: the closed set `<match>` checks
  // exhaustiveness against. Kept off Product so existing fixtures need no new
  // field.
  registry.defineObject('Banner', {
    style: t.union('info', 'warn'),
    text: t.string(),
  });
  return registry;
}

interface MoneyData {
  amountMinor: number;
  currency: string;
}

export function money(amountMinor: number, currency = 'INR'): MoneyData {
  return { amountMinor, currency };
}

export const HOST_FILTERS: HostFilterDecl[] = [
  {
    name: 'money',
    params: [t.money()],
    returns: t.moneyText(),
    impl: (args) => {
      const m = args[0] as MoneyData;
      return `₹${(m.amountMinor / 100).toFixed(2)}`;
    },
  },
  {
    name: 'imgUrl',
    params: [t.image(), t.int()],
    returns: t.url(),
    impl: (args) => {
      const img = args[0] as { key: string };
      return `/img/${img.key}?w=${String(args[1])}`;
    },
  },
  {
    /*
     * The named-argument case, and the reason the feature exists: this filter
     * has four knobs and no call site should have to remember their order.
     * A skipped optional arrives as `null` — the optional law means no argument
     * can ever BE null, so a null slot can only mean "not supplied".
     */
    name: 'imgTag',
    params: [t.image()],
    optionalParams: [
      { name: 'width', type: t.int() },
      { name: 'crop', type: t.string() },
      { name: 'quality', type: t.int() },
    ],
    returns: t.url(),
    impl: (args) => {
      const img = args[0] as { key: string };
      const parts: string[] = [];
      if (args[1] !== undefined && args[1] !== null) parts.push(`w=${String(args[1])}`);
      if (args[2] !== undefined && args[2] !== null) parts.push(`c=${String(args[2])}`);
      if (args[3] !== undefined && args[3] !== null) parts.push(`q=${String(args[3])}`);
      return parts.length === 0 ? `/img/${img.key}` : `/img/${img.key}?${parts.join('&')}`;
    },
  },
  /*
   * One filter per Html obligation, so tests can exercise all three branches.
   * The `impl`s are stand-ins — what matters here is the DECLARATION, since
   * that is what the checker and interpreter key their behaviour off.
   */
  {
    /** Untrusted in, safe out. Sanctioned path: silent at every use site. */
    name: 'richtext',
    params: [t.string()],
    returns: t.html(),
    sanitizer: true,
    impl: (args) => String(args[0]),
  },
  {
    /** Trusted by host fiat, emitted raw. Warns at every use site. */
    name: 'rawHtml',
    params: [t.string()],
    returns: t.html(),
    trustedHtml: true,
    impl: (args) => String(args[0]),
  },
  {
    /**
     * Html in, Html out. Silent, but obligated to preserve well-formedness —
     * this stand-in truncates on a tag boundary rather than mid-tag, which is
     * the whole point of the obligation.
     */
    name: 'truncateHtml',
    params: [t.html(), t.int()],
    returns: t.html(),
    htmlTransform: true,
    impl: (args) => {
      const html = (args[0] as { __orbitHtml: string }).__orbitHtml;
      const max = Number(args[1]);
      if (html.length <= max) return html;
      // Cut at the last '>' before the limit so a tag is never sliced open.
      const cut = html.lastIndexOf('>', max);
      return cut === -1 ? '' : html.slice(0, cut + 1);
    },
  },
];

export const PAGE_GLOBALS: Record<string, Type> = {
  collection: t.object('Collection'),
  banner: t.object('Banner'),
};

export interface CompiledProgram {
  program: Program;
  result: CheckResult;
}

/** Parse + check; throws on PARSE errors (tests assert check diagnostics). */
export function compile(
  files: readonly SourceFile[],
  hostFilters: readonly HostFilterDecl[] = HOST_FILTERS,
): CompiledProgram {
  const parsed = parseProgram(files);
  if (!parsed.ok) {
    throw new Error('parse failed:\n' + parsed.diagnostics.map((d) => `${d.code}: ${d.message}`).join('\n'));
  }
  const result = check(parsed.program, {
    registry: makeRegistry(),
    hostFilters,
    pageGlobals: PAGE_GLOBALS,
  });
  return { program: parsed.program, result };
}

/** Compile and require zero errors (warnings allowed). */
export function compileOk(
  files: readonly SourceFile[],
  hostFilters: readonly HostFilterDecl[] = HOST_FILTERS,
): Program {
  const { program, result } = compile(files, hostFilters);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new Error('check failed:\n' + errors.map((d) => `${d.code}: ${d.message}`).join('\n'));
  }
  return program;
}

export function codesOf(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

/** Single-component sugar: wraps a body in a Card component with Product prop. */
export function cardSource(body: string, extraFrontmatter = ''): SourceFile {
  return {
    name: 'components/card.orbit',
    source: `---\ncomponent Card\nprops {\n  product: Product\n  showVendor: Bool = false\n}\n${extraFrontmatter}---\n${body}`,
  };
}

export function pageSource(body: string, extraFrontmatter = ''): SourceFile {
  return {
    name: 'pages/collection.orbit',
    source: `---\npage collection\n${extraFrontmatter}---\n${body}`,
  };
}
