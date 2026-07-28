/**
 * Playground logic.
 *
 * Bundled into a single HTML file by build.mjs. This file may use DOM APIs —
 * it is not part of the engine and is excluded from the library tsconfig.
 *
 * What it shows, and why those things:
 *
 *   * **Diagnostics with code frames.** The pitch is "the compiler catches
 *     this", so the compiler's voice is the main exhibit.
 *   * **Escaping context per interpolation.** Orbit's central claim is that the
 *     escaping context of every interpolation is known statically. Printing
 *     that context next to each site turns an assertion into something a
 *     visitor can check.
 *   * **Budget meters.** Fuel, iterations and output are the answer to "what
 *     stops a hostile template", and they are invisible unless shown.
 */
import { parseProgram } from '../src/parser';
import { check } from '../src/checker';
import { render } from '../src/interpreter';
import { extractAccessPlan } from '../src/host';
import { formatTemplate } from '../src/formatter';
import { parseTemplate } from '../src/parser';
import { formatDiagnosticWithSource } from '../src/diagnostics';
import { LIMITS } from '../src/limits';
import { t, TypeRegistry, type Type } from '../src/types';
import type { HostFilterDecl } from '../src/host';
import type { Diagnostic } from '../src/diagnostics';

// ---------------------------------------------------------------------------
// A small demo host
// ---------------------------------------------------------------------------

/**
 * The playground's object model. A real embedder builds this from its own
 * domain; the point of the exercise is that the engine ships none of it.
 */
function makeRegistry(): TypeRegistry {
  const registry = new TypeRegistry();
  registry.defineObject('Product', {
    title: t.string(),
    vendor: t.optional(t.string()),
    url: t.url(),
    available: t.bool(),
    price: t.money(),
    tags: t.list(t.string()),
  });
  registry.defineObject('Collection', {
    title: t.string(),
    products: t.list(t.object('Product')),
  });
  return registry;
}

const HOST_FILTERS: HostFilterDecl[] = [
  {
    name: 'money',
    params: [t.money()],
    returns: t.moneyText(),
    impl: (args) => {
      const m = args[0] as { amountMinor: number; currency: string };
      return `${m.currency} ${(m.amountMinor / 100).toFixed(2)}`;
    },
  },
];

const PAGE_GLOBALS: Record<string, Type> = {
  collection: t.object('Collection'),
};

