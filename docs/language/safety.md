# The two rules that will surprise you

Most of Orbit is unremarkable if you have written templates before. Two rules
are not, and they account for the large majority of compile errors people hit
in their first hour. Both are deliberate, and both exist because the failure
they prevent is silent in every other template language.

Read this page before you get stuck, not after.

---

## 1. No truthiness

`<if>` requires a `Bool`. Not a string, not a number, not a list.

```orbit expect-error
{# Compile error. #}
<if {product.title}>
  <h1>{product.title}</h1>
</if>
```

```
error[O3007]: <if> condition must be Bool, found String (there is no truthiness)
 --> product-card.orbit:4:6
  |
4 | <if {product.title}>
  |      ^^^^^^^^^^^^^ write an explicit comparison, e.g. {value != ""}
```

Write what you actually mean:

```orbit
<if {product.title != ""}>
  <h1>{product.title}</h1>
</if>
```

### Why

"Truthy" is not one rule, it is a table, and every language's table is
different. Is `0` false? Is `"0"`? Is `[]`? Is `"false"`? A template author
moving between Liquid, Jinja and JavaScript carries the wrong table in their
head, and the resulting bug is invisible: the page renders, it just renders the
wrong branch. A missing section on a product page is not an exception anyone
sees in a log.

Requiring `Bool` means the condition says what it tests. `count != 0` and
`items |> size != 0` are different questions, and a template that asks the wrong
one now says so out loud.

---

## 2. The optional law

A value of type `T?` — one that may be `none` — cannot be used where a `T` is
required. Not rendered, not passed to a filter, not compared, not used as an
operand. It must first be given a fallback or narrowed.

```orbit expect-error
{# vendor is String?. Compile error. #}
<p>{product.vendor}</p>
```

```
error[O2104]: optional value used without a fallback (`String?`) — decide what happens when it is absent
 --> product-card.orbit:4:4
  |
4 | <p>{product.vendor}</p>
  |    ^^^^^^^^^^^^^^^^ use {product.vendor ?? ""} or wrap in <if {product.vendor != none}>
```

There are two ways to satisfy it.

**Give it a fallback** with `??`:

```orbit
<p>{product.vendor ?? "Unbranded"}</p>
```

**Narrow it** with an `!= none` guard. Inside the guarded branch, the value is
known to be present:

```orbit
<if {product.vendor != none}>
  <p>{product.vendor}</p>   {# fine: narrowed to String here #}
</if>
```

Narrowing follows the shape of the code you would write anyway:

```orbit
{# Accumulates across an else-if chain. #}
<if {product.vendor != none}>
  <p>{product.vendor}</p>
</if>
<else-if {product.brand != none}>
  <p>{product.brand}</p>
</else-if>

{# Propagates through && to the right-hand operand. #}
<if {product.vendor != none && product.vendor != ""}>
  <p>{product.vendor}</p>
</if>
```

### `||` deliberately does not narrow

```orbit expect-error
{# Still a compile error, and correctly so. #}
<if {product.vendor == none || product.vendor != ""}>
  <p>{product.vendor}</p>
</if>
```

In the branch where that condition is true, `vendor` might have been `none` —
the left operand is exactly the case where it is. A narrowing rule that
"worked" here would be unsound, and unsound narrowing is worse than none: it
would let a `none` reach a sink while the compiler claimed otherwise.

### `?.` does not end the obligation

`product.vendor?.length` yields an optional too. Optional chaining moves the
`none` along; it does not resolve it. You still need `??` or a guard at the
point of use.

### Why

The alternative is rendering `null`, `undefined`, `None` or `` into a page. Every
templating ecosystem has shipped that bug to production, usually into a `<title>`
or a price. It is not caught by tests because the test fixture always has the
field populated — the failure needs a real record with a missing vendor, on a
Tuesday.

Making it a compile error moves the discovery from a customer's screen to your
editor, and the fix-it in the diagnostic is usually the whole change.

---

## These two rules compose

```orbit
{# rating is Float? — both rules apply. #}
<if {product.rating != none && product.rating > 4.0}>
  <span class="badge">Top rated</span>
</if>
```

`&&` narrows `rating` for its right operand, so `product.rating > 4.0` is legal
there; and that comparison produces the `Bool` that `<if>` requires. Neither
rule needed a special case — they are the same rule applied twice: *a value is
only usable where its type actually fits.*

---

## What this costs you

Honestly: some verbosity. `{price ?? 0}` where another language lets you write
`{price}`. The trade is that a template which compiles cannot render a missing
value or take a branch on a definition of "truthy" you did not intend.

For a template estate maintained by people who did not write it — or generated
by a model — that trade is the entire point of using a typed template language.
