# Orbit Roadmap — from v0.1 to best-in-industry

> **Delivery status (2026-07-28).** The engineering through v1.0 has landed on
> `main`. v0.2 (hardening), v0.5 (DX and tooling) and the v1.0 specification and
> conformance work are done: 1,145 tests, a 620-case conformance corpus with
> differential testing against a real WHATWG parser, error recovery, the
> formatter and CLI, tree-sitter and TextMate grammars, the language server, the
> playground, the documentation set, the LLM kit, the spec, and the governance
> and stability policies.
>
> **What remains is not engineering.** These items need a person, money, or
> other people, and are deliberately not faked:
>
> - a third-party security audit, and the grant applications to fund it;
> - the npm trusted-publisher link (one-time setup in the npm UI);
> - VS Code Marketplace and Linguist submissions;
> - design-partner conversations and the funded bug bounty;
> - Discord, and the Show HN launch itself.
>
> Post-1.0 work — the bytecode VM, streaming and fragment caching, the Rust/WASM
> second implementation, allowlist profiles — is out of scope by decision and is
> listed below for planning only.

## Positioning

**Orbit's wedge is being typed *and* safe for untrusted authors at the same time.** Type safety is normally bought by trusting the author — the template compiles into the host language and can reach whatever that language can. Safety for untrusted authors is normally bought by giving up types, and then defended with a sandbox. Orbit refuses both trades. "Best in industry" therefore does **not** mean fastest engine or biggest ecosystem. It means:

> **The reference language for templates written by people (or AIs) you don't trust**: the only engine where XSS is a compile error, resource exhaustion is a budget trip, the data a template can touch is statically extractable, and none of this depends on a sandbox — because there is no escape surface to sandbox.

The structural argument is simple. A sandbox is a deny-list bolted onto an evaluator that can, in principle, reach the host — so its correctness depends on having anticipated every path, forever, including the ones a future feature opens. Orbit has no such evaluator to fence in: there is no recursion, no dynamic member access, no runtime code generation, and no way to name a host object the embedder did not declare. Termination and escaping are properties of the grammar and the type system, checked before anything runs.

