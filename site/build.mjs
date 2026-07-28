#!/usr/bin/env node
/**
 * Build the documentation site.
 *
 * Everything published here is GENERATED from files already in the repository
 * and already checked by CI: the docs, the playground, and `llms.txt`. Nothing
 * on the site is authored separately, so the site cannot drift from the engine
 * — the same rule the error index, the conformance corpus and `llms.txt` are
 * held to.
 *
 * Zero dependencies. The markdown renderer is `./markdown.mjs`, first-party for
 * the same reason.
 *
 * Usage:
 *   node site/build.mjs           # build into site/dist
 *   node site/build.mjs --check   # fail if the output would differ
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeHtml, renderMarkdown, rewriteLink } from './markdown.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'dist');

const SITE_TITLE = 'Orbit';
const TAGLINE = 'A typed, non-Turing-complete, HTML-strict template language for authors you do not trust.';

/**
 * Root-level documents worth publishing.
 *
 * `README.md` becomes the landing page. The rest are the ones a reader looks
 * for by name; CHANGELOG and the governance files stay on GitHub, where their
 * history is the point.
 */
const ROOT_PAGES = [
  ['SECURITY.md', 'security.html', 'Security'],
  ['STABILITY.md', 'stability.html', 'Stability'],
  ['ROADMAP.md', 'roadmap.html', 'Roadmap'],
  ['CONTRIBUTING.md', 'CONTRIBUTING.html', 'Contributing'],
  ['GOVERNANCE.md', 'GOVERNANCE.html', 'Governance'],
  ['CODE_OF_CONDUCT.md', 'CODE_OF_CONDUCT.html', 'Code of conduct'],
  ['TRADEMARK.md', 'TRADEMARK.html', 'Trademark'],
  ['CHANGELOG.md', 'CHANGELOG.html', 'Changelog'],
  ['spec/SPEC.md', 'spec/SPEC.html', 'Specification'],
  ['conformance/README.md', 'conformance/README.html', 'Conformance corpus'],
  // The landing page is README.md, but documents link to it by filename.
  ['README.md', 'README.html', 'Orbit'],
];

/**
 * Where a link goes when its target is not a published page.
 *
 * The docs link to source files and directories — `src/formatter.ts`,
 * `tree-sitter-orbit/`, `LICENSE`. Those are repository paths: meaningful on
 * GitHub, meaningless here. Publishing the source to satisfy them would be the
 * wrong fix; pointing at the repository is the right one.
 */
const REPO = 'https://github.com/princesourav/orbit-lang';
const BRANCH = 'main';

