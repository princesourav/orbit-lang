/**
 * The `orbit` command line: `orbit check` and `orbit fmt`.
 *
 * ## Why this file is allowed to touch the filesystem
 *
 * The engine is zero-I/O by construction — `tsconfig.json` sets `"types": []`
 * and omits the DOM lib precisely so that an accidental `process`, `Buffer` or
 * `document` reference fails to compile. That guarantee is worth keeping, and
 * a CLI obviously needs to read files.
 *
 * The resolution is that this is the ONLY file in `src/` permitted to import a
 * node builtin, it is excluded from the library entrypoint, and nothing in the
 * compiler imports it. Everything below is a thin shell over the same public
 * API an embedder uses; no parsing, checking or formatting logic lives here.
 * `cli.test.ts` asserts the library entrypoint stays free of `node:` imports.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { formatTemplate } from './formatter';
import { parseTemplate } from './parser';
import { formatDiagnosticWithSource, type Diagnostic } from './diagnostics';

const VERSION = '0.5.0';

const USAGE = `orbit ${VERSION} — the Orbit template language

USAGE
  orbit check [paths...]     parse and report diagnostics
  orbit fmt   [paths...]     rewrite templates in canonical form

CHECK OPTIONS
  --format <text|json>       output shape (default: text)

FMT OPTIONS
  --check                    report files that would change; write nothing
  --stdout                   print the result instead of writing it

COMMON
  --no-color                 never emit ANSI colour
  -h, --help                 show this message
  -v, --version              print the version

Paths may be files or directories; directories are searched for .orbit files.
With no paths, the current directory is used.

EXIT CODES
  0  success
  1  diagnostics found, or files are not formatted (with --check)
  2  bad usage, or a path could not be read
`;

interface Options {
  format: 'text' | 'json';
  checkOnly: boolean;
  toStdout: boolean;
  color: boolean;
  paths: string[];
}

/** A file the CLI read, kept together so diagnostics can render its source. */
interface LoadedFile {
  path: string;
  display: string;
  source: string;
}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

function parseArgs(argv: readonly string[]): { command: string; options: Options } | { error: string } {
  const command = argv[0] ?? '';
  const options: Options = {
    format: 'text',
    checkOnly: false,
    toStdout: false,
    // Respect NO_COLOR, and do not colour when the output is being piped —
    // escape sequences in a redirected file are noise, not formatting.
    color: process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true,
    paths: [],
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--no-color':
        options.color = false;
        break;
      case '--check':
        options.checkOnly = true;
        break;
      case '--stdout':
        options.toStdout = true;
        break;
      case '--format': {
        const value = argv[i + 1];
        if (value !== 'text' && value !== 'json') {
          return { error: `--format expects "text" or "json", got ${JSON.stringify(value ?? '')}` };
        }
        options.format = value;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('-')) return { error: `unknown option ${JSON.stringify(arg)}` };
        options.paths.push(arg);
    }
  }

  if (options.paths.length === 0) options.paths.push('.');
  return { command, options };
}

/** Expand paths into `.orbit` files, recursing into directories. */
function collectFiles(paths: readonly string[]): { files: string[] } | { error: string } {
  const files: string[] = [];
  const seen = new Set<string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      // Skip the directories that make a recursive walk pathological. A
      // template estate never lives in node_modules, and descending into it
      // turns `orbit check` into a multi-second no-op.
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.orbit') && !seen.has(full)) {
        seen.add(full);
        files.push(full);
      }
    }
  };

  for (const p of paths) {
    const abs = resolve(p);
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      return { error: `cannot read ${p}` };
    }
    if (stats.isDirectory()) walk(abs);
    else if (!seen.has(abs)) {
      seen.add(abs);
      files.push(abs);
    }
  }
  return { files };
}

function load(files: readonly string[]): { loaded: LoadedFile[] } | { error: string } {
  const loaded: LoadedFile[] = [];
  for (const path of files) {
    try {
      loaded.push({ path, display: relative(process.cwd(), path) || path, source: readFileSync(path, 'utf8') });
    } catch {
      return { error: `cannot read ${path}` };
    }
  }
  return { loaded };
}

