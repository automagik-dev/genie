# Wish: Fix agent join delay — readiness signal after spawn

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `fix-agent-join-delay` |
| **Date** | 2026-03-24 |
| **Issues** | #712 |

## Summary

Spawned agents take up to 60s to become ready after `genie spawn`. The team-lead dispatches work immediately but the agent hasn't loaded its context yet, causing messages to be lost or ignored. Add a readiness signal so `genie spawn` can report when the agent is actually ready to receive work, and `genie work` can optionally wait for readiness before dispatching.

## Scope

### IN
- Add readiness detection after spawn (agent pane shows idle/ready state)
- `genie spawn` reports when agent is ready (or times out after configurable threshold)
- `genie work` optionally waits for agent readiness before dispatching context
- Readiness check via tmux pane content inspection (look for idle prompt or tool_use pattern)

### OUT
- No changes to agent prompt content or AGENTS.md format
- No new IPC protocol (use existing tmux pane inspection)
- No changes to Claude Code internals
- No heartbeat/health-check daemon

## Decisions

| Decision | Rationale |
|----------|-----------|
| Detect readiness via pane output | Non-invasive — works with any agent. Claude Code shows characteristic output when ready. |
| Timeout with warning, not failure | Spawn shouldn't fail if readiness detection is slow — agent may still work. |
| Default timeout 30s | Typical agent startup is 5-15s. 30s covers slow starts without excessive waiting. |

## Success Criteria

- [ ] `genie spawn engineer` logs "Agent ready" when pane shows idle state
- [ ] Readiness detected within 30s for typical spawns
- [ ] Timeout after 30s logs warning but doesn't fail
- [ ] `genie work` dispatches only after agent readiness (or timeout)
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add readiness detection to spawn + work commands |

## Execution Groups

### Group 1: Readiness detection in spawn

**Goal:** Spawned agents signal readiness so work dispatch doesn't race the startup.

**Deliverables:**
1. In `src/lib/spawn-command.ts`:
   - After `launchTmuxSpawn()` returns, poll the pane output for readiness indicators
   - Readiness indicators: Claude Code shows "What would you like to do?" or tool_use output, or the agent sends its first `idle_notification`
   - Poll every 2s, timeout after 30s (configurable via `GENIE_SPAWN_TIMEOUT_MS`)
   - Log `✓ Agent ready` on detection, `⚠ Agent readiness timeout (30s) — proceeding anyway` on timeout
2. In `src/term-commands/dispatch.ts`:
   - When `genie work` spawns an agent, use the readiness signal before injecting context
   - If agent already running (re-dispatch), skip readiness check
3. Tests:
   - Test readiness detection with mock pane output
   - Test timeout behavior

**Acceptance Criteria:**
- [ ] Spawn waits for readiness signal (up to 30s)
- [ ] Readiness detected via pane output pattern matching
- [ ] Timeout produces warning, not error
- [ ] `genie work` respects readiness before dispatch

**Validation:**
```bash
bun test src/lib/spawn-command.test.ts && bun test src/term-commands/dispatch.test.ts && bun run typecheck
```

**depends-on:** none

---

## Files to Create/Modify

```
src/lib/spawn-command.ts           — readiness detection after launch
src/lib/spawn-command.test.ts      — readiness tests
src/term-commands/dispatch.ts      — wait for readiness in genie work
src/term-commands/dispatch.test.ts — dispatch readiness tests
```
