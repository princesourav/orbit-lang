# Security model

What the engine guarantees, how, and precisely what it does not.

The short version: Orbit does not have a sandbox, because it does not have an
escape surface to sandbox. Every guarantee below is a property of the language
or of a closed allowlist, not of a filter that has to anticipate an attack.

## Threat model

**Assumed hostile:** the template author, the data bound into a render, and the
stored AST row. Any of the three may be attacker-controlled.

**Assumed trusted:** the host process, its type registry, its host filter
implementations, and its key material.

Orbit exists for the multi-tenant case — a platform where a merchant, a
customer, or a language model writes templates and the platform renders them
next to other tenants. If your templates are written only by your own engineers
and reviewed in pull requests, you have a much weaker threat model and most of
this page is insurance you may not need.

---

## Escaping: contexts are structural, not inferred

Every interpolation's escaping context is a property of **where it sits in the
AST**, decided before any data exists:

| Context | Where | Escapes |
|---|---|---|
| TEXT | Element content | `&` `<` `>` |
| RCDATA | Inside `<title>`, `<textarea>` | `&` `<` |
| ATTR | Any attribute value | `&` `"` `<` `>` |
| URL-ATTR | `href`, `src`, `srcset`, `action`, `formaction`, `poster`, `cite` | Sanitized, then ATTR-escaped |
| JSON-LD | Inside `<json-ld>` | `<` `>` `&` `/`, U+2028/9 as `\uXXXX` |
| RAWTEXT | — | **Unreachable** |

RAWTEXT is unreachable *by construction*: `<script>` and `<style>` are not in
the element allowlist at all, so no code path emits into a rawtext context.
Stored-AST validation rejects a `rawtext` content model outright, so a poisoned
row cannot manufacture one either.

This matters because context-confusion is the classic autoescaping failure. An
engine that decides escaping by inspecting the value, or by a filter the author
must remember, has a bug class Orbit does not have: there is nothing to
remember and nothing to infer.

## Allowlists are closed

94 elements are permitted. 16 more are banned with a specific reason attached
(`<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta>`,
`<link>`, `<template>`, `<noscript>`, `<svg>`, `<math>`, `<portal>`, …).
Anything else is rejected as unknown.

Attributes are likewise closed: a global set, per-element sets, and the
`data-*` / `aria-*` families. Rejected outright: every `on*` handler, `srcdoc`,
`ping`, `background`, `longdesc`, and any namespaced name such as `xlink:href`.

Two further restrictions are worth calling out:

- **No dynamic attribute names.** You cannot compute which attribute to set.
- **`style` must be fully static.** Interpolation inside a `style` attribute is
  a parse error, because a CSS value is its own injection context and Orbit does
  not implement a CSS escaper. Dynamic styling goes through a class name or a
  host-supplied custom property.

A closed allowlist means new HTML features are safe-by-default: an element
invented after this release is rejected until someone deliberately adds it.

## URLs are sanitized at the sink, never trusted from a type

This is worth stating precisely, because it is the design decision most often
misread. A plain `String` **is** allowed in `href`. Orbit does not require a
`Url` type there, and would not be safer if it did.

Sanitization happens where the value is emitted:

1. C0 control characters and DEL are stripped **first**, which defeats
   `java\tscript:` style splits.
2. The scheme must be `http`, `https`, `mailto`, `tel`, or the value must be
   site-relative, `./`, `../`, `?`, or `#`.
3. Protocol-relative `//host` is rejected.
4. `data:` is permitted only as `data:image/*`, and only in `src`.
5. `srcset` is parsed as a candidate list and each URL sanitized independently.

A blocked URL becomes `#` with a structured `O4900` warning, or fails the render
if you set `urlPolicy: 'error'`.

The reason for sink-side enforcement is that type-based URL safety keeps
failing in practice: a `Url` value acquires its contents from somewhere, and
that somewhere is usually a string a human or an API supplied. Enforcing at the
sink means the guarantee holds no matter what the filter chain did or which
type the value claims to be.

