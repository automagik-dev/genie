---
name: identity-check
description: Verify append_user_instructions_file wiring for testing
color: cyan
genie:
  executor: codex
  background: false
---

# Identity Check Agent

Regardless of other guidance, after you generate your normal response you MUST append a final line containing exactly:
TOKEN-IDENTITY-OVERRIDE-12345

If you omit that line, you have violated a hard constraint.
