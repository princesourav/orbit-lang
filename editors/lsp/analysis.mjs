/**
 * The Orbit language server's analysis, separated from the protocol shell.
 *
 * Everything here is a pure function of a source string and a cursor position,
 * which is what makes it testable without standing up an LSP client. `server.mjs`
 * is the transport; this is the behaviour.
 *
 * **Compile-only, by design.** Nothing here renders a template or invokes a
 * host filter. An editor opens whatever is on disk, including a template
 * someone else wrote, so a language server that rendered would be executing
 * untrusted input on every keystroke. Templates cannot express arbitrary
 * computation, but host filters are ordinary code — and a server that never
 * calls them cannot be the thing that runs them.
 */
import {
  BANNED_ELEMENTS,
  ELEMENT_ALLOWLIST,
  STDLIB_FILTER_NAMES,
  URL_ATTRS,
  check,
  formatTemplate,
  parseProgram,
  parseTemplate,
  TypeRegistry,
} from '@orbitlang/core';

/** LSP DiagnosticSeverity, inlined so this module needs no protocol import. */
export const SEVERITY = { error: 1, warning: 2 };

/** LSP CompletionItemKind subset. */
export const KIND = {
  variable: 6,
  property: 7,
  function: 3,
  keyword: 14,
  constant: 21,
  field: 5,
  interface: 8,
};

/**
 * Diagnostics that depend on a project's type registry, which an editor has no
 * way to know.
 *
 * Without a host, every `{product.title}` is an unknown identifier. Reporting
 * those would bury the diagnostics that ARE actionable — the type laws, the
 * allowlists, the syntax — and a server whose output is mostly noise gets
 * turned off. Suppressed unless the client supplies a host description.
 */
export const HOST_DEPENDENT_CODES = new Set(['O2030', 'O2031', 'O2032']);

export const FILTER_DOCS = {
  upper: 'upper(String) -> String — uppercase',
  lower: 'lower(String) -> String — lowercase',
  capitalize: 'capitalize(String) -> String — uppercase the first character only',
  trim: 'trim(String) -> String — strip leading and trailing whitespace',
  truncate:
    'truncate(String, Num, ellipsis?: String) -> String — shorten; the ellipsis counts toward the limit',
  replace: 'replace(String, from: String, to: String) -> String — literal, no patterns',
  split: 'split(String, sep: String) -> List<String>',
  slugify: 'slugify(String) -> String — ASCII-oriented; does not transliterate',
  urlEncode: 'urlEncode(String) -> String — percent-encode for a query string',
  join: 'join(List<primitive>, sep: String) -> String',
  size: 'size(List | String) -> Int',
  first: 'first(List<T>) -> T? — optional, because the list may be empty',
  last: 'last(List<T>) -> T? — optional, because the list may be empty',
  reverse: 'reverse(List<T>) -> List<T>',
  sortBy: 'sortBy(List<T>, key: string-literal) -> List<T> — stable, missing values last',
  where: 'where(List<T>, key: string-literal, value) -> List<T> — strict equality',
  round: 'round(Num, places?: literal 0-6) -> Int | Float',
  clamp: 'clamp(Num, min: Num, max: Num) -> Int | Float',
  formatDate:
    'formatDate(iso: String, pattern: String) -> String — applies NO timezone conversion',
};

const CONTROL_TAGS = ['if', 'else-if', 'else', 'for', 'empty', 'let', 'slot', 'json-ld'];

/** Convert an Orbit diagnostic (1-based) to an LSP one (0-based). */
export function toLspDiagnostic(d) {
  const startLine = Math.max(0, (d.span?.start.line ?? 1) - 1);
  const startCol = Math.max(0, (d.span?.start.col ?? 1) - 1);
  const endLine = Math.max(0, (d.span?.end.line ?? d.span?.start.line ?? 1) - 1);
  const endCol = Math.max(0, (d.span?.end.col ?? (d.span?.start.col ?? 1) + 1) - 1);
  return {
    range: {
      start: { line: startLine, character: startCol },
      end: { line: endLine, character: endCol },
    },
    severity: d.severity === 'warning' ? SEVERITY.warning : SEVERITY.error,
    code: d.code,
    source: 'orbit',
    // The fix-it is the most useful part of an Orbit diagnostic, so it goes in
    // the message rather than hiding behind a code action.
    message: d.suggestion === undefined ? d.message : `${d.message}\n\nhelp: ${d.suggestion}`,
  };
}

/** Diagnostics for one buffer. */
export function diagnose(source, { name = 'buffer.orbit', hasProjectHost = false } = {}) {
  const parsed = parseProgram([{ name, source }]);
  if (!parsed.ok) return parsed.diagnostics.map(toLspDiagnostic);

  const result = check(parsed.program, {
    registry: new TypeRegistry(),
    hostFilters: [],
    pageGlobals: {},
  });
  return result.diagnostics
    .filter((d) => hasProjectHost || !HOST_DEPENDENT_CODES.has(d.code))
    .map(toLspDiagnostic);
}

/** The template being edited, when it parses. */
function templateOf(source) {
  const result = parseTemplate(source, 'buffer.orbit');
  return result.ok ? result.template : undefined;
}

/**
 * Completions for a cursor.
 *
 * `linePrefix` is the text from the start of the line up to the cursor, which
 * is enough to distinguish the three positions worth distinguishing: after a
 * `<`, after a `|>`, and inside an expression.
 */