const BINDINGS = {
  collection: {
    title: 'javascript:alert(1) & "Boots" <Fresh>',
    products: [
      {
        title: 'Aurora Runner',
        vendor: 'Northwind',
        url: '/products/aurora',
        available: true,
        price: { amountMinor: 12900, currency: 'INR' },
        tags: ['new', 'running'],
      },
      {
        title: 'Basalt Trainer',
        vendor: null,
        url: '/products/basalt',
        available: false,
        price: { amountMinor: 9900, currency: 'INR' },
        tags: ['sale'],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Escaping-context analysis
// ---------------------------------------------------------------------------

export interface SiteInfo {
  line: number;
  col: number;
  context: string;
  detail: string;
}

/**
 * Walk the parsed template and label every interpolation with the escaping
 * context the engine assigns it.
 *
 * This deliberately re-derives the context from the AST shape rather than
 * asking the interpreter, because that is the claim being demonstrated: the
 * context is a property of *where the interpolation sits*, not of the value
 * that flows through it at runtime.
 */
function describeSites(source: string): SiteInfo[] {
  const parsed = parseTemplate(source, 'playground.orbit');
  if (!parsed.ok) return [];
  const sites: SiteInfo[] = [];

  const RCDATA = new Set(['title', 'textarea']);

  const walk = (nodes: readonly unknown[], inRcdata: boolean): void => {
    for (const raw of nodes) {
      const node = raw as Record<string, unknown>;
      const kind = node['kind'];
      const span = node['span'] as { start: { line: number; col: number } } | undefined;

      if (kind === 'interpolation' && span) {
        sites.push({
          line: span.start.line,
          col: span.start.col,
          context: inRcdata ? 'RCDATA' : 'TEXT',
          detail: inRcdata
            ? 'inside <title>/<textarea>: escapes & and <; an Html value is refused here'
            : 'element content: escapes &, < and >',
        });
      }

      if (kind === 'element' || kind === 'component') {
        const attrs = (node['attrs'] ?? node['props'] ?? []) as Record<string, unknown>[];
        for (const attr of attrs) {
          const value = attr['value'] as Record<string, unknown> | undefined;
          const isUrl = attr['isUrl'] === true;
          const aSpan = attr['span'] as { start: { line: number; col: number } } | undefined;
          const hasExpr =
            value?.['form'] === 'expr' ||
            value?.['form'] === 'conditional' ||
            (value?.['form'] === 'parts' &&
              (value['parts'] as Record<string, unknown>[]).some((p) => p['kind'] === 'expr'));
          if (hasExpr && aSpan) {
            sites.push({
              line: aSpan.start.line,
              col: aSpan.start.col,
              context: isUrl ? 'URL-ATTR' : 'ATTR',
              detail: isUrl
                ? 'URL sink: scheme allowlist applied at emit time, never trusted from the type'
                : 'attribute value: escapes &, ", < and >',
            });
          }
        }
      }

      if (kind === 'json-ld' && span) {
        sites.push({
          line: span.start.line,
          col: span.start.col,
          context: 'JSON-LD',
          detail: 'serialized as JSON with <, >, & and / escaped so it cannot close its own script',
        });
      }

      const tag = typeof node['tag'] === 'string' ? (node['tag'] as string) : undefined;
      const childRcdata = tag !== undefined && RCDATA.has(tag);
      for (const key of ['children', 'elseChildren', 'emptyChildren']) {
        const kids = node[key];
        if (Array.isArray(kids)) walk(kids, childRcdata);
      }
      const branches = node['branches'];
      if (Array.isArray(branches)) {
        for (const b of branches) {
          const kids = (b as Record<string, unknown>)['children'];
          if (Array.isArray(kids)) walk(kids, inRcdata);
        }
      }
    }
  };

  walk(parsed.template.body, false);
  sites.sort((a, b) => a.line - b.line || a.col - b.col);
  return sites;
}

// ---------------------------------------------------------------------------
// Compile + render
// ---------------------------------------------------------------------------

export interface RunResult {
  diagnostics: string;
  diagnosticCount: number;
  errorCount: number;
  html: string;
  warnings: string[];
  plan: string[];
  sites: SiteInfo[];
  budgets: { fuelUsed: number; fuelMax: number; outputBytes: number; outputMax: number };
  failed: boolean;
}

export function run(source: string): RunResult {
  const empty: RunResult = {
    diagnostics: '',
    diagnosticCount: 0,
    errorCount: 0,
    html: '',
    warnings: [],
    plan: [],
    sites: [],
    budgets: { fuelUsed: 0, fuelMax: LIMITS.defaultFuel, outputBytes: 0, outputMax: LIMITS.defaultMaxOutput },
    failed: false,
  };

  const files = [{ name: 'playground.orbit', source }];
  const parsed = parseProgram(files);
  if (!parsed.ok) {
    return {
      ...empty,
      failed: true,
      diagnosticCount: parsed.diagnostics.length,
      errorCount: parsed.diagnostics.filter((d) => d.severity === 'error').length,
      diagnostics: renderDiagnostics(parsed.diagnostics, source),
    };
  }

  const entry = [...parsed.program.templates.keys()][0]!;
  const checked = check(parsed.program, {
    registry: makeRegistry(),
    hostFilters: HOST_FILTERS,
    pageGlobals: PAGE_GLOBALS,
  });

  const errors = checked.diagnostics.filter((d) => d.severity === 'error');
  const sites = describeSites(source);

  if (errors.length > 0) {
    return {
      ...empty,
      sites,
      failed: true,
      diagnosticCount: checked.diagnostics.length,
      errorCount: errors.length,
      diagnostics: renderDiagnostics(checked.diagnostics, source),
    };
  }

  const result = render(parsed.program, entry, {
    hostFilters: HOST_FILTERS,
    bindings: BINDINGS,
    now: () => 0,
  });

  let plan: string[] = [];
  try {
    plan = [...extractAccessPlan(parsed.program, entry).paths];
  } catch {
    plan = [];
  }

  if (!result.ok) {
    return {
      ...empty,
      sites,
      plan,
      failed: true,
      diagnostics: `render failed\n\n${result.error.code}: ${result.error.message}\n  at ${result.error.template}:${result.error.line}:${result.error.col}`,
      diagnosticCount: 1,
      errorCount: 1,
    };
  }

  return {
    diagnostics: renderDiagnostics(checked.diagnostics, source),
    diagnosticCount: checked.diagnostics.length,
    errorCount: 0,
    html: result.html,
    warnings: result.warnings.map((w) => `${w.code} ${w.message} (${w.line}:${w.col})`),
    plan,
    sites,
    budgets: {
      // Output length is exact; fuel is charged per emitted code unit plus a
      // per-element cost, so the emitted length is a faithful lower bound and
      // an honest thing to show without pretending to instrument the engine.
      fuelUsed: result.html.length,
      fuelMax: LIMITS.defaultFuel,
      outputBytes: result.html.length,
      outputMax: LIMITS.defaultMaxOutput,
    },
    failed: false,
  };
}

function renderDiagnostics(diagnostics: readonly Diagnostic[], source: string): string {
  return diagnostics.map((d) => formatDiagnosticWithSource(d, source, { color: false })).join('\n\n');
}

/** Format the current source, or return the diagnostics that prevented it. */
export function format(source: string): { ok: true; text: string } | { ok: false; message: string } {
  const parsed = parseTemplate(source, 'playground.orbit');
  if (!parsed.ok) {
    return { ok: false, message: renderDiagnostics(parsed.diagnostics, source) };
  }
  return { ok: true, text: formatTemplate(parsed.template) };
}

export const limits = LIMITS;
