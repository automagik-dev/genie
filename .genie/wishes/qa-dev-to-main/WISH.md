# Wish: QA Gate — dev→main Promotion (3.260320)

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `qa-dev-to-main` |
| **Date** | 2026-03-20 |
| **PRs Included** | #673 (pgserve-embed), #674 (fire-and-forget), #675 (genie-scheduler) |

## Summary

Comprehensive QA validation of the dev→main diff before production promotion. Three wishes landed: embedded pgserve, fire-and-forget dispatch, and scheduler daemon. 43 files changed, +5389 lines. This wish validates every feature works end-to-end on dev, creates the promotion PR to main with proof.

## Scope

### IN
- Validate all 3 merged wishes against their acceptance criteria on dev
- Run full test suite (`bun run check`)
- E2E test: pgserve auto-start, schema creation, `genie db` commands
- E2E test: fire-and-forget dispatch (non-blocking, mailbox, auto-exit)
- E2E test: scheduler daemon (create schedule, daemon fires trigger, run recorded)
- E2E test: session resume with `--resume` flag
- Regression check: existing genie features still work (spawn, send, team create, work)
- Create PR dev→main with evidence

### OUT
- No code changes (QA only — if bugs found, separate fix wish)
- No new features
- No observability tables (deferred)

## Success Criteria

- [ ] `bun run check` passes (typecheck + lint + dead-code + all tests)
- [ ] All 879+ tests pass, 0 failures
- [ ] pgserve auto-starts on port 19642 and responds to queries
- [ ] `genie db status` reports healthy
- [ ] `genie db migrate` shows all migrations applied
- [ ] `genie db query "SELECT count(*) FROM schedules"` returns 0
- [ ] Schema has all expected tables (schedules, triggers, runs, heartbeats, audit_events, agent_checkpoints)
- [ ] `genie schedule create "test-qa" --command "echo hello" --after "1h"` creates trigger in PG
- [ ] `genie schedule list` shows the created trigger
- [ ] `genie schedule cancel "test-qa"` cancels it
- [ ] `grep -rn "initialPrompt" src/term-commands/dispatch.ts` returns zero matches (fire-and-forget)
- [ ] `grep -rn "ORCHESTRATE_POLL_MS" src/term-commands/dispatch.ts` returns zero matches (no polling)
- [ ] `grep -rn "\-\-continue" src/lib/provider-adapters.ts` returns zero matches (--resume only)
- [ ] `tmuxSessionName` field exists in TeamConfig interface
- [ ] `--session` option exists on `genie spawn` and `genie team create`
- [ ] Wave completion detection code exists in `genie done` handler
- [ ] Push enforcement (`ensureWorkPushed`) exists in `genie done`
- [ ] Auto-exit pane logic exists in `genie done`
- [ ] Dead pane liveness handler exists in OTel relay
- [ ] Resume context injection exists in protocol-router-spawn
- [ ] Scheduler daemon core exists with LISTEN/NOTIFY + poll fallback
- [ ] RunSpec/RunState model exists with all fields from design
- [ ] Lease-based claiming uses SELECT FOR UPDATE SKIP LOCKED
- [ ] Idempotency key column exists on triggers table
- [ ] Recurring trigger generation works (trigger fires → next trigger inserted)
- [ ] `genie daemon install` generates systemd unit file content
- [ ] `genie daemon status` runs without error
- [ ] PR to main created with full evidence report

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | qa | Static validation — code checks, grep assertions, test suite |
| 2 | qa | pgserve E2E — auto-start, schema, db commands |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | qa | Scheduler E2E — create/list/cancel, daemon commands |
| 4 | qa | Fire-and-forget E2E — dispatch, mailbox, resume context |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Create PR dev→main with evidence from Groups 1-4 |

## Execution Groups

### Group 1: Static validation

**Goal:** Verify all code-level criteria via grep, test suite, and static analysis.

