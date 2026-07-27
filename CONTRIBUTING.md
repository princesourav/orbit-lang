# Contributing to Orbit

Thanks for looking. Orbit is a small, deliberately narrow project: a typed,
non-Turing-complete template engine whose entire value proposition is what it
**refuses** to do. That shapes what contributions look like here, so please read
the [Out of scope](#out-of-scope) section before starting work on a language
feature.

Bug fixes, tests, diagnostics improvements, and documentation are welcome
directly as pull requests. Grammar or semantics changes need an issue first.

## Development setup

Requirements:

- **Node.js 22 or newer** (the project targets modern ESM/CJS runtimes and is
  tested on current LTS).
- **pnpm** (`corepack enable` will provide it).

```sh
git clone https://github.com/princesourav/orbit-lang.git
cd orbit-lang
pnpm install

npx vitest run     # run the full test suite
npx tsc --noEmit   # typecheck
```

Both must be green before you open a pull request. There is no build step
required for development — the tests run against `src/` directly.

Useful variants while iterating:

```sh
npx vitest                     # watch mode
npx vitest run src/escape.test.ts   # one file
npx vitest run -t "optional law"    # by test name
```

### Repository layout

Everything ships from `src/`, and tests are colocated next to the file they
cover — `src/escape.ts` is tested by `src/escape.test.ts`. There is no separate
`test/` tree, and there never will be; if you add a source file, its test file
sits beside it.

| File | Responsibility |
|---|---|
| `lexer.ts` | Expression tokenizer (hand-rolled scanner) |
| `parser.ts` | Frontmatter + HTML-strict tree parser, structural caps |
| `allowlists.ts` | Closed element / attribute / URL-attribute tables |
| `types.ts` | Type constructors, `TypeRegistry`, assignability |
| `checker.ts` | Type checking, the optional law, terminality rules |
| `escape.ts` | The five reachable escaping contexts + URL sanitizer |
| `interpreter.ts` | Stateless renderer, budgets, warnings |
| `stdlib.ts` | The 19 pure filters, per-value caps |
| `host.ts` | Host interface, host filters, `extractAccessPlan` |
| `validate-ast.ts` | Serialize / structurally re-validate stored ASTs |
| `limits.ts` | Every cap, in one place |

## Sign your commits (DCO, not CLA)

Orbit accepts contributions under the
[Developer Certificate of Origin](https://developercertificate.org/) 1.1. Sign
off every commit:

```sh
git commit -s -m "fix: reject protocol-relative URLs in srcset candidates"
```

`-s` appends a `Signed-off-by:` trailer with your name and email. That trailer is
your statement that you wrote the change, or have the right to submit it under
the project's license. CI enforces it on every commit in a pull request.

Forgot to sign off? Fix the whole branch with:

```sh
git rebase --signoff main
```

**Why DCO and not a CLA.** A CLA asks contributors to grant a private entity
rights beyond the project's own license — usually so that entity can relicense
the work later. That is a reasonable thing for a company to want and an
unreasonable thing to ask of someone fixing an escaping bug. The DCO asks only
for a truthful statement of provenance, requires no paperwork, and cannot be
used to change the license out from under contributors. Apache-2.0 already
grants the project (and everyone else) the patent and copyright license it
needs. This is not negotiable and will not change at v1.0.

## Invariants a pull request must not break

These are the product. A change that weakens any of them will be closed
regardless of how much it improves ergonomics.

1. **No regex, anywhere in `src/`.** No `RegExp`, no regex literals, no
   `String.prototype.match`/`replace`/`split` with a pattern argument. Every
   scanner is a hand-rolled linear pass. The reason is blunt: a template engine
   that runs untrusted input through a backtracking regex engine has handed the
   attacker a CPU budget it cannot account for. `src/stdlib.test.ts` asserts
   this for the stdlib; the rule applies to the whole of `src/`.
2. **No Turing-completeness.** No user-defined functions, no recursion, no
   unbounded loops. Loop `limit` stays a compile-time literal bounded by
   `LIMITS.maxLoopLimit`.
3. **No dynamic member access, no method calls, no reflection.** `obj[expr]` is
   permitted only for list indexing by `Int`. This is what makes
   `extractAccessPlan` sound; breaking it breaks static data-access extraction.
4. **No `eval`, no `new Function`, no runtime compilation to JS.**
5. **Escaping contexts stay structural.** A context is decided by where a value
   is written, never by the value's type or content. Do not add a "trust this
   value" path.
6. **Allowlists stay closed.** New elements or attributes are additions to an
   allowlist with a rationale, never a switch to a denylist. `<script>`,
   `<style>`, `<iframe>`, `<svg>` and friends stay out permanently.
7. **`Html` stays engine-owned and terminal.** It is not host-declarable, and it
   renders only as element content. The only producer is a host filter flagged
   `unsafeHtml: true`.
8. **Every budget stays global and unforgeable.** One iteration counter per
   render, threaded through component and slot boundaries. Per-value caps are
   re-checked at every filter step, not just at the end.
9. **The engine stays free of I/O and ambient authority.** No `process`, no
   `Buffer`, no `console`, no `fetch`, no DOM. `tsconfig.json` sets
   `"types": []` and omits the DOM lib on purpose — do not add them. `Date.now`
   appears only as the default for the injectable deadline clock and never
   influences output bytes.
10. **Output stays deterministic.** Same program + same data + same options =
    byte-identical HTML. No iteration over unordered structures without an
    explicit sort, no `Math.random`, no locale-sensitive default formatting.
11. **Zero runtime dependencies.** Development dependencies need a good reason;
    a runtime dependency needs an extraordinary one.

## Adding a test

Every behavioral change needs a test, in the colocated file for the source file
you touched. The house style is short, plain vitest — a `describe` naming the
rule, and `it` blocks naming the specific behavior in prose:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizeUrl } from './escape';

describe('URL-ATTR context', () => {
  it('blocks protocol-relative //', () => {
    expect(sanitizeUrl('//evil.example/x', 'href').ok).toBe(false);
  });
});
```

For anything touching the parser, checker or interpreter, use the fake host in
`src/test-host.helper.ts` rather than building a registry inline —
`compileOk(files)` gives you a checked `Program`, `compile(files)` gives you the
diagnostics, and `codesOf(diagnostics)` gives you the codes to assert on.

Rules of thumb:

- **Escaping, allowlist and budget changes require adversarial tests**, not just
  happy-path ones. Show the payload that used to get through.
- **Assert on diagnostic codes, not on message text.** Codes are API; wording
  is not.
- **Assert exact output bytes** for rendering tests. `toBe`, not `toContain`.
- If you find a bug, add the failing test in the same pull request as the fix.

Property-based tests (fast-check) live in `src/*.property.test.ts` and are the
right tool for invariants — round-trips, monotonicity, "no input produces an
unescaped `<`". Reach for one when you find yourself writing the tenth variant
of the same assertion.

## Diagnostic codes

Every diagnostic carries a stable code, a span, and — wherever a mechanical fix
exists — a `suggestion`. Codes are grouped by the phase that emits them:

| Range | Phase | Emitted by |
|---|---|---|
| `O1xxx` | Lexing and parsing — grammar, allowlists, structural caps | `lexer.ts`, `parser.ts` |
| `O2xxx` | Type checking — types, contracts, the optional law | `checker.ts`, `stdlib.ts` |
| `O3xxx` | Type checking — the truthiness law | `checker.ts` |
| `O4xxx` | Runtime — budget trips, data-shape violations, JSON-LD | `interpreter.ts`, `escape.ts`, `stdlib.ts` |
| `O5xxx` | Stored-AST structural validation | `validate-ast.ts` |

Conventions:

- **Codes are permanent.** Once a code ships, its meaning does not change. If a
  rule changes materially, retire the old code and add a new one.
- **Never reuse a code for a different rule.** Two distinct rules sharing a code
  is a bug — we fixed several of these in v0.2 and would rather not do it again.
- **Allocate a new code at the end of its range block.** Grep for the range
  (`grep -o "'O2[0-9]\{3\}'" src/checker.ts | sort -u`) and take the next free
  number in the relevant hundred-block; the blocks group related rules.
- **Every error that a template author can trigger should carry a
  `suggestion`** if a mechanical fix exists. Diagnostics are the flagship
  feature of this project, not an afterthought.

## Out of scope

Pull requests implementing any of the following will be closed with thanks. They
are permanent non-goals, not a backlog:

- **Anything that adds Turing-completeness**: user-defined functions, recursion,
  `while`, unbounded iteration, arbitrary computation in expressions.
- **Dynamic member access or reflection**: `obj[nameFromData]`, method calls,
  `typeof`-style introspection, property enumeration over host objects.
- **Raw HTML modes**: `|safe`, `|raw`, triple-mustache, `<raw>` blocks, or any
  other way for a template author to opt out of escaping. The single unescaped
  sink is a host filter the embedder wrote and flagged `unsafeHtml: true`, and
  that stays the only one.
- **Regex**: in the stdlib, in the scanners, in a `matches` filter, anywhere.
- **`<script>`, `<style>`, `<svg>`, `<iframe>` or inline event handlers**, in
  any form, including "just for trusted templates".
- **Migration tooling from Liquid or any other engine.** Adoption is
  greenfield-first by design; converters import untyped idioms and set false
  drop-in-compatibility expectations. This has been decided and is not
  reopened by new proposals.
- **Runtime I/O, network access, filesystem access, or a clock that affects
  output.**
- **Performance work that trades away any invariant above.** The engine is not
  positioned on speed, and a fast engine with a soft boundary is worth nothing
  here.

If you need more power than the language gives you, the sanctioned answer is a
**typed host filter** — code you wrote, reviewed and own, declared through the
host interface with explicit parameter and return types. That seam exists
precisely so the language does not have to grow.

Language additions that do *not* violate the above (`<match>/<case>`, slot
fallback content, whitespace control, i18n) are tracked as staged proposals and
start with an issue describing the problem before any code.

## Security issues

Do not open a public issue. See [SECURITY.md](./SECURITY.md) for the private
reporting channel, our response targets, and the 90-day coordinated disclosure
policy.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
