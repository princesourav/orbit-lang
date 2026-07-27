import { describe, expect, it } from 'vitest';

import { makeResolver, rewriteModuleSpecifiers } from './fixup-dist.mjs';

/** Resolver that pretends every extensionless sibling exists as `<spec>.js`. */
const flat = makeResolver('/x', (p) => p.endsWith('.js') && !p.endsWith('index.js'));
/** Resolver that pretends nothing exists (falls back to `<spec>.js`). */
const none = makeResolver('/x', () => false);

const rw = (src, resolver = flat) => rewriteModuleSpecifiers(src, resolver);

describe('rewriteModuleSpecifiers', () => {
  it('adds .js to a named import', () => {
    expect(rw("import { a } from './ast';")).toBe("import { a } from './ast.js';");
  });

  it('adds .js to a re-export', () => {
    expect(rw("export { a, b, } from './diagnostics';")).toBe(
      "export { a, b, } from './diagnostics.js';"
    );
  });

  it('adds .js to `export * from`', () => {
    expect(rw("export * from './limits';")).toBe("export * from './limits.js';");
  });

  it('adds .js to a side-effect import', () => {
    expect(rw('import "./polyfill";')).toBe('import "./polyfill.js";');
  });

  it('adds .js to dynamic import() and require()', () => {
    expect(rw("const m = await import('./stdlib');")).toBe(
      "const m = await import('./stdlib.js');"
    );
    expect(rw("const m = require('./stdlib');")).toBe("const m = require('./stdlib.js');");
  });

  it('rewrites parent-relative specifiers', () => {
    expect(rw("import { x } from '../core/types';")).toBe(
      "import { x } from '../core/types.js';"
    );
  });

  it('rewrites type-only imports in .d.ts text', () => {
    expect(rw("import type { Span } from './diagnostics';")).toBe(
      "import type { Span } from './diagnostics.js';"
    );
    expect(rw("export { type Attr, EXPR_KINDS } from './ast';")).toBe(
      "export { type Attr, EXPR_KINDS } from './ast.js';"
    );
  });

  it('leaves bare package specifiers alone', () => {
    expect(rw("import { z } from 'vitest';")).toBe("import { z } from 'vitest';");
    expect(rw("import fs from 'node:fs';")).toBe("import fs from 'node:fs';");
  });

  it('leaves already-explicit specifiers alone', () => {
    for (const spec of ['./a.js', './a.mjs', './a.cjs', './data.json', './n.node']) {
      const src = `import x from '${spec}';`;
      expect(rw(src)).toBe(src);
    }
  });

  it('falls back to /index.js when the specifier names a directory', () => {
    const norm = (p) => p.split('\\').join('/');
    const dirOnly = makeResolver('/x', (p) => norm(p).endsWith('/sub/index.js'));
    expect(rewriteModuleSpecifiers("import a from './sub';", dirOnly)).toBe(
      "import a from './sub/index.js';"
    );
  });

  it('appends .js when nothing resolves on disk', () => {
    expect(rw("import a from './ghost';", none)).toBe("import a from './ghost.js';");
  });

  it('completes a trailing-slash specifier with index.js', () => {
    expect(rw("import a from './sub/';")).toBe("import a from './sub/index.js';");
  });

  it('does not touch ordinary strings that look like specifiers', () => {
    const src = `const label = './ast'; const o = { from: './ast' };`;
    expect(rw(src)).toBe(src);
  });

  it('does not touch strings inside comments', () => {
    const src = `// import { a } from './ast';\nconst x = 1;`;
    expect(rw(src)).toBe(src);
    const block = `/* from './ast' */\nconst y = 2;`;
    expect(rw(block)).toBe(block);
  });

  it('does not touch template literals or their substitutions', () => {
    const src = 'const t = `from \'./ast\' ${x} ${`from \'./b\'`}`;';
    expect(rw(src)).toBe(src);
  });

  it('handles escaped quotes inside unrelated strings', () => {
    const src = `const s = 'it\\'s from \\'./ast\\'';\nimport { a } from './ast';`;
    expect(rw(src)).toBe(
      `const s = 'it\\'s from \\'./ast\\'';\nimport { a } from './ast.js';`
    );
  });

  it('is idempotent', () => {
    const once = rw("import { a } from './ast';\nexport * from './b';");
    expect(rw(once)).toBe(once);
  });

  it('preserves an empty specifier rather than corrupting it', () => {
    expect(rw("import a from '';")).toBe("import a from '';");
  });

  it('rewrites every specifier in a realistic emitted module', () => {
    const src = [
      '/**',
      " * doc mentioning './ast'",
      ' */',
      "import { groupSlotChildren, } from './ast';",
      "import { OrbitRenderError } from './diagnostics';",
      "export { render } from './interpreter';",
      "const cwd = './not-a-specifier';",
    ].join('\n');
    const out = rw(src);
    expect(out).toContain("from './ast.js';");
    expect(out).toContain("from './diagnostics.js';");
    expect(out).toContain("from './interpreter.js';");
    expect(out).toContain("const cwd = './not-a-specifier';");
    expect(out).toContain("doc mentioning './ast'");
  });
});

describe('makeResolver', () => {
  it('prefers a sibling file over a directory index', () => {
    const both = makeResolver('/x', () => true);
    expect(both('./ast')).toBe('./ast.js');
  });

  it('is a no-op for non-relative specifiers', () => {
    expect(flat('vitest')).toBe('vitest');
    expect(flat('node:path')).toBe('node:path');
    expect(flat('@scope/pkg/sub')).toBe('@scope/pkg/sub');
  });
});
