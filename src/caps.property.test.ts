/**
 * Property-based per-value cap enforcement.
 *
 * Fuel bounds how much a render EMITS. The per-value caps bound what it
 * ALLOCATES on the way there — `replace("a", <64KiB>)` over a 100-character
 * string emits nothing at all yet builds a 6 MB intermediate. So every filter
 * routes its output through the runtime's `capString` / `capList`, and the
 * interpreter re-checks the returned value afterwards. The composed guarantee
 * — the one the interpreter actually provides, and the one worth testing — is:
 *
 *     applying any stdlib filter to any arguments either fails with a cap
 *     code, or returns a string ≤ maxStringLength and a list ≤ maxListItems.
 *
 * `mirrorApplyFilter` reproduces exactly that composition (call `eval` with a
 * capping runtime, then re-check the result) so a filter that forgets to cap
 * an intermediate is caught here rather than in whichever template first grows
 * big enough to notice.
 *
 * The caps are parameterized. The real values (256 KiB, 5 000 items) are far
 * too large to explore generatively — a property run at 262 144 characters
 * would be a benchmark, not a test — so the generative half runs at SMALL caps
 * around the boundary, where off-by-one and "cap checked before the last
 * append" bugs live, and a handful of fixed tests confirm the real `LIMITS`
 * values are the ones actually wired in.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LIMITS } from './limits';
import { render } from './interpreter';
import { type SourceFile } from './parser';
import { DEFAULT_LOCALE, STDLIB, STDLIB_FILTER_NAMES, type FilterRuntime } from './stdlib';
import { compileOk } from './test-host.helper';

// ---------------------------------------------------------------------------
// A capping runtime that mirrors the interpreter's
// ---------------------------------------------------------------------------

class CapTripped extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function cappingRuntime(maxString: number, maxList: number): FilterRuntime {
  return {
    fail: (code: string): never => {
      throw new CapTripped(code);
    },
    capString: (s: string): string => {
      if (s.length > maxString) throw new CapTripped('O4005');
      return s;
    },
    capList: <T,>(l: readonly T[]): readonly T[] => {
      if (l.length > maxList) throw new CapTripped('O4006');
      return l;
    },
    locale: DEFAULT_LOCALE,
  };
}

/**
 * The interpreter's `applyFilter` contract in miniature: run the filter with a
 * capping runtime, then re-check the RESULT. The post-check is what makes the
 * property total — `first`/`last` legitimately return an element they never
 * built, so they cannot cap it themselves.
 */
