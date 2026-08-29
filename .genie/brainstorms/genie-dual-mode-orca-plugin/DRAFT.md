# Brainstorm: Genie dual-mode Orca plugin

**Status:** APPROVED — design and plan SHIP on 2026-08-29; digest-bound independent evidence stamped.

Option A preserves Genie's current standalone lifecycle while adding an explicit Orca mode in which Orca is
the sole lifecycle authority. The amended design fixes the boundary at Orca's public
`orca orchestration ... --json` CLI, rejects local lifecycle fallback or mirroring, and retires Genie MCP only
after authority guards, adapter parity, plugin lifecycle, packaging, and documentation are green.

This DRAFT, [DESIGN.md](DESIGN.md), [WISH.md](../../wishes/genie-dual-mode-orca-plugin/WISH.md), and the
[INDEX entry](../../INDEX.md) are the four canonical planning documents. Independent reviewer
`term_fb7838bc-745e-45ba-9d62-becc5d842e07` returned SHIP at `2026-08-29T17:57:45Z` for reviewable DESIGN
SHA-256 `1b8b6c034310fab2699214866893658a4c041d9269a971bb685d57bc359f7dfe` and the consistent four-document
pending-to-approved lifecycle. Historical v6/Corpo Leve artifacts are evidence, not implementation input.
