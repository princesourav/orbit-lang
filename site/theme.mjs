/**
 * The site's chrome: stylesheet, page shell, sidebar, table of contents.
 *
 * Separated from `build.mjs` so the layout can be read on its own. No client
 * JavaScript: the mobile navigation is a `<details>` disclosure and the theme
 * follows the reader's system preference, which is what a documentation site
 * needs and the entire budget it deserves. A docs site that ships a framework
 * to render prose is an odd advertisement for a language whose pitch is that
 * most pages do not need one.
 */
import { escapeHtml } from './markdown.mjs';

export const SITE_TITLE = 'Orbit';
export const TAGLINE =
  'A typed, non-Turing-complete, HTML-strict template language for authors you do not trust.';

export const STYLE = `
:root {
  --bg: #ffffff;
  --bg-soft: #f7f8fa;
  --fg: #14161a;
  --fg-soft: #545b68;
  --rule: #e4e7ec;
  --accent: #2a55d4;
  --accent-soft: #eef2ff;
  --code-bg: #f2f4f7;
  --pre-bg: #fbfcfd;
  --danger: #c62b3d;
  --warn: #a35c00;
  --radius: 10px;
  --sidebar: 16.5rem;
  --toc: 15rem;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d0f13;
    --bg-soft: #14171d;
    --fg: #e7e9ee;
    --fg-soft: #99a1b0;
    --rule: #232830;
    --accent: #7fa4ff;
    --accent-soft: #171d2c;
    --code-bg: #171a21;
    --pre-bg: #101318;
    --danger: #ff7b8a;
    --warn: #e0a24a;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 5rem; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }

/* ---------- top bar ---------- */
.topbar {
  position: sticky; top: 0; z-index: 30;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: saturate(160%) blur(10px);
  border-bottom: 1px solid var(--rule);
}
.topbar-inner {
  max-width: 96rem; margin: 0 auto; padding: .7rem 1.25rem;
  display: flex; align-items: center; gap: 1.5rem;
}
.brand {
  font-weight: 660; letter-spacing: -0.02em; font-size: 1.05rem;
  color: var(--fg); text-decoration: none; display: flex; align-items: center; gap: .5rem;
}
.brand .mark {
  width: 1.1rem; height: 1.1rem; border-radius: 50%;
  border: 2px solid var(--accent); position: relative; display: inline-block;
}
.brand .mark::after {
  content: ""; position: absolute; width: .3rem; height: .3rem; border-radius: 50%;
  background: var(--accent); top: -.18rem; right: -.18rem;
}
.topnav { display: flex; gap: 1.15rem; margin-left: auto; flex-wrap: wrap; }
.topnav a { color: var(--fg-soft); text-decoration: none; font-size: .925rem; }
.topnav a:hover, .topnav a[aria-current] { color: var(--accent); }

/* ---------- layout ---------- */
.shell {
  max-width: 96rem; margin: 0 auto; padding: 0 1.25rem;
  display: grid; gap: 2.5rem;
  grid-template-columns: var(--sidebar) minmax(0, 1fr) var(--toc);
  align-items: start;
}
.shell.wide { grid-template-columns: minmax(0, 1fr); }

.sidebar {
  position: sticky; top: 4rem; max-height: calc(100vh - 5rem);
  overflow-y: auto; padding: 2rem 0 3rem; font-size: .925rem;
}
.sidebar h2 {
  font-size: .72rem; text-transform: uppercase; letter-spacing: .08em;
  color: var(--fg-soft); margin: 1.5rem 0 .5rem; font-weight: 640;
}
.sidebar h2:first-child { margin-top: 0; }
.sidebar ul { list-style: none; margin: 0; padding: 0; }
.sidebar li { margin: 0; }
.sidebar a {
  display: block; padding: .3rem .6rem; border-radius: 6px;
  color: var(--fg-soft); text-decoration: none; line-height: 1.45;
}
.sidebar a:hover { background: var(--bg-soft); color: var(--fg); }
.sidebar a[aria-current] {
  background: var(--accent-soft); color: var(--accent); font-weight: 560;
}

main { padding: 2.25rem 0 6rem; min-width: 0; }

.toc {
  position: sticky; top: 4rem; max-height: calc(100vh - 5rem); overflow-y: auto;
  padding: 2.25rem 0 3rem; font-size: .875rem;
}
.toc h2 {
  font-size: .72rem; text-transform: uppercase; letter-spacing: .08em;
  color: var(--fg-soft); margin: 0 0 .6rem; font-weight: 640;
}
.toc ul { list-style: none; margin: 0; padding: 0; }
.toc a {
  display: block; padding: .18rem 0 .18rem .7rem; color: var(--fg-soft);
  text-decoration: none; border-left: 2px solid var(--rule); line-height: 1.5;
}
.toc a:hover { color: var(--accent); border-left-color: var(--accent); }
.toc .lvl-3 { padding-left: 1.5rem; }

/* ---------- prose ---------- */
main h1, main h2, main h3, main h4 { line-height: 1.25; letter-spacing: -0.02em; }
main h1 { font-size: 2.15rem; margin: 0 0 1rem; }
main h2 {
  font-size: 1.45rem; margin: 2.75rem 0 .9rem;
  padding-top: 1.25rem; border-top: 1px solid var(--rule);
}
main h3 { font-size: 1.12rem; margin: 2rem 0 .6rem; }
main h4 { font-size: 1rem; margin: 1.5rem 0 .5rem; color: var(--fg-soft); }
main p, main li { overflow-wrap: break-word; }
main ul, main ol { padding-left: 1.35rem; }
main li { margin: .3rem 0; }
main img { max-width: 100%; }

code {
  background: var(--code-bg); padding: .14em .38em; border-radius: 5px;
  font-family: var(--mono); font-size: .86em;
}
pre {
  background: var(--pre-bg); border: 1px solid var(--rule);
  border-radius: var(--radius); padding: 1rem 1.15rem; overflow-x: auto;
  margin: 1.25rem 0; line-height: 1.6;
}
pre code { background: none; padding: 0; font-size: .855rem; }

blockquote {
  margin: 1.5rem 0; padding: .85rem 1.15rem;
  background: var(--bg-soft); border-left: 3px solid var(--accent);
  border-radius: 0 var(--radius) var(--radius) 0; color: var(--fg-soft);
}
blockquote p:first-child { margin-top: 0; }
blockquote p:last-child { margin-bottom: 0; }

.table-scroll {
  overflow-x: auto; margin: 1.25rem 0;
  border: 1px solid var(--rule); border-radius: var(--radius);
}
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { padding: .55rem .8rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--rule); }
th { background: var(--bg-soft); font-weight: 620; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }

hr { border: 0; border-top: 1px solid var(--rule); margin: 2.5rem 0; }

.anchor {
  float: left; margin-left: -1.05rem; width: 1.05rem; opacity: 0;
  text-decoration: none; color: var(--fg-soft); font-weight: 400;
}
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { opacity: .55; }

/* ---------- syntax colours ---------- */
.t-fence, .t-punc { color: var(--fg-soft); }
.t-kw { color: #b3309a; font-weight: 560; }
.t-tag { color: #1a7f5a; }
.t-ctl { color: #b3309a; font-weight: 560; }
.t-comp { color: #7a4ecb; }
.t-err { color: var(--danger); font-weight: 600; text-decoration: underline wavy var(--danger); }
.t-warn { color: var(--warn); text-decoration: underline dotted var(--warn); }
.t-attr { color: #9a6a00; }
.t-url { color: #9a6a00; font-style: italic; }
.t-prop { color: #0a7ea3; }
.t-str { color: #1a7f5a; }
.t-num { color: #1a6fd0; }
.t-lit { color: #1a6fd0; font-weight: 560; }
.t-type { color: #7a4ecb; }
.t-ctrl { color: #7a4ecb; }
.t-fn { color: #1a6fd0; }
.t-var { color: var(--fg); }
.t-op { color: var(--fg-soft); }
.t-island { color: #b3309a; font-weight: 600; }
.t-com { color: var(--fg-soft); font-style: italic; }
@media (prefers-color-scheme: dark) {
  .t-kw, .t-ctl, .t-island { color: #e987d4; }
  .t-tag, .t-str { color: #7fd6a9; }
  .t-comp, .t-type, .t-ctrl { color: #c5a6ff; }
  .t-attr, .t-url { color: #e8bd72; }
  .t-prop { color: #6fd0e8; }
  .t-num, .t-lit, .t-fn { color: #86b4ff; }
}

/* ---------- landing ---------- */
.hero { padding: 4.5rem 0 2.5rem; max-width: 46rem; }
.hero h1 {
  font-size: clamp(2.2rem, 1.5rem + 3vw, 3.4rem); line-height: 1.1;
  letter-spacing: -0.035em; margin: 0 0 1.1rem;
}
.hero .lede { font-size: 1.2rem; color: var(--fg-soft); margin: 0 0 1.75rem; }
.hero .cta { display: flex; gap: .75rem; flex-wrap: wrap; }
.btn {
  display: inline-block; padding: .6rem 1.15rem; border-radius: 8px;
  text-decoration: none; font-weight: 550; font-size: .95rem; border: 1px solid transparent;
}
.btn-primary { background: var(--accent); color: #fff; }
.btn-primary:hover { filter: brightness(1.08); }
.btn-ghost { border-color: var(--rule); color: var(--fg); }
.btn-ghost:hover { background: var(--bg-soft); }

.pillars { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); margin: 1rem 0 3rem; }
.pillar { border: 1px solid var(--rule); border-radius: var(--radius); padding: 1.15rem 1.25rem; background: var(--bg-soft); }
.pillar h3 { margin: 0 0 .4rem; font-size: 1rem; }
.pillar p { margin: 0; color: var(--fg-soft); font-size: .925rem; }

.split { display: grid; gap: 2rem; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); align-items: start; }
.landing-section { margin: 3.5rem 0; }
.landing-section > h2 {
  font-size: 1.35rem; border: 0; padding: 0; margin: 0 0 1rem; letter-spacing: -0.02em;
}

/* ---------- footer & mobile ---------- */
footer.site {
  border-top: 1px solid var(--rule); color: var(--fg-soft); font-size: .875rem;
  padding: 2rem 1.25rem 3rem; max-width: 96rem; margin: 0 auto;
}
footer.site a { color: var(--fg-soft); }

.mobile-nav { display: none; }
.mobile-nav > summary {
  cursor: pointer; padding: .7rem 0; color: var(--fg-soft);
  font-size: .9rem; list-style: none;
}
.mobile-nav > summary::-webkit-details-marker { display: none; }
.mobile-nav > summary::before { content: "☰  "; }

.pager { display: flex; justify-content: space-between; gap: 1rem; margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); }
.pager a { display: block; text-decoration: none; padding: .7rem 1rem; border: 1px solid var(--rule); border-radius: var(--radius); max-width: 48%; }
.pager a:hover { background: var(--bg-soft); }
.pager .dir { display: block; font-size: .75rem; color: var(--fg-soft); text-transform: uppercase; letter-spacing: .06em; }
.pager .next { margin-left: auto; text-align: right; }

@media (max-width: 78rem) {
  .shell { grid-template-columns: var(--sidebar) minmax(0, 1fr); }
  .toc { display: none; }
}
@media (max-width: 56rem) {
  .shell { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .sidebar { position: static; max-height: none; padding: 0 0 1rem; border-bottom: 1px solid var(--rule); }
  .mobile-nav { display: block; }
  .sidebar .nav-body { display: none; }
  .mobile-nav[open] + .nav-body, .sidebar details[open] .nav-body { display: block; }
  .topnav { display: none; }
  .hero { padding: 2.5rem 0 1.5rem; }
}
`.trim();

