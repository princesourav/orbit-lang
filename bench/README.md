# Benchmarks

One scenario, one engine, no comparison table.

```bash
npx vite-node bench/run.mjs -- --iterations 500
npx vite-node bench/run.mjs -- --json
```

## The scenario

A collection page rendering 48 product cards — the page a commerce platform
renders most. Each card exercises the work that actually costs something: a URL
attribute, an image, a truncated title, a narrowed optional, a host filter, a
nested loop over tags, and a conditional attribute. Output is ~25 KB.

## A measurement

Taken on the machine below. Reproduce it before quoting it; a number without a
machine attached is not a measurement.

```
Orbit benchmark — collection page, 48 product cards
  output      24,817 bytes
  runtime     node v22.14.0
  platform    win32 x64
  cpu         11th Gen Intel Core i7-1165G7 @ 2.80GHz

  operation                        median        p95        p99
  render (48 products)           0.544 ms   1.242 ms   1.766 ms
  parse + check                  0.361 ms   0.944 ms   1.143 ms
  loadCheckedAst (verify)        0.189 ms   0.361 ms   0.396 ms
  extractAccessPlan              0.022 ms   0.051 ms   0.080 ms
```

## What this licenses you to claim

**That a full page render fits comfortably in an edge CPU budget.** Cloudflare
Workers allows 10 ms of CPU on the free tier and considerably more on paid; a
0.5 ms median render leaves the budget to your data fetching, which is where it
belongs.

**That verifying a stored AST is cheap enough to do on every render** — 0.19 ms
to re-walk the entire structure against the allowlists. That matters because it
is the number that would otherwise tempt someone into
`unsafe_loadTrustedAst`.

**That the access plan is nearly free**, so declare-then-fetch costs nothing at
render time.

## What it does not license

**Any comparison to another engine.** There is none here on purpose. A
cross-engine table is easy to produce and almost always misleading: different
feature sets, different amounts of escaping work, and a scenario picked
(however unconsciously) by whoever wrote the benchmark. If Orbit ever publishes
comparative numbers it will be on a scenario suite someone else defined.

**Any claim that Orbit is fast.** The engine is a tree-walking interpreter,
which is the slowest of the reasonable architectures. It has not been optimized,
and a bytecode VM is future work. The honest position is "fast enough that a
page render is not the bottleneck", which is what the numbers above show and all
they show.

**Anything about your workload.** Real pages differ. Run it yourself.

## Method

- **Median, not mean.** One GC pause should not set the headline number. p95 and
  p99 are reported so the tail is visible rather than hidden.
- **Warm-up before measuring**, so JIT compilation is not counted as render
  cost.
- **`process.hrtime.bigint()`** for timing.
- **A real host** — a type registry, a `money` filter, settings — because a
  benchmark against a stub host measures a program nobody runs.
- **The scenario is in source**, not generated, so it can be read and disputed.

## Where the time goes

Rendering dominates, which is expected and is also the reason performance work
sits low on the roadmap: for a real page, the template render is a small
fraction of the request. Data access — the database round trips the access plan
is designed to make exact and few — is where a slow page actually comes from.

If forced to choose between optimizing the interpreter and improving the access
plan, improve the plan.
