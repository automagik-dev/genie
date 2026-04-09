# Wish: Replace --resume UUID with --continue by session name

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `session-continue-by-name` |
| **Date** | 2026-03-18 |
| **Design** | N/A (validated by manual testing) |

## Summary

Replace all `--resume <uuid>` usage in genie with `--continue <session-name>`. Claude Code natively supports resuming sessions by their `--name` value, making UUID-based session tracking unnecessary. This eliminates the `session-store.ts` name→UUID mapping, the `findLastSessionId()` JSONL scraping, and the `lastSessionId` field in worker templates.

## Scope

### IN
- Replace `--resume <uuid>` with `--continue <name>` in team-lead launch (`team-lead-command.ts`)
- Replace `--resume <uuid>` with `--continue <name>` in worker auto-spawn (`auto-spawn.ts`)
- Replace `--resume <uuid>` with `--continue <name>` in protocol-router spawn (`protocol-router-spawn.ts`)
- Replace `--resume <uuid>` with `--continue <name>` in provider-adapters (`provider-adapters.ts`)
- Remove `findLastSessionId()` from `session.ts` — no longer needed
- Remove `session-store.ts` — the name→UUID mapping is dead code
- Remove `startNamedSession()` from `genie.ts` that uses session-store
- Remove `lastSessionId` from `WorkerTemplate` in `agent-registry.ts`
- Remove `resumeSessionId` plumbing from `session.ts` (3 call sites: `createSession`, `focusTeamWindow`, inline-tmux)
- Update `SpawnParams.resume` type/docs in `provider-adapters.ts` to accept name strings (drop `.uuid()` validation)
- Update tests

### OUT
- Changing how `--name` values are generated (already works: team-leads get team name, workers get `{team}-{role}`)
- Codex adapter changes (codex has no session resume)
- Changes to `--session-id` flag usage (new sessions still use UUID)
- Native team parent session ID changes (separate concern)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Use `--continue` not `--resume` | `--continue` is the semantic match — resume by name, not by UUID. Both work, but `--continue` is the intended API |
| Keep `--name` generation as-is | Workers get unique names via `agents.ts:793` (`{team}-{role}`, e.g. `genie-pm-engineer`), team-leads get the sanitized team name (e.g. `genie-pm`). The `--continue` value must match the `--name` value. No collisions observed for single-role workers; multi-instance workers get disambiguated window names. |
| Remove session-store.ts entirely | The name→UUID mapping has only one consumer (`startNamedSession`). With `--continue`, it's dead code |
| Remove findLastSessionId() entirely | JSONL scraping was a workaround for not having name-based resume. Now unnecessary |
| Keep `claudeSessionId` on worker registry entries | Still useful for diagnostics/logging, just not for `--resume` |

## Success Criteria

- [ ] No `--resume` flags appear in any generated claude CLI commands (grep verification)
- [ ] `--continue <name>` is used for all session resumption
- [ ] `session-store.ts` is deleted
- [ ] `findLastSessionId()` is deleted from `session.ts`
- [ ] `lastSessionId` is removed from `WorkerTemplate` interface
- [ ] `SpawnParams.resume` validation no longer requires UUID format
- [ ] All existing tests pass (no regressions)
- [ ] Team-lead sessions resume correctly by name (manual verification)
- [ ] Worker auto-respawn resumes correctly by name (manual verification)

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Core plumbing: provider-adapters + team-lead-command + SpawnParams |
| 2 | engineer | Session cleanup: remove session-store.ts + findLastSessionId + genie.ts named session |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Consumers: auto-spawn + protocol-router + protocol-router-spawn + agent-registry |
| 4 | engineer | Tests: update all tests, add --continue verification |

### Wave 3
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all changes |

## Execution Groups

### Group 1: Core plumbing — SpawnParams and command builders

**Goal:** Change the resume mechanism from UUID to name-based `--continue` in the foundational layers.

**Deliverables:**
1. `provider-adapters.ts`: Change `SpawnParams.resume` doc to "session name to continue", remove `.uuid()` validation on the `resume` field in the zod schema, emit `--continue` instead of `--resume` in `buildClaudeCommand()`
2. `team-lead-command.ts`: Change `resumeSessionId` option to `continueName` (or similar), emit `--continue <name>` instead of `--resume <uuid>`. Since `--name` is already emitted on line 59, the continue value should match it.

**Acceptance Criteria:**
- [ ] `buildClaudeCommand()` emits `--continue <name>` not `--resume <uuid>`
- [ ] `buildTeamLeadCommand()` emits `--continue <name>` not `--resume <uuid>`
- [ ] Zod schema accepts any string for resume, not just UUID

**Validation:**
```bash
bun test --filter "provider-adapters|team-lead-command"
```

**depends-on:** none

---

### Group 2: Session cleanup — remove UUID infrastructure

**Goal:** Delete the session-store module and findLastSessionId scraping, since name-based continue makes them unnecessary.

**Deliverables:**
1. Delete `src/lib/session-store.ts`
2. Remove `findLastSessionId()` from `src/genie-commands/session.ts`
3. Remove all `resumeSessionId` parameters from `session.ts` functions (`createSession`, `focusTeamWindow`, inline-tmux path) — replace with name-based continue
4. Update `buildClaudeCommand()` wrapper in `session.ts` to pass continue name instead of UUID
5. Remove or update `startNamedSession()` in `genie.ts` — no longer needs session-store UUID lookup

