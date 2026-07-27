/**
 * Property-based budget and termination proofs.
 *
 * Orbit's safety argument is not "templates are written carefully", it is
 * "the interpreter cannot run away". That argument has three parts, and each
 * is a universally-quantified statement that example tests can only sample:
 *
 *  1. TERMINATION — `render` always returns. For any budget and any input it
 *     produces `{ok:true}` or `{ok:false, error}`; it never throws out of the
 *     result type, never hangs, and never returns a partial success.
 *  2. MONOTONICITY — budgets behave like budgets. The set of budgets under
 *     which a render succeeds is upward-closed: if it succeeds with fuel F it
 *     succeeds with every F' > F, and the output is the same bytes. A budget
 *     that changed the OUTPUT rather than just permitting or refusing it would
 *     mean the host's resource limits leak into what merchants see.
 *  3. ENFORCEMENT — a success never exceeds the caps it was given.
 *
 * Monotonicity is the property most worth generating: it is what makes a
 * production deployment able to lower budgets safely, and it is exactly the
 * kind of invariant that a "charge fuel here too" patch breaks silently.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LIMITS } from './limits';
import { render, type RenderResult } from './interpreter';
import { type SourceFile } from './parser';
import { compileOk } from './test-host.helper';

const WORKLOAD: SourceFile = {
  name: 'components/workload.orbit',
  source: `---
component Workload
props {
  rows: List<String>
  title: String
}
---
<section>
  <h2>{title}</h2>
  <for row of={rows}>
    <div class="r"><span>{row |> upper}</span><p>{row}</p></div>
  </for>
</section>`,
};

const program = compileOk([WORKLOAD]);

const propsFor = (n: number) => ({
  rows: Array.from({ length: n }, (_, i) => `row-${String(i)}`),
  title: 'Budgets & Limits',
});

interface Budget {
  fuel: number;
  maxIterations: number;
  maxOutput: number;
}

const run = (rows: number, budget: Partial<Budget>): RenderResult =>
  render(program, 'Workload', { props: propsFor(rows), ...budget });

describe('render terminates under every budget', () => {
  it('always returns a well-formed result, never throws', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 0, max: 4000 }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 4000 }),
        (rows, fuel, maxIterations, maxOutput) => {
          const result = run(rows, { fuel, maxIterations, maxOutput });
          // The result type is total: exactly one of the two shapes.
          if (result.ok) {
            expect(typeof result.html).toBe('string');
          } else {
            expect(typeof result.error.code).toBe('string');
            expect(result.error.code.startsWith('O')).toBe(true);
          }
          expect(Array.isArray(result.warnings)).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('charges a zero budget immediately rather than emitting anything', () => {
    for (const budget of [{ fuel: 0 }, { maxIterations: 0 }, { maxOutput: 0 }]) {
      const result = run(20, budget);
      expect(result.ok).toBe(false);
    }
  });
});

describe('budget monotonicity', () => {
  /**
   * Find the smallest budget at which a render succeeds, then assert the
   * success set is upward-closed around it. A linear scan is used rather than
   * a binary search precisely because the property under test is that the
   * predicate is monotone — searching with an algorithm that assumes
   * monotonicity would hide a violation.
   */
  const scan = (rows: number, apply: (v: number) => Partial<Budget>, values: number[]) => {
    const outcomes = values.map((v) => ({ v, result: run(rows, apply(v)) }));
    const firstOk = outcomes.findIndex((o) => o.result.ok);
    return { outcomes, firstOk };
  };

  it('fuel: once a render succeeds, more fuel never breaks it or changes bytes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (rows) => {
        const values = Array.from({ length: 40 }, (_, i) => i * 250);
        const { outcomes, firstOk } = scan(rows, (fuel) => ({ fuel }), values);
        if (firstOk === -1) return; // never succeeded in range: nothing to prove
        const baseline = outcomes[firstOk]?.result;
        expect(baseline?.ok).toBe(true);
        if (baseline === undefined || !baseline.ok) return;
        for (let i = firstOk; i < outcomes.length; i += 1) {
          const r = outcomes[i]?.result;
          expect(r?.ok).toBe(true);
          if (r !== undefined && r.ok) expect(r.html).toBe(baseline.html);
        }
        // ...and downward-closed on the failing side.
        for (let i = 0; i < firstOk; i += 1) expect(outcomes[i]?.result.ok).toBe(false);
      }),
      { numRuns: 40 },
    );
  });

  it('iterations: the success set is upward-closed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (rows) => {
        const values = Array.from({ length: 40 }, (_, i) => i);
        const { outcomes, firstOk } = scan(rows, (maxIterations) => ({ maxIterations }), values);
        if (firstOk === -1) return;
        const baseline = outcomes[firstOk]?.result;
        if (baseline === undefined || !baseline.ok) return;
        for (let i = firstOk; i < outcomes.length; i += 1) {
          const r = outcomes[i]?.result;
          expect(r?.ok).toBe(true);
          if (r !== undefined && r.ok) expect(r.html).toBe(baseline.html);
        }
        for (let i = 0; i < firstOk; i += 1) expect(outcomes[i]?.result.ok).toBe(false);
      }),
      { numRuns: 40 },
    );
  });

  it('output cap: the success set is upward-closed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (rows) => {
        const values = Array.from({ length: 40 }, (_, i) => i * 200);
        const { outcomes, firstOk } = scan(rows, (maxOutput) => ({ maxOutput }), values);
        if (firstOk === -1) return;
        const baseline = outcomes[firstOk]?.result;
        if (baseline === undefined || !baseline.ok) return;
        for (let i = firstOk; i < outcomes.length; i += 1) {
          const r = outcomes[i]?.result;
          expect(r?.ok).toBe(true);
          if (r !== undefined && r.ok) expect(r.html).toBe(baseline.html);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('more work never succeeds where less work failed, at a fixed budget', () => {
    // The dual of budget monotonicity: with the budget held constant, the
    // success set is DOWNWARD-closed in workload size.
    fc.assert(
      fc.property(fc.integer({ min: 400, max: 6000 }), (fuel) => {
        const sizes = Array.from({ length: 30 }, (_, i) => i);
        const results = sizes.map((n) => run(n, { fuel }));
        const firstFail = results.findIndex((r) => !r.ok);
        if (firstFail === -1) return;
        for (let i = firstFail; i < results.length; i += 1) {
          expect(results[i]?.ok).toBe(false);
        }
      }),
      { numRuns: 60 },
    );
  });
});

