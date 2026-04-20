# Wish: Serve Stability — Proven Bug Fixes

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-serve-stability` |
| **Date** | 2026-04-19 |
| **Design** | _No brainstorm — direct wish_ |

## Summary
`genie serve` silently exits with code 1 whenever the Omni bridge fails to connect to NATS, which is the default state on any dev machine without NATS running. This makes every CLI command (`genie team create`, `genie ls`, etc.) hang for 16 seconds and fail with a misleading error, which blocks testing genie — which in turn blocks review of PR #1202. This wish fixes the root cause and four related defensive bugs so serve stays up, crashes become visible, and stale-state never silently blocks a CLI call again.

## Scope
### IN
- **Bug 0** — Stop `process.exit(1)` on Omni bridge failure; degrade to optional unless `GENIE_OMNI_REQUIRED=1`
- **Bug 1** — Clean `serve.pid` on normal exit, SIGTERM, SIGINT, and uncaught exception
- **Bug 2** — Verify PID identity (not just PID existence) in `autoStartDaemon`; reject recycled PIDs
- **Bug 3** — Ensure `daemon_stopped` event fires on graceful shutdown (regression test)
- **Bug 4** — Distinguish "tmux socket missing" (permanent) from "pane not found" (transient) in worker reconciliation; unregister workers whose socket no longer exists
- **Bug 5** — Replace single timeout error with branched message that names the actual failure mode
- End-to-end repro script: `scripts/tests/repro-serve-stability.sh`

### OUT
- Redesigning the Omni bridge itself (just making it optional for now)
- NATS setup documentation / install automation
- The 54 PR #1202 CodeRabbit/Gemini/Codex comments (separate wish after this unblocks testing)
- pgserve cold-start performance tuning (16s timeout is fine once Bug 0 is fixed)
- `tmux -L genie` socket auto-creation on serve start (surfaced during investigation but out of scope)

## Decisions
| Decision | Rationale |
|----------|-----------|
| Omni bridge failure is a `console.warn` + continue, not `process.exit(1)` | The adjacent omni-approval-handler (serve.ts:569) is already wrapped in `try/catch {}` with "non-fatal" comment. The bridge got the wrong classification. Matching the existing pattern is less surprising than a new flag. |
| Behind `GENIE_OMNI_REQUIRED=1` env var for strict deployments | Production environments that genuinely require omni can opt in without changing the default |
| PID identity via **process start time** (not random token) | Tokens require IPC to verify. Start-time is already kernel-held and readable via `ps -p <pid> -o lstart=` (macOS) / `/proc/<pid>/stat` (Linux). Store as `{pid}:{startTime}` in serve.pid. |
| Dead-socket reconciliation is keyed on tmux socket existence, not error string | `TmuxUnreachableError` can be socket-missing OR a transient blip. Check `ls /tmp/tmux-<uid>/genie` separately — if the socket file doesn't exist, every worker on it is permanently dead. |
| Branched error message in db.ts names 3 concrete cases | *"serve not running"*, *"serve running but pgserve unreachable"*, *"stale PID"* — each suggests a different remediation |
| Repro script lives at `scripts/tests/repro-serve-stability.sh` | Matches existing `scripts/tests/repro-*.sh` convention for this repo |

## Success Criteria
- [ ] `genie serve start` stays running when NATS is not available (default dev setup)
- [ ] `genie serve stop` / SIGTERM emits `daemon_stopped` to `~/.genie/logs/scheduler.log`
- [ ] `genie serve stop` / SIGTERM / crash removes `~/.genie/serve.pid`
- [ ] With a live non-serve PID in `serve.pid`, CLI commands do not hang 16s — they spawn a new serve
- [ ] `GENIE_OMNI_REQUIRED=1 genie serve start` exits non-zero if NATS is down (preserves old strict behavior)
- [ ] Repro script `scripts/tests/repro-serve-stability.sh` exits 0 (all 5 scenarios verified)
- [ ] Workers registered on a tmux socket that no longer exists are cleaned in ≤1 scheduler tick
- [ ] Bun tests added for each bug pass: `bun test src/term-commands/serve.test.ts src/lib/db.test.ts src/lib/agent-registry.test.ts`
- [ ] `bun run check` passes (typecheck + lint + dead-code + test)

## Execution Strategy

### Wave 1 (parallel — all three groups independent)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Bug 0 + Bug 1 + Bug 3 — serve.ts lifecycle: make bridge optional, wire exit/signal handlers, verify daemon_stopped fires |
| 2 | engineer | Bug 2 + Bug 5 — db.ts + serve.ts: `{pid}:{startTime}` PID format + identity check + branched timeout message. Backward-compat: reads old single-PID format as stale. |
| 3 | engineer | Bug 4 — agent-registry.ts: distinguish socket-missing from transient tmux errors, unregister dead-socket workers |

Group 1 and Group 2 both touch `serve.ts` but in different functions (`startForeground` lifecycle vs `writeServePid` format). Merge conflicts are limited to imports; resolve at wave end.

### Wave 2 (validation)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | qa | End-to-end repro script + manual QA: serve survives no-NATS, CLI doesn't hang on stale PID, dead-socket workers cleaned |
| review | reviewer | Full review of all changes against success criteria |

## Execution Groups

### Group 1: Serve lifecycle — Bug 0 + Bug 1 + Bug 3
**Goal:** Serve process no longer exits on bridge failure; all shutdown paths clean up PID file and emit `daemon_stopped`.

**Deliverables:**
1. `src/term-commands/serve.ts:583-589` — replace `process.exit(1)` on bridge failure with `console.warn('  Omni bridge: degraded — <msg>'); // continue`, gated by `if (process.env.GENIE_OMNI_REQUIRED === '1') process.exit(1)` for strict mode.
2. `src/term-commands/serve.ts` in `startForeground()` — register cleanup handlers for `SIGTERM`, `SIGINT`, `SIGHUP`, `exit`, and `uncaughtException` that call `removeServePid()` + invoke the existing `shutdown()` sequence.
3. `src/term-commands/serve.ts` — ensure existing `shutdown()` at line 599 awaits `schedulerHandle.stop()` and its `done` promise so `daemon_stopped` is flushed before exit.
4. `src/term-commands/serve.test.ts` — new test: spawn `genie serve start --foreground` with `GENIE_NATS_URL=nats://127.0.0.1:1` (refused), assert process stays alive for ≥3s and writes PID file; send SIGTERM, assert PID file removed and `daemon_stopped` appears in scheduler log.

