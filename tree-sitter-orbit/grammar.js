/**
 * tree-sitter grammar for Orbit (@orbitlang/core).
 *
 * DERIVED FROM THE ENGINE, NOT INVENTED. Every rule below mirrors a concrete
 * code path in the reference implementation:
 *
 *   src/lexer.ts      — expression-island tokens (string escapes, #rrggbb,
 *                       `1..5` vs `1.5` number splitting)
 *   src/tokens.ts     — PUNCTUATORS (longest-first)
 *   src/parser.ts     — TemplateParser (markup), ExprParser (precedence table)
 *   src/allowlists.ts — closed element / void / RCDATA / banned tables
 *
 * Regex is used freely here: the "no regex" invariant applies to `src/` in the
 * engine package only. This is external tooling.
 *
 * PRECEDENCE (src/parser.ts, loosest first). Note `|>` is the LOOSEST
 * COMPUTATION operator as of v0.2 — looser than arithmetic AND comparison, so
 * `a + b |> round` is `(a + b) |> round`.
 *
 *   1.  ?:            ternary            (right associative)
 *   2.  ??            coalesce
 *   3.  |>            pipe
 *   4.  ||            logical or
 *   5.  &&            logical and
 *   6.  == !=         equality
 *   7.  < <= > >=     comparison
 *   8.  ..            range
 *   9.  + -           additive
 *  10.  * / %         multiplicative
 *  11.  ! -           unary prefix       (right associative)
 *  12.  . ?. [] ()    postfix
 *
 * KNOWN DEVIATIONS (documented in README.md):
 *  - open/close tag names are not checked for equality (needs an external
 *    scanner); `<div></span>` parses here but is O1052 in the engine.
 *  - `verbatim` / `<pre>` subtrees still highlight `{...}` as interpolation.
 *  - a setting literally named `label` is mis-lexed as the `label "..."` clause.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
  ternary: 1,
  coalesce: 2,
  pipe: 3,
  or: 4,
  and: 5,
  equality: 6,
  comparison: 7,
  range: 8,
  additive: 9,
  multiplicative: 10,
  unary: 11,
  postfix: 12,
};

/** src/allowlists.ts VOID_ELEMENTS */
const VOID_ELEMENTS = ['br', 'col', 'hr', 'img', 'input', 'source', 'track', 'wbr'];

/** src/allowlists.ts RCDATA_ELEMENTS */
const RCDATA_ELEMENTS = ['title', 'textarea'];

/** src/allowlists.ts BANNED_ELEMENTS (rejected with a dedicated reason) */
const BANNED_ELEMENTS = [
  'script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link',
  'template', 'noscript', 'svg', 'math', 'frame', 'frameset', 'applet', 'portal',
];

/** src/allowlists.ts ELEMENT_ALLOWLIST minus the void and RCDATA sets. */
const NORMAL_ELEMENTS = [
  'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo',
  'blockquote', 'button', 'caption', 'cite', 'code', 'colgroup', 'data',
  'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'header', 'hgroup', 'i', 'ins', 'kbd', 'label', 'legend', 'li',
  'main', 'mark', 'menu', 'meter', 'nav', 'ol', 'optgroup', 'option', 'output',
  'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'section', 'select', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul',
  'var', 'video',
];

/** Build an immediate, precedence-tagged keyword-set token. */
function tagToken(names, precedence) {
  return token.immediate(prec(precedence, choice(...names)));
}

