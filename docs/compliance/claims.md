# Claims manifest

Every capability and security claim made in [README.md](../../README.md) and
[SECURITY.md](../../SECURITY.md) is listed here with the specific test file or
shipped artifact that substantiates it.

This file is **machine-checked**. `scripts/audit-claims.mjs` runs in CI, extracts
every path in the `evidence` column, and **fails the build if any of them does
not exist**. The point is blunt: a claim in this repository cannot outlive its
evidence. If a test file is deleted or renamed, the build breaks until either the
evidence is restored or the claim is removed from the docs.

**Format.** Each row is `| claim | evidence | kind |`.

- `evidence` is a bare repo-relative path and nothing else, so it can be parsed
  mechanically. Where a specific test names the behavior, that test's name is
  quoted in the claim cell.
- `kind` is `test` when the evidence is an executable assertion, or `artifact`
  when the evidence is a shipped file whose *contents* are the claim (a closed
  table, a cap constant, a license, a policy document).

**A row is not a substitute for reading the test.** `artifact` rows in particular
prove that a file exists and is shipped, not that its contents are correct —
they carry less weight than `test` rows, and they are used only where the claim
is genuinely about the existence and content of a file.

## Escaping

| claim | evidence | kind |
|---|---|---|
| Six escaping contexts exist and are enumerated (TEXT, RCDATA, ATTR, URL-ATTR, JSON-LD, RAWTEXT) | src/escape.ts | artifact |
| TEXT context escapes `&`, `<`, `>` and leaves quotes alone — "escapes & < > and leaves quotes alone" | src/escape.test.ts | test |
| RCDATA context escapes `&` and `<` (character references are decoded in RCDATA) — "escapes & and < (character references are decoded in RCDATA)" | src/escape.test.ts | test |
| ATTR context escapes `&`, `"`, `<`, `>` — "escapes & \" < >" | src/escape.test.ts | test |
| An attribute breakout attempt stays inert inside double quotes — "breakout attempt stays inert inside double quotes" | src/escape.test.ts | test |
| JSON-LD escapes `</script>`, `<!--`, `&` and JS line separators as `\uXXXX` — "escapes </script>, <!--, & and JS line separators as \\uXXXX" | src/escape.test.ts | test |
| JSON-LD admits primitives, records and lists only; rejects Html values, non-finite numbers and over-deep nesting — "rejects Html values, non-finite numbers and over-deep nesting" | src/escape.test.ts | test |
| Escaping contexts are assigned structurally at render time, per interpolation site — "escapes text, attributes and RCDATA per context" | src/interpreter.test.ts | test |
| JSON-LD output flows through the escaping serializer at render time — "emits json-ld through the escaping serializer" | src/interpreter.test.ts | test |
| RAWTEXT is unreachable by construction: `<script>` and `<style>` are absent from the element allowlist and named in the banned table | src/allowlists.ts | artifact |
| `<script>` and `<style>` are rejected at parse time | src/parser.test.ts | test |
| Interpolation inside a `style` attribute is a parse error — "rejects any interpolation inside style" | src/parser.test.ts | test |
| Static `style` attributes are permitted as text only — "allows static style attributes" | src/parser.test.ts | test |
| RCDATA elements preserve text exactly and treat nested tags as text — "treats nested tags as text" | src/parser.test.ts | test |
| The one unescaped sink is an `unsafeHtml` host filter's output — "renders Html host-filter output raw (the one unescaped sink)" | src/interpreter.test.ts | test |
| End-to-end render is byte-exact with escaping applied across contexts — "renders byte-exact HTML with escaping, slots, settings and URL defense" | src/e2e.test.ts | test |

## Allowlists

| claim | evidence | kind |
|---|---|---|
| The element allowlist is closed and contains 94 elements; the banned table names 16 with dedicated reasons | src/allowlists.ts | artifact |
| Unknown elements are rejected at parse time with `O1081` — "rejects unknown elements with O1081" | src/parser.test.ts | test |
| The attribute allowlist is closed; `data-*` and `aria-*` are the only open families | src/allowlists.ts | artifact |
| `on*` handlers, `srcdoc`, `ping` and namespaced attribute names are rejected — "rejects on* handlers, srcdoc, ping and namespaced names" | src/parser.test.ts | test |
| Attributes outside the allowlist are rejected; `data-*`/`aria-*` are allowed — "rejects attributes outside the allowlist, allows data-*/aria-*" | src/parser.test.ts | test |
| URL-bearing attributes are a closed table, marked statically at parse time — "marks URL attributes statically" | src/parser.test.ts | test |
| Attribute values must be quoted or expressions; single quotes are rejected — "requires quoted or expression values; no single quotes" | src/parser.test.ts | test |
| Duplicate attributes are rejected — "rejects duplicate attributes" | src/parser.test.ts | test |
| The HTML tree is strict: explicit closing tags required, unescaped `<` in text rejected with a fix-it — "rejects unescaped < in text with a fix-it" | src/parser.test.ts | test |

