# Wish: Runs Own Their Session — Executor-Canonical Resume

| Field | Value |
|-------|-------|
| **Status** | DRAFT — PARTIALLY IMPLEMENTED (see Implementation Notes below) |
| **Slug** | `claude-resume-by-session-id` |
| **Date** | 2026-04-14 |
| **Design** | _No brainstorm — direct wish, council-reviewed_ |
| **Council** | `questioner`, `architect`, `simplifier`, `operator` (2-round deliberation, consensus reached) |

## Summary
Fix the category error where `agents.claude_session_id` pretended identity owns a session. Agents are entities (one per identity); executors are runs (many per agent, each with its own Claude session UUID). Every Claude-resumable spawn must write `executors.claude_session_id` on first session capture, and every resume must read from the current executor via a single function. Name-based `--resume '<name>'` is deleted. One release, no staged deprecation.

## Scope
### IN
- Drop `agents.claude_session_id` column (migration + code). Identity layer does not own a session.
- Single writer: extend existing `updateClaudeSessionId(executorId, sessionId)` → ensure **both** SDK and PTY/tmux spawn paths call it as soon as the UUID is known.
- Single reader: `getResumeSessionId(agentId)` — joins `agents.current_executor_id → executors.claude_session_id`. Emits audit events.
- Replace every `worker.claudeSessionId` / `agent.claudeSessionId` read for resume with the single reader.
- Delete name-based resume: `resolveOrMintLeadSessionId()` in `claude-native-teams.ts`, `continueName` parameter in `spawn-command.ts` / `team-lead-command.ts` / `session.ts`.
- Team-lead resume: before spawn, look up the team-lead agent's current executor; if present and has a session, reuse via `--session-id <uuid>`. If not, mint fresh UUID and pass forward. No JSONL scan.
- Fail loudly when resume is requested but no executor/session exists — typed error with entity identifier.
- 3 audit events: `resume.found`, `resume.missing_session`, `resume.provider_rejected`.
- Update tests: stop asserting `--resume 'my-team'` string literals.

### OUT
- Provider-agnostic rename (`resume_token`). Cosmetic; `claude_session_id` stays.
- `SessionId` branded type or new error type hierarchy. Ceremony.
- Staged 3-release deprecation. Internal infra, not external SDK.
- `AUDIT.md` wish artifact. `grep` is the audit.
- Dual-writing to a deprecated column for backwards compat. Hides bugs.
- Migration of existing named on-disk JSONL sessions. Pre-existing named sessions become unresumable — documented one-liner in release notes.
- Codex/app-pty runtime session capture if the provider doesn't support resume today. `getResumeSessionId` returns `null`; resume simply not offered.
- Changes to Claude Code CLI itself.

## Decisions

| Decision | Rationale |
|----------|-----------|
| `executors.claude_session_id` is canonical; `agents.claude_session_id` is dropped. | Migration 012 already split identity (`agents`) from runtime (`executors`). A session belongs to a run, not an identity. Agent may run 10 times; that's 10 executors with 10 session UUIDs. |
| Keep column name `claude_session_id` — don't rename to `resume_token`. | Cosmetic rename with migration cost. Provider-specific name is honest; other providers add their own columns when they need them. |
| Named reader function `getResumeSessionId(agentId)` over inlined JOIN. | Operator's audit events (`resume.found` / `resume.missing_session` / `resume.provider_rejected`) are P1 non-negotiable and need a call site. Symmetric with existing `updateClaudeSessionId(...)` writer. One chokepoint; schema rename = 1 edit. |
| Single release, no staged deprecation. | Internal consolidation, not external API. Dual-writing hides bugs. Architect retracted staged plan in council R2. |
| Team-lead resume reuses existing team-lead executor's session; no JSONL scan. | Simplifier's "always mint new UUID" lost production continuity (council R2). Mint **once on first spawn**, store in executor, pass forward via `--session-id` on respawn. |
| Fail loudly on missing executor/session when resume requested. | Today's silent fresh-start is the root cause of "we frequently end up unable to resume" (user). |
| Drop `teams.native_team_parent_session_id` reads (column may stay). | Team parent collapses into team-lead agent's executor lookup. Column can remain for compat with migrations but is never read by new code. |