module.exports = grammar({
  name: 'orbit',

  extras: () => [/\s+/],

  conflicts: ($) => [
    // `</if>` followed by `<` — reduce `if_statement` or shift toward
    // `<else-if>` / `<else>`? Resolved one token later (GLR).
    [$.if_statement],
  ],

  rules: {
    // Frontmatter is MANDATORY — src/parser.ts fails with O1030 ("every
    // template starts with a frontmatter header") when `---` is missing. Only
    // whitespace and `{# #}` comments may precede it (skipLeadingTrivia), and
    // notably NOT `<!-- -->`. Marking it optional here would also make the
    // grammar ambiguous: `comment` is reachable both from this leading repeat
    // and from `_node`, and with nothing mandatory in between the parser
    // cannot decide which one a leading comment belongs to.
    source_file: ($) => seq(repeat($.comment), $.frontmatter, repeat($._node)),

    // -----------------------------------------------------------------------
    // Comments — src/parser.ts skipComment / skipHtmlComment
    //
    // Deliberately NOT in `extras`: the engine only skips comments at node
    // level, and treating `{#` as a comment everywhere would swallow
    // `color={#ff0000}` (a legal color island) up to the next `#}`.
    // -----------------------------------------------------------------------

    comment: () => token(seq('{#', /[^#]*#+([^}#][^#]*#+)*/, '}')),

    html_comment: () => token(seq('<!--', /[^-]*-+([^->][^-]*-+)*/, '>')),

    // -----------------------------------------------------------------------
    // Frontmatter — src/parser.ts parseFrontmatter
    // -----------------------------------------------------------------------

    frontmatter: ($) =>
      seq(
        alias('---', $.frontmatter_fence),
        repeat(
          choice(
            $.language_version,
            $.template_declaration,
            $.props_block,
            $.settings_block,
            $.slots_block,
          ),
        ),
        alias('---', $.frontmatter_fence),
      ),

    /**
     * `orbit 2026` pins the LANGUAGE version (src/parser.ts, O1104–O1106).
     *
     * The version is matched as digits rather than as one of the known values:
     * this grammar highlights, it does not decide which versions an engine
     * implements, and a template pinning a version this checkout has never
     * heard of should still colour correctly.
     */
    language_version: ($) => seq('orbit', field('version', alias(/[0-9]+/, $.version_number))),

    template_declaration: ($) =>
      seq(
        choice('component', 'page'),
        field('name', alias($._bare_identifier, $.template_name)),
      ),

    props_block: ($) =>
      seq('props', '{', repeat(choice($.prop_declaration, ',')), '}'),

    settings_block: ($) =>
      seq('settings', '{', repeat(choice($.setting_declaration, ',')), '}'),

    slots_block: ($) =>
      seq('slots', '{', repeat(choice($.slot_declaration, ',')), '}'),

    prop_declaration: ($) =>
      seq(
        field('name', alias($._bare_identifier, $.prop_name)),
        ':',
        field('type', $._type_expression),
        optional(seq('=', field('default', $._literal))),
      ),

    _type_expression: ($) =>
      choice($.type_identifier, $.list_type, $.optional_type),

    list_type: ($) => seq('List', '<', field('element', $._type_expression), '>'),

    optional_type: ($) =>
      prec.left(seq(choice($.type_identifier, $.list_type, $.optional_type), '?')),

    type_identifier: () => /[A-Za-z_][A-Za-z0-9_]*/,

    setting_declaration: ($) =>
      seq(
        field('name', alias($._bare_identifier, $.setting_name)),
        ':',
        field('control', $._setting_control),
        '=',
        field('default', $._literal),
        optional($.setting_label),
      ),

    _setting_control: ($) =>
      choice('Text', 'Toggle', 'Color', $.select_control, $.range_control),

    select_control: ($) =>
      seq('Select', '(', $.string_literal, repeat(seq(',', $.string_literal)), ')'),

    range_control: ($) =>
      seq('Range', '(', $._range_argument, repeat(seq(',', $._range_argument)), ')'),

    _range_argument: ($) =>
      choice($._integer_literal, seq('step', ':', $._integer_literal)),

    _integer_literal: ($) => choice($.integer, $.negative_number),

    setting_label: ($) => seq('label', $.string_literal),

    slot_declaration: ($) =>
      seq(field('name', alias($._bare_identifier, $.slot_name)), optional('?')),

    _bare_identifier: () => /[A-Za-z_][A-Za-z0-9_]*/,

    // Frontmatter defaults are literals only (src/parser.ts parseLiteral).
    _literal: ($) =>
      choice(
        $.string_literal,
        $.color,
        $.boolean,
        $.none,
        $.integer,
        $.float,
        $.negative_number,
      ),

    negative_number: ($) => seq('-', choice($.integer, $.float)),

    // -----------------------------------------------------------------------
    // Markup body — src/parser.ts parseNodes
    // -----------------------------------------------------------------------

    _node: ($) =>
      choice(
        $.comment,
        $.html_comment,
        $.interpolation,
        $.if_statement,
        $.for_statement,
        $.match_statement,
        $.let_element,
        $.slot_element,
        $.json_ld_element,
        $.component_element,
        $.component_self_closing_element,
        $.void_element,
        $.rcdata_element,
        $.element,
        $.text,
      ),

    // Non-whitespace-anchored so inter-tag whitespace stays out of the tree.
    text: () => /[^<{\s]([^<{]*[^<{\s])?/,

    // -----------------------------------------------------------------------
    // Elements
    // -----------------------------------------------------------------------

    element: ($) => seq($.start_tag, repeat($._node), $.end_tag),

    start_tag: ($) => seq('<', $._element_tag_name, repeat($.attribute), '>'),

    end_tag: ($) => seq('</', $._element_tag_name, '>'),

    _element_tag_name: ($) =>
      choice($.tag_name, $.banned_tag_name, $.unknown_tag_name),

    tag_name: () => tagToken(NORMAL_ELEMENTS, 2),

    banned_tag_name: () => tagToken(BANNED_ELEMENTS, 2),

    /** Not in the closed allowlist — O1081 in the engine. */
    unknown_tag_name: () => token.immediate(prec(0, /[a-z][a-zA-Z0-9_]*(-[a-zA-Z0-9_]+)*/)),

    void_element: ($) =>
      seq('<', $.void_tag_name, repeat($.attribute), choice('>', '/>')),

    void_tag_name: () => tagToken(VOID_ELEMENTS, 2),

    /** `<title>` / `<textarea>`: text + interpolation only, whitespace exact. */
    rcdata_element: ($) =>
      seq(
        $.rcdata_start_tag,
        repeat(choice($.rcdata_text, $.interpolation, $.comment)),
        $.rcdata_end_tag,
      ),

    rcdata_start_tag: ($) => seq('<', $.rcdata_tag_name, repeat($.attribute), '>'),

    rcdata_end_tag: ($) => seq('</', $.rcdata_tag_name, '>'),

    rcdata_tag_name: () => tagToken(RCDATA_ELEMENTS, 2),

    rcdata_text: () =>
      token(prec(-1, repeat1(choice(/[^<{]/, seq('<', /[^/<{]/))))),

    // -----------------------------------------------------------------------
    // Component calls — PascalCase tags (src/parser.ts parseComponent)
    // -----------------------------------------------------------------------

    component_element: ($) =>
      seq($.component_start_tag, repeat($._node), $.component_end_tag),

    component_start_tag: ($) =>
      seq('<', $.component_name, repeat($.attribute), '>'),

    component_end_tag: ($) => seq('</', $.component_name, '>'),

    component_self_closing_element: ($) =>
      seq('<', $.component_name, repeat($.attribute), '/>'),

    component_name: () => token.immediate(prec(1, /[A-Z][A-Za-z0-9_]*(-[A-Za-z0-9_]+)*/)),

    // -----------------------------------------------------------------------
    // Attributes — src/parser.ts parseAttrs (four value forms)
    // -----------------------------------------------------------------------

    attribute: ($) =>
      choice(
        // name?={expr} — conditional attribute
        seq(
          field('name', $.attribute_name),
          '?=',
          field('value', alias($.interpolation, $.expression_value)),
        ),
        // name={expr} — whole-attribute expression
        seq(
          field('name', $.attribute_name),
          '=',
          field('value', alias($.interpolation, $.expression_value)),
        ),
        // name="text {expr} text" — quoted value with islands
        seq(field('name', $.attribute_name), '=', field('value', $.quoted_attribute_value)),
        // name — bare flag / bare component prop (true)
        field('name', $.attribute_name),
      ),

    // Elements allow `-` and `:` (the engine rejects `:` with O1086 later);
    // component props are plain identifiers.
    attribute_name: () => /[A-Za-z_][A-Za-z0-9_:-]*/,

    quoted_attribute_value: ($) =>
      seq('"', repeat(choice($.attribute_text, $.interpolation)), token.immediate('"')),

    attribute_text: () => token.immediate(prec(1, /[^"{]+/)),

    // -----------------------------------------------------------------------
    // Control flow — src/parser.ts parseIf / mergeElseSiblings / parseFor
    //
    // `<else-if>` and `<else>` are SIBLING tags in the source; they are grouped
    // into `if_statement` here exactly the way mergeElseSiblings groups them.
    // -----------------------------------------------------------------------

    if_statement: ($) =>
      seq($.if_block, repeat($.else_if_block), optional($.else_block)),

    if_block: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'if')), $.tag_name),
        field('condition', alias($.interpolation, $.condition)),
        '>',
        repeat($._node),
        '</',
        alias(token.immediate(prec(3, 'if')), $.tag_name),
        '>',
      ),

    else_if_block: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'else-if')), $.tag_name),
        field('condition', alias($.interpolation, $.condition)),
        '>',
        repeat($._node),
        '</',
        alias(token.immediate(prec(3, 'else-if')), $.tag_name),
        '>',
      ),

    else_block: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'else')), $.tag_name),
        '>',
        repeat($._node),
        '</',
        alias(token.immediate(prec(3, 'else')), $.tag_name),
        '>',
      ),

    /*
     * `<match {expr}>` with `<case>` arms and nothing else between them.
     *
     * Comments are in `extras`, so they need no mention here; anything else
     * between the arms is an ERROR node, which matches src/parser.ts (O1108)
     * and keeps a stray `<p>` from silently reparenting the arms around it.
     */
    match_statement: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'match')), $.tag_name),
        field('subject', alias($.interpolation, $.expression_value)),
        '>',
        repeat($.case_block),
        '</',
        alias(token.immediate(prec(3, 'match')), $.tag_name),
        '>',
      ),

    case_block: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'case')), $.tag_name),
        field('value', choice($.string_literal, alias('default', $.default_case))),
        '>',
        repeat($._node),
        '</',
        alias(token.immediate(prec(3, 'case')), $.tag_name),
        '>',
      ),

    for_statement: ($) =>
      seq(
        $.for_start_tag,
        repeat($._node),
        optional($.empty_block),
        '</',
        alias(token.immediate(prec(3, 'for')), $.tag_name),
        '>',
      ),

    for_start_tag: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'for')), $.tag_name),
        field('item', alias($._bare_identifier, $.loop_variable)),
        optional(seq(',', field('index', alias($._bare_identifier, $.loop_index)))),
        'of',
        '=',
        field('subject', alias($.interpolation, $.expression_value)),
        optional(
          seq('limit', '=', field('limit', alias($.interpolation, $.expression_value))),
        ),
        '>',
      ),

    /** Only valid as the LAST child of `<for>` (O1055 / O1058). */
    empty_block: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'empty')), $.tag_name),
        '>',
        repeat($._node),
        '</',
        alias(token.immediate(prec(3, 'empty')), $.tag_name),
        '>',
      ),

    let_element: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'let')), $.tag_name),
        field('name', alias($._bare_identifier, $.binding_name)),
        '=',
        field('value', alias($.interpolation, $.expression_value)),
        '/>',
      ),

    slot_element: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'slot')), $.tag_name),
        optional(seq('name', '=', field('name', $.slot_name_value))),
        '/>',
      ),

    /** Slot names are static text, not an island (O1068). */
    slot_name_value: () => token(seq('"', /[^"]*/, '"')),

    json_ld_element: ($) =>
      seq(
        '<',
        alias(token.immediate(prec(3, 'json-ld')), $.tag_name),
        '>',
        field('value', alias($.interpolation, $.expression_value)),
        '</',
        alias(token.immediate(prec(3, 'json-ld')), $.tag_name),
        '>',
      ),

    // -----------------------------------------------------------------------
    // Expression islands — src/lexer.ts lexExpression + src/parser.ts ExprParser
    // -----------------------------------------------------------------------

    interpolation: ($) => seq('{', $._expression, '}'),

    _expression: ($) =>
      choice(
        $.identifier,
        $.integer,
        $.float,
        $.string_literal,
        $.boolean,
        $.none,
        $.color,
        $.list_literal,
        $.record_literal,
        $.parenthesized_expression,
        $.member_expression,
        $.index_expression,
        $.call_expression,
        $.pipe_expression,
        $.unary_expression,
        $.binary_expression,
        $.range_expression,
        $.coalesce_expression,
        $.conditional_expression,
      ),

    parenthesized_expression: ($) => seq('(', $._expression, ')'),

    list_literal: ($) =>
      seq('[', optional(seq($._expression, repeat(seq(',', $._expression)))), ']'),

    record_literal: ($) =>
      seq('{', optional(seq($.record_field, repeat(seq(',', $.record_field)))), '}'),

    record_field: ($) =>
      seq(
        field('key', choice(alias($.identifier, $.record_key), $.string_literal)),
        ':',
        field('value', $._expression),
      ),

    member_expression: ($) =>
      prec.left(
        PREC.postfix,
        seq(
          field('object', $._expression),
          field('operator', choice('.', '?.')),
          field('property', $.property_identifier),
        ),
      ),

    index_expression: ($) =>
      prec.left(
        PREC.postfix,
        seq(field('object', $._expression), '[', field('index', $._expression), ']'),
      ),

    /** Callee is a bare name only — method calls are O1016. */
    call_expression: ($) =>
      prec.left(
        PREC.postfix,
        seq(field('function', alias($.identifier, $.function_name)), $.arguments),
      ),

    /**
     * `|>` binds looser than arithmetic and comparison (v0.2). The right side
     * is a FILTER NAME with optional arguments, never a full expression.
     */
    pipe_expression: ($) =>
      prec.left(
        PREC.pipe,
        seq(
          field('value', $._expression),
          '|>',
          field('filter', alias($.identifier, $.filter_name)),
          optional($.arguments),
        ),
      ),

    /*
     * Positional arguments first, then named ones. The grammar permits any
     * order and leaves "no positional after a named one" to the parser (O1102)
     * so a file mid-edit still produces a usable tree instead of collapsing to
     * ERROR — highlighting has to survive states the compiler rejects.
     */
    arguments: ($) => seq('(', optional(seq($._argument, repeat(seq(',', $._argument)))), ')'),

    _argument: ($) => choice($.named_argument, $._expression),

    named_argument: ($) =>
      seq(field('name', alias($.identifier, $.argument_name)), ':', field('value', $._expression)),

    unary_expression: ($) =>
      prec.right(
        PREC.unary,
        seq(field('operator', choice('!', '-')), field('operand', $._expression)),
      ),

    binary_expression: ($) => {
      const table = [
        [PREC.or, '||'],
        [PREC.and, '&&'],
        [PREC.equality, '=='],
        [PREC.equality, '!='],
        [PREC.comparison, '<'],
        [PREC.comparison, '<='],
        [PREC.comparison, '>'],
        [PREC.comparison, '>='],
        [PREC.additive, '+'],
        [PREC.additive, '-'],
        [PREC.multiplicative, '*'],
        [PREC.multiplicative, '/'],
        [PREC.multiplicative, '%'],
      ];
      return choice(
        ...table.map(([precedence, operator]) =>
          prec.left(
            precedence,
            seq(
              field('left', $._expression),
              field('operator', operator),
              field('right', $._expression),
            ),
          ),
        ),
      );
    },

    range_expression: ($) =>
      prec.left(
        PREC.range,
        seq(field('start', $._expression), '..', field('end', $._expression)),
      ),

    coalesce_expression: ($) =>
      prec.left(
        PREC.coalesce,
        seq(field('left', $._expression), '??', field('right', $._expression)),
      ),

    conditional_expression: ($) =>
      prec.right(
        PREC.ternary,
        seq(
          field('condition', $._expression),
          '?',
          field('consequence', $._expression),
          ':',
          field('alternative', $._expression),
        ),
      ),

    // -- expression terminals -------------------------------------------------

    identifier: () => /[A-Za-z_][A-Za-z0-9_]*/,

    property_identifier: () => /[A-Za-z_][A-Za-z0-9_]*/,

    boolean: () => choice('true', 'false'),

    none: () => 'none',

    /** Exactly `#rrggbb` (O1008). */
    color: () => /#[0-9a-fA-F]{6}/,

    integer: () => /[0-9]+/,

    float: () => /[0-9]+\.[0-9]+/,

    string_literal: ($) =>
      seq(
        '"',
        repeat(choice($.string_content, $.escape_sequence)),
        token.immediate('"'),
      ),

    string_content: () => token.immediate(prec(1, /[^"\\\n\r]+/)),

    /** src/lexer.ts lexString: \n \t \r \" \\ \/ and nothing else. */
    escape_sequence: () => token.immediate(/\\[ntr"\\/]/),
  },
});