## URL sanitization

| claim | evidence | kind |
|---|---|---|
| Sanitization happens at the sink and is never trusted from the `Url` type | src/escape.ts | artifact |
| http/https/mailto/tel, site-relative, `./`, `../`, `?query` and `#anchor` are allowed — "allows http/https/mailto/tel/relative/#/?" | src/escape.test.ts | test |
| `javascript:`, case tricks and control-character splits are blocked — "blocks javascript:, case tricks and control-char splits" | src/escape.test.ts | test |
| Protocol-relative `//` is rejected — "blocks protocol-relative //" | src/escape.test.ts | test |
| `data:` is allowed only as `data:image/*` and only in `src` — "data: only as data:image/* and only in src" | src/escape.test.ts | test |
| C0 control characters and DEL are stripped before scheme analysis — "strips control characters everywhere and trims spaces" | src/escape.test.ts | test |
| A blocked URL emits `#` and records a structured warning rather than failing silently — "blocks unsafe URLs at the sink, emits # and records a STRUCTURED warning" | src/interpreter.test.ts | test |
| Hostile `javascript:` data in a real page render is neutralized end-to-end — "renders byte-exact HTML with escaping, slots, settings and URL defense" | src/e2e.test.ts | test |
| URL attributes accept `Url` and `String` but not `Int` — "URL attributes accept Url and String, not Int" | src/checker.test.ts | test |

## Budgets and termination

| claim | evidence | kind |
|---|---|---|
| Every cap has a single declared value: fuel, iterations, deadline, output, per-value string/list caps, structural caps | src/limits.ts | artifact |
| Fuel exhaustion trips `O4001` and fails the render — "fuel exhaustion trips O4001" | src/interpreter.test.ts | test |
| The iteration counter is GLOBAL across component boundaries — "the iteration counter is GLOBAL across component boundaries (W-06)" | src/interpreter.test.ts | test |
| The wall-clock deadline trips `O4003` via the injected clock — "wall-clock deadline trips O4003 via the injected clock" | src/interpreter.test.ts | test |
| The output cap trips `O4004` — "output cap trips O4004" | src/interpreter.test.ts | test |
| A cap trip fails the render with template/line/col; a partial page is never returned — "fuel exhaustion trips O4001" | src/interpreter.test.ts | test |
| Per-value caps are re-checked at every intermediate filter step, not only at the end — "replace amplification trips the string cap before allocating unbounded output" | src/stdlib.test.ts | test |
| List-cardinality amplification trips the list cap — "split cardinality trips the list cap" | src/stdlib.test.ts | test |
| Join output trips the string cap — "join output trips the string cap" | src/stdlib.test.ts | test |
| Loop `limit` must be a compile-time literal within the cap — "limit must be a literal within the cap" | src/checker.test.ts | test |
| Range bounds must be literal ints and span no more than the loop cap — "range bounds must be literal ints and span <= the loop cap" | src/checker.test.ts | test |
| Structural caps are enforced AT CONSTRUCTION, while parsing — "enforces the element depth cap at construction" | src/parser.test.ts | test |
| Expression depth is capped at parse time — "rejects overly deep expressions" | src/parser.test.ts | test |
| Division by zero is a render error, never `Infinity` in the output — "division by zero is a render error, not Infinity in the output" | src/interpreter.test.ts | test |

## Determinism and statelessness

| claim | evidence | kind |
|---|---|---|
| Same program + data + options produces byte-identical output — "same program + data + options => byte-identical output" | src/interpreter.test.ts | test |
| Back-to-back renders for different tenants share no state — "back-to-back renders for different stores share no state" | src/interpreter.test.ts | test |
| Determinism holds byte-for-byte across repeated renders of a full page — "is deterministic byte-for-byte across repeated renders" | src/e2e.test.ts | test |
| The injected clock affects abort decisions only, never output bytes — "wall-clock deadline trips O4003 via the injected clock" | src/interpreter.test.ts | test |
| Data that violates the declared types fails loudly with `O4012` and never renders blanks — "data violating declared types fails loudly (O4012), never renders blanks" | src/interpreter.test.ts | test |
| Invalid merchant settings fall back to declared defaults with a warning — "falls back to declared defaults on invalid values, with a structured warning" | src/interpreter.test.ts | test |