## Success Criteria
- [ ] `rg "agents.claude_session_id|agent\.claudeSessionId|worker\.claudeSessionId" repos/genie/src` returns zero hits outside the DB-layer writer (if any), or only inside the migration that drops it.
- [ ] `rg "'--resume'" repos/genie/src` shows UUIDs only; no name literals like `'my-team'`, `'test-team'`.
- [ ] `rg "continueName" repos/genie/src` returns zero hits outside migration comments.
- [ ] `resolveOrMintLeadSessionId` is gone.
- [ ] `getResumeSessionId` is the single resume reader; used by `protocol-router.ts`, `agents.ts` (resume path), `protocol-router-spawn.ts`, team-lead spawn.
- [ ] PTY/tmux spawn path writes `executors.claude_session_id` within the session's lifetime — not deferred to `session-capture.ts` filewatch. (Filewatch remains for observability backfill only.)
- [ ] Resume requested for an agent with no current executor OR an executor with null session → throws `MissingResumeSessionError(entityId)`. No silent fresh-start.
- [ ] 3 audit events emit at resume decision points, visible via `genie events list --type resume.*`.
- [ ] `bun test` passes, including updated `spawn-command.test.ts`, `team-lead-command.test.ts`, `msg.test.ts`, `session.test.ts`, `resume.test.ts`, `claude-sdk-resume.test.ts`.
- [ ] **Manual resume smoke**: spawn `engineer`, capture session UUID from `genie events`, kill pane, `genie resume engineer` → new executor row, same session UUID observed in provider, conversation continuity verified via `genie agent log`.
- [ ] **Manual team smoke**: `genie team create X`, capture team-lead executor session, kill tmux session, `genie team resume X` → team-lead respawns on same session UUID. No JSONL name lookup occurs (traced via audit events).
- [ ] **Post-OS-restart smoke**: reboot, `pgserve` comes up, `genie agent resume --all` resumes eligible agents using the session UUIDs persisted in `executors` rows.

## Execution Strategy

### Wave 1 (parallel — primitives)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Reader function + audit events. Add `getResumeSessionId(agentId)` in `executor-registry.ts`, with 3 audit event emit points. Unit tests. |
| 2 | engineer | PTY/tmux writer gap. Make the PTY spawn path call `updateClaudeSessionId` on first session capture (not defer to filewatch). Unit test. |

### Wave 2 (after Wave 1 — swap consumers + delete name-based)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Swap all resume readers to `getResumeSessionId`. Replace `worker.claudeSessionId` at `protocol-router.ts:213`, `agents.ts:1921`, `protocol-router-spawn.ts:103`. |
| 4 | engineer | Delete name-based resume. Remove `continueName` from `spawn-command.ts`, `team-lead-command.ts`, `session.ts`. Remove `resolveOrMintLeadSessionId` in `claude-native-teams.ts`. Update tests to assert UUID resume args. |
| 5 | engineer | Team-lead executor-reuse logic. On team-lead spawn, query current executor → reuse session or mint new + pass via `--session-id`. |
| 6 | engineer | Missing-session error. Add `MissingResumeSessionError`; throw from `getResumeSessionId` callers when resume is explicitly requested. |

### Wave 3 (after Wave 2 — drop column + validate)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Drop `agents.claude_session_id` column. New migration. Remove `agent.claudeSessionId` field from `agent-registry.ts` type + rowToAgent + register INSERT. |
| 8 | qa | Full `bun test` + 3 manual smokes (single-agent resume, team resume, post-OS-restart). QA report. |
| review | reviewer | Validate success criteria. |

## Execution Groups

