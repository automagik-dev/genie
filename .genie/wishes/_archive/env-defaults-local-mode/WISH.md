# Wish: Sensible env defaults — .env not required for local mode

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `env-defaults-local-mode` |
| **Date** | 2026-04-02 |
| **Issue** | [#189](https://github.com/namastexlabs/khal-os/issues/189) |

## Summary

After a fresh clone, `make dev` crashes PM2 processes when no `.env` exists. The ws-bridge hard-exits on missing `KHAL_INSTANCE_ID`, `getDatabaseUrl()` throws on missing `DATABASE_URL`, and the ws-bridge has no restart limits — causing infinite crash loops. Every other file in the codebase already defaults `KHAL_INSTANCE_ID` to `'default'`; the ws-server is the sole outlier. Fix all env var hard-crashes so a fresh deploy Just Works in local mode.

## Scope

### IN
- Default `KHAL_INSTANCE_ID` to `'default'` in `ws-server.ts` (matching all other usages)
- Default `DATABASE_URL` to pgserve default in `getDatabaseUrl()` with console.warn
- Add `max_restarts`, `restart_delay`, `treekill`, `kill_timeout` to `os-ws-bridge` in `ecosystem.config.cjs`
- Pass `KHAL_INSTANCE_ID` in Makefile `dev-slot` target
- Add `.env` preflight warning to Makefile `dev` target
- Make client-side `workos-auth-provider.tsx` use `isLocalMode()` for auto-detection

### OUT
- Changing the authentication flow or WorkOS integration
- Modifying the npx-cli provisioning system
- Fixing `.env.example` port mismatch (separate issue — port 20642 vs 5433)
- Adding new env vars or features

## Decisions

| Decision | Rationale |
|----------|-----------|
| Default `KHAL_INSTANCE_ID` to `'default'` | 5 of 6 usages already do this — consistency |
| Default `DATABASE_URL` to `postgresql://postgres:postgres@127.0.0.1:5433/khal-os` | Matches Makefile `PG_PORT ?= 5433` and npx-cli default, not stale `.env.example` port 20642 |
| Use `isLocalMode()` in client provider | Server-side already uses it — DRY, consistent behavior |
| Add PM2 restart limits to ws-bridge | Matches existing `os-services` config — prevents infinite crash loops |

## Success Criteria

- [ ] `make dev` on fresh clone with no `.env` starts all PM2 processes without crash loops
- [ ] ws-bridge stays up with `KHAL_INSTANCE_ID=default` when env var is missing
- [ ] `seedCoreApps()` succeeds using default `DATABASE_URL`
- [ ] Existing `.env` setups continue to work (env vars override defaults)
- [ ] `os-ws-bridge` PM2 config has `max_restarts: 10`
- [ ] Client-side local mode auto-detection works without explicit `NEXT_PUBLIC_KHAL_MODE=local`

## Execution Strategy

### Wave 1 (parallel — all independent file changes)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix ws-server.ts KHAL_INSTANCE_ID default |
| 2 | engineer | Fix getDatabaseUrl() default + ecosystem.config.cjs restart limits |
| 3 | engineer | Fix Makefile + workos-auth-provider.tsx |

## Execution Groups

### Group 1: ws-server.ts — default KHAL_INSTANCE_ID
**Goal:** Remove hard crash, default to `'default'` like every other usage.
**Deliverables:**
1. Replace `process.exit(1)` block at lines 119-124 with `const instanceId = process.env.KHAL_INSTANCE_ID || 'default'` and a `console.warn` when defaulting.

**Acceptance Criteria:**
- [ ] ws-server starts without `KHAL_INSTANCE_ID` in env
- [ ] Logs a warning when defaulting
- [ ] Existing env var still takes precedence

**Validation:**
```bash
grep -n "process.exit" src/lib/ws-server.ts | grep -v "//" && echo "FAIL: process.exit still present" || echo "PASS"
grep -n "'default'" src/lib/ws-server.ts && echo "PASS: default found" || echo "FAIL"
```

**depends-on:** none

---

### Group 2: getDatabaseUrl() default + PM2 restart limits
**Goal:** Prevent DB throw and infinite ws-bridge restarts.
**Deliverables:**
1. In `packages/server-sdk/src/config.ts`, fall back `getDatabaseUrl()` to `postgresql://postgres:postgres@127.0.0.1:5433/khal-os` with `console.warn`.
2. In `ecosystem.config.cjs`, add `max_restarts: 10`, `restart_delay: 5000`, `treekill: true`, `kill_timeout: 5000` to `os-ws-bridge` process.

**Acceptance Criteria:**
- [ ] `getDatabaseUrl()` returns default URL when `DATABASE_URL` is unset
- [ ] `getDatabaseUrl()` logs warning when defaulting
- [ ] `os-ws-bridge` has restart limits matching `os-services`

**Validation:**
```bash
grep -n "max_restarts" ecosystem.config.cjs | grep -c "os-ws-bridge" || true
grep -n "127.0.0.1:5433" packages/server-sdk/src/config.ts && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 3: Makefile + client-side local mode detection
**Goal:** Pass `KHAL_INSTANCE_ID` in `dev-slot`, add `.env` preflight, fix client auto-detection.
**Deliverables:**
1. In `Makefile` `dev-slot` target (line ~150), add `KHAL_INSTANCE_ID="default"` to the ws-bridge subprocess env.
2. In `Makefile` `dev` target, add preflight: `@test -f .env || echo "⚠️  No .env found — using defaults. Copy .env.example for custom config."`.
3. In `src/providers/workos-auth-provider.tsx`, import and use `isLocalMode()` from `@khal-os/server-sdk` (or inline the same logic) instead of checking only `process.env.NEXT_PUBLIC_KHAL_MODE === 'local'`.

**Acceptance Criteria:**
- [ ] `dev-slot` passes `KHAL_INSTANCE_ID` to ws-bridge
- [ ] `make dev` warns when `.env` is missing
- [ ] Client provider auto-detects local mode when WorkOS keys are absent

**Validation:**
```bash
grep "KHAL_INSTANCE_ID" Makefile | grep -c "dev-slot" || true
grep "isLocalMode\|!clientId" src/providers/workos-auth-provider.tsx && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

## QA Criteria

- [ ] Fresh clone + `make dev` (no `.env`) → all PM2 processes start, no crash loops
- [ ] Desktop UI shows fallback apps (terminal, files, settings, marketplace)
- [ ] Existing `.env` setup continues to work — env vars override all defaults
- [ ] `ws-bridge` restarts max 10 times then stops (not infinite)

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Default DB port 5433 may not match all setups | Low | Only used as fallback when no `.env` — console.warn makes it visible |
| `isLocalMode()` from server-sdk may not be importable in client component | Medium | Inline the logic if import fails (check `NEXT_PUBLIC_*` vars only on client side) |

---

## Files to Create/Modify

```
src/lib/ws-server.ts                          # Group 1 — default KHAL_INSTANCE_ID
packages/server-sdk/src/config.ts             # Group 2 — default DATABASE_URL
ecosystem.config.cjs                          # Group 2 — add restart limits
Makefile                                      # Group 3 — dev-slot env, preflight
src/providers/workos-auth-provider.tsx         # Group 3 — client local mode detection
```
