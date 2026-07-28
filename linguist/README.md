# GitHub language support for `.orbit`

## The problem

`.orbit` files currently render on GitHub as plain text, and the repository's
language bar reports TypeScript, JavaScript and HTML — the languages Orbit is
*written in*, not the language it *is*.

Shopify's Liquid repository shows `Liquid 10.6%` because Liquid is defined in
[github-linguist/linguist][linguist], the library GitHub uses to classify files.
Orbit is not, so its templates count toward nothing and get no highlighting.

## Why this cannot be fixed in this repository

`.gitattributes` supports `linguist-language`, but it can only map a file to a
language Linguist **already defines**. There is no mechanism to declare a new
one locally. The options are to be listed upstream, or to be nothing.

Mapping `.orbit` to a neighbouring language to borrow its highlighting was
considered and rejected: it would report Orbit as Liquid — a language it is
deliberately not compatible with — in exchange for approximate colours.

## The actual requirement

Linguist's [contribution criteria][criteria] are explicit, and they are about
adoption rather than engineering:

> We will only add new extensions once they have sufficient usage on GitHub.
> […] we do not accept PRs for very new or hobby languages, and will close any
> such PRs that attempt to add them.

For an extension expected to occur more than once per repository — which
`.orbit` is — the bar is:

- **≥ 2,000 files** with the extension indexed on public GitHub in the last
  year, excluding forks;
- a **reasonable distribution across unique `:user/:repo`**, assessed by
  sampling the results. Files concentrated under the language's own author are
  filtered out of the assessment.

**Current state: 6 files, one repository, one author.** The gap is roughly three
orders of magnitude, and every one of those files is ours — which the
distribution check is specifically designed to discount.

Submitting now would get the PR closed, and closed PRs are remembered.

## What is ready

Everything except the adoption. When the bar is met, the submission is
mechanical:

| Requirement | Status |
|---|---|
| A syntax-highlighting grammar | **Ready** — [`tree-sitter-orbit`](../tree-sitter-orbit/), 63 highlight patterns, verified against every shipped example |
| A TextMate grammar (Linguist's highlighting path) | **Ready** — [`editors/vscode/syntaxes/orbit.tmLanguage.json`](../editors/vscode/syntaxes/orbit.tmLanguage.json), scope `source.orbit` |
| `languages.yml` entry | **Ready** — [`languages.yml.entry`](./languages.yml.entry) |
| Sample files for the classifier | **Ready** — [`examples/`](../examples/), six templates that CI compiles and renders |
| Usage evidence | **Blocked on adoption** |

## The submission, when the time comes

1. Confirm the search meets the bar:
   `https://github.com/search?q=path%3A*.orbit&type=code` — check the file count
   and click through for `:user/:repo` distribution.
2. Fork [github-linguist/linguist][linguist].
3. Add the entry from `languages.yml.entry` to `lib/linguist/languages.yml`,
   **omitting `language_id`** — Linguist assigns it.
4. `script/add-grammar https://github.com/princesourav/orbit-lang` — the
   TextMate grammar at `editors/vscode/syntaxes/orbit.tmLanguage.json` is the
   one to register.
5. Copy the templates from [`examples/`](../examples/) into `samples/Orbit/`.
   They are not duplicated here on purpose: CI compiles, renders and
   format-checks the originals, so a staged copy could only drift out of sync
   with the language it is meant to demonstrate.
6. `bundle exec rake test`.
7. Open the PR with the search URL and the distribution evidence.

## Notes on the entry

**`type: markup`.** Orbit is a template language that produces HTML, and it is
not Turing-complete — `programming` would overstate it, and Liquid, Twig and
Handlebars are all classified `markup`.

**`color: '#2f5bd7'`.** Chosen to be distinguishable from the colours already
used by neighbouring template languages (Liquid `#67b8de`, Twig `#c1d026`,
Handlebars `#f7931e`, HTML `#e34c26`), since the language bar is the main place
anyone sees it.

**`tm_scope: source.orbit`** matches the TextMate grammar in this repository.

**`ace_mode: text`** because Ace has no Orbit mode. This is honest rather than
aspirational; `codemirror_mode` is omitted for the same reason.

## In the meantime

The [playground](../playground/) gives Orbit source proper highlighting,
escaping-context annotation and live diagnostics — considerably more than
GitHub would — and needs no install. The
[tree-sitter grammar](../tree-sitter-orbit/) covers Neovim, Zed and Helix
today, and the [VS Code extension](../editors/vscode/) covers VS Code. GitHub
is the one surface that requires someone else's approval.

[linguist]: https://github.com/github-linguist/linguist
[criteria]: https://github.com/github-linguist/linguist/blob/main/CONTRIBUTING.md#language-extension-and-filename-usage-requirements
