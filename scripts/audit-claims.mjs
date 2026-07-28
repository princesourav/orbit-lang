#!/usr/bin/env node
/**
 * Claims audit — the "no unbacked marketing claim" gate.
 *
 * Reads docs/compliance/claims.md, a markdown table of
 *
 *     | claim | evidence | kind |
 *
 * rows where `evidence` is a repo-relative path. Every evidence path must
 * exist on disk, and every row with `kind = test` must point at a file the
 * test runner (vitest) would actually execute — otherwise the claim is backed
 * by a file nobody runs.
 *
 * Exits non-zero with a per-row message on any failure, including a missing
 * claims file. Silence is never success: an empty or unparseable table is an
 * error too.
 *
 * Usage:
 *   node scripts/audit-claims.mjs [--file <path>] [--root <dir>] [--quiet]
 *
 * Zero dependencies; Node builtins only.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CLAIMS = 'docs/compliance/claims.md';

/** Extensions vitest's default `include` glob matches. */
const TEST_EXTENSIONS = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx'];
/** Directory segments vitest's default `exclude` glob drops. */
const EXCLUDED_SEGMENTS = [
  'node_modules',
  'dist',
  '.git',
  '.idea',
  '.cache',
  '.output',
  '.temp',
  '.nuxt',
  '.next',
  '.vercel',
];
/**
 * Recognised values of the `kind` column.
 *
 * `test` = an executable assertion; the file must be one vitest actually runs.
 * `artifact` = a shipped file whose contents are the claim (a closed table, a
 * cap constant, a license, a policy doc); existence is all that is checked.
 * The remaining values are accepted synonyms for `artifact`-style evidence.
 */
const KINDS = ['test', 'artifact', 'code', 'doc', 'config', 'workflow'];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** True for a markdown table separator row such as `|---|:---:|---|`. */
function isSeparatorRow(cells) {
  if (cells.length === 0) return false;
  return cells.every((c) => {
    const t = c.trim();
    if (t.length < 1) return false;
    for (const ch of t) {
      if (ch !== '-' && ch !== ':' && ch !== ' ') return false;
    }
    return t.indexOf('-') !== -1;
  });
}

/** Split one markdown table line into trimmed cells, honouring `\|` escapes. */
function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  // A well-formed row is bounded by pipes, producing empty first/last cells.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/**
 * Normalise an evidence cell into a plain repo-relative path.
 * Accepts `path`, `` `path` ``, `[label](path)`, `<path>`, and tolerates a
 * trailing `#anchor` or `:12` line reference.
 */
export function normalizeEvidence(cell) {
  let s = cell.trim();
  if (s === '') return '';

  // [label](target)
  if (s.startsWith('[')) {
    const close = s.indexOf('](');
    const end = s.lastIndexOf(')');
    if (close !== -1 && end > close) s = s.slice(close + 2, end).trim();
  }
  // <target>
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  // `target`
  while (s.startsWith('`') && s.endsWith('`') && s.length >= 2) s = s.slice(1, -1).trim();

  // strip a #fragment
  const hash = s.indexOf('#');
  if (hash > 0) s = s.slice(0, hash);

  // strip a :line[:col] suffix, but never a drive letter or URL scheme
  const colon = s.lastIndexOf(':');
  if (colon > 1) {
    const tail = s.slice(colon + 1);
    let allDigits = tail.length > 0;
    for (const ch of tail) {
      if (ch < '0' || ch > '9') allDigits = false;
    }
    if (allDigits) s = s.slice(0, colon);
  }

  s = s.trim();
  while (s.startsWith('./')) s = s.slice(2);
  return s.split('\\').join('/');
}

/**
 * Parse the claims markdown into rows.
 *
 * The document is a sequence of `## Section` headings each followed by its own
 * `| claim | evidence | kind |` table, so header rows repeat and every one of
 * them opens a new table. Prose lines are ignored even when they contain a
 * pipe — a line only becomes a data row once a header + separator pair has
 * opened a table and no blank/pipe-free line has closed it.
 *
 * Returns `{ rows, errors }`; `rows` are `{ claim, evidence, kind, line }`.
 */
