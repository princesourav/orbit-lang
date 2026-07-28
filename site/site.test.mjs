import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main as buildSite } from './build.mjs';
import { BANNED_ELEMENTS, ELEMENT_ALLOWLIST } from '@orbitlang/core';

import { highlight, highlightOrbit } from './highlight.mjs';
import { escapeHtml, renderInline, renderMarkdown, rewriteLink, slugify } from './markdown.mjs';

/**
 * The documentation site.
 *
 * Two things are being checked, and the second is the one that pays for itself.
 *
 * 1. The renderer is correct, and — since this project's whole claim is that
 *    markup cannot be smuggled through a text sink — that it does not ship an
 *    XSS in its own documentation.
 * 2. **Every internal link resolves.** The docs cross-reference heavily and
 *    nothing has ever checked those links; a broken one is invisible on GitHub
 *    until someone clicks it. This turns the site build into a link checker for
 *    the documentation set, which is worth more than the site.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(HERE, 'dist');

/**
 * Build before asserting, rather than requiring a prior build step.
 *
 * `site/dist` is generated and gitignored, so a test that only READ it passed
 * locally — where a build had just run — and failed in CI, where the test step
 * comes first. A test whose result depends on what someone happened to run
 * beforehand is not a test.
 */
beforeAll(() => {
  const code = buildSite([]);
  expect(code, 'the site build failed').toBe(0);
});

function distFiles(dir = DIST, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) distFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

const htmlPages = () => distFiles().filter((f) => f.endsWith('.html'));

