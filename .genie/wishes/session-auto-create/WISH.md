# Wish: --session flag auto-creates tmux session

Fixes: https://github.com/automagik-dev/genie/issues/691

## Problem

`genie spawn --session <name>` silently falls back to the current tmux session when the target session doesn't exist, instead of creating it.

## Acceptance Criteria

- [ ] `genie spawn engineer --session foo` creates session `foo` if it doesn't exist
- [ ] If session already exists, behavior is unchanged (spawn window inside it)
- [ ] No regression: spawning without `--session` still works in current session

## Execution Groups

### Group A: Auto-create session

**Depends on:** nothing

**Deliverables:**
1. In the tmux spawn logic, before listing windows in the target session, check if the session exists. If not, create it with `tmux new-session -d -s '<session>'`.

**Files likely affected:**
- `src/lib/tmux.ts` or wherever `--session` is handled in spawn logic

**Validation:**
```bash
# Build succeeds
bun run build

# Verify the fix is in the right place
grep -n 'new-session' src/lib/tmux.ts
```
