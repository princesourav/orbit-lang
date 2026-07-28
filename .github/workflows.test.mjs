import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/**
 * Structural checks on the CI workflows.
 *
 * These exist because of a specific, embarrassing failure: `scorecard.yml`
 * referenced `ossf/scorecard-action@v2`, and that project publishes no floating
 * `v2` tag. The workflow therefore failed to resolve at startup on every push
 * since it was written — never analyzing anything, and showing a red badge that
 * looked like a security finding rather than a typo.
 *
 * Nothing here runs a workflow; that only happens on GitHub. What it does catch
 * is the class of mistake that makes a workflow fail before it does any work:
 * malformed YAML, an unpinned action, a job with no steps. Those are cheap to
 * check locally and expensive to discover from a red badge three days later.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.join(HERE, 'workflows');

const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

function load(file) {
  return YAML.parse(readFileSync(path.join(WORKFLOWS, file), 'utf8'));
}

function allSteps(doc) {
  return Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

describe('workflows', () => {
  it('there are workflows to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(file, () => {
      const doc = load(file);

      it('is valid YAML with at least one job', () => {
        expect(doc).toBeTypeOf('object');
        expect(Object.keys(doc.jobs ?? {}).length).toBeGreaterThan(0);
      });

      it('declares a trigger', () => {
        // `on` is parsed as the boolean true by YAML 1.1 semantics in some
        // parsers; accept either key so this checks intent, not spelling.
        expect(doc.on ?? doc[true]).toBeDefined();
      });

      it('sets least-privilege permissions somewhere', () => {
        const jobPerms = Object.values(doc.jobs).some((j) => j.permissions !== undefined);
        expect(doc.permissions !== undefined || jobPerms).toBe(true);
      });

      it('gives every job at least one step', () => {
        for (const [name, job] of Object.entries(doc.jobs)) {
          expect((job.steps ?? []).length, `job ${name} has no steps`).toBeGreaterThan(0);
        }
      });

      it('pins every action to a version', () => {
        for (const step of allSteps(doc)) {
          if (step.uses === undefined) continue;
          expect(step.uses, `unpinned action: ${step.uses}`).toContain('@');
          const [, ref] = step.uses.split('@');
          expect(ref, `empty ref: ${step.uses}`).toBeTruthy();
        }
      });

      it('never references a floating tag a publisher does not provide', () => {
        /*
         * Actions differ in what they publish. actions/* and pnpm/* maintain
         * moving major tags (`@v4`); ossf/scorecard-action does not, which is
         * exactly the bug this file was written for. Anything outside the
         * known-good list must be pinned to a full version or a SHA.
         */
        const PUBLISHES_MAJOR_TAGS = ['actions/', 'pnpm/', 'github/codeql-action'];
        for (const step of allSteps(doc)) {
          if (step.uses === undefined) continue;
          const [action, ref] = step.uses.split('@');
          if (PUBLISHES_MAJOR_TAGS.some((prefix) => action.startsWith(prefix))) continue;

          const isFullVersion = /^v\d+\.\d+/.test(ref);
          const isSha = /^[0-9a-f]{40}$/.test(ref);
          expect(
            isFullVersion || isSha,
            `${action}@${ref} uses a major-only tag; that publisher may not provide one — pin a full version or a SHA`,
          ).toBe(true);
        }
      });
    });
  }
});

describe('ci.yml specifically', () => {
  const doc = load('ci.yml');

  it('does not put Node 20 in the toolchain matrix', () => {
    // pnpm 11 requires Node >= 22.13, so a Node 20 job fails during setup
    // before testing anything. Node 20 support is verified against the BUILT
    // ARTIFACT in the node20-compat job instead, which is what `engines` claims.
    const versions = doc.jobs.test.strategy.matrix.node.map(String);
    expect(versions).not.toContain('20');
    expect(versions).toContain('22');
  });

  it('still verifies the declared minimum Node version somewhere', () => {
    // If package.json says `engines: >=20`, something must actually check it,
    // or the field is decoration.
    const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    const minimum = (pkg.engines?.node ?? '').replace(/[^\d]/g, '').slice(0, 2);
    expect(minimum, 'package.json declares no engines.node').toBeTruthy();

    const job = doc.jobs['node20-compat'];
    expect(job, 'no job verifies the engines minimum').toBeDefined();

    // Assert on the parsed structure, not on YAML quoting.
    const nodeVersions = (job.steps ?? [])
      .filter((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node'))
      .map((s) => String(s.with?.['node-version']));
    expect(nodeVersions, `no setup-node step pins Node ${minimum}`).toContain(minimum);

    // …and that it actually exercises the built artifact on that version,
    // rather than merely switching runtimes and stopping.
    const runsAfterSwitch = JSON.stringify(job.steps);
    expect(runsAfterSwitch).toContain('dist/cjs/index.js');
    expect(runsAfterSwitch).toContain('dist/esm/index.js');
  });

  it('builds before it tests', () => {
    /*
     * Not a style preference — a hard requirement.
     *
     * editors/lsp/analysis.mjs imports `@orbitlang/core` rather than reaching
     * into src/, which is right: it is what a real consumer does, and it keeps
     * the language server honest about the public API. Node resolves that
     * self-reference through the `exports` map to dist/, so the package must be
     * built before its own test suite can load it.
     *
     * Reordering these two steps turns the whole LSP suite into "Failed to
     * resolve entry for package", which is a confusing way to discover a
     * workflow ordering bug.
     */
    const names = doc.jobs.test.steps.map((s) => s.name ?? '');
    const buildAt = names.findIndex((n) => n.startsWith('Build'));
    const testAt = names.findIndex((n) => n === 'Test');
    expect(buildAt, 'no Build step').toBeGreaterThanOrEqual(0);
    expect(testAt, 'no Test step').toBeGreaterThanOrEqual(0);
    expect(buildAt, 'Build must run before Test').toBeLessThan(testAt);
  });

  it('runs the staleness gates that keep generated files honest', () => {
    const steps = JSON.stringify(doc.jobs.test.steps);
    for (const gate of ['errors:check', 'llms:check', 'playground:check', 'conformance']) {
      expect(steps, `missing gate: ${gate}`).toContain(gate);
    }
  });

  it('runs the claims audit without an install step', () => {
    // The honesty gate must not be breakable by a broken dependency tree.
    const job = doc.jobs['claims-audit'];
    expect(job).toBeDefined();
    const steps = JSON.stringify(job.steps);
    expect(steps).toContain('audit-claims.mjs');
    expect(steps).not.toContain('pnpm install');
  });
});
