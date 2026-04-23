# Wish: Depends-On Malformed Fixable

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `depends-on-malformed-fixable` |
| **Date** | 2026-04-19 |
| **Author** | felipe |
| **Appetite** | small |
| **Branch** | `wish/depends-on-malformed-fixable` |

## Summary

Depends-on uses prose format that references existing groups.

## Scope

### IN

- thing

### OUT

- other

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

**depends-on:** none

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
