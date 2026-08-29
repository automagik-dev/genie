# Brainstorm: Genie dual-mode Orca plugin

**Status:** amended-DRAFT — pending fresh independent review after a substantive post-stamp correction.

Option A preserves Genie's current standalone lifecycle while adding an explicit Orca mode in which Orca is
the sole lifecycle authority. The amended design fixes the boundary at Orca's public
`orca orchestration ... --json` CLI, rejects local lifecycle fallback or mirroring, and retires Genie MCP only
after authority guards, adapter parity, plugin lifecycle, packaging, and documentation are green.

This DRAFT, [DESIGN.md](DESIGN.md), [WISH.md](../../wishes/genie-dual-mode-orca-plugin/WISH.md), and the
[INDEX entry](../../INDEX.md) are the four canonical planning documents. Their amended DESIGN candidate digest is
`1b8b6c034310fab2699214866893658a4c041d9269a971bb685d57bc359f7dfe`; fresh independent review and a new
evidence stamp are required before lifecycle advancement. The prior
stamp by reviewer `term_e6f3cbf4-2e03-4a62-9a72-54812cc92394` at `2026-08-29T17:47:21Z` for digest
`99b71f578979363b2f582d346c786de077fc0f08fc2fe8920f06d01367642e36` is superseded and grants no authority.
Historical v6/Corpo Leve artifacts are evidence, not implementation input.
