# Scope

One page. What Orbit includes, what it excludes, and what is deferred with the
evidence that justifies deferring it.

## Two words that are not the same word

Fixed here before either reaches further into diagnostics, the manifest or the
spec, because two mechanisms sharing a word produces confused bugs before it
produces confused docs.

| | **Island** | **Widget** |
|---|---|---|
| What | A deferred **server fragment** | A **client component** the platform provides |
| Written | `<CartCount defer/>` | placed by name, host-registered |
| Rendered | By the engine, in a second pass | In the browser, by platform code |
| Why | Caching — personalized data leaves the page's access plan | Interactivity — a cart drawer cannot be a page load |
| Fails to | Its fallback, left exactly as rendered | (see the widget design; different answer) |
| Status | **Shipped** (E0 + `runtime/`) | Not built |

They **compose**: a platform widget can itself be deferred. That is precisely
why they cannot share a name — "a deferred island widget" has to be sayable, and
"an island island" does not parse.

The island keeps the word because it already reached a shipped artifact, a
placeholder element (`<orbit-island>`), five diagnostics, the manifest and the
spec. Renaming a word that has not shipped costs nothing; renaming one that has
costs a compatibility break.

This exists because "frozen" is aspirational without a document, and scope
re-expands to whatever felt designed a few rounds ago. It is also the answer to
the most common kind of proposal: not *why not?* but **which invariant are we
prepared to weaken?**

Every exclusion below names the invariant it protects. A bare "no" reads as an
arbitrary limitation to whoever arrives after everyone who remembers the reason.
An invariant has to be argued against.

---

## Included

The language as it stands, and nothing beyond this list without a written
proposal that answers the question above.

**Rendering.** Elements and attributes from closed allowlists. Six escaping
contexts assigned structurally, before any value exists. `<if>` / `<else-if>` /
`<else>`, `<for>` with a literal bound, `<match>` with exhaustiveness over
string-literal unions, `<let>`, `<slot>`, `<json-ld>`, comments.

**Types.** Primitives, `T?` under the optional law, `List<T>`, records, objects
and string-literal unions from a host `TypeRegistry`. Terminal types: `Money`,
`MoneyText`, `Url`, `Image`, `Color`, and engine-owned `Html` with its three
declared obligations.

**Computation.** Nineteen stdlib filters and host filters with typed positional
and named-optional parameters. Arithmetic, comparison, `??`, ternary, `|>`.

**Composition.** Components with typed props and declared slots. Merchant
settings with typed controls.

**Static analysis.** Access-plan extraction, sound per unit and per island.
Serialized ASTs with re-validation on load. Language versions.

**Deferral.** `defer` on a component call, its placeholder, its manifest, and
the swap script in `runtime/` that fills it.

**Tooling.** Formatter, CLI, tree-sitter and TextMate grammars, language server,
playground, conformance corpus, error index — all generated from the engine so
none can drift from it.

---

## Excluded

Not on a roadmap. Each row is a constraint the rest of the design is built on
top of; removing one does not remove a feature, it removes a guarantee.

