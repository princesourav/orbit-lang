# Security Policy

## The security model, in one paragraph

The Orbit **engine** guarantees: termination (non-Turing-complete grammar,
byte-charged fuel, one global iteration counter, wall-clock deadlines),
context-aware autoescaping (TEXT / RCDATA / ATTR / URL-ATTR / JSON-LD, with
RAWTEXT unreachable by construction), closed element and attribute allowlists,
no ambient authority (no I/O, no clock in output, no randomness — hosts inject
everything), and structural re-validation of stored ASTs. The **host** is
responsible for: authorization and data scoping of everything it exposes through
the object model, write-time sanitization behind any `Html`-producing filter it
registers, and the integrity of stored ASTs (for example an HMAC binding). A
host that declares unsanitized data as safe has a host bug, not an engine
vulnerability — but report it anyway if the engine made it easy to get wrong.

## Supported versions

| Version | Security updates |
|---|---|
| `0.2.x` | Yes — current release line |
| `0.1.x` | No — upgrade to `0.2.x` |

Before v1.0 there is exactly **one supported line at a time: the latest minor**.
Security fixes are shipped as a patch on that line; older minors do not receive
backports. This is a deliberate pre-1.0 posture and it will be replaced by a
written stability and support policy at v1.0, when the normative spec and the
semver promise land together. Embedders who need a longer window before then
should track the latest minor.

Escaping and resource-cap behavior may be **tightened in patch releases**.
Pinning an exact version does not exempt an embedder from such fixes, and a
tightening that changes output bytes is not treated as a breaking change while
the project is pre-1.0.

## Reporting a vulnerability

**Do not open a public issue for a security report.**

