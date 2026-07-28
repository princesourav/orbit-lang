# The Orbit Language Specification

**Version 1.0-draft** · Corpus version 1 · 2026-07-28

## Status

This is the normative specification for Orbit. Where it and an implementation
disagree, this document and the [conformance corpus](../conformance/) are
authoritative — with one exception stated in §9.

Key words **MUST**, **MUST NOT**, **SHALL**, **SHOULD** and **MAY** are used as
in RFC 2119.

## 1. Scope and design constraints

Orbit is a template language for producing HTML fragments. It is designed for
the case where the template author is not trusted: a merchant, a customer, a
language model, or anyone whose output is rendered next to other tenants'.

Four constraints follow from that, and every rule below serves one of them.

1. **Termination.** Every render **MUST** terminate. The language provides no
   recursion, no user-defined functions, and no loop whose bound is not a
   compile-time literal.
2. **Escaping is structural.** The escaping context of every interpolation
   **MUST** be determined by its position in the syntax tree, before any value
   exists. An implementation **MUST NOT** select escaping by inspecting a value
   at runtime.
3. **Closed allowlists.** Elements, attributes and URL schemes are permitted by
   enumeration. An implementation **MUST** reject anything not enumerated.
4. **Determinism.** The same program, data and options **MUST** produce
   byte-identical output.

## 2. Documents

A template is a UTF-8 text file consisting of frontmatter followed by a body.

Frontmatter is **REQUIRED**. An implementation **MUST** reject a template whose
first non-trivia content is not a `---` fence (`O1030`). Only whitespace and
`{# … #}` comments **MAY** precede it; an HTML comment **MUST NOT**.

Frontmatter declares exactly one of `component PascalName` or `page lowername`,
and **MAY** declare `props`, `settings` and `slots` blocks. Prop and setting
defaults **MUST** be literals.

A `page` **MUST NOT** be called by another template and **MUST NOT** declare
slots. An implementation **MUST** reject props on a `page`.

The full grammar is normative and given in
[docs/reference/grammar.md](../docs/reference/grammar.md).

## 3. Escaping

### 3.1 Contexts

An implementation **MUST** recognize exactly six contexts:

| Context | Assigned when the interpolation is | Escapes |
|---|---|---|
| TEXT | element content | `&` `<` `>` |
| RCDATA | content of `title` or `textarea` | `&` `<` |
| ATTR | any attribute value | `&` `"` `<` `>` |
| URL-ATTR | the value of a URL-bearing attribute | §3.3, then ATTR |
| JSON-LD | inside `<json-ld>` | §3.4 |
| RAWTEXT | — | unreachable |

### 3.2 RAWTEXT is unreachable

RAWTEXT **MUST** be unreachable by construction. Because `script` and `style`
are absent from the element allowlist (§4), no syntactically valid program
places an interpolation in a rawtext context.

An implementation validating a stored syntax tree **MUST** reject a node
declaring a `rawtext` content model, even though the parser cannot produce one.
This is defence against a tampered stored tree, not against a template.

### 3.3 URL sinks

An implementation **MUST** apply the following to the value of a URL-bearing
attribute, at emission, in this order:

1. Remove all C0 control characters and DEL. This **MUST** happen **before**
   scheme detection, so that `java\tscript:` and similar splits are defeated.
2. Accept the value if its scheme, compared case-insensitively, is `http`,
   `https`, `mailto` or `tel`; or if it is site-relative (`/`), `./`, `../`,
   begins `?` or `#`, or has no scheme.
3. Reject a protocol-relative value (`//host`).
4. Accept `data:` **only** when the media type begins `image/` **and** the
   attribute is `src`.
5. Otherwise reject.

A rejected value **MUST** either be replaced with `#` and reported as a
non-fatal warning, or fail the render — selectable by the host. The default
**SHOULD** be replacement.

An implementation **MUST NOT** treat a value's static type as evidence that it
is a safe URL. The check is a property of the sink, not of the value.