/** The stable machine-readable diagnostic shape. Additive changes only. */
function toJson(file: LoadedFile, d: Diagnostic): Record<string, unknown> {
  return {
    file: file.display,
    code: d.code,
    severity: d.severity,
    message: d.message,
    line: d.span?.start.line ?? null,
    col: d.span?.start.col ?? null,
    endLine: d.span?.end.line ?? null,
    endCol: d.span?.end.col ?? null,
    help: d.suggestion ?? null,
  };
}

function runCheck(loaded: readonly LoadedFile[], options: Options, io: CliIo): number {
  const json: Record<string, unknown>[] = [];
  let errors = 0;
  let filesWithErrors = 0;

  for (const file of loaded) {
    const result = parseTemplate(file.source, file.display);
    if (result.ok) continue;
    filesWithErrors += 1;
    for (const d of result.diagnostics) {
      if (d.severity === 'error') errors += 1;
      if (options.format === 'json') json.push(toJson(file, d));
      else io.err(formatDiagnosticWithSource(d, file.source, { color: options.color }) + '\n\n');
    }
  }

  if (options.format === 'json') {
    io.out(JSON.stringify(json, null, 2) + '\n');
  } else if (errors > 0) {
    io.err(`${errors} error${errors === 1 ? '' : 's'} in ${filesWithErrors} file${filesWithErrors === 1 ? '' : 's'}\n`);
  } else {
    io.out(`checked ${loaded.length} file${loaded.length === 1 ? '' : 's'}, no problems found\n`);
  }
  return errors > 0 ? 1 : 0;
}

function runFmt(loaded: readonly LoadedFile[], options: Options, io: CliIo): number {
  let changed = 0;
  let failed = 0;

  for (const file of loaded) {
    const result = parseTemplate(file.source, file.display);
    if (!result.ok) {
      // Formatting a file that does not parse is not a crash and not a silent
      // skip — it is a reported failure, because rewriting a file we could not
      // fully understand is how a formatter eats someone's work.
      failed += 1;
      for (const d of result.diagnostics) {
        io.err(formatDiagnosticWithSource(d, file.source, { color: options.color }) + '\n\n');
      }
      continue;
    }

    const formatted = formatTemplate(result.template);
    if (options.toStdout) {
      io.out(formatted);
      continue;
    }
    // Compare against line-ending-normalized input so a CRLF checkout does not
    // report every file as needing a rewrite.
    if (formatted === file.source.split('\r\n').join('\n')) continue;

    changed += 1;
    if (options.checkOnly) io.err(`would reformat ${file.display}\n`);
    else writeFileSync(file.path, formatted, 'utf8');
  }

  if (failed > 0) {
    io.err(`${failed} file${failed === 1 ? '' : 's'} could not be parsed and ${failed === 1 ? 'was' : 'were'} left untouched\n`);
    return 1;
  }
  if (options.checkOnly) {
    if (changed > 0) {
      io.err(`${changed} file${changed === 1 ? '' : 's'} would be reformatted\n`);
      return 1;
    }
    io.out(`${loaded.length} file${loaded.length === 1 ? '' : 's'} already formatted\n`);
    return 0;
  }
  if (!options.toStdout) {
    io.out(`formatted ${changed} of ${loaded.length} file${loaded.length === 1 ? '' : 's'}\n`);
  }
  return 0;
}

/** Run the CLI. Exported so tests can drive it without spawning a process. */
export function runCli(argv: readonly string[], io: CliIo = defaultIo): number {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    io.out(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === '-v' || argv[0] === '--version') {
    io.out(VERSION + '\n');
    return 0;
  }

  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    io.err(`orbit: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { command, options } = parsed;
  if (command !== 'check' && command !== 'fmt') {
    io.err(`orbit: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    return 2;
  }

  const collected = collectFiles(options.paths);
  if ('error' in collected) {
    io.err(`orbit: ${collected.error}\n`);
    return 2;
  }
  if (collected.files.length === 0) {
    io.err('orbit: no .orbit files found\n');
    return 2;
  }

  const loadResult = load(collected.files);
  if ('error' in loadResult) {
    io.err(`orbit: ${loadResult.error}\n`);
    return 2;
  }

  return command === 'check'
    ? runCheck(loadResult.loaded, options, io)
    : runFmt(loadResult.loaded, options, io);
}

// `require.main === module` is the CommonJS form; the ESM build wraps this file
// with its own entry shim. Guarding means importing the CLI for tests does not
// execute it.
declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}
