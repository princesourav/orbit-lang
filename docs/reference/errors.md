# Error code index

<!-- GENERATED FILE — do not edit by hand.
     Produced by scripts/gen-error-index.mjs from the diagnostic code literals in src/.
     Regenerate:  node scripts/gen-error-index.mjs
     Verify:      node scripts/gen-error-index.mjs --check  -->

Every Orbit diagnostic carries a stable code. Codes mean exactly one thing and are never recycled: a code that disappears from the engine is retired, not reused. This index is generated from the engine source, so it cannot drift from what the code actually raises.

| range | phase |
| --- | --- |
| `O1xxx` | lexer + parser — syntax, allowlists, structural caps |
| `O2xxx` | checker — signatures, types, contracts, filters |
| `O3xxx` | checker — the truthiness rule |
| `O4xxx` | interpreter + escaping (runtime); `O49xx` are non-fatal warnings |
| `O5xxx` | stored-AST re-validation on load |

The **message** column is the engine's own text with runtime interpolations shown as `…`. The **what to do** column is authored guidance, maintained in `scripts/gen-error-index.mjs`.

Total codes: **207**.

## O1xxx — lexer and parser

Raised before any type exists: syntax, the element and attribute allowlists, and the structural caps. Parsing stops at the first of these, so a template with a syntax error yields exactly one diagnostic.

