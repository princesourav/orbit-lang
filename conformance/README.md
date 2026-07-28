# Orbit conformance suite

620 cases in plain JSON. An implementation conforms when it reproduces every
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

The 43-case sweeps come from one payload table crossed with every context —
markup-significant characters, quote-breaking, `javascript:` with tab, newline
and NUL splits, `data:` URLs, protocol-relative URLs, Unicode, bidi overrides,
CDATA-ish sequences, and each RCDATA element's own closing tag.

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