## Stored-AST integrity

| claim | evidence | kind |
|---|---|---|
| `loadCheckedAst` re-walks stored ASTs against the same allowlists and caps the parser enforces | src/validate-ast.ts | artifact |
| A serialize → store → load round trip renders byte-identically — "renders byte-identically after the round trip" | src/validate-ast.test.ts | test |
| An injected `<script>` element is rejected even though the parser could never produce one — "rejects an injected <script> element even though the parser could never produce one" | src/validate-ast.test.ts | test |
| Unknown node kinds and unknown expression kinds are rejected — "rejects unknown node kinds and unknown expression kinds" | src/validate-ast.test.ts | test |
| Event-handler attributes and over-cap loop limits are rejected on load — "rejects event-handler attributes and over-cap loop limits" | src/validate-ast.test.ts | test |
| Rawtext content and non-void content mismatches are rejected on load — "rejects rawtext content and non-void content mismatches" | src/validate-ast.test.ts | test |
| Wrong format versions and empty roots are rejected — "rejects wrong format versions and empty roots" | src/validate-ast.test.ts | test |
| `unsafe_loadTrustedAst` skips validation by design and is named so misuse is visible — "skips structural validation by design — the name is the warning" | src/validate-ast.test.ts | test |
| The engine holds no key material; any HMAC binding of stored ASTs is host-side | src/validate-ast.ts | artifact |

## The type system: the optional law, no truthiness, terminality

| claim | evidence | kind |
|---|---|---|
| Interpolating an optional without a fallback is a compile error (`O2104`) — "rejects interpolating an optional without a fallback" | src/checker.test.ts | test |
| `??` satisfies the optional law — "?? satisfies the law" | src/checker.test.ts | test |
| Flow-narrowing via `!= none` satisfies the optional law — "flow-narrowing via != none satisfies the law" | src/checker.test.ts | test |
| Narrowing propagates through `&&` to the right operand and the body — "narrowing propagates through && to the right operand and body" | src/checker.test.ts | test |
| Logical-or deliberately does NOT narrow an optional — "does NOT narrow (escape attempt)" | src/checker.test.ts | test |
| `?.` produces an optional that still needs a fallback at the sink — "?. produces an optional that still needs a fallback at the sink" | src/checker.test.ts | test |
| Optionals cannot flow into filters or arithmetic — "optionals cannot flow into filters or arithmetic" | src/checker.test.ts | test |
| List indexing is optional, because out-of-range is `none` — "list indexing is optional (out-of-range is none)" | src/checker.test.ts | test |
| There is no truthiness: `<if>` rejects non-`Bool` conditions (`O3007`) — "rejects non-Bool <if> conditions" | src/checker.test.ts | test |
| Optional conditions are rejected with a `!= none` fix-it — "rejects optional conditions with a != none fix-it" | src/checker.test.ts | test |
| Logical-and and logical-or require `Bool` on both sides — "requires Bool on both sides" | src/checker.test.ts | test |
| `Html` renders only in element content, with a warning at the unsafe filter — "renders only in element content, with a warning at the unsafe filter" | src/checker.test.ts | test |
| `Html` is never permitted in attributes, bindings, filters, props or RCDATA — "never in attributes, bindings, filters, props or RCDATA" | src/checker.test.ts | test |
| `Html` is engine-owned and not host-declarable; `TypeRegistry.defineObject` refuses the name | src/types.ts | artifact |
| Host filters returning `Html` must be flagged `unsafeHtml: true`; `Html` may never be a host-filter parameter type | src/host.ts | artifact |
| `Money` cannot render, has no properties and admits no operators — "Money cannot render, has no properties, admits no operators" | src/checker.test.ts | test |
| `Money` cannot reach stdlib filters, only declared host filters — "Money cannot reach stdlib filters, only declared host filters" | src/checker.test.ts | test |
| `MoneyText` renders (including in attributes) but admits no filters — "MoneyText renders (incl. attributes) but admits no filters" | src/checker.test.ts | test |
| `Image` is opaque: never rendered, only host-filter input — "Image is opaque: never rendered, only host-filter input" | src/checker.test.ts | test |
| JSON-LD rejects `Money`, `MoneyText`, `Html` and nominal objects at type level — "rejects Money, MoneyText, Html and nominal objects at type level" | src/checker.test.ts | test |
| There is no string concatenation via `+` — "no string concatenation via +" | src/checker.test.ts | test |
| Component contracts are enforced: required props, unknown props, types — "checks required props, unknown props and types" | src/checker.test.ts | test |
| Slot contracts are enforced: required, undeclared, no-default — "enforces slot contracts: required, undeclared, no-default" | src/checker.test.ts | test |
| Component cycles are detected and pages are unreachable as components — "pages are unreachable as components (lowercase = element namespace) and cycles are detected" | src/checker.test.ts | test |

