# Embedding Orbit

Orbit ships no object model. It does not know what a product is, where data
comes from, or what a URL means in your system. You supply all of that, and the
engine guarantees the rest: termination, escaping, and no ambient authority.

This guide walks the whole seam.

## Install

```bash
npm install @orbitlang/core
```

Zero runtime dependencies, dual ESM/CJS, no I/O. It runs unchanged on Node,
Deno, Bun, Cloudflare Workers and in a browser.

## The pipeline

```
parseProgram(files)        → syntax
check(program, host)       → types, laws, contracts
serializeProgram(program)  → plain JSON, safe to store
loadCheckedAst(json)       → structural re-validation on the way back in
render(program, entry, …)  → HTML
extractAccessPlan(…)       → exactly which data a render can touch
```

Parse and check once, at publish time. Store the AST. Render many times.

---

## 1. Declare your types

```ts
import { t, TypeRegistry } from '@orbitlang/core';

const registry = new TypeRegistry();

registry.defineObject('Product', {
  title: t.string(),
  url: t.url(),
  vendor: t.optional(t.string()),   // String? — the optional law applies
  price: t.money(),                 // terminal: no operators, no rendering
  tags: t.list(t.string()),
  available: t.bool(),
});

registry.defineObject('Collection', {
  title: t.string(),
  products: t.list(t.object('Product')),
});
```

Type constructors: `t.string()`, `t.int()`, `t.float()`, `t.bool()`,
`t.color()`, `t.optional(T)`, `t.list(T)`, `t.object(name)`, plus the branded
terminals `t.money()`, `t.moneyText()`, `t.url()`, `t.image()`.

Mark a field `t.optional(...)` whenever it can be absent. That is not
bookkeeping — it is what makes the optional law able to catch a missing vendor
at compile time instead of rendering blank.

## 2. Declare host filters

Anything the language cannot do is a typed function you provide:

```ts
import type { HostFilterDecl } from '@orbitlang/core';

const filters: HostFilterDecl[] = [
  {
    name: 'money',
    params: [t.money()],
    returns: t.moneyText(),
    impl: ([value]) => {
      const m = value as { amountMinor: number; currency: string };
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: m.currency,
      }).format(m.amountMinor / 100);
    },
  },
];
```

Rules the engine enforces, at declaration time via `assertValidHostFilters`:

- Names are camelCase and may not collide with a stdlib filter.
- `Html` may only be a **top-level return** type — never nested in a list,
  record or optional.
- `Html` may be a **parameter** in exactly one shape: the first parameter of an
  `htmlTransform` filter. Anywhere else it is rejected, because a filter taking
  Html alongside untrusted arguments is asking to interleave the two.