/** The persistent left navigation, grouped the way the docs are organised. */
export const SECTIONS = [
  {
    title: 'Start',
    items: [
      ['index.html', 'Overview'],
      ['docs/language/tutorial.html', 'Tutorial'],
      ['playground/', 'Playground'],
      ['docs/scope.html', 'Scope'],
    ],
  },
  {
    title: 'Language',
    items: [
      ['docs/language/templates.html', 'Templates'],
      ['docs/language/types.html', 'Types'],
      ['docs/language/components.html', 'Components'],
      ['docs/language/safety.html', 'Safety'],
    ],
  },
  {
    title: 'Reference',
    items: [
      ['docs/reference/grammar.html', 'Grammar'],
      ['docs/reference/filters.html', 'Filters'],
      ['docs/reference/limits.html', 'Limits'],
      ['docs/reference/errors.html', 'Error codes'],
    ],
  },
  {
    title: 'Guides',
    items: [
      ['docs/guides/embedding.html', 'Embedding'],
      ['docs/guides/security-model.html', 'Security model'],
      ['docs/guides/trusted-types.html', 'Trusted Types & CSP'],
      ['docs/guides/non-js-embedding.html', 'Non-JS hosts'],
    ],
  },
  {
    title: 'Design',
    items: [
      ['docs/design/custom-properties.html', 'Custom properties'],
      ['docs/design/widgets.html', 'Platform widgets'],
      ['docs/evaluation/closed-world.html', 'Closed-world evaluation'],
    ],
  },
  {
    title: 'Project',
    items: [
      ['spec/SPEC.html', 'Specification'],
      ['conformance/README.html', 'Conformance corpus'],
      ['security.html', 'Security policy'],
      ['stability.html', 'Stability policy'],
      ['roadmap.html', 'Roadmap'],
      ['CHANGELOG.html', 'Changelog'],
      ['docs/compliance/claims.html', 'Claims manifest'],
      ['docs/compliance/cra-readiness.html', 'CRA readiness'],
    ],
  },
];

