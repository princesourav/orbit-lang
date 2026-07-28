/**
 * Orbit LLM eval harness: generate → compile → repair.
 *
 * The claim being measured is specific. A typed, non-Turing-complete template
 * language should be an unusually good target for code generation, because the
 * compiler can tell a model exactly what is wrong in a form it can act on —
 * stable codes, precise spans, and a suggested fix. That is testable rather
 * than rhetorical, and this measures it: how often does a model produce a
 * compiling template first try, and how often does it get there after being
 * handed the diagnostics?
 *
 * The provider is pluggable and the harness runs offline without one, because
 * the compile-and-repair half is the interesting part and it should not require
 * an API key to develop against.
 *
 * Usage:
 *   node harness.mjs --provider mock          # offline, deterministic
 *   node harness.mjs --provider anthropic     # needs ANTHROPIC_API_KEY
 *   node harness.mjs --provider mock --json   # machine-readable
 *
 * Options:
 *   --attempts N   repair rounds after the first attempt (default 2)
 *   --task ID      run one task
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProgram } from '../../src/parser.ts';
import { check } from '../../src/checker.ts';
import { formatDiagnosticWithSource } from '../../src/diagnostics.ts';
import { t, TypeRegistry } from '../../src/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// The host the generated templates are compiled against
// ---------------------------------------------------------------------------

function makeRegistry() {
  const registry = new TypeRegistry();
  registry.defineObject('Product', {
    title: t.string(),
    url: t.url(),
    vendor: t.optional(t.string()),
    price: t.money(),
    available: t.bool(),
    tags: t.list(t.string()),
  });
  registry.defineObject('Collection', {
    title: t.string(),
    products: t.list(t.object('Product')),
  });
  return registry;
}

const HOST_FILTERS = [
  { name: 'money', params: [t.money()], returns: t.moneyText(), impl: () => 'INR 0.00' },
];

const PAGE_GLOBALS = { collection: t.object('Collection') };

/**
 * A ProductCard the generated pages may call, so a task about composition does
 * not also require the model to invent the callee.
 */
const AMBIENT = [
  {
    name: 'ProductCard.orbit',
    source:
      '---\ncomponent ProductCard\nprops {\n  product: Product\n}\n---\n<article><h3>{product.title}</h3></article>\n',
  },
];

/** The host contract, described for the model. */
const HOST_DESCRIPTION = `
Available object types:
  Product { title: String, url: Url, vendor: String?, price: Money, available: Bool, tags: List<String> }
  Collection { title: String, products: List<Product> }

Page globals (available to \`page\` templates):
  collection: Collection

Host filters (in addition to the stdlib):
  money(Money) -> MoneyText

Available components: ProductCard (props: product: Product)
`.trim();

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

function compile(source) {
  const name = 'generated.orbit';
  const defines = source.includes('component ProductCard');
  const files = defines ? [{ name, source }] : [...AMBIENT, { name, source }];

  const parsed = parseProgram(files);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics, source };
  }
  const result = check(parsed.program, {
    registry: makeRegistry(),
    hostFilters: HOST_FILTERS,
    pageGlobals: PAGE_GLOBALS,
  });
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  return { ok: errors.length === 0, diagnostics: errors, source };
}

/** Render diagnostics the way a repair prompt should see them. */
function explain(result) {
  return result.diagnostics
    .map((d) => formatDiagnosticWithSource(d, result.source, { color: false }))
    .join('\n\n');
}

