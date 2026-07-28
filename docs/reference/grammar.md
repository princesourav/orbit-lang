# Grammar reference

Derived from `src/parser.ts`, which is the authority. The
[tree-sitter grammar](../../tree-sitter-orbit/) mirrors it and is verified
against the same examples.

Notation: `?` optional, `*` zero or more, `+` one or more, `|` alternatives.

## Template

```
template     ::= trivia* frontmatter node*
trivia       ::= whitespace | comment
frontmatter  ::= "---" declaration block* "---"
declaration  ::= ("component" PascalName | "page" lowerName)
block        ::= props | settings | slots
```

Frontmatter is **mandatory**. Only whitespace and `{# … #}` comments may
precede it — an HTML comment may not.

```
props     ::= "props" "{" propDecl* "}"
propDecl  ::= name ":" type ("=" literal)?

settings  ::= "settings" "{" settingDecl* "}"
settingDecl ::= name ":" control "=" literal ("label" string)?
control   ::= "Text" | "Toggle" | "Color"
            | "Select" "(" string ("," string)* ")"
            | "Range" "(" number "," number ("," "step" ":" number)? ")"

slots     ::= "slots" "{" slotDecl* "}"
slotDecl  ::= name "?"?          -- "?" marks the slot optional

type      ::= name | "List" "<" type ">" | type "?"
```

Prop and setting defaults must be **literals**.

## Body

```
node ::= text | interpolation | comment | element | void | rcdata
       | component | if | for | let | slot | jsonLd
```

### Elements

```
element   ::= "<" tag attribute* ">" node* "</" tag ">"
void      ::= "<" voidTag attribute* "/"? ">"
rcdata    ::= "<" ("title"|"textarea") attribute* ">" (text|interpolation)* "</" tag ">"
```

`tag` must be in the closed allowlist (94 elements). Every non-void element is
explicitly closed. Inside RCDATA elements, nested tags are text.

### Attributes

```
attribute ::= name                       -- bare flag
            | name "=" quoted            -- parts with optional islands
            | name "=" "{" expr "}"      -- whole expression
            | name "?" "=" "{" expr "}"  -- conditional
quoted    ::= '"' (chars | "{" expr "}")* '"'
```

Double quotes only. Names are lowercase and drawn from the closed attribute
allowlist plus the `data-*` and `aria-*` families. `style` must be entirely
static. No dynamic attribute names, no spread.

### Control flow

```
if     ::= "<if" "{" expr "}" ">" node* "</if>"
           ("<else-if" "{" expr "}" ">" node* "</else-if>")*
           ("<else>" node* "</else>")?

for    ::= "<for" name ("," name)? "of" "=" "{" expr "}"
           ("limit" "=" "{" intLiteral "}")? ">"
           node* "<empty>" node* "</empty>" "</for>"

let    ::= "<let" name "=" "{" expr "}" "/>"
slot   ::= "<slot" ("name" "=" string)? "/>"
jsonLd ::= "<json-ld>" "{" recordExpr "}" "</json-ld>"
```

`<else-if>` and `<else>` are **siblings** of `</if>`, merged by the parser into
one node. `<empty>` is required and must be the last child of `<for>`. `limit`
must be an integer literal, at most 250.

### Components

```
component ::= "<" PascalName prop* "/>"
            | "<" PascalName prop* ">" node* "</" PascalName ">"
prop      ::= name | name "=" '"' staticText '"' | name "=" "{" expr "}"
```

A bare prop means `true`. Conditional props (`?=`) are rejected on component
calls. Slot fills use a static `slot="name"` attribute on a child element.

### Comments

```
comment ::= "{#" … "#}" | "<!--" … "-->"
```

Both are stripped entirely and never reach the output.

## Expressions

Precedence, **loosest first**:

