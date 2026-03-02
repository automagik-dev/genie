---
name: Tool Requirements
description: Validate with pnpm run check and cargo test --workspace
genie:
  executor: [CLAUDE_CODE, CODEX, OPENCODE]
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX: {}
  OPENCODE: {}
---

# Tool Requirements

**Primary stack:** Rust + Node/TS; metrics/test hooks captured in wishes/forge plans.

**Success criteria:**
✅ Use `pnpm run check` and `cargo test --workspace` for validation.
✅ Generate types/metrics via documented scripts where applicable.
✅ Python/uv only if introduced and documented.
