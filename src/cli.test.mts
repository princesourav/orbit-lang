import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { runCli, type CliIo } from './cli.ts';

/**
 * CLI tests.
 *
 * `runCli` is exported and takes an injectable IO sink so these run in-process:
 * spawning the built binary would test the build as much as the behaviour, and
 * would not run until after a build step. The built artifact is smoke-tested
 * separately by CI.
 *
 * This file is `.mts` rather than `.ts` because the engine's tsconfig sets
 * `"types": []` to keep node APIs unreachable from the library; the CLI and its
 * test are the deliberate exceptions.
 */

const HEAD = '---\ncomponent Card\n---\n';

/**
 * What `HEAD` looks like after formatting.
 *
 * The `orbit` pragma is always written, even when the source omitted it —
 * absent means the default, so stating it changes no meaning while making every
 * formatted template say which language version it targets.
 */
const CANONICAL_HEAD = '---\norbit 2026\ncomponent Card\n---\n';

function makeIo(): CliIo & { stdout: string; stderr: string } {
  const sink = {
    stdout: '',
    stderr: '',
    out(text: string) {
      sink.stdout += text;
    },
    err(text: string) {
      sink.stderr += text;
    },
  };
  return sink;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-cli-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const full = join(dir, name);
  writeFileSync(full, contents, 'utf8');
  return full;
}

describe('orbit check', () => {
  it('exits 0 and says so when everything parses', () => {
    write('good.orbit', `${HEAD}<p>hello</p>\n`);
    const io = makeIo();
    expect(runCli(['check', dir, '--no-color'], io)).toBe(0);
    expect(io.stdout).toContain('no problems found');
  });

  it('exits 1 and reports every error in a file, with a code frame', () => {
    write('bad.orbit', `${HEAD}<p>a < b</p>\n<div>ok</div>\n<blink>no</blink>\n`);
    const io = makeIo();
    expect(runCli(['check', dir, '--no-color'], io)).toBe(1);
    // Both problems, not just the first — this is the payoff of recovery.
    expect(io.stderr).toContain('O1053');
    expect(io.stderr).toContain('O1081');
    // And a real code frame, not a bare location.
    expect(io.stderr).toContain('|');
    expect(io.stderr).toContain('^');
    expect(io.stderr).toContain('2 errors in 1 file');
  });

  it('emits no ANSI escapes with --no-color', () => {
    write('bad.orbit', `${HEAD}<p>a < b</p>\n`);
    const io = makeIo();
    runCli(['check', dir, '--no-color'], io);
    expect(io.stderr).not.toContain('[');
  });

  it('emits machine-readable JSON on --format json', () => {
    write('bad.orbit', `${HEAD}<p>a < b</p>\n`);
    const io = makeIo();
    expect(runCli(['check', dir, '--format', 'json'], io)).toBe(1);
    const parsed = JSON.parse(io.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      code: 'O1053',
      severity: 'error',
      line: 4,
    });
    // The documented keys must all be present, even when null.
    for (const key of ['file', 'code', 'severity', 'message', 'line', 'col', 'endLine', 'endCol', 'help']) {
      expect(Object.keys(parsed[0])).toContain(key);
    }
  });

  it('rejects an unknown --format value instead of guessing', () => {
    write('good.orbit', `${HEAD}<p>hi</p>\n`);
    const io = makeIo();
    expect(runCli(['check', dir, '--format', 'xml'], io)).toBe(2);
    expect(io.stderr).toContain('--format');
  });

  it('recurses into directories and skips node_modules', () => {
    mkdirSync(join(dir, 'nested'));
    mkdirSync(join(dir, 'node_modules'));
    write('nested/a.orbit', `${HEAD}<p>a</p>\n`);
    writeFileSync(join(dir, 'node_modules', 'vendored.orbit'), `${HEAD}<p>a < b</p>\n`, 'utf8');
    const io = makeIo();
    // The vendored file is broken; finding it would fail the run.
    expect(runCli(['check', dir, '--no-color'], io)).toBe(0);
    expect(io.stdout).toContain('checked 1 file');
  });
});

