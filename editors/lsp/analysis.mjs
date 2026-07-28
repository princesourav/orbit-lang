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
export const HOST_DEPENDENT_CODES = new Set([
  'O2030', // unknown identifier
  'O2031', // no such property
  'O2032', // property of a non-record
  /*
   * The filter-signature codes belong here for the same reason. A buffer with
   * no host description has no host filters at all, so every `imgUrl(cover,
   * 96, crop: "face")` reads as an unknown filter with a wrong argument count
   * and an invented parameter name. Four red squiggles on correct code is how
   * a language server gets switched off.
   */
  'O2070', // unknown filter
  'O2100', // wrong argument count
  'O2101', // wrong argument type
  'O2105', // no such named argument
  'O2106', // one parameter, two arguments
]);

/**
 * Stdlib signatures.
 *
 * Parameter roles are written as `name=Type` rather than `name: Type`. The
 * colon form is now real syntax — a NAMED argument — and it binds only to a
 * host filter's optional parameters. A stdlib filter has none, so showing
 * `replace(String, from: String, …)` in a completion popup would be teaching a
 * call site the checker rejects with O2105.
 */
export const FILTER_DOCS = {
  upper: 'upper(String) -> String — uppercase',
  lower: 'lower(String) -> String — lowercase',
  capitalize: 'capitalize(String) -> String — uppercase the first character only',
  trim: 'trim(String) -> String — strip leading and trailing whitespace',
  truncate:
    'truncate(String, Num, ellipsis?=String) -> String — shorten; the ellipsis counts toward the limit',
  replace: 'replace(String, from=String, to=String) -> String — literal, no patterns',
  split: 'split(String, sep=String) -> List<String>',
  slugify: 'slugify(String) -> String — ASCII-oriented; does not transliterate',
  urlEncode: 'urlEncode(String) -> String — percent-encode for a query string',
  join: 'join(List<primitive>, sep=String) -> String',
  size: 'size(List | String) -> Int',
  first: 'first(List<T>) -> T? — optional, because the list may be empty',
  last: 'last(List<T>) -> T? — optional, because the list may be empty',
  reverse: 'reverse(List<T>) -> List<T>',
  sortBy: 'sortBy(List<T>, key=string-literal) -> List<T> — stable, missing values last',
  where: 'where(List<T>, key=string-literal, value) -> List<T> — strict equality',
  round: 'round(Num, places?=literal 0-6) -> Int | Float',
  clamp: 'clamp(Num, min=Num, max=Num) -> Int | Float',
  formatDate:
    'formatDate(iso=String, pattern=String) -> String — applies NO timezone conversion',
};

const CONTROL_TAGS = [
  'if',
  'else-if',
  'else',
  'for',
  'empty',
  'match',
  'case',
  'let',
  'slot',
  'json-ld',
];

/**
 * Control tags whose rules are not guessable from the name.
 *
 * `<match>` earns an entry because its most surprising rule — no default arm on
 * a union — reads as a missing feature until you know why.
 */
const CONTROL_TAG_DOCS = {
  match:
    '`<match {expr}>` — one arm per value.\n\n' +
    'On a **string-literal union** every variant must have a `<case>`, and a ' +
    '`<case default>` is REJECTED: a default would absorb a variant added ' +
    'later, which is the failure exhaustiveness exists to catch.\n\n' +
    'On a plain `String` a `<case default>` is REQUIRED, since a String is not ' +
    'a closed set.',
  case:
    '`<case "value">` or `<case default>` — an arm of a `<match>`. ' +
    'Only `<case>` may appear between `<match>` and `</match>`.',
};

/**
 * Types a `props` block may declare, with the note a reader needs at the moment
 * they are choosing one.
 *
 * `Html` is here because it became a legal prop type: a shared rich-text
 * component is the reason the restriction was lifted, and an author will not
 * discover that from a type list that omits it.
 */
const PROP_TYPES = {
  String: 'String — text. Escaped wherever it renders.',
  Int: 'Int — whole number.',
  Float: 'Float — decimal. `/` always yields Float.',
  Bool: 'Bool — the only thing <if> accepts; there is no truthiness.',
  Color: 'Color — exactly #rrggbb.',
  Url: 'Url — renders and is valid in URL attributes. Carries no safety guarantee: URL safety is enforced at the sink.',
  Money: 'Money — terminal. No operators, no properties, no rendering. Format with a host filter.',
  MoneyText: 'MoneyText — formatted money. Renders; admits no filters.',
  Image: 'Image — opaque handle. Host-filter input only.',
  Html: 'Html — sanitized markup from a host filter. Element-content only: never an attribute, <let> binding, filter operand or <title>. Cannot be optional or listed — sanitize before the ?? instead.',
};

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

  /*
   * Inside a frontmatter block, after `name:`, the only legal continuation is a
   * type. Offering elements and filters there would be noise, and the type list
   * is exactly where an author discovers that Html is available.
   *
   * Detected from the line shape (`  name:`) plus being before the closing
   * fence, which is cheap and does not need a second parse of a buffer that is
   * mid-edit and may not parse at all.
   */
  if (trimmed.endsWith(':') && /^\s+[A-Za-z_][A-Za-z0-9_]*\s*:$/.test(trimmed)) {
    const beforeCursor = source.slice(0, source.length);
    const fenceCount = beforeCursor.split('\n---').length - 1;
    if (fenceCount >= 1) {
      return Object.entries(PROP_TYPES).map(([label, detail]) => ({
        label,
        kind: KIND.property,
        detail,
      }));
    }
  }

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
    if (CONTROL_TAG_DOCS[word] !== undefined) return CONTROL_TAG_DOCS[word];
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

  if (PROP_TYPES[word] !== undefined) return PROP_TYPES[word];

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
