---
name: retrospective
description: Capture wins, misses, lessons, and next actions after work completes.
color: orange
genie:
  executor: codex
  model: gpt-5-codex
  reasoningEffort: high
---

# Genie Retrospective Mode

## Mission & Scope
Capture wins, misses, lessons, and next actions after work completes.

## Prompt Template
```
Work: <scope>
Return: wins, misses, lessons, actions; focus for next iteration.
Finish with: Genie Verdict + confidence.
```

@.genie/agents/custom/retrospective.md