**Acceptance Criteria:**
- [ ] `genie serve start --foreground` with no NATS running does not exit; prints `Omni bridge: degraded — CONNECTION_REFUSED` and continues
- [ ] `GENIE_OMNI_REQUIRED=1 genie serve start --foreground` with no NATS exits 1
- [ ] After SIGTERM, `~/.genie/serve.pid` is gone
- [ ] After SIGTERM, `~/.genie/logs/scheduler.log` contains a `daemon_stopped` event for the just-stopped daemon
- [ ] New bun test passes

**Validation:**
```bash
bun test src/term-commands/serve.test.ts -t "bridge failure"
bun test src/term-commands/serve.test.ts -t "graceful shutdown"
```

**depends-on:** none

---

### Group 2: Auto-start identity — Bug 2 + Bug 5
**Goal:** `autoStartDaemon` rejects stale `serve.pid` entries whose PID was recycled to a different process; CLI error message names the actual failure mode.

**Deliverables:**
1. `src/term-commands/serve.ts` — `writeServePid` writes `{pid}:{startTime}` where `startTime` comes from `ps -o lstart= -p $$` (macOS) or `/proc/self/stat` field 22 (Linux). Add a small helper `getProcessStartTime(pid)` covering both.
2. `src/lib/db.ts:227-257` — `autoStartDaemon` reads `{pid}:{startTime}` from serve.pid. Calls `process.kill(pid, 0)` AND `getProcessStartTime(pid)`. If either fails OR start times don't match, treat as stale and proceed to spawn. Backward compatible: if file has old format (just PID), treat as stale (forces one-time respawn on upgrade).
3. `src/lib/db.ts:332` — replace single error with branched message:
   - no serve.pid file → *"genie serve not running. Run: genie serve start"*
   - serve.pid valid but pgserve unreachable → *"genie serve is running (PID N) but pgserve did not start within 16s. Try: genie serve restart, or check ~/.genie/logs/scheduler.log"*
   - serve.pid refers to recycled/dead PID → *"Stale ~/.genie/serve.pid (PID N is not our serve process). Removing and retrying…"* and retry once
