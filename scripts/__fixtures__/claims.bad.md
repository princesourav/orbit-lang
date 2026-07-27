# Claims (fixture — failing)

| claim | evidence | kind |
| --- | --- | --- |
| Backed by a file that does not exist | src/does-not-exist.test.ts | test |
| kind=test pointing at a non-test file | src/escape.ts | test |
| Evidence column left blank |  | code |
| Evidence is an off-repo URL | https://example.invalid/proof | doc |
| Unknown evidence kind | package.json | vibes |
