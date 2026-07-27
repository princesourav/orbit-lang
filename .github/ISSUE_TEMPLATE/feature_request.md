---
name: Feature request
about: Propose a capability, a diagnostic improvement, or a language change
title: ''
labels: enhancement
assignees: ''
---

<!--
Read this before writing: Orbit's value is what it refuses to do.

Language-feature requests are evaluated against the project's published
NON-GOALS (README "What Orbit is not", CONTRIBUTING "Out of scope"). These are
permanent design decisions, not a backlog. A proposal that adds any of the
following will be closed with thanks, however well argued:

  * Turing-completeness — user-defined functions, recursion, unbounded loops,
    arbitrary computation in expressions
  * Dynamic member access, method calls, or reflection
  * Raw-HTML escape hatches — |safe, |raw, triple-mustache, <raw> blocks
  * eval, new Function, or runtime compilation to JS
  * Regex, anywhere
  * <script>, <style>, <svg>, <iframe>, or inline event handlers
  * Migration tooling from Liquid or any other engine
  * Runtime I/O, network, filesystem, or a clock that affects output
  * Anything that makes output non-deterministic or a budget forgeable

If you need more power than the language gives you, the sanctioned answer is a
typed HOST FILTER — code you write, review and own, declared through the host
interface. Please check whether that solves your problem before filing.
-->

## The problem

<!-- Describe the situation you are stuck in, not the feature you want. What
     were you trying to author, and what stopped you? Concrete templates beat
     abstractions. -->

## What you tried

<!-- Including whether a typed host filter would solve it, and if not, why not. -->

## Proposed direction

<!-- Optional. Syntax sketch, diagnostic wording, API shape. -->

## Non-goals check

- [ ] I have read the non-goals in the README and CONTRIBUTING.
- [ ] This proposal does **not** add Turing-completeness, dynamic member access,
      a raw-HTML mode, regex, or runtime I/O.
- [ ] This proposal does **not** make output non-deterministic or allow a
      template author to exceed a host-configured budget.
- [ ] A typed host filter does not solve this (explain above if it partially
      does).

If any of those boxes cannot be ticked, file the issue anyway — but say so
plainly and make the case. An honest "this crosses a line, and here is why the
line is in the wrong place" is a better conversation than a proposal that hides
the collision.

## Category

- [ ] Diagnostic quality (message, span, fix-it) — always welcome
- [ ] Stdlib filter
- [ ] Host-interface / embedding ergonomics
- [ ] Tooling (formatter, LSP, playground — see the v0.5 roadmap first)
- [ ] Documentation
- [ ] Language syntax or semantics — needs an issue before any code, and is
      handled as a staged proposal
- [ ] Other

## Who else needs this

<!-- Are you embedding Orbit? Authoring templates? Generating them with an
     agent? Knowing the audience changes the answer more than you'd expect. -->