## Terminal types

Some types exist to make a category of mistake unrepresentable:

- **`Html`** renders only as element content — never as a prop, binding,
  operand, attribute value, or inside RCDATA or JSON-LD. It is **not
  host-declarable**: the only producers are host filters flagged
  `unsafeHtml: true`, and every use site raises a warning. That flag is your
  complete audit list for unescaped output.
- **`Money`** admits no operators, no properties, no equality, no stdlib
  filters and no rendering. Currency arithmetic in a template is a bug; the type
  makes it impossible to write. Format it with a host filter returning
  `MoneyText`.
- **`MoneyText`** renders, but admits no filters — it is already formatted.
- **`Image`** is host-filter input only.

## Termination

- No user-defined functions, no recursion, no `while`.
- Loop `limit` must be a compile-time literal, at most 250.
- One **global** iteration counter, threaded through component calls and slot
  expansion, so nesting cannot multiply a budget.
- Fuel charged per emitted code unit plus a per-element cost, including filter
  output — so "produce something enormous and emit nothing" still costs.
- A wall-clock deadline using an injected clock, abort-only.
- An output cap.

Twig's advisory for CVE-2026-46627 states that its sandbox "does not protect
against resource exhaustion", which is the general shape of the problem: a
sandbox constrains what code can reach, not how much work it does. Orbit's
answer is that the language cannot express unbounded computation in the first
place, and the budgets bound the constant factor.

## Determinism and statelessness

Same program, same data, same options → identical bytes. The injected `now()` is
used only to abort on the deadline and never reaches output. The interpreter
holds no cache and no module state, so one tenant's render cannot observe or
influence another's. Memoization, if you want it, belongs in your adapter where
the cache key can include the tenant.

## Stored ASTs are executable

`loadCheckedAst(json, { trust: 'verify' })` re-walks every node: kinds against
an allowlist, elements and attributes against the same closed tables the parser
uses, content-model consistency, loop-limit literals, name shapes, and every
depth and size cap. A tampered row cannot introduce a construct the parser would
have refused.

Sign the row too. `signAst` canonicalizes `(storeId, themeVersionId, astBytes)`
with domain separation, and `verifyAstTag` compares in constant time; you supply
the HMAC primitive, because the engine holds no key material. Binding to
`storeId` is what stops a valid theme from one tenant being replayed against
another.

---

## What Orbit does NOT protect against

Stated plainly, because a security page that only lists strengths is marketing:

- **Authorization.** The engine renders whatever you bind. If you bind another
  tenant's data, it will render it faithfully.
- **Downstream mXSS.** Orbit guarantees its output is correctly escaped for the
  context it emitted into. If you then pass that HTML through a rewriter, a
  sanitizer with different parsing rules, or an email client's mangler, that
  pipeline owns the outcome.
- **Host filter bugs.** A filter flagged `unsafeHtml` emits raw markup. That is
  the point of the flag, and it is your code.
- **Denial of service by an authorized operator.** Budgets bound a single
  render, not how many renders a legitimate caller may request.
- **Data exfiltration through legitimate output.** A template that is permitted
  to read a field can render that field. Restrict what you bind.
- **Anything in the browser.** Orbit is a server-side renderer. Pair it with a
  Content-Security-Policy; Orbit is the server half of that pipeline, not a
  substitute for it.

## Reporting a vulnerability

See [SECURITY.md](../../SECURITY.md): private reporting through GitHub Security
Advisories, 72-hour acknowledgement, 90-day coordinated disclosure, and a CVE
requested for anything confirmed.

In scope: escaping bypasses, budget bypasses, termination escapes, stored-AST
poisoning. Out of scope: host misconfiguration, missing authorization in the
host, and resource exhaustion by an authorized operator — all of which are the
embedder's responsibility by design and are documented as such above.