/** Strip markdown fences a model may wrap its answer in. */
function extractSource(text) {
  const fence = text.indexOf('```');
  if (fence === -1) return text.trim();
  const afterOpen = text.indexOf('\n', fence);
  const close = text.indexOf('```', afterOpen);
  if (afterOpen === -1 || close === -1) return text.trim();
  return text.slice(afterOpen + 1, close).trim() + '\n';
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Offline provider.
 *
 * It deliberately answers the first attempt the way a competent model with NO
 * Orbit-specific knowledge does — reaching for truthiness, method calls and a
 * script tag — and then fixes itself when handed diagnostics. That makes the harness runnable, and
 * exercised, without an API key, and it keeps the repair loop honest: the
 * canned first attempts are wrong in the ways the traps predict.
 */
function mockProvider() {
  const firstAttempts = {
    hello: '---\ncomponent Greeting\nprops {\n  name: String\n}\n---\n<h1>{name}</h1>\n',
    'optional-fallback':
      '---\ncomponent Byline\nprops {\n  author: String?\n}\n---\n<p>{author}</p>\n',
    'no-truthiness':
      '---\npage shop\n---\n<if {collection.title}>\n  <h1>{collection.title}</h1>\n</if>\n',
    'loop-with-empty':
      '---\npage shop\n---\n<ul>\n  <for product of={collection.products}>\n    <li>{product.title}</li>\n  </for>\n</ul>\n',
    'no-script':
      '---\npage shop\n---\n<h1>Shop</h1>\n<script>track()</script>\n<button type="button">Track</button>\n',
    'pipe-precedence':
      '---\npage shop\n---\n<if {collection.products |> size > 0}>\n  <p>In stock</p>\n</if>\n',
    'no-method-call': '---\npage shop\n---\n<p>{collection.title.upper()}</p>\n',
    'static-style':
      '---\ncomponent Banner\nsettings {\n  tone: Select("info", "warning") = "info" label "Tone"\n}\n---\n<div style="color: {settings.tone}">Banner</div>\n',
    'money-terminal':
      '---\ncomponent Price\nprops {\n  product: Product\n}\n---\n<p>{product.price}</p>\n',
    'url-attribute':
      '---\ncomponent ProductLink\nprops {\n  product: Product\n}\n---\n<a href={product.url}>{product.title}</a>\n',
    slots:
      '---\ncomponent Card\nslots {\n  header\n  footer?\n}\n---\n<article>\n  <header><slot name="header"/></header>\n  <div><slot/></div>\n  <footer><slot name="footer"/></footer>\n</article>\n',
    narrowing:
      '---\ncomponent Vendor\nprops {\n  product: Product\n}\n---\n<p class="vendor">{product.vendor}</p>\n',
    'escape-literal': '---\npage shop\n---\n<p>a < b</p>\n',
    'nested-components':
      '---\npage shop\n---\n<for product of={collection.products}>\n  <ProductCard product={product}/>\n</for>\n',
  };

  const repairs = {
    'optional-fallback':
      '---\ncomponent Byline\nprops {\n  author: String?\n}\n---\n<p>{author ?? "Anonymous"}</p>\n',
    'no-truthiness':
      '---\npage shop\n---\n<if {collection.title != ""}>\n  <h1>{collection.title}</h1>\n</if>\n',
    'loop-with-empty':
      '---\npage shop\n---\n<ul>\n  <for product of={collection.products}>\n    <li>{product.title}</li>\n    <empty>\n      <li>Nothing here yet.</li>\n    </empty>\n  </for>\n</ul>\n',
    'no-script': '---\npage shop\n---\n<h1>Shop</h1>\n<button type="button">Track</button>\n',
    'pipe-precedence':
      '---\npage shop\n---\n<if {(collection.products |> size) > 0}>\n  <p>In stock</p>\n</if>\n',
    'no-method-call': '---\npage shop\n---\n<p>{collection.title |> upper}</p>\n',
    'static-style':
      '---\ncomponent Banner\nsettings {\n  tone: Select("info", "warning") = "info" label "Tone"\n}\n---\n<div class="banner banner--{settings.tone}">Banner</div>\n',
    'money-terminal':
      '---\ncomponent Price\nprops {\n  product: Product\n}\n---\n<p>{product.price |> money}</p>\n',
    narrowing:
      '---\ncomponent Vendor\nprops {\n  product: Product\n}\n---\n<if {product.vendor != none}>\n  <p class="vendor">{product.vendor}</p>\n</if>\n',
    'escape-literal': '---\npage shop\n---\n<p>a {"<"} b</p>\n',
    'nested-components':
      '---\npage shop\n---\n<for product of={collection.products}>\n  <ProductCard product={product}/>\n  <empty>\n    <p>Nothing here yet.</p>\n  </empty>\n</for>\n',
  };

  return {
    name: 'mock',
    async complete({ taskId, attempt }) {
      if (attempt === 0) return firstAttempts[taskId] ?? '---\npage shop\n---\n<p>x</p>\n';
      return repairs[taskId] ?? firstAttempts[taskId] ?? '---\npage shop\n---\n<p>x</p>\n';
    },
  };
}

/** Anthropic provider. Requires ANTHROPIC_API_KEY; uses fetch, no SDK. */
function anthropicProvider() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set; use --provider mock to run offline');
  }
  const model = process.env.ORBIT_EVAL_MODEL ?? 'claude-sonnet-5';
  const systemPrompt = readFileSync(path.join(ROOT, 'llm', 'system-prompt.md'), 'utf8');

  return {
    name: `anthropic:${model}`,
    async complete({ messages }) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: `${systemPrompt}\n\n${HOST_DESCRIPTION}`,
          messages,
        }),
      });
      if (!response.ok) {
        throw new Error(`anthropic: ${response.status} ${await response.text()}`);
      }
      const body = await response.json();
      return body.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    },
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function assertionsFor(task, source) {
  const failures = [];
  for (const needle of task.must ?? []) {
    if (!source.includes(needle)) failures.push(`missing ${JSON.stringify(needle)}`);
  }
  for (const needle of task.mustNot ?? []) {
    if (source.includes(needle)) failures.push(`contains forbidden ${JSON.stringify(needle)}`);
  }
  return failures;
}

