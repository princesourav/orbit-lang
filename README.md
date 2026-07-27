# @commerceos/orbit-lang

**Orbit** — a typed, non-Turing-complete template language for themes. This
package is the **open half** of the engine (ADR-0017): parser, type checker,
context-aware escaper, stateless interpreter, pure stdlib, and the
bring-your-own-object-model host interface.

> **Status: v0, internal.** Working engine core with a conformance-style test
> suite. Lives in this monorepo as `@commerceos/orbit-lang` for build
> convenience only — it has **zero imports from any `@commerceos` package**
> and extracts verbatim to `@orbitlang/core` (Apache-2.0, GitHub org
> `orbit-lang`, `.orbit` files) at OSS launch.

## The open/closed split

| Open (this package, future Apache-2.0) | Closed (platform adapter, never here) |
|---|---|
| Grammar, parser, spans, diagnostics | cos object model / TypeRegistry contents |
| Type checker (optional law, terminality rules) | Platform filters: `money`, `img`, `jsonld`, `asset`, `paginate` |
| Six-context escaper + URL sink allowlist | AccessPlan **resolver** (tenant-scoped batch fetch) |
| Stateless interpreter, fuel/iteration/deadline budgets | Render pipeline, manifests, artifact serving, HMAC minting |
| Pure stdlib (19 filters, no regex, cap-checked) | Memoization/caching of any kind (`store_id`-first keys) |
| `extractAccessPlan` static analysis | Settings storage + customizer wiring |

Anyone can run Orbit anywhere via `OrbitHost` (a `TypeRegistry`, typed host
filters, resolved data). Nobody can render a *CommerceOS theme* without
CommerceOS — the object model, data plane and distribution custody are the
platform's, per the Liquid precedent.

## Pipeline

```
parseProgram(files)        → Program (caps enforced AT CONSTRUCTION)
check(program, {registry, hostFilters, pageGlobals})
                           → diagnostics with spans + fix-its (never throws)
serializeProgram(program)  → plain-JSON AST for storage
loadCheckedAst(json, {trust: 'verify'})
                           → structural re-validation (W-36) then Program
render(program, entry, {bindings, hostFilters, settings, fuel, deadlineMs, now})
                           → { ok, html, warnings } | { ok: false, error }
extractAccessPlan(program, entry)
                           → exact data paths the render touches
```

## Security invariants (engine-enforced, tested)

- **Escaping contexts are statically known** per interpolation site: TEXT,
  RCDATA (`<title>`/`<textarea>`), ATTR, URL-ATTR, JSON-LD. RAWTEXT is
  **unreachable by construction** — `<script>`/`<style>` are not in the
  element allowlist at all; interpolation in `style` attributes is a parse
  error (W-08/W-09).
- **Closed allowlists** for elements, attributes and URL-bearing attributes;
  `on*`, `srcdoc`, namespaced attrs rejected; no dynamic attribute names, no
  spread (W-11/W-12).
- **URL sanitization at the sink**, never trusted from the `Url` type:
  control chars stripped first, scheme allowlist http/https/mailto/tel/
  relative/#, no protocol-relative, `data:` only as `data:image/*` in `src`
  (W-11a).
- **Terminal branded types:** `Html` renders only as element content — never
  a prop, binding, operand or attribute — and is **not host-declarable**;
  the only producers are host filters flagged `unsafeHtml: true`, warned at
  every use (W-13, W-34). `Money` admits no operators, no properties, no
  rendering, no stdlib filters. `MoneyText` renders but admits no filters.
  `Image` is host-filter input only.
- **No truthiness** (`<if>` requires `Bool`) and **the optional law**: using
  `T?` without `??` or flow-narrowing (`x != none` in the guarding `<if>`;
  `||` does not narrow) is a compile error with a fix-it.
- **Budgets:** byte-charged global fuel, ONE global iteration counter
  threaded through component calls, wall-clock deadline (injectable clock,
  abort-only), output cap, per-value caps (string ≤ 256 KiB, list ≤ 5,000)
  at every filter step; **no regex anywhere** in the stdlib or the
  implementation (W-04/W-06). Published caps are spec minimums — production
  values are lower, unpublished configuration (W-33).
- **Stateless interpreter** — no cache, no module state; deterministic
  output (`now()` is used only to abort). Memoization belongs to the closed
  adapter (W-17).
- **Stored-AST integrity:** `loadCheckedAst` re-validates structure; the
  deliberately ugly `unsafe_loadTrustedAst` skips it and exists so misuse is
  visible in review. The HMAC over `(store_id, theme_version_id, ast_bytes)`
  is HOST-side — the engine has no key material (W-36).
- Dynamic cap trips FAIL the render with template/line/col; a partial page
  is never returned (W-05).

## Known gaps in v0 (honest list)

- **No error recovery**: the parser stops at the first error per file
  (multi-diagnostic output is a checker-only feature today).
- **No named filter arguments** (`img(x, widths: [...])` sugar) — positional
  only; the closed `img` helper will address ergonomics host-side.
- Frontmatter defaults are literals only; no `layout` frontmatter, no
  `<match>/<case>`, no `t()` locales (deliberate v1.1 deferrals).
- `first`/`last` take no count argument (they return `T?`).
- Whitespace collapsing keeps single boundary spaces inside mixed text runs;
  templates that need byte-exact spacing use `{" "}`.
- No LSP, no playground, no markdown docs beyond this README (per scope).

## Tests

Colocated `*.test.ts` (vitest): parser rejection matrix, checker law/contract
suite, per-context escaping matrices, interpreter budget trips + determinism
+ statelessness, stdlib cap behavior, stored-AST poisoning defenses, and a
byte-exact end-to-end render of the design doc's product-card + collection
page against a fake host.

```
pnpm --filter @commerceos/orbit-lang test
```
