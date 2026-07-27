# @orbitlang/core

[![CI](https://github.com/princesourav/orbit-lang/actions/workflows/ci.yml/badge.svg)](https://github.com/princesourav/orbit-lang/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@orbitlang/core.svg)](https://www.npmjs.com/package/@orbitlang/core)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/princesourav/orbit-lang/badge)](https://scorecard.dev/viewer/?uri=github.com/princesourav/orbit-lang)

**Orbit** is a typed, non-Turing-complete, HTML-strict template language engine
for templates written by people — or AI agents — you do not fully trust.

XSS is a compile error. Runaway loops are a budget trip. The data a template can
touch is statically extractable. None of it depends on a sandbox, because there
is no escape surface to sandbox: the language has no dynamic member access, no
method calls, no `eval`, no raw-HTML mode, and no way to reach a host object the
embedder did not declare.

This package is the **whole engine**: lexer, parser, type checker, six-context
escaper, stateless interpreter, pure stdlib, stored-AST validator, and the
bring-your-own-object-model host interface. Zero runtime dependencies, zero I/O,
no DOM, no Node built-ins — it runs unchanged on Node, Deno, Bun, Cloudflare
Workers and in the browser.

> **Status: v0.2.** The engine core is complete and heavily tested. The public
> API surface (`parseProgram` / `check` / `render` / `serializeProgram` /
> `loadCheckedAst` / `extractAccessPlan`) is stable in intent but not yet
> covered by a semver stability promise — that lands with the normative spec at
> v1.0. See [Known gaps](#known-gaps-honest-list).

## Install

```sh
npm install @orbitlang/core
```

## Quickstart

The host declares an object model, Orbit parses and type-checks the template
against it, and the interpreter renders it with escaping and budgets applied.
The example below is a complete, runnable program.

```ts
import {
  check,
  formatDiagnostic,
  parseProgram,
  render,
  t,
  TypeRegistry,
} from '@orbitlang/core';

// 1. Declare the object model. Templates can see nothing else.
const registry = new TypeRegistry();
registry.defineObject('Product', {
  title: t.string(),
  url: t.url(),
  vendor: t.optional(t.string()),
});

// 2. The template. Frontmatter declares what this file is.
const files = [
  {
    name: 'pages/product.orbit',
    source: [
      '---',
      'page product',
      '---',
      '<article class="product">',
      '  <h1>{product.title}</h1>',
      '  <p><a href={product.url}>{product.vendor ?? "House brand"}</a></p>',
      '</article>',
    ].join('\n'),
  },
];

// 3. Parse. Structural caps are enforced while the AST is built.
const parsed = parseProgram(files);
if (!parsed.ok) {
  throw new Error(parsed.diagnostics.map(formatDiagnostic).join('\n'));
}

// 4. Type-check against the declared model.
const checked = check(parsed.program, {
  registry,
  pageGlobals: { product: t.object('Product') },
});
const errors = checked.diagnostics.filter((d) => d.severity === 'error');
if (errors.length > 0) {
  throw new Error(errors.map(formatDiagnostic).join('\n'));
}

// 5. Render. Hostile data included on purpose.
const result = render(parsed.program, 'product', {
  bindings: {
    product: {
      title: 'Aurora <Runner>',
      url: 'javascript:alert(1)',
      vendor: null,
    },
  },
});

if (result.ok) {
  console.log(result.html);
  // <article class="product"><h1>Aurora &lt;Runner&gt;</h1>
  //   <p><a href="#">House brand</a></p></article>          (one line, no gaps)

  console.log(result.warnings);
  // [{
  //   code: 'O4900',
  //   message: 'blocked unsafe URL in href: scheme "javascript" is not allowed',
  //   template: 'product', line: 6, col: 6,
  // }]
}
```

Two things happened without the template author doing anything: `<Runner>` was
escaped for the TEXT context, and `javascript:alert(1)` was neutralized at the
URL sink — not because a `Url` type said so, but because every URL attribute is
sanitized where it is written, and the block was surfaced as a coded, spanned
warning rather than silently swallowed. If a soft fallback is the wrong answer
for your deployment, pass `urlPolicy: 'error'` and a blocked URL fails the render
instead — a blocked URL almost always means the *data* is wrong, and a silent
`#` hides that for months.

### The optional law, as a compile error

Drop the `?? "House brand"` fallback and the render never happens:

```
error[O2104]: optional value used without a fallback (`String?`) — decide what happens when it is absent
  --> product:6:28
 help: use {product.vendor ?? ""} or wrap in <if {product.vendor != none}>
```

There is no truthiness in Orbit. `<if>` takes a `Bool` and nothing else, and an
optional must be given a fallback or narrowed (`x != none` in the guarding
`<if>`; `||` deliberately does not narrow). Blank-page bugs from `null` are not
representable.

### Knowing what to fetch, before rendering

Because there is no dynamic member access, every path a template can read is
spelled out in the AST — so the exact data set is extractable statically:

```ts
import { extractAccessPlan } from '@orbitlang/core';

extractAccessPlan(parsed.program, 'product');
// { paths: ['product', 'product.title', 'product.url', 'product.vendor'] }
```

Hosts use this to batch-fetch exactly what a page needs (declare-then-fetch)
instead of resolving fields lazily during rendering.

## Pipeline

```
parseProgram(files)        → Program (structural caps enforced AT CONSTRUCTION)
check(program, {registry, hostFilters, pageGlobals})
                           → diagnostics with spans + fix-its (never throws)
serializeProgram(program)  → plain-JSON AST for storage
loadCheckedAst(json, {trust: 'verify'})
                           → structural re-validation, then Program
render(program, entry, {bindings, hostFilters, settings, fuel, deadlineMs, now})
                           → { ok, html, warnings } | { ok: false, error, warnings }
extractAccessPlan(program, entry)
                           → exact data paths the render touches
```

Compiling and rendering are separate on purpose: an AST is checked once, stored,
and rendered many times — and re-validated structurally on the way back in, so a
tampered row in your template store cannot smuggle in a construct the parser
would have refused.

## Security invariants (engine-enforced, tested)

Every claim below is mapped to the test that substantiates it in
[`docs/compliance/claims.md`](./docs/compliance/claims.md), and CI fails if a
claim loses its evidence.

- **Escaping contexts are assigned structurally**, never inferred from the data:
  TEXT, RCDATA (`<title>`/`<textarea>`), ATTR, URL-ATTR, JSON-LD. The sixth
  context, RAWTEXT, is **unreachable by construction** — `<script>` and
  `<style>` are not in the element allowlist at all, and interpolation inside a
  `style` attribute is a parse error, so no code path can emit into one.
- **Closed allowlists** for elements (94), attributes, and URL-bearing
  attributes. Anything absent is rejected; `on*` handlers, `srcdoc`, `ping`,
  legacy URL attributes and namespaced (`xlink:*`, `xml:*`) attributes are
  rejected by name with a dedicated message. No dynamic attribute names, no
  attribute spread.
- **URL sanitization happens at the sink**, and is never trusted from the `Url`
  type: C0 control characters and DEL are stripped first (so `java&#9;script:`
  splits do not survive), then a scheme allowlist of http/https/mailto/tel plus
  site-relative, `./`, `../`, `?query` and `#anchor`. Protocol-relative `//` is
  rejected; `data:` is allowed only as `data:image/*` and only in `src`.
- **Terminal branded types.** `Html` renders only as element content — never a
  prop, binding, operand, attribute or RCDATA value — and is **not
  host-declarable**: the only producers are host filters explicitly flagged
  `unsafeHtml: true`, which the checker warns about at every use site. `Money`
  admits no operators, no properties, no rendering and no stdlib filters.
  `MoneyText` renders but admits no filters. `Image` is host-filter input only.
- **No truthiness and the optional law.** `<if>` requires `Bool`. Using `T?`
  without `??` or flow-narrowing is a compile error carrying a fix-it.
- **Budgets.** Byte-charged global fuel, ONE global iteration counter threaded
  through component calls and slot expansion (so a nested component cannot reset
  it), a wall-clock deadline read from an injectable clock, an output-size cap,
  and per-value caps (string ≤ 256 KiB, list ≤ 5,000 items) re-checked at every
  filter step so amplification is caught mid-pipeline rather than after
  allocation. Tripping a cap **fails the render** with template/line/col — a
  partial page is never returned. The published values are spec minimums;
  production deployments configure lower ones.
- **No regex anywhere.** Not in the stdlib, not in the lexer, not in the parser,
  not in the escaper. Every scanner is a hand-rolled linear pass, so no input can
  trigger catastrophic backtracking. This is enforced by test, not by convention.
- **Stateless interpreter, deterministic output.** No cache, no module state, no
  ambient authority; the injected clock is used only to abort, never to produce
  output. The same program plus the same data plus the same options yields
  byte-identical HTML, forever. Memoization is the host's business, not the
  engine's.
- **Stored-AST integrity.** `loadCheckedAst` re-walks the whole tree against the
  same allowlists and caps the parser used. The deliberately ugly
  `unsafe_loadTrustedAst` skips that and exists so misuse is visible in code
  review. Any cryptographic binding of stored ASTs (e.g. an HMAC over
  `(tenant, version, ast_bytes)`) is host-side — the engine holds no key
  material.

Read [SECURITY.md](./SECURITY.md) for the full engine/host responsibility split,
the reporting channel, and the 90-day coordinated disclosure policy.

## What Orbit is not

These are permanent non-goals, not missing features. Requests for them are
declined by design:

- No Turing-completeness, no user-defined functions, no recursion.
- No dynamic member access (`obj[userInput]`), no method calls, no reflection.
- No raw-HTML mode, no `|safe`, no `triple-mustache` escape hatch. The only
  unescaped sink in the entire engine is a host filter that declared itself
  `unsafeHtml: true`.
- No `eval`, no `new Function`, no runtime compilation to JS.
- No regex, anywhere.

Where a template genuinely needs more power, the sanctioned answer is a typed
host filter — code the embedder wrote, reviewed and owns.

## Open engine, closed platform

Orbit is deliberately open-core-shaped. The **language and engine are open**; a
specific platform's object model and data plane are not:

| Open (this package, Apache-2.0) | Closed (a platform's own adapter) |
|---|---|
| Grammar, parser, spans, diagnostics | The platform object model / `TypeRegistry` contents |
| Type checker (optional law, terminality rules) | Platform filters: `money`, `img`, `jsonld`, `asset`, `paginate` |
| Six-context escaper + URL sink allowlist | The AccessPlan **resolver** (tenant-scoped batch fetch) |
| Stateless interpreter, fuel/iteration/deadline budgets | Render pipeline, manifests, artifact serving, signing |
| Pure stdlib (19 filters, no regex, cap-checked) | Memoization/caching of any kind (tenant-first keys) |
| `extractAccessPlan` static analysis | Settings storage + customizer wiring |

**Anyone can run Orbit anywhere** via the host interface — a `TypeRegistry`,
typed host filters, and resolved data. **Nobody can render a CommerceOS theme
without CommerceOS**, because the object model, the data plane and distribution
custody belong to the platform. That is the same split Liquid has lived under
for fifteen years, and it is why the engine can be fully open without giving the
platform away.

## Known gaps (honest list)

Fixed in v0.2: the SECURITY.md fuzz-corpus overclaim (replaced by a real
property-based suite), `extractAccessPlan` soundness holes, several runtime seam
gaps, and the packaging/identity mismatch this README used to carry.

Still open:

- **No parser error recovery.** The parser stops at the first error per file;
  multi-diagnostic output is a checker-only feature today. Code frames and
  multi-error recovery land in v0.5 — they are the prerequisite for an LSP.
- **No editor tooling yet**: no LSP, no formatter, no tree-sitter grammar, no
  playground, no docs site. All are v0.5.
- **No named filter arguments** (`img(x, widths: [...])`) — positional only.
- **`formatDate` is English-only by default** and its timezone behavior is
  caller-supplied; host-injected locale data lands in v1.0. Anything beyond that
  belongs in a host filter today.
- **Frontmatter defaults are literals only.** No `layout` frontmatter, no
  `<match>/<case>`, no `t()` locales, no whitespace control — deliberate
  deferrals, tracked as staged proposals.
- `first`/`last` take no count argument (they return `T?`).
- Whitespace collapsing keeps single boundary spaces inside mixed text runs;
  templates that need byte-exact spacing use `{" "}`.
- **No normative spec and no conformance corpus yet.** Both are v1.0, along with
  differential testing against real browser parsers. Until then the tests in
  this repository are the specification, and they validate the implementation
  against itself — which is exactly why the external oracle is on the roadmap.
- **No third-party security audit yet.** Planned for v1.0.

## Diagnostics

Every diagnostic carries a stable code, a span (line/col), and — wherever a
mechanical fix exists — a suggestion. Codes are grouped by phase:

| Range | Phase |
|---|---|
| `O1xxx` | Lexing and parsing (grammar, allowlists, structural caps) |
| `O2xxx` | Type checking (types, contracts, the optional law) |
| `O3xxx` | Type checking (truthiness law) |
| `O4xxx` | Runtime (budget trips, data-shape violations, JSON-LD) |
| `O5xxx` | Stored-AST structural validation |

## Tests

Colocated `*.test.ts`, run with [vitest](https://vitest.dev):

```sh
npm test                         # vitest run
npm run typecheck                # tsc --noEmit
node scripts/audit-claims.mjs    # every doc claim still has its evidence
```

The suite covers the parser rejection matrix, the checker law and contract
suite, per-context escaping matrices, interpreter budget trips plus determinism
and statelessness, stdlib cap behavior, stored-AST poisoning defenses, and a
byte-exact end-to-end render of a product-card plus collection page against a
fake host. Property-based tests (fast-check) cover round-tripping, escaping
oracles and budget monotonicity.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Contributions are accepted under the
Developer Certificate of Origin — `git commit -s`, no CLA. Please read the
non-goals above before proposing a language feature. Participation is governed by
the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Documents

| | |
|---|---|
| [CHANGELOG.md](./CHANGELOG.md) | What changed, per release |
| [SECURITY.md](./SECURITY.md) | Threat model, reporting channel, 90-day disclosure policy, CVE path |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Dev setup, invariants, diagnostic codes, out-of-scope list |
| [docs/compliance/claims.md](./docs/compliance/claims.md) | Every claim in these docs, mapped to its evidence |
| [docs/compliance/cra-readiness.md](./docs/compliance/cra-readiness.md) | EU Cyber Resilience Act readiness (steward status, 24/72/14 reporting, SBOM, support window) |

## License

Apache-2.0. See [LICENSE](./LICENSE).