## Non-Turing-completeness and no dynamic access

| claim | evidence | kind |
|---|---|---|
| Dynamic member access with a string index is rejected — "rejects dynamic member access with a string index" | src/parser.test.ts | test |
| Only `list[intExpr]` indexing is permitted — "allows list[intExpr] indexing" | src/parser.test.ts | test |
| Method calls are rejected, with a pipe fix-it — "rejects method calls with a pipe fix-it" | src/parser.test.ts | test |
| `extractAccessPlan` recovers the exact data paths a render touches — "extracts the exact AccessPlan the render touches (declare-then-fetch)" | src/e2e.test.ts | test |
| Access-plan soundness rests on the absence of dynamic member access | src/host.ts | artifact |

## No regex

| claim | evidence | kind |
|---|---|---|
| Stdlib filter implementations contain no `RegExp` and no `.match(` usage — "stdlib implementations contain no RegExp usage" | src/stdlib.test.ts | test |
| The expression lexer is a hand-rolled scanner with no regex | src/lexer.ts | artifact |
| The template parser is a hand-rolled scanner with no regex | src/parser.ts | artifact |
| Every escaping function is a single linear character pass with no regex | src/escape.ts | artifact |
| `replace` is literal (no patterns) and linear — "replace is literal (no patterns) and linear" | src/stdlib.test.ts | test |
| `slugify` is a linear character walk — "slugify is a linear char walk" | src/stdlib.test.ts | test |

## Property-based testing

These suites substantiate the "Property-based tests" paragraph in SECURITY.md
and the corresponding line in the README test section. They are randomized
generators over templates, data and budgets — not a coverage-guided fuzzing
corpus, which does not exist (see "Claims deliberately NOT listed here").

| claim | evidence | kind |
|---|---|---|
| No data value, whatever its bytes, can introduce markup: the rendered tag count is fixed by the template — "keeps the tag count fixed no matter what the data contains" | src/escaping.property.test.ts | test |
| Data can never close an attribute value — "never lets data close an attribute value" | src/escaping.property.test.ts | test |
| The element-content sink is lossless: escaped output decodes back to the exact input — "round-trips the data through the element-content sink" | src/escaping.property.test.ts | test |
| `escapeText` emits no markup-significant character and loses nothing — "escapeText emits no markup-significant character and loses nothing" | src/escaping.property.test.ts | test |
| `escapeAttr` is safe in both single- and double-quoted contexts — "escapeAttr is safe in both single- and double-quoted contexts" | src/escaping.property.test.ts | test |
| `escapeRcdata` cannot close its element or start a tag — "escapeRcdata cannot close its element or start a tag" | src/escaping.property.test.ts | test |
| Rendering is deterministic: identical input yields byte-identical output — "renders deterministically: identical input, byte-identical output" | src/escaping.property.test.ts | test |
| parse → serialize → JSON → `loadCheckedAst` renders byte-identical HTML over generated templates — "parse → serialize → JSON → loadCheckedAst renders byte-identical HTML" | src/roundtrip.property.test.ts | test |
| Serialisation is a fixed point: reserialising a reloaded program reproduces the wire form — "is a fixed point: serializing a reloaded program reproduces the wire form" | src/roundtrip.property.test.ts | test |
| Repeated store/load trips introduce no drift — "survives repeated trips without drift" | src/roundtrip.property.test.ts | test |
| The verifying loader accepts every well-typed generated program — "accepts every generated program through the verifying loader" | src/roundtrip.property.test.ts | test |
| Parsing is deterministic: the same source yields identical wire bytes — "parses deterministically: same source, identical wire bytes" | src/roundtrip.property.test.ts | test |
| `render` always returns a well-formed result under any budget and never throws — "always returns a well-formed result, never throws" | src/budgets.property.test.ts | test |
| Fuel is monotone: once a render succeeds, more fuel never breaks it or changes the bytes — "fuel: once a render succeeds, more fuel never breaks it or changes bytes" | src/budgets.property.test.ts | test |
| The iteration-budget success set is upward-closed — "iterations: the success set is upward-closed" | src/budgets.property.test.ts | test |
| The output-cap success set is upward-closed — "output cap: the success set is upward-closed" | src/budgets.property.test.ts | test |
| At a fixed budget, more work never succeeds where less work failed — "more work never succeeds where less work failed, at a fixed budget" | src/budgets.property.test.ts | test |
| A successful render never exceeds its output cap — "a successful render never exceeds its output cap" | src/budgets.property.test.ts | test |
| A loop wider than the iteration budget always fails with `O4002` — "a loop wider than the iteration budget always fails with O4002" | src/budgets.property.test.ts | test |
| The injected clock only ever aborts a render; it never reaches the output — "the deadline aborts rather than truncating, using the injected clock" | src/budgets.property.test.ts | test |

