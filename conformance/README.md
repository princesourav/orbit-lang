# Orbit conformance suite

644 cases in plain JSON. An implementation conforms when it reproduces every
expectation here.

Nothing in the corpus is TypeScript-specific. That is the point: a second
implementation — in Rust, Go, Python, or anything else — reads the same files
and reports the same pass/fail counts, and "it implements Orbit" becomes a
claim someone can check rather than one they have to take on trust.

## Running it

```bash
npx vite-node conformance/runner.mjs        # against the reference engine
node conformance/generate.mjs               # regenerate after a deliberate change
node conformance/generate.mjs --check       # CI: fail if the corpus is stale
```

## Case format

```json
{
  "id": "escaping-text/tagOpen",
  "category": "escaping-text",
  "template": "---\npage page\n---\n<p>{data.text}</p>\n",
  "bindings": { "data": { "text": "<script>alert(1)</script>", "...": "..." } },
  "expect": { "kind": "html", "html": "<p>&lt;script&gt;…</p>", "warnings": [] }
}
```

`expect.kind` is one of:

| kind | meaning |
|---|---|
| `html` | Renders successfully. `html` is the exact expected bytes; `warnings` is the sorted list of warning codes. |
| `parse-error` | Parsing fails. `code` is the first diagnostic's code. |
| `check-error` | Parsing succeeds, checking fails. `code` is the first error diagnostic's code. |
| `render-error` | Compiles, but rendering fails (a budget trip, a type violation at runtime). `code` is the failure code. |

A case may carry `extraTemplates`, a map of filename to source, compiled
alongside the main template — used by the component cases.

Rendering always uses the entry point named `page`, with `now()` fixed at `0`.
The clock is abort-only and never reaches output, so fixing it removes
wall-clock flakiness without affecting any expected byte.

## The conformance host

Every case compiles against this host. An implementation must construct an
equivalent one.

**Object types**

```
Item {
  text: String, url: Url, note: String?, count: Int,
  ratio: Float, flag: Bool, tags: List<String>
}

Data {
  text: String, url: Url, note: String?, count: Int,
  ratio: Float, flag: Bool, tags: List<String>,
  items: List<Item>
}
```

**Page globals**

```
data: Data
```

**Host filters**

```
shout(String) -> String     — ASCII-uppercases its argument
```

`shout` exists so the corpus exercises the host-filter seam (declaration,
type checking, byte-charging of output) without depending on anything
platform-specific.

### Html host filters

Three filters, one per Html obligation. **These must be reproduced exactly** —
the expected bytes depend on their behaviour, not only their declarations, so
behaviour is specified here rather than left to be inferred.

| Name | Signature | Flag | Warns at use sites |
|---|---|---|---|
| `richtext` | `(String) -> Html` | `sanitizer` | no |
| `rawHtml` | `(String) -> Html` | `trustedHtml` | **yes** |
| `truncateHtml` | `(Html, Int) -> Html` | `htmlTransform` | no |

**`richtext`** wraps its input in `<p>…</p>` and replaces every `<` with `&lt;`.
It is deliberately not a pass-through: a sanitizer that returned its input
unchanged would make every escaping case in this category vacuous.

```
""        ->  "<p></p>"
"a<b"     ->  "<p>a&lt;b</p>"
"<script>" -> "<p>&lt;script></p>"
```

**`rawHtml`** is the identity function. The host asserts the input is already
trusted, which is exactly what the flag means.

```
""        ->  ""
"<b>x"    ->  "<b>x"
```

**`truncateHtml`** returns its input unchanged when the markup is at most `max`
characters. Otherwise it cuts at the **last `>` at or before `max`**, keeping
that `>`, so a tag is never sliced open. When there is no such `>`, it returns
the empty string rather than a fragment of a tag — the `htmlTransform`
obligation is to preserve well-formedness, and half a tag changes how the whole
remainder of the document parses.

```
("<p>hello</p>", 6)  ->  "<p>"
("<p>hi</p>", 99)    ->  "<p>hi</p>"
("abcdef", 3)        ->  ""
```

An implementation that warns at a `sanitizer` or `htmlTransform` use site, or
stays silent at a `trustedHtml` one, fails the `html-accepted` category: the
expected `warnings` arrays encode exactly that distinction.

The host is defined once, in [`host.mjs`](./host.mjs), and imported by both the
generator and the runner. It was previously duplicated between them, and the two
drifted the first time a filter was added.

## Categories

