# Your first Orbit component

Every snippet here compiles. If you want to follow along interactively, open
the [playground](../../playground/) — it needs no install.

## A template has two halves

```orbit
---
component ProductCard
props {
  product: Product
}
---
<article class="card">
  <h3>{product.title}</h3>
</article>
```

The part between `---` fences is **frontmatter**: it declares what the template
is called and what it needs. Below it is markup.

Frontmatter is mandatory. A template that does not declare its inputs is a
template whose contract lives in someone's head.

`component` names are PascalCase; `page` names are lowercase.

## Interpolation

`{expr}` inserts a value. It is escaped according to where it sits — you never
choose an escaping filter, and there is no way to opt out:

```orbit
---
component Card
props {
  title: String
}
---
<h1>{title}</h1>
<div data-label={title}>attribute values are escaped differently</div>
```

To emit a literal `<`, write `{"<"}`. A bare `<` in text is a parse error, so
this is never ambiguous.

## Conditionals

`<if>` takes a `Bool`. There is no truthiness, so compare explicitly:

```orbit
---
component Card
props {
  title: String
  available: Bool
}
---
<if {available}>
  <button type="button">Add to cart</button>
</if>
<else>
  <p>Sold out</p>
</else>
```

`<else-if>` and `<else>` are **siblings** of `</if>`, not children of it.

## Loops

```orbit
---
page shop
---
<ul>
  <for product, i of={collection.products} limit={24}>
    <li data-position={i + 1}>{product.title}</li>
    <empty>
      <li>Nothing here yet.</li>
    </empty>
  </for>
</ul>
```

Three things to notice:

- The index binding (`, i`) is optional.
- `limit` must be a **literal**, at most 250. A bound an attacker could compute
  is not a bound. Omitted, it defaults to 250.
- `<empty>` is required and must be the last child. The empty-collection case is
  the one every template forgets, so the language does not let you.

## Optionals

A field declared `String?` may be absent, and cannot be used until you say what
happens when it is:

```orbit
---
component Card
props {
  vendor: String?
}
---
{# Give it a fallback… #}
<p>{vendor ?? "Unbranded"}</p>

{# …or narrow it with a guard. #}
<if {vendor != none}>
  <p class="vendor">{vendor}</p>
</if>
```

This is [the optional law](safety.md), and it is the rule you will meet most
often. It exists so a missing vendor cannot render as a blank line in
production.

## Filters

Pipe values through the [stdlib](../reference/filters.md):

```orbit
---
component Card
props {
  title: String
  tags: List<String>
}
---
<h3>{title |> trim |> truncate(40)}</h3>
<p>{tags |> join(", ")}</p>
```

`|>` is the loosest operator, so `{a + b |> round}` pipes the sum.

## Components calling components

A PascalCase tag is a component call:

```orbit
---
page shop
---
<ul>
  <for product of={collection.products}>
    <li><ProductCard product={product}/></li>
    <empty><li>Nothing here yet.</li></empty>
  </for>
</ul>
```

Props are typed and checked. A missing required prop, an unknown prop, or a
wrong type is a compile error naming the prop.

## Slots

Components accept content from their caller:

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
  <div><slot/></div>
  <footer><slot name="footer"/></footer>
</section>
```

`header` is required; `footer?` is optional. The caller fills them with a
`slot=` attribute:

```orbit
---
page shop
---
<Panel>
  <h2 slot="header">Featured</h2>
  <p>Body content goes to the default slot.</p>
  <small slot="footer">Terms apply.</small>
</Panel>
```

Slot content is written by the caller and renders in the **caller's** scope —
it can see the caller's data, not the component's internals.

## Naming a value

`<let>` binds an expression once:

```orbit
---
component Card
props {
  title: String
}
---
<let heading={title |> trim |> truncate(60)}/>
<h3>{heading}</h3>
<div data-heading={heading}>reuse it without recomputing</div>
```

## Settings

Settings are values a non-developer edits in a UI. They are declared with a
control type and a default:

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
<div class="promo promo--{settings.tone}">
  <p>{settings.headline}</p>
</div>
```

The host supplies values at render time; an invalid value falls back to the
declared default and raises a warning rather than failing the page.

## Compile it

```bash
npx orbit check src/themes/
```

One run reports every problem in every file, with a source excerpt and a caret:

```
error[O2104]: optional value used without a fallback (`String?`) — decide what happens when it is absent
 --> card.orbit:8:5
  |
8 | <p>{vendor}</p>
  |    ^^^^^^^^ use {vendor ?? ""} or wrap in <if {vendor != none}>
```

Then format:

```bash
npx orbit fmt src/themes/
```

## Where to go next

- [The two rules that will surprise you](safety.md) — read this one.
- [Templates and markup](templates.md) — why the element list is closed.
- [Components and pages](components.md)
- [Types](types.md)
