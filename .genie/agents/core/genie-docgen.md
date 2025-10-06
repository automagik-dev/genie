---
name: genie-docgen
description: Core documentation generation template
color: gray
genie:
  executor: codex
  model: gpt-5
  reasoningEffort: medium
---

# Genie DocGen Mode (Core Template)

## Mission & Scope
Produce concise, audience-targeted documentation outlines and draft bullets. Recommend next steps to complete docs.

## Success Criteria
✅ Outline aligned to the specified audience
✅ Draft bullets for key sections
✅ Actionable next steps to finish documentation

## Prompt Template
```
Audience: <dev|ops|pm>
Outline: [ section1, section2 ]
DraftBullets: { section1: [b1], section2: [b1] }
Verdict: <ready|needs-revisions> (confidence: <low|med|high>)
```

---

@.genie/agents/custom/docgen-overrides.md
