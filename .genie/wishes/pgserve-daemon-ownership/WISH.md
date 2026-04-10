# WISH: pgserve Daemon Ownership — Self-Healing Database Layer

**Status:** DRAFT
**Priority:** P0 — database unavailability blocks all CLI commands
**Repo:** repos/genie/
**Branch:** fix/pgserve-daemon-ownership

## Problem

Every genie CLI command tries to start its own pgserve instance, racing with the daemon and other commands. This causes zombie postgres processes, port conflicts, stale shared memory, and unrecoverable broken connections. Users must manually kill processes and clean up to recover.

## Design

One rule: **the daemon owns PG.** Everything else follows.

```
genie <any command>
  ├─ Is daemon running? (check PID file)
  │   ├─ YES → read port from ~/.genie/pgserve.port → connect
  │   └─ NO  → start daemon (which starts PG) → read port → connect
  └─ Is connection healthy? (SELECT 1)
      ├─ YES → proceed
      └─ NO  → kill stale PG, restart daemon, retry once
```

No CLI command ever starts pgserve directly. If the daemon isn't running, the CLI auto-starts it. Self-healing on every connection attempt.

## Changes

### 1. Daemon advertises PG port (`scheduler-daemon.ts`)
- After pgserve starts successfully, write port to `~/.genie/pgserve.port` atomically
- On daemon stop, remove the port file
- This is the single source of truth for "where is PG?"

### 2. CLI auto-starts daemon (`db.ts`)
- `ensurePgserve()` becomes: read `~/.genie/pgserve.port` → if exists and healthy, use it
- If port file missing or stale → check if daemon is running (PID file) → if not, `genie daemon start` in background
- Wait up to 10s for port file to appear (daemon booting PG)
- Never start pgserve directly from CLI

### 3. Health check replaces TCP check (`db.ts`)
- Replace `isPortListening()` (TCP-only) with `isPostgresHealthy(port)` that runs `SELECT 1`
- If health check fails → connection is broken → clear cached `sqlClient` → trigger self-heal

### 4. Connection recovery (`db.ts`)
- `getConnection()` wraps the cached client in a health check on first use per call stack
- If `sqlClient` exists but query fails → set `sqlClient = null` → retry `getConnection()` once
- No infinite retry — fail after one recovery attempt with clear error

### 5. Self-heal: zombie + shared memory cleanup (`db.ts`)
- Before starting pgserve (in daemon), run cleanup:
  - `pkill -9 -f "postgres.*pgserve"` to kill any stale postgres
  - Remove `~/.genie/data/pgserve/postmaster.pid` if exists
  - Clean stale shared memory via `ipcrm`
- This runs automatically — no user intervention

### 6. `genie doctor --fix` (`genie-commands/doctor.ts`)
- Add `--fix` flag that auto-heals:
  - Kills zombie/stale postgres processes
  - Cleans shared memory segments
  - Removes stale port/PID files
  - Restarts daemon
- Without `--fix`, doctor reports the issues (existing behavior)

### 7. Remove preAction audit race (`genie.ts`)
- The `preAction` hook fires `recordAuditEvent()` which triggers `getConnection()` independently
- Change to: only record audit events if DB is already connected (check `sqlClient !== null`)
- No fire-and-forget DB connection attempts from audit hooks

## Files to Modify

- `src/lib/db.ts` — port file protocol, health check, connection recovery, self-heal cleanup, remove per-command pgserve startup
- `src/lib/scheduler-daemon.ts` — write port file after pgserve start, remove on stop
- `src/genie.ts` — fix preAction audit race
- `src/genie-commands/doctor.ts` — add `--fix` flag

## Acceptance Criteria

### Must Have (P0)
1. **Daemon owns PG** — only the daemon starts pgserve, writes port to `~/.genie/pgserve.port`
2. **CLI auto-starts daemon** — `genie sessions list` without daemon running → daemon starts → PG available → command succeeds
3. **Health check** — `SELECT 1` instead of TCP connect to verify PG is alive
4. **Connection recovery** — broken cached connection is cleared and retried once, not cached forever
5. **Self-heal on startup** — daemon kills stale postgres, cleans shared memory, removes stale PID before starting pgserve
6. **Port file removed on stop** — `genie daemon stop` removes `~/.genie/pgserve.port`
7. **No per-command pgserve** — CLI commands never call pgserve startup directly
8. **Audit hook safe** — preAction only records if DB already connected, no independent startup

### Should Have (P1)
9. **`genie doctor --fix`** — automated recovery command
10. **Graceful timeout** — CLI waits up to 10s for daemon to boot PG, then fails with clear error

## Execution Groups

### Group 1: Port file + daemon ownership
**Files:** `src/lib/scheduler-daemon.ts`, `src/lib/db.ts`
- Daemon writes `~/.genie/pgserve.port` after successful pgserve start
- Daemon removes port file on stop
- `ensurePgserve()` reads port file first, trusts it if healthy

### Group 2: Health check + connection recovery + self-heal
**Files:** `src/lib/db.ts`
- Replace `isPortListening()` with `isPostgresHealthy()`
- Add connection recovery to `getConnection()`
- Add self-heal cleanup before pgserve start (pkill, rm pid, ipcrm)
- CLI auto-starts daemon if port file missing

### Group 3: Audit fix + doctor
**Files:** `src/genie.ts`, `src/genie-commands/doctor.ts`
- Fix preAction to not trigger independent DB startup
- Add `--fix` flag to doctor command

## Validation

```bash
# Scenario 1: cold start (no daemon)
genie daemon stop; sleep 2
genie sessions list
# Expected: daemon auto-starts, PG boots, sessions listed

# Scenario 2: daemon restart
genie daemon stop; sleep 2; genie daemon start
genie sessions list
# Expected: immediate success, single pgserve instance

# Scenario 3: kill postgres, verify self-heal
kill -9 $(pgrep -f "postgres.*pgserve" | head -1)
sleep 5
genie sessions list
# Expected: daemon detects dead PG, restarts, command succeeds

# Scenario 4: no duplicate pgserve
genie sessions list & genie sessions list & genie sessions list
ps aux | grep pgserve | grep -v grep | wc -l
# Expected: 1 pgserve instance

# Scenario 5: doctor --fix
genie doctor --fix
# Expected: reports and fixes any stale PG state
```