/** Sections in the order the docs index presents them. */
const NAV = [
  { label: 'Home', href: '/' },
  { label: 'Tutorial', href: '/docs/language/tutorial.html' },
  { label: 'Reference', href: '/docs/reference/grammar.html' },
  { label: 'Scope', href: '/docs/scope.html' },
  { label: 'Playground', href: '/playground/' },
  { label: 'GitHub', href: 'https://github.com/princesourav/orbit-lang' },
];

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #16181d; --muted: #5b6270; --rule: #e3e6ec;
  --accent: #2b5fd9; --code-bg: #f5f6f8; --pre-bg: #f7f8fa;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --fg: #e6e8ee; --muted: #9aa2b1; --rule: #262a33;
    --accent: #7aa2f7; --code-bg: #1a1d24; --pre-bg: #14171d;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-text-size-adjust: 100%;
}
header.site {
  border-bottom: 1px solid var(--rule); position: sticky; top: 0;
  background: var(--bg); z-index: 10;
}
header.site nav {
  max-width: 60rem; margin: 0 auto; padding: .75rem 1.25rem;
  display: flex; gap: 1.25rem; flex-wrap: wrap; align-items: baseline;
}
header.site .brand { font-weight: 650; letter-spacing: -0.01em; margin-right: auto; }
header.site a { color: inherit; text-decoration: none; }
header.site a:hover { color: var(--accent); }
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 5rem; }
h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -0.015em; margin: 2rem 0 .75rem; }
h1 { font-size: 2rem; margin-top: .5rem; }
h2 { font-size: 1.4rem; padding-top: .5rem; border-top: 1px solid var(--rule); }
h3 { font-size: 1.1rem; }
p, li { overflow-wrap: break-word; }
a { color: var(--accent); }
code {
  background: var(--code-bg); padding: .12em .35em; border-radius: 4px;
  font: .875em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
pre {
  background: var(--pre-bg); border: 1px solid var(--rule); border-radius: 8px;
  padding: .9rem 1rem; overflow-x: auto;
}
pre code { background: none; padding: 0; font-size: .85rem; }
blockquote {
  margin: 1.25rem 0; padding: .25rem 0 .25rem 1rem;
  border-left: 3px solid var(--accent); color: var(--muted);
}
.table-scroll { overflow-x: auto; margin: 1rem 0; }
table { border-collapse: collapse; width: 100%; font-size: .925rem; }
th, td { border: 1px solid var(--rule); padding: .45rem .6rem; text-align: left; vertical-align: top; }
th { background: var(--code-bg); font-weight: 600; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2rem 0; }
.anchor {
  float: left; margin-left: -1rem; width: 1rem; opacity: 0;
  text-decoration: none; color: var(--muted);
}
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { opacity: 1; }
.lede { font-size: 1.15rem; color: var(--muted); margin-top: 0; }
footer.site {
  border-top: 1px solid var(--rule); color: var(--muted);
  font-size: .875rem; padding: 1.5rem 1.25rem; max-width: 60rem; margin: 0 auto;
}
footer.site a { color: inherit; }
`.trim();

function page({ title, body, description, depth }) {
  const base = depth === 0 ? '' : '../'.repeat(depth);
  const nav = NAV.map((item) => {
    const href = item.href.startsWith('http')
      ? item.href
      : item.href === '/'
        ? `${base || './'}`
        : `${base}${item.href.slice(1)}`;
    const external = item.href.startsWith('http');
    return `<a href="${escapeHtml(href)}"${external ? ' rel="noopener noreferrer"' : ''}>${escapeHtml(item.label)}</a>`;
  }).join('\n      ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="color-scheme" content="light dark">
<style>${STYLE}</style>
</head>
<body>
<header class="site">
  <nav>
    <span class="brand"><a href="${escapeHtml(base || './')}">${escapeHtml(SITE_TITLE)}</a></span>
      ${nav}
  </nav>
</header>
<main>
${body}
</main>
<footer class="site">
  Generated from the repository on every build — the docs, the playground and
  <a href="${escapeHtml(base)}llms.txt">llms.txt</a> are the same files CI checks.
  Apache-2.0.
</footer>
</body>
</html>
`;
}

