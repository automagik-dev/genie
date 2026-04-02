# Wish: Isolated tmux Sessions for Omni-Spawned Agents

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `omni-session-isolation` |
| **Date** | 2026-03-21 |
| **Issues** | genie#684, omni#239 |
| **Blocks** | `automagik-dev/omni#239` (Omni passes `--session` from schemaConfig) |

## Summary

When Omni auto-spawns agents via `genie spawn --session <name>`, the session must be auto-created if it doesn't exist. Currently `ensureTeamWindow()` calls `createWindow()` which fails if the target tmux session hasn't been created yet. This is the only genie-side blocker for omni#239 — the `--session` flag already exists, it just can't create new sessions.

## Scope

### IN
- Auto-create tmux session in `ensureTeamWindow()` when session doesn't exist
- Verify `genie spawn agent --session claudia-whatsapp --team claudia-chat123` creates session + window
- Verify idempotency: second spawn to same session creates a new window, not a new session
- Add test coverage for session auto-creation path
- Close genie#684 and unblock omni#239

### OUT
- No worktree isolation (future scope — separate wish)
- No `--sandbox` mode (future scope)
- No changes to Omni (that's omni#239, a separate PR)
- No changes to `--session` flag parsing (already works)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Auto-create in `ensureTeamWindow` | Single point of change. All spawn paths flow through this function. |
| Use existing `createSession()` | Already handles `new-session -d -s`. No new tmux logic needed. |
| No new CLI flags | `--session` already exists. Just making it work for non-existent sessions. |

## Success Criteria

- [ ] `genie spawn agent --session new-session-name --team test` creates session `new-session-name` if absent
- [ ] Second `genie spawn` to same session adds a window, doesn't error
- [ ] Existing behavior unchanged when `--session` points to an existing session
- [ ] `tmux list-sessions` shows the auto-created session after spawn
- [ ] `bun run check` passes (932+ tests, 0 failures)
- [ ] genie#684 closeable

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Auto-create session in ensureTeamWindow + tests |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review changes |

## Execution Groups

### Group 1: Auto-create session in ensureTeamWindow

**Goal:** Make `ensureTeamWindow()` auto-create the target tmux session when it doesn't exist.

**Deliverables:**

1. In `src/lib/tmux.ts` → `ensureTeamWindow()`:
   - Before calling `createWindow()`, check if the session exists via `findSessionByName(session)`
   - If session doesn't exist, call `createSession(session)` first
   - Then proceed to `createWindow()` as normal
   - The change is ~4 lines:
     ```typescript
     // Auto-create session if it doesn't exist (enables --session with new session names)
     const sessionExists = await findSessionByName(session);
     if (!sessionExists) {
       await createSession(session);
     }
     ```

2. Add test in `src/lib/tmux.test.ts` (or new file if no tmux tests exist):
   - Test: `ensureTeamWindow` with non-existent session creates it
   - Test: `ensureTeamWindow` with existing session reuses it
   - Note: tmux tests require real tmux, so use conditional skip if not available

3. Verify E2E:
   ```bash
   genie spawn engineer --session test-isolation --team test-iso-team --cwd /tmp
   tmux list-sessions | grep test-isolation
   tmux kill-session -t test-isolation
   ```

**Acceptance Criteria:**
- [ ] `ensureTeamWindow('nonexistent', 'team')` creates session + window
- [ ] `ensureTeamWindow('existing', 'team')` creates window only (no duplicate session)
- [ ] No regressions in existing spawn behavior

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

## QA Criteria

- [ ] `bun run check` passes
- [ ] `genie spawn agent --session brand-new-session --team test` works end-to-end
- [ ] `tmux list-sessions` confirms session was created
- [ ] Existing spawn without `--session` still works

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| tmux not running when session created | Low | `createSession` starts detached session — works without attached client |
| Race condition: parallel spawns to same new session | Low | `createSession` is idempotent (tmux ignores duplicate session names) |
| Tests require tmux in CI | Medium | Skip tmux E2E tests when tmux unavailable; unit test the logic flow |

## Files to Create/Modify

```
src/lib/tmux.ts    — add session auto-creation in ensureTeamWindow (~4 lines)
```
