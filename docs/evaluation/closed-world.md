# Phase D — does the closed world hold?

The roadmap before this report optimized for language credibility. Language
credibility is not the existential risk. The risk is whether real storefronts
can be built at all in a language with no escape hatch — and nothing else in the
roadmap finds that out.

This is the falsification test. It measures an existing, complete storefront
platform against Orbit as it stands, and reports the number honestly, including
where the number is bad.

## The number

**17.2% of theme functionality requires something Orbit cannot express today.**

Per theme, against the blocks each one actually composes:

| Theme | Blocks | Needs an escape hatch | Rate |
|---|---|---|---|
| Aurora (flagship) | 15 | header, product-grid, buy-box, collection-banner | **26.7%** |
| Scholar (education) | 17 | header, product-grid, buy-box, collection-banner | **23.5%** |
| Landmark (real estate) | 15 | header, product-grid, buy-box, collection-banner | **26.7%** |
| Whole block registry | 116 | 20 blocks | **17.2%** |

The brief set the decision thresholds at "under ~5% → proceed" and "around 20% →
stop and report". **This is the stop-and-report case.** What follows is the
report, and the reason the conclusion is nevertheless *proceed, with two
specific changes* rather than *change the architecture*.

## What was measured, and against what

**Subject:** the CommerceOS block registry — 116 blocks across 34 modules, 9,519
lines, the complete section library behind five shipped themes. This is not a
sample or a reconstruction; it is the actual thing merchants compose storefronts
from.

**Method:** each block was classified by what its render genuinely needs, by
following the block's `Component()` through the view components it delegates to
(the hooks live in `slideshow-view.tsx`, `cart-flyout.tsx` and friends, not in
the block definitions, so a scan that stops at the definition reports zero
interactivity and is wrong). Signals: client state and event handlers, raw HTML,
`<style>` injection, inline `<svg>`, network calls, and the *type* of every
merchant setting — because a setting's type decides whether its value can reach
CSS as a class.

**Then the classification was tested by doing the work.** Aurora's home and
product pages are ported to Orbit in `evaluation/aurora/`, and
`evaluation/aurora/port.test.mjs` parses, checks, renders and format-checks them
on every CI run. A claim below that something "ports cleanly" is not an opinion;
it fails the build the moment it stops being true.

**The host was constrained on purpose.** A host may declare any filter it likes,
so an unconstrained host makes every gap disappear — the measurement would
prove nothing. The rule used: a filter is allowed if a platform would plausibly
ship it as part of its object model (`money`, `imgUrl`, `richtext`,
`percentOff`). A filter invented to paper over a language gap is not allowed,
and every place the port wanted one is recorded below instead.

## What does not count as an escape hatch

Four things look like gaps and are not, and separating them is most of the work
of getting an honest number.

**Sanitized merchant markup — 20 blocks (17.2%).** Product descriptions and rich
text run through `markdownToSafeHtml` in the original. Orbit has exactly this:
a host filter declaring `sanitizer`, returning `Html`, silent at every use site
because it is the sanctioned path. Ported unchanged. *Not a gap.*

**Structured data — 1 block.** The buy box hand-builds a JSON string inside a
`<script>` tag. Orbit's `<json-ld>` takes a typed record and serializes it, so
the port is both shorter and checked. *Not a gap — an improvement.*

**Component-scoped `<style>` — 22 blocks (19.0%).** Blocks inject their own CSS
because React components ship their own styles. Orbit bans the `style` element,
so a theme ships a stylesheet instead. The CSS still exists and says the same
thing; it moves from 22 string literals into one reviewable file. This is a
build-shape difference, not a capability difference. *Not a gap.*

**Inline `<svg>` — 20 blocks (17.2%).** `<svg>` is banned (`O1080`: svg
re-admits `script`, `foreignObject` and `javascript:` URLs). Icons become
`<img src="/icons/truck.svg">`, and `mask-image` with `background-color:
currentColor` restores the one thing an `<img>` otherwise loses — following the
text colour. The port does this for the trust bar's four icons. It costs a
request per icon unless they are sprited. *Not a gap — a technique change, and
the security argument for the ban is sound.*

Counting these as gaps would have produced 28.4%. They are not gaps, and a
report that inflated the number to look rigorous would be worse than useless.

## What is genuinely missing

### 1. Client interactivity — 7 blocks (6.0%)

`appointment-widget`, `product-grid`, `buy-box`, `product-carousel`,
`slideshow`, `social-share`, `header`.

Seven blocks out of 116 is a small number that badly understates the problem,
because of *which* seven. Strip the vertical-specific ones and what remains is
the header, the product grid and the buy box — the three blocks every storefront
has on every page. Every theme measured needs all three. The interactive surface
is not a long tail; it is the checkout path.

What the port had to do instead:

| Original | Port | Cost |
|---|---|---|
| Cart flyout drawer | Link to `/cart` | Full page load |
| Live search suggestions | GET form to `/search` | No suggestions |
| Mobile nav drawer | `<details>` / `<summary>` | No focus trap, no scroll lock |
| Wishlist heart | *omitted* | Feature lost |
| Variant picker | One link per option value | Full page load per click |
| Add to cart | POST form | Navigates instead of a drawer |
| Newsletter inline confirm | POST form | Navigates |
| Slideshow | Scroll-snap row | No autoplay, no counter |

Every row is a working, correct, progressively-enhanced page. Several are what a
good storefront degrades to with JS disabled. None is what a merchant paying for
a storefront expects in 2026.

