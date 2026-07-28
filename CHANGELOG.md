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