**Beachheads, ranked by who can embed us today.** Orbit ships as an npm TypeScript library, so the first two beachheads are JS-native: **(1) AI template-generation platforms** (typed compile errors give an agent a machine-checkable repair loop, and budgets bound what an unattended one can do), **(2) edge/Workers-for-Platforms operators** ([market wedge](https://www.cloudflare.com/products/workers-for-platforms/)) — with the explicit caveat that edge performance claims are gated on a reproducible benchmark (see v1.0). **(3) Multi-tenant SaaS embedding customer templates** (Braze/Zendesk/HubSpot-class) is the largest prize but runs Ruby/Java/Python/PHP backends; it is sequenced third and unlocked by an explicit portability story: a documented non-JS embedding guide (sidecar render service, precompiled signed-AST pipeline) at v1.0, and a Rust/WASM implementation post-1.0. We are not chasing raw codegen speed for trusted developers, and we deliberately ship **no migration tooling from other template engines** — adoption is greenfield-first: new template estates (AI-generated themes, new platform builds), not conversions of existing ones.

## Strategic pillars

**P1 — "No sandbox because no escape surface."** Non-Turing-completeness, closed allowlists (95 elements, banned `script`/`style`/`iframe`/`svg`), six structurally-assigned escaping contexts, and branded terminal types (`Html`, `Money`, `Url`) are the product. The codebase already delivers this with unusual discipline (RAWTEXT unreachable by construction; `Html` interpolation in TEXT is the *only* unescaped sink). The flagship document is the one that walks each class of template-injection vulnerability and shows the Orbit construct that makes it unrepresentable — not mitigated, not filtered, absent from the grammar.

**P2 — Diagnostics are the flagship feature.** For a language whose pitch is compile-time laws, error quality *is* the product; Rust and Elm are alone in S-tier ([Compiler Errors for Humans](https://elm-lang.org/news/compiler-errors-for-humans)). Orbit already has stable codes, spans, and pervasive fix-its — but the parser is fail-fast (one diagnostic per file, no code frames), which kills both human UX and any future LSP. Error recovery must land **before** tooling, per the dx-ecosystem sequencing (errors → formatter → tree-sitter → LSP).

**P3 — Spec + first-party conformance suite as the moat.** Deterministic byte-exact rendering makes a CommonMark-style executable spec feasible ([CommonMark model](https://spec.commonmark.org/0.30/)): if the same program and data always produce the same bytes, the expected bytes can simply be written down. Shipping the suite first-party rather than leaving it to someone else is what makes safety claims falsifiable and a second implementation verifiable. Correctness is validated externally — differential testing against browser parsers, and later a second implementation — never solely against the implementation that generated the suite.

**P4 — Features aimed at the platform operator, not the template author.** Fuel/deadline/output budgets and static data-access-plan extraction answer the two questions an operator asks and a template author never does: what stops a hostile template, and what data can this template reach. Budgets are the answer to resource exhaustion, which is a separate problem from injection and is not solved by escaping ([Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) set the practical ceiling at the edge). The access-plan analysis is load-bearing for later features (LSP completions, fragment-cache keys), so its known soundness gaps are fixed in v0.2, before anything depends on it.

**P5 — AI agents as a first-class audience — delivered early, not last.** A typed, non-Turing template language is an unusually good code-generation target, and the reason is mechanical rather than promotional: stable error codes, precise spans and suggested fixes turn a failed generation into a repairable one ([DSL partitioning](https://bradmurry.com/software/dsl-ai-partition/)). Typed compile errors give agents a machine-checkable repair loop; budgets bound autonomous blast radius. Because this is the strongest 2026 tailwind and is docs-plus-harness cheap, the prompt pack and eval harness ship in v0.5, not post-1.0. This audience also machine-audits us — Anthropic's Project Glasswing found 10,000+ high/critical OSS issues in a month ([Help Net Security](https://www.helpnetsecurity.com/2026/05/26/anthropic-project-glasswing-update/)) — so minimal surface + written spec is survival, not marketing.

**P6 — Tooling parity is table stakes, greenfield-first.** An author evaluating a template language judges it through an editor: highlighting, completions, a formatter, and errors that say what to do. Better safety with worse tooling loses, because the safety is invisible until something goes wrong and the tooling is felt on the first file. Orbit deliberately ships no migration tooling from other engines: conversions would import untyped idioms and imply a drop-in compatibility that does not exist. The adoption path is new templates — AI-generated, new platform builds, new tenant estates — so the tooling investment goes entirely into making authoring-from-scratch (by humans and agents) faster than porting.

## Table stakes vs differentiators

**Table stakes (build to parity, don't innovate):** autoescape-on-by-default, components/slots/partials, formatter, tree-sitter grammar, LSP + VS Code extension, playground, docs site, ESM packaging, CI/provenance, Discord/CONTRIBUTING scaffolding.

**Differentiators (protect at all costs — never trade away):** non-Turing-completeness, static typing with the optional law and no-truthiness, closed allowlists, six-context structural escaping, deterministic byte-identical output, fuel/deadline/output budgets, static data-access plans, stored-AST re-validation. Several "gaps" tempt dilution — dynamic member access, method calls, raw HTML modes, Turing-ish escape hatches. **Declined permanently.** Where users need more power, the sanctioned answer is host filters and, later, scoped extensions (CSS custom-property micro-context, allowlist profiles) — never generalized computation.

---

## v0.2 — Hardening & honesty (2026 Q3, ~10 weeks)

Goal: make what exists true, safe at the seams, decided where the spec will freeze it, and packaged for 2026. All achievable by 1–2 people.

**Weeks 1–3, deadline-driven: CRA readiness.** ENISA 24/72/14 reporting obligations start **11 September 2026 — mid-milestone**, so this ships first, not among peers: SBOM (CycloneDX), documented 24/72/14 reporting workflow, declared steward status ([Mend CRA guide](https://www.mend.io/blog/eu-cyber-resilience-act-compliance-guide/)). Alongside it, the security-process items: a documented CVE path (CNA-or-GitHub-advisory route decided and written down) and a 90-day coordinated-disclosure policy in SECURITY.md.

**Truth & identity**
- Rewrite README for the standalone `@orbitlang/core` identity; delete monorepo framing. *(The current README/package mismatch would embarrass any launch.)*
- **Delete or fulfill the fuzz-corpus claim in SECURITY.md** — fulfill it: fast-check property tests (parse→serialize→load round-trips, escaping-context oracle, fuel-termination proofs, budget monotonicity). *(An overclaim in the security policy of a security-positioned product is the worst possible bug; fast-check is the practical TS path since Jazzer.js was discontinued — [oss-fuzz #11652](https://github.com/google/oss-fuzz/issues/11652).)*
- **Documented locale/timezone limitation statement**: `formatDate` is currently English-only and its timezone behavior is documented nowhere — write the honest limitation into the filter docs now, with the sanctioned interim path (host filters), so the messaging/email conversation doesn't fail on an undisclosed gap. Locale-data injection lands in v1.0.
- CI: GitHub Actions with test + `tsc` + DCO check; npm **trusted publishing (OIDC)** with provenance; OpenSSF Scorecard action ([npm trusted publishing GA](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)). Plus a **claims-audit CI gate**: a machine-checked manifest linking every capability claim in repo docs to a test or artifact — no claim without a link.
- CHANGELOG, git tags, `engines`, `sideEffects: false`; **dual ESM/CJS build**. *(CJS-only blocks Workers/Deno/browser — ironic for a zero-I/O engine.)*

**Runtime seam hardening** (all from the runtime-security gap list)
- Wrap host filter `impl` in try/catch → `OrbitRenderError`; check deadline before/after host filter calls.
- Parse `srcset` as multi-URL candidates before sanitizing.
- Runtime shape-validation of component-entry props/bindings (mirror `settingValueValid`); fix the hollow color validator (hex-digit check).
- Structured warnings (codes + spans, matching diagnostics) and a host option to make blocked URLs fail instead of soft-`#`.
- Ship the HMAC signing helper referenced by validate-ast docs. *(Specified but not shipped is another overclaim.)*
- Null-prototype maps + `Object.freeze` on registries, with regression tests keyed to Handlebars CVE-2026-33916 and DOMPurify CVE-2026-41238 classes ([trace37](https://labs.trace37.com/blog/dompurify-pp-ceh-bypass/)).

**Language decisions & bug-fixes**
- **Pipe precedence, decided now**: `|>` currently binds tighter than `*`/`+` — opposite of Elixir/F# and a documented footgun. Fix it or normatively document it in v0.2, because after the v1.0 spec and editions pragma it becomes an edition-breaking change. This is the last cheap moment.
- **`extractAccessPlan` soundness**: fix component-entry mis-seeding and paths dropped through filters; add slot-in-slot and let-rebinding test coverage. *(v0.5 LSP completions and post-1.0 fragment-cache keys both depend on plan soundness — it must be trustworthy before anything is built on it.)*
- Page props: either support or reject with a dedicated diagnostic (currently silently dead). Fix O1002 off-by-one; numeric-literal digit caps; `Range` setting `min<=max`/`step>0` validation; de-duplicate reused diagnostic codes (O2082, O2072). *(Stable error codes are about to become documented API.)*

**Metrics:** claims-audit CI gate green (every doc claim linked to a test/artifact — replacing self-certified "zero overclaims"); CI green on every PR; ≥300 tests incl. ≥50 property-based; provenance + Scorecard badges live; CRA artifacts published before 11 Sept; pipe-precedence decision merged and documented; all runtime-security gap items closed or explicitly documented as accepted.

---

## v0.5 — DX, tooling & soft launch (2026 Q4 – 2027 Q1)

Goal: tooling an author would choose on its own merits, following the proven small-team order ([Gleam playbook](https://gleam.run/news/v0.21-introducing-the-gleam-language-server/)), and an end to public silence.

**Core tooling (in priority order — see cut line below)**
- **Parser error recovery + code-frame renderer** (source excerpt, carets, multi-error per file). *(Prerequisite for everything below; benchmark the top 20 diagnostics against rustc-style output.)*
- **Canonical formatter** (`orbit fmt`, zero-config). *(Design the canon now — retrofitting is painful.)*
- **Tree-sitter grammar + highlights.scm** → Linguist PR, Neovim, near-free Zed extension ([Zed language extensions](https://zed.dev/docs/extensions/languages)).
- **LSP + VS Code extension**: diagnostics, format-on-save, completions + hover for props/filters/**data model from access plans** (defer rename/code actions). LSP never renders templates — compile-only. *(Access-plan completions are something Theme Check can't do — and the plan analysis was made sound in v0.2.)*
- **CLI**: `orbit check` / `orbit fmt` in the one npm package — compiler-as-library architecture (Gleam/Biome pattern).

**In-milestone cut line:** the dossier's own estimates (grammar 1–3 wks, formatter 2–4 wks, minimal LSP 4–8 wks, playground 1–2 wks, docs ongoing) plus unestimated error recovery exceed two quarters for 1–2 people. **Error recovery, formatter, and tree-sitter ship in v0.5 no matter what; the LSP slips to v1.0 if the milestone runs hot.** The soft launch below does not depend on the LSP.

**AI-agent workstream (P5, pulled forward)**
- **LLM prompt kit prototype (Q4 2026)**: system-prompt pack teaching Orbit's grammar, types, and error codes, plus an **eval harness** (generate → compile → repair-loop success rate) built on the existing test corpus. Docs-plus-harness cheap, and it is where a typed language pays off most visibly. llms.txt + llms-full.txt ship with the docs site ([Astro's removal was mis-measurement](https://dacharycarey.com/2026/05/04/astro-removed-llms-txt/)).

**Soft launch (early 2027)** — the CVE record is the marketing engine and it decays; twelve months of silence wastes it. Ship publicly, without the Show HN (reserved for v1.0):
- **Browser playground**: TS compiler runs client-side, zero infra; live escaping-context visualization and budget meters ([Svelte REPL precedent](https://www.infoq.com/news/2020/10/svelte-simple-repl-summit-2020/)).
- **Docs site** (Starlight): language tutorial, grammar reference, all-19-filter reference, host-embedding guide, error-code index (every O-code gets a page), `examples/` directory.
- **First edition of the "vulnerability class → unrepresentable construct" page** (moved up from v1.0; the normative version follows with the spec) — the clearest single statement of what the design buys.
- GitHub syntax highlighting live; quiet posts in relevant communities, no launch theatrics.

**Funding workstream (starts now, not post-1.0)**
- Submit audit-funding applications (OSTIF, Sovereign Tech Fund, NLnet) in Q4 2026 — grant cycles have 3–6 month lead times and the v1.0 audit depends on a decision landing by early 2027; self-funded fallback scope defined if all three decline.
- Open **paid design-partner conversations pre-1.0** with at least three platforms that render templates authored by their own users; target one signed paid pilot or LOI before launch. The closed layer (hosted rendering/governance) is validated from day one, not after.
- Define bounty scope and budget now ("produce executable output," fixed pool), to be funded and published at v1.0.

**Community scaffolding**: code of conduct, issue/PR templates, real CONTRIBUTING, Discord, good-first-issues drawn from the gaps lists. API stability tiers: stable pipeline API vs. explicitly-unstable AST exports.

**Metrics:** median time-to-first-successful-template <15 min (tested with 5 outsiders); playground + docs + CVE page public by end of Q1 2027; LLM eval harness reports a baseline generate-compile-repair success rate; ≥2 grant applications submitted; ≥3 design-partner conversations opened, ≥1 LOI in progress; ≥3 external contributors merged; error recovery + formatter + tree-sitter shipped (LSP shipped or formally slipped with a v1.0 date).

---

## v1.0 — Spec, credibility, launch (2027 Q2 – Q3)

Goal: falsifiable claims, enterprise-grade stability promises, public launch.

- **Normative spec with executable examples** + first-party `orbit-conformance` corpus: pure JSON (template, data, expected HTML bytes *or* expected diagnostic code), categories for all six escaping contexts and every budget-exhaustion behavior — including an empty-loop-body fuel test. *(An empty body emits nothing, so an implementation that charges per byte would make an empty loop free work and hand an author an unbounded one. The counter is charged per iteration, and the corpus pins it.)*
- **Normative escaping spec**: six contexts, transition table, terminal-type contracts, enumerated non-goals (downstream mXSS etc.), a corpus covering the JS/CSS cases Go's html/template mis-parses ([golang/go#27926](https://github.com/golang/go/issues/27926)), **plus differential testing against browser parsers** — rendered output fed through actual browser HTML/URL parsers to confirm context assignments match reality, giving the conformance suite an external oracle instead of self-validation.
- **"Vulnerability class → unrepresentable construct" security page, normative edition**: host-object reachability through value coercion, template-from-string evaluation, runtime introspection, codegen by string concatenation, sanitizer bypass — each mapped to the Orbit design that excludes it.
- **Non-JS embedding guide**: documented sidecar-render and precompiled-signed-AST patterns for Ruby/Java/Python/PHP hosts — the interim portability story for the multi-tenant SaaS segment until the second implementation lands.
- **Locale-data injection** for `formatDate` (host-supplied locale/timezone data, deterministic output preserved); full plurals/i18n stays in the staged-proposal pipeline.
- **Stability policy + editions pragma** (`orbit 2027`): semver covers syntax, output bytes, error codes, access-plan format; "engine upgrades never change tenant output" is the enterprise headline ([The Last Breaking Change](https://json-schema.org/blog/posts/the-last-breaking-change)).
- **Governance-lite**: GOVERNANCE.md (BDFL-for-now, scaled-down staged proposal process), one-page trademark policy (Apache-2.0 excludes trademark — [§6](https://www.apache.org/licenses/LICENSE-2.0)), DCO stays (no CLA — [OpenStack precedent](https://governance.openstack.org/tc/resolutions/20250520-replace-the-cla-with-dco-for-all-contributions.html)).
- **One named third-party audit**, published with fixes — funded via the v0.5 grant applications, with a defined self-funded fallback scope. *(The pen-test report, not the README, is what procurement reads — [HubSpot Trust Center pattern](https://trust.hubspot.com/).)*
- **Funded bounty, published scope**: "produce executable output from a compiled template," fixed budget, published rules — live at launch so the launch claim is falsifiable in public.
- **Trusted Types integration recipe** — TT is Baseline since Feb 2026; Orbit as the server half of a browser-enforced pipeline ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API)).
- **Bench harness, one number only**: a reproducible harness directory with a single headline measurement — Workers CPU-ms for a representative product-listing render on the *current* engine. This single benchmark is exempt from the cut-performance-first rule, because the edge pitch is unsupported without it; broader benchmarks wait for the VM. **No speed claims in the README** — a table of what the engine guarantees instead ([benchmarketing risk](https://bitsondata.dev/what-is-benchmarketing-and-why-is-it-bad)).
- **Launch**: Show HN with literal title ("…typed, non-Turing template language where XSS is a compile error"), founder first-comment, hour-one reply discipline; deep-dive posts (escaping proof, access-plan extraction) at 2–6 week intervals ([HN playbook](https://www.markepear.dev/blog/dev-tool-hacker-news-launch)).

**Metrics:** conformance suite ≥500 cases with the browser-differential oracle at 100% agreement on escaping-context cases; audit published, all high/critical fixed; bounty live with published scope and budget, zero paid claims after 90 days; ≥2 signed design-partner LOIs (≥1 paid) from target segments; launch ≥1k GitHub stars.

---

## Post-1.0 — Ecosystem & scale (2027 Q4 →)

- **Bytecode/IR compilation + serialized-IR precompilation.** Never runtime compile-to-JS (`new Function` is blocked on Workers — [workerd #1421](https://github.com/cloudflare/workerd/issues/1421)); a MiniJinja-class VM lands within 2–5x of compiled engines while keeping the sandbox ([MiniJinja benchmarks](https://github.com/mitsuhiko/minijinja/tree/main/benchmarks)). Targets: <5ms CPU for the v1.0 benchmark scenario, with allocations per render reported alongside ops/sec.
- **Streaming + fragment caching**: explicit flush boundaries, bot-aware head-locking mode, fragment cache keys derived from the (v0.2-hardened) access plan ([fragment cache design](https://oneuptime.com/blog/post/2026-01-30-fragment-cache-design/view)).
- **Public benchmarks** in reviewer-expected formats (JS scenario suites, askama-style page, Workers CPU-ms as the differentiated number) — only atop the reproducible v1.0 harness.
- **Second implementation (Rust/WASM) passing the conformance suite** [community] — the TC39 "two implementations" legitimacy bar ([TC39 process](https://tc39.es/process-document/)), real coverage-guided fuzzing via cargo-fuzz, and the native embedding path that fully unlocks the polyglot multi-tenant SaaS segment.
- **Allowlist profiles** (e.g., email-HTML dialect) — unlocks the Unlayer/Beefree-class embedded-builder market [gated on profile design not weakening the core].
- **LLM codegen kit, expanded**: the v0.5 prompt pack and eval harness grow into an MCP docs server and a design-partner program aimed at platforms generating templates on their users' behalf.
- **Language additions via staged proposals** [community input]: `<match>/<case>`, slot fallback content, full i18n/plurals atop the v1.0 locale-data foundation, whitespace control, CSS custom-property micro-context for theme colors.

**Metrics:** ≥2 production multi-tenant embeddings; ≥1 AI-builder partner generating Orbit in production; second implementation at ≥95% conformance [community]; closed layer generating revenue from ≥1 paying design partner converted from the pre-1.0 LOIs — the open engine captures zero revenue by design, and is not meant to.

---

## Risk register

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | **Team of 1–2 stalls on the tooling long-pole (LSP/formatter)**, launch slips past the 2026–27 credibility window | Proven order (errors→formatter→tree-sitter→LSP); **in-milestone cut line: LSP formally slips to v1.0, the v0.5 soft launch proceeds without it**; compiler-as-library from day one; recruit contributors early for grammar and editor extensions [community] |
| 2 | **A security researcher (or AI auditor) finds an escaping/budget hole before the spec exists**, undermining the positioning | v0.2 property-testing + seam hardening *before* the early-2027 soft launch; browser-differential oracle at v1.0; funded, scoped bounty live at launch; private-report channel + 90-day disclosure policy + CVE path in SECURITY.md from v0.2; assume machine audit per Glasswing |
| 3 | **Overclaim hangover**: fuzz-suite and HMAC claims already in-repo are false today | Fix in v0.2 before any external attention; claims-audit CI gate (every doc claim linked to a test or artifact) makes recurrence machine-detectable rather than self-certified |
| 4 | **Strictness rejection**: real users hit missing power (dynamic style, i18n, email HTML) and go elsewhere | Sanctioned escape valves (host filters now; locale-data injection at v1.0; profiles and micro-contexts via staged proposals); honest limitation docs from v0.2 so nothing fails as a surprise; never answer with Turing-completeness |
| 5 | **Beachhead mismatch**: the largest segment (polyglot multi-tenant SaaS) can't embed an npm library, and the edge pitch rests on an unbuilt VM | JS-native segments (AI builders, edge) ranked first; non-JS embedding guide at v1.0 and Rust/WASM post-1.0 for the SaaS segment; edge claims gated on the single v1.0 Workers benchmark, which is exempt from performance-cut rules |
| 6 | **Unfunded commitments and no revenue until mid-2027**: audit hand-waved to competitive grants, bounty unbudgeted, monetization deferred | Funding workstream from v0.5: grant applications submitted Q4 2026 with a self-funded fallback scope; bounty budget defined in v0.5, funded at v1.0; paid design-partner conversations open pre-1.0 with ≥1 paid LOI targeted before launch |

**Sequencing honesty:** everything through v1.0 is deliberately sized for 1–2 people plus early contributors; the VM, second implementation, and profile system are explicitly contingent on post-launch community and/or funding [community]. If forced to cut, cut performance work first (data access dominates real pages — Shopify's wins came from SQL and caching, not template micro-optimization) — **with one exemption: the single reproducible Workers CPU-ms benchmark ships at v1.0 regardless, because the edge pitch is dishonest without it**. Never cut diagnostics, spec, or conformance — they are the moat.
