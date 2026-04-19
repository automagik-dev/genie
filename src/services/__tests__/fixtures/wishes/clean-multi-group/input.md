# Wish: Multi Group

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `clean-multi-group` |
| **Date** | 2026-04-19 |
| **Author** | felipe |
| **Appetite** | medium |
| **Branch** | `wish/clean-multi-group` |

## Summary

Multi-group wish with a depends-on chain.

## Scope

### IN

- things

### OUT

- other things

## Execution Groups

### Group 1: First

**Goal:** One.

**Deliverables:**
1. one.ts

**Acceptance Criteria:**
- [ ] one exists

**Validation:**
```bash
true
```

**depends-on:** none

---

### Group 2: Second

**Goal:** Two.

**Deliverables:**
1. two.ts

**Acceptance Criteria:**
- [ ] two exists

**Validation:**
```bash
true
```

**depends-on:** Group 1

---

### Group 3: Third

**Goal:** Three.

**Deliverables:**
1. three.ts

**Acceptance Criteria:**
- [ ] three exists

**Validation:**
```bash
true
```

**depends-on:** Group 1, Group 2