`srcset` **MUST** be parsed as a comma-separated candidate list, each URL
sanitized independently, and each descriptor validated as digits followed by
`w` or `x`.

The URL-bearing attributes are exactly: `href`, `src`, `srcset`, `action`,
`formaction`, `poster`, `cite`.

### 3.4 JSON-LD

`<json-ld>` takes exactly one record expression. An implementation **MUST**
serialize it as JSON in which `<`, `>`, `&`, `/`, U+2028 and U+2029 are emitted
as `\uXXXX` escapes, so the payload cannot terminate the element containing it.
Only primitives, records, lists and `Url` **MAY** appear; `Html` **MUST** be
rejected. Nesting depth **MUST** be bounded.

### 3.5 Attribute quoting

Attribute values **MUST** be emitted double-quoted. An implementation **MUST**
reject single-quoted attributes in source. This makes the ATTR escaper's
obligation total rather than dependent on the quoting style in use.

## 4. Allowlists

An implementation **MUST** enumerate permitted elements and reject any other
(`O1081`). The following **MUST** be rejected with a distinguishable diagnostic
(`O1080`): `script`, `style`, `iframe`, `object`, `embed`, `applet`, `base`,
`meta`, `link`, `template`, `noscript`, `svg`, `math`, `frame`, `frameset`,
`portal`.

`html`, `head` and `body` **MUST NOT** be permitted: a template produces a
fragment, and the document shell belongs to the host.

Attributes **MUST** likewise be enumerated, with the `data-*` and `aria-*`
families permitted by prefix. The following **MUST** be rejected: every `on*`
attribute, `srcdoc`, `ping`, `background`, `longdesc`, and any namespaced name.

An implementation **MUST NOT** support dynamic attribute names or attribute
spreading.

A `style` attribute **MUST** be entirely static; an interpolation within one is
a parse error. Orbit specifies no CSS escaper, and an implementation **MUST
NOT** invent one.

## 5. Types

### 5.1 The optional law

A value of type `T?` **MUST NOT** be used where `T` is required — rendered,
passed to a filter, used as an operand, or compared — unless it has been given a
fallback with `??` or narrowed.

Narrowing **MUST** be sound. An implementation **MUST** narrow on `x != none`
within the guarded branch, **MUST** propagate narrowing through `&&` to the
right operand, and **MUST NOT** narrow through `||`. Narrowing **MUST** be
discarded when the name is rebound.

### 5.2 No truthiness

The condition of `<if>`, of a ternary, and the operands of `&&`, `||` and `!`
**MUST** be `Bool`. An implementation **MUST NOT** define a truthiness
conversion for any other type.

### 5.3 Terminal types

| Type | Constraints |
|---|---|
| `Money` | **MUST NOT** render, and **MUST NOT** admit operators, properties, equality, or stdlib filters. |
| `MoneyText` | Renders in content and attributes; **MUST NOT** admit filters. |
| `Url` | Renders; valid in URL attributes and JSON-LD. Carries no safety guarantee (§3.3). |
| `Image` | **MUST** be host-filter input only. |
| `Html` | **MUST** render only as element content. **MAY** be a component prop type and be passed to a prop declared `Html`. **MUST NOT** appear as a binding, an attribute value, in RCDATA, or in JSON-LD, and **MUST NOT** be a filter operand except as the first argument of an `htmlTransform` filter. **MUST NOT** be nested inside an optional, list or record. **MUST NOT** be host-declarable as a data type. |

The only producer of `Html` **MUST** be a host filter, and every
`Html`-returning filter **MUST** declare exactly one of three obligations. An
implementation **MUST** reject a declaration that names none, names more than
one, or names any of them on a filter that does not return `Html`.

| Flag | The host undertakes | Implementation MUST warn at use sites |
|---|---|---|
| `sanitizer` | input is untrusted; this filter sanitizes it | no |
| `trustedHtml` | input is trusted by host fiat; emitted raw | **yes** |
| `htmlTransform` | `Html` in, `Html` out; well-formedness preserved | no |