| Excluded | Invariant protected |
|---|---|
| **Raw HTML sinks** (`\|safe`, triple-mustache, any author-selectable raw output) | Sound six-context structural escaping. The trust decision belongs to the embedder at integration time, not the author at a call site. |
| **Dynamic member access** (`obj[expr]` on records or objects) | Finite, predictable access-plan extraction. This is precisely what makes the plan sound, and therefore what makes declare-then-fetch and fragment caching possible at all. |
| **JavaScript in templates** | Deterministic, fuel-bounded SSR. Orbit ships JavaScript; what it forbids is *author-written* JS in a theme. |
| **`Html` crossing a foreign boundary** | The escaper cannot be bypassed via `innerHTML`. An `Html` value carries its trust obligation in the value; handing it to foreign code strips that and hands back a string indistinguishable from merchant input. |
| **Orbit-rendered children inside foreign subtrees** | Unambiguous DOM ownership and lifecycle. Two owners of one subtree is two lifecycles, and neither can be reasoned about. |
| **Server-side execution of foreign modules** | SSR determinism and zero ambient authority. The engine has no I/O; a foreign module has whatever the process has. |
| **Interpolated `style` attribute** (`O1095`) | CSS injection sink. The typed custom-property form is the narrow carve-out — see below — and it is narrow on purpose. |
| **General string → CSS custom property** | Only terminal types with a closed lexical form may reach a CSS sink. `String` has no lexical form to enumerate, so nothing can be proven about what it does downstream. |
| **Turing-completeness** — user-defined functions, recursion, unbounded loops | Termination is a property of the grammar, not of a watchdog. |
| **Regular expressions** | Bounded, predictable filter cost. No catastrophic backtracking to budget for. |
| **`eval`, runtime code generation** | There is no evaluator to sandbox. This is the whole structural argument: a sandbox is a deny-list bolted onto something that can reach the host, and its correctness depends on having anticipated every path forever. |
| **Migration tooling from other template engines** | Adoption is greenfield-first, by decision. |

### The two carve-outs, stated as carve-outs

Both are narrow on purpose, and neither is a precedent.

**The typed custom-property sink** carves `O1095` open for exactly one form: a
static `--property` name bound to a value of a terminal type whose lexical form
the engine can enumerate. v1 admits `Color` and nothing else. The safety argument
is that a `Color` is exactly six hex digits — and that argument does **not**
transfer to `Length`, `FontFamily`, or a background URL, each of which needs its
own lexical analysis. Interpolated `style` stays banned.

**The swap script's `innerHTML`** is `Html` crossing into the DOM, which the
table above excludes. It is permitted because the value is Orbit's own render
output — same engine, same escaper, the host's own second pass over same-origin
credentials — not author markup and not user input. There is exactly one such
write in `runtime/`, and a test fails if a second appears. An implementation that
sources island content from anywhere else has broken the escaping guarantee
rather than extended it.

---

## Deferred

Not excluded — the invariants above survive them — but not now, and each with
the evidence that justifies waiting.

| Deferred | Evidence |
|---|---|
| **Reactivity beyond placed widgets** (`<let>` reactivity across a document, a store and action vocabulary) | Phase D found interactivity concentrated in 7 blocks, all of which need *placement* of a platform component rather than reactive bindings. Building the general mechanism first would be building for a requirement the measurement did not produce. |
| **`Length` / `FontFamily` / URL custom properties** | Phase D counted 14 blocks with a `Color` setting and 38 with a `Range`. `Range` is finite and already expressible as enumerated classes; the colour gap is the one with no answer. Each additional type needs its own lexical analysis, and none is on the measured critical path. |
| **A bytecode VM** | No reproducible benchmark exists yet, so there is no evidence that interpretation is the bottleneck. Phase D's finding was about expressiveness, not speed. |
| **Streaming and fragment caching** | Both key off access plans, which now partition per island — the prerequisite landed with E0, the consumers have not been asked for. |
| **A Rust/WASM second implementation** | The conformance corpus is the prerequisite and exists; the demand is a polyglot embedding segment that is sequenced third by decision. |
| **Email-dialect allowlist profiles** | No measured demand. Speculative until a host asks. |
| **Browser-matrix testing of `runtime/`** | The script is 1.4KB of ES2018 with one DOM write. Real-DOM coverage exists; a browser matrix is warranted when the client surface grows past one artifact. Stated as a gap in `SECURITY.md` rather than claimed. |

---

## How to propose something

State which row above you are moving, and to where. A proposal that moves a row
out of **Excluded** must name the invariant it weakens and argue that the
weakened version is still worth having. A proposal that moves a row out of
**Deferred** must supply evidence of the kind in the right-hand column —
measured, not anticipated.

Proposals that do neither are answered with this page.