// ---------------------------------------------------------------------------
// Termination over GENERATED programs, not just one fixed workload
// ---------------------------------------------------------------------------

/**
 * The workload above pins the numbers; this grammar attacks the claim from
 * the other side. Nested loops, nested components and slot expansion are the
 * shapes where a per-loop budget reset or a missed charge would let work
 * multiply, so the generator builds exactly those and the property asserts
 * only what must hold universally: `render` RETURNS, with a total result.
 */
const NESTABLE = ['div', 'section', 'ul', 'p'];

function nested(depth: number): fc.Arbitrary<string> {
  if (depth <= 0) {
    return fc.constantFrom(
      '<p>{title}</p>',
      '<span>{rows |> size}</span>',
      '<b>{title |> upper}</b>',
      'text',
      '<Leaf label={title}></Leaf>',
    );
  }
  const inner = (): fc.Arbitrary<string> =>
    fc.array(nested(depth - 1), { minLength: 1, maxLength: 2 }).map((xs) => xs.join(''));
  return fc.oneof(
    fc.tuple(fc.constantFrom(...NESTABLE), inner()).map(([tag, body]) => `<${tag}>${body}</${tag}>`),
    inner().map((body) => `<for r of={rows}>${body}<empty><p>none</p></empty></for>`),
    inner().map((body) => `<for r of={rows} limit={4}><for s of={rows} limit={4}>${body}</for></for>`),
    inner().map((body) => `<if {title != ""}>${body}</if><else><p>e</p></else>`),
    inner().map((body) => `<Wrap><span slot="body">${body}</span></Wrap>`),
    nested(depth - 1),
  );
}

const SUPPORT: SourceFile[] = [
  {
    name: 'components/leaf.orbit',
    source: '---\ncomponent Leaf\nprops {\n  label: String\n}\n---\n<em>{label}</em>',
  },
  {
    name: 'components/wrap.orbit',
    source: '---\ncomponent Wrap\nslots { body? }\n---\n<div class="w"><slot name="body"/></div>',
  },
];