## Stdlib and host seam

| claim | evidence | kind |
|---|---|---|
| The stdlib is exactly 19 pure filters and contains nothing platform-bound — "ships the documented pure filters and nothing platform-bound" | src/stdlib.test.ts | test |
| `sortBy` is stable with nulls last; `where` filters by equality — "sortBy is stable, nulls last; where filters by equality" | src/stdlib.test.ts | test |
| `formatDate` uses host-injected locale data and no `Date` object — "uses injected month names" | src/stdlib.test.ts | test |
| `formatDate` fails loudly on non-ISO input rather than guessing — "fails loudly on non-ISO input" | src/stdlib.test.ts | test |
| Host filters are validated as a host programming error, not a template diagnostic | src/host.ts | artifact |
| The public API surface is exactly the documented pipeline plus its types | src/index.ts | artifact |

## Diagnostics

| claim | evidence | kind |
|---|---|---|
| Diagnostics carry stable codes, spans (line/col) and suggestions where a mechanical fix exists — "parse errors carry line/col and a suggestion where available" | src/parser.test.ts | test |
| Lexer errors carry line/col spans — "carries line/col spans" | src/lexer.test.ts | test |
| Unknown names carry did-you-mean suggestions — "did-you-mean on properties" | src/checker.test.ts | test |
| Diagnostic formatting is stable and includes location plus help text | src/diagnostics.ts | artifact |
| Diagnostic code ranges are `O1xxx` parse / `O2xxx`–`O3xxx` check / `O4xxx` runtime / `O5xxx` stored-AST | CONTRIBUTING.md | artifact |
| The code frame renders a source excerpt with a caret run spanning the whole diagnostic — "puts the caret under the exact span, not just its start" | src/codeframe.test.ts | test |
| Caret alignment survives tabs and East-Asian wide glyphs — "expands tabs so the caret still lands under the right character", "keeps wide characters aligned" | src/codeframe.test.ts | test |
| CRLF files produce the same line numbers as LF files — "numbers CRLF files identically to LF and drops the \r for display" | src/codeframe.test.ts | test |
| ANSI colour is opt-in; output is plain text by default — "emits no ANSI escapes by default and escapes only when asked" | src/codeframe.test.ts | test |
| A diagnostic whose source text is unavailable degrades to location-only rather than being dropped — "degrades a diagnostic to location-only rather than dropping it when its source is missing" | src/codeframe.test.ts | test |
| The error-code index is generated from the source, not hand-maintained, and CI can fail on drift | scripts/gen-error-index.mjs | artifact |

## Parse error recovery

| claim | evidence | kind |
|---|---|---|
| One parse pass reports every independent error in a file, not only the first — "reports every independent error in one pass, not just the first" | src/recovery.test.ts | test |
| Recovered diagnostics are reported in source order — "reports diagnostics in source order" | src/recovery.test.ts | test |
| The first diagnostic is unchanged from fail-fast behaviour — "reports the same first diagnostic a fail-fast parser would have" | src/recovery.test.ts | test |
| Cascading diagnostics are suppressed: the closer of an already-rejected element is not reported again — "does not report the closing tag of an element it already rejected" | src/recovery.test.ts | test |
| Genuinely stray closing tags are still reported — "still reports a genuinely stray closing tag" | src/recovery.test.ts | test |
| Recovery is bounded by `LIMITS.maxParseErrorsPerTemplate` — "caps the number of recovered errors instead of working without bound" | src/recovery.test.ts | test |
| A template that needed recovery is never returned to a caller and cannot be serialized or rendered — "never returns a template when any error was recovered", "never yields a program a caller could serialize or render" | src/recovery.test.ts | test |
| Damaged frontmatter fails the file outright rather than inventing body diagnostics — "fails the whole file when frontmatter is damaged, without inventing body errors" | src/recovery.test.ts | test |
| Recovery always terminates and makes forward progress, including on adversarial input — "makes forward progress on adversarial input" | src/recovery.test.ts | test |
| Every recovered diagnostic carries a span the code frame can render — "never emits a diagnostic without a span" | src/recovery.test.ts | test |

