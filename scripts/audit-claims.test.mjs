import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  auditClaims,
  checkRow,
  normalizeEvidence,
  parseClaims,
  vitestWouldRun,
} from './audit-claims.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const fixture = (name) => readFileSync(path.join(HERE, '__fixtures__', name), 'utf8');

describe('normalizeEvidence', () => {
  it('passes a plain path through', () => {
    expect(normalizeEvidence('src/escape.test.ts')).toBe('src/escape.test.ts');
  });
  it('strips backticks', () => {
    expect(normalizeEvidence('  `src/escape.ts`  ')).toBe('src/escape.ts');
  });
  it('extracts a markdown link target', () => {
    expect(normalizeEvidence('[escaping](src/escape.ts)')).toBe('src/escape.ts');
  });
  it('strips angle brackets', () => {
    expect(normalizeEvidence('<src/escape.ts>')).toBe('src/escape.ts');
  });
  it('strips a leading ./ and normalises separators', () => {
    expect(normalizeEvidence('./src\\escape.ts')).toBe('src/escape.ts');
  });
  it('strips an #anchor and a :line suffix', () => {
    expect(normalizeEvidence('docs/spec.md#escaping')).toBe('docs/spec.md');
    expect(normalizeEvidence('src/escape.ts:42')).toBe('src/escape.ts');
  });
  it('returns empty for a blank cell', () => {
    expect(normalizeEvidence('   ')).toBe('');
  });
});

describe('vitestWouldRun', () => {
  it('accepts the default test-file shapes', () => {
    for (const p of [
      'src/escape.test.ts',
      'src/e2e.spec.ts',
      'scripts/fixup-dist.test.mjs',
      'a/b/c.test.tsx',
      'x.test.cjs',
    ]) {
      expect(vitestWouldRun(p), p).toBe(true);
    }
  });
  it('rejects non-test files', () => {
    for (const p of ['src/escape.ts', 'README.md', 'package.json', 'test.ts', 'src/testing.ts']) {
      expect(vitestWouldRun(p), p).toBe(false);
    }
  });
  it('rejects files inside excluded directories', () => {
    expect(vitestWouldRun('node_modules/x/a.test.js')).toBe(false);
    expect(vitestWouldRun('dist/esm/a.test.js')).toBe(false);
  });
  it('handles windows separators', () => {
    expect(vitestWouldRun('src\\escape.test.ts')).toBe(true);
  });
});

describe('parseClaims', () => {
  it('parses the rows of a well-formed table and ignores prose', () => {
    const { rows, errors } = parseClaims(fixture('claims.ok.md'));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows[0].kind).toBe('test');
    expect(rows[3].evidence).toBe('package.json');
  });

  it('reports a missing header row', () => {
    const { errors } = parseClaims('| a | b | c |\n');
    expect(errors.some((e) => e.message.includes('header row'))).toBe(true);
  });

  it('honours escaped pipes inside a cell', () => {
    const md = [
      '| claim | evidence | kind |',
      '| --- | --- | --- |',
      '| a \\| b is fine | package.json | config |',
    ].join('\n');
    const { rows } = parseClaims(md);
    expect(rows).toHaveLength(1);
    expect(rows[0].claim).toBe('a | b is fine');
  });

  it('handles a document of several tables, each with its own header row', () => {
    const md = [
      '## Escaping',
      '',
      '| claim | evidence | kind |',
      '|---|---|---|',
      '| a | src/escape.test.ts | test |',
      '',
      '## Allowlists',
      '',
      '| claim | evidence | kind |',
      '|---|---|---|',
      '| b | src/allowlists.ts | artifact |',
      '',
    ].join('\n');
    const { rows, errors } = parseClaims(md);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.kind)).toEqual(['test', 'artifact']);
    expect(rows.map((r) => r.claim)).toEqual(['a', 'b']);
  });

  it('ignores prose that merely quotes the row format', () => {
    const md = [
      'Each row is `| claim | evidence | kind |`.',
      '',
      '| claim | evidence | kind |',
      '|---|---|---|',
      '| a | package.json | artifact |',
    ].join('\n');
    const { rows, errors } = parseClaims(md);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('flags a row with the wrong column count', () => {
    const md = ['| claim | evidence | kind |', '| --- | --- | --- |', '| only two | cols |'].join(
      '\n'
    );
    const { errors } = parseClaims(md);
    expect(errors.some((e) => e.message.includes('expected 3'))).toBe(true);
  });
});

