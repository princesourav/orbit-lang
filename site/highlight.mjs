/**
 * Build-time syntax highlighting for Orbit code blocks.
 *
 * Two things make this worth having rather than reaching for a generic
 * highlighter:
 *
 * 1. **The vocabulary comes from the engine.** Element names, banned elements,
 *    URL attributes and filter names are imported from the compiled package,
 *    not restated here. A tag added to the allowlist highlights correctly on
 *    the next build; a highlighter with its own copy of the list starts lying
 *    the first time the list changes.
 * 2. **Banned elements and unknown tags are coloured as errors**, the same way
 *    the editor grammars do it. The documentation then shows the language's
 *    rules rather than only describing them — `<script>` is visibly wrong on
 *    the page that explains why it is rejected.
 *
 * The scanner itself is deliberately simple and RESILIENT rather than a reuse
 * of the real parser: a large share of the snippets in these documents are
 * deliberately invalid, because they illustrate diagnostics. A highlighter that
 * required a clean parse would fail on exactly the examples that matter most.
 * It is display-only, and nothing downstream depends on its judgements.
 *
 * Output is escaped before any markup is added, like everything else here.
 */
import { BANNED_ELEMENTS, ELEMENT_ALLOWLIST, STDLIB, URL_ATTRS } from '@orbitlang/core';

import { escapeHtml } from './markdown.mjs';

const CONTROL_TAGS = new Set([
  'if', 'else-if', 'else', 'for', 'empty', 'match', 'case', 'let', 'slot', 'json-ld',
]);

const FRONTMATTER_KEYWORDS = new Set([
  'component', 'page', 'props', 'settings', 'slots', 'orbit', 'label',
]);

const CONTROLS = new Set(['Text', 'Toggle', 'Color', 'Select', 'Range']);
const TYPES = new Set([
  'String', 'Int', 'Float', 'Bool', 'Color', 'Url', 'Money', 'MoneyText', 'Image', 'Html', 'List',
]);
const LITERALS = new Set(['true', 'false', 'none']);

const span = (cls, text) => `<span class="t-${cls}">${escapeHtml(text)}</span>`;

/** Classify a tag name using the engine's own tables. */
function tagClass(name) {
  if (CONTROL_TAGS.has(name)) return 'ctl';
  if (BANNED_ELEMENTS.has(name)) return 'err';
  if (/^[A-Z]/.test(name)) return 'comp'; // PascalCase = component call
  if (ELEMENT_ALLOWLIST.has(name)) return 'tag';
  return 'warn'; // not in the closed allowlist
}

/** Highlight the inside of an `{expression}` island. */
function expression(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += span('str', src.slice(i, Math.min(j + 1, src.length)));
      i = j + 1;
      continue;
    }
    if (c === '#') {
      let j = i + 1;
      while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j += 1;
      out += span('num', src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      out += span('num', src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      // A name followed by `(` or preceded by `|>` is a filter call.
      const after = src.slice(j).trimStart();
      const isCall = after.startsWith('(');
      const piped = /\|>\s*$/.test(src.slice(0, i));
      if (LITERALS.has(word)) out += span('lit', word);
      else if (TYPES.has(word)) out += span('type', word);
      else if (isCall || piped) out += span(STDLIB.has(word) ? 'fn' : 'fn', word);
      else out += span('var', word);
      i = j;
      continue;
    }
    if (src.startsWith('|>', i) || src.startsWith('??', i) || src.startsWith('?.', i)) {
      out += span('op', src.slice(i, i + 2));
      i += 2;
      continue;
    }
    if ('+-*/%<>=!&|?:'.includes(c)) {
      out += span('op', c);
      i += 1;
      continue;
    }
    out += escapeHtml(c);
    i += 1;
  }
  return out;
}

/** Highlight a run of template body text, turning `{…}` into expressions. */
function body(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '{') {
      let depth = 0;
      let j = i;
      while (j < src.length) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      const inner = src.slice(i + 1, j);
      out += `<span class="t-island">{</span>${expression(inner)}<span class="t-island">}</span>`;
      i = j + 1;
      continue;
    }
    out += escapeHtml(src[i]);
    i += 1;
  }
  return out;
}

/** Highlight the attribute region of a tag. */
function attributes(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (/\s/.test(c)) {
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += 1;
      const inner = src.slice(i + 1, j);
      out += `<span class="t-str">"</span>${body(inner)}<span class="t-str">"</span>`;
      i = j + 1;
      continue;
    }
    if (c === '{') {
      let depth = 0;
      let j = i;
      while (j < src.length) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      out += `<span class="t-island">{</span>${expression(src.slice(i + 1, j))}<span class="t-island">}</span>`;
      i = j + 1;
      continue;
    }
    if (c === '=' || c === '?') {
      out += span('op', c);
      i += 1;
      continue;
    }
    // An attribute name, including `--custom-property` and `data-*`.
    let j = i;
    while (j < src.length && /[-A-Za-z0-9_:@]/.test(src[j])) j += 1;
    if (j === i) {
      out += escapeHtml(c);
      i += 1;
      continue;
    }
    const name = src.slice(i, j);
    const cls =
      name.startsWith('--') ? 'prop'
      : name === 'defer' || name === 'verbatim' ? 'ctl'
      : URL_ATTRS.has(name) ? 'url'
      : 'attr';
    out += span(cls, name);
    i = j;
  }
  return out;
}

