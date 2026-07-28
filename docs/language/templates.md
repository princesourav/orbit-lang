# Templates and markup

## The element allowlist is closed

Orbit permits 94 elements. Everything else is a compile error — not a warning,
not passed through.

```orbit expect-error
<blink>nope</blink>
```

```
error[O1081]: <blink> is not in the element allowlist
```

Sixteen elements are banned with a specific reason rather than a generic
"unknown", because people reach for them deliberately:

`script`, `style`, `iframe`, `object`, `embed`, `applet`, `base`, `meta`,
`link`, `template`, `noscript`, `svg`, `math`, `frame`, `frameset`, `portal`.

```orbit expect-error
<script>alert(1)</script>
```

```
error[O1080]: <script> is not allowed: scripts cannot appear in templates;
client behavior ships as platform runtime islands
```

### Why closed rather than a denylist

A denylist is a list of attacks someone thought of. Every new HTML feature is
permitted by default until somebody notices — which is how `srcdoc`, `<portal>`
and countless `on*` variants became bug reports in other engines.

The closed list also buys something structural: because `<script>` and `<style>`
are not in it, **no code path emits into a rawtext context**, so the RAWTEXT
escaping context is unreachable by construction rather than by careful escaping.

`<html>`, `<head>` and `<body>` are also absent. Templates render *fragments*;
the document shell and its metadata belong to the host.

## Attributes

Four value forms:

```orbit
{# static #}
<div class="card">a</div>
{# quoted, with islands #}
<div class="card card--{product.title}">b</div>
{# whole-expression #}
<a href={product.url}>c</a>
{# bare flag #}
<button disabled>d</button>
{# conditional: the attribute is emitted only when the Bool is true #}
<button disabled?={!product.available}>e</button>
```

Values are always double-quoted in output. Single quotes are rejected in
source, which is what makes the attribute escaper's job total rather than
context-dependent.

The attribute allowlist is closed too: a global set, per-element sets, and the
`data-*` and `aria-*` families. Rejected outright: every `on*` handler,
`srcdoc`, `ping`, `background`, `longdesc`, and any namespaced name like
`xlink:href`.

There are **no dynamic attribute names** and no spread. You cannot compute
which attribute to set, which means an attacker cannot compute it either.

### `style` must be static

```orbit expect-error
<div style="color: {settings.accent}">x</div>
```

A CSS value is its own injection context, and Orbit does not implement a CSS
escaper — so rather than escape it badly, the language refuses. Static `style`
attributes are fine:

```orbit
<div style="display: flex">x</div>
```

For dynamic styling, switch on a class name, or have the host supply a
custom-property value it has validated.

## URL attributes

Seven attributes are marked URL-bearing at parse time: `href`, `src`, `srcset`,
`action`, `formaction`, `poster`, `cite`.

A plain `String` is allowed in them. Orbit does not require a `Url` type,
because [it never trusts a type to mean a URL is safe](../guides/security-model.md#urls-are-sanitized-at-the-sink-never-trusted-from-a-type)
— the scheme allowlist is applied where the value is emitted.

## RCDATA elements

`<title>` and `<textarea>` hold text and interpolation, but nested tags are
treated as text:

```orbit
<title>{article.title} — Shop</title>
```

An `Html` value can never render here (`O2075`), because RCDATA does not parse
markup and injecting markup into it would either do nothing or break out.

## Text and whitespace

Runs of whitespace collapse to a single space, and **boundary spaces are
preserved**. `<p>  hello  </p>` renders as `<p> hello </p>`; a run that is
entirely whitespace is dropped.

This matters more than it sounds, because it defines where the formatter may
break lines — see [the formatter's contract](../../src/formatter.ts). If you
need byte-exact spacing, write it explicitly:

```orbit
<p>Price:{" "}<strong>19.00</strong></p>
```

Inside `<pre>`, text is preserved exactly.

A bare `<` in text is a parse error with a fix-it, so there is never ambiguity
about whether you meant a tag:

```orbit
<p>a {"<"} b</p>
```

### `verbatim`

The `verbatim` marker disables interpolation for a subtree, so `{` is literal:

```orbit
<code verbatim>{this is not an expression}</code>
```

## Comments

```orbit
{# Stripped before rendering. Never reaches the output. #}
<!-- Also stripped. -->
<p>x</p>
```

Both forms are removed entirely. There is no comment that survives into the
HTML, so a comment cannot leak template internals to a viewer.

## JSON-LD

```orbit
<json-ld>{{"@type": "Product", name: product.title, url: product.url}}</json-ld>
```

Note the double braces: the outer `{}` is the interpolation island, the inner
`{}` is the record literal. Keys that are not valid identifiers — `@type`,
`@context` — must be quoted.

Takes exactly one record expression, serialized by the engine. Strings are
emitted with `<`, `>`, `&` and `/` escaped as `\uXXXX`, so the payload can never
close the script element it lives in. Only primitives, records, lists and `Url`
are permitted; `Html` is refused.
