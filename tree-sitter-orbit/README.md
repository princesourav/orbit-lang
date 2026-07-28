# tree-sitter-orbit

Tree-sitter grammar for the [Orbit](https://github.com/princesourav/orbit-lang)
template language — a typed, non-Turing-complete, HTML-strict template language.

This grammar drives syntax highlighting and structural editing in Neovim, Zed,
Helix and anything else built on tree-sitter. It is **not** the compiler: the
real parser lives in `src/parser.ts` in the parent repository and is the sole
authority on what Orbit accepts. This grammar tracks it, and the verification
step below exists to keep the two from drifting.

## What it highlights that other grammars cannot

Orbit's element list is *closed*, so the grammar can distinguish three cases a
generic HTML grammar cannot:

| Construct | Capture | Why |
|---|---|---|
| Allowlisted element (`<div>`, `<article>`) | `@tag` | Compiles. |
| Banned element (`<script>`, `<style>`, `<iframe>`) | `@error` | Rejected at parse time — the engine has no code path that emits into a script or style context. |
| Unknown element (`<my-widget>`) | `@warning` | Not in the allowlist, so it will not compile. |

The result is that Orbit's central safety rule is visible while you type, not
only when you build.

## Usage

### Neovim (nvim-treesitter)

```lua
require('nvim-treesitter.parsers').get_parser_configs().orbit = {
  install_info = {
    url = 'https://github.com/princesourav/orbit-lang',
    location = 'tree-sitter-orbit',
    files = { 'src/parser.c' },
    branch = 'main',
  },
  filetype = 'orbit',
}
vim.filetype.add({ extension = { orbit = 'orbit' } })
```

Then `:TSInstall orbit`.

### Zed

Zed consumes this grammar through a language extension; point the extension's
`config.toml` at this directory's `grammar.js` and `queries/`.

### GitHub

Repository-wide highlighting on GitHub requires this grammar to be accepted
into [github-linguist/linguist](https://github.com/github-linguist/linguist),
which has its own submission criteria (a grammar plus real-world usage
evidence). That submission is a deliberate, human-driven follow-up and has
**not** been made yet.

## Development

```bash
npm install
npx tree-sitter generate     # regenerate src/parser.c from grammar.js
npm run verify               # parse every example, compile every query
```

### Verification, and why it does not use `tree-sitter test`

`npm run verify` runs `verify.mjs`, which loads the grammar **compiled to
WebAssembly** through `web-tree-sitter`, then:

1. parses every `.orbit` file in `../examples/` and asserts the tree contains
   no `ERROR` or `MISSING` nodes, and
2. compiles every query in `queries/` and fails if any pattern is invalid.

Both checks matter for a reason that is easy to miss. `tree-sitter generate`
succeeding proves only that the grammar is well-formed and free of LR
conflicts — it says nothing about whether the grammar accepts Orbit. And an
invalid query fails *silently* in most editors: a capture that names a
non-existent node is simply never applied, so highlighting degrades quietly
rather than erroring. Parsing the same examples the real engine is tested
against closes the first gap; compiling the queries closes the second.

The examples are a good oracle precisely because they are not written for this
grammar: `examples/examples.test.mjs` in the parent repository already asserts
that the **real engine** parses and typechecks all of them with zero errors. If
this grammar and the engine ever disagree about the language, one of these two
suites breaks.

To regenerate the wasm after changing `grammar.js`:

```bash
npx tree-sitter build --wasm   # requires docker or a local emscripten
```

The native path (`tree-sitter test`, `tree-sitter parse`) additionally requires
a **64-bit C toolchain**. On Windows a 32-bit MinGW will compile the parser but
produce a DLL the 64-bit CLI cannot load, which surfaces as a confusing
`os error 126`. The wasm path avoids this entirely and runs anywhere Node runs,
which is why it is the default here.

## Layout

```
grammar.js              the grammar, annotated with the src/parser.ts rules it mirrors
tree-sitter.json        grammar metadata (ABI 15)
queries/highlights.scm  63 highlight patterns
queries/injections.scm  documents why Orbit injects no CSS or JS (it cannot contain either)
verify.mjs              wasm-based grammar + query verification
```

## License

Apache-2.0, same as the parent project.
