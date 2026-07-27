#!/usr/bin/env node
/**
 * CycloneDX 1.5 SBOM generator for @orbitlang/core.
 *
 * The whole point of the document is the shape of the dependency graph: the
 * engine ships with ZERO runtime dependencies, so the root component's
 * `dependsOn` list is empty and every other component is a build-time-only
 * tool recorded with `scope: "excluded"` plus the standard
 * `cdx:npm:package:development` property.
 *
 * Deterministic by construction: the serial number is derived from
 * name@version, and the metadata timestamp honours SOURCE_DATE_EPOCH, so the
 * same commit produces byte-identical output — matching the engine's own
 * determinism guarantee.
 *
 * Usage:
 *   node scripts/sbom.mjs [--out <file>] [--pretty|--compact]
 *
 * Zero dependencies; Node builtins only.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_VERSION = '1.5';

/** Percent-encode an npm name for a Package URL (only `@` and `/` matter here). */
export function purlFor(name, version) {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    const scope = name.slice(1, slash);
    const bare = name.slice(slash + 1);
    return `pkg:npm/%40${scope}/${bare}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

/** RFC 4122-shaped UUID derived from a string — stable across runs. */
export function deterministicUuid(seed) {
  const h = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(h.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4 shape
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

/** Normalise a package.json `license`/`licenses` field into CycloneDX form. */
export function licensesFor(pkg) {
  const out = [];
  if (typeof pkg.license === 'string' && pkg.license !== '') {
    if (pkg.license.indexOf(' ') !== -1 || pkg.license.indexOf('(') !== -1) {
      out.push({ expression: pkg.license });
    } else {
      out.push({ license: { id: pkg.license } });
    }
  } else if (Array.isArray(pkg.licenses)) {
    for (const l of pkg.licenses) {
      if (l && typeof l.type === 'string') out.push({ license: { id: l.type } });
    }
  }
  return out;
}

/** Resolve the installed version of a dev dependency, falling back to its range. */
function resolveInstalled(root, name, range) {
  const manifest = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof pkg.version === 'string') return { version: pkg.version, pkg };
    } catch {
      /* fall through to the declared range */
    }
  }
  let v = range;
  while (v.length > 0 && (v[0] === '^' || v[0] === '~' || v[0] === '=' || v[0] === 'v')) {
    v = v.slice(1);
  }
  return { version: v, pkg: null };
}

// No regex anywhere in this repo (project invariant W-04c) — plain slicing.
function timestamp() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const ms = epoch !== undefined && epoch !== '' ? Number(epoch) * 1000 : Date.now();
  const iso = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
  // 2026-07-28T02:11:05.123Z -> 2026-07-28T02:11:05Z (second precision)
  return iso.length === 24 ? iso.slice(0, 19) + 'Z' : iso;
}

/** Build the CycloneDX document for the package manifest at `root`. */
export function buildSbom(root = ROOT, options = {}) {
  const pkg = options.pkg ?? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const runtimeDeps = Object.keys(pkg.dependencies ?? {});
  const devDeps = pkg.devDependencies ?? {};

  const rootRef = purlFor(pkg.name, pkg.version);

  const repoUrl =
    typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? undefined);

  const rootComponent = {
    type: 'library',
    'bom-ref': rootRef,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    scope: 'required',
    licenses: licensesFor(pkg),
    purl: rootRef,
    externalReferences: [],
    properties: [
      { name: 'cdx:npm:package:runtimeDependencyCount', value: String(runtimeDeps.length) },
      { name: 'cdx:npm:package:private', value: 'false' },
    ],
  };
  if (repoUrl !== undefined) {
    rootComponent.externalReferences.push({ type: 'vcs', url: repoUrl });
  }
  if (typeof pkg.homepage === 'string') {
    rootComponent.externalReferences.push({ type: 'website', url: pkg.homepage });
  }
  if (typeof pkg.bugs === 'string') {
    rootComponent.externalReferences.push({ type: 'issue-tracker', url: pkg.bugs });
  }
  rootComponent.externalReferences.push({
    type: 'distribution',
    url: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').pop()}-${pkg.version}.tgz`,
  });

  const components = [];
  for (const name of Object.keys(devDeps).sort()) {
    const { version, pkg: dep } = resolveInstalled(root, name, devDeps[name]);
    const ref = purlFor(name, version);
    components.push({
      type: 'library',
      'bom-ref': ref,
      name,
      version,
      // Build-time only: not part of what a consumer of @orbitlang/core runs.
      scope: 'excluded',
      licenses: dep !== null ? licensesFor(dep) : [],
      purl: ref,
      properties: [
        { name: 'cdx:npm:package:development', value: 'true' },
        { name: 'cdx:npm:package:declaredRange', value: devDeps[name] },
      ],
    });
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: SPEC_VERSION,
    serialNumber: 'urn:uuid:' + deterministicUuid(`${pkg.name}@${pkg.version}`),
    version: 1,
    metadata: {
      timestamp: options.timestamp ?? timestamp(),
      tools: {
        components: [
          {
            type: 'application',
            name: 'orbit-sbom',
            version: pkg.version,
            author: 'Orbit',
          },
        ],
      },
      component: rootComponent,
      licenses: licensesFor(pkg),
      properties: [
        {
          name: 'orbit:sbom:note',
          value:
            'Runtime dependency graph is empty by design; every listed component is a build-time devDependency (scope=excluded).',
        },
      ],
    },
    components,
    dependencies: [
      // Zero runtime dependencies — the root depends on nothing.
      { ref: rootRef, dependsOn: [] },
      ...components.map((c) => ({ ref: c['bom-ref'], dependsOn: [] })),
    ],
  };
}

function main(argv) {
  let out = null;
  let pretty = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '-o') out = argv[++i];
    else if (argv[i] === '--compact') pretty = false;
    else if (argv[i] === '--pretty') pretty = true;
  }
  const doc = buildSbom(ROOT);
  const json = JSON.stringify(doc, null, pretty ? 2 : 0) + '\n';
  if (out !== null) {
    const abs = path.isAbsolute(out) ? out : path.join(ROOT, out);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, json, 'utf8');
    process.stdout.write(
      `sbom: wrote ${path.relative(ROOT, abs).split('\\').join('/')} ` +
        `(CycloneDX ${SPEC_VERSION}, ${doc.components.length} build-time component(s), 0 runtime)\n`
    );
  } else {
    process.stdout.write(json);
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
