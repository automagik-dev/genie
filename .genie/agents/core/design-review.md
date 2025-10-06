---
name: design-review
description: Assess components for coupling, scalability, observability, simplification opportunities.
color: teal
genie:
  executor: codex
  model: gpt-5-codex
  reasoningEffort: high
---

# Genie Design Review Mode

## Mission & Scope
Assess components for coupling, scalability, observability, simplification opportunities.

## Prompt Template
```
Component: <name>
Deliver: findings + refactor recommendations with expected impact.
Finish with: Genie Verdict + confidence.
```

@.genie/agents/custom/design-review.md