| Category | Cases | What it pins |
|---|---|---|
| `escaping-text` | 43 | Every payload interpolated into element content |
| `escaping-attr` | 43 | …into a whole-expression attribute |
| `escaping-attr-parts` | 43 | …into a quoted attribute with islands |
| `escaping-rcdata-title` | 43 | …into `<title>` |
| `escaping-rcdata-textarea` | 43 | …into `<textarea>` |
| `escaping-jsonld` | 43 | …into a JSON-LD payload |
| `url-href` / `src` / `action` / `poster` / `cite` | 43 each | Every URL-bearing attribute against every payload |
| `url-srcset` | 8 | Candidate-list parsing and per-candidate sanitization |
| `banned-element` | 16 | Each banned element, with its dedicated code |
| `unknown-element` | 7 | Non-allowlisted tags, including `html`/`head`/`body` |
| `banned-attribute` | 10 | `on*`, `srcdoc`, `ping`, namespaced names, interpolated `style` |
| `syntax-rejection` | 12 | Bare `<`, method calls, dynamic member access, missing `<empty>`, … |
| `type-law-rejection` | 7 | Truthiness and the optional law, refused |
| `type-law-acceptance` + `-absent` | 12 | The same programs accepted, with the optional present and absent |
| `budget` | 6 | Loop-limit boundaries, and that an empty loop body still charges |
| `whitespace` | 12 | Collapsing, boundary spaces, `<pre>`, explicit `{" "}` |
| `filter` | 35 | Every stdlib filter, at its edges |
| `structure` | 16 | Control flow, `<let>`, void elements, conditional attributes, comments |
| `component` | 5 | Props, defaults, slots, calls inside loops |
| `html-accepted` | 7 | Html in element content: sanitizer, trusted, transform chain, ternary |
| `html-rejected` | 10 | Every other sink, plus the `??`/`|>` precedence trap |
| `html-prop` | 8 | Html crossing a component boundary, forwarded, and mis-typed |

The 43-case sweeps come from one payload table crossed with every context —
markup-significant characters, quote-breaking, `javascript:` with tab, newline
and NUL splits, `data:` URLs, protocol-relative URLs, Unicode, bidi overrides,
CDATA-ish sequences, and each RCDATA element's own closing tag.

## The server-island placeholder, specified

The `server-islands` cases assert exact bytes, so the shape has to be stated
rather than inferred from them. A conforming implementation emits, for
`<Component defer/>`:

```
<orbit-island data-island="ID">FALLBACK</orbit-island>
```

- The element name is exactly `orbit-island`. A custom element is inert in every
  browser — an unknown element is an `inline` container with no behaviour — so a
  page whose second pass never runs shows the fallback and nothing else.
- `ID` is `i` followed by the island's **zero-based index in emission order**:
  `i0`, `i1`, `i2`. It is a render-local counter and **must not** be derived from
  data. An id computed from bindings is both attacker-reachable and a cache key
  that moves when nothing meaningful changed.
- `FALLBACK` is the call's children, rendered in the caller's scope with the
  caller's escaping rules, exactly as if they had been written in place. It is
  empty when the call has no children.
- `data-island` is the only attribute. Everything else the host needs — the
  component name, the resolved props, the island's access plan — travels in the
  **manifest**, not in the markup, so nothing about the second pass is
  attacker-reachable through the page.

### The swap protocol

The placeholder is only half a contract; something has to fill it. Orbit ships
that something (`runtime/`), and the protocol is specified here so a second
implementation can reproduce both halves.

**Configuration comes from the script's own tag**, so a theme ships one tag:

```html
<script src="/orbit-islands.min.js"
        integrity="sha384-…"
        crossorigin="anonymous"
        data-endpoint="/_islands"
        data-token="…"
        defer></script>
```

**One request per page, not per island.** The reason a fragment was deferred is
that the page could be cached without it; paying one network round trip per
island gives that back.

```
POST <data-endpoint>
content-type: application/json
credentials: same-origin

{ "token": "<data-token, verbatim>", "ids": ["i0", "i1"] }
```

```
200 OK
{ "islands": { "i0": "<span>…</span>", "i1": "…" } }
```

The ids travel in the **body**. They are read from the DOM, and a value from the
DOM interpolated into a request URL is a forgery surface even when the values are
engine-generated today.

**Where signing sits.** The engine has no key material and cannot sign. But the
signed thing is the **manifest**, not the DOM: the host signs it server-side and
emits an opaque token into the page. The script copies that token through and
never constructs, parses or validates it. So the engine owns the protocol and the
host owns exactly the one thing it must.

