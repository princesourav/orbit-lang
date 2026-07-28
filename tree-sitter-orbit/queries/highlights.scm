; Syntax highlighting for the Orbit template language.
;
; Capture names follow the tree-sitter/nvim-treesitter convention so editors
; that ship a default theme map them without extra configuration.
;
; Two Orbit-specific choices are worth stating outright, because they make the
; language's safety rules visible in the editor rather than only at compile
; time:
;
;   1. Banned elements (`<script>`, `<style>`, `<iframe>`, …) are captured as
;      @error. They are not merely unsupported — the engine rejects them at
;      parse time, and seeing them light up red is the fastest possible
;      feedback.
;   2. Unknown (non-allowlisted) tags are captured as @warning. Orbit's element
;      list is closed, so a tag that is not in it will not compile.

; -----------------------------------------------------------------------------
; Frontmatter
; -----------------------------------------------------------------------------

(frontmatter_fence) @punctuation.delimiter

"component" @keyword
"page" @keyword

(template_name) @type

"props" @keyword
"settings" @keyword
"slots" @keyword

(prop_declaration name: (prop_name) @variable.parameter)
(setting_declaration name: (setting_name) @variable.parameter)
(slot_declaration name: (slot_name) @variable.parameter)

(type_identifier) @type
(list_type "List" @type)
(optional_type "?" @punctuation.special)

; Setting controls are a closed set of constructor-like names.
(select_control "Select" @function.builtin)
(range_control "Range" @function.builtin)
"label" @keyword

; -----------------------------------------------------------------------------
; Elements
; -----------------------------------------------------------------------------

(tag_name) @tag
(void_tag_name) @tag
(rcdata_tag_name) @tag
(unknown_tag_name) @warning
(banned_tag_name) @error

(component_name) @type
(component_start_tag (component_name) @constructor)
(component_end_tag (component_name) @constructor)
(component_self_closing_element (component_name) @constructor)

(attribute_name) @attribute
(quoted_attribute_value) @string
(attribute_text) @string
(slot_name_value) @string

"<" @punctuation.bracket
">" @punctuation.bracket
"</" @punctuation.bracket
"/>" @punctuation.bracket
"=" @operator

; -----------------------------------------------------------------------------
; Control flow — these are tags in Orbit, but they are control flow to a reader
; -----------------------------------------------------------------------------

(if_block) @keyword.conditional
(else_if_block) @keyword.conditional
(else_block) @keyword.conditional
(for_start_tag) @keyword.repeat
(empty_block) @keyword.repeat
(let_element) @keyword
(slot_element) @keyword
(json_ld_element) @keyword

; -----------------------------------------------------------------------------
; Expressions
; -----------------------------------------------------------------------------

(interpolation "{" @punctuation.special)
(interpolation "}" @punctuation.special)

(identifier) @variable
(property_identifier) @property
(function_name) @function.call

(integer) @number
(float) @number.float
(negative_number) @number
(boolean) @boolean
(none) @constant.builtin
(color) @constant

(string_literal) @string
(escape_sequence) @string.escape

[
  "+"
  "-"
  "*"
  "/"
  "%"
  "=="
  "!="
  "<"
  "<="
  ">"
  ">="
  "&&"
  "||"
  "!"
  "??"
  "?."
  "|>"
  ".."
] @operator

(conditional_expression ["?" ":"] @keyword.conditional.ternary)

"." @punctuation.delimiter
"," @punctuation.delimiter
":" @punctuation.delimiter

[
  "("
  ")"
  "["
  "]"
] @punctuation.bracket

; -----------------------------------------------------------------------------
; Comments
; -----------------------------------------------------------------------------

(comment) @comment @spell
(html_comment) @comment @spell
