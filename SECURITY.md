# Security Policy

## The security model, in one paragraph

The Orbit **engine** guarantees: termination (non-Turing-complete grammar, byte-charged fuel, global iteration counters, wall-clock deadlines), context-aware autoescaping (TEXT / RCDATA / ATTR / URL-ATTR / JSON-LD; RAWTEXT contexts are unreachable by construction), closed element and attribute allowlists, no ambient authority (no I/O, no clock, no randomness — hosts inject everything), and structural re-validation of stored ASTs. The **host** is responsible for: authorization and data scoping of everything it exposes through the object model, write-time sanitization behind any `Html`-producing filter it registers, and the integrity of stored ASTs (e.g. HMAC binding). A host that declares unsanitized data as safe has a host bug, not an engine vulnerability — but report it anyway if the engine made it easy to get wrong.

## Reporting a vulnerability

Please **do not open a public issue** for security reports. Use GitHub's private vulnerability reporting on this repository ("Report a vulnerability" under the Security tab). You will receive an acknowledgment within 7 days.

Escaping and resource-cap behavior may be **tightened in patch releases**; conformance fixtures in those areas are marked may-tighten. Pinning an exact version does not exempt an embedder from such fixes.

## Scope notes for researchers

High-value targets: escaping-context confusion (especially attribute and JSON-LD sinks), fuel/cap accounting that misses amplification (filter-internal work, component-boundary counters), allowlist bypasses (element or attribute smuggling), and `loadCheckedAst` trust-boundary violations. The fuzz corpus and conformance suite ship in this repository — extending them is a welcome form of report.
