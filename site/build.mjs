#!/usr/bin/env node
/**
 * Build the documentation site.
 *
 * Everything published is GENERATED from files already in the repository and
 * already checked by CI: the docs, the playground, and `llms.txt`. Nothing on
 * the site is authored separately, so it cannot drift from the engine — the
 * same rule the error index, the conformance corpus and `llms.txt` are held to.
 *
 * The one exception is the landing page, which is written here rather than
 * lifted from the README. A README is written for someone standing in the
 * repository with the source in front of them; a landing page is written for
 * someone who has never heard of the project. Dumping one into the other reads
 * as neither.
 *
 * Zero dependencies. Markdown, chrome and highlighting are `./markdown.mjs`,
 * `./theme.mjs` and `./highlight.mjs`, first-party for the same reason.
 *
 * Usage:
 *   node site/build.mjs           # build into site/dist
 *   node site/build.mjs --check   # fail if the output would differ
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { highlight } from './highlight.mjs';
import { escapeHtml, renderMarkdown, rewriteLink } from './markdown.mjs';
import { SECTIONS, SITE_TITLE, TAGLINE, shell } from './theme.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'dist');

const REPO = 'https://github.com/princesourav/orbit-lang';
const BRANCH = 'main';

/** Root-level documents worth publishing, and the name each takes on the site. */
const ROOT_PAGES = [
  ['SECURITY.md', 'security.html', 'Security policy'],
  ['STABILITY.md', 'stability.html', 'Stability policy'],
  ['ROADMAP.md', 'roadmap.html', 'Roadmap'],
  ['CONTRIBUTING.md', 'CONTRIBUTING.html', 'Contributing'],
  ['GOVERNANCE.md', 'GOVERNANCE.html', 'Governance'],
  ['CODE_OF_CONDUCT.md', 'CODE_OF_CONDUCT.html', 'Code of conduct'],
  ['TRADEMARK.md', 'TRADEMARK.html', 'Trademark'],
  ['CHANGELOG.md', 'CHANGELOG.html', 'Changelog'],
  ['README.md', 'README.html', 'Readme'],
  ['spec/SPEC.md', 'spec/SPEC.html', 'Specification'],
  ['conformance/README.md', 'conformance/README.html', 'Conformance corpus'],
];

/** Files copied verbatim, with the path they take on the site. */
const COPIES = [
  ['playground/index.html', 'playground/index.html'],
  ['llms.txt', 'llms.txt'],
  ['llms-full.txt', 'llms-full.txt'],
];

/** Reading order for previous/next, flattened from the sidebar. */
const READING_ORDER = SECTIONS.flatMap((s) => s.items).filter(([target]) => !target.endsWith('/'));

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------

const SAMPLE = `---
orbit 2026
component ProductCard
props {
  product: Product
  eager: Bool = false
}
settings {
  accent: Color = #2a55d4 label "Accent"
}
---
{# Merchant text is data. It cannot become markup. #}
<article class="card" --card-accent={settings.accent}>
  <a href={product.url}>
    <img src={imgUrl(product.cover, 600, crop: "center")} alt={product.title}/>
    <match {product.badge}>
      <case "none"></case>
      <case "new"><span class="badge">New</span></case>
      <case "sale"><span class="badge badge--sale">Sale</span></case>
    </match>
    <h3>{product.title}</h3>
    <p>{money(product.price)}</p>
  </a>
</article>`;

const PILLARS = [
  [
    'XSS is a compile error',
    'Six escaping contexts, assigned by position in the syntax tree before any value exists. A template author cannot introduce an unescaped sink, choose one, or opt out at a call site.',
  ],
  [
    'No sandbox, because no escape surface',
    'No recursion, no dynamic member access, no runtime code generation, and no way to name a host object the embedder did not declare. Termination is a property of the grammar.',
  ],
  [
    'Typed against your own object model',
    'You declare the types and the filters. The optional law, terminal types and exhaustive matching turn a class of runtime holes into diagnostics with fix-its.',
  ],
  [
    'The data a template touches is extractable',
    'A static access plan says exactly what a page reads, before it renders — which is what makes declare-then-fetch, and later fragment caching, possible at all.',
  ],
];

