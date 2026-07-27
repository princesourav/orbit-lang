import { describe, expect, it } from 'vitest';

import { buildSbom, deterministicUuid, licensesFor, purlFor } from './sbom.mjs';

const TS = '2026-07-28T00:00:00Z';
const build = () => buildSbom(undefined, { timestamp: TS });

describe('purlFor', () => {
  it('percent-encodes a scoped name', () => {
    expect(purlFor('@orbitlang/core', '0.1.0')).toBe('pkg:npm/%40orbitlang/core@0.1.0');
  });
  it('leaves an unscoped name alone', () => {
    expect(purlFor('typescript', '5.6.0')).toBe('pkg:npm/typescript@5.6.0');
  });
});

describe('deterministicUuid', () => {
  it('is stable for the same seed', () => {
    expect(deterministicUuid('a@1.0.0')).toBe(deterministicUuid('a@1.0.0'));
  });
  it('differs for different seeds', () => {
    expect(deterministicUuid('a@1.0.0')).not.toBe(deterministicUuid('a@1.0.1'));
  });
  it('has the RFC 4122 v4 shape', () => {
    const uuid = deterministicUuid('x');
    const parts = uuid.split('-');
    expect(parts.map((p) => p.length)).toEqual([8, 4, 4, 4, 12]);
    expect(parts[2][0]).toBe('4');
    expect('89ab'.includes(parts[3][0])).toBe(true);
  });
});

describe('licensesFor', () => {
  it('emits an SPDX id for a simple license', () => {
    expect(licensesFor({ license: 'Apache-2.0' })).toEqual([{ license: { id: 'Apache-2.0' } }]);
  });
  it('emits an expression for a compound license', () => {
    expect(licensesFor({ license: '(MIT OR Apache-2.0)' })).toEqual([
      { expression: '(MIT OR Apache-2.0)' },
    ]);
  });
  it('handles the legacy licenses array', () => {
    expect(licensesFor({ licenses: [{ type: 'MIT' }] })).toEqual([{ license: { id: 'MIT' } }]);
  });
  it('returns empty when unlicensed', () => {
    expect(licensesFor({})).toEqual([]);
  });
});

describe('buildSbom', () => {
  it('is a well-formed CycloneDX 1.5 document', () => {
    const doc = build();
    expect(doc.bomFormat).toBe('CycloneDX');
    expect(doc.specVersion).toBe('1.5');
    expect(doc.version).toBe(1);
    expect(doc.serialNumber.startsWith('urn:uuid:')).toBe(true);
    expect(doc.metadata.timestamp).toBe(TS);
  });

  it('describes @orbitlang/core as the root component with its license and purl', () => {
    const c = build().metadata.component;
    expect(c.name).toBe('@orbitlang/core');
    expect(c.type).toBe('library');
    expect(c.purl).toBe(`pkg:npm/%40orbitlang/core@${c.version}`);
    expect(c.licenses).toEqual([{ license: { id: 'Apache-2.0' } }]);
    expect(c.externalReferences.some((r) => r.type === 'vcs')).toBe(true);
  });

  it('records zero runtime dependencies', () => {
    const doc = build();
    const root = doc.dependencies.find((d) => d.ref === doc.metadata.component['bom-ref']);
    expect(root.dependsOn).toEqual([]);
    const count = doc.metadata.component.properties.find(
      (p) => p.name === 'cdx:npm:package:runtimeDependencyCount'
    );
    expect(count.value).toBe('0');
  });

  it('lists every devDependency as an excluded, development-scoped component', () => {
    const doc = build();
    expect(doc.components.length).toBeGreaterThan(0);
    for (const c of doc.components) {
      expect(c.scope).toBe('excluded');
      expect(
        c.properties.some((p) => p.name === 'cdx:npm:package:development' && p.value === 'true')
      ).toBe(true);
      expect(c.purl).toBe(`pkg:npm/${c.name.startsWith('@') ? '%40' + c.name.slice(1) : c.name}@${c.version}`);
    }
    const names = doc.components.map((c) => c.name);
    expect(names).toContain('typescript');
    expect(names).toContain('vitest');
    expect([...names].sort()).toEqual(names); // deterministic ordering
  });

  it('gives every component a bom-ref that a dependency entry references', () => {
    const doc = build();
    const refs = new Set(doc.dependencies.map((d) => d.ref));
    for (const c of doc.components) expect(refs.has(c['bom-ref'])).toBe(true);
    expect(refs.has(doc.metadata.component['bom-ref'])).toBe(true);
  });

  it('is byte-identical across runs for the same input', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('serialises to valid JSON', () => {
    expect(() => JSON.parse(JSON.stringify(build()))).not.toThrow();
  });
});
