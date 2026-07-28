# Changelog

All notable changes to `@orbitlang/core` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Pre-1.0 note.** Until v1.0 the semver promise is limited: escaping and
resource-cap behavior may be **tightened in a patch release**, and such a
tightening can change output bytes. Diagnostic codes, once shipped, are already
treated as permanent. The full stability policy — covering syntax, output bytes,
error codes and the access-plan format — lands with the normative specification
at v1.0.

## [Unreleased]

### Server islands (Phase E0)

#### Added

- **`<Component defer/>`** renders a component in a SECOND pass. The engine
  emits an inert placeholder — `<orbit-island data-island="i0">` with the call's
  children as fallback — and returns an island manifest: id, component, the
  props resolved in this pass, and the paths that component reads. Transport,
  signing and caching policy stay with the host.
  The reason is caching, not interactivity: a personalized cart badge in a
  shared header otherwise puts its paths into every page's access plan, and a
  page whose plan contains personalized data cannot be cached for anyone.
- **A required prop a deferred call omits is host-resolved, not missing.** This
  is what makes the feature do anything: an island whose every input came from
  the page would take nothing out of the page's plan, because the page already
  had to fetch it. Those props are what the island's own plan is rooted at.
- **`AccessPlan` gained `islands`** and `paths` now covers the first pass only.
  Deferring never adds a path to the page plan, and no path is in both — a
  property test asserts both.
- **`LIMITS.defaultIslandFuel` and `LIMITS.maxIslandsPerRender`.** Each pass has
  its own budget; an island does not draw on the page's, because the two are
  separate requests and a shared budget would let a slow island shrink a page
  that was already sent.