function mirrorApplyFilter(
  name: string,
  args: readonly unknown[],
  maxString: number,
  maxList: number,
): { ok: true; value: unknown } | { ok: false; code: string } {
  const filter = STDLIB.get(name);
  if (filter === undefined) throw new Error(`no stdlib filter ${name}`);
  const rt = cappingRuntime(maxString, maxList);
  try {
    const value = filter.eval(args, rt);
    if (typeof value === 'string') rt.capString(value);
    if (Array.isArray(value)) rt.capList(value);
    return { ok: true, value };
  } catch (err) {
    if (err instanceof CapTripped) return { ok: false, code: err.code };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Argument generation, per filter
// ---------------------------------------------------------------------------

/** Sizes clustered on the boundary: cap−2 … cap+2, plus 0 and a blowup size. */
function boundarySizes(cap: number): fc.Arbitrary<number> {
  return fc.constantFrom(0, 1, cap - 2, cap - 1, cap, cap + 1, cap + 2, cap * 2 + 1).map((n) => Math.max(0, n));
}

const smallText = fc.string({ maxLength: 12 });

function sizedString(size: number, unit: string): string {
  return unit.repeat(size);
}

/**
 * Arguments for every stdlib filter, sized against the caps in play. The table
 * is exhaustive by construction — a companion test fails if a filter is added
 * to the stdlib and not covered here.
 */
function argsFor(name: string, maxString: number, maxList: number): fc.Arbitrary<readonly unknown[]> {
  const bigString = boundarySizes(maxString).chain((n) =>
    fc.constantFrom('a', 'ab', 'é', '😀').map((unit) => sizedString(n, unit)),
  );
  const bigList = boundarySizes(maxList).map((n) => Array.from({ length: n }, (_, i) => `i${String(i)}`));
  const objectList = boundarySizes(maxList).map((n) =>
    Array.from({ length: n }, (_, i) => ({ rank: (i * 7) % 13, name: `n${String(i)}` })),
  );

  switch (name) {
    case 'upper':
    case 'lower':
    case 'capitalize':
    case 'trim':
    case 'slugify':
    case 'urlEncode':
      return fc.tuple(bigString).map((t) => t);
    case 'truncate':
      // The third argument is the ellipsis — a huge one makes `truncate`
      // GROW the string, which is the only way this filter can overflow.
      return fc.tuple(bigString, fc.integer({ min: 0, max: 32 }), bigString).map((t) => t);
    case 'replace':
      // `to` longer than `from` is multiplicative: the classic blowup.
      return fc.tuple(bigString, fc.constantFrom('a', 'ab', 'é', ''), bigString).map((t) => t);
    case 'split':
      // An empty separator splits into one item per code unit: the list-cap
      // blowup that mirrors `replace`'s string-cap one.
      return fc.tuple(bigString, fc.constantFrom('', 'a', ',', 'ab')).map((t) => t);
    case 'join':
      return fc.tuple(bigList, fc.constantFrom('', ',', ', ', 'xxxxxxxx')).map((t) => t);
    case 'size':
      return fc.oneof(fc.tuple(bigString), fc.tuple(bigList)).map((t) => t);
    case 'first':
    case 'last':
    case 'reverse':
      return fc.oneof(fc.tuple(bigList), fc.tuple(bigString.map((s) => [s]))).map((t) => t);
    case 'sortBy':
      return fc.tuple(objectList, fc.constantFrom('rank', 'name', 'missing')).map((t) => t);
    case 'where':
      return fc.tuple(objectList, fc.constantFrom('rank', 'name'), fc.oneof(fc.integer({ min: 0, max: 12 }), smallText)).map((t) => t);
    case 'round':
      return fc.tuple(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.integer({ min: 0, max: 6 })).map((t) => t);
    case 'clamp':
      return fc
        .tuple(
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          fc.double({ noNaN: true, noDefaultInfinity: true }),
        )
        .map((t) => t);
    case 'formatDate':
      return fc
        .tuple(
          fc.constantFrom('2024-01-02', '2024-01-02T03:04:05', '1999-12-31'),
          bigString.map((s) => `YYYY-MM-DD${s}`),
        )
        .map((t) => t);
    default:
      throw new Error(`argsFor: no argument generator for stdlib filter ${JSON.stringify(name)}`);
  }
}

// ---------------------------------------------------------------------------
// The properties
// ---------------------------------------------------------------------------

describe('per-value caps: no stdlib filter can exceed them', () => {
  it('covers every filter in the stdlib', () => {
    // Keeps the table above honest: a new filter without a generator throws.
    for (const name of STDLIB_FILTER_NAMES) {
      expect(() => argsFor(name, 8, 8)).not.toThrow();
    }
  });

  /** Caps and arguments drawn together, so shrinking can reduce both. */
  function scenarioFor(name: string): fc.Arbitrary<{
    maxString: number;
    maxList: number;
    args: readonly unknown[];
  }> {
    return fc
      .tuple(fc.integer({ min: 1, max: 24 }), fc.integer({ min: 1, max: 24 }))
      .chain(([maxString, maxList]) =>
        argsFor(name, maxString, maxList).map((args) => ({ maxString, maxList, args })),
      );
  }

  for (const name of STDLIB_FILTER_NAMES) {
    it(`${name}: returns within cap or trips a cap code`, () => {
      fc.assert(
        fc.property(scenarioFor(name), ({ maxString, maxList, args }) => {
          const outcome = mirrorApplyFilter(name, args, maxString, maxList);
          if (!outcome.ok) {
            // O4020/O4021 are the value-shape failures a filter may raise on
            // a hand-built AST; anything else means the cap path is broken.
            expect(['O4005', 'O4006', 'O4020', 'O4021']).toContain(outcome.code);
            return;
          }
          if (typeof outcome.value === 'string') {
            expect(outcome.value.length).toBeLessThanOrEqual(maxString);
          }
          if (Array.isArray(outcome.value)) {
            expect(outcome.value.length).toBeLessThanOrEqual(maxList);
          }
        }),
        { numRuns: 200 },
      );
    });
  }
});

describe('per-value caps: the cap path is actually reachable', () => {
  /**
   * "Never exceeds the cap" is vacuously true for a filter that can never
   * approach it, so each filter that handles a string or a list is shown to
   * trip on a deliberately oversized argument. Without this, a regression that
   * made `argsFor` generate only tiny values would leave the whole suite green
   * and testing nothing.
   */
  const CAP = 4;
  const overString = 'a'.repeat(CAP + 1);
  const overList = Array.from({ length: CAP + 1 }, (_, i) => ({ rank: i, name: `n${String(i)}` }));
  const uniformList = Array.from({ length: CAP + 1 }, () => ({ rank: 1, name: 'n' }));

  const TRIPPING: ReadonlyArray<readonly [string, readonly unknown[]]> = [
    ['upper', [overString]],
    ['lower', [overString]],
    ['capitalize', [overString]],
    ['trim', [overString]],
    ['slugify', [overString]],
    ['urlEncode', [overString]],
    ['truncate', [overString, 2, overString]],
    ['replace', [overString, 'a', 'bb']],
    ['split', [overString, '']],
    ['join', [Array.from({ length: CAP + 1 }, () => 'x'), ',']],
    ['first', [[overString]]],
    ['last', [[overString]]],
    ['reverse', [overList]],
    ['sortBy', [overList, 'rank']],
    ['where', [uniformList, 'rank', 1]],
    ['formatDate', ['2024-01-02', `YYYY${'x'.repeat(CAP)}`]],
  ];

  for (const [name, args] of TRIPPING) {
    it(`${name}: an oversized argument trips the cap`, () => {
      const outcome = mirrorApplyFilter(name, args, CAP, CAP);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(['O4005', 'O4006']).toContain(outcome.code);
    });
  }

  it('the numeric filters return scalars and can never trip a cap', () => {
    // Stated rather than left implicit: `size`, `round` and `clamp` are the
    // three filters missing from the table above, and this is why.
    expect(mirrorApplyFilter('size', [overString], CAP, CAP)).toEqual({ ok: true, value: CAP + 1 });
    expect(mirrorApplyFilter('round', [1.55, 1], CAP, CAP).ok).toBe(true);
    expect(mirrorApplyFilter('clamp', [99, 0, 10], CAP, CAP)).toEqual({ ok: true, value: 10 });
    const covered = new Set([...TRIPPING.map(([n]) => n), 'size', 'round', 'clamp']);
    expect([...covered].sort()).toEqual([...STDLIB_FILTER_NAMES].sort());
  });
});

describe('per-value caps: the real LIMITS values are the ones wired in', () => {
  const CAP_COMPONENT: SourceFile = {
    name: 'components/caps.orbit',
    source: `---
component Caps
props {
  s: String
  sep: String
}
---
<p>{replace(s, "a", sep)}</p>`,
  };

  const SPLIT_COMPONENT: SourceFile = {
    name: 'components/split.orbit',
    source: `---
component Split
props {
  s: String
}
---
<p>{split(s, "") |> size}</p>`,
  };

  it('replace: a string blowup past maxStringLength fails with O4005', () => {
    const program = compileOk([CAP_COMPONENT]);
    // 200 000 copies of 'a' replaced by 'bb' → 400 000 > 262 144.
    const result = render(program, 'Caps', {
      props: { s: 'a'.repeat(200_000), sep: 'bb' },
      maxOutput: LIMITS.defaultMaxOutput,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('O4005');
  });

  it('replace: staying just under maxStringLength succeeds', () => {
    const program = compileOk([CAP_COMPONENT]);
    const result = render(program, 'Caps', {
      props: { s: 'a'.repeat(LIMITS.maxStringLength / 2), sep: 'bb' },
    });
    // Exactly maxStringLength characters: allowed, and it is the OUTPUT cap
    // (not the value cap) that must decide from here on.
    expect(result.ok).toBe(true);
  });

  it('split: a list blowup past maxListItems fails with O4006', () => {
    const program = compileOk([SPLIT_COMPONENT]);
    const result = render(program, 'Split', { props: { s: 'x'.repeat(LIMITS.maxListItems + 1) } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('O4006');
  });

  it('split: exactly maxListItems is allowed', () => {
    const program = compileOk([SPLIT_COMPONENT]);
    const result = render(program, 'Split', { props: { s: 'x'.repeat(LIMITS.maxListItems) } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.html).toBe(`<p>${String(LIMITS.maxListItems)}</p>`);
  });

  it('the cap boundary is inclusive on both sides', () => {
    // ≤ cap passes, cap+1 fails — asserted directly against the runtime so a
    // future `<` / `<=` slip is caught without needing a 256 KiB render.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (cap) => {
        expect(mirrorApplyFilter('upper', ['a'.repeat(cap)], cap, cap).ok).toBe(true);
        const over = mirrorApplyFilter('upper', ['a'.repeat(cap + 1)], cap, cap);
        expect(over.ok).toBe(false);
        if (!over.ok) expect(over.code).toBe('O4005');
        expect(mirrorApplyFilter('reverse', [Array.from({ length: cap }, (_, i) => i)], cap, cap).ok).toBe(true);
        const overList = mirrorApplyFilter('reverse', [Array.from({ length: cap + 1 }, (_, i) => i)], cap, cap);
        expect(overList.ok).toBe(false);
        if (!overList.ok) expect(overList.code).toBe('O4006');
      }),
      { numRuns: 60 },
    );
  });
});

describe('per-value caps: chained filters cannot launder an oversized value', () => {
  it('a pipeline is capped at every step, not only at the end', () => {
    // `replace` grows the string, `truncate` would shrink it back. If the cap
    // were only applied to the FINAL value, this pipeline would allocate the
    // blown-up intermediate and then hide it.
    const program = compileOk([
      {
        name: 'components/chain.orbit',
        source: `---\ncomponent Chain\nprops {\n  s: String\n  sep: String\n}\n---\n<p>{replace(s, "a", sep) |> truncate(10)}</p>`,
      },
    ]);
    const result = render(program, 'Chain', { props: { s: 'a'.repeat(200_000), sep: 'bb' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('O4005');
  });
});
