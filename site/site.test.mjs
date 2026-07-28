import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
        if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) continue;
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
    const nav = nested.slice(nested.indexOf('<nav>'), nested.indexOf('</nav>'));
    expect(nav).toContain('href="../../"');
    expect(nav).not.toContain('tree/main/."');
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
