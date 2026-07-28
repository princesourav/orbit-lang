# Orbit trademark policy

**Draft.** This states the intent. It has not been reviewed by a lawyer, and no
mark is currently registered.

## Why this file exists at all

Apache-2.0 grants copyright and patent rights. It explicitly does **not** grant
trademark rights — [section 6](https://www.apache.org/licenses/LICENSE-2.0)
says so. A project that ships Apache-2.0 with no trademark statement leaves
everyone guessing about what they may call their fork, and the guessing usually
resolves in favour of whoever is most confident.

The goal here is narrow: keep "Orbit" meaning *this language*, so that "my
template compiles under Orbit" stays a statement someone can rely on. Nothing
in this policy restricts use of the software itself.

## What you may do without asking

- **Use the software.** For anything, commercially or otherwise, per the
  licence.
- **Say what your software does.** "Built with Orbit", "Orbit-compatible",
  "supports Orbit templates", "an Orbit renderer for Go" — all fine, provided
  the statement is accurate.
- **Write about it.** Books, courses, talks, blog posts, comparisons. No
  permission needed, including for criticism.
- **Publish a plugin, tool or integration** with a name that includes Orbit
  descriptively: `orbit-lsp`, `vscode-orbit`, `orbit-rs`. Prefer that shape to
  `Orbit LSP`, which reads as official.
- **Fork it.** Under a different name.

## What needs a different name

- **A fork or modified engine distributed as "Orbit".** If it does not pass the
  [conformance corpus](conformance/), calling it Orbit makes the name useless
  to everyone else. Call it something else and say it is derived from Orbit.
- **Claiming to be official.** "The Orbit Foundation", "Orbit Inc", "Orbit
  Certified" — none of those exist.
- **A logo or name confusingly similar** to the project's.
- **Republishing on npm under a name a user would take for the original.**

## "Orbit-compatible"

Use it when your implementation passes the conformance corpus, and say which
version it passed. If it passes a subset, say which — "passes 94% of the Orbit
conformance corpus v1" is a useful, honest claim and this policy encourages it.

Do not use it for something that has never run the corpus. That is the one use
that actively degrades the term for everyone.

## The name

"Orbit" is a common English word and is used by many unrelated projects and
companies. This policy claims nothing beyond the template-language context, and
no confusion is intended with any other use.

## Questions

Open an issue. Requests to use the name in a way this document does not cover
are usually granted; asking is mostly a formality that lets the answer be
recorded in public.
