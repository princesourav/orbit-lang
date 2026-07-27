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
    // Test stand-in for a sanitizer-backed richtext sink (unsafe by contract).
    name: 'richtext',
    params: [t.string()],
    returns: t.html(),
    unsafeHtml: true,
    impl: (args) => String(args[0]),
  },
];

export const PAGE_GLOBALS: Record<string, Type> = {
  collection: t.object('Collection'),
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
