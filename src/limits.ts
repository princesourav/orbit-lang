/**
 * Engine caps. Per the security review (W-33) these published values are SPEC
 * MINIMUMS — "a conforming engine MUST bound X". Production deployments
 * configure their own (lower, unpublished) fuel/iteration budgets through
 * RenderOptions; the per-value caps and structural caps here are hard.
 */
export const LIMITS = {
  /** AST construction caps — enforced while parsing, not after. */
  maxAstNodesPerTemplate: 20_000,
  maxElementDepth: 64,
  maxExprDepth: 32,
  maxExprTokens: 512,
  /**
   * Total decimal digits allowed in one numeric literal (integer part plus
   * fractional part, sign and `.` excluded). Orbit numbers are IEEE-754
   * doubles: past this width a literal cannot be distinguished from its
   * neighbours, so the parser rejects it instead of silently rounding.
   * Literals inside this cap are ADDITIONALLY required to round-trip exactly.
   */
  maxNumberDigits: 20,

  /** Loop discipline: `limit` must be a compile-time literal and <= this. */
  maxLoopLimit: 250,
  /** Implicit per-loop limit when `limit={n}` is omitted. */
  defaultLoopLimit: 250,

  /** Runtime caps — one GLOBAL counter each per render, threaded through
   * component calls and slot expansion (W-06). */
  maxComponentDepth: 16,
  defaultMaxIterations: 10_000,
  /** Fuel is charged per emitted UTF-16 code unit plus a fixed per-element
   * cost; it is a byte budget, not an op budget (W-04a, W-06). */
  defaultFuel: 2_000_000,
  perElementFuelCost: 8,

  /** Per-value caps enforced at every filter step (W-04b). */
  maxStringLength: 262_144, // 256 KiB of UTF-16 code units
  maxListItems: 5_000,

  /** Structural extras enforced at parse / AST re-validation. */
  maxAttrsPerElement: 64,
  maxJsonLdDepth: 16,

  /** Output + wall-clock defaults (spec minimums; hosts configure lower). */
  defaultMaxOutput: 1_572_864, // 1.5 MiB per render
  defaultDeadlineMs: 250,
} as const;
