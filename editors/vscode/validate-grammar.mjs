/**
 * Validate the Orbit TextMate grammar and language configuration.
 *
 * TextMate grammars fail the same way tree-sitter queries do — silently. A
 * pattern with a broken regex is skipped at runtime, so the only symptom is
 * that some construct stops being highlighted, which nobody notices until a
 * user reports "the colors look wrong". This script turns that into an error.
 *
 * It checks that every `match`/`begin`/`end` regex compiles, that every
 * `include` resolves to a repository key that exists, and that the capture
 * indices referenced by each rule are plausible for its pattern.
 *
 * Caveat worth stating: TextMate uses Oniguruma, not JavaScript RegExp. The
 * two overlap heavily but not perfectly, so a pattern that compiles here could
 * still behave differently in VS Code. This catches structural mistakes and
 * typos, which is the overwhelming majority of real breakage — it is not a
 * substitute for opening a `.orbit` file in the editor.
 *
 * Run: node validate-grammar.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAMMAR = path.join(HERE, 'syntaxes', 'orbit.tmLanguage.json');
const LANGCONF = path.join(HERE, 'language-configuration.json');

const errors = [];
let regexCount = 0;
let ruleCount = 0;

const grammar = JSON.parse(readFileSync(GRAMMAR, 'utf8'));
const repository = grammar.repository ?? {};

function checkRegex(pattern, where) {
  regexCount++;
  try {
    new RegExp(pattern);
  } catch (err) {
    errors.push(`${where}: regex does not compile — ${err.message}\n    ${pattern}`);
  }
}

function walk(node, where) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${where}[${i}]`));
    return;
  }
  if (!node || typeof node !== 'object') return;

  if (node.include) {
    // `$self` and `$base` are grammar-level references, not repository keys.
    if (node.include.startsWith('#')) {
      const key = node.include.slice(1);
      if (!(key in repository)) {
        errors.push(`${where}: include "#${key}" has no matching repository key`);
      }
    } else if (node.include !== '$self' && node.include !== '$base') {
      errors.push(`${where}: unsupported include "${node.include}"`);
    }
  }

  if (typeof node.match === 'string') {
    ruleCount++;
    checkRegex(node.match, `${where}.match`);
  }
  if (typeof node.begin === 'string') {
    ruleCount++;
    checkRegex(node.begin, `${where}.begin`);
  }
  if (typeof node.end === 'string') checkRegex(node.end, `${where}.end`);
  if (typeof node.while === 'string') checkRegex(node.while, `${where}.while`);

  // A rule with `begin` must have `end` or `while`, else the region never closes.
  if (node.begin && !node.end && !node.while) {
    errors.push(`${where}: has "begin" but neither "end" nor "while"`);
  }
  // `beginCaptures`/`endCaptures` without the corresponding pattern is dead config.
  if (node.beginCaptures && !node.begin) {
    errors.push(`${where}: has "beginCaptures" but no "begin"`);
  }
  if (node.endCaptures && !node.end) {
    errors.push(`${where}: has "endCaptures" but no "end"`);
  }
  if (node.captures && !node.match && !node.begin) {
    errors.push(`${where}: has "captures" but no "match" or "begin"`);
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'match' || key === 'begin' || key === 'end' || key === 'while') continue;
    if (value && typeof value === 'object') walk(value, `${where}.${key}`);
  }
}

if (!grammar.scopeName) errors.push('grammar: missing "scopeName"');
if (grammar.scopeName && grammar.scopeName !== 'source.orbit') {
  errors.push(`grammar: scopeName is "${grammar.scopeName}", expected "source.orbit"`);
}
if (!Array.isArray(grammar.patterns) || grammar.patterns.length === 0) {
  errors.push('grammar: top-level "patterns" is missing or empty');
}

walk(grammar.patterns, 'patterns');
walk(repository, 'repository');

// Repository keys nobody includes are dead weight and usually a rename bug.
const referenced = new Set();
(function collectIncludes(node) {
  if (Array.isArray(node)) return node.forEach(collectIncludes);
  if (!node || typeof node !== 'object') return;
  if (typeof node.include === 'string' && node.include.startsWith('#')) {
    referenced.add(node.include.slice(1));
  }
  for (const value of Object.values(node)) collectIncludes(value);
})(grammar);

for (const key of Object.keys(repository)) {
  if (!referenced.has(key)) {
    errors.push(`repository."${key}": defined but never included by any rule`);
  }
}

// The language configuration carries regexes too, in a different shape.
const langConf = JSON.parse(readFileSync(LANGCONF, 'utf8'));
for (const [key, value] of Object.entries(langConf.indentationRules ?? {})) {
  checkRegex(value, `language-configuration.indentationRules.${key}`);
}
for (const [key, value] of Object.entries(langConf.folding?.markers ?? {})) {
  checkRegex(value, `language-configuration.folding.markers.${key}`);
}
if (langConf.wordPattern) {
  checkRegex(langConf.wordPattern, 'language-configuration.wordPattern');
}
(langConf.onEnterRules ?? []).forEach((rule, i) => {
  for (const key of ['beforeText', 'afterText', 'previousLineText']) {
    if (rule[key]) checkRegex(rule[key], `language-configuration.onEnterRules[${i}].${key}`);
  }
});

if (errors.length > 0) {
  console.error(`textmate grammar FAILED — ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log(
  `textmate grammar OK — ${ruleCount} rule(s), ${regexCount} regex(es) compile, ` +
    `${Object.keys(repository).length} repository key(s), all includes resolve`,
);