### Group 1: Reader function + audit events
**Goal:** Single chokepoint for every resume read; 3 audit events for observability.
**Deliverables:**
1. `getResumeSessionId(agentId: string): Promise<string | null>` in `lib/executor-registry.ts`, joins `agents.current_executor_id → executors.claude_session_id`.
2. Emits `resume.found { agentId, executorId, sessionId }` on hit, `resume.missing_session { agentId, reason: 'no_executor'|'null_session' }` on miss, `resume.provider_rejected { agentId, sessionId, reason }` when caller signals failure back (helper method).
3. Unit tests covering: happy path, no current executor, executor without session, multiple prior executors (only current counts).

**Acceptance Criteria:**
- [ ] Function exported and typed.
- [ ] `bun test src/lib/executor-registry.test.ts` passes new cases.
- [ ] `genie events list --type resume.* --since 5m` shows entries after unit test run (when PG is live).

**Validation:**
```bash
cd repos/genie && bun test src/lib/executor-registry.test.ts
```

**depends-on:** none

---

### Group 2: PTY/tmux writer gap
**Goal:** Session UUID lands in `executors.claude_session_id` within the run's lifetime, not deferred to filewatch.
**Deliverables:**
1. Identify first-session-capture hook in the PTY spawn path (`agents.ts::launchInlineSpawn` / team-lead spawn path). Wire it to call `updateClaudeSessionId(executorId, uuid)`.
2. Keep `session-capture.ts` filewatch for observability backfill only (belt-and-suspenders). Ensure it no longer owns the persistence contract.
3. Unit test: spawn PTY path, first session line processed, DB row has `claude_session_id` set.

**Acceptance Criteria:**
- [ ] PTY-spawned executor row gets `claude_session_id` set before the spawn call returns (or within 1s of first session event — test tolerance).
- [ ] Filewatch still works for historic JSONL backfill.

**Validation:**
```bash
cd repos/genie && bun test src/term-commands/agents.test.ts src/lib/session-capture.test.ts
```

**depends-on:** none

---

### Group 3: Swap resume readers
**Goal:** Every resume reader calls `getResumeSessionId`.
**Deliverables:**
1. Update `protocol-router.ts:213`, `term-commands/agents.ts:1921` (`buildResumeParams`), `protocol-router-spawn.ts:103`.
2. Remove the force-unwrap `agent.claudeSessionId!` at `agents.ts:1921`.
3. Type of `SpawnParams.resume` stays `string | undefined`.

**Acceptance Criteria:**
- [ ] `rg "worker\.claudeSessionId|agent\.claudeSessionId" repos/genie/src` returns zero hits for resume intent (only the DB writer may still touch the column).
- [ ] `bun test` passes on affected suites.

**Validation:**
```bash
cd repos/genie && bun test src/lib/protocol-router.test.ts src/__tests__/resume.test.ts
```

**depends-on:** Group 1

---

