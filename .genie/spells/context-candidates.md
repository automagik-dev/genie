---
name: Context Candidates (ACE‑style)
description: Generate 2–3 task‑conditioned context variants, evaluate, and select under budget
---

# Context Candidates – Agentic Context Engineering Pattern

Goal: Before committing to a single context pack, propose 2–3 viable variants, evaluate quickly, and select the best tradeoff of quality, tokens, and latency.

When to use:
- New wish creation or major context refresh
- Uncertain retrieval scope or compression level
- Performance or token constraints are tight

Protocol:
1) Propose Candidates
- Build 2–3 variants with different knobs:
  - Retrieval scope: narrow vs broad
  - Compression: extractive vs abstractive
  - Structure: order, grouping, summaries first vs full refs
  - Cost target: low/med/high token budgets
- Output structure:
```
<context_candidates>
- id: C1
  budget: low|med|high
  ingredients: [@file, @doc, session, summary]
  assembly: steps (filter/merge/summarize/reorder)
  rationale: one line
- id: C2
  ...
- id: C3
  ...
</context_candidates>
```

2) Evaluate Quickly
- Use cheap, task‑appropriate checks (pick 1–2):
  - Answerability probe (can we answer the core question?)
  - Coverage checklist (all required sections present?)
  - Sanity metrics (duplication, staleness, token size)
- Score each as 0–1 on dimensions:
```
<context_scores>
- id: C1
  quality: 0.0–1.0
  cost: tokens or rough band (low/med/high)
  latency: seconds (if known) or band
  notes: brief observation
- id: C2 ...
</context_scores>
```

3) Select and Commit
- Pick winner by quality first, then cost/latency
- Record selection + reason and proceed with the winner only
```
<selection>
  winner: C2
  reason: brief tradeoff statement
</selection>
```

4) Record in Wish Markdown
- In the wish file's "Context Variants Considered" section, list candidates (C1/C2/C3), brief scores, and the selected winner with a one‑line reason.

Promotion (Durable Learning):
- If a recipe repeatedly wins for a task archetype, synthesize a tiny, reusable spell capturing the recipe (ingredients + assembly) and commit to `.genie/spells/`.

Notes:
- Keep candidate generation within a single neuron/agent attempt when possible.
- For heavier checks, create subtasks per candidate via `mcp__genie__create_subtask` and aggregate scores back.