export function parseClaims(markdown) {
  const rows = [];
  const errors = [];
  const lines = markdown.split('\n');
  let seenHeader = false;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.indexOf('|') === -1) {
      inTable = false;
      continue;
    }

    const cells = splitRow(line);

    if (cells.length >= 3 && isSeparatorRow(cells)) {
      inTable = true;
      continue;
    }

    const lower = cells.map((c) => c.toLowerCase());
    if (
      cells.length === 3 &&
      lower[0] === 'claim' &&
      lower[1] === 'evidence' &&
      lower[2] === 'kind'
    ) {
      seenHeader = true;
      inTable = false; // the separator row that follows opens the table
      continue;
    }

    if (!inTable) continue; // prose containing a pipe, or a row before any table

    if (cells.length !== 3) {
      errors.push({
        line: i + 1,
        message: `table row has ${cells.length} column(s), expected 3 (| claim | evidence | kind |)`,
      });
      continue;
    }

    rows.push({
      claim: cells[0],
      evidence: cells[1],
      kind: cells[2].toLowerCase(),
      line: i + 1,
    });
  }

  if (!seenHeader) {
    errors.push({
      line: 0,
      message: 'no `| claim | evidence | kind |` header row found',
    });
  }
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Evidence checks
// ---------------------------------------------------------------------------

/**
 * Would vitest's default `include`/`exclude` globs pick this file up?
 * Default include: **\/*.{test,spec}.?(c|m)[jt]s?(x)
 */
export function vitestWouldRun(relPath) {
  const normalized = relPath.split('\\').join('/');
  const segments = normalized.split('/');
  for (const segment of segments.slice(0, -1)) {
    if (EXCLUDED_SEGMENTS.indexOf(segment) !== -1) return false;
  }
  const base = segments[segments.length - 1] ?? '';
  const parts = base.split('.');
  if (parts.length < 3) return false;
  const ext = parts[parts.length - 1];
  const marker = parts[parts.length - 2];
  if (marker !== 'test' && marker !== 'spec') return false;
  if (TEST_EXTENSIONS.indexOf(ext) === -1) return false;
  return parts.slice(0, -2).join('.').length > 0;
}

/**
 * Is this path tracked by git?
 *
 * Shelled out rather than reimplemented: `.gitignore` semantics are more
 * subtle than they look, and a partial reimplementation would answer wrongly
 * for exactly the nested cases that caused the problem. Where git is not
 * available the check degrades to "assume tracked" — this is a sharpening of
 * the audit, and it must not become a reason the audit cannot run at all.
 */
let trackedCache;

function defaultIsTracked(evidence, root) {
  // ONE `git ls-files` for the whole manifest, not one per row. Three hundred
  // subprocesses took nine seconds and blew the test timeout — the check was
  // right and the way it asked was not.
  if (trackedCache === undefined) {
    try {
      const listing = execFileSync('git', ['ls-files', '-z'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      });
      trackedCache = new Set(listing.split('\0').filter(Boolean));
    } catch {
      // git missing, or not a repository. This check is a sharpening of the
      // audit and must never become a reason it cannot run at all.
      trackedCache = null;
    }
  }
  if (trackedCache === null) return true;
  return trackedCache.has(evidence);
}

