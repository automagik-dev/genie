# Wish: Fix Session Resume — Extract and Store Claude Code Session UUIDs

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-session-uuid-resume` |
| **Date** | 2026-03-25 |
| **Design** | N/A (trace-driven — root cause fully identified) |

## Summary

`genie` sessions cannot be resumed because `--resume` receives a friendly name (e.g., `"genie-pm-aoz3"`) instead of the UUID that Claude Code requires. The UUID exists in CC's JSONL session files but is never extracted or stored. This wish fixes UUID extraction, stores it in the agent registry, and passes it correctly to `--resume`.

## Context

**Trace findings (2026-03-25):**
- `claude --resume "genie-pm-aoz3" --print "test"` → Error: "not a valid UUID"
- `claude --resume "52cba80a-a087-4841-87c8-f59f38bd1426" --print "test"` → works
- CC's JSONL contains `{"type":"custom-title","customTitle":"genie-pm-aoz3","sessionId":"52cba80a-..."}` — the UUID is right there but discarded
- All interactive team-leads in `workers.json` have no `claudeSessionId`
- Prior wish `session-continue-by-name` (SHIPPED) switched to `--continue` by name, which proved buggy
- Feedback memory confirms: "always use `--resume` with session ID, `--continue` by name is buggy"

**Two defects:**
1. `sessionExists()` in `team-lead-command.ts:118-136` returns `boolean` instead of the UUID
2. `registerSessionInRegistry()` in `session.ts:89-114` never stores `claudeSessionId` for team-lead sessions

## Scope

### IN
- Change `sessionExists()` → `findSessionUuid()` returning `string | null` (the UUID from CC's JSONL)
- Change `fileHasSessionName()` → `extractSessionUuid()` returning `string | null`
- Update `buildTeamLeadCommand()` to pass UUID to `--resume` instead of the friendly name
- Update `launchWithContinueFallback()` callers to use the UUID
- Store `claudeSessionId` in registry during `registerSessionInRegistry()` by discovering it from CC's JSONL after launch
- Update all callers of `sessionExists()` to use the new `findSessionUuid()` return type
- Update tests in `session.test.ts` and `team-lead-command.test.ts` to assert UUID-based resume

### OUT
- PostgreSQL migration of session state (separate wish: `pg-state-migration`)
- Changes to the daemon auto-resume path (covered by `resilient-resume`)
- Crash recovery or reboot recovery (covered by `genie-resume`)
- Worker/spawned agent resume (workers already generate UUIDs via `crypto.randomUUID()`)
- Resume context injection (covered by `resilient-resume`)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Extract UUID from CC JSONL (not generate our own) | CC owns session identity. Its JSONL is the source of truth for session UUIDs. Generating our own would diverge. |
| Post-launch discovery (not pre-generation) | CC creates the UUID on first launch. We can only discover it after the JSONL file is written. A short delay + scan is acceptable. |
| Keep `--name` flag alongside `--resume` | `--name` sets the display title; `--resume` provides the session ID. They serve different purposes and are compatible. |
| Don't remove `--name` from the command | Workers and the TUI use session names for display. The name stays; only the resume mechanism changes. |

## Success Criteria

- [ ] `genie` command resumes existing sessions without OAuth prompt or session picker
- [ ] `findSessionUuid("genie-pm")` returns a valid UUID string from CC's JSONL files
- [ ] `buildTeamLeadCommand()` output contains `--resume '<uuid>'` (not a name)
- [ ] `registerSessionInRegistry()` stores `claudeSessionId` in the registry entry
- [ ] `genie ls` shows `claudeSessionId` for interactive team-lead sessions
- [ ] All existing tests pass (updated to assert new behavior)
- [ ] Manual test: `genie` → exit CC → `genie` → resumes correctly with conversation history

## Execution Strategy

### Wave 1 (sequential — core fix)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Refactor `sessionExists()` → `findSessionUuid()` and update all callers |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Store `claudeSessionId` in registry after launch + update `genie ls` |
| review | reviewer | Review Groups 1+2 |

## Execution Groups

### Group 1: UUID Extraction and Resume Fix

**Goal:** Make `--resume` pass a real UUID instead of a friendly name.

**Deliverables:**
1. `findSessionUuid(name, cwd?)` in `team-lead-command.ts` — scans CC JSONL files for `custom-title` matching `name`, returns the `sessionId` UUID field (or `null`)
2. `extractSessionUuid(filePath, needle)` replaces `fileHasSessionName()` — returns UUID string instead of boolean
3. `buildTeamLeadCommand()` receives UUID from `findSessionUuid()` and passes it to `--resume`
4. `launchWithContinueFallback()` in `session.ts` updated to pass UUID
5. All callers in `session.ts` and `genie.ts` updated
6. Tests in `session.test.ts` and `team-lead-command.test.ts` updated

**Acceptance Criteria:**
- [ ] `findSessionUuid('genie-pm')` returns a UUID string when a matching session exists
- [ ] `findSessionUuid('nonexistent')` returns `null`
- [ ] Built command contains `--resume '<uuid-format>'` not `--resume '<name>'`
- [ ] All tests pass

**Validation:**
```bash
bun run build && bun test -- --grep "session|team-lead-command" && echo "Group 1 OK"
```

**depends-on:** none

---

### Group 2: Registry Storage and Observability

**Goal:** Persist the Claude session UUID in the agent registry for future use (resume, PG migration).

**Deliverables:**
1. `registerSessionInRegistry()` discovers UUID after launch (scan JSONL with retry/delay since CC writes asynchronously)
2. `claudeSessionId` field populated in registry for team-lead entries
3. `genie ls` displays `claudeSessionId` when available

**Acceptance Criteria:**
- [ ] After `genie` starts, `workers.json` entry for the team-lead has a valid `claudeSessionId`
- [ ] `genie ls` shows the session UUID column

**Validation:**
```bash
bun run build && bun test -- --grep "registry|agent" && echo "Group 2 OK"
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] `genie` from a directory with a prior session resumes the CC conversation (no OAuth, no picker)
- [ ] `genie` from a fresh directory starts a new session correctly
- [ ] `genie --reset` clears and starts fresh
- [ ] Multiple concurrent sessions (different directories) resume independently
- [ ] `genie ls` shows session UUIDs for all active team-leads

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| CC JSONL format changes | Medium | Pin to `custom-title` type + `sessionId` field; add defensive parsing |
| UUID not available immediately after launch | Low | Retry with backoff (CC writes JSONL within ~1s of start) |
| Multiple sessions with same name | Low | `findSessionUuid` returns the most recent match (sort by file mtime) |
| `--resume` + `--name` interaction | Low | Tested: they are compatible — `--name` sets title, `--resume` provides session ID |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/team-lead-command.ts          — sessionExists → findSessionUuid, fileHasSessionName → extractSessionUuid
src/genie-commands/session.ts         — launchWithContinueFallback, registerSessionInRegistry
src/genie.ts                          — callers of sessionExists
tests/team-lead-command.test.ts       — UUID assertions
tests/session.test.ts                 — UUID assertions
```
