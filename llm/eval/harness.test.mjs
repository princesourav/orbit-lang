import { describe, expect, it } from 'vitest';
import { compile, extractSource, mockProvider, runEval } from './harness.mjs';

/**
 * Tests for the LLM eval harness.
 *
 * The harness measures a claim — that a typed, non-Turing-complete template
 * language is an unusually good code-generation target because the compiler can
 * hand a model an actionable repair — so the harness itself has to be
 * trustworthy. Two things could make it lie:
 *
 *   1. Compiling nothing, or accepting everything, so every task "passes".
 *   2. A mock provider whose first attempts are already correct, which would
 *      make the repair loop look effective without ever exercising it.
 *
 * Both are asserted against below.
 */

describe('the harness compiles for real', () => {
  it('accepts a valid template', () => {
    const result = compile('---\npage shop\n---\n<h1>{collection.title}</h1>\n');
    expect(result.ok).toBe(true);
  });

  it('rejects the traps the tasks are built around', () => {
    const bad = [
      '---\npage shop\n---\n<if {collection.title}><p>x</p></if>\n',
      '---\npage shop\n---\n<script>x()</script>\n',
      '---\npage shop\n---\n<p>{collection.title.upper()}</p>\n',
      '---\npage shop\n---\n<if {collection.products |> size > 0}><p>x</p></if>\n',
      '---\npage shop\n---\n<p>a < b</p>\n',
    ];
    for (const source of bad) {
      expect(compile(source).ok, `should not compile: ${source}`).toBe(false);
    }
  });

  it('produces diagnostics a model could act on', () => {
    const result = compile('---\npage shop\n---\n<if {collection.title}><p>x</p></if>\n');
    expect(result.ok).toBe(false);
    const d = result.diagnostics[0];
    expect(d.code).toMatch(/^O\d{4}$/);
    expect(d.span).toBeDefined();
    // A code and a location are the minimum; a suggestion is what makes the
    // repair loop cheap, and the common diagnostics carry one.
    expect(d.message.length).toBeGreaterThan(10);
  });
});

describe('source extraction', () => {
  it('unwraps a fenced block', () => {
    expect(extractSource('Here you go:\n```orbit\n---\npage a\n---\n<p>x</p>\n```\n')).toBe(
      '---\npage a\n---\n<p>x</p>\n',
    );
  });

  it('passes through bare source', () => {
    expect(extractSource('---\npage a\n---\n')).toBe('---\npage a\n---');
  });
});

describe('the eval loop', () => {
  it('reaches 100% after repair with the offline provider', async () => {
    const summary = await runEval({ provider: mockProvider(), maxRepairs: 2 });
    expect(summary.total).toBeGreaterThanOrEqual(10);
    expect(summary.passed).toBe(summary.total);
  });

  it('does NOT reach 100% on the first attempt', async () => {
    // If the mock's first attempts all compiled, the repair loop would never
    // run and this harness would be measuring nothing. The canned first
    // attempts deliberately reach for constructs Orbit rejects.
    const summary = await runEval({ provider: mockProvider(), maxRepairs: 0 });
    expect(summary.passed).toBeLessThan(summary.total);
    expect(summary.passed).toBeGreaterThan(0);
  });

  it('reports first-try and post-repair rates separately', async () => {
    const summary = await runEval({ provider: mockProvider(), maxRepairs: 2 });
    expect(summary.firstTryRate).toBeLessThan(summary.passRate);
    expect(summary.firstTryRate).toBeGreaterThan(0);
  });

  it('runs a single task when asked', async () => {
    const summary = await runEval({ provider: mockProvider(), only: 'hello' });
    expect(summary.total).toBe(1);
    expect(summary.results[0].id).toBe('hello');
  });

  it('every task asserts something beyond "it compiled"', async () => {
    const { tasks } = JSON.parse(
      await import('node:fs').then((fs) =>
        fs.readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'),
      ),
    );
    for (const task of tasks) {
      const hasAssertion =
        (task.must?.length ?? 0) > 0 || (task.mustNot?.length ?? 0) > 0 || task.trap !== undefined;
      expect(hasAssertion, `task ${task.id} asserts nothing`).toBe(true);
    }
  });
});