## Editor tooling

| claim | evidence | kind |
|---|---|---|
| The tree-sitter grammar parses every shipped example with no ERROR or MISSING nodes, and every highlight query compiles | tree-sitter-orbit/verify.mjs | artifact |
| The TextMate grammar's regexes all compile, every include resolves and no repository key is orphaned | editors/vscode/validate-grammar.mjs | artifact |
| Every shipped example parses and typechecks with zero error diagnostics | examples/examples.test.mjs | test |

## Packaging and process

| claim | evidence | kind |
|---|---|---|
| Zero runtime dependencies (no `dependencies` field; only devDependencies) | package.json | artifact |
| The engine performs no I/O: the main tsconfig sets `"types": []` and omits the DOM lib | tsconfig.json | artifact |
| Licensed under Apache-2.0 | LICENSE | artifact |
| A private vulnerability reporting channel, 72h acknowledgement target and 90-day coordinated disclosure policy are published | SECURITY.md | artifact |
| A CVE is requested via GitHub Security Advisories (a CNA) for any confirmed vulnerability | SECURITY.md | artifact |
| In-scope and out-of-scope categories for security reports are published | SECURITY.md | artifact |
| CRA open-source-steward status, the 24h/72h/14-day reporting workflow and the support window are documented | docs/compliance/cra-readiness.md | artifact |
| Contributions are accepted under the DCO with `git commit -s`, and no CLA is required | CONTRIBUTING.md | artifact |
| Pull requests carry a DCO and invariants checklist | .github/PULL_REQUEST_TEMPLATE.md | artifact |
| Language-feature requests are evaluated against the published non-goals | .github/ISSUE_TEMPLATE/feature_request.md | artifact |
| The project operates under Contributor Covenant 2.1 | CODE_OF_CONDUCT.md | artifact |
| Known gaps are published rather than omitted | README.md | artifact |
| CI runs the test suite, `tsc --noEmit`, a DCO sign-off check and this claims audit on every pull request | .github/workflows/ci.yml | workflow |
| An OpenSSF Scorecard run is wired into CI | .github/workflows/scorecard.yml | workflow |
| A CycloneDX SBOM is generated per release and attached to the GitHub release | .github/workflows/release.yml | workflow |
| The SBOM generator is first-party and dependency-free | scripts/sbom.mjs | artifact |
| npm publishing uses trusted publishing (OIDC) with provenance attestations | .github/workflows/release.yml | workflow |
| This claims manifest is enforced by a CI script that fails the build on missing evidence | scripts/audit-claims.mjs | artifact |
| The claims-audit script is itself tested | scripts/audit-claims.test.mjs | test |

## Claims deliberately NOT listed here

Some things this project will claim later are absent on purpose, because the
evidence does not exist yet and a row here would be exactly the kind of overclaim
this file was created to prevent:

- **Coverage-guided fuzzing corpus** — does not exist. SECURITY.md says so
  explicitly. Property-based tests are not the same thing.
- **Conformance suite** — planned for v1.0, not shipped.
- **Third-party security audit** — planned for v1.0, not performed.
- **Browser-differential escaping oracle** — planned for v1.0, not built.
- **Reproducible performance benchmark** — planned for v1.0. There are no
  performance claims anywhere in the docs, precisely because there is no harness.

### Rows pending in this milestone

None. Rows are added to the tables above **by the pull request that lands the
file**, never in advance — a row must never be written before its evidence
exists, or the audit gate is worthless.

The one entry that stood here through most of v0.2 was `src/*.property.test.ts`.
Those suites have since landed (`escaping`, `roundtrip`, `budgets`) and their
rows are in the "Property-based testing" section above, so the paragraph in
SECURITY.md and the line in the README test section are now backed by evidence
the audit gate checks.