An implementation **MUST NOT** warn at the use sites of a `sanitizer` or
`htmlTransform` filter. Warning on correct code devalues the warning that marks
code a human must inspect, and an implementation that warns on everything has
produced a census rather than an audit.

The restriction that an `Html` value is element-content-only **MUST** hold
transitively: it applies to a value that arrived through a component prop
exactly as to one produced by a filter in the same expression. An implementation
**SHOULD** achieve this by checking the type at each sink rather than tracking
the value's origin.

An implementation **MUST** carry the `trustedHtml` obligation with the value, so
that it is still known at a sink the value reached through a component prop.

### 5.4 Arithmetic

`/` **MUST** yield `Float` for all operands, including two `Int`s. `%` **MUST**
be `Int`-only. `+` **MUST NOT** concatenate strings.

### 5.5 Exhaustiveness

`<match>` selects one arm by exact string equality against its subject. An
implementation **MUST** reject a subject that is neither a `String` nor a
string-literal union, and **MUST** apply §5.1 to the subject.

When the subject is a **union**, an implementation **MUST** reject:

- a `<match>` that omits an arm for any variant, naming the omitted variants;
- a default arm, whether or not the other arms are complete. A default arm
  would absorb variants added later, which is the property this construct
  exists to provide.

When the subject is a plain `String`, an implementation **MUST** require a
default arm: a `String` is not a closed set, so the arms cannot be proven to
cover it.

An implementation **MUST** reject an arm that can never be selected: one whose
value repeats an earlier arm, one whose value is not a variant of the union, and
any arm following the default arm.

Arm order **MUST NOT** affect which arm is selected. There is no fallthrough.

If no arm matches at render time and there is no default arm, an implementation
**MUST** fail the render. The arms were proven to cover the type, so this state
means the host supplied a value outside the type it declared, and rendering
nothing would hide it.

### 5.6 Filter arguments

A host filter declares an ordered list of **required** parameters and an ordered
list of **optional** parameters, each optional parameter carrying a name.

An argument at a call site is either positional or named (`name: value`). An
implementation **MUST** bind them as follows:

1. Positional arguments fill parameter slots in order, required slots first,
   then optional slots.
2. A named argument fills the optional slot with that name.
3. A positional argument **MUST NOT** follow a named one. This is a syntax
   rule, so an implementation **MUST** reject it without consulting the host.
4. Two arguments **MUST NOT** bind to the same slot, whether by repeating a
   name or by naming a slot a positional argument already filled.
5. A name that matches no optional parameter **MUST** be rejected. Required
   parameters are positional-only and are therefore never matched by name.
6. Arity **MUST** be judged on the count of POSITIONAL arguments. Named
   arguments each occupy a distinct optional slot, so they can neither overflow
   the parameter list nor satisfy a required parameter.

Arguments **MUST** be evaluated in written order, independently of the slots
they bind to.

An optional parameter that no argument bound to **MUST** be passed to the host
implementation as the absent value. Because §5.1 forbids an optional operand,
no argument can itself be absent, so an absent parameter slot is unambiguous.

Filters other than host filters have no named parameters, and an implementation
**MUST** reject a named argument passed to one.

## 6. Evaluation

### 6.1 Budgets

An implementation **MUST** enforce, per render:

- a **fuel** budget charged per emitted code unit plus a fixed per-element cost,
  and charged for filter output whether or not it is emitted;
- a **single global iteration counter**, charged for every loop iteration and
  every component call, and shared across nesting so that nested constructs
  cannot multiply the budget;
- a **wall-clock deadline**, evaluated against an injected clock;
- an **output size** cap;
- **per-value caps** on string length and list length, checked at every filter
  step.

An empty loop body **MUST** still charge the iteration counter.

Exceeding any budget **MUST** fail the whole render. An implementation **MUST
NOT** return partial output.

Published cap values are **minimums**: a conforming implementation must bound
each quantity, and a host **MAY** configure lower values.

### 6.2 Determinism and statelessness

