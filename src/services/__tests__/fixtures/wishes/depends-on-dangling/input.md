# Wish: Depends-On Dangling

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `depends-on-dangling` |
| **Date** | 2026-04-19 |
| **Author** | felipe |
| **Appetite** | small |
| **Branch** | `wish/depends-on-dangling` |

## Summary

Depends-on references a group that does not exist.

## Scope

### IN

- thing

### OUT

- other

## Execution Groups

### Group 1: Do the thing

**Goal:** Make the widget.

**Deliverables:**
1. widget.ts

**Acceptance Criteria:**
- [ ] widget.ts exists

**Validation:**
```bash
test -f widget.ts
```

**depends-on:** Group 99