/** Every markdown file under docs/, as repo-relative paths. */
function docFiles(dir = path.join(ROOT, 'docs'), acc = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) docFiles(full, acc);
    else if (entry.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/** First heading in a document, used as its title. */
function titleOf(source, fallback) {
  const m = /^#\s+(.*)$/m.exec(source);
  return m === null ? fallback : m[1].trim().replace(/`/g, '');
}

function writePage(relative, html) {
  const target = path.join(OUT, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, html, 'utf8');
}

function buildDocs(written) {
  for (const abs of docFiles()) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const source = readFileSync(abs, 'utf8');
    const { html } = renderMarkdown(source);
    const outRel = rel.replace(/\.md$/, '.html');
    const depth = outRel.split('/').length - 1;
    const title = titleOf(source, path.basename(rel, '.md'));
    written.set(
      outRel,
      page({
        title: `${title} — ${SITE_TITLE}`,
        description: `${title}. ${TAGLINE}`,
        body: html,
        depth,
      }),
    );
  }
}

function buildRootPages(written) {
  for (const [file, outRel, label] of ROOT_PAGES) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    const { html } = renderMarkdown(source);
    written.set(
      outRel,
      page({
        title: `${label} — ${SITE_TITLE}`,
        description: `${label}. ${TAGLINE}`,
        body: html,
        depth: 0,
      }),
    );
  }
}

function buildLanding(written) {
  const source = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const { html } = renderMarkdown(source);
  written.set(
    'index.html',
    page({
      title: `${SITE_TITLE} — the template language for untrusted authors`,
      description: TAGLINE,
      body: html,
      depth: 0,
    }),
  );
}

/** Files copied verbatim, with the path they take on the site. */
const COPIES = [
  ['playground/index.html', 'playground/index.html'],
  ['llms.txt', 'llms.txt'],
  ['llms-full.txt', 'llms-full.txt'],
];

/**
 * Send links that do not resolve on the site to the repository instead.
 *
 * Runs as a post-pass because it needs the complete published set, which does
 * not exist until every page has been rendered. A link to `src/formatter.ts`
 * becomes a link to that file on GitHub; a link to `tree-sitter-orbit/` becomes
 * a link to that directory. Neither should 404, and neither should be published
 * here.
 */
function repointOffsiteLinks(written, copied) {
  const published = new Set([...written.keys(), ...copied]);

  for (const [rel, html] of written) {
    const dir = path.posix.dirname(rel);
    const patched = html.replace(/href="([^"]+)"/g, (whole, href) => {
      if (/^(https?:|mailto:|#)/i.test(href)) return whole;

      const [target, hash] = href.split('#');
      if (target === '' || target === './') return whole;

      const resolved = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, target));
      // `../../` from a nested page resolves to the site root, which normalizes
      // to `.` — that is the landing page, not a repository path.
      if (resolved === '.' || resolved === './' || resolved === '') return whole;
      const asIndex = `${resolved.replace(/\/$/, '')}/index.html`;
      if (published.has(resolved) || published.has(asIndex)) return whole;

      // Not on the site: it is a repository path. A trailing slash means a
      // directory, which GitHub serves under /tree/ rather than /blob/.
      const isDir = target.endsWith('/');
      const clean = resolved.replace(/\/$/, '');
      // The link was written against a `.md` source; undo the .html rewrite so
      // the repository URL points at the file that actually exists there.
      const repoPath = clean.endsWith('.html') ? `${clean.slice(0, -5)}.md` : clean;
      const url = `${REPO}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${repoPath}${hash === undefined ? '' : `#${hash}`}`;
      return `href="${escapeHtml(url)}" rel="noopener noreferrer"`;
    });
    written.set(rel, patched);
  }
}

function main(argv) {
  const check = argv.includes('--check');

  const written = new Map();
  buildLanding(written);
  buildRootPages(written);
  buildDocs(written);
  repointOffsiteLinks(written, COPIES.map(([, to]) => to));

  for (const [from] of COPIES) {
    if (!existsSync(path.join(ROOT, from))) {
      console.error(`site: ${from} is missing — run its generator first`);
      return 1;
    }
  }

  if (check) {
    for (const [rel, html] of written) {
      const target = path.join(OUT, rel);
      if (!existsSync(target) || readFileSync(target, 'utf8') !== html) {
        console.error(`site: ${rel} is STALE — run: npm run site`);
        return 1;
      }
    }
    for (const [from, to] of COPIES) {
      const target = path.join(OUT, to);
      if (!existsSync(target) || readFileSync(target, 'utf8') !== readFileSync(path.join(ROOT, from), 'utf8')) {
        console.error(`site: ${to} is STALE — run: npm run site`);
        return 1;
      }
    }
    console.log(`site: up to date (${String(written.size)} pages)`);
    return 0;
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const [rel, html] of written) writePage(rel, html);
  for (const [from, to] of COPIES) {
    const target = path.join(OUT, to);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(ROOT, from), target);
  }
  // GitHub Pages runs Jekyll unless told not to, and Jekyll drops files whose
  // names begin with an underscore.
  writeFileSync(path.join(OUT, '.nojekyll'), '', 'utf8');

  console.log(`site: wrote ${String(written.size)} pages + ${String(COPIES.length)} copied files to site/dist`);
  return 0;
}

export { docFiles, main, OUT, ROOT, rewriteLink };

if (process.argv[1]?.endsWith('build.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
