# Wish: fix-dispatch-initial-prompt

**Status:** SHIPPED
**Issue:** #745
**Priority:** P0 — blocks all autonomous team execution

## Problem

`genie work` dispatches engineers that spawn idle because the initial task prompt is sent via `protocolRouter.sendMessage` AFTER spawn, which fails silently under concurrent dispatch (4/6 engineers in rlmx got no task). Engineers partially work from system prompt context but never receive completion protocol instructions (`genie done`, `genie send`), so team-lead polls forever.

## Solution

Pass the task prompt as `initialPrompt` to `handleWorkerSpawn` in all dispatch commands. This makes it a positional argument to the `claude` CLI, guaranteeing the agent starts working immediately. This is the same pattern `qa-runner.ts:334` uses successfully.

## Scope

- `src/term-commands/dispatch.ts` — 4 dispatch commands
- `src/term-commands/team.ts` — `spawnLeaderWithWish`

## Acceptance Criteria

1. `workDispatchCommand` passes `initialPrompt` with task instructions to `handleWorkerSpawn`
2. `brainstormCommand` passes `initialPrompt` to `handleWorkerSpawn`
3. `wishCommand` passes `initialPrompt` to `handleWorkerSpawn`
4. `reviewCommand` passes `initialPrompt` to `handleWorkerSpawn`
5. `spawnLeaderWithWish` in team.ts passes `initialPrompt` to `handleWorkerSpawn`
6. Keep existing `protocolRouter.sendMessage` calls as backup, but log warnings on delivery failure
7. All existing tests pass (`bun test`)

## Execution Strategy

### Wave 1 (parallel — all changes are independent)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add `initialPrompt` to all 5 spawn call sites + add delivery result logging |

## Execution Groups

### Group 1: Add initialPrompt to dispatch commands

**Files to modify:**
- `src/term-commands/dispatch.ts`
- `src/term-commands/team.ts`

**Changes:**

1. **`workDispatchCommand` (dispatch.ts ~line 532):** Add `initialPrompt` to the `handleWorkerSpawn` call. The prompt should match what's currently in the `protocolRouter.sendMessage` call (line 541-546).

2. **`brainstormCommand` (dispatch.ts ~line 411):** Add `initialPrompt` with appropriate brainstorm instructions. Match the existing `protocolRouter.sendMessage` call content.

3. **`wishCommand` (dispatch.ts ~line 451):** Add `initialPrompt` with wish planning instructions. Match the existing `protocolRouter.sendMessage` call content.

4. **`reviewCommand` (dispatch.ts ~line 596):** Add `initialPrompt` with review instructions. Match the existing `protocolRouter.sendMessage` call content.

5. **`spawnLeaderWithWish` (team.ts ~line 259):** Add `initialPrompt` with team-lead bootstrapping instructions. Match the existing `protocolRouter.sendMessage` call content.

6. **All dispatch commands:** After each `protocolRouter.sendMessage` call, check the return value and log a warning if `delivered === false`:
```typescript
const result = await protocolRouter.sendMessage(...);
if (!result.delivered) {
  console.warn(`⚠ Backup delivery to ${effectiveRole} failed: ${result.reason ?? 'unknown'}`);
}
```

**Reference implementation:** `src/lib/qa-runner.ts:334` — shows the correct pattern.

**Validation:** `bun test`
