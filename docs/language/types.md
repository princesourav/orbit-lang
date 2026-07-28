# Types

Orbit is statically typed. Every expression has a type known before any data
exists, and the type is what makes the safety rules checkable rather than
hopeful.

## Primitives

| Type | Literals | Notes |
|---|---|---|
| `String` | `"hello"` | Escapes: `\n \t \r \" \\ \/`. No raw newlines. |
| `Int` | `42`, `-7` | |
| `Float` | `1.5` | No exponent form, no leading dot. |
| `Bool` | `true`, `false` | The only thing `<if>` accepts. |
| `Color` | `#2f5bd7` | Exactly `#rrggbb`. |
| `none` | `none` | The absent value. |

`Int` widens to `Float` where a `Float` is expected. Nothing else widens
implicitly — in particular there is no implicit stringification anywhere, so
`{count}` renders an `Int` but `"total: " + count` is an error (use
interpolation instead).

`/` always yields `Float`, even for two `Int`s, because integer division
silently truncating a price is a bug worth a compile error. `%` is `Int`-only.

## Optionals: `T?`

A value that may be `none`. This is the type behind
[the optional law](safety.md): a `T?` cannot be used where a `T` is required
until you supply `??` or narrow it with an `!= none` guard.

```orbit
---
component Card
props {
  vendor: String?
}
---
<p>{vendor ?? "Unbranded"}</p>
```

Optional chaining `?.` produces an optional too — it moves the `none` along, it
does not resolve it.

## Lists: `List<T>`

```orbit
---
component Tags
props {
  tags: List<String>
}
---
<p>{tags |> join(", ")}</p>
```

Indexing yields `T?`, because the index may be out of range:

```orbit
---
component Tags
props {
  tags: List<String>
}
---
<p>{tags[0] ?? "untagged"}</p>
```

`obj[expr]` on a *record or object* is a parse error — indexing works on lists
only. That restriction is what makes the static access plan sound.

## Records and objects

**Records** are structural: `{title: "x", count: 2}` has type
`{title: String, count: Int}`, and width subtyping applies (a record with extra
fields is assignable where fewer are required).

**Objects** are nominal, declared by the host in its `TypeRegistry`. `Product`
is assignable only to `Product`. The host owns these; the engine ships none.

## String-literal unions

A `Select` setting produces a union of its options:

```orbit
---
component Banner
settings {
  tone: Select("info", "warning", "danger") = "info" label "Tone"
}
---
<div class="banner banner--{settings.tone}">x</div>
```

`settings.tone` has type `"info" | "warning" | "danger"`, so the checker knows
exactly which values can appear. A union widens to `String` where a `String` is
required.

## Terminal types

Four branded types exist to make whole categories of mistake unrepresentable.
They are not ordinary types with restrictions bolted on — the restrictions are
the reason they exist.

### `Money`

Admits **no** operators, **no** properties, **no** equality, **no** stdlib
filters, and **cannot be rendered**.

That looks hostile until you consider what it prevents: currency arithmetic in
a template. `{price * 1.2}` for a tax rate, `{price - discount}` for a sale
price — every one of those is a float-rounding bug shipped to a customer's
invoice, and none of them belongs in a presentation layer.

Format it with a host filter that returns `MoneyText`:

```orbit
---
component Price
props {
  product: Product
}
---
<p class="price">{product.price |> money}</p>
```

### `MoneyText`

The output of formatting money. Renders in content and attributes, admits no
filters — it is already formatted, and truncating or upper-casing a formatted
price is not something to make easy.

### `Url`

Renders, and is valid in URL attributes and JSON-LD. It is a convenience, **not
a safety mechanism**: a plain `String` is equally allowed in `href`, because
[URL safety is enforced at the sink](../guides/security-model.md#urls-are-sanitized-at-the-sink-never-trusted-from-a-type),
never inferred from a type.

### `Image`

Host-filter input only. It exists so an image reference can be passed to a
host's image pipeline without the template being able to do anything else with
it.

### `Html`

Engine-owned, and the sharpest of the five. It renders **only** as element
content — never as a prop, binding, operand, attribute value, or inside RCDATA
or JSON-LD. It is **not host-declarable**: you cannot add a field of type
`Html` to your registry.

The only producers are host filters, and each must declare one of three
obligations:

| Flag | The host promises | Warns at use sites |
|---|---|---|
| `sanitizer` | input is untrusted; this filter sanitizes it | no |
| `trustedHtml` | input is trusted; emitted raw | **yes** |
| `htmlTransform` | Html in, Html out; well-formedness preserved | no |

Only `trustedHtml` warns, because only it asserts trust rather than
establishing it. Grep for `trustedHtml` and you have the complete list of
places markup enters a page on the host’s word alone.

`Html` may be a **component prop**, so a shared `<RichText content={…}/>`
can own prose typography. It stays element-content-only everywhere inside
that component: not an attribute, not `<let>`-bound, not a filter operand
(except an `htmlTransform` first argument), never in `<title>`.

## Where annotations go

Only in frontmatter, on props. Everything else is inferred:

- `<let>` takes the type of its expression.
- Loop variables take the element type of the subject.
- List literals unify their elements; numeric branches unify to `Float`.
- Ternary branches unify; a `none` branch makes the result `T?`.
- `Url` unified with `String` gives `String` — the weaker of the two, because
  assuming otherwise would be assuming safety.

## `invalid`

When the checker cannot determine a type, it produces `invalid` and
**suppresses** downstream errors involving it. One genuine mistake yields one
diagnostic, not a cascade of twenty consequences — the same principle the
parser's recovery follows.