const generatedWorkload = nested(3).map(
  (body): SourceFile => ({
    name: 'components/generated.orbit',
    source: `---\ncomponent Generated\nprops {\n  title: String\n  rows: List<String>\n}\n---\n<div>${body}</div>`,
  }),
);

/** Codes a render may legitimately fail with under a squeezed budget. */
const BUDGET_CODES = ['O4001', 'O4002', 'O4003', 'O4004', 'O4005', 'O4006', 'O4015'];

describe('render terminates for any generated program under any budget', () => {
  it('always returns a total result and never a partial document', () => {
    fc.assert(
      fc.property(
        generatedWorkload,
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 0, max: 600 }),
        fc.integer({ min: 0, max: 20_000 }),
        (file, rowCount, fuel, maxIterations, maxOutput) => {
          const generated = compileOk([file, ...SUPPORT]);
          const result = render(generated, 'Generated', {
            props: {
              title: 'T',
              rows: Array.from({ length: rowCount }, (_, i) => `r${String(i)}`),
            },
            fuel,
            maxIterations,
            maxOutput,
          });
          if (result.ok) {
            expect(typeof result.html).toBe('string');
            expect(result.html.length).toBeLessThanOrEqual(maxOutput);
          } else {
            // No partial document survives a failure: the failure branch of
            // the result type has no `html` at all, which is what makes it
            // impossible to accidentally serve a truncated page.
            expect(Object.hasOwn(result, 'html')).toBe(false);
            expect(BUDGET_CODES).toContain(result.error.code);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a generous budget renders every generated program', () => {
    // The dual guard: if the budgets were so tight that everything failed, the
    // termination property above would pass while proving nothing.
    fc.assert(
      fc.property(generatedWorkload, fc.integer({ min: 0, max: 8 }), (file, rowCount) => {
        const generated = compileOk([file, ...SUPPORT]);
        const result = render(generated, 'Generated', {
          props: { title: 'T', rows: Array.from({ length: rowCount }, (_, i) => `r${String(i)}`) },
        });
        expect(result.ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('fuel monotonicity holds for generated programs too', () => {
    fc.assert(
      fc.property(generatedWorkload, fc.integer({ min: 1, max: 8 }), (file, rowCount) => {
        const generated = compileOk([file, ...SUPPORT]);
        const props = {
          title: 'T',
          rows: Array.from({ length: rowCount }, (_, i) => `r${String(i)}`),
        };
        const outcomes = Array.from({ length: 24 }, (_, i) => i * 400).map((fuel) =>
          render(generated, 'Generated', { props, fuel }),
        );
        const firstOk = outcomes.findIndex((r) => r.ok);
        if (firstOk === -1) return;
        const baseline = outcomes[firstOk];
        if (baseline === undefined || !baseline.ok) return;
        for (let i = 0; i < outcomes.length; i += 1) {
          const r = outcomes[i];
          if (r === undefined) continue;
          if (i < firstOk) expect(r.ok).toBe(false);
          else if (r.ok) expect(r.html).toBe(baseline.html);
          else expect(r.ok).toBe(true);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('budget enforcement', () => {
  it('a successful render never exceeds its output cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 6000 }),
        (rows, maxOutput) => {
          const result = run(rows, { maxOutput });
          if (result.ok) expect(result.html.length).toBeLessThanOrEqual(maxOutput);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a loop wider than the iteration budget always fails with O4002', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (maxIterations) => {
        const result = run(maxIterations + 5, { maxIterations });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('O4002');
      }),
      { numRuns: 60 },
    );
  });

  it('the deadline aborts rather than truncating, using the injected clock', () => {
    // `now` is injected and only ever used to ABORT — it can never reach the
    // output, which is what keeps renders deterministic.
    let ticks = 0;
    const result = render(program, 'Workload', {
      props: propsFor(50),
      deadlineMs: 5,
      now: () => {
        ticks += 1;
        return ticks * 1000; // every check looks like another second elapsed
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('O4003');
  });

  it('default budgets render this workload comfortably', () => {
    // Guards against a future "tightening" that makes the documented defaults
    // too small for an ordinary page.
    const result = run(100, {});
    expect(result.ok).toBe(true);
    expect(LIMITS.defaultFuel).toBeGreaterThan(0);
    expect(LIMITS.defaultMaxIterations).toBeGreaterThan(0);
  });
});