**Failure is per-island and never destructive.** On network failure, a non-200,
a malformed body, or an id absent from the response, the placeholder is left
exactly as rendered — the fallback is already correct, and clearing it or
substituting an error message replaces working output with worse output. A
failed island must never invalidate already-rendered SSR output. There is no
retry: a broken endpoint costs one request, not a storm.

An implementation **MUST**:

- fill only `orbit-island[data-island]` elements, and only ids it requested;
- ignore a response entry whose value is not a string;
- fill a duplicated id at most once — filling every copy would duplicate
  personalized content across placeholders that were never the same island;
- leave every other element in the document untouched.

Content is assigned with `innerHTML`. That is defensible **only** because the
value is Orbit's own render output — same engine, same six-context escaper, the
host's own second pass over same-origin credentials — and not author markup or
user input. An implementation that sources island content from anywhere else has
broken the escaping guarantee, not extended it.

Reporting is via DOM events on `document`, so nothing must exist before the
script loads: `orbit:islands-filled` with `{ filled: string[] }`, and
`orbit:islands-failed` with `{ ids: string[], reason: string }`.

Caching policy remains the host's.

## CSS custom properties: the closed-lexical-form rule

`--accent={settings.tint}` emits `style="--accent:#1a73e8"`. The `custom-properties`
cases assert exact bytes; this is the rule behind them, because an implementation
that reproduced the bytes and not the rule would pass the accepted cases and be
unsafe.

**A value may enter this sink only if its type has a CLOSED LEXICAL FORM the
implementation can enumerate completely.** In this version that is `Color`, and
only `Color`. The permitted set is total:

```
#        exactly one, position 0
0-9 a-f A-F   exactly six, positions 1-6
anything else  cannot be emitted
```

There is no escape function for this context. An escaper transforms hostile
input into safe output; this **refuses** it. That difference is the entire safety
argument, and it is why the rule does not generalise: `Length` admits units and
`calc()`, `FontFamily` admits quoted strings with escapes, and a URL admits
everything the URL sink already handles. None of those can be written as a table
this short, so none is admitted.

An implementation **MUST**:

- accept only a **static** property name, matching `--` followed by
  `[a-zA-Z0-9_-]+`. An interpolated name is a parse error — a dynamic property
  name is an injection surface for the same reason a dynamic attribute name is.
- accept only the expression form. Bare, quoted and conditional forms are parse
  errors; a *static* custom property belongs in the stylesheet.
- **revalidate the value at emission** and fail the render when it is malformed,
  rather than trusting the declared type. A `Color` arriving as a field of a
  host object is validated nowhere upstream, so a sink that trusted the type
  would inherit that gap.
- emit all custom properties on one element as declarations of a **single**
  `style` attribute, in written order, after any static `style` text. Two
  `style` attributes is a document browsers resolve by keeping the first.
- continue to reject interpolated `style` (`O1095`). This form is a carve-out of
  exactly one shape and nothing wider.

## Two things the corpus does not prove

Stated plainly, because a conformance suite that oversells itself is worse than
none.

**1. The expectations were captured from the reference implementation.** That
is the ordinary bootstrapping problem for a first suite: it proves an
implementation is self-consistent and does not drift, not that the original
answers were right.

The gap is covered by `differential.test.mjs`, which renders every escaping
case and feeds it to **parse5** — a real WHATWG HTML parser this project did
not write — then checks the resulting DOM against what the escaping rules
promise: a text payload stays text, an attribute payload reads back unchanged,
no payload introduces an element or an event handler, and no URL sink yields a
`javascript:`, non-image `data:`, or protocol-relative URL. 459 assertions.

**2. Passing is necessary, not sufficient.** A corpus enumerates cases someone
thought of. The property-based suite in `src/*.property.test.ts` covers the
space between them.

## One known divergence: U+0000

Orbit emits a NUL byte exactly as bound. A browser does not keep it, and what
it does depends on the context: in body character data the token is a parse
error and is **ignored**; in an attribute value and in RCDATA it is **replaced**
with U+FFFD.

This is a fidelity difference, not a security one — a NUL cannot terminate an
attribute, close an element, or open a tag, which the structural assertions
confirm across every context. It is pinned by its own tests rather than
normalized away, because the value of an external oracle is precisely that it
surfaces this kind of fact.

## Porting to another implementation

1. Build the host above.
2. Read every `cases/*.json`.
3. For each case: compile `extraTemplates` plus the template, render the entry
   point `page` with the case's bindings and a clock fixed at 0, and compare
   against `expect`.
4. Report `passed / total`.

`runner.mjs` is roughly a page of code and is the executable definition of
those semantics — read it rather than inferring them from this prose.
