---
name: Context Critic (Lightweight Evaluator)
description: Score candidate contexts on answerability, coverage, and cost quickly
---

# Context Critic – Quick Scoring Heuristics

Purpose: Provide a cheap, fast evaluator to compare 2–3 context candidates before selection.

Scoring Dimensions (0.0–1.0 each):
- quality: Is the context sufficient to complete the immediate task? (answerability probe, clarity)
- coverage: Does it include required sections/files/constraints? (checklist tally)
- redundancy: Penalize duplication and irrelevant material
- cost: Normalized inverse token estimate (lower tokens → higher score)
- latency: Optional, if measurable during probes

Procedure:
1) Answerability Probe (quality)
- Attempt to answer the core question or draft the key section from each candidate; judge confidence.

2) Coverage Checklist (coverage)
- Compare against known required items (wish template sections, mandatory refs, constraints).

3) Redundancy Pass (redundancy)
- Note duplicated sections, stale copies, or unnecessary full texts; penalize.

4) Cost Estimate (cost)
- Rough token count bands: low(<2k), med(2–6k), high(>6k); invert to 0–1.

Output structure per candidate:
```
<critic_scores>
- id: C1
  quality: 0.85
  coverage: 0.90
  redundancy: 0.20
  cost: 0.70
  latency: low|med|high
  notes: one line
- id: C2 ...
</critic_scores>
```

Selection Guidance:
- Prefer higher quality and coverage first.
- Break ties by (1) lower redundancy, (2) lower cost, (3) lower latency.

Integration:
- Use inline within neuron/agent prompts after `<context_candidates>`.
- For heavier evaluation (e.g., run tests), spawn subtasks per candidate and summarize back.

