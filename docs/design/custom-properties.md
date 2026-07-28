# The typed custom-property sink

Design, stated before implementation, precise enough to argue with.

Phase D found 14 blocks (12.1% of a real block registry) carrying a merchant
`Color` setting with nowhere to go. This is the mechanism that closes them, and
it is deliberately the narrowest thing that does.

## The problem, restated exactly

A merchant setting of type `Color` is an arbitrary `#rrggbb`. Every existing
route to CSS is closed:

| Route | Why it fails |
|---|---|
| `style="background: {settings.accent}"` | Banned (`O1095`), and correctly — interpolated `style` is a CSS injection sink. |
| `class="bg-{settings.accent}"` | Needs one stylesheet rule per colour, over an infinite set. |
| `data-accent={settings.accent}` | Allowed, and useless. CSS cannot read a data attribute as a colour value. |
| A `trustedHtml` filter emitting `<style>` | Abuses a seam built for auditing raw markup, and warns at every use site. |

Orbit made `style` static-only for a real reason and never supplied the
replacement. This is the replacement.

## 1. Surface form

```orbit
---
component Promo
settings {
  accent: Color = #1a73e8 label "Accent"
  surface: Color = #ffffff label "Surface"
}
---
<div class="promo" --accent={settings.accent} --surface={settings.surface}>
  <p>Promo</p>
</div>
```

renders

```html
<div class="promo" style="--accent:#1a73e8;--surface:#ffffff">…</div>
```

### Why it cannot be confused with a normal attribute

**No HTML attribute may begin with `-`.** The attribute allowlist is closed and
contains nothing starting with a hyphen; the open families are `data-*` and
`aria-*`. So `--accent` is not an attribute that exists, an attribute that could
be added, or an attribute the allowlist would ever admit. It is
lexically unmistakable at the point a reader meets it, without knowing this
document.

It also reads as what it becomes. `--accent` in the template is `--accent` in the
CSS, which is the whole point: an author who knows CSS custom properties already
knows what this does.

### Rules on the form

- **The property name is static.** It is written literally in the template and
  can never be interpolated. `--{name}={value}` is a parse error. A dynamic
  property name is a new injection surface for the same reason a dynamic
  attribute name would be.
- The name after `--` matches `[a-zA-Z0-9_-]+` — CSS's own ident set, minus
  anything requiring escape analysis.
- The value is an expression, in braces, exactly like any other typed attribute.
- Multiple custom properties on one element are permitted and emit in written
  order.
- An element may carry both a static `style` and custom properties. The static
  text is emitted first, then the properties, in one `style` attribute. The
  static half is already parse-time-validated as interpolation-free, so nothing
  about merging weakens it.

## 2. The escaping micro-context

This is a **seventh context**, not a reuse of ATTR. A custom property value is
substituted by the browser into arbitrary later CSS positions — it can end up in
a `color`, in a `background`, inside `calc()`, inside a `url()` if a stylesheet
says so. What is safe in an attribute is not automatically safe there, so it gets
its own analysis and its own entry in the escaper.

The analysis is unusually short, because the context is defined by what may
**enter** it rather than by what must be escaped on the way out.

| Permitted in CSS-CUSTOM-PROPERTY | |
|---|---|
| `#` | exactly one, in position 0 |
| `0`–`9`, `a`–`f`, `A`–`F` | exactly six, in positions 1–6 |
| **everything else** | **rejected — cannot be emitted** |

That is the complete table. Length is exactly 7. There is no escape function for
this context, because there is nothing to escape: no character outside the set
above can reach the sink at all. A transformer converts hostile input into safe
output; this is a **validator**, which refuses it.

That distinction is the entire safety argument, and it is why the design does not
generalise (see §3).

### Validated at the sink, not trusted from the type

The value's declared type is **not** evidence that it holds a valid colour.
`isHexColorLiteral` is applied to merchant settings and component-entry props,
but a `Color` arriving as a page binding or as a field of a host object reaches a
sink unvalidated today — verified, and recorded in
[closed-world.md](../evaluation/closed-world.md). A sink that trusted the type
would inherit that hole.

So the sink revalidates at emission and **fails the render** when the value is
malformed, rather than emitting or substituting. This follows the rule the
project already applies to URLs — "sanitization happens at the sink and is never
trusted from the `Url` type" (SPEC §3.3) — and the rule the Html trust model
turns on: sinks are type-directed *at the sink*.

Emission is then: validate, then pass the value through the ordinary attribute
escaper on the way into `style="…"`. The second step is redundant for a value
that passed the first — `#0a0a0a` has nothing to escape — and it is there so that
two independent things must both fail before anything reaches the page.

## 3. Types admitted, in v1

**`Color`, and nothing else.**

Not a `String`. Not a host opaque type. Not `Html`, `Url`, `Money`, `MoneyText`,
`Image`, `Int`, `Float`, `Bool`, a list, a record, an object, a union, or an
optional of any of those.

`Color` is admissible because its values are **exactly six hex digits after a
`#`** — a closed lexical form the engine can enumerate completely, which is what
makes the table in §2 total rather than best-effort.

**That argument does not transfer, and this is not a general terminal-type
sink.** `Length` admits units, `calc()`, and scientific notation. `FontFamily`
admits quoted strings with escapes. A background URL admits everything the URL
sink already spends 60 lines on, in a context where `url()` parsing differs from
attribute parsing. Each needs its own lexical analysis, and none of them is on
Phase D's measured critical path. Adding one later is a decision with its own
evidence requirement, not an extension of this one.

### The test that proves nothing else can reach it

A hand-picked sample of rejected types proves that those samples are rejected. It
does not prove the set is closed, and it silently stops covering the language the
day someone adds a type.

So the test is **driven from the exhaustive list of type kinds**: it enumerates
every constructor in `types.ts`, admits exactly the ones on the allowed list, and
asserts every other one is rejected at check time. A new type added to the
language fails this test until someone decides, in writing, which side it is on.

## 4. What stays banned

`O1095` is unchanged. Interpolated `style` is still a parse error. This form is a
carve-out of exactly one shape — a static `--name` bound to a value of an
enumerated closed-lexical-form type — and nothing wider.

The distinction is not cosmetic. `style="color: {x}"` puts an arbitrary string in
a CSS *declaration* position, where it can close the declaration and open
another. `--accent={x}` puts a validated seven-character token in a *value*
position that has already been proven to contain nothing but hex digits.

## 5. Diagnostics

| Code | When |
|---|---|
| `O1113` | The property name is malformed, or interpolated. Parse time. |
| `O2115` | The bound value is not an admitted type. Check time, naming the type it found and the types the sink admits. |
| `O4044` | The value was not a valid `Color` at render time — the host data contradicts its declared type. Fails the render. |

## 6. Acceptance

- A `Color` setting reaches a custom property and renders as `--accent:#1a73e8`.
- `String`, `Html`, host opaque types and every other type kind are rejected at
  check time, driven from the exhaustive kind list.
- A non-literal property name is rejected at check time.
- Interpolated `style` is still rejected, `O1095` unchanged.
- **Property test:** no value reachable through this sink can terminate the
  property declaration or the `style` attribute. Generated adversarial `Color`
  values include ones that would break out if the validator were soft — the
  test that would have caught the v0.1 hollow validator.
- **Differential test** against a real CSS parser, in the style of the parse5
  escaper suite: the emitted `style` attribute parses to exactly the declarations
  intended, and no more.
- Conformance category `custom-properties`, with the closed-lexical-form rule
  stated in prose in `conformance/README.md`.