| # | Operators | Associativity |
|---|---|---|
| 1 | `? :` | right |
| 2 | `??` | left |
| 3 | `\|>` | left |
| 4 | `\|\|` | left |
| 5 | `&&` | left |
| 6 | `==` `!=` | left |
| 7 | `<` `<=` `>` `>=` | left |
| 8 | `..` | non-associative |
| 9 | `+` `-` | left |
| 10 | `*` `/` `%` | left |
| 11 | `!` `-` (unary) | prefix |
| 12 | `.` `?.` `[…]` call | postfix |

**The pipe is the loosest operator**, as in Elixir and F#. `a + b |> round`
pipes the whole sum. The consequence worth remembering is that a comparison
cannot follow a pipeline without parentheses:

```orbit
{# Parse error O1019 — the pipe would swallow the comparison. #}
{(tags |> size) > 0}
```

The right-hand side of `|>` is a **filter name only**, optionally with extra
arguments: `x |> truncate(40)`.

```
expr    ::= ternary
ternary ::= coalesce ("?" ternary ":" ternary)?
coalesce::= pipe ("??" pipe)*
pipe    ::= or ("|>" filterName ("(" args ")")?)*
…
postfix ::= primary ("." name | "?." name | "[" expr "]")*
primary ::= literal | name | "(" expr ")" | list | record | call
list    ::= "[" (expr ("," expr)*)? "]"
record  ::= "{" (key ":" expr ("," key ":" expr)*)? "}"
key     ::= name | string
call    ::= filterName "(" args ")"
args    ::= (arg ("," arg)*)?
arg     ::= expr | name ":" expr          -- named args come after positional
```

### Named arguments

A host filter's **optional** parameters may be passed by name:

```orbit
<img src={imgUrl(product.cover, 800, crop: "face", format: "webp")} alt=""/>
```

The rules, and why each one is there:

| Rule | Diagnostic | Reason |
|---|---|---|
| Names bind to a host filter's **optional** parameters | `O2105` | Required parameters are the subject of the call. `truncate(text: body, length: 40)` is ceremony, not clarity. |
| **Stdlib filters take positional arguments only** | `O2105` | Their signatures are check functions, not parameter lists; there is nothing to bind a name to. |
| A positional argument may not **follow** a named one | `O1102` | Once a name is given, the slot a positional would fill is no longer determined by where it sits. A grammar rule, so it holds without knowing the host. |
| One parameter, one argument | `O2106` | Covers both naming it twice and naming one already filled positionally. |
| Arity counts **positional** arguments | `O2100` | Names land in distinct optional slots, so they can neither overflow the list nor satisfy a required parameter. |

Order among names is free — that is the point. `imgUrl(cover, 800, format:
"webp", crop: "face")` and `imgUrl(cover, 800, crop: "face", format: "webp")`
are the same call, and the formatter preserves whichever order was written
rather than sorting them.

A skipped optional reaches the host implementation as `none`. No argument can
ever *be* `none` — the optional law rejects a `T?` operand — so a `none` in a
parameter slot means "not supplied" and nothing else.

Record keys may be identifiers or quoted strings. Keys that are not valid
identifiers — `"@type"`, `"@context"` — must be quoted.

### Literals

```
int    ::= digit+                        -- max 20 digits, must round-trip exactly
float  ::= digit+ "." digit+             -- no exponent, no leading dot
string ::= '"' (char | escape)* '"'      -- escapes: \n \t \r \" \\ \/
bool   ::= "true" | "false"
none   ::= "none"
color  ::= "#" hex hex hex hex hex hex
range  ::= expr ".." expr                -- literal bounds, span <= 250
```

## Deliberately absent

Not oversights, and not on a roadmap:

- **Method calls.** `x.upper()` is `O1016`, with a fix-it pointing at `|>`.
- **Dynamic member access.** `obj[expr]` on records or objects is `O1015`. This
  is what makes the static access plan sound.
- **User-defined functions, recursion, `while`.** Termination is a property of
  the language.
- **String concatenation with `+`.** Use interpolation; the fix-it says so.
- **Assignment.** `<let>` binds; nothing mutates.
- **Whitespace control syntax** (`{%-` and friends). The collapse rule is fixed;
  use `{" "}` where you need an exact space.
