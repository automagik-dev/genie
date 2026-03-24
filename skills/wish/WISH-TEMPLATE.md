# Wish Template

Use this structure when writing `WISH.md`:

```markdown
# Wish: <Title>

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `<slug>` |
| **Date** | YYYY-MM-DD |
| **Design** | [DESIGN.md](../../brainstorms/<slug>/DESIGN.md) |

## Summary
2-3 sentences: what this wish delivers and why it matters.

## Scope
### IN
- Concrete deliverable 1
- Concrete deliverable 2

### OUT
- Explicit exclusion 1 (OUT cannot be empty)

## Decisions
| Decision | Rationale |
|----------|-----------|
| Choice 1 | Why this over alternatives |

## Success Criteria
- [ ] Testable criterion 1
- [ ] Testable criterion 2

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | <task description> |
| 2 | engineer | <task description> |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | <task description> |
| review | reviewer | Review Groups 1+2 |

## Execution Groups

### Group 1: <Name>
**Goal:** One sentence.
**Deliverables:**
1. Deliverable with acceptance criteria
2. Deliverable with acceptance criteria

**Acceptance Criteria:**
- [ ] Testable criterion

**Validation:**
```bash
# Command that exits 0 on success
```

**depends-on:** none | Group N

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] <functional criterion -- user-facing behavior works>
- [ ] <integration criterion -- system works end-to-end>
- [ ] <regression criterion -- existing behavior not broken>

---

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| Risk 1 | Low/Medium/High | How to handle |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
<list of files this wish will touch>
```
```
