# Wish: Isolated RAM Pgserve for Tests

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `test-pg-ram-isolation` |
| **Date** | 2026-04-04 |
| **Priority** | P1 |
| **Trace** | [TRACE.md](./TRACE.md) |
| **Depends-on** | `test-schema-isolation` (SHIPPED — this wish extends it) |

## Summary

`bun test` deadlocks on `team.test.ts` because tests and the live `genie serve` daemon share one PostgreSQL database, and their asymmetric catalog-lock orderings trip PG's deadlock detector (full analysis in [TRACE.md](./TRACE.md)). This wish runs the test suite against a dedicated `pgserve --ram` on port `20642`, leaving production untouched, and delivers a clean `bun run check` on the first attempt.

## Scope

### IN
- `bunfig.toml` `[test] preload` entry so **every** `bun test` invocation (including `bun run check`'s inline call) boots the test pgserve before any test file loads.
- Single tiny preload file `src/lib/test-setup.ts` that spawns `pgserve --ram` on the first free port from `20642`, sets `GENIE_TEST_PG_PORT`, and registers a `process.on('beforeExit')` cleanup that SIGTERMs the child.
- Child process spawned with `detached: false` so it dies with the test runner even on crash — no async exit hooks required.
- Minimal branch in `src/lib/db.ts :: _ensurePgserve()` that, when `GENIE_TEST_PG_PORT` is set, skips the lockfile/daemon auto-start and connects directly to the test port.
- Linux fallback: if `/dev/shm` is unavailable, spawn with `--data /tmp/genie-test-pg-<pid>` and delete the dir on exit.
- Single new test file `src/lib/test-setup.test.ts` proving the preload wired up correctly (connection reaches the test port, not `19642`).

### OUT
- No new bootstrap module (`test-pgserve.ts`) — logic fits in `test-setup.ts` in ~60 lines.
- No changes to the `package.json` `"test"` script — `bun test` already picks up bunfig.toml.
- No changes to any existing `*.test.ts` file or to `test-db.ts` — they keep calling `ensurePgserve()` unchanged.
- No changes to production `genie serve` behavior when `GENIE_TEST_PG_PORT` is unset (verified by regression check).
- No CI changes — CI path (`describe.skipIf(!DB_AVAILABLE)`) continues to work when pgserve is unavailable.
- No `async` exit handlers — the child-dies-with-parent model is sufficient and avoids known Bun/Node `process.on('exit')` footguns.
- Fixes to any test flakiness unrelated to PG deadlocks.

## Decisions

| Decision | Rationale |
|----------|-----------|
| `bunfig.toml [test] preload` instead of `package.json "test"` script | `bun run check` calls `bun test` directly (not `bun run test`), so a package.json change would bypass the pre-push hook. bunfig.toml applies to every `bun test` invocation. |
| One preload file, no separate module | Keeps the fix ~60 lines, fewer files to review, no indirection. The existing `db.ts` branch is the only code-path change. |
| Port discovery from `20642` upward | Avoids collision with production pgserve (19642) and with another dev machine's custom port; logs chosen port on stdout for debuggability. |
| `detached: false` + `child.unref = false` | Child inherits parent's process group; when `bun test` exits (normal, crash, Ctrl-C), the kernel SIGHUPs the group and pgserve dies. No async cleanup needed. |
| `--ram` on Linux, `--data /tmp/...` fallback | `/dev/shm` confirmed 252 GB free on this host. macOS/WSL2 without `/dev/shm` fall back to `/tmp` which is APFS/tmpfs-backed and still fast. |
| No schema-level refactor | The existing `test-schema-isolation` (SHIPPED) design stays; this wish only swaps the underlying pgserve instance. |

## Success Criteria

- [ ] `bun test` passes 10 consecutive runs with **zero** deadlock-related failures.
- [ ] `bun run check` passes on the first attempt while `genie serve` is running.
- [ ] `ps -ef | grep 'pgserve.*20642'` shows a running child during `bun test` and nothing after exit.
- [ ] `ls ~/.genie/data/pgserve` is byte-identical (name + size + mtime) before and after a test run.
- [ ] `GENIE_TEST_PG_PORT` unset → `ensurePgserve()` behaves exactly as today (regression check passes).
- [ ] `bun run typecheck`, `bun run lint`, `bun run dead-code` all pass.
- [ ] Test suite wall-clock time ≤ current baseline (target: faster from RAM I/O).

## Execution Strategy

### Wave 1 (sequential — foundation)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add `bunfig.toml` preload, create `src/lib/test-setup.ts`, patch `db.ts`, write unit test |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | qa | 10× soak run, production isolation byte-check, pre-push hook validation with daemon active |

## Execution Groups

### Group 1: Bunfig Preload + `db.ts` Branch

**Goal:** Make every `bun test` invocation boot a dedicated RAM pgserve on port 20642 before any test file loads, with zero impact when `GENIE_TEST_PG_PORT` is unset.

**Deliverables:**

1. **`bunfig.toml`** (new file at repo root):
   ```toml
   [test]
   preload = ["./src/lib/test-setup.ts"]
   ```

2. **`src/lib/test-setup.ts`** (new, ~60 lines):
   - `spawn(findPgserveBin(), [...args], { stdio: 'ignore', detached: false })` — child inherits process group, dies with parent automatically.
   - Scans ports `20642..20742` for the first free port via a TCP probe.
   - Args: `--port <n> --host 127.0.0.1 --log warn --no-stats --no-cluster --no-provision` + `--ram` on Linux / `--data /tmp/genie-test-pg-<pid>` otherwise.
   - Polls `isPostgresHealthy(port)` up to 15s; throws on timeout so tests fail fast.
   - On success: `process.env.GENIE_TEST_PG_PORT = String(port)` + `process.env.GENIE_PG_AVAILABLE = 'true'`.
   - `process.on('beforeExit', () => child.kill('SIGTERM'))` — best-effort async-safe cleanup; the process-group fallback guarantees termination.
   - Logs `[test-setup] pgserve --ram on port <n>` once at startup.

3. **`src/lib/db.ts :: _ensurePgserve()`** — insert as the **first** branch (before lockfile read):
   ```ts
   const testPort = process.env.GENIE_TEST_PG_PORT;
   if (testPort) {
     const port = Number.parseInt(testPort, 10);
     if (!Number.isNaN(port) && (await isPostgresHealthy(port))) {
       activePort = port;
       process.env.GENIE_PG_AVAILABLE = 'true';
       return port;
     }
     throw new Error(`GENIE_TEST_PG_PORT=${testPort} set but not healthy`);
   }
   ```
   No other lines in `db.ts` change. Production path (`testPort` undefined) executes exactly as today.

4. **`src/lib/test-setup.test.ts`** (new):
   - Asserts `process.env.GENIE_TEST_PG_PORT` is a parseable integer ≥ 20642 when the suite runs.
   - Asserts the port differs from `process.env.GENIE_PG_PORT` / `19642`.
   - Asserts `getConnection()` returns a connection to the test port (runs `SELECT inet_server_port()`).
   - On Linux: asserts a `/dev/shm/genie-test-pg*` or `PostgreSQL.*` segment exists for the chosen port (via `ls /dev/shm`).

5. **`src/lib/test-setup.ts`** must `export async function stopTestPgserve()` so the unit test can assert clean shutdown semantics even though the `beforeExit` hook owns the runtime cleanup.

**Acceptance Criteria:**
- [ ] `bun test src/lib/test-setup.test.ts` passes.
- [ ] `bun test` during a live `genie serve` session connects to port 20642, not 19642 (verified by `lsof -i :20642` during the run).
- [ ] Running `bun test` twice in a row succeeds both times — no stale `/dev/shm` or stale-port issues.
- [ ] `unset GENIE_TEST_PG_PORT; bun run typecheck && bun run lint` still clean (regression).
- [ ] No modifications to any existing `*.test.ts` file, `test-db.ts`, or `package.json`.
- [ ] `test-setup.ts` is ≤ 80 lines including imports, comments, and the exported function.

**Validation:**
```bash
cd /home/genie/.genie/worktrees/genie/omni-fix

# Setup: production daemon active
genie serve start --headless >/dev/null 2>&1

# Run target test file (new) + a known-dependent file
bun test src/lib/test-setup.test.ts src/lib/wish-state.test.ts

# Verify port binding during a run
(bun test &) ; sleep 2 ; lsof -i :20642 | head -3 ; wait

# Verify cleanup
pgrep -f 'pgserve.*20642' && echo "LEAK" || echo "OK"
ls /dev/shm/genie-test-pg* 2>/dev/null && echo "LEAK" || echo "OK"

# Regression: production path untouched
env -u GENIE_TEST_PG_PORT bun run typecheck
```

**depends-on:** none

---

### Group 2: Deadlock Soak + Production Isolation Proof

**Goal:** Prove the deadlocks are gone, production is untouched, and `bun run check` lands cleanly.

**Deliverables:**

1. **Soak run** — `bun test` 10 consecutive times with `genie serve` active in parallel. Record pass/fail counts and any deadlock stack traces.
2. **Production isolation check** — `find ~/.genie/data/pgserve -type f -exec sha256sum {} \;` before and after a test run; hashes must match.
3. **Pre-push hook run** — invoke `bun run check` twice (matches the `(bun test || bun test)` pattern in the hook); both attempts must pass.
4. **Baseline vs RAM timing** — record wall-clock for each run; RAM mode must be ≤ current baseline. (If slower, investigate fsync batching in the fallback path.)
5. **`.genie/wishes/test-pg-ram-isolation/QA.md`** — report with raw logs, pass counts, timing comparison, and a one-line verdict.

**Acceptance Criteria:**
- [ ] 10/10 soak runs pass zero deadlock-related failures (any failure in a different file is triaged but does not block this wish).
- [ ] Production pgserve data dir sha256sums identical before and after.
- [ ] `bun run check` exits 0 on the first run.
- [ ] RAM test wall time ≤ baseline wall time.
- [ ] Zero leaked `/dev/shm/genie-test-pg*` or pgserve processes after the soak completes.

**Validation:**
```bash
# Soak loop
for i in $(seq 1 10); do
  bun test 2>&1 | tail -3 | tee -a /tmp/soak-$i.log
done
! grep -l "deadlock detected" /tmp/soak-*.log   # must exit 0 (no matches)

# Isolation: hash production dir before and after
find ~/.genie/data/pgserve -type f -exec sha256sum {} \; | sort > /tmp/before.sum
bun test >/dev/null 2>&1
find ~/.genie/data/pgserve -type f -exec sha256sum {} \; | sort > /tmp/after.sum
diff /tmp/before.sum /tmp/after.sum    # must be empty

# Pre-push hook
bun run check
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] `bun test` runs deterministically 10× with zero deadlock failures.
- [ ] `genie serve` continues to operate during test runs with no observable production impact.
- [ ] `~/.genie/data/pgserve` byte-identical (sha256) before and after tests.
- [ ] `bun run check` passes on the first attempt.
- [ ] Test pgserve killed and `/dev/shm/genie-test-pg*` cleaned up on normal and SIGINT exits.
- [ ] `bun run typecheck`, `bun run lint`, `bun run dead-code` all clean.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `bun test` does not honor `bunfig.toml [test] preload` | High | `src/lib/test-setup.test.ts` proves the hook ran (asserts `GENIE_TEST_PG_PORT` is set). If preload is silently ignored, the test fails loudly. |
| `bunfig.toml` at repo root conflicts with existing Bun runtime config | Low | No `bunfig.toml` exists today (verified via `ls`). Creating one is additive. |
| `process.on('beforeExit')` does not fire on SIGKILL / `bun test` crash | Low | `detached: false` puts the child in the parent's process group; kernel SIGHUPs the group on parent death. beforeExit hook is a best-effort courtesy, not the primary cleanup path. |
| Port 20642..20742 all occupied on some dev host | Low | Scan range of 100 ports; log the chosen port; throw a clear error if none free. |
| `--ram` mode behaves differently from `--data` mode for catalog writes | Low | pgserve's README lists `--ram` as an I/O storage flag only; query planner/catalog paths are identical. Unit test covers a `CREATE TABLE` + `INSERT` + `SELECT` round-trip to confirm. |
| Masking a real lock-order bug in production code | Medium | Group 2 explicitly verifies production pgserve is byte-identical before/after tests. Any production lock-order bug surfaces independently when `genie serve` runs under load. |
| Startup overhead of spawning pgserve per `bun test` | Low | pgserve `--ram` cold-start is <1s locally. If `bun run check` shows a regression, that counts as a HIGH bug and blocks the wish. |

## Files to Create/Modify

```
CREATE:
  bunfig.toml                                           — [test] preload entry
  src/lib/test-setup.ts                                 — ~60-line preload (spawn + env + beforeExit)
  src/lib/test-setup.test.ts                            — proves preload wiring
  .genie/wishes/test-pg-ram-isolation/TRACE.md          — full deadlock trace (done)
  .genie/wishes/test-pg-ram-isolation/QA.md             — Group 2 soak report

MODIFY:
  src/lib/db.ts                                          — 10-line branch at the top of _ensurePgserve()
```

## Review Results

_Populated by `/review` after plan approval._
