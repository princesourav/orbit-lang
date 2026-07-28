#!/usr/bin/env node
/**
 * Error-code index generator.
 *
 * Scans `src/` for diagnostic code literals (`'O1234'`) and the message
 * attached to each one, then emits `docs/reference/errors.md`. The point is
 * that the published index CANNOT drift from the engine: the codes and the
 * message text are read out of the source, and only the "what to do about it"
 * column is authored — it lives in the NOTES table below, in this file, under
 * review like any other code.
 *
 * Drift is an error in BOTH directions:
 *   - a code in src/ with no NOTES entry  -> reported, row still emitted
 *   - a NOTES entry for a code src/ no longer raises -> hard failure
 *
 * Usage:
 *   node scripts/gen-error-index.mjs            # write docs/reference/errors.md
 *   node scripts/gen-error-index.mjs --check    # exit 1 if the file is stale
 *   node scripts/gen-error-index.mjs --stdout   # print, write nothing
 *
 * Regex is used freely here: the no-regex rule is a constraint on the ENGINE
 * (src/), not on repo tooling. Zero dependencies; Node builtins only.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src');
const OUT_REL = 'docs/reference/errors.md';
const OUT_ABS = path.join(ROOT, OUT_REL);

// ---------------------------------------------------------------------------
// Authored column: what the code means in one line, and what to do about it.
// ---------------------------------------------------------------------------

/** code -> short remedy. Kept here so it is reviewed alongside the engine. */
const NOTES = new Map(Object.entries({
  // -- O1xxx: lexer -----------------------------------------------------------
  O1001: 'Close the interpolation island with `}`. Every `{` in template text opens an expression.',
  O1002: 'Split the expression across two or more `<let>` bindings.',
  O1003: 'Remove the character; Orbit expressions use ASCII identifiers, numbers, strings, `#colors` and the documented punctuators.',
  O1004: 'Add the closing `"`. Strings cannot span lines.',
  O1005: 'Replace the literal newline with `\\n`.',
  O1006: 'Use one of `\\n` `\\t` `\\r` `\\"` `\\\\` `\\/`.',
  O1007: 'Shorten the literal, or move the text into element content where it is not a single value.',
  O1008: 'Write the full six-digit form, e.g. `#0a0a0a`. Three-digit and named colors are not accepted.',
  O1009: 'Break the expression into `<let>` steps; deep nesting is capped so checking stays linear.',
  O1010: 'Delete the trailing token, or wrap the whole thing in parentheses if you meant one expression.',
  O1011: 'The expression ends mid-operator — supply the missing operand.',
  O1012: 'Insert the punctuation the parser named (usually a `)`, `]`, `}` or `:`).',
  O1013: 'The right of `|>` is a filter name, optionally with arguments: `x |> truncate(40)`.',
  O1014: 'Write a static property name after the dot. There is no dynamic member access.',
  O1015: 'Use a static property (`obj.name`). `obj["name"]` would make data flow unanalyzable.',
  O1016: 'Methods do not exist; pipe instead: `value |> filter(args)`.',
  O1017: 'Record keys are identifiers or string literals: `{ name: "x" }`.',
  O1018: 'The token cannot start an expression — check for a stray operator or an unbalanced bracket.',
  O1019: 'Parenthesize: `(x |> round) * 2`. `|>` binds looser than every arithmetic and comparison operator.',
  O1020: 'Supply the identifier the parser asked for (a prop, setting, slot or binding name).',
  O1021: 'A `<` in text must be written `{"<"}`; a tag needs a name immediately after `<`.',
  O1022: 'Close the comment with `#}`.',
  O1023: 'Close the comment with `-->`.',
  O1024: 'Orbit numbers are IEEE-754 doubles — a literal this wide has no exact representation. Shorten it.',
  O1025: 'Write the value the double actually holds, or keep integers within the safe-integer range.',

  // -- O1xxx: frontmatter -----------------------------------------------------
  O1030: 'Start the file with a `---` frontmatter block declaring `component Name` or `page name`.',
  O1031: 'Close the frontmatter with a second `---`.',
  O1032: 'A template is either a component or a page, declared exactly once.',
  O1033: 'Rename the component to PascalCase: `component ProductCard`.',
  O1034: 'Rename the page to lowercase: `page collection`.',
  O1035: 'Frontmatter accepts only `component`, `page`, `props`, `settings` and `slots`.',
  O1036: 'Add `component Name` or `page name` inside the frontmatter block.',
  O1037: 'Open the block with `{`: `props { … }`.',
  O1038: 'Close the block with `}`.',
  O1039: 'Write `List<T>` with an element type, e.g. `List<Product>`.',
  O1040: 'Supply a numeric literal.',
  O1041: 'Frontmatter defaults are literals only: numbers, strings, `true`/`false`, `none`, `#rrggbb`.',
  O1042: '`settings` is the reserved binding for merchant settings — pick another name.',
  O1043: 'Every prop is typed: `title: String`.',
  O1044: 'Every setting names a control: `heading: Text = "Sale"`.',
  O1045: 'Write `Select("a", "b")` with string-literal options.',
  O1046: 'Write `Range(0, 12)` or `Range(0, 12, step: 2)` with integer bounds.',
  O1047: 'Valid controls are `Text`, `Select(...)`, `Range(min, max, step)`, `Toggle`, `Color`.',
  O1048: 'Give the setting a default: `name: Toggle = false`. Merchant settings are always populated.',
  O1049: 'Labels are string literals: `label "Heading"`.',

  // -- O1xxx: markup ----------------------------------------------------------
  O1050: 'Close the element. Orbit is HTML-strict: no implied end tags, no auto-closing.',
  O1051: 'Finish the closing tag with `>`.',
  O1052: 'Tags must nest properly — close the inner element before the outer one.',
  O1053: 'Write `{"<"}` for a literal less-than sign.',
  O1054: 'Split the text run; a single text node or attribute value is capped.',
  O1055: '`<empty>` is the fallback branch of `<for>` and is valid nowhere else.',
  O1056: 'A `<for>` has at most one `<empty>` branch.',
  O1057: '`<empty>` takes no attributes: write `<empty>…</empty>`.',
  O1058: 'Move `<empty>` after every repeated child; it must be the last child of `<for>`.',
  O1059: '`<else-if>` and `<else>` are siblings of `<if>` — put them immediately after `</if>`.',
  O1060: 'Write `<else-if {cond}>…</else-if>` with a condition island.',
  O1061: 'Write `<else>…</else>`; `<else>` takes no condition.',
  O1062: 'Write `<if {cond}>…</if>` with a condition island.',
  O1063: 'Write `<for item of={list}>` (optionally `<for item, i of={list}>`).',
  O1064: 'Write `limit={12}` with a literal integer.',
  O1065: 'Finish the `<for>` tag with `>`; the only attributes are `of=` and `limit=`.',
  O1066: 'Write `<let name={expr}/>`.',
  O1067: '`<let>` is self-closing: `<let total={a + b}/>`.',
  O1068: 'Slot names are static strings: `<slot name="badge"/>`.',
  O1069: '`<slot>` is self-closing and has no fallback content.',
  O1070: '`<json-ld>` takes no attributes.',
  O1071: '`<json-ld>` wraps exactly one record expression: `<json-ld>{ … }</json-ld>`.',
  O1072: 'Wrap the component call in an element and put `slot=` on that element.',
  O1073: 'Finish the component tag with `>` or `/>`.',
  O1080: 'The element is banned for the stated reason — there is no flag to re-enable it.',
  O1081: 'Only allowlisted elements parse. Use a semantic element from the allowlist.',
  O1082: 'Only void elements self-close. Write `<tag>…</tag>`.',
  O1083: 'Finish the tag with `>` or `/>`.',
  O1084: 'Reduce the number of attributes on the element.',
  O1085: 'Remove the repeated attribute.',
  O1086: 'The attribute is banned for the stated reason (event handlers, `srcdoc`, `ping`, namespaced names, legacy URL attributes).',
  O1087: 'Use an allowlisted attribute, or a `data-*` / `aria-*` attribute for custom data.',
  O1088: 'Conditional attributes need a Bool island: `disabled?={isSoldOut}`.',
  O1089: 'Attribute values are double-quoted.',
  O1090: 'Write `name="text"` or `name={expr}`. Unquoted values are not accepted.',
  O1091: 'Component props take whole expressions: `title={product.title}`, not `title="a {x}"`.',
  O1092: 'Supply an attribute name.',
  O1096: 'The `on:name` or `@name` attribute form is RESERVED for a future version of Orbit and is not implemented. It is not banned on its merits like `onclick` — it is unclaimed syntax being claimed while that is still free. This version has no event bindings; client behaviour ships as platform runtime islands configured through data-* attributes.',
  O1093: 'Attribute names are lowercase.',
  O1094: 'Close the attribute value with `"`.',
  O1095: 'Interpolation in `style` is banned. Choose a class from a static set, or use a host `cssVar` helper.',
  O1096: '`slot=` is a static name: `slot="badge"`.',
  O1097: '`verbatim` is a bare marker attribute: `<pre verbatim>`.',
  O1098: 'Template names are the program-wide key — rename one of the two templates.',
  O1100: 'Split the template into components; the per-template node cap is structural.',
  O1101: 'Flatten the markup or extract a component; element nesting is capped.',
  O1102: 'Move the positional argument before the first `name:` one, or give it a name too.',
  O1103: 'The `on:` and `@` attribute forms are reserved. Behaviour ships as platform runtime islands configured through `data-*`.',
  O1104: 'Upgrade the engine, or change the `orbit` pragma if the version was a typo.',
  O1105: 'Write the version: `orbit 2026`.',
  O1106: 'Remove the second `orbit` line; a template declares one language version.',

  // -- O2xxx: signatures ------------------------------------------------------
  O2010: 'Remove the duplicate prop declaration.',
  O2011: 'Html is element-content-only: it can never be a prop type or a prop value.',
  O2012: 'Make the default literal match the declared prop type.',
  O2013: 'Remove the duplicate setting declaration.',
  O2014: 'Remove the duplicate slot declaration.',
  O2015: 'The default must be valid for the control (a string for `Text`, an option for `Select`, an in-range Int for `Range`, …).',
  O2016: 'Declare the type in the host `TypeRegistry`, or use a built-in (`Int`, `Float`, `String`, `Bool`, `Color`).',
  O2017: 'Pages are entry points, not callees. Move the data to `pageGlobals` in `CheckOptions`.',
  O2018: 'Swap the bounds: `Range(min, max)` with `min <= max`.',
  O2019: 'A `Range` step must be greater than zero.',
  O2020: 'Warning: the declared maximum is unreachable. Pick a step that divides the span, or adjust `max`.',

  // -- O2xxx: expressions -----------------------------------------------------
  O2030: 'The name is not in scope. Check spelling, or declare it as a prop / page global / `<let>`.',
  O2031: 'The object has no such field. Check the host `TypeRegistry` (or the record literal) for the real name.',
  O2032: 'The value has no properties. Lists use `size(list)` or a `<for>` loop.',
  O2033: 'Remove the duplicate record key.',
  O2034: 'List indices are Int.',
  O2035: 'Only lists can be indexed; there is no dynamic member access.',
  O2036: 'Unary `-` needs an Int or Float.',
  O2037: 'Arithmetic and ordering need numbers. Strings compose via interpolation: `{a}{b}`.',
  O2050: 'Range bounds are literal integers (`1..5`). Loop over a host-resolved list for dynamic counts.',
  O2051: 'Shorten the range; ranges are bounded at compile time.',
  O2060: 'Money is terminal: no operators, no equality, no properties, no stdlib filters. Pass it to a host money filter.',
  O2061: 'Image is an opaque handle. Pass it to a host image filter to obtain a Url.',
  O2062: 'MoneyText only renders — it admits no filters. Format it in the host filter instead.',
  O2063: 'Html cannot be a filter operand; it can only be interpolated into element content.',
  O2064: 'URL attributes take a `Url` or a `String`.',
  O2065: 'Warning: the value can never be `none`, so the comparison is constant. Drop it.',
  O2066: 'The two sides have no common comparable type. Compare precomputed flags from the host model.',
  O2070: 'No such filter. Check the stdlib reference and the host filter list.',
  O2071: 'Warning: this host filter is declared trustedHtml, so its output is emitted raw and unsanitized. The host asserts the input is trusted; verify that where the filter is DECLARED, not at this call site. A sanitizer or htmlTransform filter does not raise this.',
  O2072: 'Warning: the left of `??` is never `none` — the fallback is dead. Remove it.',
  O2073: 'Both branches must have a common type. Convert one side, or move the difference into the markup.',
  O2074: 'The value has no textual form. Project it into a printable primitive first.',
  O2075: 'Html cannot render inside `<title>` / `<textarea>`; those are RCDATA.',
  O2076: 'Html cannot appear in attributes.',
  O2077: '`<for>` iterates a List or a Range.',
  O2078: '`limit` is a literal Int within the engine loop cap.',
  O2079: 'Html cannot be bound with `<let>`; interpolate it directly into element content.',
  O2080: 'No such component in the program. Check the name and that the file is in the compiled set.',
  O2081: 'Pages cannot be called. Extract the markup into a component.',
  O2082: 'The component declares no such prop.',
  O2083: 'The argument type does not match the declared prop type.',
  O2084: 'Supply the required prop, or give it a default / optional type in the component.',
  O2085: 'Every element a control-flow wrapper can render must target the same slot. Split the wrapper.',
  O2086: 'The component declares no such slot. Add it to `slots { … }`, or use `<slot/>` for default content.',
  O2087: 'The slot is required — provide content for it with `slot="name"`.',
  O2088: '`<slot>` is only valid inside a component.',
  O2089: 'Declare the slot in frontmatter: `slots { name? }`.',
  O2090: '`<json-ld>` admits primitives, records and lists. Project host objects into a record first.',
  O2091: 'Break the cycle; the component graph must be acyclic (this is what makes rendering total).',
  O2092: '`?=` is the conditional-attribute form. Component props take `name={boolExpr}`.',
  O2093: 'Warning: the value is never `none`, so `?.` is redundant. Use plain `.`.',

  // -- O2xxx: filters ---------------------------------------------------------
  O2100: 'Wrong argument count — check the filter signature.',
  O2101: 'Wrong argument type — check the filter signature.',
  O2102: 'The argument must be a literal so the filter stays statically analyzable.',
  O2103: 'The field does not exist on the element type, or is not sortable.',
  O2104: 'THE OPTIONAL LAW: decide what happens when the value is absent. Use `{x ?? fallback}`, or narrow with `<if {x != none}>`.',
  O2105: 'No such named argument. Names bind to a host filter\'s optional parameters; stdlib filters take positional arguments only.',
  O2106: 'One parameter, two arguments. Drop the positional one, or drop the name.',

  // -- O3xxx: truthiness ------------------------------------------------------
  O3007: 'There is no truthiness. Write an explicit Bool: `{x != none}`, `{s != ""}`, `{n > 0}`.',

  // -- O4xxx: runtime budgets -------------------------------------------------
  O4001: 'The render exhausted its fuel (a byte budget). Emit less, or raise `fuel` in `RenderOptions`.',
  O4002: 'The render exceeded the global iteration budget. Lower loop limits, or raise `maxIterations`.',
  O4003: 'The render passed its wall-clock deadline. Usually a slow host filter; raise `deadlineMs` only if the work is legitimate.',
  O4004: 'The output exceeded `maxOutput`. Paginate the page, or raise the cap.',
  O4005: 'An intermediate string exceeded the per-value cap inside a filter chain.',
  O4006: 'An intermediate list exceeded the per-value cap inside a filter chain.',
  O4010: 'The AST references a binding the host did not supply. Check `bindings` / `props` against the access plan.',
  O4011: 'Property access on a value that is not a record. The host data does not match its declared type.',
  O4012: 'The host supplied `none` where a non-optional value was declared. Fix the data or declare the field `T?`.',
  O4013: 'Division or modulo by zero. Guard the denominator with `<if>`.',
  O4014: 'A structured value reached a text sink. The checker allows this only for `<invalid>` types — check the data shape.',
  O4015: 'Component nesting exceeded the depth cap. Flatten the composition.',
  O4016: 'The entry name is not in the loaded program.',
  O4020: 'A filter received a value of the wrong runtime shape — the host data contradicts its declared type.',
  O4021: '`formatDate` needs an ISO-8601 date string (`YYYY-MM-DD`, optionally `Thh:mm[:ss]`).',
  O4022: 'A conditional attribute evaluated to a non-Bool at runtime.',
  O4023: 'An Html value reached an attribute sink.',
  O4024: 'The `<for>` subject, or an indexed value, was not a list at runtime.',
  O4025: 'A condition evaluated to a non-Bool at runtime.',
  O4026: 'An arithmetic operand was not a number at runtime.',
  O4027: 'Unknown binary operator in the AST — only a hand-built AST can produce this.',
  O4028: 'The AST names a filter that is not registered for this render.',
  O4029: 'A non-finite number (NaN / Infinity) reached a text sink.',
  O4030: 'The json-ld value nests deeper than the cap. Flatten the record.',
  O4031: 'json-ld numbers must be finite.',
  O4032: 'Html values cannot appear in json-ld.',
  O4033: 'json-ld admits primitives, records and lists only.',
  O4034: 'Html cannot render inside `<title>` / `<textarea>`.',
  O4035: 'A host filter declared `Html` but returned a non-string. Fix the host implementation.',
  O4036: 'A host filter threw. Host filters must handle their own failures and return a value.',
  O4037: 'A URL was blocked by the sink under `urlPolicy: "error"`. Fix the data; the scheme is not allowlisted.',
  O4038: 'A prop supplied at a component entry is missing or has the wrong shape for its declared type.',
  O4039: 'A reserved property name (`__proto__`, `constructor`, `prototype`) can never be read from or written to data.',

  // -- O49xx: render warnings (non-fatal) -------------------------------------
  O4900: 'Warning: a URL was blocked at the sink and replaced with a placeholder. Set `urlPolicy: "error"` to fail instead.',
  O4901: 'Warning: a merchant setting value was invalid for its control; the declared default was used.',
  O4902: 'Warning: a trustedHtml host filter emitted raw Html at runtime. Sanitizer and htmlTransform output is silent, so this list is an audit surface rather than a census of every rich-text field.',
  O4903: 'Warning: a prop supplied at a component entry is not declared by the component and was ignored.',
  O4909: 'Warning: the per-render warning list hit its cap and was truncated.',

  // -- O5xxx: stored-AST re-validation ----------------------------------------
  O5000: 'Structural re-validation of a stored AST failed. The row is malformed or was not produced by this engine version; re-compile from source.',
  O5001: 'The stored AST has no `templates` record — the row is not an Orbit program.',
}));

