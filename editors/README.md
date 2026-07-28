# Editor support

| Directory | What |
|---|---|
| [`lsp/`](lsp/) | The language server. Diagnostics, completion, hover, formatting. |
| [`vscode/`](vscode/) | VS Code extension: TextMate grammar, language configuration, LSP client. |
| [`../tree-sitter-orbit/`](../tree-sitter-orbit/) | Tree-sitter grammar for Neovim, Zed and Helix. |

## The language server is compile-only

It parses, checks and formats. It **never renders**, and it **never invokes a
host filter**.

That is a security boundary, not a limitation to be lifted later. An editor
opens whatever file is on disk — including a template someone else wrote, from
a repository you just cloned. A language server that rendered would be
executing untrusted input on every keystroke. Orbit templates cannot express
arbitrary computation, but host filters are ordinary code, and a server that
never calls them cannot be the thing that runs them.

Everything offered therefore comes from static analysis.

## What it does

**Diagnostics** — the parser and checker, with *every* error in the file. Parser
recovery means one pass reports them all, which is what makes squiggles useful
rather than a game of whack-a-mole.

**Completion** — position-aware:
- after `<`: allowlisted elements and control-flow tags. Banned elements are
  never offered, so the closed allowlist is visible while typing.
- after `|>`: filter names only, because the grammar allows nothing else there.
- inside an expression: the template's own props, settings (by path), and
  slots, plus filters and literals.

**Hover** — filter signatures with their real limitations (`formatDate` says it
applies no timezone conversion), the *reason* a banned element is banned, and
the note that a URL attribute is sanitized at the sink rather than trusted from
a type. Names the buffer declares beat the global tables, so `header` in a
`slots` block hovers as a slot rather than an HTML element.

**Formatting** — the canonical formatter, which is rendering-preserving. A
buffer that does not parse gets **no edit**: rewriting a file the formatter
could not fully understand is how a formatter eats someone's work.

## What it does not do yet

Rename and code actions. Both need care around slot names and component
references, and a half-working rename is worse than none.

## `orbit.hasProjectHost`

Off by default, and the reason is worth understanding.

An editor has no way to know a project's type registry — `Product`,
`Collection`, and the host filters are supplied by the embedding application at
compile time. Without them, every `{product.title}` is an unknown identifier.

Reporting those would bury the diagnostics that *are* actionable — the type
laws, the allowlists, the syntax — under noise, and a server whose output is
mostly false positives gets turned off. So `O2030`-class diagnostics are
suppressed until a host description is configured. Everything else is reported
normally: allowlist violations, syntax errors, no-truthiness and the optional
law all work without a host.

## Installing

### VS Code

```bash
cd editors/vscode
npm install
npx vsce package
code --install-extension orbit-lang-0.5.0.vsix
```

Not yet published to the Marketplace; that is a deliberate human step.

### Neovim, Zed, Helix

Point your LSP client at `editors/lsp/server.mjs` (run with Node), and install
the tree-sitter grammar for highlighting — see
[tree-sitter-orbit](../tree-sitter-orbit/README.md).

Minimal Neovim configuration:

```lua
vim.filetype.add({ extension = { orbit = 'orbit' } })

vim.lsp.config.orbit = {
  cmd = { 'node', '/path/to/orbit-lang/editors/lsp/server.mjs', '--stdio' },
  filetypes = { 'orbit' },
  root_markers = { 'package.json', '.git' },
}
vim.lsp.enable('orbit')
```

## Testing

```bash
npx vitest run editors/
```

`lsp/analysis.mjs` holds all the behaviour and is a pure function of source
text plus cursor position; `lsp/server.mjs` is only transport. The split exists
because an LSP server is otherwise close to untestable, and "the language
server works" is not a claim worth making on inspection alone. 32 tests.
