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

## Simplicity Case

- **Simplest complete design:** <TODO: smallest design that satisfies current user stories>
- **Added machinery:** <TODO: none, or each mechanism and the present evidence that requires it>
- **Deferred until measured:** <TODO: future complexity and its concrete adoption trigger>
- **Complexity removed:** <TODO: states, failure modes, options, or dependencies deliberately avoided>

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
| 1 | engineer | <TODO: risk + rationale> | inherit | <TODO: task description> |

**Global constraints:** <TODO: the plan-wide requirements every group inherits — version floors, dependency limits, naming and interface rules, platform requirements — one line each, values copied verbatim from the source they come from. Use `none` only when there are genuinely none.>

Describe each group’s coupling and risk in **Complexity**. In **Model**, inherit the active model unless user instructions or an evidenced capacity need justify another supported runtime configuration. Use portable role names; keep actual model/effort settings in the runtime. Order groups by dependencies and give parallel writers disjoint files or isolated worktrees.

## Execution Groups

### Group 1: <TODO: Group 1 title>

**Goal:** <TODO: one-sentence goal for Group 1.>

**Deliverables:**
1. <TODO: deliverable 1>
2. <TODO: deliverable 2>

**Interfaces:**
- Consumes: <TODO: exact signatures this group takes from earlier groups, or `none`>
- Produces: <TODO: exact names and types later groups rely on, or `none`. A group's worker sees only its own group; this block is how it learns the neighbouring shapes.>

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
