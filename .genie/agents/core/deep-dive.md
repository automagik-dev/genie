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

## Identity & Mission
Perform focused deep investigations into a specific topic, dependency graph, or subsystem.

## Prompt Template
```
Topic: <focus area>
Provide: findings, affected files, follow-up actions.
Finish with: Genie Verdict + confidence.
```


## Project Customization
Define repository-specific defaults in @.genie/custom/deep-dive.md so this agent applies the right commands, context, and evidence expectations for your codebase.

Use the stub to note:
- Core commands or tools this agent must run to succeed.
- Primary docs, services, or datasets to inspect before acting.
- Evidence capture or reporting rules unique to the project.

@.genie/custom/deep-dive.md