describe('the markdown renderer', () => {
  it('escapes text before anything else can reach the output', () => {
    const { html } = renderMarkdown('A <script>alert(1)</script> paragraph.');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes inside code fences too', () => {
    const { html } = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('<pre><code>');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('supports no raw-HTML passthrough, which is the feature that makes renderers dangerous', () => {
    // Markdown's raw-HTML escape hatch is exactly what a renderer has to give
    // up to be safe by construction. The handler survives as TEXT — escaped,
    // inert, and visible as source — which is the correct outcome.
    const { html } = renderMarkdown('<div onclick="alert(1)">hi</div>');
    expect(html).not.toMatch(/<div/);
    expect(html).not.toMatch(/<[a-z]+\s+onclick=/);
    expect(html).toContain('&lt;div');
    expect(html).toContain('&quot;');
  });

  it('supports double-backtick code spans, which is how a fence marker is quoted', () => {
    const out = renderInline('Every `` ```orbit `` block is compiled.');
    expect(out).toContain('<code>```orbit</code>');
    expect(out).not.toContain('<pre>');
  });

  it('refuses a javascript: link target', () => {
    const out = renderInline('[click](javascript:alert(1))');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('href="#"');
  });

  it('refuses any other unknown scheme, and keeps the ones a doc needs', () => {
    expect(renderInline('[x](data:text/html,<script>)')).toContain('href="#"');
    expect(renderInline('[x](vbscript:evil)')).toContain('href="#"');
    expect(renderInline('[x](https://example.com/a)')).toContain('href="https://example.com/a"');
    expect(renderInline('[x](mailto:a@example.com)')).toContain('href="mailto:a@example.com"');
    expect(renderInline('[x](#anchor)')).toContain('href="#anchor"');
  });

  it('marks external links noopener', () => {
    expect(renderInline('[x](https://example.com)')).toContain('rel="noopener noreferrer"');
    expect(renderInline('[x](./local.md)')).not.toContain('rel=');
  });

  it('leaves markup inside a code span literal', () => {
    // These documents quote syntax constantly, so a code span that got
    // emphasis-processed would corrupt half the reference pages.
    const out = renderInline('use `**not bold**` and `[not a link](x)`');
    expect(out).toContain('<code>**not bold**</code>');
    expect(out).toContain('<code>[not a link](x)</code>');
    expect(out).not.toContain('<strong>');
  });

  it('renders tables, the construct these docs use most', () => {
    const { html } = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('table-scroll'); // wide tables must scroll, not overflow
  });

  it('renders headings with stable GitHub-compatible slugs', () => {
    const { headings } = renderMarkdown('## The `Html` trust model\n');
    expect(headings[0].id).toBe('the-html-trust-model');
    expect(slugify('Why the threshold fired, and why it was overridden')).toBe(
      'why-the-threshold-fired-and-why-it-was-overridden',
    );
  });

  it('rewrites .md links to .html and keeps the anchor', () => {
    expect(rewriteLink('../evaluation/closed-world.md')).toBe('../evaluation/closed-world.html');
    expect(rewriteLink('scope.md#excluded')).toBe('scope.html#excluded');
    expect(rewriteLink('https://example.com/x.md')).toBe('https://example.com/x.html');
    expect(rewriteLink('#anchor')).toBe('#anchor');
  });

  it('escapes attribute-position text', () => {
    expect(escapeHtml('a" onload="x')).toBe('a&quot; onload=&quot;x');
  });
});

describe('the built site', () => {
  it('has been built', () => {
    expect(existsSync(DIST), 'run: npm run site').toBe(true);
    expect(htmlPages().length).toBeGreaterThan(20);
  });

  it('publishes the playground, llms.txt and llms-full.txt', () => {
    for (const rel of ['playground/index.html', 'llms.txt', 'llms-full.txt']) {
      expect(existsSync(path.join(DIST, rel)), rel).toBe(true);
    }
  });

  it('publishes byte-identical copies, so the site cannot drift from the repo', () => {
    for (const rel of ['playground/index.html', 'llms.txt', 'llms-full.txt']) {
      expect(readFileSync(path.join(DIST, rel), 'utf8')).toBe(
        readFileSync(path.join(ROOT, rel), 'utf8'),
      );
    }
  });

  it('ships .nojekyll, without which Jekyll drops underscore-prefixed files', () => {
    expect(existsSync(path.join(DIST, '.nojekyll'))).toBe(true);
  });

  it('leaves no raw markdown in the output', () => {
    for (const file of htmlPages()) {
      if (file.endsWith(path.join('playground', 'index.html'))) continue;
      const html = readFileSync(file, 'utf8');
      const rel = path.relative(DIST, file);
      // Markdown syntax is legitimate INSIDE a code span or block — these docs
      // quote fence markers and link syntax constantly — so prose is what gets
      // checked, with code stripped first.
      const prose = html
        .slice(html.indexOf('<main>'), html.indexOf('</main>'))
        .replace(/<pre>[\s\S]*?<\/pre>/g, '')
        .replace(/<code>[\s\S]*?<\/code>/g, '');
      expect(prose.includes('```'), `${rel} has an unrendered code fence`).toBe(false);
      expect(/^#{1,6}\s/m.test(prose), `${rel} has an unrendered heading`).toBe(false);
      expect(/\]\([^)]*\)/.test(prose), `${rel} has an unrendered link`).toBe(false);
      expect(/\*\*\w/.test(prose), `${rel} has unrendered bold`).toBe(false);
    }
  });

  it('carries no inline event handler and no script tag of its own', () => {
    // The playground is exempt: it IS an application, built and checked
    // separately, and its script is the thing being shipped.
    for (const file of htmlPages()) {
      if (file.endsWith(path.join('playground', 'index.html'))) continue;
      const html = readFileSync(file, 'utf8');
      expect(html, path.relative(DIST, file)).not.toMatch(/<script/);
      expect(html, path.relative(DIST, file)).not.toMatch(/\son(click|load|error)=/);
    }
  });
});

describe('every internal link resolves', () => {
  /**
   * The check worth having independently of the site.
   *
   * The documentation cross-references constantly and nothing has ever
   * verified those links. On GitHub a broken one is invisible until someone
   * clicks it; here it fails the build.
   */
  const linkTargets = () => {
    const problems = [];
    for (const file of htmlPages()) {
      if (file.endsWith(path.join('playground', 'index.html'))) continue;
      const html = readFileSync(file, 'utf8');
      const dir = path.dirname(file);
      for (const m of html.matchAll(/href="([^"]+)"/g)) {
        const href = m[1];
        if (/^(https?:|mailto:|#|data:)/i.test(href)) continue;
        const [rel] = href.split('#');
        if (rel === '' || rel === './') continue;
        // Directory links resolve to their index.
        const candidate = rel.endsWith('/') ? path.join(dir, rel, 'index.html') : path.join(dir, rel);
        if (!existsSync(candidate)) {
          problems.push(`${path.relative(DIST, file)} -> ${href}`);
        }
      }
    }
    return problems;
  };

  it('resolves every relative link in the generated site', () => {
    expect(linkTargets()).toEqual([]);
  });

  it('sends the Home link to the landing page, not to the repository', () => {
    // `../../` from a nested page resolves to the site root, which normalizes
    // to `.` — the off-site rewrite mistook that for a repository path and
    // pointed the whole nav at GitHub.
    const nested = readFileSync(path.join(DIST, 'docs', 'language', 'tutorial.html'), 'utf8');
    expect(nested).toContain('class="brand" href="../../"');
    expect(nested).not.toContain('tree/main/."');
  });

  it('uses only relative links, so the site works under a project subpath', () => {
    // GitHub Pages serves this at /orbit-lang/, not at a domain root. A single
    // root-absolute href would 404 there and nowhere else, which is the kind of
    // bug that only shows up in production.
    for (const file of htmlPages()) {
      if (file.endsWith(path.join('playground', 'index.html'))) continue;
      const html = readFileSync(file, 'utf8');
      const absolute = [...html.matchAll(/href="(\/[^/][^"]*)"/g)].map((m) => m[1]);
      expect(absolute, path.relative(DIST, file)).toEqual([]);
    }
  });
});

describe('syntax highlighting uses the engine, not a copy of it', () => {
  /**
   * The highlighter imports the element allowlist, the banned table, the URL
   * attributes and the filter names from the compiled package. A highlighter
   * with its own copy of those lists starts lying the first time a list
   * changes; this one cannot drift, and these assertions are what says so.
   */
  it('colours an allowlisted element and a component call differently', () => {
    const out = highlightOrbit('<div><ProductCard product={p}/></div>');
    expect(out).toContain('class="t-tag">div');
    expect(out).toContain('class="t-comp">ProductCard');
  });

  it('marks a banned element as an error, using the engine’s own table', () => {
    // The documentation then SHOWS the rule rather than only describing it:
    // `<script>` is visibly wrong on the page explaining why it is rejected.
    expect(BANNED_ELEMENTS.has('script')).toBe(true);
    expect(highlightOrbit('<script>x</script>')).toContain('class="t-err">script');
  });

  it('marks a tag outside the closed allowlist as a warning', () => {
    expect(ELEMENT_ALLOWLIST.has('blink')).toBe(false);
    expect(highlightOrbit('<blink>x</blink>')).toContain('class="t-warn">blink');
  });

  it('distinguishes a URL attribute, a custom property and an ordinary one', () => {
    const out = highlightOrbit('<img src={u} alt="a" --accent={c}/>');
    expect(out).toContain('class="t-url">src');
    expect(out).toContain('class="t-attr">alt');
    expect(out).toContain('class="t-prop">--accent');
  });

  it('highlights control flow, interpolations and filters', () => {
    const out = highlightOrbit('<if {a != none}><p>{title |> upper}</p></if>');
    expect(out).toContain('class="t-ctl">if');
    expect(out).toContain('class="t-island">{');
    expect(out).toContain('class="t-fn">upper');
  });

  it('highlights frontmatter keywords and types', () => {
    const out = highlightOrbit('---\ncomponent Card\nprops {\n  title: String\n}\n---\n<p>x</p>');
    expect(out).toContain('class="t-kw">component');
    expect(out).toContain('class="t-type">String');
  });

  it('escapes everything it does not recognise', () => {
    const out = highlightOrbit('<p>{"<script>alert(1)</script>"}</p>');
    expect(out).not.toMatch(/<script>alert/);
    expect(out).toContain('&lt;script&gt;');
  });

  it('survives a deliberately broken snippet', () => {
    // A large share of the snippets in these docs are invalid on purpose,
    // because they illustrate diagnostics. A highlighter that needed a clean
    // parse would fail on exactly the examples that matter most.
    for (const broken of ['<div', '{unclosed', '<p>a < b</p>', '---\nbroken', '<if {}>']) {
      expect(() => highlightOrbit(broken)).not.toThrow();
    }
  });

  it('leaves a non-Orbit language alone, escaped', () => {
    expect(highlight('ts', 'const a = "<b>";')).toBe('const a = &quot;&lt;b&gt;&quot;;');
  });
});

describe('the documentation chrome', () => {
  it('gives every docs page a sidebar and marks the current entry', () => {
    const page = readFileSync(path.join(DIST, 'docs', 'reference', 'grammar.html'), 'utf8');
    expect(page).toContain('class="sidebar"');
    expect(page).toMatch(/href="[^"]*docs\/reference\/grammar\.html" aria-current="page"/);
  });

  it('builds an on-page table of contents from the headings', () => {
    const page = readFileSync(path.join(DIST, 'docs', 'reference', 'grammar.html'), 'utf8');
    expect(page).toContain('class="toc"');
    expect(page).toContain('On this page');
  });

  it('links previous and next in reading order', () => {
    const page = readFileSync(path.join(DIST, 'docs', 'language', 'types.html'), 'utf8');
    expect(page).toContain('class="pager"');
    expect(page).toContain('Previous');
    expect(page).toContain('Next');
  });

  it('ships a landing page that is not the README', () => {
    const landing = readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const readme = readFileSync(path.join(DIST, 'README.html'), 'utf8');
    expect(landing).toContain('class="hero"');
    expect(landing).not.toBe(readme);
    // And it shows real, highlighted Orbit rather than a screenshot of it.
    expect(landing).toContain('class="t-kw">component');
  });

  it('has one navigation, not a duplicated mobile copy', () => {
    // The disclosure and the desktop list are the same markup; CSS decides
    // which is visible. Two copies is two things to keep in step.
    const page = readFileSync(path.join(DIST, 'docs', 'scope.html'), 'utf8');
    expect(page.split('class="nav-body"').length - 1).toBe(1);
  });

  it('needs no JavaScript for navigation', () => {
    // The mobile menu is a <details> disclosure. A docs site that shipped a
    // framework to render prose would be an odd advertisement for a language
    // whose pitch is that most pages do not need one.
    const page = readFileSync(path.join(DIST, 'docs', 'scope.html'), 'utf8');
    expect(page).toContain('<details class="mobile-nav">');
    expect(page).not.toMatch(/<script/);
  });
});
