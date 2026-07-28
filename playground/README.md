# Orbit playground

A single self-contained HTML file with the whole engine inlined. Open
`index.html` from a `file://` URL and it works — no server, no build step, no
network.

That is not a party trick; it falls out of two properties of the engine and is
worth stating because it is unusual for a template language:

* **Zero runtime dependencies**, so there is nothing to fetch.
* **Zero I/O** — no filesystem, no network, no clock it was not handed — so
  there is nothing to run server-side.

It also makes the pitch checkable rather than asserted. A visitor can paste a
hostile template and watch it fail to compile in their own browser, with no
trust in us and no data leaving the page.

## What the panels show

| Panel | What it demonstrates |
|---|---|
| **Diagnostics** | The compiler's voice, with code frames. Since v0.5 the parser recovers, so one run reports every problem in the file rather than only the first. |
| **Output** | The exact bytes rendered. |
| **Preview** | The rendered HTML in a `sandbox`-ed iframe with scripts disabled. Orbit cannot emit script; the preview should not be the one place that could. |
| **Escaping** | Every interpolation with the escaping context its *position* implies — decided before any data exists. `RAWTEXT` never appears, because `<script>` and `<style>` are not in the element allowlist at all. |
| **Data plan** | The exact data paths a render can touch, extracted statically. Possible only because Orbit has no dynamic member access. |
| **Budgets** | Fuel, output and the iteration cap — the answer to "what stops a hostile template", which is otherwise invisible. |

## Examples worth trying

* **XSS is a compile error** — `<script>`, `on*` handlers, `<iframe>` and
  interpolation inside `style` are all rejected before rendering.
* **Hostile URLs die at the sink** — a plain `String` in `href` is deliberately
  *allowed*. Orbit never trusts a type to mean a URL is safe; the scheme
  allowlist is applied where the value is emitted, so a `javascript:` payload
  becomes `#` and raises a structured warning. Type-based URL safety is the
  thing that keeps failing in other engines, so Orbit does not rely on it.
* **The optional law** and **No truthiness** — the two rules that surprise
  newcomers most, each shown as the error you actually get.

## Building

```bash
npm run playground          # rewrite index.html
npm run playground:check    # fail if index.html is stale (CI uses this)
```

`index.html` is generated but **committed**, so a clone can open the playground
with no build step and no hosting. The cost of committing generated output is
that it silently goes stale, which is why CI runs `--check`.

Source layout:

```
playground.ts        compile/render/format logic and the demo host — no DOM
shell.html           the page, with a /*__ORBIT_BUNDLE__*/ placeholder
build.mjs            esbuild bundle -> inlined into shell.html
playground.test.ts   asserts the examples demonstrate what they claim
```

`playground.test.ts` exists because a playground whose "XSS is a compile error"
example quietly compiled would be worse than having no playground at all.
