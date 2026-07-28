/**
 * Build the browser playground.
 *
 * The playground is a single self-contained HTML file with the whole engine
 * inlined. That is possible only because Orbit has zero runtime dependencies
 * and does no I/O — there is no server, no API, and nothing to deploy beyond
 * copying one file. Open it from a file:// URL and it works.
 *
 * It is also the cheapest honest demonstration of the pitch: a visitor can
 * paste a hostile template and watch it fail to compile in their own browser,
 * with no trust in us required.
 *
 * Run: node playground/build.mjs
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const result = await build({
  entryPoints: [path.join(HERE, 'playground.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'OrbitPlayground',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  write: false,
  // The engine touches no node builtin, so an empty shim list is the correct
  // configuration — if this ever needs a polyfill, something has gone wrong
  // with the zero-I/O guarantee and the build should fail loudly instead.
  external: [],
});

const bundled = result.outputFiles[0].text;
const shell = await readFile(path.join(HERE, 'shell.html'), 'utf8');

const marker = '/*__ORBIT_BUNDLE__*/';
if (!shell.includes(marker)) {
  throw new Error(`shell.html is missing the ${marker} placeholder`);
}

const html = shell.replace(marker, bundled);
const out = path.join(ROOT, 'playground', 'index.html');
const kb = (html.length / 1024).toFixed(0);

/*
 * `--check` verifies the committed artifact matches the current source instead
 * of rewriting it. index.html is generated but committed, so that a clone can
 * open the playground with no build step and no hosting — which is most of its
 * value. The cost of committing generated output is that it silently goes
 * stale, so CI runs this mode and fails the build when it has.
 */
if (process.argv.includes('--check')) {
  let existing;
  try {
    existing = await readFile(out, 'utf8');
  } catch {
    process.stderr.write('playground: index.html is missing — run `npm run playground`\n');
    process.exit(1);
  }
  if (existing !== html) {
    process.stderr.write(
      'playground: index.html is stale — run `npm run playground` and commit the result\n',
    );
    process.exit(1);
  }
  process.stdout.write(`playground: index.html is up to date (${kb} KB)\n`);
} else {
  await writeFile(out, html, 'utf8');
  process.stdout.write(`playground: wrote ${path.relative(ROOT, out)} (${kb} KB, self-contained)\n`);
}