async function runTask(task, provider, maxRepairs) {
  const messages = [
    {
      role: 'user',
      content: `${task.prompt}\n\n${HOST_DESCRIPTION}\n\nReply with only the template, in a single \`\`\`orbit code block.`,
    },
  ];

  let firstTry = false;
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const raw = await provider.complete({ taskId: task.id, attempt, messages });
    const source = extractSource(raw);
    const result = compile(source);
    const assertionFailures = result.ok ? assertionsFor(task, source) : [];
    const passed = result.ok && assertionFailures.length === 0;

    if (attempt === 0) firstTry = passed;
    if (passed) {
      return { id: task.id, passed: true, firstTry, attempts: attempt + 1, source };
    }

    const feedback = result.ok
      ? `The template compiles but does not satisfy the request:\n${assertionFailures.join('\n')}`
      : `The template does not compile:\n\n${explain(result)}`;

    messages.push({ role: 'assistant', content: '```orbit\n' + source + '```' });
    messages.push({
      role: 'user',
      content: `${feedback}\n\nFix it and reply with only the corrected template.`,
    });

    if (attempt === maxRepairs) {
      return {
        id: task.id,
        passed: false,
        firstTry,
        attempts: attempt + 1,
        source,
        failure: result.ok ? assertionFailures.join('; ') : explain(result),
      };
    }
  }
  return { id: task.id, passed: false, firstTry, attempts: maxRepairs + 1 };
}

export async function runEval({ provider, maxRepairs = 2, only } = {}) {
  const { tasks } = JSON.parse(readFileSync(path.join(HERE, 'tasks.json'), 'utf8'));
  const selected = only ? tasks.filter((t) => t.id === only) : tasks;
  const results = [];
  for (const task of selected) {
    results.push(await runTask(task, provider, maxRepairs));
  }
  const passed = results.filter((r) => r.passed).length;
  const firstTry = results.filter((r) => r.firstTry).length;
  return {
    provider: provider.name,
    total: results.length,
    passed,
    firstTry,
    passRate: results.length === 0 ? 0 : passed / results.length,
    firstTryRate: results.length === 0 ? 0 : firstTry / results.length,
    results,
  };
}

export { compile, extractSource, mockProvider, anthropicProvider, HOST_DESCRIPTION };
