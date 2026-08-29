# Brainstorm: Genie dual-mode Orca plugin

**Status:** DRAFT — amended four-document planning set pending fresh independent review and evidence stamp.

Option A preserves Genie's current standalone lifecycle while adding an explicit Orca mode in which Orca is
the sole lifecycle authority. The amended design fixes the boundary at Orca's public
`orca orchestration ... --json` CLI, rejects local lifecycle fallback or mirroring, and retires Genie MCP only
after authority guards, adapter parity, plugin lifecycle, packaging, and documentation are green.

This DRAFT, [DESIGN.md](DESIGN.md), [WISH.md](../../wishes/genie-dual-mode-orca-plugin/WISH.md), and the
[INDEX entry](../../INDEX.md) are the four canonical planning documents. They remain a pending-review candidate:
no prior review or approval authorizes implementation, a documentation PR, or release work. Historical v6/Corpo
Leve artifacts are evidence, not implementation input.