/**
 * Codes that legitimately raise more than one message.
 *
 * One code, one MEANING — but a meaning can be worded differently at different
 * sites: `O1046` reports five ways a `Range(…)` control is malformed, `O4001`
 * names which budget ran out. That is fine, and the index prints every phrasing.
 *
 * What is NOT fine is a code quietly acquiring a SECOND meaning, which is how
 * `O1096` came to mean both "`slot=` must be static" and "`on:` is reserved".
 * Nothing in the generated index made that visible: both messages appeared
 * under one authored note, and the note only described one of them.
 *
 * So the set is pinned. A code that starts raising a second message fails the
 * build until someone either gives the new diagnostic its own code — the usual
 * answer — or adds it here on purpose.
 */
const MULTI_MESSAGE = new Set([
  'O1041', 'O1045', 'O1046', 'O1054', 'O1060', 'O1062', 'O1063', 'O1068',
  'O2011', 'O2015', 'O2031', 'O2037', 'O2060', 'O2061', 'O2074',
  'O2100', 'O2101', 'O2102', 'O2103', 'O2105',
  'O3007',
  'O4001', 'O4011', 'O4013', 'O4016', 'O4020', 'O4024', 'O4025', 'O4026',
  'O4038', 'O4039',
]);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const CODE_RE = /'(O\d{4})'/g;

