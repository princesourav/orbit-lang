# Components and pages

Every template is one or the other, declared in frontmatter.

```orbit
---
component ProductCard
props {
  product: Product
  showVendor: Bool = false
}
---
<article class="card">
  <h3>{product.title}</h3>
</article>
```

| | `component` | `page` |
|---|---|---|
| Name | PascalCase | lowercase |
| Called by other templates | yes | **no** |
| Receives `props` | yes | no |
| Receives host bindings | no | yes |
| Declares `slots` | yes | no |

A page is an entry point: the host binds top-level data to it. A component is
reusable and receives everything through props. Pages cannot be called and
cannot declare slots — a page reached by two different routes would otherwise
have two different contracts.

## Props

Props are typed, and may have a literal default:

```orbit
---
component Badge
props {
  label: String
  tone: String = "info"
  count: Int?
}
---
<span class="badge badge--{tone}">
  {label}
  <if {count != none}>({count})</if>
</span>
```

Defaults must be **literals** — a default that could run code is a default that
runs at every call site, invisibly.

Calling it:

```orbit
---
page shop
---
<Badge label="New"/>
<Badge label="Sale" tone="warning"/>
```

The checker verifies each call: a missing required prop, an unknown prop, or a
type mismatch is an error naming the prop, with a did-you-mean suggestion for
near-misses.

A bare prop means `true`:

```orbit
---
component Card
props {
  product: Product
  showVendor: Bool = false
}
---
<article>
  <h3>{product.title}</h3>
  <if {showVendor}><p>{product.vendor ?? "Unbranded"}</p></if>
</article>
```

```orbit
---
page shop
---
<for product of={collection.products}>
  <Card product={product} showVendor/>
  <empty><p>none</p></empty>
</for>
```

Conditional props (`prop?={...}`) are rejected on component calls — a prop that
sometimes does not exist would make the callee's contract conditional.

## Slots

Slots let a caller pass markup in.

```orbit
---
component Panel
slots {
  header
  footer?
}
---
<section class="panel">
  <header><slot name="header"/></header>
  <div class="panel__body"><slot/></div>
  <footer><slot name="footer"/></footer>
</section>
```

`header` is required; `footer?` is optional. `<slot/>` is the default slot.

The caller fills them with a static `slot=` attribute:

```orbit
---
page shop
---
<Panel>
  <h2 slot="header">Featured</h2>
  <p>This goes to the default slot.</p>
  <small slot="footer">Terms apply.</small>
</Panel>
```

A missing required slot, or a fill targeting a slot that does not exist, is a
compile error.

**Slot content renders in the caller's scope.** It can see the caller's data,
not the component's internals. That is what keeps a component's props from
leaking into markup it did not write.

There is no fallback content inside `<slot/>` in this version.

### Slot transparency

`<if>` and `<for>` wrappers are transparent for slot assignment, provided every
element they render targets the *same* slot:

```orbit
---
page shop
---
<Panel>
  <h2 slot="header">Featured</h2>
  <if {collection.title != ""}>
    <p slot="footer">{collection.title}</p>
  </if>
</Panel>
```

If a wrapper's branches target different slots, that is an error (`O2085`) —
the assignment would depend on runtime data, and slot structure is meant to be
statically known.

## `<let>`

Binds an expression to a name for the rest of the enclosing scope:

```orbit
---
component Card
props {
  product: Product
}
---
<let heading={product.title |> trim |> truncate(60)}/>
<h3>{heading}</h3>
<div data-heading={heading}>reused without recomputing</div>
```

`<let>` cannot shadow `settings`, and rebinding the same name in a nested scope
is allowed but the outer binding is unaffected — there is no assignment in
Orbit, only binding.

## The component graph must be acyclic

A component that calls itself, directly or through a cycle, is a compile error
(`O2091`) with the full cycle path in the message.

This is not a limitation to work around — it is what makes rendering
provably terminate. Combined with literal loop bounds and the global iteration
counter, it means no template can loop forever, no matter who wrote it.

## Settings

Settings are values a non-developer edits in a UI, declared with a control type
and a default:

```orbit
---
component PromoBanner
settings {
  headline: Text = "Free shipping" label "Headline"
  tone: Select("info", "warning") = "info" label "Tone"
  columns: Range(1, 6, step: 1) = 3 label "Columns"
  showBadge: Toggle = true label "Show badge"
  accent: Color = #2f5bd7 label "Accent"
}
---
<div class="promo promo--{settings.tone}" data-columns={settings.columns}>
  <p>{settings.headline}</p>
</div>
```

Controls: `Text`, `Select(...)`, `Range(min, max, step: n)`, `Toggle`, `Color`.
A `Select` produces a string-literal union type, so the checker knows exactly
which values `settings.tone` can hold.

`settings` is a reserved name and cannot be shadowed. At render time the host
supplies values; an invalid one falls back to the declared default and raises a
warning rather than failing the page — a merchant typo should not take down a
storefront.
