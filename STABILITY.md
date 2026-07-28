# Stability policy

What Orbit promises not to break, and what it explicitly reserves the right to
change. Read this before building a platform on the engine.

The headline, because it is the promise that matters to anyone rendering other
people's templates:

> **Upgrading the engine within a major version will not change the bytes a
> tenant's template renders.**

## What semantic versioning covers

Within a major version, a patch or minor release **will not**:

| Covered | Meaning |
|---|---|
| **Rendered bytes** | A program that rendered successfully renders identically. |
| **Accepted language** | A program that compiled still compiles. |
| **Diagnostic codes** | An `O`-code keeps its meaning. Codes are documented API. |
| **Warning codes** | Same, for the `O49xx` runtime warnings. |
| **Access-plan format** | The paths and their shape stay stable. |
| **Public API** | Every export from the package root keeps its signature. |
| **Serialized-AST format** | A stored AST written by an older version still loads. |

Message *text* is not covered — wording improves. Match on codes, never on
prose. `formatDiagnostic` output is for humans; `--format json` and the
`Diagnostic` object are for programs.

## The one deliberate exception

**A security fix may reject a program that previously compiled**, in a patch
release, and this is not treated as a compatibility break.

If a construct is found to be unsafe, continuing to accept it in order to
preserve compatibility would mean knowingly shipping a vulnerability to every
tenant. Rejecting an unsafe program is not a break worth preserving.

Such a change will always:

- be documented in the CHANGELOG under **Security**;
- carry a diagnostic explaining what to write instead;
- be listed in the release notes with the range of affected versions.

The same applies to *tightening* a cap. Published cap values are minimums, and
a host already configures its own.

## API stability tiers

Not everything exported is equally stable.

### Tier 1 — Stable

The pipeline and the host seam. Breaking changes only in a major version.

```
parseProgram  check  serializeProgram  loadCheckedAst  render
extractAccessPlan  formatTemplate  formatProgram
TypeRegistry  t  assertValidHostFilters
signAst  verifyAstTag  astAuthMessage
formatDiagnostic  formatDiagnosticWithSource  formatDiagnostics
LIMITS  STDLIB  ELEMENT_ALLOWLIST  BANNED_ELEMENTS  URL_ATTRS
```

Plus the types naming their inputs and outputs: `Program`, `Diagnostic`,
`Span`, `RenderOptions`, `RenderResult`, `RenderWarning`, `OrbitHost`,
`HostFilterDecl`, `AccessPlan`, `Type`.

### Tier 2 — Unstable: the AST

```
Node  Expr  Attr  Template  ElementNode  IfNode  ForNode  …
EXPR_KINDS  NODE_KINDS  groupSlotChildren  slotNameOf
```

The AST is exported because tooling needs it — the formatter, the tree-sitter
grammar, a future LSP. It is **not** covered by the stability policy: adding a
language feature adds node kinds, and every grammar change would otherwise be a
major version.

If you build on the AST, pin an exact version. Ideally, build on the
conformance corpus instead, which *is* stable.

### Tier 3 — Escape hatches

```
unsafe_loadTrustedAst
```

Named to be conspicuous. It may change or disappear.

## Language versions

**The language is versioned separately from the package**, and a template
declares which version it targets:

```orbit
---
orbit 2026
component ProductCard
---
```

The two move at different speeds, and conflating them would make every engine
bug fix a potential semantic change. The rules:

- **Language semantics change only across language versions.** Within one, a
  template means what it meant. An engine upgrade cannot change it.
- **The checker rejects a version it does not implement** (`O1097`), naming the
  versions it supports. Rendering a template written against a later language
  under whatever rules this engine happens to have would be worse than any
  parse error.
- **A stored AST carries its language version**, and `loadCheckedAst` refuses
  one this engine does not implement. A stored tree outlives the engine that
  produced it.
- **Omitting the pragma means the default**, which is what every template
  written before the pragma existed implicitly targeted. The formatter writes it
  explicitly, so a formatted template always states its version.

A later engine understands earlier versions. That is what makes a change like
the v0.2 `|>` precedence fix — cheap then, expensive after 1.0 — possible at
all once themes exist: it ships in a new language version and leaves existing
templates alone.

Language versions do **not** fork the security rules. A security fix applies to
every version, per the exception above.

Supported today: `2026`.

## What "1.0" means here

It means the language and the API are frozen under this policy, the
[specification](spec/SPEC.md) is normative, and the
[conformance corpus](conformance/) defines observable behaviour.

It does **not** mean the project is finished, has an ecosystem, or has been
independently audited. Where that stands is stated in
[SECURITY.md](SECURITY.md) and the [roadmap](ROADMAP.md); this project would
rather say so than let a version number imply it.

## Support

Pre-1.0, the latest minor line receives fixes. A concrete support window ships
with 1.0 — promising one now, before there is anyone to support, would be a
claim without a commitment behind it.

Security reporting, the acknowledgement SLA and the disclosure timeline are in
[SECURITY.md](SECURITY.md).