- A filter returning `Html` **must** declare exactly one of `sanitizer`,
  `trustedHtml` or `htmlTransform`. Each names a different obligation, and
  only `trustedHtml` warns at use sites — see the table in
  [types](../language/types.md#terminal-types). Declaring two, or none, throws
  at `assertValidHostFilters`: it is an embedder bug, not a template one.

Filters must be pure and fast. A throwing filter fails the render cleanly (it
does not escape as an unhandled exception), and the deadline is checked either
side of the call — but a slow filter still spends your budget.

## 3. Compile

```ts
import { parseProgram, check, formatDiagnostics } from '@orbitlang/core';

const parsed = parseProgram([
  { name: 'components/card.orbit', source: cardSource },
  { name: 'pages/collection.orbit', source: pageSource },
]);

if (!parsed.ok) {
  // One pass reports every error in every file.
  const sources = new Map([['components/card.orbit', cardSource]]);
  throw new Error(formatDiagnostics(parsed.diagnostics, sources));
}

const result = check(parsed.program, {
  registry,
  hostFilters: filters,
  pageGlobals: { collection: t.object('Collection') },
});

const errors = result.diagnostics.filter((d) => d.severity === 'error');
if (errors.length > 0) throw new Error('theme does not compile');
```

`check` never throws. It returns diagnostics with spans and fix-its; render
them with `formatDiagnosticWithSource` for a code frame.

## 4. Store the AST, and re-validate it coming back

```ts
import { serializeProgram, loadCheckedAst } from '@orbitlang/core';

const stored = JSON.stringify(serializeProgram(parsed.program));

// Later, on a render path:
const program = loadCheckedAst(JSON.parse(stored), { trust: 'verify' });
```

Treat the stored AST as **executable code**, because it is. `loadCheckedAst`
re-walks the whole structure — node kinds, the element and attribute
allowlists, content models, loop limits — so a row that was tampered with in
your database cannot smuggle a `<script>` into a page that once compiled
cleanly.

There is also `unsafe_loadTrustedAst`, deliberately named so that its use is
visible in review. Reach for it only when the bytes came from memory you just
produced.

### Signing stored ASTs

The engine holds no key material. It provides the canonicalization and a
constant-time comparison; you provide the HMAC primitive:

```ts
import { createHmac } from 'node:crypto';
import { signAst, verifyAstTag } from '@orbitlang/core';

const hmac = (key: Uint8Array, msg: Uint8Array) =>
  new Uint8Array(createHmac('sha256', key).update(msg).digest());

const tag = signAst(hmac, key, { storeId, themeVersionId, astBytes });
const ok = verifyAstTag(hmac, key, { storeId, themeVersionId, astBytes }, tag);
```

Binding the tag to `storeId` is what stops a valid theme from one tenant being
replayed against another.

## 5. Fetch only what the template uses

```ts
import { extractAccessPlan } from '@orbitlang/core';

const plan = extractAccessPlan(program, 'collection');
// [ 'collection.products', 'collection.products[].title', … ]
```

The plan is exact because Orbit has **no dynamic member access** — there is no
`obj[key]` for a runtime `key`, so every path a render can touch is visible
statically. Use it to drive a declare-then-fetch data layer: resolve precisely
these paths, and nothing more.

The plan is deliberately an **over-approximation** where it cannot be exact
(paths through filters, for example): it may list a path a given render does not
reach, but never omits one it does. Over-fetching is a performance problem;
under-fetching is a correctness bug.

## 6. Render

```ts
import { render } from '@orbitlang/core';

const out = render(program, 'collection', {
  bindings: { collection: await fetchCollection(plan) },
  hostFilters: filters,
  settings: { collection: { showVendors: true } },

  // Configure these from your own p99, not from the published minimums.
  fuel: 250_000,
  maxIterations: 2_000,
  maxOutput: 512 * 1024,
  deadlineMs: 50,

  urlPolicy: 'error',   // fail instead of emitting a placeholder
});

if (!out.ok) {
  logger.error({ code: out.error.code, at: `${out.error.template}:${out.error.line}` });
  return renderFallbackPage();
}

for (const w of out.warnings) {
  // Structured: code, message, line, col. Route them to the theme author.
  logger.warn({ code: w.code, message: w.message, line: w.line });
}

return out.html;
```

### `urlPolicy`

By default a URL that fails the scheme allowlist is replaced with `#` and
raises an `O4900` warning, so one bad link does not take down a page. Set
`urlPolicy: 'error'` to fail the render instead. Choose deliberately: the
default favours availability, `'error'` favours noticing.

## The responsibility split

The engine guarantees, and tests:

- **Termination.** No recursion, literal loop bounds, one global iteration
  counter, fuel, and a deadline.
- **Escaping.** Six contexts assigned structurally, closed element and
  attribute allowlists, URL sanitization at the sink.
- **No ambient authority.** No I/O, no clock beyond the one you inject, no
  module state. Renders cannot see each other.
- **Determinism.** Same program, same data, same bytes.

You are responsible for:

- **Authorization.** The engine will happily render whatever you bind. Scope
  your data fetches by tenant.
- **Data scoping.** An access plan tells you what to fetch, not who may see it.
- **Key custody** for stored-AST signing.
- **Budgets** appropriate to your traffic.
- **Document metadata.** `<html>`, `<head>`, `<meta>` and `<link>` are not in
  the element allowlist; templates render fragments and you own the shell.

See [the security model](security-model.md) for the reasoning behind each
guarantee.
