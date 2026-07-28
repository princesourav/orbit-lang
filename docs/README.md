# Orbit documentation

Orbit is a typed, non-Turing-complete, HTML-strict template language for
storefronts, content sites, and anywhere templates are authored by people — or
models — you do not fully trust.

The engine is `@orbitlang/core`: a parser, type checker, six-context escaper and
fuel-metered interpreter. It ships no object model. You bring your own data
types and host filters, and the engine guarantees the rest.

## Read in this order

**If you are writing templates**

1. [Tutorial](language/tutorial.md) — your first component, end to end.
2. [Safety rules](language/safety.md) — the two rules that surprise newcomers:
   no truthiness, and the optional law. Read this before you get stuck.
3. [Templates and markup](language/templates.md) — elements, attributes,
   whitespace, and why the element list is closed.
4. [Components and pages](language/components.md) — props, slots, `<let>`.
5. [Types](language/types.md) — the type system, including the branded terminal
   types (`Money`, `Url`, `Html`) that behave unlike anything else.

**If you are embedding the engine**

1. [Embedding guide](guides/embedding.md) — implementing a host, declaring
   types and filters, budgets, stored ASTs, access plans.
2. [Security model](guides/security-model.md) — what the engine guarantees,
   and precisely what remains your job.

**Reference**

- [Grammar](reference/grammar.md) — the full syntax and operator precedence.
- [Filters](reference/filters.md) — all 19 stdlib filters.
- [Limits](reference/limits.md) — every cap and the code it trips.
- [Error codes](reference/errors.md) — every diagnostic, generated from source.

## Try it without installing anything

The [playground](../playground/) is a single self-contained HTML file. Open it
from a `file://` URL: no server, nothing uploaded. Paste a hostile template and
watch it fail to compile in your own browser.

## Tools

```bash
npm install @orbitlang/core

npx orbit check src/themes/        # parse and report, with code frames
npx orbit fmt src/themes/          # canonical formatting
npx orbit fmt --check src/themes/  # CI gate: fail if anything would change
```

Editor support lives in [`tree-sitter-orbit/`](../tree-sitter-orbit/) (Neovim,
Zed, Helix) and [`editors/vscode/`](../editors/vscode/).

## What Orbit will not do

These are permanent, not a backlog:

- **No Turing-completeness.** No user-defined functions, no recursion, no
  unbounded loops. Every render terminates.
- **No dynamic member access.** `obj[expr]` is a parse error. This is what makes
  the static data-access plan sound.
- **No raw HTML mode.** There is no escape hatch that emits unescaped markup;
  the only unescaped sink is a host filter explicitly declared `trustedHtml`.
- **No regular expressions**, anywhere in the engine or the stdlib.

If you need more power than the language offers, the answer is a typed host
filter — a boundary you control and can audit — never a loosening of the
language.
