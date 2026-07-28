# Orbit and Trusted Types

Trusted Types reached Baseline in February 2026. It closes DOM-based XSS in the
browser: with a CSP `require-trusted-types-for 'script'` directive, assigning a
plain string to `innerHTML`, `src` on a script, or any other injection sink
throws instead of executing.

Orbit and Trusted Types solve **different halves of the same problem**, and
neither substitutes for the other:

| | Prevents | Where |
|---|---|---|
| **Orbit** | Injection through server-rendered markup | Server, at render |
| **Trusted Types** | Injection through DOM manipulation | Browser, at assignment |

Orbit guarantees the HTML it produced is correctly escaped for the context it
emitted into. It says nothing about what your client-side JavaScript does with
that page afterwards. Trusted Types covers exactly that gap.

## The recommended headers

```http
Content-Security-Policy:
  require-trusted-types-for 'script';
  trusted-types default;
  script-src 'self';
  base-uri 'none';
  object-src 'none'
```

Notes on each, since a copied CSP nobody understands is its own hazard:

- `require-trusted-types-for 'script'` — the directive that does the work.
- `trusted-types default` — names the allowed policies. Start with a single
  `default` policy and enumerate more only as you genuinely need them.
- `script-src 'self'` — Orbit templates cannot emit `<script>` at all, so you
  do not need `'unsafe-inline'` for anything the template produced. If your
  build needs a nonce, add it here rather than loosening this.
- `base-uri 'none'` — `<base>` is not in Orbit's element allowlist either;
  this covers scripts that might inject one.
- `object-src 'none'` — same reasoning for `<object>` and `<embed>`.

## Rolling it out

Report first, enforce later. A `report-only` header tells you what would break
without breaking it:

```http
Content-Security-Policy-Report-Only:
  require-trusted-types-for 'script';
  trusted-types default;
  report-uri /csp-report
```

Because an Orbit-rendered page contains no inline script and no event handler
attributes, the violations you see will come from your own client bundle and
from third-party tags — which is exactly the inventory worth having.

## The one place they meet: `trustedHtml` filters

Orbit has a single unescaped sink: a host filter declared to produce `Html`.
Rich-text fields usually go through one.

```ts
{
  name: 'richtext',
  params: [t.string()],
  returns: t.html(),
  trustedHtml: true,
  impl: ([markup]) => sanitize(String(markup)),
}
```

That `sanitize` is **yours**, and it is the weakest link in the whole pipeline —
the engine has said so explicitly by making you flag the filter and by warning
at every use site.

Trusted Types does not protect this path, because the markup is assembled on the
server and arrives as part of the document. Two things do:

1. **Sanitize with a maintained library**, and keep it updated. DOMPurify's
   CVE-2026-41238 is a reminder that sanitizers are themselves a moving target.
2. **Audit the use sites.** Every one is a compile-time warning, so a build log
   is a complete inventory. Grep for `trustedHtml: true` and you have the list of
   filters; the warnings give you the list of templates.

If you can avoid a `trustedHtml` filter entirely — by giving authors structured
fields instead of a rich-text blob — do that. It removes the only sink Orbit
cannot reason about.

## What Orbit does that helps a CSP hold

- **No `<script>`, no `<style>`, no `on*` attributes.** Not "escaped" — absent
  from the allowlists, so a template cannot express them. A strict `script-src`
  costs you nothing.
- **No `<base>`, `<meta>` or `<link>`.** A template cannot rewrite the document
  base or inject a stylesheet reference.
- **URL sinks are scheme-checked at emission.** `javascript:` in an `href`
  never reaches the page, so you are not relying on the browser to refuse it.
- **`style` attributes are static.** No injected CSS to reason about, which
  keeps `style-src` simple.

## What it does not help with

Stated plainly:

- **Your client-side JavaScript.** Orbit renders a page; whatever your bundle
  does to the DOM afterwards is between it and Trusted Types.
- **Third-party tags.** An analytics snippet you inject around the Orbit output
  is outside the engine's reach.
- **Downstream rewriting.** A CDN transform, an A/B testing proxy, or an email
  client's HTML mangler applied after render owns its own outcome. See
  [the security model](security-model.md#what-orbit-does-not-protect-against).
