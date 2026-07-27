---
name: Bug report
about: Something in the engine behaves incorrectly
title: ''
labels: bug
assignees: ''
---

<!--
STOP if this is a security issue.

Do NOT file a public issue for an escaping bypass, a budget bypass, a
sandbox/termination escape, or stored-AST poisoning. Use private reporting:
https://github.com/princesourav/orbit-lang/security/advisories/new
See SECURITY.md for scope and our response targets.
-->

## What happened

<!-- Observed behavior, in one or two sentences. -->

## What you expected

<!-- Expected behavior. If the engine produced HTML, paste the exact bytes you
     expected, not a paraphrase — output is deterministic, so exactness helps. -->

## Minimal reproduction

The most useful bug report is a failing test. Fill in whichever of these apply.

**Template**

```
---
page example
---
<!-- the smallest template that reproduces it -->
```

**Host declarations** (object model, host filters, page globals)

```ts
const registry = new TypeRegistry();
registry.defineObject('Thing', { /* ... */ });
```

**Data / render options**

```ts
render(program, 'example', { bindings: { /* ... */ } });
```

**Actual output or diagnostic**

```
<!-- exact HTML bytes, or the exact diagnostic code and message -->
```

## Which phase

- [ ] Parsing (`O1xxx` — grammar, allowlists, structural caps)
- [ ] Type checking (`O2xxx` / `O3xxx` — types, contracts, the optional law)
- [ ] Rendering (`O4xxx` — budgets, escaping, data shape)
- [ ] Stored-AST validation (`O5xxx`)
- [ ] Access-plan extraction
- [ ] Not sure

Diagnostic code, if there is one:

## Environment

- `@orbitlang/core` version:
- Runtime and version (Node / Deno / Bun / Workers / browser):
- Operating system:

## Anything else

<!-- Workaround you found, when it started, whether it is a regression. -->
