# Brainstorm: Genie dual-mode Orca plugin

**Status:** APPROVED — independent review SHIP at `2026-08-29T18:13:16Z`.

Option A preserves Genie's current standalone lifecycle while adding an explicit Orca mode in which Orca is
the sole lifecycle authority. The current design fixes the boundary at Orca's public
`orca orchestration ... --json` CLI, rejects local lifecycle fallback or mirroring, and retires Genie MCP only
after authority guards, adapter parity, plugin lifecycle, packaging, and documentation are green.

This DRAFT, [DESIGN.md](DESIGN.md), [WISH.md](../../wishes/genie-dual-mode-orca-plugin/WISH.md), and the
[INDEX entry](../../INDEX.md) are the four canonical planning documents. Current reviewable DESIGN SHA-256
`2499668e81fe3d3f3f7f15bac0246c3e0647a036e9441fa882dcf6a8ecb92bf9` was independently reviewed SHIP by
`term_6c98a3c8-7ac8-4274-a8e9-ade35e2d82dd` at `2026-08-29T18:13:16Z`; the four-document plan is approved and
A1–A7 are authorized in the recorded dependency order. The earlier 2026-08-29 SHIP review by
`term_fb7838bc-745e-45ba-9d62-becc5d842e07` at `2026-08-29T17:57:45Z` covered superseded digest
`1b8b6c034310fab2699214866893658a4c041d9269a971bb685d57bc359f7dfe` and is retained only as historical
evidence; it does not approve the current four-document set. Historical v6/Corpo Leve artifacts are evidence,
not implementation input.
