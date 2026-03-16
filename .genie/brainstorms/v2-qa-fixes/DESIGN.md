# Design: Genie v2 QA Fixes

**Slug:** `v2-qa-fixes`
**Date:** 2026-03-14
**Parent wish:** `genie-v2-framework-redesign`

## Summary

Fix 10 issues (#546-#555) found during QA exploration of the v2 redesign. All fixes are scoped to match the original spec — no plan changes, no new features beyond `genie reset` (leader recovery from stuck groups).

## Architecture

### New module: `src/lib/file-lock.ts`

Extracted from the identical pattern in 3 existing modules. Single source of truth.

```typescript
export async function acquireLock(filePath: string): Promise<() => Promise<void>>
export async function withLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T>
```

Constants: `LOCK_TIMEOUT_MS=5000`, `LOCK_RETRY_MS=50`, `LOCK_STALE_MS=10000`

Consumers: `agent-directory.ts`, `wish-state.ts`, `agent-registry.ts`, `mailbox.ts`, `team-chat.ts`

### CWD resolution chain (fixed)

```
options.cwd > teamConfig.worktreePath > entry.dir > process.cwd()
```

### Wish state machine (updated)

```
blocked → ready → in_progress → done
                  in_progress → ready (via resetGroup — leader recovery)
```

No new states. `resetGroup()` clears `assignee`, `startedAt`, sets status back to `ready`.

## Scope

### IN
- Extract shared file-lock utility (#550)
- Fix spawn CWD to use team worktree (#546)
- Add file lock to mailbox (#547)
- Add file lock to team-chat (#555)
- Add cycle detection + dangling dep validation in createState (#548)
- Enforce in_progress before done in completeGroup (#549)
- Add resetGroup() + `genie reset slug#group` CLI (#552)
- Validate team name against git branch rules (#551)
- Make parseWishGroups regex case-insensitive (#554)
- Document getState() lockless read (#553)

### OUT
- New wish state `failed` (replaced by `genie reset`)
- Lock on getState() reads (documented as eventually consistent)
- Changes to any CLI command signatures
- Changes to any module public API (except adding resetGroup)
- Changes to the v2 plan or architecture

## Decisions

| Decision | Rationale |
|----------|-----------|
| Extract file-lock first | Enables #547 and #555 cleanly. DRY. |
| `resetGroup()` not `failGroup()` | Leader recovery is: detect stuck → kill → reset → redeploy. No new state needed. |
| Enforce strict state transitions | Spec says sequential transitions. Prevents orphaned groups with no assignee. |
| Case-insensitive parsing | Robustness. All existing WISH.md files already use correct case. |
| Document lockless reads | Low impact. Adding lock to reads would slow `genie status` for no real benefit. |
| Validate branch names proactively | Opaque git errors are unacceptable. Fail fast with clear message. |

## Execution Groups

### Group 1: Shared File Lock Extraction
- Extract `src/lib/file-lock.ts` from `agent-directory.ts`
- Update `agent-directory.ts`, `wish-state.ts`, `agent-registry.ts` to import from shared module
- Verify all existing tests pass

**depends-on:** none

### Group 2: Concurrency Fixes
- Add file lock to `mailbox.ts` send/markDelivered (#547)
- Add file lock to `team-chat.ts` postMessage (#555)
- Update concurrency tests to verify fixes

**depends-on:** Group 1

### Group 3: Wish State Hardening
- Add cycle detection in `createState()` (#548)
- Add dangling dep validation in `createState()` (#548)
- Enforce `in_progress` before `done` in `completeGroup()` (#549)
- Add `resetGroup()` function (#552)
- Add `genie reset slug#group` CLI command (#552)
- Document lockless `getState()` (#553)
- Update wish-state tests

**depends-on:** Group 1

### Group 4: Spawn & Team Fixes
- Fix CWD resolution in `agents.ts` — add team worktree lookup (#546)
- Add `validateBranchName()` in `team-manager.ts` (#551)
- Make `parseWishGroups()` regex case-insensitive (#554)
- Update relevant tests

**depends-on:** none

### Group 5: Validation
- `bun run check` passes
- `bun run build` succeeds
- All 10 issues verified fixed with tests

**depends-on:** Group 2, Group 3, Group 4

## Success Criteria

- [ ] `src/lib/file-lock.ts` exists, used by 5 modules
- [ ] Concurrent mailbox.send() retains all messages (test C-MB-01 passes)
- [ ] Concurrent team-chat postMessage() retains all messages
- [ ] `createState()` throws on circular deps
- [ ] `createState()` throws on dangling dep references
- [ ] `completeGroup()` throws if group is not `in_progress`
- [ ] `resetGroup()` moves `in_progress` back to `ready`
- [ ] `genie reset slug#group` works from CLI
- [ ] Built-in agent spawn in team uses worktree CWD
- [ ] `genie team create "spaces here"` fails with clear error
- [ ] `parseWishGroups()` handles lowercase `### group N:`
- [ ] `bun run check` exits 0
- [ ] `bun run build` succeeds

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Enforcing strict transitions breaks existing tests | Low | Update tests to call startGroup before completeGroup |
| File lock extraction introduces import path bugs | Low | Typecheck catches all consumers |
| Branch name validation too strict | Low | Use `git check-ref-format --branch` for authoritative validation |
