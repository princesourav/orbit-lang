/**
 * A small, first-party markdown renderer for the documentation site.
 *
 * Zero dependencies, like everything else that generates an artifact here. It
 * handles the subset these documents actually use — measured, not guessed:
 * headings, paragraphs, fenced code, tables (by far the most common construct),
 * lists, blockquotes, rules, and inline code / links / emphasis.
 *
 * **Escaping first.** This project's entire pitch is that markup cannot be
 * smuggled through a text sink, so a renderer that shipped an XSS in its own
 * documentation site would be an unusually embarrassing bug. Every text run is
 * escaped before anything else happens; the only HTML that reaches the output
 * is HTML this file wrote. No raw-HTML passthrough is supported, deliberately —
 * markdown's `<div>` escape hatch is exactly the feature that makes other
 * renderers dangerous.
 *
 * Regular expressions are used freely: the no-regex rule is a constraint on the
 * ENGINE, where filter cost has to be predictable, not on build tooling.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Every text run goes through this before it can reach the output. */
export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

/**
 * A link target that is safe to emit.
 *
 * The same scheme rule the engine's URL sink uses, for the same reason: a
 * `javascript:` href in a doc is a live vulnerability on the published site,
 * and "the content is first-party" is an argument that stops being true the
 * first time someone accepts a documentation pull request.
 */
function safeHref(href) {
  const trimmed = href.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) return trimmed;
  if (lower.startsWith('mailto:')) return trimmed;
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('.')) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return '#'; // any other scheme
  return trimmed; // bare relative path
}

/** `docs/guides/embedding.md#anchor` -> `embedding.html#anchor`. */
export function rewriteLink(href) {
  const [path, hash] = href.split('#');
  if (!path.endsWith('.md')) return href;
  return `${path.slice(0, -3)}.html${hash === undefined ? '' : `#${hash}`}`;
}

/**
 * Pull code spans out, leaving numbered placeholders behind.
 *
 * Scanned rather than matched with a regular expression, because the rule is
 * "a run of N backticks closes on the next run of EXACTLY N" — and a
 * non-greedy regex closes on the first two backticks of a longer run instead.
 * That matters directly here: these documents quote fence markers, so
 * `` ```orbit `` is a code span whose content is itself three backticks.
 */
function extractCodeSpans(text, codes) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      out += text[i];
      i += 1;
      continue;
    }
    let open = 0;
    while (text[i + open] === '`') open += 1;

    // Find a closing run of exactly the same length.
    let j = i + open;
    let close = -1;
    while (j < text.length) {
      if (text[j] === '`') {
        let run = 0;
        while (text[j + run] === '`') run += 1;
        if (run === open) {
          close = j;
          break;
        }
        j += run;
        continue;
      }
      j += 1;
    }
    if (close === -1) {
      // Unterminated: the backticks are literal text.
      out += text.slice(i, i + open);
      i += open;
      continue;
    }
    codes.push(text.slice(i + open, close).trim());
    out += ` CODE${codes.length - 1} `;
    i = close + open;
  }
  return out;
}

/**
 * Inline markdown.
 *
 * Code spans are extracted FIRST and replaced with placeholders, so that a
 * backtick-quoted `**not bold**` or `[not a link](x)` stays literal — which
 * matters here, because these documents quote syntax constantly.
 */
export function renderInline(text) {
  const codes = [];
  let work = extractCodeSpans(text, codes);

  work = escapeHtml(work);

  /*
   * Images BEFORE links, because a badge row is `[![alt](src)](href)` — an
   * image nested inside a link. Handled the other way round, the link pattern
   * matches the inner brackets and produces `<a>![alt</a>](href)`.
   */
  work = work.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
    const target = safeHref(src);
    return `<img src="${escapeHtml(target)}" alt="${alt}" loading="lazy">`;
  });

  // [label](target)
  work = work.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const target = safeHref(rewriteLink(href));
    const external = /^https?:/i.test(target);
    const rel = external ? ' rel="noopener noreferrer"' : '';
    return `<a href="${escapeHtml(target)}"${rel}>${label}</a>`;
  });

  // Lazy, and NOT `[^*]+`: bold spans in these documents contain nested
  // emphasis — "**typed *and* safe**" — which a no-asterisk body cannot match.
  // Emphasis runs after, so the inner `*and*` is picked up inside the strong.
  work = work.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  // Single `*` only when it is not part of `**`, and not a bare asterisk.
  work = work.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  return work.replace(/ CODE(\d+) /g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

/** GitHub-style heading slug, so in-page anchors match what the docs link to. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function renderTableRow(line, cell) {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
  return `<tr>${cells.map((c) => `<${cell}>${renderInline(c)}</${cell}>`).join('')}</tr>`;
}

const isTableDivider = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

/**
 * Render a markdown document to an HTML fragment, and collect its headings so
 * a page can build its own table of contents.
 */
export function renderMarkdown(source) {
  const lines = source.split('\n');
  const out = [];
  const headings = [];
  let i = 0;

  const flushParagraph = (buffer) => {
    if (buffer.length === 0) return;
    out.push(`<p>${renderInline(buffer.join(' '))}</p>`);
    buffer.length = 0;
  };

  const paragraph = [];

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. The body is escaped and emitted verbatim — no inline
    // processing, which is the whole point of a code block.
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const lang = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugify(text);
      headings.push({ level, text, id });
      out.push(
        `<h${level} id="${escapeHtml(id)}">` +
          `<a class="anchor" href="#${escapeHtml(id)}" aria-hidden="true">#</a>` +
          `${renderInline(text)}</h${level}>`,
      );
      i += 1;
      continue;
    }

    // Tables — the most-used construct in these documents by a wide margin.
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushParagraph(paragraph);
      const head = renderTableRow(line, 'th');
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body.push(renderTableRow(lines[i], 'td'));
        i += 1;
      }
      out.push(
        `<div class="table-scroll"><table><thead>${head}</thead><tbody>${body.join('')}</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph(paragraph);
      out.push('<hr>');
      i += 1;
      continue;
    }

    // Lists. Nesting is handled one level deep, which is all these docs use.
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const ordered = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph(paragraph);
      const tag = bullet ? 'ul' : 'ol';
      const items = [];
      while (i < lines.length) {
        const m = bullet ? /^(\s*)[-*]\s+(.*)$/.exec(lines[i]) : /^(\s*)\d+\.\s+(.*)$/.exec(lines[i]);
        if (!m) {
          // A continuation line belongs to the item above it.
          if (/^\s+\S/.test(lines[i]) && items.length > 0) {
            items[items.length - 1] += ' ' + lines[i].trim();
            i += 1;
            continue;
          }
          break;
        }
        items.push(m[2]);
        i += 1;
      }
      out.push(`<${tag}>${items.map((t) => `<li>${renderInline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (line.startsWith('>')) {
      flushParagraph(paragraph);
      const quoted = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderMarkdown(quoted.join('\n')).html}</blockquote>`);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph(paragraph);
      i += 1;
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }

  flushParagraph(paragraph);
  return { html: out.join('\n'), headings };
}
