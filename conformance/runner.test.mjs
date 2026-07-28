import { describe, expect, it } from 'vitest';
import { loadCases, runAll, runCase } from './runner.mjs';

/**
 * The reference implementation must pass its own conformance corpus.
 *
 * That sounds tautological, and on its own it would be — the corpus was
 * generated from this engine. It is not tautological in practice, because the
 * corpus is a COMMITTED artifact and the engine keeps changing: any future edit
 * that alters rendering, a diagnostic code, or a warning will fail here rather
 * than silently redefining the language. That is the whole function of a
 * conformance suite for a single implementation, and it is why `--check` in CI
 * matters as much as the corpus itself.
 *
 * The independent-correctness argument lives in `differential.test.mjs`, which
 * checks the escaping cases against a real WHATWG parser.
 */

describe('the reference implementation conforms', () => {
  it('passes every case', () => {
    const summary = runAll();
    if (summary.failed > 0) {
      const detail = summary.failures
        .slice(0, 10)
        .map((f) => `  ${f.id}: ${f.reason}`)
        .join('\n');
      throw new Error(`${summary.failed}/${summary.total} conformance failures:\n${detail}`);
    }
    expect(summary.conformance).toBe(1);
    expect(summary.total).toBeGreaterThanOrEqual(500);
  });
});

describe('the runner actually discriminates', () => {
  /*
   * A runner that reported success unconditionally would make the suite above
   * meaningless. These mutate a known-good case and require it to fail.
   */
  it('fails a case whose expected HTML is wrong', () => {
    const good = loadCases({ category: 'structure' }).find((c) => c.expect.kind === 'html');
    expect(good).toBeDefined();
    const mutated = { ...good, expect: { ...good.expect, html: good.expect.html + '<p>x</p>' } };
    expect(runCase(mutated).passed).toBe(false);
  });

  it('fails a case whose expected diagnostic code is wrong', () => {
    const rejection = loadCases({ category: 'banned-element' })[0];
    expect(rejection).toBeDefined();
    const mutated = { ...rejection, expect: { ...rejection.expect, code: 'O9999' } };
    const result = runCase(mutated);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('O9999');
  });

  it('fails a case that was expected to error but renders', () => {
    const good = loadCases({ category: 'structure' }).find((c) => c.expect.kind === 'html');
    const mutated = { ...good, expect: { kind: 'parse-error', code: 'O1053' } };
    expect(runCase(mutated).passed).toBe(false);
  });

  it('fails a case whose warnings differ', () => {
    const good = loadCases({ category: 'structure' }).find((c) => c.expect.kind === 'html');
    const mutated = { ...good, expect: { ...good.expect, warnings: ['O4900'] } };
    const result = runCase(mutated);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('warnings differ');
  });
});

describe('corpus coverage', () => {
  it('covers each escaping context', () => {
    for (const category of [
      'escaping-text',
      'escaping-attr',
      'escaping-rcdata-title',
      'escaping-rcdata-textarea',
      'escaping-jsonld',
    ]) {
      expect(loadCases({ category }).length, `${category} is empty`).toBeGreaterThan(20);
    }
  });

  it('covers every URL-bearing attribute', () => {
    for (const category of ['url-href', 'url-src', 'url-action', 'url-poster', 'url-cite', 'url-srcset']) {
      expect(loadCases({ category }).length, `${category} is empty`).toBeGreaterThan(0);
    }
  });

  it('covers budget behaviour including the empty-loop-body case', () => {
    const budget = loadCases({ category: 'budget' });
    expect(budget.length).toBeGreaterThan(0);
    // LiquidJS CVE-2026-44645 was an iteration budget escaped by an empty loop
    // body. Orbit's counter is charged per iteration regardless, and the corpus
    // pins that rather than assuming it.
    expect(budget.some((c) => c.id.includes('empty-loop-body'))).toBe(true);
  });

  it('covers both acceptance and rejection of the type laws', () => {
    expect(loadCases({ category: 'type-law-rejection' }).length).toBeGreaterThan(0);
    expect(loadCases({ category: 'type-law-acceptance' }).length).toBeGreaterThan(0);
    // The absent-value variants are the ones that actually exercise optionals.
    expect(loadCases({ category: 'type-law-acceptance-absent' }).length).toBeGreaterThan(0);
  });
});
