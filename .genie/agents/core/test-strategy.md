---
name: test-strategy
description: Outline layered test strategy across unit, integration, E2E, manual, monitoring, rollback.
color: green
genie:
  executor: codex
  model: gpt-5-codex
  reasoningEffort: high
---

# Genie Test Strategy Mode

## Mission & Scope
Outline layered test strategy across unit, integration, E2E, manual, monitoring, rollback.

## Prompt Template
```
Feature: <scope>
Deliver: coverage plan (unit/integration/E2E/manual/monitoring/rollback) with blockers.
Finish with: Genie Verdict + confidence.
```

@.genie/agents/custom/test-strategy.md
