## What this changes

<!-- One or two sentences. What behavior is different after this PR? -->

## Why

<!-- The problem, not the solution. Link the issue if there is one. -->

Fixes #

## How to verify

<!-- The command a reviewer runs, and what they should see. -->

```sh
npx vitest run
npx tsc --noEmit
```

---

## DCO

- [ ] Every commit in this PR is signed off (`git commit -s`), certifying I wrote
      the change or have the right to submit it under Apache-2.0.

Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/). There is no
CLA. If you forgot, `git rebase --signoff main` fixes the whole branch.

## Checks

- [ ] `npx vitest run` passes
- [ ] `npx tsc --noEmit` is clean
- [ ] New or changed behavior has a test, colocated as `src/<file>.test.ts`
- [ ] Tests assert **diagnostic codes**, not message wording, and **exact output
      bytes** (`toBe`, not `toContain`) for rendering
- [ ] If this changes escaping, an allowlist, or a budget: an **adversarial**
      test is included showing the payload that used to get through
- [ ] If this adds a diagnostic: a new code at the end of its range block, never
      a reused one, with a `suggestion` if a mechanical fix exists
- [ ] If this changes a documented claim: the corresponding row in
      `docs/compliance/claims.md` is updated, added, or removed

## Invariants

Confirm this PR does **not** do any of the following. If any box cannot be
ticked, say why in the description — it is not automatically disqualifying, but
it needs an explicit argument.

- [ ] **No regex** anywhere in `src/` — no `RegExp`, no regex literals, no
      `match`/`replace`/`split` with a pattern argument
- [ ] **No Turing-completeness** — no user-defined functions, recursion, or
      unbounded iteration; loop `limit` stays a compile-time literal
- [ ] **No dynamic member access, method calls or reflection** (`list[intExpr]`
      indexing remains the only exception)
- [ ] **No `eval` / `new Function` / runtime compilation to JS**
- [ ] **No new raw-HTML escape hatch** — the only unescaped sink remains a host
      filter flagged `trustedHtml: true`
- [ ] **Escaping contexts stay structural** — decided by where a value is
      written, never by its type or content
- [ ] **Allowlists stay closed** — additions carry a rationale; no switch to a
      denylist, and `script`/`style`/`iframe`/`svg` stay out
- [ ] **`Html` stays engine-owned and terminal** — not host-declarable, element
      content only
- [ ] **Budgets stay global and unforgeable** — one iteration counter per render,
      threaded through component and slot boundaries
- [ ] **No I/O or ambient authority** — no `process`, `Buffer`, `console`,
      `fetch` or DOM; `tsconfig.json` keeps `"types": []`
- [ ] **Output stays deterministic** — same program + data + options yields
      byte-identical HTML
- [ ] **No new runtime dependencies**

## Anything else

<!-- Trade-offs you made, alternatives you rejected, things you want scrutinized. -->
