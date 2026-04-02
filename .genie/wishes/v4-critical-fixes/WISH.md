# Wish: v4 Critical Fixes — pgserve, session resume, agent names

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `v4-critical-fixes` |
| **Date** | 2026-03-23 |
| **Issues** | #702, #701, #700, #694 |

## Summary

Fix four critical bugs blocking genie v4 production use: pgserve spawns a new instance per CLI invocation exhausting ports (#702), `--resume`/`--continue` fails on first session launch (#694, #701), and `genie read/answer` cannot resolve short agent names shown by `genie ls` (#700). These bugs block agent orchestration, KhalOS development, and basic CLI usability.

## Scope

### IN
- Pgserve singleton daemon with port lockfile (no per-invocation spawn)
- Session resume detection: skip `--resume` on first run, use it on subsequent runs
- Agent name resolver: match short names (role, customName) from `genie ls` output
- Test coverage for all three areas

### OUT
- PostgreSQL connection pooling or pgserve architecture redesign
- Tmux session management refactor beyond the resume fix
- Agent directory or registry schema changes
- New CLI commands or flags

## Decisions

| Decision | Rationale |
|----------|-----------|
| Port lockfile at `~/.genie/pgserve.port` | Simpler than IPC or daemon socket. Works cross-process. Read before spawn, write after successful start. |
| Check session existence before passing `--resume` | `--resume` with a nonexistent name should never be emitted. Detect via CC API or filesystem check. |
| Fuzzy name resolution with role + customName + partial ID | `genie ls` shows `role \|\| id`, so `genie read` must accept both. Scoped to current team first, then global. |

## Success Criteria

- [ ] `genie task list` completes in <500ms after pgserve is warm
- [ ] 10 rapid `genie task create` commands don't crash with port exhaustion
- [ ] `genie --session newname` starts fresh (no `--resume` flag emitted)
- [ ] `genie --session existingname` resumes correctly with `--resume`
- [ ] `genie read engineer-4` resolves when `genie ls` shows `engineer-4`
- [ ] `genie answer engineer-4 "msg"` resolves the same way
- [ ] All existing tests pass (`bun test`)
- [ ] New tests cover first-run detection, port reuse, and name resolution

## Execution Strategy

### Wave 1 (parallel — no dependencies between groups)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Pgserve singleton + port lockfile |
| 2 | engineer | Session resume detection (fixes #694 + #701) |
| 3 | engineer | Short agent name resolution (fixes #700) |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all 3 groups for correctness + regressions |

**Wave 2 Acceptance Criteria:**
- [ ] All 3 groups' code reviewed for logic correctness
- [ ] No regressions in existing test suite (`bun test`)
- [ ] New tests written and passing for each group
- [ ] Typecheck passes (`bun run typecheck`)

## Execution Groups

### Group 1: Pgserve Singleton — Port Lockfile & Process Reuse
**Goal:** Eliminate per-invocation pgserve spawning. One pgserve per data directory.

**Deliverables:**
1. On successful pgserve start, write port to `~/.genie/pgserve.port` (or `DATA_DIR/pgserve.port`)
2. On startup, read lockfile first. If port file exists and port is listening, connect to it — skip spawn
3. On startup, if port file exists but port is NOT listening, delete stale lockfile and proceed with spawn
4. Clean up lockfile on graceful shutdown (process exit handler)
5. Remove or reduce MAX_PORT_RETRIES fallback — with lockfile, port scanning is unnecessary

**Files:**
- `src/lib/db.ts` — `ensurePgserve()`, `_ensurePgserve()`, port constants, shutdown handler

**Acceptance Criteria:**
- [ ] Second `genie task list` reuses existing pgserve (no "starting pgserve" log)
- [ ] 10 rapid CLI commands don't exhaust ports
- [ ] Stale lockfile (process died) is detected and cleaned up
- [ ] Lockfile removed on clean shutdown

**Validation:**
```bash
bun test --filter "db|pgserve" && echo "pgserve tests pass"
```

**depends-on:** none

---

### Group 2: Session Resume Detection — First-Run vs Subsequent
**Goal:** Only pass `--resume` when a prior session actually exists for that name.

**Deliverables:**
1. In `startNamedSession()` (genie.ts:81-97): before passing `continueName`, check if a prior CC session exists with that name. If not, omit `continueName` (start fresh with `--name` instead).
2. In `session.ts` inside-tmux branch (~line 340): never pass `continueName` with a timestamp-suffixed unique name — these are always new.
3. In `team-lead-command.ts`: ensure `buildTeamLeadCommand()` maps `continueName` → `--resume` only when set, and adds `--name` when starting fresh.
4. Add helper: `sessionExists(name: string): boolean` in `src/lib/team-lead-command.ts` — checks CC conversation storage at `~/.claude/projects/*/` for matching session name, or runs `claude --list` to verify. Called from `startNamedSession()` before setting `continueName`.
5. `launchWithContinueFallback()` in session.ts: keep as safety net but the primary path should never need it.

**Files:**
- `src/genie.ts` — `startNamedSession()`
- `src/genie-commands/session.ts` — inside-tmux branch, `launchWithContinueFallback()`
- `src/lib/team-lead-command.ts` — `buildTeamLeadCommand()`

**Acceptance Criteria:**
- [ ] First `genie --session newname` → no `--resume` flag in spawned command
- [ ] Second `genie --session newname` → `--resume newname` present
- [ ] Inside-tmux path never emits `--resume` with unique timestamp names
- [ ] `claude --continue 'name'` gracefully starts new when no prior session exists (or genie avoids calling it)

**Validation:**
```bash
bun test --filter "session|team-lead|resume" && echo "session tests pass"
```

**depends-on:** none

---

### Group 3: Short Agent Name Resolution
**Goal:** `genie read <short-name>` works when `genie ls` shows that short name.

**Deliverables:**
1. In `target-resolver.ts` `resolveTarget()`: add resolution step between ID match and role fallback — match against `customName`, partial ID suffix, and display name (`role || id`)
2. Name matching priority: exact ID → exact role (team-scoped) → customName match → partial ID match (suffix) → role match (global) → fail
3. If multiple matches found, prefer same-team match. If still ambiguous, return error listing candidates.
4. Ensure `genie answer` uses the same resolver — verify in `src/term-commands/orchestrate.ts` (`answerQuestion()` at ~line 75 already uses `resolveTarget()`)

**Files:**
- `src/lib/target-resolver.ts` — `resolveTarget()`, add `resolveByDisplayName()` or extend `resolveByRole()`
- `src/term-commands/read.ts` — verify it uses resolveTarget
- `src/term-commands/orchestrate.ts` — verify `answerQuestion()` uses resolveTarget

**Acceptance Criteria:**
- [ ] `genie read engineer-4` resolves when worker has role=engineer and display shows `engineer-4`
- [ ] `genie read ec331228` resolves via partial ID suffix match
- [ ] Ambiguous names return helpful error listing candidates
- [ ] `genie answer` resolves the same way as `genie read`

**Validation:**
```bash
bun test --filter "target-resolver|resolve|read|answer" && echo "name resolution tests pass"
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] `genie task list` completes fast after first pgserve startup — no port exhaustion on repeated calls
- [ ] `genie --session brand-new-name` works on first launch (no "No conversation found" error)
- [ ] `genie --session existing-name` correctly resumes a prior session
- [ ] `genie ls` shows short names and `genie read <short-name>` resolves them
- [ ] `genie answer <short-name> "test"` delivers the message
- [ ] `bun test` passes with no regressions
- [ ] `bun run typecheck` passes

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| CC `--resume` behavior may have changed in latest CC version | Medium | Test against current CC binary; keep `launchWithContinueFallback()` as safety net |
| pgserve lockfile race condition between concurrent CLI starts | Low | Use atomic write (write to .tmp then rename) and port-listening check as secondary validation |
| Partial ID match could be ambiguous with many agents | Low | Return candidate list and require more specific name |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/db.ts                        — pgserve singleton, lockfile, port reuse
src/genie.ts                         — session resume detection
src/genie-commands/session.ts         — inside-tmux resume fix
src/lib/team-lead-command.ts          — --resume vs --name mapping
src/lib/target-resolver.ts            — short name resolution
src/term-commands/read.ts             — verify resolver usage
src/term-commands/orchestrate.ts       — verify answerQuestion() resolver usage
tests/                                — new tests for all 3 areas
```
