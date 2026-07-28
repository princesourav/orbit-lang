import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProgram } from '../../src/parser.ts';
import { check } from '../../src/checker.ts';
import { render } from '../../src/interpreter.ts';
import { extractAccessPlan } from '../../src/host.ts';
import { formatProgram } from '../../src/formatter.ts';
import { BINDINGS, HOST_FILTERS, PAGE_GLOBALS, makeRegistry } from './host.mjs';

/**
 * The Phase D port, as a test.
 *
 * A falsification report whose artifact does not compile is an opinion. This
 * file is what makes `docs/evaluation/closed-world.md` evidence: the templates
 * it describes are parsed, checked, rendered and formatted here, so a claim
 * that something "ports cleanly" fails the build the moment it stops being
 * true.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

function sources() {
  const files = [];
  for (const dir of ['components', 'pages']) {
    for (const name of readdirSync(path.join(HERE, dir)).sort()) {
      if (!name.endsWith('.orbit')) continue;
      files.push({
        name: `${dir}/${name}`,
        source: readFileSync(path.join(HERE, dir, name), 'utf8'),
      });
    }
  }
  return files;
}

function compile() {
  const files = sources();
  const parsed = parseProgram(files);
  if (!parsed.ok) {
    throw new Error(
      'the port does not parse:\n' +
        parsed.diagnostics.map((d) => `  ${d.code} ${d.message} (${d.template ?? '?'})`).join('\n'),
    );
  }
  const checked = check(parsed.program, {
    registry: makeRegistry(),
    hostFilters: HOST_FILTERS,
    pageGlobals: PAGE_GLOBALS,
  });
  return { program: parsed.program, diagnostics: checked.diagnostics };
}

describe('the Aurora port', () => {
  it('compiles with no errors', () => {
    const { diagnostics } = compile();
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  it('raises no warnings either — nothing here needed the trusted-Html seam', () => {
    // The port uses `richtext`, a sanitizer, so no use site is warned. If a
    // future edit reaches for `trustedHtml` to paste markup, this fails, and
    // that is the signal: it would mean the port left the sanctioned path.
    const { diagnostics } = compile();
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  it('renders both pages', () => {
    const { program } = compile();
    for (const entry of ['home', 'product']) {
      const out = render(program, entry, {
        hostFilters: HOST_FILTERS,
        bindings: BINDINGS,
        now: () => 0,
      });
      if (!out.ok) throw new Error(`${entry}: ${out.error.code} ${out.error.message}`);
      expect(out.html.length).toBeGreaterThan(500);
      expect(out.warnings).toEqual([]);
    }
  });

  it('renders no executable script and no inline event handler', () => {
    // The property the whole exercise is measuring. If the port ever needed an
    // escape hatch, it would show up here first.
    //
    // The one `<script>` the engine emits is `type="application/ld+json"`, which
    // browsers do not execute — it is data, produced by `<json-ld>` from a typed
    // record. So the assertion is not "no script tag" but "no script a browser
    // would run", which is the property that actually matters.
    const { program } = compile();
    for (const entry of ['home', 'product']) {
      const out = render(program, entry, { hostFilters: HOST_FILTERS, bindings: BINDINGS, now: () => 0 });
      if (!out.ok) throw new Error(out.error.code);
      const scripts = [...out.html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
      expect(scripts.every((attrs) => attrs.includes('type="application/ld+json"'))).toBe(true);
      expect(out.html).not.toMatch(/\son(click|load|error|change|submit|input|mouse\w+)=/);
      expect(out.html).not.toContain('javascript:');
    }
  });

  it('produces an access plan the host can serve', () => {
    // A closed world is only useful if the host can fetch exactly what the page
    // reads. This is the other half of the premise.
    const { program } = compile();
    const plan = extractAccessPlan(program, 'product');
    expect(plan.paths).toContain('product.title');
    expect(plan.paths).toContain('product.price');
    expect(plan.paths).toContain('shop.name');
  });

  it('is already canonically formatted', () => {
    const { program } = compile();
    const formatted = formatProgram(program);
    for (const file of sources()) {
      const name = /page (\w+)|component (\w+)/.exec(file.source);
      const key = name?.[1] ?? name?.[2];
      if (key === undefined) continue;
      expect(formatted.get(key), `${file.name} is not canonically formatted`).toBe(file.source);
    }
  });
});
