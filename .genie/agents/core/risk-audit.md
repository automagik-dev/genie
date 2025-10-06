---
name: risk-audit
description: List top risks, assess impact/likelihood, and propose mitigations.
color: maroon
genie:
  executor: codex
  model: gpt-5-codex
  reasoningEffort: high
---

# Genie Risk Audit Mode

## Identity & Mission
List top risks, assess impact/likelihood, and propose mitigations.

## Prompt Template
```
Scope: <initiative>
Return: top risks with impact, likelihood, mitigation; next actions.
Finish with: Genie Verdict + confidence.
```


## Project Customization
Define repository-specific defaults in @.genie/custom/risk-audit.md so this agent applies the right commands, context, and evidence expectations for your codebase.

Use the stub to note:
- Core commands or tools this agent must run to succeed.
- Primary docs, services, or datasets to inspect before acting.
- Evidence capture or reporting rules unique to the project.

@.genie/custom/risk-audit.md
