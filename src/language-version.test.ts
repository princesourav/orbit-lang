import { describe, expect, it } from 'vitest';

import { formatTemplate } from './formatter';
import { parseProgram, parseTemplate } from './parser';
import { loadCheckedAst, serializeProgram } from './validate-ast';
import { DEFAULT_LANGUAGE_VERSION, LANGUAGE_VERSIONS } from './limits';

/**
 * The `orbit <version>` frontmatter pragma versions the LANGUAGE, not the
 * package.
 *
 * The distinction matters because the two move at different speeds: a patch
 * release of the engine must not change what a template means, and a template
 * must keep meaning the same thing across engine upgrades. Tying meaning to the
 * package version would make every bug fix a potential semantic change.
 *
 * This lands now because there are zero themes in the wild. Once there are,
 * every undeclared template has to be treated as some implicit default forever,
 * and choosing that default retroactively is a guess about what its author
 * meant.
 */

function parseOrThrow(source: string) {
  const result = parseTemplate(source, 'v.orbit');
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code} ${d.message}`).join('; '));
  }
  return result.template;
}

function firstError(source: string) {
  const result = parseTemplate(source, 'v.orbit');
  if (result.ok) return undefined;
  return result.diagnostics[0];
}

describe('the orbit pragma', () => {
  it('defaults when absent, so existing templates keep their meaning', () => {
    expect(parseOrThrow('---\npage p\n---\n<p>x</p>\n').languageVersion).toBe(
      DEFAULT_LANGUAGE_VERSION,
    );
  });

  it('accepts every version this engine implements', () => {
    for (const version of LANGUAGE_VERSIONS) {
      expect(parseOrThrow(`---\norbit ${version}\npage p\n---\n<p>x</p>\n`).languageVersion).toBe(
        version,
      );
    }
  });

  it('rejects a version this engine does not implement, and says which it does', () => {
    // Rendering a template written against a later language under whatever
    // rules this engine happens to have is the failure mode being prevented.
    const d = firstError('---\norbit 2099\npage p\n---\n<p>x</p>\n');
    expect(d?.code).toBe('O1104');
    expect(d?.message).toContain('2099');
    expect(d?.suggestion).toContain(DEFAULT_LANGUAGE_VERSION);
  });

  it('rejects a missing version rather than assuming one', () => {
    expect(firstError('---\norbit\npage p\n---\n<p>x</p>\n')?.code).toBe('O1105');
  });

  it('rejects a duplicate declaration', () => {
    expect(firstError('---\norbit 2026\norbit 2026\npage p\n---\n<p>x</p>\n')?.code).toBe('O1106');
  });

  it('lists itself among the valid frontmatter keywords', () => {
    expect(firstError('---\nnonsense 1\npage p\n---\n<p>x</p>\n')?.suggestion).toContain('orbit');
  });
});

describe('the formatter states the version explicitly', () => {
  it('writes the pragma even when the source omitted it', () => {
    const formatted = formatTemplate(parseOrThrow('---\npage p\n---\n<p>x</p>\n'));
    expect(formatted).toContain(`orbit ${DEFAULT_LANGUAGE_VERSION}`);
  });

  it('stays idempotent, since absent and default mean the same thing', () => {
    const once = formatTemplate(parseOrThrow('---\npage p\n---\n<p>x</p>\n'));
    expect(formatTemplate(parseOrThrow(once))).toBe(once);
  });

  it('puts the pragma before the kind declaration', () => {
    const lines = formatTemplate(parseOrThrow('---\npage p\n---\n<p>x</p>\n')).split('\n');
    expect(lines[1]).toBe(`orbit ${DEFAULT_LANGUAGE_VERSION}`);
    expect(lines[2]).toBe('page p');
  });
});

describe('a stored AST carries its language version', () => {
  it('round-trips through serialize and verified load', () => {
    const parsed = parseProgram([{ name: 'p.orbit', source: '---\norbit 2026\npage p\n---\n<p>x</p>\n' }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const json = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));
    const back = loadCheckedAst(json, { trust: 'verify' });
    expect([...back.templates.values()][0]!.languageVersion).toBe('2026');
  });

  it('refuses a stored tree written against a version this engine lacks', () => {
    // A stored tree outlives the engine that produced it, which is the entire
    // reason the validator exists. Silently rendering it would be worse than
    // any parse error.
    const parsed = parseProgram([{ name: 'p.orbit', source: '---\npage p\n---\n<p>x</p>\n' }]);
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const json = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));
    json.templates.p.languageVersion = '2099';
    expect(() => loadCheckedAst(json, { trust: 'verify' })).toThrow(/language version/);
  });

  it('refuses a stored tree with no language version at all', () => {
    const parsed = parseProgram([{ name: 'p.orbit', source: '---\npage p\n---\n<p>x</p>\n' }]);
    if (!parsed.ok) throw new Error('fixture failed to parse');
    const json = JSON.parse(JSON.stringify(serializeProgram(parsed.program)));
    delete json.templates.p.languageVersion;
    expect(() => loadCheckedAst(json, { trust: 'verify' })).toThrow(/language version/);
  });
});