4. `src/lib/db.test.ts` — tests for each branch: stale PID + recycled PID + no PID file + valid PID + unhealthy pgserve. Use a mock `getProcessStartTime` to simulate mismatch.

**Acceptance Criteria:**
- [ ] Writing a live non-serve PID to `serve.pid` no longer causes 16s timeout; serve spawns fresh
- [ ] Upgrade path: old single-PID format in `serve.pid` is treated as stale, respawn succeeds
- [ ] Each of the 3 timeout branches produces the named message
- [ ] Bun tests pass on macOS and Linux (CI matrix)

**Validation:**
```bash
bun test src/lib/db.test.ts -t "autoStartDaemon"
# Manual repro (macOS):
echo "$$:stub" > ~/.genie/serve.pid  # current shell PID, wrong identity
time genie ls --json  # must NOT hang 16s
```

**depends-on:** none — runs in parallel with Group 1. Reads old single-PID format as "stale" for one-time respawn on upgrade; no structural dependency on Group 1's changes.

---

### Group 3: Worker reconciliation — Bug 4
**Goal:** Workers registered on a tmux socket that no longer exists are marked `error` and cleaned on the next reconciliation tick, instead of failing forever in `recovery_worker_failed`.

**Deliverables:**
1. `src/lib/agent-registry.ts:304-345` — extend reconciliation: before per-worker `isPaneAlive(pane_id)`, check whether the tmux socket for that worker exists (via `fs.existsSync('/tmp/tmux-<uid>/<socketName>')` — socketName from the worker's session metadata or the global `-L genie` default). If socket is missing, mark ALL workers on that socket as `error`, clear `pane_id`, emit an audit event, and skip the per-worker check.
2. `src/lib/tmux.ts` (or wherever socket discovery lives) — small helper `isTmuxSocketAlive(name)` that stats the socket file. Share between reconciliation and status command.
3. `src/lib/agent-registry.test.ts` — test: register worker with a fake `pane_id` on a non-existent socket, run `reconcileStaleSpawns`, assert worker transitions to `error` and `pane_id` is cleared. **Write the test first and verify it FAILS against current `main` — this proves Bug 4 is a real defect, not a refactoring target.** Then apply the fix and confirm the test passes.
4. Verify scheduler log stops emitting `recovery_worker_failed` for these workers after the fix.

**Acceptance Criteria:**
- [ ] Worker with dead-socket pane gets `error` state after one reconciliation pass
- [ ] Scheduler log no longer spams `recovery_worker_failed` for dead-socket workers
- [ ] Workers on live sockets still get the transient-retry protection (existing behavior preserved)
- [ ] Bun test passes

**Validation:**
```bash
bun test src/lib/agent-registry.test.ts -t "dead socket"
```

**depends-on:** none

---

### Group 4: End-to-end repro + QA
**Goal:** One script that exits 0 iff all five bugs are demonstrably fixed, and manual QA confirms genie is usable without NATS.

**Deliverables:**
1. `scripts/tests/repro-serve-stability.sh` — shell script that runs five scenarios in sequence with temporary `GENIE_HOME`:
   - **S1 (Bug 0):** start serve with unreachable NATS, sleep 5s, verify process still alive and `serve.pid` present.
   - **S2 (Bug 1):** kill serve via SIGTERM, verify `serve.pid` removed and `daemon_stopped` in log.
   - **S3 (Bug 2):** write a live non-serve PID to `serve.pid`, run `genie ls --json`, assert exit 0 within 5s (not 32s).
   - **S4 (Bug 4):** insert a worker row on a fake tmux socket, run scheduler one tick, assert worker state is `error`.
   - **S5 (Bug 5):** three timeout scenarios, assert each stderr matches the expected branched message.
2. Document manual QA checklist in the wish's QA Criteria section.

**Acceptance Criteria:**
- [ ] `bash scripts/tests/repro-serve-stability.sh` exits 0 on macOS and Linux
- [ ] Each scenario prints a clear ✅ / ❌ line so failures are easy to identify
- [ ] Script cleans up its `GENIE_HOME` directory on both success and failure

**Validation:**
```bash
bash scripts/tests/repro-serve-stability.sh
```

**depends-on:** Group 1, Group 2, Group 3

---

## QA Criteria

_Tested on dev after merge before declaring the wish done._

- [ ] Fresh machine (no NATS): `genie serve start` — serve stays up, `genie ls` returns in <3s
- [ ] `genie serve stop` cleanly exits — no stale PID, `daemon_stopped` logged
- [ ] Kill serve with SIGKILL (simulates crash): next CLI call auto-starts a new serve within 5s
- [ ] `genie team create test-xyz --repo $(pwd)` completes successfully without NATS (regression check for the user-visible symptom)
- [ ] No scheduler log spam over a 5-minute idle window (regression for Bug 3+Bug 4)
- [ ] PR #1202 test suite can run end-to-end (original blocker)

---

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| `ps -o lstart=` format differs across macOS versions | Low | Parse defensively; fall back to "unknown" → treat as stale. Test on current macOS + Ubuntu. |
| Someone is actually running with NATS in production and expects bridge to be mandatory | Medium | `GENIE_OMNI_REQUIRED=1` preserves strict behavior; document in commit message and CHANGELOG. |
| Dead-socket reconciliation wrongly classifies a transient tmux socket permission blip as permanent | Low | Stat the socket path AND run one retry after 100ms before flipping workers to `error`. |
| Existing `~/.genie/serve.pid` in old single-PID format after upgrade causes one unnecessary respawn | Low (accepted) | Design intent; documented. |
| PID file race between shutdown-handler-removing-it and new serve writing it | Low | `writeServePid` uses atomic write (`.tmp` + rename) already; shutdown removes only if the file's PID matches `process.pid`. |
| Fixing Bug 0 reveals downstream bugs that were masked by early serve death | Medium | Allocate buffer in Group 4 QA to surface and triage. If new bugs appear, file separately rather than expand this wish's scope. |

---

## Review Results

### Plan Review — 2026-04-19 — Round 1

**Verdict:** FIX-FIRST → resolved inline → **SHIP (plan)**

**Gaps addressed:**
- [HIGH] Wave 2 parallelization — Group 2's "depends-on: Group 1" was overstated; Group 1 only adds exit handlers that call existing `removeServePid`, not the format change. → Fixed: Group 2 moved into Wave 1, now runs parallel with Groups 1 and 3.
- [MEDIUM] Bug 4 test should fail-first to prove bug is real → Fixed: Group 3 deliverable 3 now mandates failing-test-first verification.

All Plan Review checklist items (problem statement, scope IN/OUT, testable acceptance criteria, bite-sized tasks, dependencies, validation commands) passed on Round 1. Decisions-table calls (GENIE_OMNI_REQUIRED env var, `{pid}:{startTime}` identity, socket-existence reconciliation, branched error, repro-script location) all confirmed sound by reviewer. No scope creep, no missing bug coverage, no correctness concerns in the plan itself.

_Execution review — populated after `/work` completes._

---

## Files to Create/Modify

```
Modify:
  src/term-commands/serve.ts         # Bug 0, Bug 1, Bug 2 write-side
  src/lib/db.ts                      # Bug 2 read-side, Bug 5
  src/lib/agent-registry.ts          # Bug 4
  src/lib/tmux.ts                    # (new helper: isTmuxSocketAlive)

Create:
  src/term-commands/serve.test.ts    # lifecycle tests (may append to existing)
  scripts/tests/repro-serve-stability.sh
  .genie/wishes/genie-serve-stability/WISH.md (this file)

Test additions (may be in existing files):
  src/lib/db.test.ts                 # autoStartDaemon branches
  src/lib/agent-registry.test.ts     # dead-socket reconciliation
```