**Deliverables:**
1. Run `bun run check` — capture full output
2. Run all grep assertions from success criteria (initialPrompt, ORCHESTRATE_POLL_MS, --continue, etc.)
3. Verify TeamConfig has tmuxSessionName field
4. Verify --session option exists on spawn and team create
5. Verify RunSpec/RunState interfaces have all design fields
6. Verify SELECT FOR UPDATE SKIP LOCKED in scheduler daemon
7. Verify idempotency_key column in migration SQL

**Acceptance Criteria:**
- [ ] bun run check passes
- [ ] All grep assertions pass (zero matches for removed patterns, positive matches for added patterns)

**Validation:**
```bash
bun run check
```

**depends-on:** none

---

### Group 2: pgserve E2E

**Goal:** Verify pgserve auto-starts and schema is correct.

**Deliverables:**
1. Run `genie db status` — verify auto-start on 19642
2. Run `genie db migrate` — verify all migrations applied
3. Run `genie db query "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"` — verify all tables
4. Run `genie db query "SELECT count(*) FROM schedules"` — verify query works
5. Verify data dir exists at `~/.genie/data/pgserve/`

**Acceptance Criteria:**
- [ ] pgserve running on 19642
- [ ] All 6+ tables present
- [ ] Queries return results
- [ ] Data dir exists and has postgres data files

**Validation:**
```bash
genie db status
genie db query "SELECT 1"
```

**depends-on:** none

---

### Group 3: Scheduler E2E

**Goal:** Verify schedule create/list/cancel and daemon commands work.

**Deliverables:**
1. `genie schedule create "qa-test" --command "echo hello" --after "1h"` — verify trigger in PG
2. `genie schedule list` — verify shows the trigger
3. `genie schedule list --json` — verify JSON output
4. `genie schedule cancel "qa-test"` — verify cancellation
5. `genie daemon status` — verify runs without error
6. `genie daemon install --dry-run` or inspect systemd template output
7. Verify recurring trigger generation: check that the fix commit handles next trigger insertion

**Acceptance Criteria:**
- [ ] Schedule CRUD works end-to-end
- [ ] Daemon commands respond correctly
- [ ] Recurring trigger logic exists in code

**Validation:**
```bash
genie schedule create "qa-test" --command "echo hello" --after "1h"
genie schedule list
genie schedule cancel "qa-test"
genie daemon status
```

**depends-on:** Group 2

---

### Group 4: Fire-and-forget E2E

**Goal:** Verify dispatch changes, mailbox delivery, and session resume.

**Deliverables:**
1. Verify autoOrchestrateCommand exits after spawning (read the function — no polling loop)
2. Verify mailbox delivery code path (genie send after spawn, not initialPrompt)
3. Verify `genie done` flow: completeGroup → wave detection → push enforcement → pane exit
4. Verify resume context injection in protocol-router-spawn
5. Verify --resume usage in provider-adapters (not --continue)
6. Verify dead pane handler in OTel relay section of agents.ts

**Acceptance Criteria:**
- [ ] All fire-and-forget code paths verified with evidence
- [ ] No regressions in existing dispatch functionality

**Validation:**
```bash
bun test src/term-commands/state.test.ts
bun test src/lib/wish-state.test.ts
bun test src/lib/spawn-command.test.ts
```

**depends-on:** none

---

### Group 5: Create PR dev→main

**Goal:** Create the promotion PR with all QA evidence.

**Deliverables:**
1. Compile evidence from Groups 1-4 into PR body
2. Create PR: `gh pr create --base main --title "chore: promote dev→main — pgserve, fire-and-forget, scheduler" --body "<evidence>"`
3. Verify CI passes on the PR

**Acceptance Criteria:**
- [ ] PR to main exists with evidence summary
- [ ] CI green on the PR

**Validation:**
```bash
gh pr checks <number>
```

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## QA Criteria

- [ ] Every success criterion has PASS/FAIL with captured evidence
- [ ] Zero HIGH or CRITICAL issues
- [ ] PR to main includes full test report

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| pgserve won't start in CI environment | Medium | Tests mock DB layer; E2E is local only |
| Scheduler daemon can't bind port in test | Low | Daemon tests use mocks |

## Files to Create/Modify

```
None — QA only. PR to main created as output.
```