describe('checkRow', () => {
  const opts = { root: ROOT };
  it('accepts a real test file for kind=test', () => {
    expect(checkRow({ claim: 'c', evidence: 'src/escape.test.ts', kind: 'test' }, opts)).toBeNull();
  });
  it('rejects a missing file', () => {
    expect(checkRow({ claim: 'c', evidence: 'src/nope.ts', kind: 'code' }, opts)).toMatch(
      'does not exist'
    );
  });
  it('rejects kind=test on a file vitest would not run', () => {
    expect(checkRow({ claim: 'c', evidence: 'src/escape.ts', kind: 'test' }, opts)).toMatch(
      'vitest would not run'
    );
  });
  it('rejects a URL', () => {
    expect(
      checkRow({ claim: 'c', evidence: 'https://example.invalid/x', kind: 'doc' }, opts)
    ).toMatch('repo-relative');
  });
  it('rejects an escape outside the repo', () => {
    expect(checkRow({ claim: 'c', evidence: '../secrets.txt', kind: 'doc' }, opts)).toMatch(
      'inside the repo'
    );
  });
  it('rejects an unknown kind', () => {
    expect(checkRow({ claim: 'c', evidence: 'package.json', kind: 'vibes' }, opts)).toMatch(
      'unknown kind'
    );
  });
  it('rejects a directory', () => {
    expect(checkRow({ claim: 'c', evidence: 'src', kind: 'code' }, opts)).toMatch('not a file');
  });
});

describe('auditClaims', () => {
  it('passes the good fixture against the real repo', () => {
    const result = auditClaims(fixture('claims.ok.md'), { root: ROOT });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(4);
  });

  it('fails the bad fixture with one message per broken row', () => {
    const result = auditClaims(fixture('claims.bad.md'), { root: ROOT });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(5);
    const joined = result.failures.map((f) => f.message).join('\n');
    expect(joined).toMatch('does not exist');
    expect(joined).toMatch('vitest would not run');
    expect(joined).toMatch('empty');
    expect(joined).toMatch('repo-relative');
    expect(joined).toMatch('unknown kind');
  });

  it('treats an empty table as a failure, never a silent pass', () => {
    const md = '| claim | evidence | kind |\n| --- | --- | --- |\n';
    const result = auditClaims(md, { root: ROOT });
    expect(result.ok).toBe(false);
    expect(result.failures[0].message).toMatch('empty audit is a failed audit');
  });

  it('treats a document with no table as a failure', () => {
    const result = auditClaims('# Claims\n\nWe are very compliant.\n', { root: ROOT });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.message.includes('header row'))).toBe(true);
  });

  it('reports the source line of each broken row', () => {
    const result = auditClaims(fixture('claims.bad.md'), { root: ROOT });
    for (const f of result.failures) {
      expect(f.line).toBeGreaterThan(0);
    }
  });

  it('accepts artifact as a kind without demanding a runnable test', () => {
    const md = [
      '| claim | evidence | kind |',
      '|---|---|---|',
      '| the allowlist is closed | src/allowlists.ts | artifact |',
    ].join('\n');
    expect(auditClaims(md, { root: ROOT }).ok).toBe(true);
  });
});

// The real gate, run here as well as in CI so a broken claims manifest fails
// the local test suite too. Absence of the file is caught by the CLI (exit 1).
describe('docs/compliance/claims.md', () => {
  const claimsPath = path.join(ROOT, 'docs', 'compliance', 'claims.md');
  const present = existsSync(claimsPath);

  it.skipIf(!present)('every claim in the shipped manifest is backed by evidence', () => {
    const result = auditClaims(readFileSync(claimsPath, 'utf8'), { root: ROOT });
    expect(result.failures.map((f) => `${f.line}: ${f.message}`)).toEqual([]);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