- Diagnostics: `O1112` (`defer` is a bare marker), `O2112` (no `Html` prop —
  an `Html` value carries its trust obligation and serializing discards it),
  `O2113` (islands do not nest at any depth), `O2114` (no slot fills — a fill is
  markup in the caller's scope, and the caller is gone), `O4042` (island cap).
- Conformance category `server-islands`, with the placeholder shape specified in
  prose in `conformance/README.md`.

**Breaking for embedders.** `RenderResult` gained `islands`, and `AccessPlan`
gained `islands` with `paths` narrowed to the first pass.

### The closed-world falsification (Phase D)

- **[docs/evaluation/closed-world.md](docs/evaluation/closed-world.md)** — 17.2%
  of a real platform's theme functionality cannot be expressed in Orbit as it
  stands; 23–27% per individual theme. Measured against the CommerceOS block
  registry (116 blocks, 34 modules, 9,519 lines) and tested by porting Aurora's
  home and product pages to Orbit in `evaluation/aurora/`, where they compile,
  render and format-check on every CI run.
- The premise holds for content and breaks for commerce interaction. 93% of the
  registry needs no client JavaScript. What fails is the header, the product
  grid and the buy box — every page of every theme.
- Two follow-ups, neither of which is an escape hatch: platform islands (started
  above), and a typed custom-property sink for per-instance `Color` settings,
  which has no plan behind it yet.

### Language: match, named arguments, versions (Phase B)

#### Added

- **`<match>` / `<case>`** with exhaustiveness over string-literal unions. Every
  variant needs an arm, and a union scrutinee may NOT have a default: a default
  absorbs variants added later, which is exactly the check's purpose. A plain
  `String` requires one, having no closed set to check against.
  Diagnostics `O1107`–`O1111`, `O2107`–`O2111`, `O4040`–`O4041`.
- **Named filter arguments.** A host filter's optional parameters carry names,
  and a call site may pass them by name in any order:
  `imgUrl(product.cover, 800, crop: "face")`. Positional order was the thing
  that rotted. Diagnostics `O1102`, `O2105`, `O2106`.
- **`orbit <version>` frontmatter pragma** versions the LANGUAGE separately from
  the package. An engine rejects a version it does not implement rather than
  rendering it under whatever rules it happens to have, and a stored AST carries
  its version. Diagnostics `O1104`–`O1106`.
- **`on:*` and `@*` attribute forms are reserved** (`O1103`) so a future
  reactive syntax cannot collide with attribute names already in the wild.
- **Comments are AST nodes.** `orbit fmt` previously deleted every comment in a
  file, silently, because the parser discarded them and no test noticed — a
  comment changes no rendered byte.

#### Changed

- **`HostFilterDecl.optionalParams` is now `{ name, type }[]`.** Breaking for
  embedders; nothing is published to npm.
- **Three diagnostic codes were reassigned.** `O1096`, `O1097` and `O1037` had
  each acquired a second, unrelated meaning while this work landed, which
  STABILITY.md forbids and the spec states as a MUST NOT. The new diagnostics
  moved to `O1103`–`O1106`, and `scripts/gen-error-index.mjs` now pins the set
  of codes that legitimately raise more than one message — a code acquiring a
  second meaning fails the build rather than hiding under one authored note.

#### Fixed

- The language server no longer reports unknown-filter and signature errors for
  host filters it has no declarations for, and no longer advertises
  `replace(s, from: String, to: String)` in completions — the colon now makes
  that a real call, and one the checker rejects.

### Html trust model (Phase A)

**Breaking for embedders.** `HostFilterDecl.unsafeHtml` is replaced by three
flags, and `unsafeHtmlValue` is renamed `htmlValue`. Nothing has been published
to npm, so no deprecation alias is carried.

#### Changed

- **One flag became three.** An `Html`-returning host filter now declares
  exactly one of `sanitizer`, `trustedHtml` or `htmlTransform`. The old single
  flag conflated two different risks and answered both with a warning: a filter
  that sanitizes untrusted input is the sanctioned path and should be silent,
  while a filter passing through markup the host decided to trust is the one a
  reviewer must actually look at. Warning on both trained everyone to ignore the
  warning.
- **Only `trustedHtml` warns** — `O2071` at check time, `O4902` at render time.
  A theme calling a sanitizer at fifty sites now produces zero warnings. The
  `O2071` hint points at the filter DECLARATION, because nothing the template
  author writes can resolve it.
- **The obligation travels with the value**, so it is still known at a sink the
  value reached through a component prop.
- **README, security model, types and embedding docs corrected.** The claim that
  Orbit has no raw-HTML mode was false: `unsafeHtml` was one, and every real
  deployment ships one because product descriptions are rich text. The accurate
  and still-strong claim is that unescaped sinks are host-owned and fixed at
  embed time — a template author cannot introduce one, choose one, or opt out of
  escaping at a call site.

#### Added

- **`Html` may cross a component boundary.** It is a legal prop type on a
  component and may be passed to a prop declared `Html`, which is what makes a
  shared `<RichText content={…}/>` possible. Without it every prose site inlines
  its own sanitizer call, forcing a proliferation of narrow blessed components —
  a larger unaudited surface than one well-named filter. Nothing is loosened
  inside the callee: every sink check is keyed on the type AT the sink, so
  attributes, `<let>`, filter operands and RCDATA still reject it, and a
  property test sweeps all eleven sink positions rather than the two that are
  easy to think of.
- **`htmlTransform` filters** take `Html` as a first argument and return `Html`,
  so truncation and heading-shifting run on sanitized markup instead of forcing
  sanitization to run twice in an order the checker cannot see. The obligation is
  to preserve well-formedness — naive truncation yields `<a href="` and changes
  how everything after it parses.
- `Html?` and `List<Html>` are rejected: optionality belongs on the String
  before sanitization, where the sanitizer decides what empty input produces. The
  canonical pattern is `{(product.description ?? "") |> richtext}`.
- Conformance categories `html-accepted`, `html-rejected` and `html-prop`
  (26 cases). The corpus previously had **zero** `Html` coverage.
- LSP prop-type completion and hover, including `Html`.

#### Fixed

- **The formatter now parenthesises a pipe on the right of `??`.** `|>` binds
  tighter, so `a ?? "" |> richtext` pipes only the FALLBACK and leaves `a`
  unsanitized — and both groupings previously printed identically, so a reader
  could not tell which was in effect. Hit twice while writing this change.
- The conformance host is now defined once, in `conformance/host.mjs`, and
  imported by both the generator and the runner. The two copies drifted during
  this change and 19 cases failed against a host that no longer matched.

Two milestones landed on `main` since 0.2.0. They are documented here rather
than tagged, because tagging a release implies a published artifact and nothing
has been published to npm yet.

### v0.5 — developer experience

#### Added

- **Parser error recovery.** One pass now reports every error in a file
  instead of stopping at the first. Recovery is *not* a salvage path: a
  template that needed it is discarded whole and never reaches the checker,
  serializer or interpreter, because an AST carrying error nodes leaves a
  standing risk that some later code path treats a damaged template as
  executable. Bounded by `LIMITS.maxParseErrorsPerTemplate`; forward progress
  guaranteed by a fuzz property; cascading diagnostics suppressed, including
  the closing tag of an element already rejected.
- **Code-frame diagnostics** in the rustc/Elm tradition — source excerpt, a
  caret run spanning the whole diagnostic, the fix-it inline. Handles tab
  expansion, East-Asian wide glyphs, CRLF, long lines and tall spans. Colour is
  opt-in.
- **Canonical formatter.** One form, no options. Idempotent, AST-preserving,
  and **rendering-preserving** — a break is only legal where the parser's
  whitespace-collapsing rule makes it invisible in the output.
- **`orbit` CLI**: `check` (with `--format json`) and `fmt` (with `--check` and
  `--stdout`). `fmt` refuses to rewrite a file that does not parse.
- **Tree-sitter grammar** with 63 highlight patterns, verified against every
  shipped example, plus a **TextMate grammar** and language configuration.
- **Language server** — diagnostics, position-aware completion, hover,
  formatting. Compile-only: it never renders and never invokes a host filter.
- **VS Code extension**, deliberately thin so every editor gets the same
  features from the same server.
- **Browser playground**: a single self-contained HTML file with escaping-context
  visualization, budget meters and a sandboxed preview.
- **Documentation set** — tutorial, safety rules, templates, components, types,
  grammar, filters, limits, embedding guide, security model. Every code block is
  compiled by CI, and blocks documented as errors must actually fail.
- **LLM kit** — a system prompt and a generate → compile → repair eval harness
  with 14 tasks, each targeting a habit carried over from another template
  language. Offline provider included.
- **`llms.txt` / `llms-full.txt`**, generated from the docs with a staleness gate.

#### Fixed

- Record keys are quoted when they are not valid identifiers, so JSON-LD
  payloads like `{"@type": "Article"}` round-trip through the formatter.

### v1.0 groundwork — specification and credibility

#### Added

- **Normative specification** (`spec/SPEC.md`), RFC 2119, with stated non-goals.
- **Conformance corpus** — 620 language-agnostic JSON cases across 25
  categories, a reference runner, and a documented host contract so a second
  implementation can be verified rather than trusted.
- **Differential testing against parse5**, a real WHATWG HTML parser. The corpus
  captured its expectations from this implementation; this is the oracle it did
  not write.
- **`STABILITY.md`** — what semver covers, three API tiers, and the deliberate
  exception that a security fix may reject a previously compiling program.
- **`GOVERNANCE.md`** and a draft **`TRADEMARK.md`**.
- **Trusted Types recipe** and a **non-JavaScript embedding guide**.
- **Benchmark harness** — one scenario, one engine, no comparison table.
- **Locale injection tests and documentation** for `formatDate`, including its
  documented non-goals.

#### Known divergence

- Orbit emits U+0000 as bound; a WHATWG parser drops it in body text and
  replaces it with U+FFFD in attributes and RCDATA. Pinned per context by
  tests and documented in the spec rather than normalized away. Not a security
  issue — a NUL cannot terminate an attribute, close an element or open a tag.

## [0.2.0] - 2026-07-28

**Theme: hardening and honesty.** Nothing in this release adds expressive power
to the language. It closes runtime seams, removes claims the repository could not
back up, decides two language questions while they are still cheap to decide, and
packages the engine for 2026 distribution and EU regulatory reality.

### Added

- **Property-based test suite** (fast-check, `src/*.property.test.ts`):
  randomized generators checking invariants rather than fixed outputs — parse →
  `serializeProgram` → `loadCheckedAst` round-trip fidelity, a per-context
  escaping oracle, fuel-termination proofs, and budget monotonicity (raising a
  budget never makes a render fail earlier). This is what SECURITY.md previously
  claimed and did not have.
- **Claims manifest and CI audit gate** (`docs/compliance/claims.md`,
  `scripts/audit-claims.mjs`): every capability and security claim in README.md
  and SECURITY.md is mapped to the test file or shipped artifact that
  substantiates it, and the build fails if any listed evidence path disappears.
  A claim in this repository can no longer outlive its evidence.
- **EU Cyber Resilience Act readiness statement**
  (`docs/compliance/cra-readiness.md`): declared open-source-steward status, the
  24-hour early-warning / 72-hour notification / 14-day final-report workflow
  for actively exploited vulnerabilities including who files and to which
  channel, SBOM availability, a pointer to the coordinated disclosure policy,
  and a plain statement of the security-update support window. Reporting
  obligations begin applying 11 September 2026.
- **90-day coordinated disclosure policy and documented CVE path** in
  SECURITY.md: private reporting through GitHub Security Advisories, a 72-hour
  acknowledgement target, explicit in-scope and out-of-scope categories, a credit
  policy, and a commitment to request a CVE through GitHub as CNA for any
  confirmed vulnerability.
- **HMAC signing helper** for stored ASTs, which the validate-AST documentation
  previously referenced without shipping.
- **Structured render warnings**: warnings now carry codes and spans matching the
  diagnostic convention, and a host option makes a blocked URL fail the render
  instead of soft-falling back to `#`.
- **Runtime shape validation of component-entry props and bindings**, mirroring
  the settings-value validation path.
- **Dual ESM/CJS build**, `engines`, `sideEffects: false`, and git tags. The
  previous CJS-only build blocked Workers, Deno and browser consumers — an odd
  limitation for an engine with zero I/O.
- **CI on GitHub Actions**: tests, `tsc --noEmit`, a DCO sign-off check, the
  claims audit, an OpenSSF Scorecard run, and npm **trusted publishing (OIDC)**
  with provenance attestations. A CycloneDX SBOM is generated per release and
  published as a release asset.
- **Community scaffolding**: `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1),
  issue templates for bug reports and feature requests, and a pull-request
  template carrying a DCO and invariants checklist.
- **Documented `formatDate` limitation**: the filter is English-only by default
  and its timezone behavior is caller-supplied. Written down honestly, with host
  filters as the sanctioned interim path; host-injected locale data lands in
  v1.0.
- Test coverage for slot-in-slot nesting and `<let>` rebinding in access-plan
  extraction.

### Changed

- **README rewritten for the standalone `@orbitlang/core` identity.** The
  previous README named a package that does not exist, gave an install command
  nobody could run, described the repository as living inside a monorepo it no
  longer lives in, and cited internal ticket references meaningless to any
  outside reader. It now carries a runnable quickstart, plain-English rationale
  for every invariant, and an honest gaps list.
- **CONTRIBUTING expanded** from five lines into a real guide: development
  setup, the DCO rationale, the invariants a pull request may not break, how to
  add a test, the diagnostic-code convention, and what is permanently out of
  scope.
- **Pipe precedence decided.** `|>` previously bound tighter than `*` and `+`,
  the opposite of Elixir and F# and a documented footgun. The decision is settled
  and documented now, because after the v1.0 specification and the editions
  pragma it would become an edition-breaking change.
- **`srcset` is parsed as multi-URL candidates before sanitizing**, so each
  candidate URL is checked individually rather than the attribute being treated
  as one opaque string.
- Registries and lookup maps use null-prototype objects and are frozen, with
  regression tests keyed to the prototype-pollution classes seen in recent
  Handlebars and DOMPurify advisories.
- Published cap values remain spec minimums; production deployments are expected
  to configure lower ones. This is now stated in the docs rather than only in a
  source comment.

### Fixed

- **`extractAccessPlan` soundness**: component-entry mis-seeding and data paths
  dropped through filter applications are corrected. The v0.5 LSP completions and
  post-1.0 fragment-cache keys both depend on plan soundness, so it had to be
  trustworthy before anything was built on it.
- **Page props are no longer silently dead** — they are either supported or
  rejected with a dedicated diagnostic.
- `O1002` off-by-one in the reported span.
- Numeric-literal digit caps are enforced.
- `Range` settings validate `min <= max` and `step > 0`.
- The color-setting validator no longer accepts non-hex characters; it now
  actually checks hex digits.
- Duplicate diagnostic codes (`O2072`, `O2082` each covering two unrelated
  rules) are de-duplicated. Stable error codes are about to become documented
  API, so a code meaning two things had to go.

### Security

- **Removed an overclaim from the security policy.** SECURITY.md stated that "the
  fuzz corpus and conformance suite ship in this repository." Neither existed.
  The policy now describes exactly what exists (unit, integration and
  property-based tests) and states plainly what does not: no coverage-guided
  fuzzing corpus, no conformance suite, no third-party audit, no
  browser-differential oracle. An overclaim in the security policy of a
  security-positioned product is the worst kind of bug this project can ship, and
  the claims-audit gate exists so it cannot recur silently.
- **Host filter implementations are wrapped in try/catch** and surface as
  `OrbitRenderError` rather than escaping the engine as an arbitrary exception;
  the deadline is checked before and after every host filter call, so a slow host
  filter can no longer run past the render's wall clock unobserved.
- Prototype-pollution regression tests added for settings, bindings and props
  entry points.

## [0.1.0] - 2026-07-27

Initial release. The engine core, extracted as a standalone Apache-2.0 package
with zero runtime dependencies.

### Added

- **Lexer and parser** (`parseProgram`, `parseTemplate`): frontmatter
  declarations for pages, components, props, settings and slots; an HTML-strict
  tree parser requiring explicit closing tags; structural caps (AST nodes,
  element depth, expression depth and tokens, attributes per element) enforced
  while the AST is constructed rather than checked afterwards. Hand-rolled
  scanners throughout — no regex.
- **Closed allowlists**: 94 elements, a closed attribute table with `data-*` and
  `aria-*` as the only open families, and a closed URL-bearing attribute table.
  `script`, `style`, `iframe`, `svg`, `math`, `template`, `noscript` and eleven
  others are rejected by name with a dedicated reason. `on*` handlers, `srcdoc`,
  `ping`, legacy URL attributes and namespaced attributes are rejected. No
  dynamic attribute names, no spread.
- **Type checker** (`check`): a `TypeRegistry`-declared object model, no
  truthiness (`<if>` requires `Bool`), the optional law (a `T?` needs `??` or
  flow-narrowing), flow-narrowing through `!= none` and `&&` but deliberately not
  through `||`, terminal branded types (`Html`, `Money`, `MoneyText`, `Image`),
  component and slot contracts, cycle detection, and settings typing. Diagnostics
  carry stable codes, spans and fix-it suggestions, and the checker never throws.
- **Six-context escaper** (`escape.ts`): TEXT, RCDATA, ATTR, URL-ATTR and JSON-LD
  implemented as single linear passes, with RAWTEXT unreachable by construction
  because no RAWTEXT element exists in the allowlist. URL sanitization happens at
  the sink — control characters stripped first, then a scheme allowlist —
  never trusted from the `Url` type.
- **Stateless interpreter** (`render`): deterministic byte-identical output, no
  cache and no module state, byte-charged global fuel, one global iteration
  counter threaded through component calls and slot expansion, an injectable
  wall-clock deadline used only to abort, an output cap, and per-value caps
  re-checked at every filter step. A cap trip fails the render with
  template/line/col; a partial page is never returned.
- **Pure stdlib**: 19 filters (`capitalize`, `clamp`, `first`, `formatDate`,
  `join`, `last`, `lower`, `replace`, `reverse`, `round`, `size`, `slugify`,
  `sortBy`, `split`, `trim`, `truncate`, `upper`, `urlEncode`, `where`), all
  cap-checked and all regex-free. Nothing platform-bound.
- **Host interface** (`host.ts`): bring-your-own object model through a
  `TypeRegistry`, typed host filters with taint flagging (`unsafeHtml: true` is
  required for any filter returning `Html`, and `Html` may never be a parameter
  type), and host-programming-error validation that throws rather than producing
  template diagnostics.
- **`extractAccessPlan`**: static extraction of the exact data paths a render
  will touch, sound because the language has no dynamic member access.
- **Stored-AST pipeline** (`serializeProgram`, `loadCheckedAst`,
  `validateAstStructure`): plain-JSON serialization for storage and structural
  re-validation on load against the same allowlists and caps the parser enforces,
  so a poisoned stored AST cannot smuggle a construct the parser would have
  refused. `unsafe_loadTrustedAst` skips validation by design and is named so
  that misuse is visible in review.
- Zero runtime dependencies, zero I/O, no DOM and no Node built-ins.

[Unreleased]: https://github.com/princesourav/orbit-lang/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/princesourav/orbit-lang/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/princesourav/orbit-lang/releases/tag/v0.1.0