Use GitHub's private vulnerability reporting on this repository — the
**"Report a vulnerability"** button under the
[Security tab](https://github.com/princesourav/orbit-lang/security/advisories/new).
That channel is private to the maintainers and is the only supported intake.

If GitHub is unreachable for you, open a public issue containing **no technical
detail** — just "requesting a private security contact" — and a maintainer will
open a private advisory thread for you.

### Our commitments

| Stage | Target |
|---|---|
| Acknowledgement of your report | **72 hours** |
| Initial triage: accepted / needs-info / out of scope, with reasoning | 7 days |
| Fix or documented mitigation for a confirmed high-severity issue | 30 days |
| Fix or documented mitigation for a confirmed low/medium issue | 90 days |
| Public advisory + release | At fix, or at day 90, whichever comes first |

These are targets for a small maintainer team, not a contractual SLA. If a
target is going to slip, we will tell you before it slips and say why.

## Coordinated disclosure policy (90 days)

We ask reporters to keep findings private for **90 days from our acknowledgement**,
or until a fix is publicly released, whichever comes first. In exchange:

- We will keep you informed at least every 14 days while an issue is open.
- We will not ask for an extension beyond 90 days except where a fix requires a
  coordinated release with a downstream embedder, and we will say so explicitly
  and agree a new date with you rather than letting the clock run out silently.
- If we go quiet for more than 30 days on an acknowledged report, treat the
  embargo as void and publish. Maintainer silence is not a disclosure embargo.
- If a vulnerability is already being exploited in the wild, the embargo does not
  apply — tell us and publish on whatever timeline protects users.

**Credit.** Reporters are credited by name (or handle, or anonymously — your
choice) in the published advisory and in CHANGELOG.md. We will never ask you to
sign anything as a condition of being credited, and we do not require you to
accept an embargo in order to be credited.

**No legal threats.** Good-faith research against your own deployment of this
engine — fuzzing, crafting hostile templates or hostile data, reverse
engineering — is welcome, and we will not pursue or support legal action over
it. Do not test against systems you do not own, and do not access other people's
data.

There is no paid bug bounty today. A funded, scoped bounty is planned for v1.0
and will be announced with published rules and a budget when it exists.

## CVE assignment and advisory publication

Advisories are published through **GitHub Security Advisories**. GitHub is a CVE
Numbering Authority (CNA), so for any **confirmed vulnerability in this package**
we will request a CVE ID through the GitHub advisory workflow rather than
handling disclosure informally. Concretely:

1. A confirmed report becomes a draft GitHub Security Advisory on this
   repository, with an affected-version range and a severity assessment.
2. We request a CVE ID from GitHub as the CNA for that advisory, including for
   issues we found ourselves rather than only for externally reported ones.
3. The fix ships; the advisory is published with the CVE ID, the CVSS vector,
   the affected and patched version ranges, and reporter credit.
4. Because the advisory is published on the repository, it propagates to the
   GitHub Advisory Database and from there to `npm audit`, Dependabot and the
   OSV feed without any further action by embedders.

We will request a CVE even for issues that only affect a non-default
configuration, as long as the configuration is one the documentation sanctions.
We do not suppress CVEs to keep a count low.

## Scope

### In scope

- **Escaping bypass** — any input that causes a value to reach the output in the
  wrong escaping context, or unescaped, without a host filter having explicitly
  declared `unsafeHtml: true`. Attribute and JSON-LD sinks are the highest-value
  targets. Context confusion between TEXT, RCDATA, ATTR, URL-ATTR and JSON-LD
  counts even when no proof-of-concept payload is supplied.
- **Budget bypass** — any template that renders without terminating, or that
  performs work not charged against fuel, the global iteration counter, the
  deadline, the output cap or the per-value caps. Amplification hidden inside a
  filter, or counters that reset at a component or slot boundary, are the
  patterns we care about most.
- **Sandbox or termination escape** — reaching a host object, prototype, global,
  or any capability the embedder did not declare through the `TypeRegistry` or a
  host filter. Prototype pollution through settings, bindings or props belongs
  here.
- **Stored-AST poisoning** — any structure that survives
  `loadCheckedAst(data, { trust: 'verify' })` but that the parser would have
  rejected, including allowlist smuggling and cap evasion.
- **Allowlist bypass** — smuggling an element, attribute or URL scheme past the
  closed tables, at parse time or at AST-validation time.
- **Non-determinism** — the same program, data and options producing different
  output bytes across renders or processes.

### Out of scope

- **Host misconfiguration.** Declaring untrusted data through a filter flagged
  `unsafeHtml: true`, or registering a host filter that itself concatenates
  attacker-controlled strings into HTML, is a host bug. Report it anyway if the
  engine's API made the mistake easy or hard to see — API ergonomics that invite
  the error are in scope even when the resulting bug is not.
- **Missing authorization in the host.** The engine has no identity, no tenancy
  and no data plane. If a host resolves an `AccessPlan` against data the viewer
  should not see, that is the host's authorization boundary, not ours.
- **Denial of service by an authorized host operator.** An embedder who sets
  `fuel`, `deadlineMs` or `maxOutput` high enough to hurt its own service has
  configured a policy, not found a vulnerability. Reports that a *template
  author* can exceed the host's configured budgets ARE in scope; reports that a
  *host operator* can raise those budgets are not.
- **Downstream mXSS.** Correct HTML output that a non-conforming downstream
  consumer (a sanitizer, a mutation-XSS-prone parser, an email client) then
  mis-parses. We are interested in hearing about it, but it is a limitation
  documented at v1.0 in the normative escaping spec, not an engine defect.
- **Dependency vulnerabilities.** The package has zero runtime dependencies.
  Development dependencies are not part of the published artifact.
- **Missing hardening that is on the roadmap and documented as missing** — for
  example the absence of a normative spec, conformance corpus or third-party
  audit. Those are gaps we already publish in the README; a report telling us
  they are gaps is not a vulnerability report.

## What testing exists today (v0.2)

Stated precisely, so nobody has to guess what "tested" means here:

- **Colocated unit and integration tests** (`src/*.test.ts`, vitest): the parser
  rejection matrix, the checker law and contract suite, per-context escaping
  matrices, interpreter budget trips, determinism and statelessness, stdlib
  per-value cap behavior, stored-AST poisoning defenses, and a byte-exact
  end-to-end render against a fake host.
- **Property-based tests** (fast-check, `src/*.property.test.ts`): randomized
  generators over templates and data, checking invariants rather than fixed
  outputs — parse → serialize → `loadCheckedAst` round-trip fidelity, an
  escaping oracle per context, fuel-termination proofs, and budget monotonicity
  (raising a budget never makes a render fail earlier).
- **A machine-checked claims manifest**
  ([`docs/compliance/claims.md`](./docs/compliance/claims.md)): every capability
  and security claim in the README and in this file is mapped to the test file or
  shipped artifact that substantiates it, and CI fails if any listed evidence
  path disappears. This exists specifically so that a security policy cannot
  quietly drift ahead of the code again.

**What does NOT exist yet, stated plainly:**

- There is **no coverage-guided fuzzing corpus** in this repository. Property
  tests with randomized generators are not the same thing as a persisted,
  coverage-guided corpus, and we do not describe them as one.
- There is **no conformance suite**. A first-party `orbit-conformance` corpus —
  pure JSON cases of (template, data, expected bytes *or* expected diagnostic
  code), covering all six escaping contexts and every budget-exhaustion
  behavior — is **planned for v1.0 and is not shipped today**. Until it exists,
  the tests in this repository validate the implementation against itself, with
  no external oracle.
- There is **no third-party security audit**. One is planned for v1.0.
- There is **no differential testing against browser parsers**. Planned for v1.0
  alongside the normative escaping spec.

Extending the property-based suite is a very welcome form of report — a failing
generator is often a better bug report than prose.