### Group 4: Delete name-based resume
**Goal:** No code path constructs `--resume '<name>'`.
**Reference:** `.genie/wishes/claude-resume-by-session-id/CALL-SITES.md` lists every emission site (rows #1, #2, #16-#21, #23) and every test to rewrite.
**Deliverables:**
1. Remove `continueName` param from `spawn-command.ts`, `team-lead-command.ts`, `session.ts`. Callers no longer pass names for resume.
2. Remove `resolveOrMintLeadSessionId` and JSONL-scanning logic in `claude-native-teams.ts:222-499` (~200 LoC deletion).
3. **Standalone bug fix** (CALL-SITES.md row #21): `team-auto-spawn.ts:156, 184` resolves `sessionId` from `resolveOrMintLeadSessionId` then discards it, passing `sanitizeTeamName(teamName)` instead. Before deleting the resolver, extract the UUID and pass it forward.
4. Remove the `OR s.claude_session_id = $1` branch at `term-commands/agents.ts:975-1011` — accept UUID only.
5. Update tests per CALL-SITES.md §2 — replace asserts like `expect(cmd).toContain("--resume 'my-team'")` with UUID-shaped assertions.

**Acceptance Criteria:**
- [ ] `rg "continueName" repos/genie/src` → zero hits.
- [ ] `rg "resolveOrMintLeadSessionId" repos/genie/src` → zero hits.
- [ ] `rg "'--resume'" repos/genie/src/lib repos/genie/src/term-commands` → UUID fixtures only.

**Validation:**
```bash
cd repos/genie && bun test
```

**depends-on:** Group 1

---

### Group 5: Team-lead executor-reuse logic
**Goal:** Team-lead resume uses current-executor session; if absent, mint UUID once and pass forward.
**Deliverables:**
1. Before spawning team-lead, call `getResumeSessionId(teamLeadAgentId)`. If non-null, pass `--resume <uuid>`. If null and this is a fresh team, mint a UUID with `randomUUID()` and pass `--session-id <uuid>` on spawn (so next resume finds it).
2. Remove `teams.native_team_parent_session_id` READS (writes can remain until Group 7's cleanup).
3. Test: create team, kill team-lead, resume team → same session UUID observed in executor row.

**Acceptance Criteria:**
- [ ] No code reads `teams.native_team_parent_session_id` on team-lead resume.
- [ ] Team-lead spawn always carries either `--resume <uuid>` or `--session-id <uuid>`.

**Validation:**
```bash
cd repos/genie && bun test src/lib/team-manager.test.ts src/lib/claude-native-teams.test.ts
```

**depends-on:** Groups 1, 4

---

### Group 6: Missing-session error
**Goal:** Resume-requested-but-no-session fails loudly.
**Deliverables:**
1. `MissingResumeSessionError` in `lib/errors.ts` (or colocated) — carries `entityId`, `reason`.
2. `handleWorkerResume` (`agents.ts:1880`) and team-lead resume paths throw it on null from `getResumeSessionId`.
3. Error message includes the agent/team identifier and the runbook hint.
4. Test.

**Acceptance Criteria:**
- [ ] Unit test: resume an agent with no current executor → throws `MissingResumeSessionError`.
- [ ] CLI user sees the error on stderr with exit code 1.

**Validation:**
```bash
cd repos/genie && bun test src/__tests__/resume.test.ts
```

**depends-on:** Group 1

---

### Group 7: Drop `agents.claude_session_id`
**Goal:** Identity layer no longer carries a session.
**Deliverables:**
1. New migration `NNN_drop_agents_claude_session_id.sql`: `ALTER TABLE agents DROP COLUMN IF EXISTS claude_session_id;`
2. Remove `claudeSessionId` field from `Agent` TS type in `agent-registry.ts`, the rowToAgent mapper (line 154), and the `register()` INSERT (line 216+).
3. Remove any lingering writers to `agents.claude_session_id`.
4. Typecheck + full test suite.

**Acceptance Criteria:**
- [ ] Migration applied cleanly on a fresh PG.
- [ ] `rg "claudeSessionId" repos/genie/src/lib/agent-registry.ts` → zero hits (move the field entirely to executor types).
- [ ] `bun run typecheck` passes.

**Validation:**
```bash
cd repos/genie && bun run typecheck && bun test
```

**depends-on:** Groups 3, 4, 5, 6

---

### Group 8: QA smoke tests
**Goal:** Validate real-world resume scenarios.
**Deliverables:**
1. `.genie/wishes/claude-resume-by-session-id/QA.md` with three scripted smokes:
   - **Single-agent resume**: spawn → capture UUID via `genie events` → kill pane → `genie resume` → same UUID reused.
   - **Team resume**: `genie team create` → capture team-lead UUID → `genie team done` + cleanup tmux session → recreate team → same team-lead UUID reused (via executor lookup).
   - **Post-OS-restart**: stop pgserve+tmux, restart, `genie agent resume --all` → eligible agents resume with the persisted UUIDs.
2. Each smoke documented with commands, expected audit events, and pass/fail evidence.

**Acceptance Criteria:**
- [ ] All 3 smokes pass.
- [ ] `genie events list --type resume.* --since 10m` shows expected events per smoke.

**Validation:**
```bash
cd repos/genie && bun test
# plus manual smokes documented in QA.md
```

**depends-on:** Group 7

---

## Dependencies
- **depends-on:** none (external)
- **blocks:** none
- **runs-in-parallel-with:** active `/trace` on agent detection/registry (separate wish, separate code surface)

## QA Criteria

- [ ] Fresh spawn (SDK or PTY) writes `executors.claude_session_id` within the run's lifetime.
- [ ] Resume reads ONLY via `getResumeSessionId`; no `worker.claudeSessionId` / `agent.claudeSessionId` references remain.
- [ ] Team-lead respawn after kill uses the same session UUID (executor-reuse, not JSONL scan).
- [ ] Resume without a stored session throws `MissingResumeSessionError` with the entity identifier.
- [ ] No `--resume '<name>'` strings anywhere (UUIDs only).
- [ ] 3 audit events present and filterable.
- [ ] Post-OS-restart resume works for eligible agents.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Existing named on-disk JSONL sessions become unresumable after this lands. | Medium | Documented in OUT scope; release notes one-liner. Users start fresh. |
| Provider session expired at CC's store (executor has UUID but CC rejects) — resume still fails. | Medium | `resume.provider_rejected` audit event; caller decides fresh spawn with WARN. |
| Codex/app-pty don't support session resume today. | Low | `getResumeSessionId` returns null; CLI never offers resume for non-resumable providers. |
| Race: `updateClaudeSessionId` UPDATE lost to PG crash between capture and commit. | Low | Next spawn finds null, starts fresh, re-captures. Acceptable. |
| Hidden writer to `agents.claude_session_id` outside `agent-registry.ts`. | Low | Group 7 grep sweep before the drop migration. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
.genie/wishes/claude-resume-by-session-id/QA.md                (new — Group 8)
repos/genie/src/db/migrations/NNN_drop_agents_claude_session_id.sql   (new — Group 7)
repos/genie/src/lib/executor-registry.ts                       (Groups 1, 3)
repos/genie/src/lib/executor-registry.test.ts                  (Group 1)
repos/genie/src/term-commands/agents.ts                        (Groups 2, 3, 6)
repos/genie/src/lib/session-capture.ts                         (Group 2 — narrow to backfill)
repos/genie/src/lib/protocol-router.ts                         (Group 3)
repos/genie/src/lib/protocol-router-spawn.ts                   (Group 3)
repos/genie/src/lib/spawn-command.ts                           (Group 4)
repos/genie/src/lib/spawn-command.test.ts                      (Group 4)
repos/genie/src/lib/team-lead-command.ts                       (Group 4)
repos/genie/src/lib/team-lead-command.test.ts                  (Group 4)
repos/genie/src/term-commands/msg.test.ts                      (Group 4)
repos/genie/src/genie-commands/session.ts                      (Group 4)
repos/genie/src/genie-commands/__tests__/session.test.ts       (Group 4)
repos/genie/src/lib/claude-native-teams.ts                     (Group 4 — delete scan logic)
repos/genie/src/lib/team-manager.ts                            (Group 5)
repos/genie/src/lib/errors.ts                                  (Group 6)
repos/genie/src/__tests__/resume.test.ts                       (Groups 3, 6)
repos/genie/src/lib/agent-registry.ts                          (Group 7)
```

## Referenced Council Positions (for traceability)

- **Questioner R1/R2:** drop `agents.claude_session_id` now; JOIN-based resolution; no new columns.
- **Architect R1/R2:** canonical `executors.claude_session_id`, single writer+reader, retracted staged deprecation in R2.
- **Simplifier R1/R2:** delete 3 targets (column, `resolveOrMintLeadSessionId`, dual-writes); conceded "always mint" loses continuity → mint once, reuse via executor.
- **Operator R1/R2:** ship criteria = executors sole source of truth + explicit audit events + validated post-restart runbook.

---

## Implementation Notes (2026-04-18, via `/trace` + `/fix` cycle)

An urgent bug report ("stale resumed sessions") triggered a trace + fix cycle outside this wish's `/work` lifecycle. Five commits landed on branch `dev` in `repos/genie` (5 ahead of origin/dev, not yet pushed):

| SHA | Subject | Wish alignment |
|---|---|---|
| `525654a1` | fix(hooks): sync `executors.claude_session_id` from PTY session hooks | **Group 2 delivered** (via hook handler, not filewatch — see correction below) |
| `b303a611` | fix(team-auto-spawn): pass resolved UUID to `--resume` + create executor row | **Group 5 partially delivered** (team-auto-spawn path only; other callers still pass `continueName` via deprecated flag) |
| `a05644f9` | fix(protocol-router): throw `MissingResumeSessionError` on missing claudeSessionId | **Groups 3 + 6 partially delivered** (protocol-router call site + typed error; other resume read sites not yet swapped to a single reader) |
| `2c2490d9` | fix(resume): remove `claudeSessionId` force-unwrap in `buildResumeParams` | **Group 3 extended** (force-unwrap at `agents.ts:1921` eliminated; `buildFullResumeParams` wrapper validates and throws) |
| `2cd43598` | fix(hooks): emit `session.reconciled` audit event when PTY UUID rotates | **New audit event** — complements (not replaces) the three wish-scoped events |

### Correction to Group 2 rationale

The original Group 2 deliverable claimed the fix is to stop deferring persistence to `session-capture.ts` filewatch. **That premise was factually wrong.** Static trace confirmed `session-capture.ts` only **reads** `executors.claude_session_id` (to tag ingested JSONL rows); it never wrote to that column. The actual defect: the PTY/tmux spawn path had no writer at all — only the SDK provider path (`services/executors/claude-sdk.ts::reconcileSessionId`) captured the per-resume UUID that Claude CLI returns.

The delivered fix (`525654a1`) adds a new hook handler at `src/hooks/handlers/session-sync.ts` that reads `payload.session_id` on every PreToolUse / PostToolUse / UserPromptSubmit / Stop hook firing, compares it to the executor's stored UUID, and calls `updateClaudeSessionId` when it differs. No filewatch changes were needed.

### Scope still outstanding (for future `/work`)

- **Group 1** — `getResumeSessionId(agentId)` single reader helper in `executor-registry.ts`, emitting `resume.found` / `resume.missing_session` / `resume.provider_rejected`. Not implemented; current fixes use direct type narrowing at call sites.
- **Group 3 — remaining call sites** — `getResumeSessionId` should replace reads at `protocol-router.ts:213` (now partially via `isExecutorResumable` guard), `term-commands/agents.ts:1921` (now via `buildFullResumeParams`), `protocol-router-spawn.ts:103` (not yet touched).
- **Group 4** — `continueName` legacy callers still active at `src/genie-commands/session.ts:102-113` and `src/genie.ts:144`. Parameter is `@deprecated` but not deleted. `buildTeamLeadCommand` still accepts it.
- **Group 5 — single-agent respawn path** — team-auto-spawn delivered; individual agent respawn's executor-reuse logic not yet touched.
- **Group 7** — `agents.claude_session_id` column not dropped. Migration and `agent-registry.ts` type/INSERT cleanup pending.

### What the 5 commits effectively delivered

- PTY-side writer (Group 2, via hook reconciliation).
- Force-unwrap elimination + typed error for explicit resume intent (Groups 3 + 6, narrow).
- Team-auto-spawn UUID propagation + executor row creation + fuzzy cross-worktree scan removal in `findNewestSessionIdForTeam` (Groups 5 + partial Group 4).
- Tests: 2476 pass, 0 fail (7 new).

### Recommendation for picking this wish back up

1. Decide whether to keep the existing 5 commits as the foundation and narrow remaining wish scope to outstanding groups (preferred — less churn), or revert and run the original plan end-to-end.
2. If keeping: amend Group 2 rationale in place (or mark it done), narrow Group 3 to the untouched call sites, keep Groups 1/4/5-rest/7 as-is.
3. Before dropping the column (Group 7), run a post-restart smoke on the current fix to confirm PTY reconciliation holds across `pgserve` bounces.
