# EU Cyber Resilience Act — readiness statement

**Project:** Orbit (`@orbitlang/core`)
**Version this statement describes:** 0.2.0
**Last reviewed:** 2026-07-28

> **This is not legal advice.** It is an engineering readiness statement written
> by the project's maintainers describing what this project does, what it will
> do, and which obligations we believe apply to us. Organizations placing
> products containing Orbit on the EU market must do their own assessment; we
> cannot do it for them, and nothing here transfers an obligation from a
> manufacturer to us or from us to a manufacturer.

## 1. Declared status: open-source software steward

Regulation (EU) 2024/2847 (the Cyber Resilience Act) distinguishes
**manufacturers**, who place products with digital elements on the EU market in
the course of a commercial activity, from **open-source software stewards**, who
support the development of free and open-source software intended for commercial
use but do not themselves monetize it.

**Orbit declares itself an open-source software steward.**

The basis for that declaration:

- Orbit is published under the Apache License 2.0 with source available to all.
- The project charges nothing for the software, sells no support contracts, sells
  no hosted version of the engine, and receives no payment for the package.
- The project is developed by a small maintainer team supporting it on an
  ongoing basis, which is what distinguishes a steward from an individual
  contributor publishing code with no support commitment.
- Orbit is **intended for commercial use** by others — it is explicitly designed
  to be embedded in commercial multi-tenant platforms — which is what brings a
  steward into scope at all.

Steward obligations are lighter than manufacturer obligations: a steward must
have a documented cybersecurity policy, must cooperate with market surveillance
authorities, and must report **actively exploited vulnerabilities and severe
incidents it becomes aware of**. A steward is not subject to conformity
assessment, CE marking, or the full manufacturer documentation set.

**If this changes, this document changes.** Should the maintainers begin
monetizing the engine itself — a paid hosted rendering service built on this
package, paid support for this package, or a commercial license of this package
— the steward declaration no longer holds for that activity and this file will
be updated before, not after, the change. The separately-developed closed
platform layer described in the README is a **different product**; if it is
placed on the EU market, its manufacturer obligations are that product's, not
this package's.

## 2. When these obligations start

The Cyber Resilience Act entered into force on 10 December 2024. Its
obligations phase in:

| Date | What starts applying |
|---|---|
| **11 September 2026** | **Reporting obligations for actively exploited vulnerabilities and severe incidents** (CRA Article 14), including for stewards |
| 11 December 2027 | The remaining obligations, including the essential cybersecurity requirements |

The 24-hour / 72-hour / 14-day reporting clocks described below therefore begin
applying to this project on **11 September 2026**. The workflow is documented and
operational before that date so it is not being invented during an incident.

## 3. Reporting workflow for an actively exploited vulnerability

The reporting duty is triggered by an **actively exploited vulnerability** in
this product, or a **severe incident having an impact on the security of this
product** — not by every vulnerability. A confirmed but unexploited bug follows
the ordinary disclosure path in [SECURITY.md](../../SECURITY.md); it does not
start these clocks.

### Who reports

The **repository maintainers** (the individuals with admin rights on
`github.com/princesourav/orbit-lang`) are responsible for filing. There is no
delegation to a downstream embedder: an embedder that discovers exploitation is
asked to notify us through the private channel in SECURITY.md, and remains
responsible for any reporting duty attaching to **its own** product.

### To whom

Reports are submitted through the **ENISA single reporting platform**, the
central entry point established under CRA Article 16, which routes the
notification to the appropriate **CSIRT designated as coordinator** and to ENISA.
The project has no EU establishment, so where the platform requires a
coordinator to be selected, we file to the CSIRT of the Member State with the
greatest number of identifiable affected users, as the Regulation directs. If the
single reporting platform is unavailable at the moment of filing, the fallback is
direct notification to the coordinating CSIRT by its published contact channel,
with the platform submission repeated once available.

### From what channel

The originating record is always the **private GitHub Security Advisory** for the
issue on this repository. That advisory is the single source of truth for
affected versions, severity, and remediation status; the ENISA submissions are
generated from it, and the advisory is annotated with the submission timestamps
and reference numbers so the trail is auditable after the fact.

### The clocks

| Deadline | From | What is filed |
|---|---|---|
| **24 hours** | Becoming aware of the actively exploited vulnerability or severe incident | **Early warning.** Minimal facts: that the vulnerability is being actively exploited, whether it is believed to be exploitation by a malicious actor, and which Member States we believe are affected. Deliberately terse; incomplete information is expected at this stage and is not a reason to delay. |
| **72 hours** | The same moment of awareness | **Vulnerability notification.** General information about the affected product versions, the nature of the vulnerability, its severity and impact, and any corrective or mitigating measures available or that users can apply. Updates the early warning rather than replacing it. |
| **14 days** (vulnerability) / **1 month** (severe incident) | Availability of a corrective or mitigating measure | **Final report.** A description of the vulnerability including severity and impact, information about any malicious actor exploiting it where available, and details of the security update or corrective measure made available. |

"Awareness" is dated from the moment a maintainer has enough information to
reasonably conclude that exploitation is occurring — not from the moment a report
arrives, and not from the moment a fix is understood. That timestamp is recorded
in the advisory as soon as it is set, because it is the anchor for all three
deadlines.

### Concurrent obligations

Filing to ENISA does not replace our own disclosure duties. In an actively
exploited scenario:

