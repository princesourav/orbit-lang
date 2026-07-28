#!/usr/bin/env node
/**
 * Build the island swap script, and enforce its budget.
 *
 * This ships to browsers, which makes it different from everything else in the
 * repository: a size regression here is paid by every visitor to every page. So
 * the budget is a BUILD failure, not a warning, and it is set now — while the
 * artifact is small and nobody has a reason to argue with it. A budget added
 * after the first regression is a budget set to whatever the regression was.
 *
 * The SRI hash is emitted as a build artifact rather than computed by the host.
 * A host that computes its own hash is a host that can get it wrong silently,
 * and `integrity` that does not match simply blocks the script — which looks
 * exactly like the island endpoint being down.
 *
 * Usage:
 *   node runtime/build.mjs           # build, write, report
 *   node runtime/build.mjs --check   # fail if dist is stale or over budget
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'islands.js');
const OUT_DIR = path.join(HERE, 'dist');
const OUT_JS = path.join(OUT_DIR, 'orbit-islands.min.js');
const OUT_META = path.join(OUT_DIR, 'orbit-islands.json');

/**
 * Bytes, minified, before transport compression.
 *
 * Well inside the 10KB runtime ceiling. The number is deliberately close to
 * what the script actually costs today: a budget with generous headroom is a
 * budget that never fires, and the point is to notice the first regression
 * rather than the tenth.
 */
export const SIZE_BUDGET = 2048;

/** Bumped independently of the engine; a theme pins the version it was built against. */
export const RUNTIME_VERSION = '1.0.0';

async function compile() {
  const result = await build({
    entryPoints: [SRC],
    bundle: true,
    minify: true,
    format: 'iife',
    // The floor a shipped script may assume. Older engines get the script and
    // no islands, which degrades to the fallback — the same as a failed fetch.
    target: ['es2018'],
    write: false,
    legalComments: 'none',
  });
  const file = result.outputFiles[0];
  if (file === undefined) throw new Error('esbuild produced no output');
  return file.text;
}

function sriOf(code) {
  return 'sha384-' + createHash('sha384').update(code, 'utf8').digest('base64');
}

function metaFor(code) {
  return (
    JSON.stringify(
      {
        name: 'orbit-islands',
        version: RUNTIME_VERSION,
        bytes: Buffer.byteLength(code, 'utf8'),
        budget: SIZE_BUDGET,
        integrity: sriOf(code),
        // What a host puts in the page. Written out so the integrity value and
        // the tag that carries it cannot drift apart.
        tag:
          `<script src="/orbit-islands.min.js" integrity="${sriOf(code)}" ` +
          `crossorigin="anonymous" data-endpoint="/_islands" data-token="…" defer></script>`,
      },
      null,
      2,
    ) + '\n'
  );
}

async function main(argv) {
  const check = argv.includes('--check');
  const code = await compile();
  const bytes = Buffer.byteLength(code, 'utf8');

  if (bytes > SIZE_BUDGET) {
    console.error(
      `orbit-islands: ${String(bytes)} bytes exceeds the ${String(SIZE_BUDGET)}-byte budget by ${String(bytes - SIZE_BUDGET)}.`,
    );
    console.error('  Raise SIZE_BUDGET deliberately, in the commit that needs it, or make it smaller.');
    return 1;
  }

  const meta = metaFor(code);

  if (check) {
    if (!existsSync(OUT_JS) || !existsSync(OUT_META)) {
      console.error('orbit-islands: dist is missing — run: node runtime/build.mjs');
      return 1;
    }
    if (readFileSync(OUT_JS, 'utf8') !== code || readFileSync(OUT_META, 'utf8') !== meta) {
      console.error('orbit-islands: dist is STALE — run: node runtime/build.mjs');
      return 1;
    }
    console.log(
      `orbit-islands: up to date (${String(bytes)}/${String(SIZE_BUDGET)} bytes, v${RUNTIME_VERSION})`,
    );
    return 0;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JS, code, 'utf8');
  writeFileSync(OUT_META, meta, 'utf8');
  console.log(
    `orbit-islands: wrote ${String(bytes)}/${String(SIZE_BUDGET)} bytes, v${RUNTIME_VERSION}, ${sriOf(code)}`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/') ?? ''}` || process.argv[1]?.endsWith('build.mjs')) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
