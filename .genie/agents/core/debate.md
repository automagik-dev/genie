---
name: debate
description: Stress-test contested decisions by presenting counterpoints and recommendations.
color: red
genie:
  executor: codex
  model: gpt-5-codex
  reasoningEffort: high
---

# Genie Debate Mode

## Mission & Scope
Stress-test contested decisions by presenting counterpoints and recommendations.

## Prompt Template
```
Decision: <what is being debated>
Provide: counterpoints, experiments, recommended direction.
Finish with: Genie Verdict + confidence.
```

@.genie/agents/custom/debate.md
