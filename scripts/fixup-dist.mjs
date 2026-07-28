#!/usr/bin/env node
/**
 * Post-build fixup for the dual ESM/CJS artifact layout.
 *
 * Two jobs:
 *
 *  1. Drop a format marker into each output directory —
 *     dist/cjs/package.json = {"type":"commonjs"} and
 *     dist/esm/package.json = {"type":"module"} — so Node resolves each half
 *     correctly no matter what the root package.json says.
 *
 *  2. Rewrite relative module specifiers in the EMITTED dist/esm/*.js and
 *     dist/esm/*.d.ts so they carry an explicit `.js` extension.
 *
 * Why (2) exists: src/ uses extensionless relative imports (`from './ast'`).
 * That is legal TypeScript under bundler resolution and keeps src/ free of
 * build-format concerns, but real Node ESM requires a full specifier. Rather
 * than rewriting src/, the transform runs over tsc's output — a small,
 * well-tested pass on generated code (see fixup-dist.test.mjs).
 *
 * Zero dependencies; Node builtins only.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Specifier suffixes that are already explicit — never touched. */
const EXPLICIT_SUFFIXES = ['.js', '.mjs', '.cjs', '.json', '.node', '.css'];

const IDENT_START =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const IDENT_PART = IDENT_START + '0123456789';

function isIdentStart(ch) {
  return IDENT_START.indexOf(ch) !== -1;
}
function isIdentPart(ch) {
  return IDENT_PART.indexOf(ch) !== -1;
}
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Scan past a quoted string starting at `i` (src[i] is the quote).
 * Returns the index one past the closing quote. Handles escapes, and
 * `${ ... }` substitutions inside template literals (including nested
 * strings/templates within them).
 */
function scanString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    if (quote === '`' && ch === '$' && src[j + 1] === '{') {
      j = scanTemplateSubstitution(src, j + 2);
      continue;
    }
    if (quote !== '`' && (ch === '\n' || ch === '\r')) return j; // unterminated; bail
    j++;
  }
  return j;
}

/** Scan the interior of a `${ ... }`, returning the index one past the `}`. */
function scanTemplateSubstitution(src, i) {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '"' || ch === "'" || ch === '`') {
      j = scanString(src, j);
      continue;
    }
    if (ch === '{') {
      depth++;
      j++;
      continue;
    }
    if (ch === '}') {
      depth--;
      j++;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  return j;
}

/**
 * Rewrite every relative module specifier in `source` using `resolve`.
 *
 * `resolve(specifier)` receives the raw specifier text (no quotes) and returns
 * the replacement, or the same string to leave it alone.
 *
 * A string literal is treated as a module specifier when the preceding
 * significant token is `from`, `import`, or when it sits directly inside
 * `import(...)` / `require(...)`. Everything else — ordinary strings, object
 * keys, template literals — is copied through untouched.
 *
 * Note: JS regex literals are not detected. The Orbit sources contain no regex
 * (hard project invariant W-04c), so a `/` in the emitted output is always
 * division or a comment.
 */
export function rewriteModuleSpecifiers(source, resolve) {
  let out = '';
  let i = 0;
  /** last significant token, and the one before it */
  let prev = '';
  let prev2 = '';

  const push = (tok) => {
    prev2 = prev;
    prev = tok;
  };

  while (i < source.length) {
    const ch = source[i];

    if (isSpace(ch)) {
      out += ch;
      i++;
      continue;
    }

    // comments
    if (ch === '/' && source[i + 1] === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j++;
      out += source.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const j = end === -1 ? source.length : end + 2;
      out += source.slice(i, j);
      i = j;
      continue;
    }

    // string / template literal
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = scanString(source, i);
      const raw = source.slice(i, end);
      const isSpecifierSlot =
        ch !== '`' &&
        (prev === 'from' ||
          prev === 'import' ||
          (prev === '(' && (prev2 === 'import' || prev2 === 'require')));
      if (isSpecifierSlot && end > i + 1) {
        const value = raw.slice(1, -1);
        const next = resolve(value);
        out += ch + next + ch;
      } else {
        out += raw;
      }
      i = end;
      push('<string>');
      continue;
    }

    // identifier / keyword
    if (isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);
      out += word;
      i = j;
      push(word);
      continue;
    }

    // number-ish and everything else: single character token
    out += ch;
    i++;
    push(ch);
  }

  return out;
}

