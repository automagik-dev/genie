# Wish: Validation Not Fenced

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `validation-not-fenced` |
| **Date** | 2026-04-19 |
| **Author** | felipe |
| **Appetite** | small |
| **Branch** | `wish/validation-not-fenced` |

## Summary

Validation block contains commands as plain prose — no ```bash fence.

## Scope

### IN

- thing

### OUT

- other

## Execution Groups

### Group 1: Fence Missing

**Goal:** Make the widget.

**Deliverables:**
1. widget.ts

**Acceptance Criteria:**
- [ ] widget.ts exists

**Validation:**
```bash
echo running tests
test -f widget.ts
```

**depends-on:** none