/** Highlight the frontmatter block between the `---` fences. */
function frontmatter(src) {
  let out = '';
  for (const line of src.split('\n')) {
    const word = /^\s*([A-Za-z]+)/.exec(line);
    if (word && FRONTMATTER_KEYWORDS.has(word[1])) {
      const before = line.slice(0, word.index + word[0].length - word[1].length);
      const rest = line.slice(word.index + word[0].length);
      out += escapeHtml(before) + span('kw', word[1]) + frontmatterRest(rest) + '\n';
      continue;
    }
    out += frontmatterRest(line) + '\n';
  }
  return out.slice(0, -1);
}

function frontmatterRest(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += 1;
      out += span('str', src.slice(i, Math.min(j + 1, src.length)));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_#0-9]/.test(src[i])) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_#]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      if (TYPES.has(word)) out += span('type', word);
      else if (CONTROLS.has(word)) out += span('ctrl', word);
      else if (LITERALS.has(word)) out += span('lit', word);
      else if (/^[#0-9]/.test(word)) out += span('num', word);
      else if (FRONTMATTER_KEYWORDS.has(word)) out += span('kw', word);
      // PascalCase in frontmatter is a host-declared type or a component name.
      // The engine's own tables cannot help here — the host declares them — so
      // the casing convention the language already enforces is what is used.
      else if (/^[A-Z]/.test(word)) out += span('type', word);
      else out += span('var', word);
      i = j;
      continue;
    }
    out += escapeHtml(src[i]);
    i += 1;
  }
  return out;
}

/**
 * Highlight an Orbit source snippet.
 *
 * Resilient by construction: anything it does not recognise is escaped and
 * emitted as plain text, so a deliberately-broken example still renders.
 */
export function highlightOrbit(source) {
  let out = '';
  let i = 0;

  // Frontmatter, when the snippet is a whole template.
  if (source.startsWith('---')) {
    const end = source.indexOf('\n---', 3);
    if (end !== -1) {
      const fenceEnd = source.indexOf('\n', end + 1);
      out +=
        span('fence', '---') +
        '\n' +
        frontmatter(source.slice(4, end)) +
        '\n' +
        span('fence', '---');
      i = fenceEnd === -1 ? source.length : fenceEnd;
    }
  }

  while (i < source.length) {
    // `{# comment #}`
    if (source.startsWith('{#', i)) {
      const end = source.indexOf('#}', i);
      const stop = end === -1 ? source.length : end + 2;
      out += span('com', source.slice(i, stop));
      i = stop;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i);
      const stop = end === -1 ? source.length : end + 3;
      out += span('com', source.slice(i, stop));
      i = stop;
      continue;
    }

    if (source[i] === '<') {
      const m = /^<\/?([A-Za-z][-A-Za-z0-9]*)/.exec(source.slice(i));
      if (m) {
        const closing = source[i + 1] === '/';
        const name = m[1];
        // Find the end of the tag, skipping quoted values and islands.
        let j = i + m[0].length;
        let depth = 0;
        while (j < source.length) {
          const c = source[j];
          if (c === '"') {
            j += 1;
            while (j < source.length && source[j] !== '"') j += 1;
          } else if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
          else if (c === '>' && depth <= 0) break;
          j += 1;
        }
        out +=
          span('punc', closing ? '</' : '<') +
          span(tagClass(name), name) +
          attributes(source.slice(i + m[0].length, j)) +
          span('punc', source.slice(j, j + 1));
        i = j + 1;
        continue;
      }
    }

    // An interpolation island in element content.
    if (source[i] === '{') {
      let depth = 0;
      let j = i;
      while (j < source.length) {
        if (source[j] === '{') depth += 1;
        else if (source[j] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      if (j >= source.length) {
        // Unterminated — an error example. Emit what is there and stop
        // pretending to understand the rest.
        out += span('island', source.slice(i));
        break;
      }
      out +=
        span('island', '{') + expression(source.slice(i + 1, j)) + span('island', '}');
      i = j + 1;
      continue;
    }

    // Ordinary text, up to the next thing worth looking at.
    let j = i + 1;
    while (j < source.length && source[j] !== '<' && source[j] !== '{') j += 1;
    out += escapeHtml(source.slice(i, j));
    i = j;
  }
  return out;
}

/** Languages this highlights; anything else is escaped and left plain. */
export function highlight(lang, source) {
  if (lang === 'orbit') return highlightOrbit(source);
  return escapeHtml(source);
}
