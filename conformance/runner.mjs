/**
 * Run the Orbit conformance corpus against an implementation.
 *
 * This is the reference runner. It exists so the corpus is not merely a folder
 * of JSON that everyone interprets slightly differently: the semantics of a
 * case — what "expect: html" means, how bindings are supplied, which entry
 * point is rendered — are defined by executable code that anyone can read.
 *
 * A non-JavaScript implementation does not run this file; it reimplements it,
 * which is a page of work, and then reports the same pass/fail counts. That is
 * the CommonMark arrangement, and it is what makes a second implementation
 * possible to verify rather than merely claimed.
 *
 * Usage:
 *   npx vite-node conformance/runner.mjs -- [--category NAME] [--json] [--verbose]
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProgram } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { render } from '../src/interpreter.ts';
import { t, TypeRegistry } from '../src/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(HERE, 'cases');

// ---------------------------------------------------------------------------
// The conformance host — see README.md, which specifies this in prose so a
// non-JS implementation can reproduce it exactly.
// ---------------------------------------------------------------------------

const ITEM_FIELDS = {
  text: t.string(),
  url: t.url(),
  note: t.optional(t.string()),
  count: t.int(),
  ratio: t.float(),
  flag: t.bool(),
  tags: t.list(t.string()),
};

function makeRegistry() {
  const registry = new TypeRegistry();
  registry.defineObject('Item', { ...ITEM_FIELDS });
  registry.defineObject('Data', { ...ITEM_FIELDS, items: t.list(t.object('Item')) });
  return registry;
}

const HOST_FILTERS = [
  { name: 'shout', params: [t.string()], returns: t.string(), impl: ([s]) => String(s).toUpperCase() },
];

const PAGE_GLOBALS = { data: t.object('Data') };

// ---------------------------------------------------------------------------

export function runCase(testCase) {
  const files = [];
  for (const [name, source] of Object.entries(testCase.extraTemplates ?? {})) {
    files.push({ name, source });
  }
  files.push({ name: 'case.orbit', source: testCase.template });

  const parsed = parseProgram(files);
  if (!parsed.ok) {
    return compare(testCase, { kind: 'parse-error', code: parsed.diagnostics[0].code });
  }

  const checked = check(parsed.program, {
    registry: makeRegistry(),
    hostFilters: HOST_FILTERS,
    pageGlobals: PAGE_GLOBALS,
  });
  const errors = checked.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    return compare(testCase, { kind: 'check-error', code: errors[0].code });
  }

  // `now: () => 0` makes the deadline check deterministic. The clock is
  // abort-only and never reaches output, so a fixed value cannot change any
  // expected HTML — it only removes wall-clock flakiness from the suite.
  const result = render(parsed.program, 'page', {
    bindings: testCase.bindings ?? {},
    hostFilters: HOST_FILTERS,
    now: () => 0,
  });

  if (!result.ok) {
    return compare(testCase, { kind: 'render-error', code: result.error.code });
  }
  return compare(testCase, {
    kind: 'html',
    html: result.html,
    warnings: result.warnings.map((w) => w.code).sort(),
  });
}

function compare(testCase, actual) {
  const expected = testCase.expect;
  if (expected.kind !== actual.kind) {
    return {
      id: testCase.id,
      passed: false,
      reason: `expected ${expected.kind}, got ${actual.kind}` +
        (actual.kind === 'html' ? '' : ` (${actual.code})`),
    };
  }
  if (expected.kind === 'html') {
    if (expected.html !== actual.html) {
      return {
        id: testCase.id,
        passed: false,
        reason: 'html differs',
        expected: expected.html,
        actual: actual.html,
      };
    }
    const expectedWarnings = (expected.warnings ?? []).join(',');
    const actualWarnings = (actual.warnings ?? []).join(',');
    if (expectedWarnings !== actualWarnings) {
      return {
        id: testCase.id,
        passed: false,
        reason: `warnings differ: expected [${expectedWarnings}], got [${actualWarnings}]`,
      };
    }
    return { id: testCase.id, passed: true };
  }
  if (expected.code !== actual.code) {
    return {
      id: testCase.id,
      passed: false,
      reason: `expected ${expected.code}, got ${actual.code}`,
    };
  }
  return { id: testCase.id, passed: true };
}

export function loadCases({ category } = {}) {
  const files = readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => category === undefined || path.basename(f, '.json') === category);
  return files.flatMap((f) => JSON.parse(readFileSync(path.join(CASES_DIR, f), 'utf8')).cases);
}

export function runAll(options = {}) {
  const cases = loadCases(options);
  const results = cases.map(runCase);
  const failed = results.filter((r) => !r.passed);
  return {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    conformance: results.length === 0 ? 0 : (results.length - failed.length) / results.length,
    failures: failed,
  };
}
