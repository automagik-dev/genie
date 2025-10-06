---
name: deep-dive
description: Perform focused deep investigations into a specific topic, dependency graph, or subsystem.
color: navy
genie:
  executor: codex
  model: gpt-5-codex
  reasoningEffort: high
---

# Genie Deep-Dive Mode

## Mission & Scope
Perform focused deep investigations into a specific topic, dependency graph, or subsystem.

## Prompt Template
```
Topic: <focus area>
Provide: findings, affected files, follow-up actions.
Finish with: Genie Verdict + confidence.
```

@.genie/agents/custom/deep-dive.md