**But none of these is a missing filter, a missing type, or a missing operator.**
Each is the same missing thing, seven times: a way for a theme to say *put the
platform's cart drawer here*. That is one mechanism, and the settled position is
already that Orbit ships JavaScript — what it forbids is **author-written** JS in
themes. A platform-owned island, placed by the theme and configured through
typed attributes, closes all seven without weakening a single language rule.

This finding does not argue for an escape hatch. It argues that the island
mechanism is not a Phase E nice-to-have; it is the thing standing between the
language and a shippable storefront, and it should be sequenced first.

### 2. Per-instance colour — 14 blocks (12.1%)

`reading-progress`, `collection-banner`, `usp-strip`, `sale-strip`,
`announcement-rotator`, `split-hero`, `typographic-hero`, `marquee`,
`countdown-banner`, `app-badges`, `community-stats`, `social-share`,
`founder-note`, `pull-quote`.

This one is a genuine language gap, and unlike the first it has no plan behind
it.

A merchant setting of type `Color` is an arbitrary `#rrggbb`. Getting it onto
the page means one of:

- `style="background: {settings.accent}"` — **banned** (`O1095`), correctly:
  interpolated `style` is a CSS injection sink.
- `class="bg-{settings.accent}"` — needs a stylesheet rule per colour, and the
  set is infinite.
- `data-accent={settings.accent}` — **allowed, and useless**: CSS cannot read a
  data attribute as a colour value.
- A `trustedHtml` host filter emitting a scoped `<style>` block — technically
  in-language, and an abuse of a seam built for auditing raw markup. It warns at
  every use site, which is the correct behaviour for that seam and the wrong
  experience for setting a background colour.

Note the difference from `Range`. A `Range(0, 64, step: 8)` is nine values, so
`data-padding={settings.padding}` plus nine stylesheet rules works — verbose,
mechanical, fine. 38 blocks (32.8%) have a range setting and none of them is a
gap. `Color` is unbounded, and that is the whole difference.

The honest framing: Orbit made `style` static-only for a real reason, and then
did not supply the replacement. **A typed custom-property sink** — a way to say
"this `Color` becomes `--accent` on this element", where the engine emits
`style="--accent:#1a73e8"` after validating that the value is a `Color` and the
name is a custom property — would close this with no new injection surface,
because `Color` is already a terminal type whose values are exactly six hex
digits. That is a language change and it is not on any roadmap. It should be.

### 3. Fidelity losses that are not gaps

Recorded so the report is not read as "everything else was free":

- Icons cost an extra request each (`<img>` instead of inline `<svg>`).
- Range-driven styling costs one stylesheet rule per step.
- Carousels become scroll-snap rows.
- Every form submission navigates.

## What the port found that the classification did not

Three things only showed up by writing the templates and compiling them.

**Narrowing is stronger than defensive habits.** The port was written with
`{product.compareAt ?? product.price}` inside `<if {product.compareAt != none}>`.
Orbit rejected the `??` as dead code (`O2072`) — the guard had already narrowed
it. Six of these were removed. The port is shorter than it was written, and the
diagnostic was right every time.

**`<match>` is better than the thing it replaces.** The original renders a badge
with `badge === 'sale' ? … : null`, which silently renders nothing for a badge
type added later. The port's `<match {product.badge}>` fails the build by name
when the platform adds a fifth badge. This is the one place the port is strictly
better than the original rather than equal or worse.

**Conditional props are rejected on components** (`O2092`). `eager?={i < 4}`
must be `eager={i < 4}`. Documented, and a five-second fix, but it is the kind of
paper cut a theme author hits on day one.

**The port raises zero warnings.** Not one use of the `trustedHtml` seam was
needed. The rich-text path is a `sanitizer`, and nothing in two full pages had to
reach past it.

## Verdict

The closed-world premise **holds for content and breaks for commerce
interaction.**

93% of the block registry needs no client JavaScript at all — that is the finding
that matters, and it is the opposite of what a sceptic would predict. The
storefront is overwhelmingly a rendering problem, and a language that renders
well and refuses to execute covers it.

The 17.2% that fails divides cleanly:

- **6.0% is interactivity**, and the answer is already designed. Platform-owned
  islands, placed by the theme, configured through typed attributes, with no
  author-written JS anywhere. This does not loosen a language rule. It should be
  built first, not third.
- **12.1% is per-instance colour**, and the answer does not exist yet. It needs a
  typed custom-property sink — a small, specific language addition that stays
  inside the type system rather than reopening `style`.

Neither conclusion is "add an escape hatch". An escape hatch would trade the
project's one defensible property — that nobody can inject script through a
theme — for two problems that each have a typed, closed-world answer.

**Recommendation: proceed, with the sequence changed.** The island mechanism and
the custom-property sink move ahead of further hardening. Hardening a language
that cannot express a cart drawer is the wrong use of the next two quarters; the
brief's own reasoning applies to the ordering as much as to the decision.

## Reproducing this

```
# the port itself — compiles, renders, format-checks
npx vitest run evaluation/aurora/port.test.mjs
```

The port lives in `evaluation/aurora/`: a realistic host object model
(`host.mjs`), three components, and two pages. The per-block classification was
produced by following each block's render through its view components in the
CommerceOS repository; the counts in this report are the ones that scan
produced, and the theme compositions are read from
`packages/theme-schema/src/default-theme.ts` and `industry-themes.ts`.

The measurement is of one platform's block library. It is the platform Orbit
exists to serve, which makes it the right subject and also the limit of the
claim: this is evidence about CommerceOS storefronts, not a general result about
every template language's every user.