/** Check one row. Returns `null` when the row is fine, else a failure string. */
export function checkRow(row, opts) {
  const root = opts.root;
  const exists = opts.exists ?? ((p) => existsSync(p));
  const isFile = opts.isFile ?? ((p) => statSync(p).isFile());

  const evidence = normalizeEvidence(row.evidence);
  if (evidence === '') return 'evidence column is empty';
  if (evidence.startsWith('http://') || evidence.startsWith('https://')) {
    return `evidence must be a repo-relative path, got a URL (${evidence})`;
  }
  if (path.isAbsolute(evidence) || evidence.startsWith('..')) {
    return `evidence must be a repo-relative path inside the repo, got "${evidence}"`;
  }
  if (KINDS.indexOf(row.kind) === -1) {
    return `unknown kind "${row.kind}" (expected one of: ${KINDS.join(', ')})`;
  }

  const abs = path.join(root, evidence);
  if (!exists(abs)) return `evidence file does not exist: ${evidence}`;
  if (!isFile(abs)) return `evidence path is not a file: ${evidence}`;

  /*
   * Evidence must be IN THE REPOSITORY, not a build output.
   *
   * A generated file passes the existence check on a machine that has just
   * built, and fails in CI where the checkout is clean — so a claim backed by
   * one is a claim that appears substantiated locally and is unbacked
   * everywhere else. That is precisely the drift this audit exists to prevent,
   * and it went undetected because the audit only asked whether the file was
   * on disk.
   */
  const tracked = opts.isTracked ?? defaultIsTracked;
  if (!tracked(evidence, root)) {
    return (
      `evidence is not tracked by git: ${evidence} — a build output passes ` +
      'locally and fails on a clean checkout; cite the generator or a test instead'
    );
  }

  if (row.kind === 'test' && !vitestWouldRun(evidence)) {
    return (
      `kind=test but vitest would not run "${evidence}" ` +
      '(needs a *.test.<ext> / *.spec.<ext> name outside node_modules and dist)'
    );
  }
  return null;
}

/** Audit a parsed claims document. Returns `{ ok, failures, rows }`. */
export function auditClaims(markdown, opts = {}) {
  const root = opts.root ?? ROOT;
  const { rows, errors } = parseClaims(markdown);
  const failures = errors.map((e) => ({
    line: e.line,
    claim: '(document)',
    message: e.message,
  }));

  for (const row of rows) {
    const problem = checkRow(row, { root, exists: opts.exists, isFile: opts.isFile });
    if (problem !== null) {
      failures.push({ line: row.line, claim: row.claim, message: problem });
    }
  }

  if (rows.length === 0 && errors.length === 0) {
    failures.push({
      line: 0,
      claim: '(document)',
      message: 'claims table is empty — an empty audit is a failed audit, not a pass',
    });
  }

  return { ok: failures.length === 0, failures, rows };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const opts = { file: DEFAULT_CLAIMS, root: ROOT, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') opts.file = argv[++i];
    else if (arg === '--root') opts.root = path.resolve(argv[++i]);
    else if (arg === '--quiet' || arg === '-q') opts.quiet = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else opts.file = arg;
  }
  return opts;
}

function main(argv) {
  const opts = parseArgv(argv);
  if (opts.help) {
    process.stdout.write(
      'Usage: node scripts/audit-claims.mjs [--file <path>] [--root <dir>] [--quiet]\n'
    );
    return 0;
  }

  const claimsPath = path.isAbsolute(opts.file) ? opts.file : path.join(opts.root, opts.file);
  const rel = path.relative(opts.root, claimsPath).split('\\').join('/');

  if (!existsSync(claimsPath)) {
    process.stderr.write(
      `claims-audit FAILED\n` +
        `  missing claims file: ${rel}\n` +
        `  Every public claim must be listed there with backing evidence.\n` +
        `  Create it as a markdown table: | claim | evidence | kind |\n`
    );
    return 1;
  }

  const markdown = readFileSync(claimsPath, 'utf8');
  const result = auditClaims(markdown, { root: opts.root });

  if (!result.ok) {
    process.stderr.write(`claims-audit FAILED (${rel})\n`);
    for (const f of result.failures) {
      const where = f.line > 0 ? `${rel}:${f.line}` : rel;
      process.stderr.write(`  ${where}: ${f.message}\n`);
      if (f.claim !== '(document)') {
        process.stderr.write(`      claim: ${f.claim}\n`);
      }
    }
    process.stderr.write(
      `  ${result.failures.length} unbacked claim(s) of ${result.rows.length} row(s).\n`
    );
    return 1;
  }

  if (!opts.quiet) {
    process.stdout.write(
      `claims-audit OK — ${result.rows.length} claim(s), every evidence path present` +
        `${result.rows.some((r) => r.kind === 'test') ? ' and every kind=test file runnable by vitest' : ''}.\n`
    );
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
