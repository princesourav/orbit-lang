# Embedding Orbit from a non-JavaScript host

Orbit ships as a TypeScript library. If your platform is Ruby, Java, Python,
PHP, Go or .NET, you cannot `import` it — and the segment that most needs a safe
template language for untrusted authors is largely built on those stacks.

This page describes the three patterns that work today, honestly including what
each costs. A native second implementation is the real answer and is not built;
see [conformance](../../conformance/README.md) if you want to build one.

---

## Pattern 1 — Sidecar render service

Run the engine as a small HTTP service. Your application calls it.

```
your app  ──POST /render──▶  orbit-sidecar (Node)  ──▶  HTML
   (Ruby/Java/Python)          @orbitlang/core
```

A minimal sidecar:

```js
import { createServer } from 'node:http';
import { loadCheckedAst, render } from '@orbitlang/core';

const server = createServer(async (req, res) => {
  const body = JSON.parse(await text(req));

  // The AST was compiled and stored at publish time; the render path never
  // parses source. Verify it, because the row is executable.
  const program = loadCheckedAst(body.ast, { trust: 'verify' });

  const result = render(program, body.entry, {
    bindings: body.bindings,
    hostFilters: FILTERS,
    settings: body.settings,
    fuel: 250_000,
    deadlineMs: 50,
    maxOutput: 512 * 1024,
    urlPolicy: 'error',
  });

  res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result.ok
    ? { html: result.html, warnings: result.warnings }
    : { error: result.error }));
});
```

**Good:** the engine runs exactly as designed, every guarantee intact, and you
upgrade it independently of your application.

**Costs, stated plainly:**

- **A network hop per render.** Same-host over a Unix socket keeps this to
  hundreds of microseconds; across a network it will dominate.
- **A Node runtime to operate** — deployment, monitoring, patching.
- **Data crosses a boundary.** Bindings are serialized. That is a place tenant
  data can leak if the sidecar is reachable from anywhere it should not be.
  Bind it to localhost or a socket, never a shared network.

**Fits:** you already run a polyglot service mesh, or renders are infrequent
enough that a hop does not matter.

---

## Pattern 2 — Precompile to a signed AST, render at the edge

Split the work by lifecycle. Compile in your pipeline; render wherever.

```
publish time (CI, Node):     source ──parse+check──▶ AST ──sign──▶ database
render time (edge, Node):    AST ──verify──▶ render ──▶ HTML
```

Your non-JS application never touches the engine. It manages templates, stores
the signed AST, and serves the rendered result — while parsing, checking and
rendering happen where JavaScript already runs, which for most of these
architectures is the CDN edge.

```js
// Publish (CI):
const parsed = parseProgram(files);
const checked = check(parsed.program, host);
if (checked.diagnostics.some((d) => d.severity === 'error')) fail(checked);

const ast = JSON.stringify(serializeProgram(parsed.program));
const tag = signAst(hmac, key, { storeId, themeVersionId, astBytes: bytes(ast) });
await db.save({ storeId, themeVersionId, ast, tag });
```

**Good:** no render-time hop, no Node in your request path, and the expensive
half happens once per publish rather than once per request.

**Costs:**

- **Two runtimes to operate**, even if only one is in the request path.
- **Key custody.** The signing key is now a thing you own and rotate.
- **Deployment coupling.** An engine upgrade means recompiling stored ASTs if
  the serialized format changed. It is covered by
  [the stability policy](../../STABILITY.md) within a major version, but a major
  bump means a migration.

**Fits:** commerce and content platforms that already publish themes, and
anything rendering on Cloudflare Workers, Vercel or Fastly.

---

## Pattern 3 — Compile-only integration

Use Orbit as a *validator* in your pipeline and keep your existing renderer.

Run `orbit check --format json` over authored templates in CI. You get the type
laws, the allowlists and the diagnostics, without changing what renders.

```bash
npx orbit check themes/ --format json > report.json
```

**Good:** almost no integration work, and it catches the class of bug Orbit
exists to catch, at authoring time.

**Cost, and it is the important one:** you get **none of the runtime
guarantees**. No structural escaping, no budgets, no sanitized URL sinks —
because your renderer is still the one producing HTML. This is a linting story,
not a security story, and should not be described internally as the latter.

**Fits:** an incremental first step while evaluating one of the patterns above.

---

## Which to choose

| Your situation | Pattern |
|---|---|
| Templates are published, then rendered many times | **2** — precompiled signed AST |
| Rendering is already at the edge | **2** |
| Polyglot services, renders are not hot | **1** — sidecar |
| Evaluating Orbit, cannot change the render path yet | **3** — compile-only |
| You need a native library in-process | Not available. See below. |

## The honest gap

None of these is as good as a native library in your language. Pattern 1 costs a
hop, pattern 2 costs a second runtime, pattern 3 gives up the runtime guarantees
entirely.

The real answer is a second implementation, and the
[conformance corpus](../../conformance/README.md) exists to make one verifiable:
620 language-agnostic cases, a documented host contract, and a reference runner
that is roughly a page of code. An implementation that passes them all is Orbit,
and that claim is checkable rather than asserted.

If you are considering building one, the corpus is the specification of what
you have to match — start there rather than with this engine's source.
