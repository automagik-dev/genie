# Wish: <TODO: Title>

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `{{slug}}` |
| **Date** | {{date}} |
| **Author** | <TODO: author> |
| **Appetite** | <TODO: small \| medium \| large> |
| **Branch** | `wish/{{slug}}` |
| **Repos touched** | <TODO: repos> |
| **Design** | _No brainstorm — direct wish_ |

## Summary

<TODO: 2–3 sentences. What this wish delivers and why it matters.>

## Scope

### IN

- <TODO: concrete deliverable 1>
- <TODO: concrete deliverable 2>

### OUT

- <TODO: explicit exclusion — OUT must contain at least one bullet>

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | <TODO: decision> | <TODO: why this over alternatives> |

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] <TODO: testable criterion 1>
- [ ] <TODO: testable criterion 2>

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | <TODO: score + rationale> | <TODO: route> | <TODO: task description> |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Codex maps these to
the `genie_*` profiles; other runtimes use their matching native roles. Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: <TODO: Group 1 title>

**Goal:** <TODO: one-sentence goal for Group 1.>

**Deliverables:**
1. <TODO: deliverable 1>
2. <TODO: deliverable 2>

**Acceptance Criteria:**
- [ ] <TODO: testable acceptance criterion>

**Validation:**
```bash
# TODO: command that exits 0 on success
echo "replace with real validation"
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] <TODO: functional criterion — user-facing behavior works>
- [ ] <TODO: integration criterion — system works end-to-end>
- [ ] <TODO: regression criterion — existing behavior not broken>

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| <TODO: risk> | <TODO: Low \| Medium \| High> | <TODO: how to handle> |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

---

## Files to Create/Modify

```
# TODO: list files this wish will touch
```
