# Claims (fixture — passing)

Prose above the table is ignored, even when it contains a | pipe character.

| claim | evidence | kind |
| --- | --- | --- |
| Escaping is assigned structurally, in six contexts | src/escape.test.ts | test |
| The interpreter is fuel-metered | `src/interpreter.test.ts` | test |
| Element and attribute allowlists are closed | [allowlists](src/allowlists.ts) | code |
| The engine declares zero runtime dependencies | package.json | config |

Prose below the table, also ignored.