**Acceptance Criteria:**
- [ ] `session-store.ts` is deleted
- [ ] `findLastSessionId()` is deleted
- [ ] `session.ts` passes session name (not UUID) to `buildTeamLeadCommand()`
- [ ] `genie.ts` no longer imports session-store

**Validation:**
```bash
bun test --filter "session" && ! grep -r "findLastSessionId\|session-store" src/
```

**depends-on:** Group 1

---

### Group 3: Consumers — auto-spawn + protocol-router + registry

**Goal:** Update all consumers that stored/used `lastSessionId` UUIDs to use session names instead.

**Deliverables:**
1. `auto-spawn.ts`: Replace `template.lastSessionId` → derive continue name as `${template.team}-${template.role}` (matching `agents.ts:793` naming convention), push `--continue <name>` instead of `--resume <uuid>`
2. `protocol-router.ts`: Stop reading `worker.claudeSessionId ?? template.lastSessionId` for resume. Instead derive the continue name as `${template.team}-${template.role}`
3. `protocol-router-spawn.ts`: Change `resumeSessionId` parameter to `continueName`, pass it as `resume` (which now means name) to `buildSpawnParams()`. Update log message on line 154 from `'with --resume'` to `'with --continue'`
4. `agent-registry.ts`: Remove `lastSessionId` from `WorkerTemplate` interface
5. `protocol-router.ts` line 143: Stop saving `lastSessionId` on template after spawn

**Acceptance Criteria:**
- [ ] `lastSessionId` removed from `WorkerTemplate`
- [ ] Auto-spawn uses `--continue <name>` not `--resume <uuid>`
- [ ] Protocol router derives continue name from template metadata

**Validation:**
```bash
bun test --filter "auto-spawn|protocol-router|registry" && ! grep -r "lastSessionId" src/
```

**depends-on:** Group 1

---

### Group 4: Tests

**Goal:** Update all tests to reflect the new --continue behavior and verify no regressions.

**Deliverables:**
1. Update `msg.test.ts` test "includes --resume when resumeSessionId provided" → test --continue with name
2. Add test verifying `buildClaudeCommand` emits `--continue` not `--resume`
3. Add test verifying `buildTeamLeadCommand` emits `--continue` not `--resume`
4. Remove any tests that reference `session-store` or `findLastSessionId`
5. Run full test suite

**Acceptance Criteria:**
- [ ] All tests pass
- [ ] No test references `--resume` for session resumption
- [ ] At least one test verifies `--continue <name>` output

**Validation:**
```bash
bun test
```

**depends-on:** Group 1, Group 2, Group 3

---

## QA Criteria

- [ ] `genie` command launches team-lead and resumes previous session by name
- [ ] `genie spawn --role engineer` creates worker that can be auto-respawned by name
- [ ] Kill a worker pane, send it a message → auto-spawn resumes with `--continue <name>`
- [ ] Multiple concurrent sessions for same agent work (no name collisions)
- [ ] `grep -r '\-\-resume' src/` returns zero matches in generated commands (only in CLI option parsing if any)

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `--continue <name>` fails when multiple sessions share the same name | Medium | Workers already get unique names (`{team}-{role}`). If two engineers exist, the second gets a different window name. Verify with concurrent workers. |
| Claude Code changes `--continue` behavior in future versions | Low | Pin to tested CC version. The feature is stable and CC itself suggests `--resume <name>` on exit. |
| Removing `findLastSessionId` breaks session resume for team-leads launched from different directories | Low | Team-leads use `--name` which is derived from the team/folder name — deterministic across restarts. |

---

## Review Results

**Plan Review — 2026-03-18**
Verdict: **SHIP** (after gap fixes)

Reviewer flagged:
- Worker session naming strategy clarified — `${team}-${role}` from `agents.ts:793`
- Log message in `protocol-router-spawn.ts:154` added to Group 3 deliverables
- All other findings were false positives (items already covered in Groups 1-3)

---

## Files to Create/Modify

```
DELETE  src/lib/session-store.ts
MODIFY  src/lib/provider-adapters.ts          — SpawnParams.resume docs + zod schema + --continue emit
MODIFY  src/lib/team-lead-command.ts           — resumeSessionId → continueName, --continue emit
MODIFY  src/genie-commands/session.ts          — remove findLastSessionId, remove resumeSessionId plumbing
MODIFY  src/genie.ts                           — remove session-store import, simplify startNamedSession
MODIFY  src/hooks/handlers/auto-spawn.ts       — use name instead of lastSessionId
MODIFY  src/lib/protocol-router.ts             — derive continue name from template, drop lastSessionId save
MODIFY  src/lib/protocol-router-spawn.ts       — resumeSessionId → continueName
MODIFY  src/lib/agent-registry.ts              — remove lastSessionId from WorkerTemplate
MODIFY  src/term-commands/msg.test.ts          — update --resume test to --continue
MODIFY  src/term-commands/agents.ts            — remove lastSessionId from template saves
```
