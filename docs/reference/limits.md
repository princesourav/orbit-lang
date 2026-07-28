# Limits

Every cap Orbit enforces, what trips it, and the code you get.

**Published values are spec minimums.** They say "a conforming engine must bound
this". A production host configures its own, lower, unpublished values through
`RenderOptions` — publishing the exact budget a tenant runs under only tells an
attacker how close they may get.

A runtime cap trip **fails the whole render** with a template, line and column.
A partial page is never returned, because a truncated page is a page that ships
half a checkout form.

---

## Parse-time caps

Enforced while parsing, at node construction. An over-cap template never
finishes parsing — there is no post-hoc walk that a bug could skip.

| Cap | Value | Code | Trips on |
|---|---|---|---|
| AST nodes per template | 20,000 | `O1100` | Template too large |
| Element nesting depth | 64 | `O1101` | Deeply nested markup |
| Expression depth | 32 | `O1009` | Deeply nested expression |
| Expression tokens | 512 | `O1002` | One enormous expression |
| Numeric literal digits | 20 | — | A literal that cannot round-trip exactly |
| Text run length | 256 KiB | `O1054` | One enormous text node |
| Attributes per element | 64 | — | Too many attributes |
| Parse errors per template | 100 | — | Recovery stops; the rest are cascades |

Numeric literals are additionally required to **round-trip exactly**. Orbit
numbers are IEEE-754 doubles, so a literal wider than the cap cannot be
distinguished from its neighbours; rejecting it beats silently rounding
someone's price.

## Check-time caps

| Cap | Value | Code |
|---|---|---|
| Loop `limit` literal | 1..250 | `O2078` |
| Range literal span | 250 | `O2050`, `O2051` |
| JSON-LD nesting depth | 16 | — |

`limit` must be a **compile-time literal**. A loop bound that could be computed
at runtime is a loop bound an attacker can influence.

## Runtime budgets

One **global** counter each per render, threaded through component calls and
slot expansion — so nesting cannot multiply a budget.

| Budget | Default | Code | What it bounds |
|---|---|---|---|
| Fuel | 2,000,000 | `O4001` | Total work: per emitted UTF-16 code unit, plus 8 per element |
| Iterations | 10,000 | `O4002` | Every loop iteration and component call, globally |
| Deadline | 250 ms | `O4003` | Wall clock, via the injected `now()` |
| Output | 1.5 MiB | `O4004` | Total bytes emitted |
| Component depth | 16 | — | Nesting of component calls |
| Loop limit (implicit) | 250 | — | Iterations per loop when `limit` is omitted |

Fuel is a **byte budget, not an op budget**: it is charged per code unit
emitted, and filter outputs are charged too, so "produce something enormous and
emit nothing" still burns fuel.

The deadline uses an **injected clock** and is abort-only — `now()` never
reaches output, so determinism is preserved. Two renders of the same program and
data produce identical bytes regardless of how long either took.

## Per-value caps

Checked at **every filter step**, so a chain cannot inflate a value past them.

| Cap | Value | Code |
|---|---|---|
| String length | 256 KiB (262,144 UTF-16 code units) | `O4005` |
| List items | 5,000 | `O4006` |

## Configuring them

```ts
render(program, 'collection', {
  bindings,
  hostFilters,
  fuel: 250_000,       // well below the published minimum
  deadlineMs: 50,
  maxOutput: 512 * 1024,
});
```

Choose these from your own p99 render, not from this page. The defaults are
generous so that the engine's own test suite exercises real templates; a
multi-tenant host should be far stricter, and should treat a budget trip as a
signal worth alerting on rather than a routine error.

## Why budgets rather than a sandbox

Twig's own advisory for CVE-2026-46627 states plainly that its sandbox "does not
protect against resource exhaustion". That is the general case: sandboxes
constrain *what* code reaches, not *how much* work it does, so a sandboxed
template language still needs a separate answer for a hostile author writing a
loop that never ends.

Orbit does not need one, because the language cannot express unbounded
computation: there is no recursion, loop bounds are literals, and every budget
above is enforced by one global counter. Termination is a property of the
language, and the budgets bound the constant factor.
