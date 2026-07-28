# Filter reference

Orbit ships 19 filters. They are pure functions: same input, same output, no
I/O, no clock, no state. None uses a regular expression, and every one that can
grow a value is checked against the per-value caps at each step.

Filters are applied with the pipe operator, which is the **loosest** operator in
the language (as in Elixir and F#), so the whole left-hand expression is piped:

```orbit
{title |> trim |> truncate(40)}
{basePrice + shipping |> round}      {# pipes the SUM, not just shipping #}
```

Or called directly:

```orbit
{truncate(trim(title), 40)}
```

Some arguments must be **literals**, noted below. That restriction is what keeps
templates statically analyzable — a sort key that could be computed at runtime
would defeat the static access plan.

---

## Strings

### `upper(s: String) -> String`
### `lower(s: String) -> String`

Case conversion. Operates per code unit; no locale-specific casing rules (no
Turkish dotless-i handling), because locale-dependent output would break the
determinism guarantee.

```orbit
{"Aurora Runner" |> upper}   {# AURORA RUNNER #}
```

### `capitalize(s: String) -> String`

Uppercases the first character, leaves the rest untouched. It does **not**
lowercase the remainder — `capitalize("iPhone case")` is `"IPhone case"`, not
`"Iphone case"`.

### `trim(s: String) -> String`

Removes leading and trailing whitespace (space, tab, CR, LF).

### `truncate(s: String, max: Num, ellipsis?: String) -> String`

Shortens to at most `max` characters **including** the ellipsis, so the result
never exceeds `max`. Default ellipsis is `…` (one character).

```orbit
{"Aurora Runner Lightweight" |> truncate(12)}   {# "Aurora Runn…" #}
{"Aurora Runner" |> truncate(9, "...")}         {# "Aurora..." #}
```

Returns the input unchanged when it is already short enough.

### `replace(s: String, from: String, to: String) -> String`

Literal substring replacement — every occurrence, no patterns. There is no
regex form and will not be one; `from` is matched by a linear scan, and the
result is cap-checked as it grows so a replacement that inflates the string
cannot exceed the per-value limit.

### `split(s: String, separator: String) -> List<String>`

Splits on a literal separator. The result is capped at `maxListItems`.

### `slugify(s: String) -> String`

Lowercases, and maps runs of non-alphanumeric characters to single hyphens, with
no leading or trailing hyphen. ASCII-oriented: it does not transliterate
accented or non-Latin characters, so use it for URL fragments you control, not
as a general internationalized slug function.

### `urlEncode(s: String) -> String`

Percent-encodes for use in a query string. This is **not** what makes a URL
safe — URL safety is enforced at the sink when the value is emitted into a
URL-bearing attribute, whatever the filter chain did. See
[the security model](../guides/security-model.md).

---

## Lists

### `join(list: List<primitive>, separator: String) -> String`

Joins primitives. Structured values (records, objects) cannot be joined — there
is no implicit stringification anywhere in Orbit.

### `size(value: List | String) -> Int`

Length of a list, or character count of a string. The idiomatic emptiness test,
since there is no truthiness:

```orbit
<if {(product.tags |> size) > 0}>
  <p>tagged</p>
</if>
```

The parentheses are required. `|>` is the loosest operator, so
`{tags |> size > 0}` would try to pipe into `size > 0` — the parser rejects it
with `O1019` and says so. `{size(product.tags) > 0}` is equivalent.

### `first(list: List<T>) -> T?`
### `last(list: List<T>) -> T?`

The first or last element — **optional**, because the list may be empty. That
optional is not a nuisance; it is the empty-list case that other languages let
you render as blank. Satisfy it with `??` or a guard.

Neither takes a count argument.

### `reverse(list: List<T>) -> List<T>`

Returns a reversed copy. The input is never mutated — nothing in Orbit mutates.

### `sortBy(list: List<T>, key: string-literal) -> List<T>`

Stable sort by a field. `key` **must be a string literal**. Missing values sort
last.

```orbit
<for product of={collection.products |> sortBy("title")}>
  <p>{product.title}</p>
  <empty><p>none</p></empty>
</for>
```

### `where(list: List<T>, key: string-literal, value) -> List<T>`

Keeps elements whose field equals `value`, by strict equality. `key` **must be a
string literal**.

```orbit
<for product of={collection.products |> where("available", true)}>
  <p>{product.title}</p>
  <empty><p>none in stock</p></empty>
</for>
```

---

## Numbers

### `round(n: Num, places?: literal 0..6) -> Int | Float`

Rounds to `places` decimal places (default `0`). `places` **must be a literal**
between 0 and 6. Returns `Int` when rounding to 0 places, `Float` otherwise.

### `clamp(n: Num, min: Num, max: Num) -> Int | Float`

Constrains to a range.

**Note:** none of these apply to `Money`. `Money` is a terminal type that admits
no operators, no properties, no stdlib filters and no rendering — currency
arithmetic in a template is a bug, and the type makes it unrepresentable. Format
money with a host filter that returns `MoneyText`.

---

## Dates

### `formatDate(iso: String, pattern: String) -> String`

Formats an ISO-8601 date string. The parse is a hand-rolled linear scan and
deliberately does not construct a `Date`, because that would make output depend
on the host's timezone and break determinism.

Pattern tokens: `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, and `MMMM` for the month
name.

```orbit
{article.publishedAt |> formatDate("MMMM D, YYYY")}
```

**Limitations you should know before relying on it:**

- Month names come from the injected locale data, which defaults to English.
  Supply your own through `RenderOptions.locale`.
- **Timezones are not applied.** The input is formatted as given. If you need a
  value rendered in the viewer's zone, convert it host-side before binding it —
  the engine has no clock and no timezone database, by design.

For anything richer — relative times, plurals, full CLDR formatting — declare a
host filter. That keeps the locale data, and its update cadence, on your side of
the boundary.

---

## Caps

Every filter is checked against the per-value caps at each step, so a chain
cannot inflate a value past them:

| Cap | Value | Code |
|---|---|---|
| String length | 256 KiB | `O4005` |
| List items | 5,000 | `O4006` |

A trip fails the whole render with a template, line and column. A partial page
is never returned. See [limits](limits.md).
