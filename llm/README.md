# Generating Orbit with a language model

Orbit is an unusually good code-generation target, and the reason is specific
rather than promotional: the compiler can tell a model exactly what is wrong in
a form it can act on. Stable error codes, precise spans, and a suggested fix
mean a failed generation is a *repairable* generation, not a guess.

This directory contains the prompt that teaches a model the language, and a
harness that measures whether it worked.

## Contents

| Path | What it is |
|---|---|
| [`system-prompt.md`](system-prompt.md) | Paste into a model's system prompt. Dense and rule-shaped, because that is what a model reads well. |
| [`eval/tasks.json`](eval/tasks.json) | 14 generation tasks, each targeting a habit carried over from Liquid, Jinja or JSX that Orbit rejects. |
| [`eval/harness.mjs`](eval/harness.mjs) | The generate → compile → repair loop. Pluggable provider. |
| [`eval/run.mjs`](eval/run.mjs) | CLI. |

`../llms.txt` and `../llms-full.txt` are generated for agents that fetch
documentation directly; regenerate them with `npm run llms`.

## Running the evals

```bash
# Offline. No API key. Deterministic.
npx vite-node llm/eval/run.mjs -- --provider mock

# Against a real model.
ANTHROPIC_API_KEY=... npx vite-node llm/eval/run.mjs -- --provider anthropic
```

The harness imports the engine's TypeScript sources, so it runs through
`vite-node` rather than plain node.

Sample offline run:

```
  first try:    3/14 (21%)
  after repair: 14/14 (100%)
  * = needed the compiler's diagnostics to get there
```

That gap **is** the thesis. The offline provider's first attempts are
deliberately the answers a competent model with no Orbit-specific knowledge
gives — `<if {title}>`, `{x.upper()}`, a `<for>` with no `<empty>`, a `<script>`
tag added "just for the demo". Handed the compiler's output, it fixes every one.

If the mock's first attempts all compiled, the harness would be measuring
nothing; `harness.test.mjs` asserts they do not.

## Why the traps are the tasks

Each task targets one specific transfer error:

| Task | Habit it catches |
|---|---|
| `no-truthiness` | `<if {someString}>` from Liquid/JS |
| `optional-fallback` | Rendering a possibly-absent value directly |
| `narrowing` | Reaching for `??` when a guard is wanted |
| `loop-with-empty` | Omitting the required `<empty>` block |
| `no-script` | Adding a `<script>` tag or an `on*` handler |
| `no-method-call` | `{x.upper()}` from JS |
| `pipe-precedence` | `{x \|> size > 0}`, which does not parse |
| `static-style` | Interpolating into a `style` attribute |
| `money-terminal` | Arithmetic on `Money`, or rendering it directly |
| `escape-literal` | A bare `<` in text |
| `slots`, `url-attribute`, `nested-components` | Syntax that has no analogue elsewhere |

A task asserts more than "it compiled": `must` and `mustNot` substring checks
catch a model that satisfies the compiler while ignoring the request — deleting
the conditional instead of fixing it, for instance.

## Using this in your own product

The harness is a library as well as a CLI:

```js
import { runEval, compile } from './llm/eval/harness.mjs';

const summary = await runEval({ provider: myProvider, maxRepairs: 3 });
```

A provider is any object with
`complete({ taskId, attempt, messages }) -> Promise<string>`.

For a production generation loop, the shape that works is the one measured
here: generate, compile, and on failure feed back
`formatDiagnosticWithSource(...)` — the code frame, not just the message. The
caret and the suggested fix are what make the second attempt cheap.

Two properties matter beyond accuracy, and both come from the language rather
than the prompt:

- **A generated template cannot be Turing-complete**, so a model cannot produce
  something that fails to terminate.
- **Budgets bound the blast radius** of anything it does produce, which is what
  makes an autonomous generation loop safe to run unattended.