Rendering **MUST** be a pure function of program, bindings, settings and
options. An implementation **MUST NOT** retain state between renders, and the
injected clock **MUST** be used only to detect deadline expiry — its value
**MUST NOT** reach output.

### 6.3 Component graph

The component call graph **MUST** be acyclic. An implementation **MUST** reject
a cycle at check time and **SHOULD** report the cycle path.

## 7. Whitespace

Within a text run, each maximal run of whitespace **MUST** collapse to a single
space, and leading and trailing spaces **MUST** be preserved. A text run
consisting entirely of whitespace **MUST** be dropped.

Text within `<pre>`, and within a subtree marked `verbatim`, **MUST** be
preserved exactly.

These rules are what make source formatting a decidable problem; see
[the formatter](../src/formatter.ts).

## 8. Stored syntax trees

A serialized syntax tree is executable, and an implementation **MUST** treat it
as untrusted input. Loading one **MUST** re-validate: format version, node and
expression kinds against an allowlist, element and attribute names against the
same closed tables the parser uses, content-model consistency (rejecting
`rawtext`), loop-limit literals, name shapes, and every depth and size cap.

An implementation **MAY** offer an unchecked load, which **MUST** be named so
that its use is conspicuous in review.

Integrity of the stored tree is the host's responsibility. An implementation
**SHOULD** provide canonicalization and constant-time tag comparison, and
**MUST NOT** hold key material.

## 9. Conformance

An implementation conforms when it reproduces every expectation in the
[conformance corpus](../conformance/). The corpus is normative for observable
behaviour: rendered bytes, diagnostic codes, and warning codes.

**The exception.** The corpus expectations were captured from the reference
implementation, so the corpus proves self-consistency, not correctness. Where
the corpus and this prose disagree, **this document governs and the corpus is
in error** and must be regenerated after the implementation is fixed.

Independent evidence for the escaping rules comes from differential testing
against a WHATWG HTML parser; see
[conformance/differential.test.mjs](../conformance/differential.test.mjs).

### 9.1 Known divergence

Orbit emits U+0000 as bound. A conforming HTML parser does not preserve it:
in character data the token is ignored, and in attribute values and RCDATA it
is replaced with U+FFFD. An implementation **MAY** emit the byte unchanged.
This is documented rather than specified away because it is a difference
between emitted bytes and the resulting DOM, and implementations should know
about it.

### 9.2 Non-goals

An implementation is **not** required to defend against:

- **Downstream transformation.** Output is correct for the context it was
  emitted into. A rewriter, sanitizer or email client applied afterwards owns
  its own outcome.
- **Host authorization.** The engine renders what it is given.
- **Host filter defects.** A `sanitizer` is only as good as the sanitizer
  behind it, a `trustedHtml` filter emits whatever it is given, and an
  `htmlTransform` that slices markup mid-tag changes how the remainder of the
  document parses. Each obligation is the host’s to keep; the engine records
  which one was claimed.
- **Request-rate exhaustion.** Budgets bound one render.

## 10. Versioning

### 10.1 Language versions

The language is versioned separately from any implementation. A template **MAY**
declare the version it targets with an `orbit <version>` frontmatter pragma;
omitting it **MUST** mean the implementation's default version.

An implementation **MUST** reject a template declaring a version it does not
implement, and **SHOULD** report the versions it does. Rendering a template
written against a later language under whatever rules the implementation happens
to have is a worse outcome than a parse error.

A stored syntax tree (§8) **MUST** carry its language version, and loading one
whose version the implementation does not implement **MUST** fail.

Language versions **MUST NOT** fork the security rules: a security change under
the exception below applies to every version.

### 10.2 Implementation versions

Within a major version, an implementation **MUST NOT** change rendered bytes for
a program that previously rendered successfully, **MUST NOT** repurpose a
diagnostic code, and **MUST NOT** narrow the accepted language.

An implementation **MAY** tighten a security-relevant rule in a patch release
when doing so rejects a program that was previously accepted, provided the
change is documented. Rejecting an unsafe program is not a compatibility break
worth preserving.

See [STABILITY.md](../STABILITY.md).
