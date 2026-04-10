# WISH: os-services Orphan Process Leak — OOM Hotfix

**Status:** DRAFT
**Priority:** P0 — active incident, OOM-killed machine twice on 2026-03-27
**Repo:** /home/genie/prod/khal-os
**Branch:** fix/os-services-orphan-leak

## Incident Summary

Machine ran out of memory (75GB / 127GB consumed) due to **1,016 orphaned genie service processes** accumulating over time. Each process consumed ~50-113MB RSS, totaling ~49.5GB.

**Timeline:**
- `os-services` (pm2 id 9) runs `service-loader.ts` which spawns N child services via `spawn('npx', ['tsx', path])`
- Each `npx tsx` spawn creates a 5-process tree: `npx → sh → node(tsx-cli) → npm-exec → node(service)`
- When `os-services` crashes or is restarted by PM2, only the direct child (npx) receives SIGTERM
- The `sh → node → npm → node` grandchildren become orphans (PPID=1) and keep running
- PM2's tree-kill cannot follow the npx→sh→node chain
- Each restart cycle leaves ~5 × N_services orphans behind
- With 37+ restarts of `os-services` and 1,092+ restarts of `omni-nats`, orphans accumulated to 1,000+

## Root Causes

### Bug 1: npx Spawn Creates Unkillable Process Trees

**File:** `src/lib/service-loader.ts:257-258`
```typescript
// Dev mode: use npx tsx
cmd = ['npx', 'tsx', service.path];
```

**Line 265:** `spawn(cmd[0], cmd.slice(1), { ... })` — spawns npx as direct child.

**Line 392:** `service.process.kill()` — sends SIGTERM to npx PID only, not the process group.

**Why it leaks:**
1. `npx` spawns `sh -c "tsx" <path>` (shell wrapper)
2. `sh` spawns `node tsx/dist/cli.mjs <path>` (tsx runner)
3. tsx spawns the actual service node process
4. `process.kill()` (default SIGTERM) only hits the direct child PID (npx)
5. npx does NOT propagate signals to its shell subprocess
6. When PM2 kills service-loader, only the service-loader process dies
7. All grandchild processes become orphans with PPID=1

**Evidence:** `ps -eo ppid,pid,cmd` showed 1,000+ processes with PPID=1 running `genie-app/views/genie/service/index.ts`

### Bug 2: Migration Error Spam (Contributing, Not Crashing)

**File:** `packages/os-sdk/src/db/migrate.ts` via `service-loader.ts:347`

The `bootstrapJournalIfNeeded()` function checks only the FIRST `CREATE TABLE` in each migration file (line 46: `sqlContent.match(/CREATE TABLE "(\w+)"/)`) to determine if a migration was already applied. If the journal state becomes desynchronized (e.g., table exists from a different migration), Drizzle's migrator tries to re-run the raw SQL and hits `relation "audit_events" already exists`.

The error IS caught (line 349-351) and doesn't crash the service-loader, but it floods error logs and makes diagnosis harder.

## Investigation Method

Used `rlmx` v0.4.0 with `--tools full` against:
- `/home/genie/prod/khal-os/src/lib/service-loader.ts` — spawn logic, shutdown handler, process tracking
- `/home/genie/prod/khal-os/packages/os-sdk/src/db/migrate.ts` — migration bootstrap, journal sync
- `/home/genie/prod/khal-os/ecosystem.config.cjs` — PM2 config analysis

Key rlmx findings:
- Double-shell nesting via `npx` prevents signal propagation
- PM2 config lacks `treekill: true` and `kill_timeout`
- Structural fix: replace `npx tsx` with direct `node --import tsx/esm` or `bun`

## Acceptance Criteria

### Must Have (P0 — Hotfix)
1. **Replace `npx tsx` spawn with direct node/bun execution** — eliminate the shell wrapper chain that prevents signal propagation
2. **Process group kill on shutdown** — use `process.kill(-pid, 'SIGTERM')` (negative PID) to kill the entire process group, not just the direct child
3. **PM2 ecosystem config hardening** — add `treekill: true`, `kill_timeout: 5000` to os-services entry
4. **Orphan reaper on startup** — on service-loader boot, find and kill any orphaned processes from previous runs before spawning new ones