- The 90-day coordinated disclosure embargo in SECURITY.md **does not apply** —
  it is explicitly void for in-the-wild exploitation.
- Users are informed without undue delay, via the published GitHub Security
  Advisory (which propagates to the GitHub Advisory Database, `npm audit`,
  Dependabot and OSV) and a CHANGELOG entry, together with any mitigating
  measure available before a fix ships.
- A CVE ID is requested through GitHub Security Advisories, which is a CNA. See
  SECURITY.md § "CVE assignment and advisory publication".

## 4. Software Bill of Materials (SBOM)

A **CycloneDX SBOM is generated in CI for every release** and published as a
release asset alongside the tagged version. It covers the published package's
dependency tree in the format the CRA expects a machine-readable bill of
materials to take, and it is generated from the lockfile at build time rather
than maintained by hand.

The document itself is short, because the honest content of it is short:
**`@orbitlang/core` has zero runtime dependencies.** The published artifact
contains only first-party compiled TypeScript. Development dependencies
(TypeScript, vitest, fast-check, esbuild) are not part of the published package
and appear in the SBOM only as build-time components where the format calls for
them.

This matters more than it sounds: the most common CRA-relevant supply-chain
exposure — a transitive dependency with a known vulnerability shipping inside a
downstream product — is structurally absent here. An embedder's SBOM entry for
Orbit is a leaf.

Release artifacts are additionally published with **npm provenance attestations
via trusted publishing (OIDC)**, so the link between a published tarball and the
CI run and commit that produced it is independently verifiable.

## 5. Coordinated vulnerability disclosure policy

The project operates a documented coordinated vulnerability disclosure policy,
as required of a steward's cybersecurity policy. It is
**[SECURITY.md](../../SECURITY.md)**, and it specifies:

- The private reporting channel (GitHub private vulnerability reporting).
- A **72-hour acknowledgement** target and a 7-day triage target.
- A **90-day coordinated disclosure** window, with the conditions under which it
  is shortened (active exploitation) or extended (downstream coordination, by
  agreement, never silently).
- Explicit in-scope and out-of-scope categories.
- Credit policy and a commitment not to pursue good-faith researchers.
- The CVE request path via GitHub Security Advisories as CNA.

A `security.txt`-style pointer is not published because this project distributes
no hosted service; the repository's Security tab is the canonical entry point.

## 6. Security-update support window

Stated plainly, because vagueness here is the usual failure mode:

- **Before v1.0, exactly one release line is supported at a time: the latest
  minor.** Security fixes ship as a patch release on that line. Older minors do
  not receive backports. As of this document, that line is `0.2.x`.
- **Security updates are provided free of charge** and through the same public
  npm distribution channel as ordinary releases. There is no paid tier for
  security fixes and there will not be one.
- Users are notified of security updates through the published GitHub Security
  Advisory, which reaches embedders automatically via the GitHub Advisory
  Database, `npm audit`, Dependabot and OSV, plus a `### Security` section in
  CHANGELOG.md.
- **A defined support period lands at v1.0.** The CRA expects a support period
  reflecting the product's expected lifetime, with five years as the reference
  point for products with a longer lifetime. The project intends to commit to a
  concrete, written support period for the 1.x line at the v1.0 release,
  alongside the stability policy and the normative specification. Committing to a
  multi-year window for a pre-1.0 engine whose output bytes are still allowed to
  change would be a promise made for the sake of a compliance checkbox, so it is
  deliberately deferred to the release that can honor it.
- **End-of-life notice:** when a release line stops receiving security fixes,
  that is announced in CHANGELOG.md and in the repository's README support
  table at the time it happens, not retroactively.

## 7. Technical documentation and secure-by-design posture

Full manufacturer technical documentation is not a steward obligation, but the
substance the essential requirements ask about is published rather than absent:

| CRA theme | Where it lives |
|---|---|
| Secure-by-default configuration | Every budget has a bounded default; caps are enforced at construction and at runtime. See `src/limits.ts` and the README security invariants. |
| Attack-surface minimization | Zero runtime dependencies, zero I/O, no DOM, no Node built-ins, closed element/attribute allowlists, no dynamic evaluation. |
| Protection against unauthorized access | The engine has no ambient authority whatsoever; everything reachable from a template is declared by the host through a `TypeRegistry` and typed host filters. |
| Integrity of stored artifacts | `loadCheckedAst` structurally re-validates any stored AST against the same allowlists and caps the parser enforces. |
| Availability / DoS resistance | Non-Turing-complete grammar plus fuel, a single global iteration counter, wall-clock deadline, output cap and per-value caps; no regex anywhere, so no catastrophic backtracking. |
| Vulnerability handling process | SECURITY.md; advisories on the repository; CVE via GitHub as CNA. |
| Claims are verifiable, not asserted | [`claims.md`](./claims.md) maps every capability and security claim in the docs to the test or artifact substantiating it, checked in CI. |

## 8. Known limitations of this readiness statement

In the spirit of the rest of this repository:

- The steward declaration is the maintainers' own assessment. It has not been
  reviewed by counsel or confirmed by a market surveillance authority.
- No third-party security audit has been performed. One is planned for v1.0.
- The 24/72/14 workflow has been documented and rehearsed on paper; it has not
  been exercised against a real actively exploited vulnerability, because there
  has not been one.
- The ENISA single reporting platform's exact submission interface may change
  before 11 September 2026. This document names the destination and the
  originating record; the mechanical steps will be updated when the platform's
  final interface is published.