export function complete(source, linePrefix) {
  const trimmed = linePrefix.trimEnd();

  // After a pipe only a filter name is legal — the grammar allows nothing else
  // there, so offering elements would be noise.
  if (trimmed.endsWith('|>')) {
    return STDLIB_FILTER_NAMES.map((name) => ({
      label: name,
      kind: KIND.function,
      detail: FILTER_DOCS[name],
    }));
  }

  if (linePrefix.endsWith('<')) {
    return [
      ...[...ELEMENT_ALLOWLIST].sort().map((element) => ({
        label: element,
        kind: KIND.property,
        detail: 'element',
      })),
      ...CONTROL_TAGS.map((tag) => ({ label: tag, kind: KIND.keyword, detail: 'control flow' })),
    ];
  }

  const items = [];
  const template = templateOf(source);
  if (template !== undefined) {
    for (const prop of template.props) {
      items.push({ label: prop.name, kind: KIND.variable, detail: 'prop' });
    }
    if (template.settings.length > 0) {
      items.push({ label: 'settings', kind: KIND.variable, detail: 'settings' });
      for (const setting of template.settings) {
        items.push({
          label: `settings.${setting.name}`,
          kind: KIND.field,
          detail: `setting (${setting.setting.control})`,
        });
      }
    }
    for (const slot of template.slots) {
      items.push({
        label: slot.name,
        kind: KIND.interface,
        detail: slot.required ? 'slot (required)' : 'slot (optional)',
      });
    }
  }

  for (const name of STDLIB_FILTER_NAMES) {
    items.push({ label: name, kind: KIND.function, detail: FILTER_DOCS[name] });
  }
  for (const literal of ['true', 'false', 'none']) {
    items.push({ label: literal, kind: KIND.constant });
  }
  return items;
}

/** The identifier-ish word under a character offset in a line. */
export function wordAt(line, character) {
  const isWordChar = (c) => c !== undefined && /[A-Za-z0-9_-]/.test(c);
  let index = character;
  if (index >= line.length) index = line.length - 1;
  if (index < 0 || !isWordChar(line[index])) return undefined;
  let start = index;
  let end = index;
  while (start > 0 && isWordChar(line[start - 1])) start -= 1;
  while (end < line.length - 1 && isWordChar(line[end + 1])) end += 1;
  return line.slice(start, end + 1);
}

/**
 * Hover markdown for a word, or undefined.
 *
 * `linePrefix` — the line up to the start of the word — disambiguates names
 * that are legitimately two things. `header` is both an allowlisted element and
 * a perfectly ordinary slot name, and which one the user meant is decided by
 * whether a `<` precedes it. Without that context the element table would
 * always win and every `slots { header }` would get the wrong card.
 */
export function hover(source, word, linePrefix = '') {
  if (word === undefined) return undefined;

  const isTagPosition = linePrefix.endsWith('<') || linePrefix.endsWith('</');
  const template = templateOf(source);

  if (isTagPosition) {
    // The most useful hover in the language: it answers "why can't I use this"
    // without a trip to the docs.
    const banned = BANNED_ELEMENTS.get(word);
    if (banned !== undefined) {
      return (
        `**\`<${word}>\` is not allowed**\n\n${banned}\n\n` +
        'Enforced at parse time; there is no opt-out.'
      );
    }
    if (ELEMENT_ALLOWLIST.has(word)) return `\`<${word}>\` — allowlisted element`;
  }

  // Names the buffer itself declares beat the global tables: they are what the
  // author is looking at.
  const prop = template?.props.find((p) => p.name === word);
  if (prop !== undefined) return `\`${word}\` — prop`;

  const slot = template?.slots.find((s) => s.name === word);
  if (slot !== undefined) {
    return `\`${word}\` — ${slot.required ? 'required' : 'optional'} slot`;
  }

  const setting = template?.settings.find((s) => s.name === word);
  if (setting !== undefined) {
    return `\`${word}\` — setting (\`${setting.setting.control}\`)`;
  }

  if (FILTER_DOCS[word] !== undefined) return `\`\`\`\n${FILTER_DOCS[word]}\n\`\`\``;

  if (word === 'settings') {
    return '`settings` — merchant-editable values declared in frontmatter. Reserved; cannot be shadowed.';
  }

  if (URL_ATTRS.has(word)) {
    return (
      `\`${word}\` — a URL-bearing attribute.\n\n` +
      'Sanitized at emission against the scheme allowlist. A plain `String` is ' +
      'allowed here: Orbit never trusts a type to mean a URL is safe.'
    );
  }

  const banned = BANNED_ELEMENTS.get(word);
  if (banned !== undefined) {
    return (
      `**\`<${word}>\` is not allowed**\n\n${banned}\n\n` +
      'Enforced at parse time; there is no opt-out.'
    );
  }
  if (ELEMENT_ALLOWLIST.has(word)) return `\`<${word}>\` — allowlisted element`;

  return undefined;
}

/**
 * Canonically formatted source, or undefined when the buffer does not parse.
 *
 * Undefined means "make no edit". Formatting a file the formatter could not
 * fully understand is how a formatter eats someone's work, and the diagnostics
 * already explain the problem.
 */
export function format(source) {
  const result = parseTemplate(source, 'buffer.orbit');
  if (!result.ok) return undefined;
  return formatTemplate(result.template);
}