| code | message | what to do | raised in |
| --- | --- | --- | --- |
| `O1001` | unterminated expression: missing closing `}` | Close the interpolation island with `}`. Every `{` in template text opens an expression. | `src/lexer.ts:143` |
| `O1002` | expression too long (more than … tokens) | Split the expression across two or more `<let>` bindings. | `src/lexer.ts:133` |
| `O1003` | unexpected character … in expression | Remove the character; Orbit expressions use ASCII identifiers, numbers, strings, `#colors` and the documented punctuators. | `src/lexer.ts:198` |
| `O1004` | unterminated string literal | Add the closing `"`. Strings cannot span lines. | `src/lexer.ts:219 (+1 more)` |
| `O1005` | string literals cannot contain raw newlines | Replace the literal newline with `\n`. | `src/lexer.ts:223 (+1 more)` |
| `O1006` | unknown string escape \… | Use one of `\n` `\t` `\r` `\"` `\\` `\/`. | `src/lexer.ts:233 (+1 more)` |
| `O1007` | string literal exceeds the per-value string cap | Shorten the literal, or move the text into element content where it is not a single value. | `src/lexer.ts:238` |
| `O1008` | color literals are exactly #rrggbb (got #…) | Write the full six-digit form, e.g. `#0a0a0a`. Three-digit and named colors are not accepted. | `src/lexer.ts:250 (+1 more)` |
| `O1009` | expression nesting exceeds depth … | Break the expression into `<let>` steps; deep nesting is capped so checking stays linear. | `src/parser.ts:151` |
| `O1010` | unexpected … after expression | Delete the trailing token, or wrap the whole thing in parentheses if you meant one expression. | `src/parser.ts:106` |
| `O1011` | unexpected end of expression | The expression ends mid-operator — supply the missing operand. | `src/parser.ts:118 (+1 more)` |
| `O1012` | expected … | Insert the punctuation the parser named (usually a `)`, `]`, `}` or `:`). | `src/parser.ts:132` |
| `O1013` | the right side of \|> must be a filter name | The right of `\|>` is a filter name, optionally with arguments: `x \|> truncate(40)`. | `src/parser.ts:245` |
| `O1014` | expected a property name after | Write a static property name after the dot. There is no dynamic member access. | `src/parser.ts:356` |
| `O1015` | dynamic member access is not supported | Use a static property (`obj.name`). `obj["name"]` would make data flow unanalyzable. | `src/parser.ts:373` |
| `O1016` | method calls are not supported | Methods do not exist; pipe instead: `value \|> filter(args)`. | `src/parser.ts:391` |
| `O1017` | expected a record key | Record keys are identifiers or string literals: `{ name: "x" }`. | `src/parser.ts:470` |
| `O1018` | unexpected … in expression | The token cannot start an expression — check for a stray operator or an unbalanced bracket. | `src/parser.ts:486` |
| `O1019` | `…` cannot follow a \|> pipeline — \|> binds looser than every arithmetic and comparison operator | Parenthesize: `(x \|> round) * 2`. `\|>` binds looser than every arithmetic and comparison operator. | `src/parser.ts:274` |
| `O1020` | expected … | Supply the identifier the parser asked for (a prop, setting, slot or binding name). | `src/parser.ts:664` |
| `O1021` | expected a tag name after < | A `<` in text must be written `{"<"}`; a tag needs a name immediately after `<`. | `src/parser.ts:674` |
| `O1022` | (message is constructed at the call site) | Close the comment with `#}`. | `src/parser.ts:701` |
| `O1023` | (message is constructed at the call site) | Close the comment with `-->`. | `src/parser.ts:701` |
| `O1024` | numeric literal has … digits (the limit is …) | Orbit numbers are IEEE-754 doubles — a literal this wide has no exact representation. Shorten it. | `src/lexer.ts:300` |
| `O1025` | numeric literal … cannot be represented exactly (it would round to …) | Write the value the double actually holds, or keep integers within the safe-integer range. | `src/lexer.ts:309` |
| `O1030` | every template starts with a frontmatter header | Start the file with a `---` frontmatter block declaring `component Name` or `page name`. | `src/parser.ts:756` |
| `O1031` | unterminated frontmatter (missing closing ---) | Close the frontmatter with a second `---`. | `src/parser.ts:770` |
| `O1032` | duplicate component/page declaration | A template is either a component or a page, declared exactly once. | `src/parser.ts:775` |
| `O1033` | component names are PascalCase | Rename the component to PascalCase: `component ProductCard`. | `src/parser.ts:780` |
| `O1034` | page names are lowercase | Rename the page to lowercase: `page collection`. | `src/parser.ts:783` |
| `O1035` | unknown frontmatter keyword … | Frontmatter accepts only `component`, `page`, `props`, `settings` and `slots`. | `src/parser.ts:827` |
| `O1036` | frontmatter must declare `component Name` or `page name` | Add `component Name` or `page name` inside the frontmatter block. | `src/parser.ts:834` |
| `O1037` | expected { to open the block | Open the block with `{`: `props { … }`. | `src/parser.ts:851` |
| `O1038` | unterminated frontmatter block | Close the block with `}`. | `src/parser.ts:855` |
| `O1039` | List needs an element type: List<T> | Write `List<T>` with an element type, e.g. `List<Product>`. | `src/parser.ts:866 (+1 more)` |
| `O1040` | expected a number | Supply a numeric literal. | `src/parser.ts:930` |
| `O1041` | expected a literal value, found … | Frontmatter defaults are literals only: numbers, strings, `true`/`false`, `none`, `#rrggbb`. | `src/parser.ts:949 (+1 more)` |
| `O1042` | `settings` is a reserved binding name | `settings` is the reserved binding for merchant settings — pick another name. | `src/parser.ts:957 (+1 more)` |
| `O1043` | prop … needs a type | Every prop is typed: `title: String`. | `src/parser.ts:959` |
| `O1044` | setting … needs a control type | Every setting names a control: `heading: Text = "Sale"`. | `src/parser.ts:979` |
| `O1045` | Select needs options: Select("a", "b") | Write `Select("a", "b")` with string-literal options. | `src/parser.ts:987 (+2 more)` |
| `O1046` | Range needs bounds: Range(min, max, step) | Write `Range(0, 12)` or `Range(0, 12, step: 2)` with integer bounds. | `src/parser.ts:1001 (+4 more)` |
| `O1047` | unknown setting control … | Valid controls are `Text`, `Select(...)`, `Range(min, max, step)`, `Toggle`, `Color`. | `src/parser.ts:1024` |
| `O1048` | setting … needs a default | Give the setting a default: `name: Toggle = false`. Merchant settings are always populated. | `src/parser.ts:1031` |
| `O1049` | label must be a string literal | Labels are string literals: `label "Heading"`. | `src/parser.ts:1044` |
| `O1050` | missing closing tag </…> | Close the element. Orbit is HTML-strict: no implied end tags, no auto-closing. | `src/parser.ts:1131 (+2 more)` |
| `O1051` | malformed closing tag </… | Finish the closing tag with `>`. | `src/parser.ts:1140 (+2 more)` |
| `O1052` | (message is constructed at the call site) | Tags must nest properly — close the inner element before the outer one. | `src/parser.ts:1147` |
| `O1053` | unescaped `<` in text | Write `{"<"}` for a literal less-than sign. | `src/parser.ts:1177` |
| `O1054` | comment exceeds the per-value string cap | Split the text run; a single text node or attribute value is capped. | `src/parser.ts:711 (+4 more)` |
| `O1055` | <empty> is only valid inside <for> | `<empty>` is the fallback branch of `<for>` and is valid nowhere else. | `src/parser.ts:1244` |
| `O1056` | duplicate <empty> in <for> | A `<for>` has at most one `<empty>` branch. | `src/parser.ts:1247` |
| `O1057` | <empty> takes no attributes | `<empty>` takes no attributes: write `<empty>…</empty>`. | `src/parser.ts:1250` |
| `O1058` | <empty> must be the last child of <for> | Move `<empty>` after every repeated child; it must be the last child of `<for>`. | `src/parser.ts:1255` |
| `O1059` | <…> without a preceding <if> sibling | `<else-if>` and `<else>` are siblings of `<if>` — put them immediately after `</if>`. | `src/parser.ts:1261` |
| `O1060` | <else-if> needs a condition: <else-if {cond}> | Write `<else-if {cond}>…</else-if>` with a condition island. | `src/parser.ts:1281 (+1 more)` |
| `O1061` | malformed <else> | Write `<else>…</else>`; `<else>` takes no condition. | `src/parser.ts:1292` |
| `O1062` | <if> needs a condition: <if {cond}> | Write `<if {cond}>…</if>` with a condition island. | `src/parser.ts:1304 (+1 more)` |
| `O1063` | expected `of` in <for>, found … | Write `<for item of={list}>` (optionally `<for item, i of={list}>`). | `src/parser.ts:1325 (+2 more)` |
| `O1064` | expected limit={n} | Write `limit={12}` with a literal integer. | `src/parser.ts:1333 (+1 more)` |
| `O1065` | malformed <for> tag | Finish the `<for>` tag with `>`; the only attributes are `of=` and `limit=`. | `src/parser.ts:1338` |
| `O1066` | <let> needs a value: <let name={expr}/> | Write `<let name={expr}/>`. | `src/parser.ts:1443 (+1 more)` |
| `O1067` | <let> is self-closing: <let name={expr}/> | `<let>` is self-closing: `<let total={a + b}/>`. | `src/parser.ts:1447` |
| `O1068` | slot names are static: <slot name="badge"/> | Slot names are static strings: `<slot name="badge"/>`. | `src/parser.ts:1458 (+1 more)` |
| `O1069` | <slot> is self-closing (no fallback content in v0) | `<slot>` is self-closing and has no fallback content. | `src/parser.ts:1469` |
| `O1070` | <json-ld> takes no attributes | `<json-ld>` takes no attributes. | `src/parser.ts:1477` |
| `O1071` | <json-ld> contains exactly one { record expression } | `<json-ld>` wraps exactly one record expression: `<json-ld>{ … }</json-ld>`. | `src/parser.ts:1479 (+1 more)` |
| `O1072` | components cannot carry slot=; wrap the call in an element | Wrap the component call in an element and put `slot=` on that element. | `src/parser.ts:1494` |
| `O1073` | malformed <…> tag | Finish the component tag with `>` or `/>`. | `src/parser.ts:1503` |
| `O1080` | <…> is not allowed: … | The element is banned for the stated reason — there is no flag to re-enable it. | `src/parser.ts:1516` |
| `O1081` | <…> is not in the element allowlist | Only allowlisted elements parse. Use a semantic element from the allowlist. | `src/parser.ts:1520` |
| `O1082` | <…> is not a void element | Only void elements self-close. Write `<tag>…</tag>`. | `src/parser.ts:1529` |
| `O1083` | malformed <…> tag | Finish the tag with `>` or `/>`. | `src/parser.ts:1535` |
| `O1084` | more than … attributes on one element | Reduce the number of attributes on the element. | `src/parser.ts:1619` |
| `O1085` | duplicate attribute … | Remove the repeated attribute. | `src/parser.ts:1621` |
| `O1086` | attribute … is not allowed: … | The attribute is banned for the stated reason (event handlers, `srcdoc`, `ping`, namespaced names, legacy URL attributes). | `src/parser.ts:1632` |
| `O1087` | attribute … is not in the attribute allowlist | Use an allowlisted attribute, or a `data-*` / `aria-*` attribute for custom data. | `src/parser.ts:1634` |
| `O1088` | conditional attribute needs an expression: …?={cond} | Conditional attributes need a Bool island: `disabled?={isSoldOut}`. | `src/parser.ts:1642` |
| `O1089` | attribute values are double-quoted | Attribute values are double-quoted. | `src/parser.ts:1654` |
| `O1090` | attribute values must be quoted or an {expression} | Write `name="text"` or `name={expr}`. Unquoted values are not accepted. | `src/parser.ts:1656` |
| `O1091` | component props take whole expressions, not text with islands | Component props take whole expressions: `title={product.title}`, not `title="a {x}"`. | `src/parser.ts:1667` |
| `O1092` | expected an attribute name | Supply an attribute name. | `src/parser.ts:1711` |
| `O1093` | attribute names are lowercase (got …) | Attribute names are lowercase. | `src/parser.ts:1720` |
| `O1094` | unterminated attribute value for … | Close the attribute value with `"`. | `src/parser.ts:1735` |
| `O1095` | interpolation inside style attributes is not allowed (W-09) | Interpolation in `style` is banned. Choose a class from a static set, or use a host `cssVar` helper. | `src/parser.ts:1763` |
| `O1096` | slot= must be a static name: slot="badge" | `slot=` is a static name: `slot="badge"`. | `src/parser.ts:1772` |
| `O1097` | verbatim is a bare marker attribute | `verbatim` is a bare marker attribute: `<pre verbatim>`. | `src/parser.ts:1775` |
| `O1098` | duplicate template name … | Template names are the program-wide key — rename one of the two templates. | `src/parser.ts:1870` |
| `O1100` | template exceeds … AST nodes | Split the template into components; the per-template node cap is structural. | `src/ast.ts:310` |
| `O1101` | element nesting exceeds depth … | Flatten the markup or extract a component; element nesting is capped. | `src/ast.ts:319` |
| `O1102` | a positional argument cannot follow a named one | Move the positional argument before the first `name:` one, or give it a name too. | `src/parser.ts:314` |
| `O1103` | the `@name` attribute form is reserved for a future version of Orbit and is not implemented | The `on:` and `@` attribute forms are reserved. Behaviour ships as platform runtime islands configured through `data-*`. | `src/parser.ts:1628 (+1 more)` |
| `O1104` | this engine does not implement Orbit language version … | Upgrade the engine, or change the `orbit` pragma if the version was a typo. | `src/parser.ts:805` |
| `O1105` | expected a language version after `orbit` | Write the version: `orbit 2026`. | `src/parser.ts:1681` |
| `O1106` | duplicate orbit version declaration | Remove the second `orbit` line; a template declares one language version. | `src/parser.ts:799` |
| `O1107` | <match> needs a subject: <match {expr}> | Give the match a subject: `<match {expr}>`. | `src/parser.ts:1357 (+1 more)` |
| `O1108` | only <case> may appear inside <match> | Only `<case>` may sit between `<match>` and `</match>`. Move the markup inside a case. | `src/parser.ts:1375` |
| `O1109` | <case> is only valid as a direct child of <match> | `<case>` is only valid as a direct child of `<match>`. | `src/parser.ts:1230` |
| `O1110` | unterminated case value | A case takes a string literal or the bare marker `default`: `<case "new">`, `<case default>`. | `src/parser.ts:1406 (+2 more)` |
| `O1111` | <match> needs at least one <case> | A `<match>` with no arms matches nothing. Add a `<case>`. | `src/parser.ts:1384` |

## O2xxx — checker: signatures, types, contracts, filters

Raised by `check()`. The checker never throws and never stops early: it returns every diagnostic it found, each with a span and, where one can be computed, a fix-it suggestion.

| code | message | what to do | raised in |
| --- | --- | --- | --- |
| `O2010` | duplicate prop … | Remove the duplicate prop declaration. | `src/checker.ts:162` |
| `O2011` | Html cannot appear inside … — it may only be a prop's own type | Html is element-content-only: it can never be a prop type or a prop value. | `src/checker.ts:188 (+1 more)` |
| `O2012` | default for prop … is …, expected … | Make the default literal match the declared prop type. | `src/checker.ts:200` |
| `O2013` | duplicate setting … | Remove the duplicate setting declaration. | `src/checker.ts:213` |
| `O2014` | duplicate slot … | Remove the duplicate slot declaration. | `src/checker.ts:226` |
| `O2015` | setting …: Text default must be a string | The default must be valid for the control (a string for `Text`, an option for `Select`, an in-range Int for `Range`, …). | `src/checker.ts:286 (+4 more)` |
| `O2016` | unknown type … | Declare the type in the host `TypeRegistry`, or use a built-in (`Int`, `Float`, `String`, `Bool`, `Color`). | `src/checker.ts:321` |
| `O2017` | page … cannot declare props (prop …) — pages are entry points, not callees | Pages are entry points, not callees. Move the data to `pageGlobals` in `CheckOptions`. | `src/checker.ts:155` |
| `O2018` | setting …: Range min (…) is greater than max (…) | Swap the bounds: `Range(min, max)` with `min <= max`. | `src/checker.ts:253` |
| `O2019` | setting …: Range step must be greater than 0 (found …) | A `Range` step must be greater than zero. | `src/checker.ts:262` |
| `O2020` | setting …: step … never reaches max (…..… is … wide) | Warning: the declared maximum is unreachable. Pick a step that divides the span, or adjust `max`. | `src/checker.ts:274` |
| `O2030` | unknown identifier … | The name is not in scope. Check spelling, or declare it as a prop / page global / `<let>`. | `src/checker.ts:780` |
| `O2031` | `…` has no property `…` | The object has no such field. Check the host `TypeRegistry` (or the record literal) for the real name. | `src/checker.ts:908 (+1 more)` |
| `O2032` | … has no properties | The value has no properties. Lists use `size(list)` or a `<for>` loop. | `src/checker.ts:925` |
| `O2033` | duplicate record key … | Remove the duplicate record key. | `src/checker.ts:799` |
| `O2034` | list index must be Int, found … | List indices are Int. | `src/checker.ts:828` |
| `O2035` | only lists can be indexed (found …) — dynamic member access is not supported | Only lists can be indexed; there is no dynamic member access. | `src/checker.ts:836` |
| `O2036` | unary - needs Int or Float, found … | Unary `-` needs an Int or Float. | `src/checker.ts:852` |
| `O2037` | operator … needs Int or Float, found … | Arithmetic and ordering need numbers. Strings compose via interpolation: `{a}{b}`. | `src/checker.ts:972 (+1 more)` |
| `O2050` | range bounds must be literal integers (a..b) | Range bounds are literal integers (`1..5`). Loop over a host-resolved list for dynamic counts. | `src/checker.ts:810` |
| `O2051` | range spans more than … values | Shorten the range; ranges are bounded at compile time. | `src/checker.ts:817` |
| `O2060` | Money cannot be rendered directly; pass it to a host money filter | Money is terminal: no operators, no equality, no properties, no stdlib filters. Pass it to a host money filter. | `src/checker.ts:550 (+4 more)` |
| `O2061` | Image is an opaque handle; pass it to a host image filter | Image is an opaque handle. Pass it to a host image filter to obtain a Url. | `src/checker.ts:554 (+2 more)` |
| `O2062` | MoneyText admits no filters — it only renders | MoneyText only renders — it admits no filters. Format it in the host filter instead. | `src/checker.ts:1070` |
| `O2063` | (message is constructed at the call site) | Html cannot be a filter operand; it can only be interpolated into element content. | `src/checker.ts:1058` |
| `O2064` | URL attribute … needs a Url or String, found … | URL attributes take a `Url` or a `String`. | `src/checker.ts:561` |
| `O2065` | comparing … to none is always … | Warning: the value can never be `none`, so the comparison is constant. Drop it. | `src/checker.ts:999` |
| `O2066` | cannot compare … and … | The two sides have no common comparable type. Compare precomputed flags from the host model. | `src/checker.ts:1014 (+1 more)` |
| `O2070` | unknown filter … | No such filter. Check the stdlib reference and the host filter list. | `src/checker.ts:1170` |
| `O2071` | host filter … is declared trustedHtml — its output is emitted raw, unsanitized | Warning: this host filter is declared trustedHtml, so its output is emitted raw and unsanitized. The host asserts the input is trusted; verify that where the filter is DECLARED, not at this call site. A sanitizer or htmlTransform filter does not raise this. | `src/checker.ts:1117` |
| `O2072` | left of ?? is never none (…) | Warning: the left of `??` is never `none` — the fallback is dead. Remove it. | `src/checker.ts:863` |
| `O2073` | branches have incompatible types: … vs … | Both branches must have a common type. Convert one side, or move the difference into the markup. | `src/checker.ts:1372` |
| `O2074` | cannot render a … in an attribute | The value has no textual form. Project it into a printable primitive first. | `src/checker.ts:578 (+2 more)` |
| `O2075` | Html cannot render inside <title>/<textarea> | Html cannot render inside `<title>` / `<textarea>`; those are RCDATA. | `src/checker.ts:706` |
| `O2076` | Html cannot appear in attributes (element-content only) | Html cannot appear in attributes. | `src/checker.ts:546` |
| `O2077` | <for> needs a List or Range, found … | `<for>` iterates a List or a Range. | `src/checker.ts:442` |
| `O2078` | limit must be a literal Int between 1 and … | `limit` is a literal Int within the engine loop cap. | `src/checker.ts:447` |
| `O2079` | Html cannot be bound with <let> (element-content only) | Html cannot be bound with `<let>`; interpolate it directly into element content. | `src/checker.ts:469` |
| `O2080` | unknown component … | No such component in the program. Check the name and that the file is in the compiled set. | `src/checker.ts:594` |
| `O2081` | … is a page and cannot be called as a component | Pages cannot be called. Extract the markup into a component. | `src/checker.ts:598` |
| `O2082` | component … has no prop … | The component declares no such prop. | `src/checker.ts:605` |
| `O2083` | prop … expects …, found … | The argument type does not match the declared prop type. | `src/checker.ts:651` |
| `O2084` | missing required prop … on <…> | Supply the required prop, or give it a default / optional type in the component. | `src/checker.ts:659` |
| `O2085` | ambiguous slot attribution: every element a control-flow wrapper can render must target the same slot | Every element a control-flow wrapper can render must target the same slot. Split the wrapper. | `src/checker.ts:666` |
| `O2086` | (message is constructed at the call site) | The component declares no such slot. Add it to `slots { … }`, or use `<slot/>` for default content. | `src/checker.ts:674` |
| `O2087` | slot … on <…> is required | The slot is required — provide content for it with `slot="name"`. | `src/checker.ts:685` |
| `O2088` | <slot> is only valid inside components | `<slot>` is only valid inside a component. | `src/checker.ts:482` |
| `O2089` | slot … is not declared in frontmatter | Declare the slot in frontmatter: `slots { name? }`. | `src/checker.ts:488` |
| `O2090` | json-ld admits primitives, records and lists only (found …) | `<json-ld>` admits primitives, records and lists. Project host objects into a record first. | `src/checker.ts:500` |
| `O2091` | component cycle: … | Break the cycle; the component graph must be acyclic (this is what makes rendering total). | `src/checker.ts:361` |
| `O2092` | prop … cannot use ?= (that form is for conditional HTML attributes) | `?=` is the conditional-attribute form. Component props take `name={boolExpr}`. | `src/checker.ts:621` |
| `O2093` | ?. on a value that is never none (…) | Warning: the value is never `none`, so `?.` is redundant. Use plain `.`. | `src/checker.ts:899` |
| `O2100` | … takes … arguments, got … | Wrong argument count — check the filter signature. | `src/checker.ts:1297 (+1 more)` |
| `O2101` | …: … must be …, found … | Wrong argument type — check the filter signature. | `src/checker.ts:1094 (+5 more)` |
| `O2102` | …: the key must be a string literal | The argument must be a literal so the filter stays statically analyzable. | `src/stdlib.ts:132 (+1 more)` |
| `O2103` | sortBy: … has no field … | The field does not exist on the element type, or is not sortable. | `src/stdlib.ts:418 (+2 more)` |
| `O2104` | optional value used without a fallback (`…`) — decide what happens when it is absent | THE OPTIONAL LAW: decide what happens when the value is absent. Use `{x ?? fallback}`, or narrow with `<if {x != none}>`. | `src/checker.ts:754` |
| `O2105` | … takes positional arguments only — named arguments are a host-filter feature | No such named argument. Names bind to a host filter's optional parameters; stdlib filters take positional arguments only. | `src/checker.ts:1138 (+2 more)` |
| `O2106` | (message is constructed at the call site) | One parameter, two arguments. Drop the positional one, or drop the name. | `src/checker.ts:1338` |
| `O2107` | <match> needs a String or a string-literal union, found … | `<match>` needs a String or a string-literal union. Use `<if>` for a Bool. | `src/checker.ts:1207` |
| `O2108` | <match> does not handle … | Add an arm for each named variant. This is the diagnostic the construct exists to produce. | `src/checker.ts:1261` |
| `O2109` | <match> already has a default arm | The arm can never be selected: the value is already handled, is not one of the variants, or sits after the default. | `src/checker.ts:1221 (+3 more)` |
| `O2110` | a default arm defeats exhaustiveness on a union — list every variant instead | Remove the default arm and list every variant. A default absorbs variants added later, which is exactly what exhaustiveness is for. | `src/checker.ts:1251` |
| `O2111` | <match> on a String needs a <case default> arm | A String is not a closed set, so add `<case default>`. | `src/checker.ts:1269` |

## O3xxx — checker: the truthiness rule

Its own range because it is the rule newcomers hit first, and the one that never bends.

| code | message | what to do | raised in |
| --- | --- | --- | --- |
| `O3007` | … must be Bool, found … | There is no truthiness. Write an explicit Bool: `{x != none}`, `{s != ""}`, `{n > 0}`. | `src/checker.ts:734 (+1 more)` |

## O4xxx — interpreter and escaping (runtime)

Raised during `render()`. Every one of these FAILS the render — a partial page is never returned. The O49xx sub-range is different: those are non-fatal `RenderWarning`s returned alongside a successful render.

| code | message | what to do | raised in |
| --- | --- | --- | --- |
| `O4001` | render fuel exhausted (output byte budget) | The render exhausted its fuel (a byte budget). Emit less, or raise `fuel` in `RenderOptions`. | `src/interpreter.ts:249 (+3 more)` |
| `O4002` | global iteration budget of … exhausted | The render exceeded the global iteration budget. Lower loop limits, or raise `maxIterations`. | `src/interpreter.ts:266` |
| `O4003` | render exceeded the …ms wall-clock deadline | The render passed its wall-clock deadline. Usually a slow host filter; raise `deadlineMs` only if the work is legitimate. | `src/interpreter.ts:273` |
| `O4004` | output exceeds … characters | The output exceeded `maxOutput`. Paginate the page, or raise the cap. | `src/interpreter.ts:252` |
| `O4005` | intermediate string exceeds … characters | An intermediate string exceeded the per-value cap inside a filter chain. | `src/interpreter.ts:279` |
| `O4006` | intermediate list exceeds … items | An intermediate list exceeded the per-value cap inside a filter chain. | `src/interpreter.ts:286` |
| `O4010` | unbound identifier … | The AST references a binding the host did not supply. Check `bindings` / `props` against the access plan. | `src/interpreter.ts:699` |
| `O4011` | accessed property … of none | Property access on a value that is not a record. The host data does not match its declared type. | `src/interpreter.ts:728 (+1 more)` |
| `O4012` | rendered value is none — data violated its declared type | The host supplied `none` where a non-optional value was declared. Fix the data or declare the field `T?`. | `src/interpreter.ts:926` |
| `O4013` | division by zero | Division or modulo by zero. Guard the denominator with `<if>`. | `src/interpreter.ts:816 (+1 more)` |
| `O4014` | cannot render a structured value | A structured value reached a text sink. The checker allows this only for `<invalid>` types — check the data shape. | `src/interpreter.ts:928` |
| `O4015` | component nesting exceeds depth … | Component nesting exceeded the depth cap. Flatten the composition. | `src/interpreter.ts:633` |
| `O4016` | unknown template … | The entry name is not in the loaded program. | `src/interpreter.ts:192 (+1 more)` |
| `O4020` | …: expected a string value | A filter received a value of the wrong runtime shape — the host data contradicts its declared type. | `src/stdlib.ts:148 (+4 more)` |
| `O4021` | formatDate: not an ISO date: … | `formatDate` needs an ISO-8601 date string (`YYYY-MM-DD`, optionally `Thh:mm[:ss]`). | `src/stdlib.ts:514` |
| `O4022` | conditional attribute …?= needs a Bool | A conditional attribute evaluated to a non-Bool at runtime. | `src/interpreter.ts:538` |
| `O4023` | Html cannot appear in attributes | An Html value reached an attribute sink. | `src/interpreter.ts:560` |
| `O4024` | <for> subject is not a list or range | The `<for>` subject, or an indexed value, was not a list at runtime. | `src/interpreter.ts:617 (+1 more)` |
| `O4025` | condition did not evaluate to a Bool | A condition evaluated to a non-Bool at runtime. | `src/interpreter.ts:670 (+1 more)` |
| `O4026` | expected an Int | An arithmetic operand was not a number at runtime. | `src/interpreter.ts:676 (+2 more)` |
| `O4027` | unknown operator … | Unknown binary operator in the AST — only a hand-built AST can produce this. | `src/interpreter.ts:822` |
| `O4028` | unknown filter … | The AST names a filter that is not registered for this render. | `src/interpreter.ts:909` |
| `O4029` | cannot render a non-finite number | A non-finite number (NaN / Infinity) reached a text sink. | `src/interpreter.ts:921` |
| `O4030` | json-ld nesting exceeds depth … | The json-ld value nests deeper than the cap. Flatten the record. | `src/escape.ts:326` |
| `O4031` | json-ld numbers must be finite | json-ld numbers must be finite. | `src/escape.ts:332` |
| `O4032` | Html values cannot appear in json-ld | Html values cannot appear in json-ld. | `src/escape.ts:347` |
| `O4033` | json-ld admits primitives, records and lists only (found …) | json-ld admits primitives, records and lists only. | `src/escape.ts:359` |
| `O4034` | Html cannot render inside <title>/<textarea> | Html cannot render inside `<title>` / `<textarea>`. | `src/interpreter.ts:405` |
| `O4035` | host filter … declared Html but returned a non-string | A host filter declared `Html` but returned a non-string. Fix the host implementation. | `src/interpreter.ts:902` |
| `O4036` | host filter … threw …; host filters must handle their own failures | A host filter threw. Host filters must handle their own failures and return a value. | `src/interpreter.ts:887` |
| `O4037` | blocked unsafe URL in …: … | A URL was blocked by the sink under `urlPolicy: "error"`. Fix the data; the scheme is not allowlisted. | `src/interpreter.ts:571` |
| `O4038` | component entry …: required prop … of type … was not supplied and has no default | A prop supplied at a component entry is missing or has the wrong shape for its declared type. | `src/interpreter.ts:364 (+1 more)` |
| `O4039` | record field … is a reserved property name | A reserved property name (`__proto__`, `constructor`, `prototype`) can never be read from or written to data. | `src/interpreter.ts:712 (+1 more)` |
| `O4040` | no <case> matches …, and the host declared no such variant | No `<case>` matched and there is no default. The checker proved the arms cover the union, so the host supplied a value outside the type it declared. | `src/interpreter.ts:461` |
| `O4041` | <match> subject is not a String at runtime | The `<match>` subject was not a string at runtime — the host data contradicts its declared type. | `src/interpreter.ts:449` |
| `O4900` | blocked unsafe URL in …: … | Warning: a URL was blocked at the sink and replaced with a placeholder. Set `urlPolicy: "error"` to fail instead. | `src/interpreter.ts:573` |
| `O4901` | setting ….…: provided value is invalid for its … control; using the declared default | Warning: a merchant setting value was invalid for its control; the declared default was used. | `src/interpreter.ts:309` |
| `O4902` | emitted raw Html from a trustedHtml host filter | Warning: a trustedHtml host filter emitted raw Html at runtime. Sanitizer and htmlTransform output is silent, so this list is an audit surface rather than a census of every rich-text field. | `src/interpreter.ts:417` |
| `O4903` | component entry …: prop … is not declared by the component and was ignored | Warning: a prop supplied at a component entry is not declared by the component and was ignored. | `src/interpreter.ts:384` |
| `O4909` | warning list truncated at … entries | Warning: the per-render warning list hit its cap and was truncated. | `src/interpreter.ts:231` |

## O5xxx — stored-AST re-validation

Raised by `loadCheckedAst(data, { trust: "verify" })` when a stored AST row fails structural re-validation.

| code | message | what to do | raised in |
| --- | --- | --- | --- |
| `O5000` | (message is constructed at the call site) | Structural re-validation of a stored AST failed. The row is malformed or was not produced by this engine version; re-compile from source. | `src/validate-ast.ts:61` |
| `O5001` | stored AST has no templates record | The stored AST has no `templates` record — the row is not an Orbit program. | `src/validate-ast.ts:532` |

