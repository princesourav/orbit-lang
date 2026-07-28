# `runtime/` — the island swap script

Orbit's first shipped client artifact, and the only part of the system with
ambient authority. Everything else in this repository is a pure function of its
inputs; this runs in someone's browser.

## Why it lives here

`defer` on a component makes the engine emit a placeholder and hand the host a
manifest. Until this existed, nothing replaced the placeholder — server islands
compiled, checked and rendered, and did nothing.

The earlier design called the swap script "a single module the host serves",
which put it outside this repository. That was wrong. Under the settled position
that **Orbit ships JavaScript — what it forbids is author-written JS in
themes**, a swap protocol reinvented per embedder is a protocol with no
specification, and the placeholder contract is only half a contract.

The host keeps exactly what the engine cannot own: the endpoint, and signing.
The engine has no key material. But the signed thing is the *manifest*, not the
DOM — the host signs it server-side and emits an opaque token, and this script
copies that token through without constructing, parsing or validating it.

## Using it

One tag, per the runtime rules:

```html
<script src="/orbit-islands.min.js"
        integrity="sha384-…"
        crossorigin="anonymous"
        data-endpoint="/_islands"
        data-token="…"
        defer></script>
```

The `integrity` value and the tag that carries it are emitted together in
`dist/orbit-islands.json`, so they cannot drift apart. A host that computes its
own hash is a host that can get it wrong silently — and a mismatched `integrity`
simply blocks the script, which looks exactly like the island endpoint being
down.

Listen for results on `document`:

```js
document.addEventListener('orbit:islands-filled', (e) => e.detail.filled);
document.addEventListener('orbit:islands-failed', (e) => e.detail.ids);
```

Events rather than a global, so nothing has to exist before the script loads and
two copies cannot fight over a namespace.

The wire protocol is specified in prose in
[`conformance/README.md`](../conformance/README.md), so a second implementation
can reproduce it.

## The rules it ships under

These are set now, while the artifact is 1.4KB and nobody has a reason to argue
with them. A budget added after the first regression is a budget set to whatever
that regression was.

| Rule | Where |
|---|---|
| Versioned independently of the engine; a theme pins what it built against | `RUNTIME_VERSION` in `build.mjs` |
| SRI hash published as a build artifact | `dist/orbit-islands.json` |
| Size budget enforced in CI, failing the build | `SIZE_BUDGET`, `npm run runtime:check` |
| One script tag | the configuration is all `data-*` on the tag |
| First in scope for the third-party audit | `SECURITY.md` |

```
npm run runtime          # build dist/ and report size
npm run runtime:check    # CI: fail if stale or over budget
```

## What it deliberately does not do

- **No retry.** A broken endpoint costs one request, not a storm.
- **No error UI.** The fallback is already correct — it is what the author wrote
  for exactly this case. Replacing it with an error message replaces working
  output with worse output.
- **No partial-page invalidation.** A failed island never damages already
  rendered SSR output. Every failure path in `islands.test.mjs` asserts the
  fallback is still there afterwards.
- **No id in the URL.** Ids come from the DOM, and a DOM value interpolated into
  a request URL is a forgery surface even when the values are engine-generated
  today.

## The one `innerHTML`

There is exactly one, and a test fails if a second appears.

It is defensible only because the value is Orbit's own render output — same
engine, same six-context escaper, the host's own second pass over same-origin
credentials — and not author markup or user input. An implementation that
sources island content from anywhere else has broken the escaping guarantee
rather than extended it.

## Testing

`islands.test.mjs` runs against a **real DOM, not a real browser**: happy-dom
implements DOM semantics in Node. It evidences the logic, including every
failure path. It evidences nothing about Safari, an older engine, or a
CSP-constrained page. That gap is stated in `SECURITY.md` and is not claimed
anywhere as browser coverage.
