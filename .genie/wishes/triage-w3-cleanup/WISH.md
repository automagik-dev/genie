# Wish: Triage W3 — Backlog Cleanup

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `triage-w3-cleanup` |
| **Date** | 2026-04-30 |
| **Author** | genie-3 |
| **Appetite** | large |
| **Branch** | `wish/triage-w3-cleanup` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Drain the 35-issue triage-verified backlog produced by the 2026-04-30 fleet triage (one agent per issue, evidence-pinned to commit SHAs). Each execution group ships fixes for a coherent cluster of related issues; one PR per issue, gated by a regression test where the triage evidence cited a missing test. Anchored to `dev` (the active integration branch) — earlier triage that anchored to `chore/pgserve-2.0.2` was off by 97 commits and is re-verified per group.

## Scope

### IN

- Close the 35 GH issues with verified fixes on `dev`
- One PR per issue (keyed `fix/<NNNN>-<slug>`), so blast radius stays small and revertable
- Add/update a regression test wherever the original triage evidence cited a defect with a missing test
- Re-run the original repro from the GH issue body after each fix; confirm it now passes
- Update the GH issue with a closing comment citing the merged PR SHA

### OUT

- NEEDS-DISCUSSION issues pending reporter input (#1469 tests-pkill, #1478 wave-tracker false-positives) — parked, not executed
- Architectural rewrites that exceed the issue's stated scope (e.g. #1396 full SDK adoption, #1300 unify-task-trees end-state) — file separate wishes
- Already-closed issues from the first-pass triage (#1461 #1462 #1463 #1473 #1509 #1521 #1574 #1575 #1589 #1594) — done
- Cross-org/upstream dependencies (e.g. #1390 needs an upstream opentui patch release) — track upstream, do not block this wish on it
- Source code changes outside `automagik-dev/genie` repo

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | One PR per issue, named `fix/<NNNN>-<short-slug>` | Keeps reviewer scope tight; one bad merge can be reverted in isolation |
| 2 | Group by domain cluster, not by priority | Reviewers gain context faster when consecutive PRs touch the same files; merges interleave less frequently |
| 3 | Re-anchor every verdict to `dev` HEAD before starting any fix | First-pass triage anchored to `chore/pgserve-2.0.2` (97 commits behind dev) — already produced two false STILL-OPEN-CONFIRMED verdicts (#1521, #1589). Each group's first deliverable is a re-anchor pass against `dev` |
| 4 | NEEDS-DISCUSSION issues do not enter execution scope | The triage agent could not reproduce / find the cited code; pulling them into work would burn cycles on phantom bugs. Reporter must reconfirm |
| 5 | Skip "enhancement-track" issues that need their own design (#1300 G3+G4, #1396, #1451) — leave open with a wish-track pointer | Each is a multi-day design effort; lumping them into a cleanup wish would force shallow fixes |
| 6 | Validation per group runs `make check` plus the issue's own repro command | Catches both regression and the specific defect; cheaper than a full smoke run per issue |

## Success Criteria

- [ ] All URGENT issues (3) closed by merged PR on `dev`: #1491 #1493 #1582
- [ ] All HIGH issues that aren't already closed (10) closed by merged PR on `dev`: #1330 #1390 #1400 #1410 #1502 #1581 #1583 #1591 #1597 #1598
- [ ] All NORMAL issues that aren't enhancement-track (14) closed by merged PR on `dev`: #1315 #1391 #1394 #1412 #1460 #1488 #1533 #1579 #1584 #1587 #1592 #1593 #1595 #1596
- [ ] All LOW actionable issues (2) closed by merged PR on `dev`: #1392 #1470
- [ ] Enhancement-track issues (4) get a wish-track pointer comment and stay open: #1300 #1368 #1396 #1451
- [ ] NEEDS-DISCUSSION issues (2) remain open with a "needs reporter reconfirm" status: #1469 #1478
- [ ] `make check` passes on `dev` after final merge
- [ ] No regressions surface in `genie events errors --since 24h` after final merge
- [ ] Master triage task `#1` closed with final closeout report

## Execution Strategy

Five waves keyed to priority + risk class. Within each wave, groups touch disjoint file sets and can run in parallel. Group 1 is sequential because all three deliverables share `src/hooks/` and `package.json`/postinstall plumbing.

### Per-group prelude (mandatory, applies to every group)

Before writing any fix code in a group, the executing engineer **must** complete this prelude:

> **Deliverable 0 — Re-anchor to `dev`:** For every issue in the group, verify the cited file:line/SHA evidence still applies on `dev` HEAD. If a referenced commit has been merged or the cited code path has been refactored, update the deliverable scope (or move the issue to enhancement-track). The first-pass triage was anchored to `chore/pgserve-2.0.2` (97 commits behind dev) and produced two false STILL-OPEN-CONFIRMED verdicts (#1521, #1589) — this prelude prevents that recurrence.

This prelude is implicit in every group's Deliverables list — treat it as Deliverable 0 even though it is not re-listed under each group below.

### Cross-group file collisions (advisory)

Several files are touched by multiple groups: `src/genie-commands/doctor.ts` (G1, G3, G5), `package.json` (G1, G4, G7, G9), `src/lib/team-manager.ts` (G3, G6), `src/term-commands/agents.ts` (G2, G6). The wave gating ensures collisions are sequential across waves, not parallel within a wave. Reviewers merging PRs across waves should rebase later-wave PRs onto the latest `dev` after earlier-wave PRs land, to avoid silent merge-conflict resolution losing intended hunks.

### Wave 1 (sequential — release-blockers)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | release-blockers + RAM leak (#1491 #1493 #1582) |

### Wave 2 (parallel — high blast)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | lifecycle + cleanup (#1330 #1410 #1502 #1591) |
| 3 | engineer | team + update flows (#1400 #1581 #1583) |
| 4 | engineer | TUI + tests (#1390 #1597 #1598) |

### Wave 3 (parallel — normal blast)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | pgserve hygiene (#1592 #1593 #1595 #1596) |
| 6 | engineer | small CLI/UX (#1412 #1460 #1533 #1579 #1584 #1587) |
| 7 | engineer | dep bumps + omni (#1391 #1394 #1488) |
| 8 | engineer | meta verb unification (#1315) |

### Wave 4 (parallel — low actionable)

| Group | Agent | Description |
|-------|-------|-------------|
| 9 | engineer | dep + narrow env (#1392 #1470) |

### Wave 5 (parallel — parked / pointer-only)

| Group | Agent | Description |
|-------|-------|-------------|
| 10 | engineer | enhancement-track pointer comments (#1300 #1368 #1396 #1451) |
| 11 | engineer | needs-discussion close/park (#1469 #1478) |

## Execution Groups

### Group 1: release-blockers + RAM leak (#1491 #1493 #1582)

**Goal:** Eliminate the three blockers that prevent shipping a clean `dev` cut.

**Deliverables:**
1. **#1491** — Wire AsyncLocalStorage in `src/hooks/`+`src/serve/` so `[from:]` attribution carries the originating agent name through the genie-hook bridge instead of leaking the orchestrator's `GENIE_AGENT_NAME`. Update `identity-inject.ts:22` and `runtime-emit.ts:246` to read from the ALS context, not `process.env`.
2. **#1493** — Make the standard build emit the `genie-hook` binary and bring compile size back under the 20 MB wish gate (currently 99 MB). Either ship the `cf7275fd` postinstall flow on `chore/pgserve-2.0.2` too, or wrap the binary into the npm tarball.
3. **#1582** — Reap orphan `bun-genie.js` processes accumulated under PID 1 (~21 reparented, ~4 GB RAM). Extend `f3f642c1`'s `reapStaleGenieProcesses()` from `genie update` post-maintenance to also run on `genie serve` startup and TUI exit, so leaks are bounded without requiring an update.

**Acceptance Criteria:**
- [ ] Spawning agent `A` from agent `B` lands `[from: A]` in `B`'s inbox (not `[from: <orchestrator>]`); regression test in `src/hooks/__tests__/identity-attribution.test.ts`.
- [ ] `bun run build` produces a binary ≤ 20 MB containing `genie-hook` (verifiable via `bun run build && du -m dist/genie && [ -f dist/genie-hook ]`).
- [ ] After `genie tui` and `genie serve` lifecycle (start/stop/start/stop/start), `pgrep -f bun-genie.js | wc -l` is no greater than the number of currently active agents per `genie ls --json` (i.e. zero orphans reparented to PID 1); reap function unit-tested.

**Validation:**
```bash
cd /home/genie/.genie/worktrees/triage-w3-cleanup
bun test src/hooks/__tests__/identity-attribution.test.ts \
  && bun run build \
  && [ "$(stat -c%s dist/genie)" -le 20971520 ] \
  && [ -f dist/genie-hook ] \
  && bun test src/genie-commands/__tests__/reap-stale.test.ts \
  && make check
```

**depends-on:** none

---

### Group 2: lifecycle + cleanup (#1330 #1410 #1502 #1591)

**Goal:** Make agent lifecycle verbs work for native Claude Code teammates and stop multi-instance routing chaos.

**Deliverables:**
1. **#1330** — `genie stop` (and the parallel `genie kill`) currently fail for native Claude Code teammates with "no active executor linked". Add a fallback path that resolves the tmux pane from the team config when the executor link is absent, then teardown the pane cleanly. Same fix lifts the disambiguation-burns-cycles workflow this wish hit during dispatch cleanup.
2. **#1410** — Multiple Claude instances on the same agent name share a single inbox with no per-instance addressing. Add an instance-id suffix to inbox paths (e.g. `<team>/<agent>#<n>/inbox`), update `genie send --to <agent>#<n>` to route, and dedup by `(agent, instance, msg-hash)` instead of `(agent, msg-hash)`.
3. **#1502** — `omni-bridge` stays stopped after `genie serve` daemon restart. The `evictStalePidfile` path at `omni-bridge.ts:347–391` only unlinks dead-PID files; recycled PIDs after `serve stop`+`start` trigger `pidfile locked`, which `startOmniBridgeSafely` swallows as a degraded state. Make the eviction PID-AND-startTime aware so recycled PIDs are recognized as stale.
4. **#1591** — `cwd-pin` resolver returns null in the bundled binary, leaving the admin.json bypass as the only working path. Investigate why bundled-binary path resolution skips the resolver, then either fix the resolver or formally retire it (the dead-scaffolding cleanup #1594 already started).

**Acceptance Criteria:**
- [ ] `genie stop <native-cc-name>` and `genie kill <native-cc-name>` exit 0 and the tmux pane is gone; regression test added.
- [ ] Two `genie spawn engineer --role engineer` calls produce two distinct inboxes; `genie send --to engineer#1` and `engineer#2` route correctly.
- [ ] After `genie serve restart`, `omni-bridge` reaches `running` state without a manual evict.
- [ ] In bundled-binary mode, cwd-pin resolves to a real value OR the resolver is removed and code paths read directly from admin.json.

**Validation:**
```bash
cd /home/genie/.genie/worktrees/triage-w3-cleanup
bun test src/term-commands/__tests__/stop-native-cc.test.ts \
  && bun test src/lib/__tests__/inbox-multi-instance.test.ts \
  && bun test src/serve/__tests__/omni-bridge-pidfile.test.ts \
  && make check
```

**depends-on:** Group 1

---

### Group 3: team + update flows (#1400 #1581 #1583)

**Goal:** Stop the post-update / team-management flows from referring to verbs that don't exist.

**Deliverables:**
1. **#1400** — `genie team create` currently scaffolds into the global `genie` team when invoked from a master-agent context, leading to subagent leak and collateral termination. Add `--master` flag (or auto-detect master-agent context) and create a project-scoped team with its own session.
2. **#1581** — `ensure-ready.ts:577,590` references `genie team repair <name>` as a fixCommand. The verb is not implemented. Implement `genie team repair` (revalidate config.json members, drop dead pane refs, re-resolve session) OR drop the reference and emit a real fixCommand. Recommend implementing.
3. **#1583** — `update.ts:474` references `genie doctor --update-detection` as a hint when `genie update --next` fails with "Source install path not found". Implement the flag on `doctor.ts` to emit the install-detection probe (which install type was picked, what hint sources were checked, what each returned).

**Acceptance Criteria:**
- [ ] From a master-agent session, `genie team create x --repo /tmp/x` creates `team-x` and does not pollute the global `genie` team; subagents spawned in `x` do not appear in `genie ls --team genie`.
- [ ] `genie team repair test-team` exits 0 and either does the repair or prints a structured report; no more `unknown command 'repair'`.
- [ ] `genie doctor --update-detection` exits 0 and emits a JSON-or-table summary of the detection probe.

**Validation:**
```bash
cd /home/genie/.genie/worktrees/triage-w3-cleanup
bun test src/term-commands/__tests__/team-master-scaffold.test.ts \
  && bun test src/term-commands/__tests__/team-repair.test.ts \
  && bun test src/genie-commands/__tests__/doctor-update-detection.test.ts \
  && make check
```

**depends-on:** Group 1

---

### Group 4: TUI + tests (#1390 #1597 #1598)

**Goal:** Stabilize the user-facing TUI on macOS and stop the test-suite flake.

**Deliverables:**
1. **#1390** — TUI crashes with `bufferDrawBox SIGTRAP` on macOS arm64 in Warp. Pin to a known-working `@opentui/core` (the fix lives on `chore/opentui-0.2-deep` — bring it forward) OR feature-detect the bug and fall back to safe-mode rendering. Coordinate with upstream opentui release if needed.
2. **#1597** — Stale `/dev/shm/pgserve-*` test postmasters not reaped between `bun:test` runs. `reapOrphanedTestPgservers` is startup-only; add a teardown hook that runs on SIGINT and on test runner exit, plus a `genie doctor` cleanup pass.
3. **#1598** — Full-suite test flakes: 15-20 `(unnamed) [5000ms]` hook timeouts that pass in isolation. Implement the `test-suite-deflake` WISH (concurrency cap + setupTestSchema mutex + loud skips). Currently DRAFT.

**Acceptance Criteria:**
- [ ] `genie tui` does not SIGTRAP on macOS arm64 in Warp (verify via macOS CI runner OR explicit feature-detect that falls back).
- [ ] After `bun test`, `ls /dev/shm/pgserve-*` produces 0 directories on Linux (or a bounded set ≤ N).
- [ ] Re-running the full test suite 10× in a row shows ≤ 2 hook timeouts total (down from ~150–200 in current state).

**Validation:**
```bash
cd /home/genie/.genie/worktrees/triage-w3-cleanup
bun test src/tui/__tests__/safe-mode-fallback.test.ts \
  && bun test src/lib/__tests__/test-postmaster-cleanup.test.ts \
  && bash scripts/test-flake-loop.sh 10 \
  && make check
```

**depends-on:** Group 1

---

### Group 5: pgserve hygiene (#1592 #1593 #1595 #1596)

**Goal:** Close out the pgserve config + diagnostics gaps so on-call doesn't hand-edit configs.

**Deliverables:**
1. **#1592** — `max_connections=10000` doesn't apply to an already-running pgserve daemon. Detect daemon-config drift in `getOrStartDaemon()`; either auto-restart OR emit a structured warning with a fixCommand.
2. **#1593** — `pgserve install` fails on pm2 6 due to the upstream `--min-uptime` bug (#1588 sibling). Genie-side warn-and-continue (`install.ts:121`) is intact, but the floor remains `^2.0.0`/`^2.0.8`; coordinate the upstream pgserve fix and bump the floor. **Fallback if upstream is delayed:** ship a feature-detect that pins to a known-working pm2 version with a documented "if pm2 6 then warn + skip pgserve install" path, so the wish does not block on upstream.
3. **#1595** — Migrate to postgres-native peer auth, dropping the `PG_AUTH_FIELD` + `resolvePgserveAuthPassword`/`resolveTcpPgPassword` machinery from `src/lib/db.ts`. Add a `pg_hba` migration step in `doctor.ts`.
4. **#1596** — `src/lib/session-filewatch.ts:163` emits a generic FK-violation log without `err.constraint_name`. Surface the constraint name so on-call can identify the specific FK without re-running with debug.

**Acceptance Criteria:**
- [ ] Starting a pgserve daemon with config drift triggers a structured warning (or auto-restart) instead of silently using the stale config.
- [ ] `pgserve install` succeeds on pm2 6 (post upstream fix) — version floor bumped accordingly.
- [ ] `db status` works with peer auth; password machinery removed; old TCP-password path covered by a deprecation warning before removal.
- [ ] FK violation logs include `err.constraint_name`.

**Validation:**
```bash
cd /home/genie/.genie/worktrees/triage-w3-cleanup
bun test src/lib/__tests__/db-peer-auth.test.ts \
  && bun test src/lib/__tests__/session-filewatch-fk-log.test.ts \
  && make check
```

**depends-on:** Group 1

---

### Group 6: small CLI/UX (#1412 #1460 #1533 #1579 #1584 #1587)

**Goal:** Knock out the small UX papercuts that accumulate.

**Deliverables:**
1. **#1412** — `genie update` does not warn when `~/.genie/serve.pid` points to a live daemon (binary still in memory; manual restart needed). Read serve.pid in `updateCommand` epilogue and emit a structured warning + restart suggestion.
2. **#1460** — Team-lead `idle_notification` routes to its own inbox and surfaces as a teammate-message to the model. Add a self-from guard at `claude-native-teams.ts:409 writeNativeInbox` and stop registering the lead as a member of its own team (line 887).
3. **#1533** — `genie team fire` reports success but doesn't persist member removal. `fireAgent` (`team-manager.ts:590`) only UPDATEs the PG `teams.members`, never rewrites disk `~/.claude/teams/<team>/config.json`. Sync both stores.
4. **#1579** — `wish-lint` schema strips wave/group hierarchy from `depends-on`. `parseWishGroups` (`dispatch.ts:218`) only strips `slug#`, not `slug/Group N`. Match #1406's fix shape (commit `7125bd83`).
5. **#1584** — `genie spawn --provider codex` fails when `~/.genie/relay/<team>/` doesn't exist. `registerOtelRelayPane` at `agents.ts:641-642` writes without an `mkdirSync` on the parent dir. Add the directory creation.
6. **#1587** — `genie agent recover` JSONL scan path is empty when `agent.repoPath` is unset. Add a global session-id fallback so recovery still finds the transcript.

**Acceptance Criteria:**
- [ ] After `genie update` with a live serve pid, the user sees a clear restart warning.
- [ ] Team-lead does not receive its own idle_notifications; verified by spawning a team and tailing the lead's inbox.
- [ ] After `genie team fire <member>`, the disk config.json reflects the removal AND PG reflects it; round-trip test added.
- [ ] `genie wish lint` accepts `slug/Group N` in `depends-on` without truncation.
- [ ] `genie spawn --provider codex` succeeds when relay dir doesn't exist; mkdir is idempotent.
- [ ] `genie agent recover <name>` finds the transcript even when repoPath is empty.

**Validation:**
```bash
cd /home/genie/.genie/worktrees/triage-w3-cleanup
bun test src/genie-commands/__tests__/update-warns-live-serve.test.ts \
  && bun test src/lib/__tests__/team-self-from-guard.test.ts \
  && bun test src/lib/__tests__/team-fire-roundtrip.test.ts \
  && bun test src/wish/__tests__/depends-on-hierarchy.test.ts \
  && bun test src/term-commands/__tests__/spawn-relay-mkdir.test.ts \
  && bun test src/term-commands/__tests__/agent-recover-fallback.test.ts \
  && make check
```

**depends-on:** Group 1

---

### Group 7: dep bumps + omni (#1391 #1394 #1488)

**Goal:** Land the dep bumps that pay off in perf and the omni-bridge correctness fixes.

**Deliverables:**
1. **#1391** — Bump commander v12 → v14 (65 files, breaking: excess args become errors). Audit each `program.command(...)` call for excess-arg usage; add explicit `.allowExcessArguments()` only where intentional.
2. **#1394** — Bump zod v3 → v4 (53 files, perf + bundle-size win). Migrate any deprecated APIs (e.g. `.passthrough()` → `.loose()`).
3. **#1488** — Omni-bridge spawned-worker turn lifecycle: (a) `entry.dir` reads `metadata.dir` not `repo_path`; relative AGENTS.md path leaks. (b) `turn-based-prompt.ts:11` hardcodes "WhatsApp Turn" in a channel-blind template. Fix both. Bug 3 (omni done) is already fixed externally in omni 2.260430.15.

**Acceptance Criteria:**
- [ ] `bun run build` succeeds with commander v14; tests pass; CLI surface unchanged from user-visible POV.
- [ ] `bun run build` succeeds with zod v4; bundle size drops measurably (record before/after in PR).
- [ ] Omni spawned-worker reads `repo_path` and the prompt template is channel-aware.

**Validation:**
```bash
cd /home/genie/.genie/worktrees/triage-w3-cleanup
bun install \
  && bun run build \
  && bun test src/omni/__tests__/spawned-worker-turn.test.ts \
  && make check
```

**depends-on:** Group 1

---

### Group 8: meta verb unification (#1315)

**Goal:** Single ergonomic surface for agent + project registration.

**Deliverables:**
1. **#1315** — Symptoms 3 (built-in name shadowing) and 4 (no `project edit`) plus the verb-unification proposal. Symptom 1 already fixed by `a0d58839`. Implement: (a) detect built-in name shadowing on `agent register` and refuse with a clear error; (b) add `genie project edit` matching the `agent edit` surface; (c) align `genie dir add` and `genie agent register` to a single canonical entry point with the other as alias.

**Acceptance Criteria:**
- [ ] Registering an agent with a built-in name (e.g. `engineer`) is refused with a structured error.
- [ ] `genie project edit` exists with help text and lifecycle parity with `genie agent edit`.
- [ ] `genie dir add` and `genie agent register` no longer silently diverge.

**Validation:**
```bash
cd /home/genie/.genie/worktrees/triage-w3-cleanup
bun test src/term-commands/__tests__/agent-register-shadow.test.ts \
  && bun test src/term-commands/__tests__/project-edit.test.ts \
  && make check
```

**depends-on:** Group 1

---

### Group 9: dep + narrow env (#1392 #1470)

**Goal:** Final low-priority cleanups.

**Deliverables:**
1. **#1392** — Bump @inquirer/prompts v7 → v8 (small surface, ESM-only baseline).
2. **#1470** — `osc52-copy.sh` fallbacks all fail in nested-tmux + no-utmp + no-SSH_TTY. Implement the proposed tmux-socket strategy as a 4th fallback.

**Acceptance Criteria:**
- [ ] `bun run build` succeeds with inquirer v8.
- [ ] `osc52-copy.sh` succeeds in nested-tmux + no-utmp + no-SSH_TTY env (verify via integration test).

**Validation:**
```bash
cd /home/genie/.genie/worktrees/triage-w3-cleanup
bun install \
  && bun run build \
  && bun test src/lib/__tests__/osc52-copy-fallback.test.ts \
  && make check
```

**depends-on:** Group 1

---

### Group 10: enhancement-track pointer comments (#1300 #1368 #1396 #1451)

**Goal:** Mark these as needing their own wish-track instead of letting them rot in the backlog.

**Deliverables:**
1. **#1300** — Comment with: "G1 + G2 shipped (PRs #1472, #1542). G3 (adopt-by-title fallback in `getOrCreateState`) and G4 (skills/wish/SKILL.md `--wish` threading) need their own wish — file `unify-pg-task-creation-g3-g4`."
2. **#1368** — Comment with: "G1 + G2 shipped via PR #1362. G3 (deletion pass + bench), G4 (events-file/redact/persist/audit), G5 (print-cleanup-commands) remain. File `sec-scan-g3-g5` wish."
3. **#1396** — Comment: "Phase 1 shipped (`0ecec572`), Phase 2 ~70% in `claude-sdk.ts`. Phases 3–9 each need their own wish; this issue is now a master tracker."
4. **#1451** — Comment with: "Implementation tracked separately as a wish — file `genie-done-report-broadcast`. The proposal here remains the design source of truth."

**Acceptance Criteria:**
- [ ] Each of the four issues gets a single comment matching the format above with explicit wish-track names.
- [ ] No code changes in this group.

**Validation:**
```bash
gh issue view 1300 --comments | grep -q "wish-track" \
  && gh issue view 1368 --comments | grep -q "wish-track\|sec-scan-g3-g5" \
  && gh issue view 1396 --comments | grep -q "master tracker" \
  && gh issue view 1451 --comments | grep -q "genie-done-report-broadcast"
```

**depends-on:** none (parallel with everything)

---

### Group 11: needs-discussion close/park (#1469 #1478)

**Goal:** Park the irreproducible-but-unconfirmed issues without losing them.

**Deliverables:**
1. **#1469** — Triage agent could not find any `pkill -f "genie serve"` in the tree. Comment asking the reporter to point at the offending script + capture context. Apply label (existing only) or leave open with the comment.
2. **#1478** — Similar — wave-tracker already reads PG state, no `wip:` greps anywhere. Ask reporter to reconfirm on `4.260429.33+` with a real emit path.

**Acceptance Criteria:**
- [ ] Each issue has a single re-triage comment with a specific question for the reporter and a "this issue does not enter execution scope until reproduced" note.
- [ ] No close on either issue (reporter may know something the agent can't see).

**Validation:**
```bash
gh issue view 1469 --comments | grep -q "reporter to reconfirm\|cannot reproduce\|point at the offending" \
  && gh issue view 1478 --comments | grep -q "reporter to reconfirm\|cannot reproduce"
```

**depends-on:** none (parallel with everything)

---

## QA Criteria

- [ ] All 29 GH issues that fall within this wish's "fix-and-merge" scope are CLOSED with a commit/PR reference (3 URGENT + 10 HIGH + 14 NORMAL + 2 LOW).
- [ ] All 4 enhancement-track issues are commented with explicit follow-on wish slugs.
- [ ] All 2 NEEDS-DISCUSSION issues are commented with reconfirm requests.
- [ ] `make check` passes on `dev` HEAD after the final merge.
- [ ] `genie events errors --since 24h` returns no NEW error patterns introduced by these merges (compare against pre-wish baseline snapshot).
- [ ] No regression in `bun test` flake rate: ≤ 2 hook timeouts per full-suite run (Group 4 acceptance criterion holds across the wish).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| First-pass triage anchored to `chore/pgserve-2.0.2`, missed dev-only fixes (saw it on #1521 #1589) | Medium | Decision 3: each group re-anchors to dev as deliverable 0 before any new code |
| 22 PRs in flight is high churn for one reviewer | Medium | One PR per issue but reviews can batch by group; reviewer guidance: review group at a time |
| `make check` may regress under combined merges that pass individually | Medium | After each group merge, re-run `make check` on `dev`; revert offending PR if regression introduced |
| Group 7 (dep bumps) blast radius is wide (commander 65 files, zod 53 files) | High | Land each dep bump in its own PR with a CI-only quality gate; do not combine the two |
| Group 1 #1493 (build size) may reveal that 99 MB → 20 MB needs more than postinstall — could be a wave 1 of N | Medium | If size gate cannot be hit by the obvious lever, escalate to a separate `genie-binary-size` wish and downgrade #1493 to enhancement-track |
| Upstream opentui release for #1390 may not happen before this wish ships | Medium | Group 4 acceptance allows feature-detect + safe-mode fallback; doesn't block on upstream |
| /dream loop may pick groups out of dependency order | Medium | Decision 2 plus the explicit `depends-on: Group 1` on Groups 2–9 forces ordering |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/hooks/identity-inject.ts          # Group 1 (#1491)
src/hooks/runtime-emit.ts             # Group 1 (#1491)
src/hooks/__tests__/identity-attribution.test.ts  # Group 1 (#1491) — new

scripts/build-genie.ts                # Group 1 (#1493)
src/genie-commands/install.ts         # Group 1 (#1493)
package.json                          # Group 1 (#1493) — postinstall flow

src/genie-commands/doctor.ts          # Group 1 (#1582), Group 3 (#1583), Group 5 (#1592 #1595)
src/genie-commands/__tests__/reap-stale.test.ts  # Group 1 (#1582) — new

src/term-commands/agents.ts           # Group 2 (#1330), Group 6 (#1584)
src/term-commands/__tests__/stop-native-cc.test.ts  # Group 2 (#1330) — new
src/term-commands/__tests__/spawn-relay-mkdir.test.ts  # Group 6 (#1584) — new

src/lib/inbox.ts                      # Group 2 (#1410)
src/lib/__tests__/inbox-multi-instance.test.ts  # Group 2 (#1410) — new

src/serve/omni-bridge.ts              # Group 2 (#1502)
src/serve/__tests__/omni-bridge-pidfile.test.ts  # Group 2 (#1502) — new

src/lib/cwd-pin.ts                    # Group 2 (#1591)

src/lib/team-manager.ts               # Group 3 (#1400), Group 6 (#1533)
src/lib/__tests__/team-master-scaffold.test.ts  # Group 3 (#1400) — new
src/lib/__tests__/team-fire-roundtrip.test.ts   # Group 6 (#1533) — new

src/term-commands/team.ts             # Group 3 (#1581 — repair subcommand)
src/term-commands/__tests__/team-repair.test.ts  # Group 3 (#1581) — new

src/genie-commands/update.ts          # Group 6 (#1412)
src/genie-commands/__tests__/update-warns-live-serve.test.ts  # Group 6 (#1412) — new
src/genie-commands/__tests__/doctor-update-detection.test.ts  # Group 3 (#1583) — new

package.json                          # Group 4 (#1390 — opentui), Group 7 (#1391 #1394), Group 9 (#1392)
src/tui/                              # Group 4 (#1390 — feature-detect path)

src/tui/safe-mode.ts                  # Group 4 (#1390) — new feature-detect path
src/tui/__tests__/safe-mode-fallback.test.ts  # Group 4 (#1390) — new

scripts/test-postmaster-cleanup.ts    # Group 4 (#1597) — new
src/lib/__tests__/test-postmaster-cleanup.test.ts  # Group 4 (#1597) — new
scripts/test-flake-loop.sh            # Group 4 (#1598) — new

src/lib/db.ts                         # Group 5 (#1595)
src/lib/__tests__/db-peer-auth.test.ts  # Group 5 (#1595) — new

src/lib/session-filewatch.ts          # Group 5 (#1596)
src/lib/__tests__/session-filewatch-fk-log.test.ts  # Group 5 (#1596) — new

src/lib/claude-native-teams.ts        # Group 6 (#1460)
src/lib/__tests__/team-self-from-guard.test.ts  # Group 6 (#1460) — new

src/term-commands/dispatch.ts         # Group 6 (#1579)
src/wish/__tests__/depends-on-hierarchy.test.ts  # Group 6 (#1579) — new

src/term-commands/agent-recover.ts    # Group 6 (#1587)
src/term-commands/__tests__/agent-recover-fallback.test.ts  # Group 6 (#1587) — new

src/omni/turn-based-prompt.ts         # Group 7 (#1488)
src/omni/__tests__/spawned-worker-turn.test.ts  # Group 7 (#1488) — new

src/term-commands/agent-register.ts   # Group 8 (#1315)
src/term-commands/project.ts          # Group 8 (#1315) — new edit subcommand
src/term-commands/__tests__/agent-register-shadow.test.ts  # Group 8 — new
src/term-commands/__tests__/project-edit.test.ts  # Group 8 — new

src/lib/osc52-copy.sh                 # Group 9 (#1470)
src/lib/__tests__/osc52-copy-fallback.test.ts  # Group 9 (#1470) — new

# No code changes for Groups 10 + 11 — GH comments only.
```