const TOP_NAV = [
  ['docs/language/tutorial.html', 'Docs'],
  ['docs/reference/grammar.html', 'Reference'],
  ['playground/', 'Playground'],
  ['https://github.com/princesourav/orbit-lang', 'GitHub'],
];

/** `../` repeated for the depth of a page, so every link is subpath-safe. */
export const baseFor = (depth) => (depth === 0 ? '' : '../'.repeat(depth));

const href = (base, target) => (target.startsWith('http') ? target : `${base}${target}`);

function renderSidebar(base, current) {
  const groups = SECTIONS.map((section) => {
    const items = section.items
      .map(([target, label]) => {
        const active = target === current ? ' aria-current="page"' : '';
        return `<li><a href="${escapeHtml(href(base, target))}"${active}>${escapeHtml(label)}</a></li>`;
      })
      .join('');
    return `<h2>${escapeHtml(section.title)}</h2><ul>${items}</ul>`;
  }).join('');

  // The mobile disclosure and the desktop list are the same markup; CSS decides
  // which is visible. No script, and no second copy of the navigation.
  return `<nav class="sidebar" aria-label="Documentation">
  <details class="mobile-nav"><summary>Menu</summary></details>
  <div class="nav-body">${groups}</div>
</nav>`;
}

function renderToc(headings) {
  const shown = headings.filter((h) => h.level === 2 || h.level === 3);
  if (shown.length < 2) return '';
  const items = shown
    .map(
      (h) =>
        `<li><a class="lvl-${h.level}" href="#${escapeHtml(h.id)}">${escapeHtml(h.text.replace(/`/g, ''))}</a></li>`,
    )
    .join('');
  return `<nav class="toc" aria-label="On this page"><h2>On this page</h2><ul>${items}</ul></nav>`;
}

function renderPager(base, prev, next) {
  if (prev === undefined && next === undefined) return '';
  const link = (entry, dir, cls) =>
    entry === undefined
      ? ''
      : `<a class="${cls}" href="${escapeHtml(href(base, entry[0]))}"><span class="dir">${dir}</span>${escapeHtml(entry[1])}</a>`;
  return `<div class="pager">${link(prev, 'Previous', 'prev')}${link(next, 'Next', 'next')}</div>`;
}

/**
 * Wrap rendered content in the site shell.
 *
 * `layout: 'landing'` drops the sidebar and table of contents; everything else
 * gets the full documentation chrome.
 */
export function shell({ title, description, content, depth, current, headings = [], layout = 'docs', prev, next }) {
  const base = baseFor(depth);
  const topnav = TOP_NAV.map(
    ([target, label]) =>
      `<a href="${escapeHtml(href(base, target))}"${target.startsWith('http') ? ' rel="noopener noreferrer"' : ''}>${escapeHtml(label)}</a>`,
  ).join('');

  const isLanding = layout === 'landing';
  const body = isLanding
    ? `<div class="shell wide"><main>${content}</main></div>`
    : `<div class="shell">
${renderSidebar(base, current)}
<main>${content}${renderPager(base, prev, next)}</main>
${renderToc(headings)}
</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='11' fill='none' stroke='%232a55d4' stroke-width='3'/><circle cx='25' cy='7' r='4' fill='%232a55d4'/></svg>">
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="${escapeHtml(base || './')}"><span class="mark"></span>${escapeHtml(SITE_TITLE)}</a>
    <nav class="topnav" aria-label="Main">${topnav}</nav>
  </div>
</header>
${body}
<footer class="site">
  Every page here is generated from the repository and checked in CI — the docs,
  the playground and <a href="${escapeHtml(base)}llms.txt">llms.txt</a> are the
  same files the build verifies. Apache-2.0.
</footer>
</body>
</html>
`;
}