/**
 * Read the string literal starting at `i`, or `undefined` if there is none.
 *
 * Hand-written rather than a regex because template literals nest: the engine
 * raises messages like `` `${a} takes ${x ? `${m}–${n}` : ''} args` ``, and a
 * regex for a backtick literal stops at the first INNER backtick, silently
 * truncating the message.
 */
function readLiteralAt(text, i) {
  const quote = text[i];
  if (quote !== '`' && quote !== "'" && quote !== '"') return undefined;
  let j = i + 1;
  if (quote !== '`') {
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') return undefined;
      if (c === quote) return { literal: text.slice(i, j + 1), end: j + 1 };
      j += 1;
    }
    return undefined;
  }
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') return { literal: text.slice(i, j + 1), end: j + 1 };
    if (c === '$' && text[j + 1] === '{') {
      j = skipBraced(text, j + 1);
      continue;
    }
    j += 1;
  }
  return undefined;
}

/** Skip a `{ … }` group starting at `i`, stepping over nested literals. */
function skipBraced(text, i) {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`' || c === "'" || c === '"') {
      const nested = readLiteralAt(text, j);
      if (nested === undefined) return j + 1;
      j = nested.end;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return j;
}

/** Source files that can raise diagnostics (tests and helpers excluded). */
function engineSources() {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.helper.ts'))
    .sort()
    .map((f) => ({ rel: `src/${f}`, abs: path.join(SRC_DIR, f) }));
}

/**
 * Replace every `${…}` interpolation with a single ellipsis. Brace-balanced by
 * hand because interpolations nest arbitrarily (`${a ? `x ${b}` : ''}`), which
 * no regex can match.
 */
function stripInterpolations(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\') {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (s[i] === '$' && s[i + 1] === '{') {
      i = skipBraced(s, i + 1);
      out += '…';
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/** Strip the quotes and normalize `${…}` interpolations to a single ellipsis. */
function normalizeMessage(literal) {
  let s = stripInterpolations(literal.slice(1, -1));
  s = s.replace(/\\`/g, '`').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  s = s.replace(/\\n/g, ' ').replace(/\s+/g, ' ');
  s = s.replace(/…(\s*…)+/g, '…');
  return s.trim();
}