/**
 * Build a resolver for a file living in `dir` within `outDir`.
 * Adds `.js` to extensionless relative specifiers, preferring a sibling file
 * and falling back to `/index.js` when the specifier names a directory.
 */
export function makeResolver(dir, exists = existsSync) {
  return (spec) => {
    if (!spec.startsWith('./') && !spec.startsWith('../')) return spec;
    for (const suffix of EXPLICIT_SUFFIXES) {
      if (spec.endsWith(suffix)) return spec;
    }
    if (spec.endsWith('/')) return spec + 'index.js';
    if (exists(path.join(dir, spec + '.js'))) return spec + '.js';
    if (exists(path.join(dir, spec, 'index.js'))) return spec + '/index.js';
    return spec + '.js';
  };
}

/** Recursively collect files under `dir` matching one of `suffixes`. */
async function collect(dir, suffixes, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, suffixes, acc);
    } else if (suffixes.some((s) => entry.name.endsWith(s))) {
      acc.push(full);
    }
  }
  return acc;
}

async function writeTypeMarker(dir, type) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'package.json');
  await writeFile(file, JSON.stringify({ type }, null, 2) + '\n', 'utf8');
  return file;
}

async function main() {
  const cjsDir = path.join(ROOT, 'dist', 'cjs');
  const esmDir = path.join(ROOT, 'dist', 'esm');

  const missing = [cjsDir, esmDir].filter((d) => !existsSync(d));
  if (missing.length > 0) {
    process.stderr.write(
      'fixup-dist: missing build output:\n' +
        missing.map((d) => '  - ' + path.relative(ROOT, d)).join('\n') +
        '\nRun `npm run build:cjs` and `npm run build:esm` first.\n'
    );
    process.exit(1);
  }

  await writeTypeMarker(cjsDir, 'commonjs');
  await writeTypeMarker(esmDir, 'module');

  const files = await collect(esmDir, ['.js', '.d.ts', '.mjs']);
  let rewritten = 0;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const next = rewriteModuleSpecifiers(source, makeResolver(path.dirname(file)));
    if (next !== source) {
      await writeFile(file, next, 'utf8');
      rewritten++;
    }
  }

  const shebanged = await addCliShebang(path.join(ROOT, 'dist', 'cli', 'cli.js'));

  process.stdout.write(
    `fixup-dist: wrote type markers; rewrote specifiers in ${rewritten}/${files.length} dist/esm files` +
      `${shebanged ? '; added CLI shebang' : ''}\n`
  );
}

/**
 * Prepend `#!/usr/bin/env node` to the built CLI.
 *
 * npm creates a shim on Windows regardless, but on Linux and macOS it symlinks
 * the file into .bin and the kernel needs the interpreter line to execute it —
 * without this, `orbit` installs cleanly and then fails with an exec format
 * error. tsc has no banner option, so it is added here.
 *
 * Also marks the file executable where the platform has a mode bit.
 */
async function addCliShebang(cliPath) {
  let source;
  try {
    source = await readFile(cliPath, 'utf8');
  } catch {
    return false; // build:cli did not run; the caller's checks report that
  }
  if (source.startsWith('#!')) return false;
  await writeFile(cliPath, `#!/usr/bin/env node\n${source}`, 'utf8');
  try {
    await chmod(cliPath, 0o755);
  } catch {
    // Windows has no executable bit; npm's shim handles it there.
  }
  return true;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write('fixup-dist failed: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    process.exit(1);
  });
}
