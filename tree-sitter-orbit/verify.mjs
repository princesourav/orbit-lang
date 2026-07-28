/**
 * Verify the Orbit tree-sitter grammar against the real language.
 *
 * Grammar generation only proves the grammar is well-formed and free of LR
 * conflicts — it proves nothing about whether the grammar accepts Orbit. This
 * script closes that gap by parsing every `.orbit` file in `examples/` (which
 * a separate test already proves the real engine accepts) and asserting the
 * tree-sitter parse has no ERROR or MISSING nodes.
 *
 * It loads the compiled `.wasm` through `web-tree-sitter` rather than a native
 * `.dll`/`.so`, so it runs anywhere Node runs — no C toolchain required. That
 * matters on Windows, where the tree-sitter CLI needs a 64-bit compiler that
 * many dev machines do not have.
 *
 * Build the wasm first:  npx tree-sitter build --wasm   (needs docker/emscripten)
 * Then:                  node verify.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language, Query } from 'web-tree-sitter';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, 'tree-sitter-orbit.wasm');
const EXAMPLES = path.resolve(HERE, '..', 'examples');

/** Recursively collect every `.orbit` file under `dir`. */
function orbitFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...orbitFiles(full));
    else if (entry.endsWith('.orbit')) out.push(full);
  }
  return out.sort();
}

/**
 * Walk the tree and collect every ERROR / MISSING node. Tree-sitter never
 * fails outright — it recovers and marks the damage — so "did it parse?" is
 * exactly the question "are there any error nodes?".
 */
function defects(tree) {
  const found = [];
  const cursor = tree.walk();
  const visit = () => {
    const node = cursor.currentNode;
    if (node.isError || node.isMissing) {
      found.push({
        kind: node.isMissing ? 'MISSING' : 'ERROR',
        type: node.type,
        row: node.startPosition.row + 1,
        col: node.startPosition.column + 1,
        text: node.text.slice(0, 60).replace(/\n/g, '\\n'),
      });
    }
    if (cursor.gotoFirstChild()) {
      do visit();
      while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };
  visit();
  return found;
}

if (!existsSync(WASM)) {
  console.error(
    `missing ${path.relative(process.cwd(), WASM)}\n` +
      'build it first: npx tree-sitter build --wasm',
  );
  process.exit(2);
}

await Parser.init();
const parser = new Parser();
const language = await Language.load(WASM);
parser.setLanguage(language);

// Queries are the other half of the grammar, and they fail silently in most
// editors: a capture naming a node that does not exist is simply never applied,
// so highlighting degrades quietly instead of erroring. Compiling each query
// here turns that into a hard failure.
let queryFailures = 0;
const queryDir = path.join(HERE, 'queries');
if (existsSync(queryDir)) {
  for (const file of readdirSync(queryDir).filter((f) => f.endsWith('.scm'))) {
    const source = readFileSync(path.join(queryDir, file), 'utf8');
    // A comments-only query (injections.scm) compiles to zero patterns, which
    // is valid and intentional — do not treat it as a failure.
    try {
      const query = new Query(language, source);
      console.log(`ok   queries/${file} (${query.patternCount()} pattern(s))`);
    } catch (err) {
      queryFailures++;
      console.log(`FAIL queries/${file}\n       ${String(err.message).trim()}`);
    }
  }
}

const files = orbitFiles(EXAMPLES);
if (files.length === 0) {
  console.error(`no .orbit files found under ${EXAMPLES}`);
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const rel = path.relative(path.resolve(HERE, '..'), file);
  const tree = parser.parse(readFileSync(file, 'utf8'));
  const bad = defects(tree);
  if (bad.length === 0) {
    console.log(`ok   ${rel}`);
  } else {
    failed++;
    console.log(`FAIL ${rel}`);
    for (const d of bad.slice(0, 5)) {
      console.log(`       ${d.kind} at ${d.row}:${d.col} (${d.type}) ${d.text}`);
    }
    if (bad.length > 5) console.log(`       … and ${bad.length - 5} more`);
  }
}

const ok = failed === 0 && queryFailures === 0;
console.log(
  ok
    ? `\ngrammar OK — ${files.length} example(s) parsed with no ERROR/MISSING nodes, all queries compile`
    : `\ngrammar FAILED — ${failed}/${files.length} example(s) did not parse cleanly, ` +
        `${queryFailures} query file(s) failed to compile`,
);
process.exit(ok ? 0 : 1);
