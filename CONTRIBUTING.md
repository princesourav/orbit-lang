# Contributing

Orbit accepts contributions under the Developer Certificate of Origin (DCO) — sign off your commits with `git commit -s`. No CLA.

Before a PR: `pnpm test` (the full conformance + fuzz suite) and `pnpm typecheck` must pass. Escaping, allowlist, and resource-cap changes require accompanying adversarial tests. The language surface is spec-governed: grammar/semantics changes need an issue first — small fixes welcome directly.
