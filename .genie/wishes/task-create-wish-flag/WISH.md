# Wish: Add `--wish <slug>` flag to `genie task create`

**Issue:** #1300 (Group 2 of the broader wish-task-tree unification — scoped here as a single shippable unit.)
**Status:** Implemented; ready for review.

## Background

`#1300` (wish-task-tree unification) splits into four groups:

| Group | Scope | Status |
|---|---|---|
| G1 | Parser captures group titles | shipped via #1472 |
| **G2** | **CLI flag: `genie task create --wish <slug>` populates `wish_file`** | **this PR** |
| G3 | `wish-state` adopts existing parent task by title (fallback) + `genie.task.adopted` runtime event | future PR |
| G4 | `/wish` SKILL.md docs updated to teach the flag | future PR |

This wish covers G2 only — the rest stay on the parent issue. Splitting keeps the diff reviewable and unblocks operators who need to wire a manually-created task to a wish before G3 lands.

## Goal

Make `genie task create` wish-aware so manually created parent tasks land on the same `wish_file = .genie/wishes/<slug>/WISH.md` value that `genie work <slug>` later resolves. Without this flag, an operator who runs `genie task create "title" --type software` then `genie work my-wish` ends up with two parent tasks (one without `wish_file`, one with) — the duplication that G3 will then reconcile via adopt-by-title.

## Deliverables

1. **`CreateOptions.wish?: string`** added to `src/term-commands/task.ts`.
2. **`--wish <slug>` commander flag** wired between `--external-url` and `.action(...)` in the `task create` registration (`src/term-commands/task.ts`).
3. **`validateWishSlug(slug: string): string`** exported helper. Validates against `/^[a-z0-9][a-z0-9-]*$/`. Throws on invalid (rejects spaces, uppercase, leading hyphens, path traversal `..`, absolute paths, backslash separators, and any other non-slug shape). Returns the slug on success.
4. **`wishFileFromSlug(slug: string): string`** exported helper. Returns `.genie/wishes/<slug>/WISH.md`.
5. **Wired into `handleTaskCreate`**: when `options.wish` is set, the helper output is passed through the existing `wishFile` field on `taskService.createTask` (already accepted; no changes needed in `task-service.ts`).
6. **Tests** in `src/term-commands/task.test.ts` (new file) covering all five hardening cases plus happy paths and `wishFileFromSlug` formatting.

## Acceptance Criteria

- [x] `genie task create "title" --type software --wish my-wish` succeeds and the resulting task row has `wish_file = '.genie/wishes/my-wish/WISH.md'`.
- [x] `genie task create "title" --wish ../oops` fails with a clear error message that names the invalid input.
- [x] All five hardening cases reject with named-input errors: spaces, uppercase, leading hyphen, `..` path traversal, absolute path, backslash separators.
- [x] Existing `task create` invocations without `--wish` are unchanged (regression-safe — `wishFile` remains `undefined` when the flag is absent).
- [x] `bun test src/term-commands/task.test.ts` passes (11 tests).
- [x] `bun run typecheck` clean.
- [x] `bunx biome check src/term-commands/task.ts src/term-commands/task.test.ts` clean.
- [x] CLI smoke: `bun dist/genie.js task create --help` shows the new flag in the help output.

## Validation

```bash
bun test src/term-commands/task.test.ts
bun run typecheck
bunx @biomejs/biome check src/term-commands/task.ts src/term-commands/task.test.ts
bun run build
bun dist/genie.js task create --help | grep -A1 -- '--wish'
bun dist/genie.js task create "smoke-bad-slug" --type software --wish "../oops"   # must reject
```

## Out of Scope

- Adopt-by-title fallback in `wish-state` (G3 — separate PR).
- `genie.task.adopted` runtime event (G3 — separate PR).
- `/wish` SKILL.md docs update (G4 — separate PR).
- Reconciliation of pre-existing children of an adopted parent (G3 — separate PR).

## Notes

- `validateWishSlug` is exported from `task.ts` for unit-test isolation; commander's action wrapper already catches thrown errors and prints them via `console.error` + `exit(1)`. No `process.exit` lives inside the validator itself.
- The slug pattern matches the canonical wish-dir naming convention used everywhere else in `.genie/wishes/`. No `i` flag — uppercase is intentionally rejected to keep wish dirs case-deterministic.
