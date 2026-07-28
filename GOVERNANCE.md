# Governance

Orbit is a small project and this document describes what is actually true,
not an org chart it does not have. It will grow when the project does.

## Decision-making

The project currently has a single maintainer, who has final say on what ships.
That is the honest description of a project this size; pretending otherwise
would make the process harder to predict, not more open.

What that commits the maintainer to:

- **Decisions are made in public.** Design rationale goes in the issue, the
  pull request, or a comment in the code — not in a private channel.
- **Reasons are given.** A proposal that is declined gets a reason, and if it
  is declined on principle (see non-goals) it is closed rather than left open
  indefinitely.
- **The non-goals are the constraint, not the maintainer's taste.** A change
  that preserves them gets a fair hearing regardless of who proposes it.

## Non-goals — proposals that will be declined

These are not a backlog. They are the shape of the language, and a proposal
that requires one will be closed with a pointer here.

| Non-goal | Why |
|---|---|
| Turing-completeness | Termination is a property of the language. User-defined functions, recursion or unbounded loops would end that. |
| Dynamic member access | `obj[expr]` would make the static access plan unsound, which several features depend on. |
| A raw-HTML mode | The only unescaped sink is a host filter flagged as unsafe — an auditable list. A template-level escape hatch destroys that. |
| Regular expressions | Not in the engine, not in the stdlib. Catastrophic backtracking is a denial-of-service primitive. |
| Runtime code generation | `new Function` and `eval` are absent, deliberately. They also do not exist on edge runtimes. |
| A CSS escaper | A CSS value is its own injection context. Orbit refuses `style` interpolation rather than escaping it approximately. |
| Implicit stringification | Rendering `none`, an object, or a list by accident is the bug the type system exists to prevent. |
| Migration tooling from other template languages | Adoption is greenfield-first. A converter would import untyped idioms and imply drop-in compatibility that does not exist. |

Adding an element or attribute to the allowlist is **not** on this list — that
is an ordinary proposal, and a good one if the addition is safe in every
context. It needs a conformance case.

## Proposing a language change

1. **Open an issue** describing the problem, not the syntax. "I cannot express
   X" is a better start than "add Y".
2. **Expect the first question to be whether a host filter solves it.** The
   host seam exists precisely so the language does not have to grow for every
   need, and a filter is a boundary you control and can audit.
3. If it genuinely needs language support, the proposal needs:
   - the grammar change;
   - the type rules, including how it interacts with the optional law;
   - the escaping context, if it can emit;
   - whether it can affect termination or any budget;
   - conformance cases for the accepted **and** rejected forms;
   - what it means for the existing spec text.
4. **Security-relevant changes need more.** If a proposal touches escaping,
   allowlists, budgets or stored-AST validation, it needs an explicit argument
   for why it is safe in every one of the six contexts.

Steps 3 and 4 are heavy on purpose. A template language for untrusted authors
gets less safe with every feature, and the burden should sit with the addition.

## Contributions that are always welcome

Lower ceremony, high value:

- **Conformance cases**, especially ones that fail. A case demonstrating a
  divergence between the spec and the implementation is the single most useful
  contribution.
- **Diagnostic improvements.** A confusing error with a better message and a
  fix-it. Error quality is the product for a language like this.
- **Editor support** — the tree-sitter grammar, TextMate scopes, editor
  extensions.
- **Documentation**, including the reasoning behind a rule that reads as
  arbitrary. Every snippet is compiled by CI, so a broken example cannot land.
- **A second implementation.** See [conformance](conformance/README.md). Two
  independent implementations passing one suite is the strongest correctness
  evidence this project can have.

## Contribution terms

Contributions are accepted under the **Developer Certificate of Origin**: sign
off with `git commit -s`. There is no CLA.

The DCO asserts you have the right to contribute the code. A CLA additionally
assigns rights to the project, which is a real cost to a contributor for
questionable benefit to a project already licensed Apache-2.0. CI enforces the
sign-off.

## Security

Vulnerability reports do not go through this process. See
[SECURITY.md](SECURITY.md): private reporting, 72-hour acknowledgement, 90-day
coordinated disclosure.

A security fix may ship without prior public discussion, and may break a
previously accepted program. That is stated in [STABILITY.md](STABILITY.md) as
a deliberate exception.

## Releases

Releases are tagged `v*` and published to npm with provenance via OIDC trusted
publishing — no long-lived token exists to leak. Each release carries a
CycloneDX SBOM.

Every release must have CI green, which includes: the test suite on Node 20,
22 and 24; both typecheck configurations; the conformance corpus not stale; the
claims audit passing; and the CLI smoke tests.

## If this project outgrows one maintainer

The intended progression, stated now so it is not invented under pressure:
committers with merge rights in areas they have worked in; then a small group
for decisions that cross areas; then a written process for language changes
modelled on TC39 stages. Moving to any of those requires more sustained
contributors than the project currently has.