describe('orbit fmt', () => {
  it('rewrites a file in place and is then a no-op', () => {
    const file = write('ugly.orbit', `${HEAD}<div>\n        <p>hi</p>\n</div>\n`);
    expect(runCli(['fmt', file], makeIo())).toBe(0);
    const once = readFileSync(file, 'utf8');
    expect(once).toBe(`${CANONICAL_HEAD}<div>\n  <p>hi</p>\n</div>\n`);

    expect(runCli(['fmt', file], makeIo())).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(once);
  });

  it('--check reports without writing and exits 1', () => {
    const original = `${HEAD}<div>\n        <p>hi</p>\n</div>\n`;
    const file = write('ugly.orbit', original);
    const io = makeIo();
    expect(runCli(['fmt', '--check', file], io)).toBe(1);
    expect(io.stderr).toContain('would reformat');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('--check exits 0 on already-canonical files', () => {
    write('good.orbit', `${CANONICAL_HEAD}<p>hello</p>\n`);
    const io = makeIo();
    expect(runCli(['fmt', '--check', dir], io)).toBe(0);
    expect(io.stdout).toContain('already formatted');
  });

  it('--stdout prints and leaves the file alone', () => {
    const original = `${HEAD}<div>\n        <p>hi</p>\n</div>\n`;
    const file = write('ugly.orbit', original);
    const io = makeIo();
    expect(runCli(['fmt', '--stdout', file], io)).toBe(0);
    expect(io.stdout).toContain('<div>\n  <p>hi</p>\n</div>');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('refuses to rewrite a file that does not parse, and leaves it untouched', () => {
    // Rewriting a file the formatter could not fully understand is how a
    // formatter eats someone's work. It must be a reported failure.
    const original = `${HEAD}<p>a < b</p>\n`;
    const file = write('bad.orbit', original);
    const io = makeIo();
    expect(runCli(['fmt', file, '--no-color'], io)).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(io.stderr).toContain('left untouched');
  });

  it('formats the good files even when a sibling is broken', () => {
    write('good.orbit', `${HEAD}<div>\n      <p>hi</p>\n</div>\n`);
    write('bad.orbit', `${HEAD}<p>a < b</p>\n`);
    const io = makeIo();
    expect(runCli(['fmt', dir, '--no-color'], io)).toBe(1);
    expect(readFileSync(join(dir, 'good.orbit'), 'utf8')).toContain('  <p>hi</p>');
  });
});

describe('orbit usage', () => {
  it('prints usage and exits 2 with no arguments', () => {
    const io = makeIo();
    expect(runCli([], io)).toBe(2);
    expect(io.stdout).toContain('USAGE');
  });

  it('prints usage and exits 0 for --help', () => {
    const io = makeIo();
    expect(runCli(['--help'], io)).toBe(0);
    expect(io.stdout).toContain('orbit check');
    expect(io.stdout).toContain('orbit fmt');
  });

  it('prints a version', () => {
    const io = makeIo();
    expect(runCli(['--version'], io)).toBe(0);
    expect(io.stdout.trim().length).toBeGreaterThan(0);
  });

  it('exits 2 on an unknown command rather than doing something surprising', () => {
    const io = makeIo();
    expect(runCli(['frobnicate'], io)).toBe(2);
    expect(io.stderr).toContain('unknown command');
  });

  it('exits 2 on an unreadable path', () => {
    const io = makeIo();
    expect(runCli(['check', join(dir, 'nope')], io)).toBe(2);
    expect(io.stderr).toContain('cannot read');
  });

  it('exits 2 when no .orbit files are found', () => {
    const io = makeIo();
    expect(runCli(['check', dir], io)).toBe(2);
    expect(io.stderr).toContain('no .orbit files');
  });
});

describe('the library stays zero-I/O', () => {
  /**
   * The engine's promise is that it has no ambient authority: no filesystem, no
   * network, no clock it did not receive. `tsconfig.json` enforces that at
   * compile time by omitting @types/node, but the CLI now legitimately imports
   * node builtins — so this asserts the two never merge.
   */
  it('no source file except cli.ts imports a node builtin', () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const entry of readdirSync(srcDir)) {
      if (!entry.endsWith('.ts') && !entry.endsWith('.mts')) continue;
      if (entry === 'cli.ts' || entry.includes('.test.')) continue;
      const source = readFileSync(join(srcDir, entry), 'utf8');
      if (source.includes("'node:") || source.includes('"node:')) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });

  it('the built library entrypoint contains no node: specifier', () => {
    // Belt and braces: the compiled artifact is what actually ships.
    const distEsm = join(process.cwd(), 'dist', 'esm');
    let files: string[];
    try {
      files = readdirSync(distEsm).filter((f) => f.endsWith('.js'));
    } catch {
      return; // not built in this run; CI builds before testing
    }
    const offenders = files.filter((f) => readFileSync(join(distEsm, f), 'utf8').includes('node:'));
    expect(offenders).toEqual([]);
  });
});