/** 1-based line number of `index` within `text`. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Find the message literal that belongs to a code literal at `end`.
 *
 * Two shapes occur in the engine: a positional call (`fail('O1010', "msg")`)
 * and a diagnostic object (`{ code: 'O1100', severity: 'error', message: … }`).
 * The window is bounded so a following, unrelated string cannot be captured.
 */
function messageFor(text, end) {
  const window = text.slice(end, end + 600);
  // Diagnostic-object form: `{ code: 'X', severity: 'error', message: … }`.
  // Checked first because it ALSO looks like the positional form — the next
  // literal after the code is `'error'`, not the message.
  const objectForm = /^\s*,\s*severity:/.test(window);
  if (!objectForm) {
    const comma = /^\s*,\s*/.exec(window);
    if (comma !== null) {
      const found = readLiteralAt(window, comma[0].length);
      if (found !== undefined) return normalizeMessage(found.literal);
    }
  }
  const field = /message:\s*/.exec(window);
  if (field !== null) {
    const found = readLiteralAt(window, field.index + field[0].length);
    if (found !== undefined) return normalizeMessage(found.literal);
  }
  return undefined;
}

function collect() {
  /** @type {Map<string, {code: string, messages: string[], sites: string[]}>} */
  const byCode = new Map();
  for (const file of engineSources()) {
    const text = readFileSync(file.abs, 'utf8');
    CODE_RE.lastIndex = 0;
    let m;
    while ((m = CODE_RE.exec(text)) !== null) {
      const code = m[1];
      const entry = byCode.get(code) ?? { code, messages: [], sites: [] };
      const message = messageFor(text, m.index + m[0].length);
      if (message !== undefined && !entry.messages.includes(message)) entry.messages.push(message);
      const site = `${file.rel}:${lineAt(text, m.index)}`;
      if (!entry.sites.includes(site)) entry.sites.push(site);
      byCode.set(code, entry);
    }
  }
  return [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SECTIONS = [
  {
    prefix: 'O1',
    title: 'O1xxx — lexer and parser',
    blurb:
      'Raised before any type exists: syntax, the element and attribute allowlists, and the structural caps. ' +
      'Parsing stops at the first of these, so a template with a syntax error yields exactly one diagnostic.',
  },
  {
    prefix: 'O2',
    title: 'O2xxx — checker: signatures, types, contracts, filters',
    blurb:
      'Raised by `check()`. The checker never throws and never stops early: it returns every diagnostic it found, ' +
      'each with a span and, where one can be computed, a fix-it suggestion.',
  },
  {
    prefix: 'O3',
    title: 'O3xxx — checker: the truthiness rule',
    blurb: 'Its own range because it is the rule newcomers hit first, and the one that never bends.',
  },
  {
    prefix: 'O4',
    title: 'O4xxx — interpreter and escaping (runtime)',
    blurb:
      'Raised during `render()`. Every one of these FAILS the render — a partial page is never returned. ' +
      'The O49xx sub-range is different: those are non-fatal `RenderWarning`s returned alongside a successful render.',
  },
  {
    prefix: 'O5',
    title: 'O5xxx — stored-AST re-validation',
    blurb: 'Raised by `loadCheckedAst(data, { trust: "verify" })` when a stored AST row fails structural re-validation.',
  },
];

function escapeCell(s) {
  return s.replace(/\|/g, '\\|');
}

function render(entries, notesReport) {
  const lines = [];
  lines.push('# Error code index');
  lines.push('');
  lines.push(
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Produced by scripts/gen-error-index.mjs from the diagnostic code literals in src/.',
    '     Regenerate:  node scripts/gen-error-index.mjs',
    '     Verify:      node scripts/gen-error-index.mjs --check  -->',
  );
  lines.push('');
  lines.push(
    'Every Orbit diagnostic carries a stable code. Codes mean exactly one thing and are never recycled: ' +
      'a code that disappears from the engine is retired, not reused. This index is generated from the engine ' +
      'source, so it cannot drift from what the code actually raises.',
  );
  lines.push('');
  lines.push('| range | phase |');
  lines.push('| --- | --- |');
  lines.push('| `O1xxx` | lexer + parser — syntax, allowlists, structural caps |');
  lines.push('| `O2xxx` | checker — signatures, types, contracts, filters |');
  lines.push('| `O3xxx` | checker — the truthiness rule |');
  lines.push('| `O4xxx` | interpreter + escaping (runtime); `O49xx` are non-fatal warnings |');
  lines.push('| `O5xxx` | stored-AST re-validation on load |');
  lines.push('');
  lines.push(
    'The **message** column is the engine\'s own text with runtime interpolations shown as `…`. ' +
      'The **what to do** column is authored guidance, maintained in `scripts/gen-error-index.mjs`.',
  );
  lines.push('');
  lines.push(`Total codes: **${entries.length}**.`);
  lines.push('');

  for (const section of SECTIONS) {
    const rows = entries.filter((e) => e.code.startsWith(section.prefix));
    if (rows.length === 0) continue;
    lines.push(`## ${section.title}`);
    lines.push('');
    lines.push(section.blurb);
    lines.push('');
    lines.push('| code | message | what to do | raised in |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of rows) {
      const message = row.messages[0] ?? '(message is constructed at the call site)';
      const note = NOTES.get(row.code) ?? '';
      const sites = row.sites.length === 1 ? row.sites[0] : `${row.sites[0]} (+${row.sites.length - 1} more)`;
      lines.push(
        `| \`${row.code}\` | ${escapeCell(message)} | ${escapeCell(note)} | \`${escapeCell(sites)}\` |`,
      );
    }
    lines.push('');
  }

  if (notesReport.missing.length > 0) {
    lines.push('## Codes without authored guidance');
    lines.push('');
    lines.push('These codes exist in the engine but have no entry in the generator\'s notes table:');
    lines.push('');
    for (const code of notesReport.missing) lines.push(`- \`${code}\``);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const check = argv.includes('--check');
  const toStdout = argv.includes('--stdout');
  const quiet = argv.includes('--quiet');

  const entries = collect();
  if (entries.length === 0) {
    console.error('gen-error-index: found no diagnostic codes in src/ — refusing to write an empty index');
    return 1;
  }

  const known = new Set(entries.map((e) => e.code));
  const missing = entries.filter((e) => !NOTES.has(e.code)).map((e) => e.code);
  const stale = [...NOTES.keys()].filter((code) => !known.has(code));

  const newlyShared = entries.filter((e) => e.messages.length > 1 && !MULTI_MESSAGE.has(e.code));
  if (newlyShared.length > 0) {
    console.error(
      `gen-error-index: ${newlyShared.length} code(s) raise more than one message but are not in MULTI_MESSAGE:`,
    );
    for (const e of newlyShared) {
      console.error(`  ${e.code}  (${e.sites.join(', ')})`);
      for (const m of e.messages) console.error(`      - ${m}`);
    }
    console.error('  give the new diagnostic its own code, or add this one to MULTI_MESSAGE deliberately');
    return 1;
  }
  const noLongerShared = [...MULTI_MESSAGE].filter(
    (code) => !entries.some((e) => e.code === code && e.messages.length > 1),
  );
  if (noLongerShared.length > 0) {
    console.error(
      `gen-error-index: MULTI_MESSAGE lists ${noLongerShared.length} code(s) that no longer share: ${noLongerShared.join(', ')}`,
    );
    return 1;
  }

  if (stale.length > 0) {
    console.error(
      `gen-error-index: notes exist for ${stale.length} code(s) the engine no longer raises: ${stale.join(', ')}`,
    );
    console.error('  remove them from NOTES in scripts/gen-error-index.mjs (codes are retired, never reused)');
    return 1;
  }
  if (missing.length > 0 && !quiet) {
    console.error(`gen-error-index: ${missing.length} code(s) have no authored guidance: ${missing.join(', ')}`);
  }

  const output = render(entries, { missing });

  if (toStdout) {
    process.stdout.write(output);
    return 0;
  }

  if (check) {
    if (!existsSync(OUT_ABS)) {
      console.error(`gen-error-index: ${OUT_REL} does not exist — run: node scripts/gen-error-index.mjs`);
      return 1;
    }
    const current = readFileSync(OUT_ABS, 'utf8');
    if (current !== output) {
      console.error(`gen-error-index: ${OUT_REL} is STALE — run: node scripts/gen-error-index.mjs`);
      return 1;
    }
    if (!quiet) console.log(`gen-error-index: ${OUT_REL} is up to date (${entries.length} codes)`);
    return 0;
  }

  mkdirSync(path.dirname(OUT_ABS), { recursive: true });
  writeFileSync(OUT_ABS, output, 'utf8');
  if (!quiet) console.log(`gen-error-index: wrote ${OUT_REL} (${entries.length} codes)`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
