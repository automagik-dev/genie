# Brainstorm: Genie dual-mode Orca plugin

**Status:** CRYSTALLIZED into [DESIGN.md](DESIGN.md) on 2026-08-29.

Option A preserves Genie's current standalone lifecycle while adding an explicit Orca mode in which Orca is
the sole lifecycle authority. The amended design fixes the boundary at Orca's public
`orca orchestration ... --json` CLI, rejects local lifecycle fallback or mirroring, and retires Genie MCP only
after authority guards, adapter parity, plugin lifecycle, packaging, and documentation are green.

Canonical execution planning now lives in
[WISH.md](../../wishes/genie-dual-mode-orca-plugin/WISH.md). Historical v6/Corpo Leve artifacts are evidence,
not implementation input.
