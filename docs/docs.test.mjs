/**
 * Every ```orbit block in the documentation must actually compile.
 *
 * Documentation that no longer builds is worse than no documentation: it costs
 * a reader real time before they conclude the docs are wrong rather than
 * themselves. This walks every markdown file under docs/, extracts each
 * ```orbit fence, and compiles it against a host that mirrors the one the
 * examples use.
 *
 * Blocks that are *supposed* to fail — the ones demonstrating a compile error —
 * are marked in the prose, so they are opted out with a marker comment rather
 * than silently excluded:
 *
 *     ```orbit expect-error
 *
 * Those are asserted to fail, which keeps the "this is a compile error" claims
 * honest in the other direction too.
 *
 * It lives here as .mjs, outside src/, because reading the docs directory needs
 * node:fs and the engine's tsconfig deliberately makes that unavailable to
 * anything it typechecks.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseProgram } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { t, TypeRegistry } from '../src/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// A host covering everything the docs reference
// ---------------------------------------------------------------------------

function makeRegistry() {
  const registry = new TypeRegistry();
  registry.defineObject('Product', {
    title: t.string(),
    url: t.url(),
    vendor: t.optional(t.string()),
    brand: t.optional(t.string()),
    price: t.money(),
    tags: t.list(t.string()),
    available: t.bool(),
    rating: t.optional(t.float()),
    publishedAt: t.string(),
  });
  registry.defineObject('Collection', {
    title: t.string(),
    products: t.list(t.object('Product')),
  });
  registry.defineObject('Article', {
    title: t.string(),
    publishedAt: t.string(),
  });
  return registry;
}

const HOST_FILTERS = [
  {
    name: 'money',
    params: [t.money()],
    returns: t.moneyText(),
    impl: () => 'INR 0.00',
  },
];

/**
 * Generous globals, because many doc snippets are deliberately fragments —
 * three lines showing one operator, not a whole template. Those are wrapped in
 * a default page header (see `wrap` below) and resolve their identifiers here.
 */
const PAGE_GLOBALS = {
  collection: t.object('Collection'),
  article: t.object('Article'),
  product: t.object('Product'),
  title: t.string(),
  vendor: t.optional(t.string()),
  heading: t.string(),
  tags: t.list(t.string()),
  available: t.bool(),
  basePrice: t.float(),
  shipping: t.float(),
  count: t.int(),
  items: t.list(t.string()),
};

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function markdownFiles(dir = HERE) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...markdownFiles(abs));
    else if (entry.endsWith('.md')) out.push(abs);
  }
  return out;
}

/**
 * Pull every ```orbit fence out of a markdown file, with its line number and
 * whether it is marked `expect-error`.
 */
function orbitBlocks(source, file) {
  const blocks = [];
  const lines = source.split(/\r?\n/);
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (open === null) {
      if (line.trimStart().startsWith('```orbit')) {
        const rest = line.trim().slice('```orbit'.length).trim();
        open = { line: i + 1, expectError: rest === 'expect-error', body: [] };
      }
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      blocks.push({ ...open, file, source: open.body.join('\n') + '\n' });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  return blocks;
}

const FILES = markdownFiles();
const BLOCKS = FILES.flatMap((file) => orbitBlocks(readFileSync(file, 'utf8'), file));

/**
 * Give a fragment the frontmatter it omits.
 *
 * Prose is clearer when a snippet shows one operator rather than a whole file,
 * so a block that does not start with `---` is treated as a page body. The
 * alternative — repeating six lines of header in every example — would make the
 * docs worse to read in order to make this test simpler to write.
 */
function wrap(source) {
  return source.trimStart().startsWith('---') ? source : `---\npage snippet\n---\n${source}`;
}

/**
 * Components referenced by snippets that show a CALL rather than a definition.
 *
 * A tutorial showing `<ProductCard product={product}/>` should not have to
 * inline the component's definition to make a point about call syntax, so the
 * definitions live here and are compiled alongside every snippet. They are real
 * templates, checked like any other, so they cannot drift from the language.
 */
const AMBIENT_COMPONENTS = [
  {
    name: 'ambient/ProductCard.orbit',
    source: `---\ncomponent ProductCard\nprops {\n  product: Product\n}\n---\n<article class="card">\n  <h3>{product.title}</h3>\n</article>\n`,
  },
  {
    name: 'ambient/Panel.orbit',
    source: `---\ncomponent Panel\nslots {\n  header\n  footer?\n}\n---\n<section class="panel">\n  <header><slot name="header"/></header>\n  <div><slot/></div>\n  <footer><slot name="footer"/></footer>\n</section>\n`,
  },
];

/** The component a block defines, if it defines one. */
function definedComponent(source) {
  const match = source.split('\n').find((line) => line.startsWith('component '));
  return match === undefined ? undefined : match.slice('component '.length).trim();
}

/**
 * Compile one block; returns the error diagnostics.
 *
 * A snippet showing a component CALL is compiled alongside the definitions that
 * appear earlier on the same page, which is exactly how a reader encounters
 * them. That keeps the docs readable — a call example does not have to repeat
 * the definition — while still compiling every definition for real, so neither
 * half can drift from the language.
 */
function compile(block, allBlocks) {
  const name = `${path.basename(block.file)}:${block.line}`;
  const wrapped = wrap(block.source);
  const selfDefines = definedComponent(wrapped);

  const earlierInFile = allBlocks
    .filter(
      (b) =>
        b.file === block.file &&
        b.line < block.line &&
        !b.expectError &&
        definedComponent(b.source) !== undefined &&
        definedComponent(b.source) !== selfDefines,
    )
    // Keep only the LAST definition of each component name: pages often refine
    // the same example, and two templates sharing a name is itself an error.
    .reduce((acc, b) => acc.set(definedComponent(b.source), b), new Map());

  const deps = [...earlierInFile.values()].map((b) => ({
    name: `${path.basename(b.file)}:${b.line}`,
    source: b.source,
  }));

  const defined = new Set([selfDefines, ...earlierInFile.keys()]);
  const ambient = AMBIENT_COMPONENTS.filter(
    (c) => !defined.has(path.basename(c.name, '.orbit')),
  );

  const parsed = parseProgram([...ambient, ...deps, { name, source: wrapped }]);
  if (!parsed.ok) return parsed.diagnostics.filter((d) => d.severity === 'error');
  const result = check(parsed.program, {
    registry: makeRegistry(),
    hostFilters: HOST_FILTERS,
    pageGlobals: PAGE_GLOBALS,
  });
  return result.diagnostics.filter((d) => d.severity === 'error');
}

describe('documentation', () => {
  it('contains orbit code blocks to check', () => {
    // Guards against the extractor silently matching nothing after a docs
    // restructure, which would make every assertion below vacuous.
    expect(BLOCKS.length).toBeGreaterThan(10);
  });

  const good = BLOCKS.filter((b) => !b.expectError);
  const bad = BLOCKS.filter((b) => b.expectError);

  for (const block of good) {
    const where = `${path.relative(HERE, block.file)}:${block.line}`;
    it(`compiles: ${where}`, () => {
      const errors = compile(block, BLOCKS);
      expect(
        errors.map((d) => `${d.code} ${d.message} (line ${d.span?.start.line})`),
        `snippet at ${where} does not compile`,
      ).toEqual([]);
    });
  }

  for (const block of bad) {
    const where = `${path.relative(HERE, block.file)}:${block.line}`;
    it(`fails as documented: ${where}`, () => {
      const errors = compile(block, BLOCKS);
      expect(errors.length, `snippet at ${where} was expected to fail but compiled`).toBeGreaterThan(
        0,
      );
    });
  }
});