### Should Have (P1)
5. **Fix migration bootstrap edge case** — `bootstrapJournalIfNeeded()` should check ALL `CREATE TABLE` statements in a migration file, not just the first one
6. **Circuit breaker for PM2 restarts** — service-loader already has one internally (lines 173-179) but PM2's own `autorestart: true` has no backoff, so PM2 keeps restarting even after the circuit breaker trips. Add `max_restarts` and `restart_delay` to PM2 config.

### Nice to Have (P2)
7. **Process health watchdog** — log total child process count and RSS periodically; alert if count exceeds threshold
8. **Graceful child shutdown timeout** — send SIGTERM, wait 5s, then SIGKILL remaining children

## Execution Groups

### Group 1: Hotfix — Stop the Leak (P0 items 1-4)
**Files:**
- `src/lib/service-loader.ts` — lines 225-303 (spawnService + exit handler), lines 387-403 (shutdown)
- `ecosystem.config.cjs` — os-services entry

**Changes:**
1. Replace `['npx', 'tsx', service.path]` with `['bun', 'run', service.path]` (bun is already on this system and handles tsx natively) OR `['node', '--import', 'tsx/esm', service.path]`
2. In `spawnService()`, spawn with `detached: false` (default) and record the process group
3. In shutdown handler and exit handler, use `process.kill(-proc.pid, 'SIGTERM')` to kill the process group
4. Add startup orphan reaper: `pkill -f "genie-app/views/genie/service"` equivalent via `child_process.execSync`
5. In `ecosystem.config.cjs`, add `treekill: true`, `kill_timeout: 5000`, `max_restarts: 10`, `restart_delay: 5000`

### Group 2: Migration & PM2 Hardening (P1 items 5-6)
**Files:**
- `packages/os-sdk/src/db/migrate.ts` — `bootstrapJournalIfNeeded()` function
- `ecosystem.config.cjs`

**Changes:**
1. Change `sqlContent.match(/CREATE TABLE "(\w+)"/)` to `sqlContent.matchAll(/CREATE TABLE "(\w+)"/g)` and check ALL tables
2. Add `max_restarts: 10`, `restart_delay: 5000` to PM2 config

### Group 3: Observability (P2 items 7-8)
**Files:**
- `src/lib/service-loader.ts` — health publisher

**Changes:**
1. Add RSS/count monitoring to `publishHealth()`
2. Add graceful shutdown with timeout escalation (SIGTERM → wait → SIGKILL)

## Validation

```bash
# 1. Verify no orphan accumulation after 3 restart cycles
pm2 start os-services && sleep 5 && pm2 restart os-services && sleep 5 && pm2 restart os-services
ps aux | grep "genie-app/views/genie/service" | grep -v grep | wc -l
# Expected: only active children, no orphans

# 2. Verify process group kill works
pm2 stop os-services
ps aux | grep "genie-app/views/genie/service" | grep -v grep | wc -l
# Expected: 0

# 3. Verify migrations don't error
pm2 start os-services && sleep 10
grep "auto-migrations failed" ~/.pm2/logs/os-services-error.log | tail -1
# Expected: no new errors

# 4. Memory stability over 10 minutes
free -h  # baseline
sleep 600
free -h  # should not grow significantly
```

## Context

**Why this is P0:** The orphan leak caused the machine to OOM twice on 2026-03-27, killing all agent processes including active development sessions. The machine has 127GB RAM and was consuming 75GB from orphaned processes alone. This blocks all work on the machine.

**Why `npx tsx` specifically:** In dev mode (non-bundled), `service-loader.ts:257` uses `npx tsx` as the runner. `npx` creates a shell wrapper chain that swallows signals. The bundled/production mode (line 252) correctly uses a direct `node` binary, so this is a dev-mode-only issue. But the production deployment at `/home/genie/prod/khal-os` is running in dev mode via pm2.

**Immediate mitigation applied:** All pm2 services stopped, orphan processes killed. System recovered to 727MB usage. Services need to be restarted after the fix is applied.