function landingContent(base) {
  const link = (target, label, cls) =>
    `<a class="${cls}" href="${escapeHtml(target.startsWith('http') ? target : base + target)}"${target.startsWith('http') ? ' rel="noopener noreferrer"' : ''}>${escapeHtml(label)}</a>`;

  const pillars = PILLARS.map(
    ([title, text]) => `<div class="pillar"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`,
  ).join('');

  return `
<section class="hero">
  <h1>The template language for authors you don't trust</h1>
  <p class="lede">${escapeHtml(TAGLINE)} Merchants, customers, and language models write templates. Orbit renders them without ever trusting what they wrote.</p>
  <div class="cta">
    ${link('docs/language/tutorial.html', 'Start the tutorial', 'btn btn-primary')}
    ${link('playground/', 'Open the playground', 'btn btn-ghost')}
    ${link(REPO, 'View on GitHub', 'btn btn-ghost')}
  </div>
</section>

<section class="landing-section">
  <div class="pillars">${pillars}</div>
</section>

<section class="landing-section">
  <h2>A component, in full</h2>
  <p>Typed props, merchant-editable settings, exhaustive matching on a
  host-declared union, and a colour that reaches CSS without an interpolated
  <code>style</code> attribute anywhere.</p>
  <pre><code class="language-orbit">${highlight('orbit', SAMPLE)}</code></pre>
  <p>Every code sample on this site is highlighted using the engine's own
  element allowlist and filter table, so a banned tag looks wrong here for the
  same reason it fails to compile.</p>
</section>

<section class="landing-section">
  <h2>What it refuses to do</h2>
  <div class="split">
    <div>
      <p>Each of these is a constraint the rest of the design is built on top of.
      Removing one does not add a feature — it removes a guarantee, which is why
      the <a href="${escapeHtml(base)}docs/scope.html">scope page</a> names the
      invariant behind every exclusion.</p>
      <ul>
        <li>No raw-HTML sink a template author can reach</li>
        <li>No dynamic member access</li>
        <li>No author-written JavaScript in a theme</li>
        <li>No user-defined functions, recursion or unbounded loops</li>
        <li>No regular expressions, no <code>eval</code></li>
        <li>No interpolated <code>style</code> attribute</li>
      </ul>
    </div>
    <div>
      <p>What it does instead is measurable. A closed-world evaluation against a
      real 116-block storefront library is published in full, including the part
      of the number that looks bad:</p>
      <p><a href="${escapeHtml(base)}docs/evaluation/closed-world.html">The closed-world evaluation →</a></p>
      <p>And every capability claim in the documentation is mapped to the test
      that substantiates it, with CI failing if the evidence disappears:</p>
      <p><a href="${escapeHtml(base)}docs/compliance/claims.html">The claims manifest →</a></p>
    </div>
  </div>
</section>

<section class="landing-section">
  <h2>Get started</h2>
  <pre><code class="language-sh">${escapeHtml('npm install @orbitlang/core\n\nnpx orbit check src/themes/        # parse and report, with code frames\nnpx orbit fmt src/themes/          # canonical formatting')}</code></pre>
  <p>Then read the <a href="${escapeHtml(base)}docs/guides/embedding.html">embedding guide</a>
  to declare your object model, or the
  <a href="${escapeHtml(base)}docs/language/tutorial.html">tutorial</a> to write a component.</p>
</section>
`.trim();
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function docFiles(dir = path.join(ROOT, 'docs'), acc = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) docFiles(full, acc);
    else if (entry.endsWith('.md')) acc.push(full);
  }
  return acc;
}

function titleOf(source, fallback) {
  const m = /^#\s+(.*)$/m.exec(source);
  return m === null ? fallback : m[1].trim().replace(/`/g, '');
}

/** Previous/next in reading order, for a page that appears in the sidebar. */
function neighbours(outRel) {
  const index = READING_ORDER.findIndex(([target]) => target === outRel);
  if (index === -1) return {};
  return { prev: READING_ORDER[index - 1], next: READING_ORDER[index + 1] };
}

function renderPage(written, { source, outRel, title, layout }) {
  const depth = outRel.split('/').length - 1;
  const { html, headings } = renderMarkdown(source, { highlight });
  const { prev, next } = neighbours(outRel);
  written.set(
    outRel,
    shell({
      title: `${title} — ${SITE_TITLE}`,
      description: `${title}. ${TAGLINE}`,
      content: html,
      depth,
      current: outRel,
      headings,
      layout,
      prev,
      next,
    }),
  );
}

function buildAll() {
  const written = new Map();

  written.set(
    'index.html',
    shell({
      title: `${SITE_TITLE} — the template language for authors you don't trust`,
      description: TAGLINE,
      content: landingContent(''),
      depth: 0,
      current: 'index.html',
      layout: 'landing',
    }),
  );

  for (const [file, outRel, label] of ROOT_PAGES) {
    renderPage(written, {
      source: readFileSync(path.join(ROOT, file), 'utf8'),
      outRel,
      title: label,
    });
  }

  for (const abs of docFiles()) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const source = readFileSync(abs, 'utf8');
    renderPage(written, {
      source,
      outRel: rel.replace(/\.md$/, '.html'),
      title: titleOf(source, path.basename(rel, '.md')),
    });
  }

  repointOffsiteLinks(written, COPIES.map(([, to]) => to));
  return written;
}

/**
 * Send links that do not resolve on the site to the repository instead.
 *
 * A post-pass, because it needs the complete published set. The docs link to
 * source files and directories — those are repository paths: meaningful on
 * GitHub, meaningless here. Publishing the source to satisfy them would be the
 * wrong fix; pointing at the repository is the right one.
 */
function repointOffsiteLinks(written, copied) {
  const published = new Set([...written.keys(), ...copied]);

  for (const [rel, html] of written) {
    const dir = path.posix.dirname(rel);
    written.set(
      rel,
      html.replace(/href="([^"]+)"/g, (whole, href) => {
        if (/^(https?:|mailto:|#|data:)/i.test(href)) return whole;
        const [target, hash] = href.split('#');
        if (target === '' || target === './') return whole;

        const resolved = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, target));
        // `../../` from a nested page resolves to the site root, which
        // normalizes to `.` — the landing page, not a repository path.
        if (resolved === '.' || resolved === './' || resolved === '') return whole;
        if (published.has(resolved) || published.has(`${resolved.replace(/\/$/, '')}/index.html`)) {
          return whole;
        }

        const isDir = target.endsWith('/');
        const clean = resolved.replace(/\/$/, '');
        const repoPath = clean.endsWith('.html') ? `${clean.slice(0, -5)}.md` : clean;
        const url = `${REPO}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${repoPath}${hash === undefined ? '' : `#${hash}`}`;
        return `href="${escapeHtml(url)}" rel="noopener noreferrer"`;
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(argv) {
  const check = argv.includes('--check');
  const written = buildAll();

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
  for (const [rel, html] of written) {
    const target = path.join(OUT, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, html, 'utf8');
  }
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

export { docFiles, OUT, ROOT, rewriteLink };

if (process.argv[1]?.endsWith('build.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
