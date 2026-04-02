# Wish: Fix depends-on parser for parenthetical comments

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-depends-parser` |
| **Date** | 2026-03-17 |

## Summary

The `parseWishGroups()` function in `dispatch.ts` doesn't strip parenthetical comments from `depends-on` values. `depends-on: 1 (must be done first)` is parsed as dependency on group "1 (must be done first)" which doesn't exist. Fix: strip `(...)` from dependency values.

## Scope

### IN
- Strip parenthetical comments from depends-on values in parseWishGroups()
- Handle: `none (comment)`, `1 (comment)`, `Group 1 (comment)`

### OUT
- Changes to other parser logic
- Changes to wish template

## Decisions

| Decision | Rationale |
|----------|-----------|
| Strip `(...)` after parsing, before storing | Simple regex, no impact on other parsing |

## Success Criteria

- [ ] `depends-on: 1 (comment)` parses as dependency on "1"
- [ ] `depends-on: none (comment)` parses as no dependencies
- [ ] `bun run check` passes

## Execution Groups

### Group 1: Fix parser

**Goal:** Strip parenthetical comments from depends-on values.

**Deliverables:**
1. In `src/term-commands/dispatch.ts` `parseWishGroups()`, after parsing depends-on values, strip any `(...)` suffix from each value.
2. Add test case for parenthetical comments.

**Acceptance Criteria:**
- [ ] Parser strips `(...)` from dependency values
- [ ] Test covers the fix

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 2: Validate

**Goal:** Full CI pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1

---

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix parser |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | reviewer | Full validation |

## Files to Create/Modify

```
src/term-commands/dispatch.ts — strip parenthetical comments in parseWishGroups()
src/term-commands/dispatch.test.ts — add test case
```
