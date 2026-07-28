/**
 * Generate llms.txt and llms-full.txt.
 *
 * `llms.txt` is a short index a model (or an agent fetching docs) can read to
 * find its way around. `llms-full.txt` is the whole documentation set inlined,
 * for the case where one fetch is cheaper than ten.
 *
 * Both are generated rather than hand-written, for the same reason the error
 * index is: a hand-maintained copy of the docs drifts from the docs, and a
 * stale copy aimed specifically at machines is worse than none — it is
 * confidently wrong at scale.
 *
 * Run:  node scripts/gen-llms-txt.mjs
 *       node scripts/gen-llms-txt.mjs --check    (CI: fail if stale)
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOCS = path.join(ROOT, 'docs');

/** Docs in reading order; anything not listed is appended alphabetically. */
const ORDER = [
  'language/tutorial.md',
  'language/safety.md',
  'language/templates.md',
  'language/components.md',
  'language/types.md',
  'reference/grammar.md',
  'reference/filters.md',
  'reference/limits.md',
  'reference/errors.md',
  'guides/embedding.md',
  'guides/security-model.md',
];

const DESCRIPTIONS = {
  'language/tutorial.md': 'Your first component, end to end.',
  'language/safety.md':
    'The two rules that cause most first-hour errors: no truthiness, and the optional law.',
  'language/templates.md':
    'Markup rules: the closed element allowlist, attributes, whitespace, RCDATA, JSON-LD.',
  'language/components.md': 'Components vs pages, props, slots, <let>, settings.',
  'language/types.md': 'The type system, including the branded terminal types.',
  'reference/grammar.md': 'Full grammar and operator precedence.',
  'reference/filters.md': 'All 19 stdlib filters with signatures and limitations.',
  'reference/limits.md': 'Every cap, its value, and the diagnostic it trips.',
  'reference/errors.md': 'Every diagnostic code, generated from source.',
  'guides/embedding.md': 'Implementing a host: types, filters, stored ASTs, access plans.',
  'guides/security-model.md':
    'Threat model, each guarantee and its mechanism, and what Orbit does NOT protect against.',
};

function docFiles(dir = DOCS, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    // compliance/ is process paperwork (CRA readiness, the claims manifest).
    // Useful to a human auditor, noise to a model writing a template.
    if (rel.startsWith('compliance')) continue;
    if (statSync(abs).isDirectory()) out.push(...docFiles(abs, rel));
    else if (entry.endsWith('.md') && rel !== 'README.md') out.push(rel);
  }
  return out;
}

const found = docFiles();
const ordered = [...ORDER.filter((f) => found.includes(f)), ...found.filter((f) => !ORDER.includes(f))];

const REPO = 'https://github.com/princesourav/orbit-lang';
const BLOB = `${REPO}/blob/main`;

// --- llms.txt --------------------------------------------------------------

const index = `# Orbit

> A typed, non-Turing-complete, HTML-strict template language for storefronts,
> content sites, and anywhere templates are authored by people — or models — you
> do not fully trust. XSS is a compile error, resource exhaustion is a budget
> trip, and the data a template can touch is statically extractable.

Orbit is NOT Liquid, Jinja, Handlebars or JSX. Habits from those produce code
that does not compile. The rules that most often surprise:

- \`<if>\` requires a \`Bool\`. There is no truthiness.
- A \`T?\` value must be given \`??\` or narrowed with \`!= none\` before use.
- Only allowlisted HTML. No \`<script>\`, no \`on*\` handlers, no \`<iframe>\`.
- \`style\` attributes must be fully static.
- No method calls (\`{x |> upper}\`, not \`{x.upper()}\`) and no dynamic member access.
- \`<for>\` requires an \`<empty>\` block as its last child.
- \`|>\` is the LOOSEST operator, so a comparison after a pipeline needs parentheses.

## Generating Orbit

- [System prompt](${BLOB}/llm/system-prompt.md): paste into a model's system prompt. Dense, rule-shaped, states the failure modes.
- [Eval harness](${BLOB}/llm/eval/): measures generate → compile → repair success. Runs offline.

## Documentation

${ordered.map((f) => `- [${path.basename(f, '.md')}](${BLOB}/docs/${f}): ${DESCRIPTIONS[f] ?? ''}`.trimEnd()).join('\n')}

## Optional

- [Full documentation, inlined](${BLOB}/llms-full.txt)
- [Examples](${BLOB}/examples/): six real templates, compiled by CI.
- [Playground](${BLOB}/playground/): single self-contained HTML file, runs offline.
`;

// --- llms-full.txt ---------------------------------------------------------

const parts = [
  `# Orbit — complete documentation`,
  '',
  `Generated from ${REPO}. Do not edit by hand.`,
  '',
  `Orbit is a typed, non-Turing-complete, HTML-strict template language. This`,
  `file inlines every documentation page in reading order.`,
  '',
];

for (const file of ordered) {
  const body = readFileSync(path.join(DOCS, file), 'utf8').trimEnd();
  parts.push('', '='.repeat(78), `FILE: docs/${file}`, '='.repeat(78), '', body, '');
}

const full = parts.join('\n').trimEnd() + '\n';

// --- write or check --------------------------------------------------------

const targets = [
  [path.join(ROOT, 'llms.txt'), index],
  [path.join(ROOT, 'llms-full.txt'), full],
];

if (process.argv.includes('--check')) {
  let stale = 0;
  for (const [file, expected] of targets) {
    let actual;
    try {
      actual = readFileSync(file, 'utf8');
    } catch {
      process.stderr.write(`${path.basename(file)} is missing\n`);
      stale += 1;
      continue;
    }
    if (actual !== expected) {
      process.stderr.write(`${path.basename(file)} is stale\n`);
      stale += 1;
    }
  }
  if (stale > 0) {
    process.stderr.write('run `node scripts/gen-llms-txt.mjs` and commit the result\n');
    process.exit(1);
  }
  process.stdout.write(`llms.txt and llms-full.txt are up to date (${ordered.length} pages)\n`);
} else {
  for (const [file, contents] of targets) writeFileSync(file, contents, 'utf8');
  process.stdout.write(
    `wrote llms.txt and llms-full.txt (${ordered.length} pages, ${(full.length / 1024).toFixed(0)} KB)\n`,
  );
}
