# Wish: Omni Lifecycle Hardening — Install / Update / Doctor Env Hermeticity

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — PR [automagik-dev/omni#359](https://github.com/automagik-dev/omni/pull/359) (Execution Review SHIP 2026-04-06) |
| **Slug** | `omni-lifecycle-hardening` |
| **Date** | 2026-04-06 |
| **Repo** | `automagik-dev/omni` |
| **Trigger** | Live debugging session 2026-04-06 — env pollution from genie tmux poisoned omni-api's pm2 stored env, breaking auth and orphaning data dirs. See `Background` section. |
| **Depends-on** | none |

## Summary

`omni install` reads `process.env.DATABASE_URL` from the calling shell and bakes it into `~/.omni/config.json`'s `server.databaseUrl`, which is then re-applied by every subsequent `omni restart` / `omni update` / `omni auth recover`. When the calling shell has a stray `DATABASE_URL` from another tool (e.g. genie's tmux session), this silently corrupts the install: pm2's stored env points the new omni-api at the wrong database, the embedded pgserve data dir gets orphaned, the CLI's API key stops matching, and `omni update`'s health check returns "successful" without verifying the running server is actually healthy on the right DB. This wish makes the install/restart/update/recover commands env-hermetic, makes `omni update` actually verify the running server matches the new version and is reachable with the configured key, and adds an `omni doctor` command that detects and repairs broken installs in place — without losing data.

## Background — what happened (full incident)

On 2026-04-06 a routine `omni update` followed by `pm2 restart all` left the user's omni install in a broken state. Investigation revealed:

1. The user's `~/.omni/config.json` had `server.databaseUrl: postgresql://...20642/khal-os` — pointing at genie's pgserve, not omni's.
2. Two separate pgserve instances were running: omni's embedded one on `:8432` (data at `~/.omni/data/pgserve`, contained Sofia + 3 instances + 1546 messages + 4 API keys) and genie's on `:20642` (data at `~/.genie/data/pgserve`, completely different schema).
3. The omni-api pm2 process had `DATABASE_URL=...20642/khal-os` in its environment, inherited from the genie-tmux shell that originally launched it via `omni install`.
4. The CLI's stored `apiKey` no longer matched any key in the omni DB on `:8432`.
5. `omni auth recover` repeatedly failed because its `pm2 restart --update-env` re-inherited the same polluted shell env.
6. `omni update` (run earlier) had silently "succeeded" against the broken state — it never noticed the running server's auth was broken or that it was talking to the wrong DB.

Manual recovery required: deleting the pm2 process, relaunching with `env -u DATABASE_URL`, manually deleting the `__primary__` row in the DB, and regenerating the CLI key. See conversation log for full repro.

The root cause is at `dist/index.js:81760`:

```js
var DEFAULT_DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/omni";
```

This single line propagates shell env pollution into permanent install state.

## Scope

### IN

- **Install hermeticity (install.ts)**
  - When `PGSERVE_EMBEDDED=true` (the default), `omni install` MUST NOT read `process.env.DATABASE_URL` for the default value. Derive the default from the configured `PGSERVE_PORT` instead: `postgresql://postgres:postgres@localhost:${PGSERVE_PORT}/omni`.
  - Hardcoded fallback `postgresql://...localhost:5432/omni` must be replaced with one derived from the actual `PGSERVE_PORT` (default 8432). The 5432 fallback is wrong even on a clean install.
  - When user explicitly passes `--database-url <url>` (new flag) or selects "external database" mode in the wizard, `process.env.DATABASE_URL` MAY be used as a default. Embedded mode MUST NOT.
  - `omni install` MUST sanitize the env passed to pm2: only the explicitly-built `runtimeEnv` from `buildApiRuntimeEnv(cfg)` is propagated. Pass `--update-env` is forbidden in install, restart, update, and auth recover code paths — pm2 must use the explicitly-passed env, not merge shell env.

- **Restart / Update / Recover hermeticity (restart.ts, update.ts, recover.ts)**
  - `omni restart`, `omni update`, and `omni auth recover` MUST rebuild the runtime env from `~/.omni/config.json` via `buildApiRuntimeEnv()` and pass it to pm2 explicitly. They MUST NOT use `pm2 restart --update-env` (which merges shell env).
  - The `buildApiRuntimeEnv2()` in restart.ts and the `buildApiRuntimeEnv()` in install.ts MUST be deduplicated into a single helper in a shared module (`src/runtime-env.ts`).

- **`omni update` visible verification**
  - After `omni update` restarts services, it MUST poll the running server until BOTH conditions hold:
    1. `GET /api/v2/health` returns 200 with `serverVersion === <new cli version>` (string match — the server reports the bundle version it's running)
    2. `GET /api/v2/auth/status` (with the configured CLI key) returns `keyValid: true`
  - On success, print a visible 3-line confirmation:
    ```
    ✓ CLI:    v2.260406.1
    ✓ Server: v2.260406.1 (healthy)
    ✓ Auth:   key valid
    ```
  - On failure, print which check failed and exit non-zero with actionable next steps (e.g. "run: omni doctor").
  - The existing `--no-restart` flag is preserved.

- **New command: `omni doctor`**
  - `omni doctor` (read-only by default) diagnoses install health and prints a report:
    - pm2 stored env vs `~/.omni/config.json` drift (e.g. `DATABASE_URL` mismatch)
    - CLI `apiKey` validity against the running server
    - Embedded pgserve port reachability and DB existence
    - Orphaned pgserve data dirs (e.g. stale `.pgserve-data/` in repo)
    - Server bundle version vs CLI version mismatch
    - pm2 process status for `omni-api` and `omni-nats`
  - `omni doctor --fix` repairs whatever it can:
    - Rebuild pm2 stored env from `~/.omni/config.json` (deletes the pm2 process, re-launches with sanitized env)
    - Regenerate `__primary__` key and update CLI config
    - Confirm via the same checks as the `omni update` verification
  - `omni doctor --json` for machine-readable output
  - Doctor never deletes or modifies the embedded pgserve data dir at `~/.omni/data/pgserve` — only fixes process/env state.

- **Update help text accuracy**
  - The `omni update` help text currently claims "checks API health on the configured API port". Update it to reflect the new visible 3-step verification: CLI version, server version match, auth key valid.

### OUT

- **Migrating an existing broken install across databases.** `omni doctor --fix` only repairs in place using existing data dirs. If the user installed twice with different `dataDir` values and wants to merge them, they need a separate migration tool.
- **Removing the `DATABASE_URL` leak from genie's tmux session** — that's a fix in the genie repo, not omni. Tracked separately.
- **`omni install --systemd` mode** — already correctly avoids pm2 stored env (writes systemd units instead). Out of scope for this wish; the bug is pm2-only.
- **External database mode (`--database-url`)** — beyond defaulting from `process.env.DATABASE_URL` when explicitly opted in, this wish does not change how external DBs are configured.
- **Auto-update / scheduled updates / multi-host install repair.** `omni doctor` is local-only.
- **Rewriting the embedded pgserve to be a managed service** — the current "spawn pgserve as a subprocess of omni-api" approach stays.
- **CLI/server protocol versioning.** The version match check uses string equality; semver-compat negotiation is a separate concern.
- **Migrating users away from `~/.omni/config.json`** — config schema stays the same.

## Decisions

| Decision | Rationale |
|----------|-----------|
| **Env-hermetic by default for embedded mode** | Embedded mode is "managed by omni" — the user's expectation is that omni configures itself, no shell state should bleed in. External mode is opt-in and can read shell env. |
| **No `pm2 ... --update-env` anywhere in omni's code paths** | `--update-env` merges current shell env into pm2's stored env, defeating hermeticity. Always pass the explicit `runtimeEnv` from the CLI config. |
| **`omni update` verifies version match + auth + health, not just exit codes** | Today it says "Services restarted successfully" without confirming the running server is the new version. This is the user-observable gap that triggered the wish. |
| **`omni doctor` over `omni install --repair`** | A doctor is a separate verb that's safe to run (read-only by default), discoverable, and composable. Reusing `install` would conflate "fresh install" with "fix existing install". |
| **Doctor is opt-in repair (`--fix`), not default** | Read-only diagnosis is always safe to run on a healthy system. `--fix` is destructive (deletes pm2 process, may rotate keys) so it requires explicit consent. |
| **Doctor never touches `~/.omni/data/pgserve`** | The data dir is sacrosanct. All repairs operate on process/env state, not on database contents. |
| **Single `runtime-env.ts` helper shared across install/restart/update/recover/doctor** | The two existing copies (`buildApiRuntimeEnv` in install.ts, `buildApiRuntimeEnv2` in restart.ts) already drifted. One source of truth eliminates the drift. |
| **Server reports its bundled version via `/api/v2/health`** | If the endpoint already returns a version field, use it. If not, add it as part of this wish (small server-side change). The update verifier needs this signal. |
| **Bundle into single PR** | All five changes are in the same lifecycle code paths and share `runtime-env.ts`. Splitting would create coupling churn between PRs. |

## Success Criteria

- [ ] **Install hermeticity:** `DATABASE_URL=postgresql://garbage omni install --non-interactive --port 8882` produces a working install. The pm2 stored env contains `DATABASE_URL=postgresql://postgres:postgres@localhost:8432/omni` (NOT garbage), and `~/.omni/config.json` `server.databaseUrl` matches.
- [ ] **Restart hermeticity:** `DATABASE_URL=postgresql://garbage omni restart` leaves the running pm2 omni-api with the correct `DATABASE_URL` from `~/.omni/config.json`, not from the shell env.
- [ ] **Update hermeticity:** `DATABASE_URL=postgresql://garbage omni update` (when an update is available) successfully restarts services and the pm2 omni-api environment is unaffected by the shell env.
- [ ] **Recover hermeticity:** `DATABASE_URL=postgresql://garbage omni auth recover` successfully rotates the primary key and the running server validates the new key.
- [ ] **No `--update-env` flag** appears in any source file under `packages/cli/src/commands/{install,restart,update,auth}.ts` — verified by grep.
- [ ] **Single `runtime-env.ts` helper** exists at `packages/cli/src/runtime-env.ts` and is imported by install, restart, update, doctor, and recover. The duplicate `buildApiRuntimeEnv2` in restart.ts is deleted.
- [ ] **`omni update` visible verification:** Output after a successful update includes the three-line confirmation:
  ```
  ✓ CLI:    v<latest>
  ✓ Server: v<latest> (healthy)
  ✓ Auth:   key valid
  ```
- [ ] **`omni update` failure path:** If the running server reports a version different from the CLI after restart, `omni update` exits non-zero with `Server version mismatch: cli=v<X> server=v<Y>. Run: omni doctor`.
- [ ] **`omni update` auth failure path:** If the configured CLI key fails validation against the new server, `omni update` exits non-zero with `Auth key invalid after restart. Run: omni doctor --fix`.
- [ ] **`omni doctor` exists** as a top-level command. `omni doctor --help` lists `--fix`, `--json`, and `--verbose` flags.
- [ ] **`omni doctor` (read-only) checks** all of: pm2 env drift, CLI key validity, embedded pgserve reachability, orphaned data dirs, server/CLI version mismatch, pm2 process status. Each check reports `OK` / `WARN` / `FAIL` with one-line detail.
- [ ] **`omni doctor --fix` repair flow:** running it on a deliberately-broken install (e.g. polluted pm2 env) restores the running server to a healthy state without losing any data from `~/.omni/data/pgserve`.
- [ ] **Doctor never touches data dir:** verified by mutation test — corrupt the pm2 env, count files in `~/.omni/data/pgserve`, run `omni doctor --fix`, count files again, must be equal.
- [ ] **`omni update` help text** mentions the visible verification (not just "checks API health").
- [ ] **CI passes** — typecheck, lint, full test suite (existing + new).
- [ ] **New tests added** — at minimum: install env-leak regression test, doctor diagnose-then-fix test, update version-mismatch test.

## Execution Strategy

### Wave 1 (sequential — single group, internal dependencies)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Extract `runtime-env.ts`, fix install env leak, sanitize all pm2 invocations, harden update verification, add `omni doctor` |
| review | reviewer | Plan + execution review against acceptance criteria |

A single sequential wave is correct here: the runtime-env extraction is a prerequisite for all other changes (they all import from it), the install/restart/update/recover fixes are the same edit pattern applied to four call sites, and `omni doctor` reuses the same helpers. Splitting into multiple groups would create artificial coupling between PRs touching the same files. Validation runs at the end of the single group.

## Execution Groups

### Group 1: Lifecycle Hermeticity + Doctor

**Goal:** Make `omni install`, `omni restart`, `omni update`, and `omni auth recover` env-hermetic, give `omni update` visible verification, and add `omni doctor` for in-place repair.

**Deliverables:**

1. **`packages/cli/src/runtime-env.ts`** — new shared module exporting:
   - `type RuntimeEnv` (the shape passed to pm2)
   - `function buildRuntimeEnv(serverConfig: ServerConfig, cliConfig: CliConfig): RuntimeEnv`
   - The function never reads `process.env.DATABASE_URL`. It always derives `DATABASE_URL` from `serverConfig.databaseUrl` (which the user set explicitly via `omni install`).
   - For embedded mode (`PGSERVE_EMBEDDED=true`), if `serverConfig.databaseUrl` is empty or default, the function derives it from `serverConfig.pgservePort` as `postgresql://postgres:postgres@localhost:${port}/omni`.

2. **`packages/cli/src/commands/install.ts`** — refactor:
   - Replace `var DEFAULT_DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://...5432/omni"` with a function that derives the default from `PGSERVE_PORT` (default 8432) and the embedded-mode flag. Only read `process.env.DATABASE_URL` when an external-database flag is present.
   - Add `--database-url <url>` CLI flag for explicit external-DB installs.
   - Replace local `buildApiRuntimeEnv(cfg)` with `import { buildRuntimeEnv } from '../runtime-env.js'`.
   - The `runPm2(["start", launcherPath, ...], runtimeEnv)` call must pass `runtimeEnv` as the second arg AND must NOT include `--update-env` in the args array.
   - Write `~/.omni/config.json` `server.databaseUrl` from the resolved value (not from `process.env`).

3. **`packages/cli/src/commands/restart.ts`** — refactor:
   - Delete `buildApiRuntimeEnv2()` (duplicate of install's helper).
   - Import and use `buildRuntimeEnv` from `runtime-env.js`.
   - Remove `--update-env` from the `runPm2(["restart", ...])` args. Pass the env explicitly.

4. **`packages/cli/src/commands/update.ts`** — refactor:
   - After `restartPm2Services()`, instead of just `waitForHealth()`, perform the three-step verification:
     1. Fetch `/api/v2/health` and parse the `version` field. Compare with the CLI's `latest` version. If mismatch, fail with `Server version mismatch: cli=v<X> server=v<Y>. Run: omni doctor`.
     2. Fetch `/api/v2/auth/status` with the CLI key. If `keyValid !== true`, fail with `Auth key invalid after restart. Run: omni doctor --fix`.
     3. Print the three green-check lines on success.
   - The pm2 restart inside update must use the sanitized env via `buildRuntimeEnv()`, not inherit shell env.
   - Update the `addHelpText("after", ...)` block to describe the new visible verification.

5. **`packages/cli/src/commands/auth/recover.ts`** (or wherever the recover command lives) — refactor:
   - The `pm2 restart omni-api --update-env` call must become `pm2 restart omni-api` with explicit env from `buildRuntimeEnv()`. Remove `--update-env`.
   - The DB delete-then-restart sequence (delete `__primary__`, restart with new `OMNI_API_KEY` env, server recreates the row on startup) must work even when the calling shell has a polluted `DATABASE_URL`.

6. **`packages/cli/src/commands/doctor.ts`** — new file:
   - Top-level command `omni doctor` registered in the CLI command tree.
   - `runDoctor({ fix: false, json: false, verbose: false })` performs these checks in order:
     - **pm2-env-drift**: Compare `pm2 jlist` env for `omni-api` against the env that `buildRuntimeEnv()` would produce now. Report any keys that differ. Severity: WARN if `DATABASE_URL` differs, FAIL if `PGSERVE_DATA` differs.
     - **cli-key-valid**: Call `GET /api/v2/auth/status` with the CLI's stored key. FAIL if `keyValid !== true`.
     - **pgserve-reachable**: Connect to `localhost:${PGSERVE_PORT}` (TCP). FAIL if refused.
     - **omni-db-exists**: Query `\l` on the embedded pgserve, look for `omni`. FAIL if missing.
     - **orphaned-data-dirs**: Find any `.pgserve-data/` directories under common project paths (cwd, repo roots). Report as WARN with absolute paths.
     - **version-match**: Compare CLI version against `GET /api/v2/health` `version` field. WARN if mismatch.
     - **pm2-status**: Check that `omni-api` and `omni-nats` are `online` in pm2. FAIL if either is `stopped` or `errored`.
   - With `--fix`, attempt repair for each FAIL/WARN that has a known repair path:
     - pm2-env-drift FIX: `pm2 delete omni-api`, then re-launch via the same path used by `omni start`, with explicit `buildRuntimeEnv()`.
     - cli-key-valid FIX: delete `__primary__` row from the omni DB, restart omni-api with new `OMNI_API_KEY`, re-validate, write the new key to `~/.omni/config.json`.
     - orphaned-data-dirs FIX: print `rm -rf` commands for the user to review (do NOT auto-delete).
   - With `--json`, emit `{ checks: [...], summary: { ok, warn, fail }, fixesApplied: [...] }`.
   - The fix flow must NEVER touch `~/.omni/data/pgserve/`. Verified by an integration test that snapshots that directory before/after `--fix` and asserts equality.

7. **Server-side: `/api/v2/health` returns version** — **VERIFIED PRE-EXISTING** by reviewer at `packages/api/src/routes/health.ts:79`. The verifier in deliverable 4 can consume this field directly; no server-side change required.

8. **Tests** (`packages/cli/src/__tests__/`):
   - **install-env-leak.test.ts** — invoke install with `DATABASE_URL=garbage`, assert pm2 stored env does not contain `garbage` and CLI config has the derived value.
   - **runtime-env.test.ts** — unit tests for `buildRuntimeEnv` covering embedded vs external, port derivation, no shell-env reads.
   - **doctor.test.ts** — fixture-based tests: build a known-broken pm2 env, run `omni doctor`, assert correct FAIL reports; run `omni doctor --fix`, assert state is repaired.
   - **update-verify.test.ts** — mock the server health endpoint with a version mismatch and assert the visible failure message + non-zero exit.

**Acceptance Criteria:**

- [ ] `packages/cli/src/runtime-env.ts` exists and is the only place `DATABASE_URL` is built for the omni-api process
- [ ] `grep -rn "process.env.DATABASE_URL" packages/cli/src/commands/` returns nothing under install/restart/update/auth (it MAY appear in places that read external-DB explicitly)
- [ ] `grep -rn "update-env" packages/cli/src/commands/{install,restart,update,auth}.ts` returns nothing
- [ ] `grep -rn "buildApiRuntimeEnv2" packages/cli/src/` returns nothing (the duplicate is deleted)
- [ ] `omni install --help` shows the `--database-url` flag
- [ ] `omni doctor --help` works and lists `--fix`, `--json`, `--verbose`
- [ ] `omni update` success path prints the three green-check lines
- [ ] `omni update` failure paths exit non-zero with the documented error messages
- [ ] All new tests pass
- [ ] Existing tests pass (typecheck, biome, full bun test)
- [ ] Mutation test: corrupt the pm2 stored env to point at `postgresql://invalid:5432/wrong`, run `omni doctor --fix`, then `omni status` reports healthy with `keyValid: true`
- [ ] Mutation test: snapshot file count of `~/.omni/data/pgserve/` before and after `omni doctor --fix`, count is unchanged

**Validation:**

```bash
cd /home/genie/workspace/repos/omni
git checkout -b feat/omni-lifecycle-hardening

# 1. Code-level guardrails
! grep -rn "process.env.DATABASE_URL" packages/cli/src/commands/{install,restart,update,auth}/
! grep -rn "update-env" packages/cli/src/commands/{install,restart,update,auth}/
! grep -rn "buildApiRuntimeEnv2" packages/cli/src/
test -f packages/cli/src/runtime-env.ts
test -f packages/cli/src/commands/doctor.ts

# 2. Build and test
make typecheck
bunx biome check .
bun test packages/cli/src/__tests__/{install-env-leak,runtime-env,doctor,update-verify}.test.ts
bun test  # full suite

# 3. End-to-end install hermeticity test (in a clean dir)
TMPHOME=$(mktemp -d)
HOME=$TMPHOME DATABASE_URL=postgresql://garbage:1234/wrong \
  bun packages/cli/src/index.ts install --non-interactive --port 8883
# Inspect pm2 jlist for the env, must NOT contain "garbage"
HOME=$TMPHOME pm2 jlist | jq '.[] | select(.name=="omni-api") | .pm2_env.DATABASE_URL' \
  | grep -v garbage
HOME=$TMPHOME pm2 delete omni-api omni-nats || true
rm -rf $TMPHOME

# 4. Doctor diagnose + fix on a deliberately broken install
# (assume omni is installed and running)
omni doctor --json | jq '.summary'                       # baseline OK
pm2 set omni-api:DATABASE_URL postgresql://broken:1/x    # corrupt env
omni doctor                                              # should report FAIL
omni doctor --fix                                        # should repair
omni doctor                                              # should report OK
omni status --json | jq '{authenticated, keyValid}'      # both true

# 5. Update visible verification (requires a version diff to test live)
# Verified via update-verify.test.ts unit test instead of live test
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after PR merges to dev._

- [ ] **Functional:** Install in a polluted-env shell (`DATABASE_URL=postgresql://garbage`) produces a working omni-api with the correct `DATABASE_URL` in pm2's stored env
- [ ] **Functional:** `omni update` (when a real version diff exists) prints the three green-check verification lines on success
- [ ] **Functional:** `omni doctor` runs in <2s on a healthy install and reports all checks OK
- [ ] **Functional:** `omni doctor --fix` on a broken install (e.g. corrupted pm2 env) restores it without touching the data dir
- [ ] **Integration:** `omni auth recover` works in a polluted-env shell
- [ ] **Regression:** Existing `omni install`, `omni restart`, `omni update`, `omni auth recover` flows on a clean shell continue to work unchanged
- [ ] **Regression:** Users with externally-managed databases (`--database-url`) can still set `DATABASE_URL` via env or flag and have it honored
- [ ] **Drift guard:** A test PR that re-introduces `--update-env` to any of the four lifecycle commands gets blocked by the new tests

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Existing users have polluted pm2 env on disk; `omni update` will start failing visibly for them after this lands | Medium | This is intentional — they were silently broken before. The new failure message points them at `omni doctor --fix`. Document in CHANGELOG and PR body. |
| `/api/v2/health` may not currently return a `version` field | Low | If missing, deliverable 7 adds it (small server change). Verify by curling the existing endpoint as the first step in Group 1. |
| `omni doctor --fix` could fail mid-repair, leaving a half-repaired state | Medium | Each repair step is idempotent. Doctor can be re-run safely. The pm2 delete + relaunch is atomic-enough (delete is fast, relaunch is the same path as install). |
| Users running external Postgres (not embedded) might rely on `process.env.DATABASE_URL` for install defaults | Low | New `--database-url` flag preserves the explicit path. The env-var read happens only when external mode is selected. |
| Server `/api/v2/health` version field could be cached behind a CDN in production | Low | Bypass with `Cache-Control: no-cache` header on the verifier's request. Document. |
| pm2 `--update-env` removal might break a user who was relying on it for some legit reason | Low | None found in code review. If discovered post-merge, restore for the specific call site with a comment explaining why. |
| Server-side change (deliverable 7) needs to land before client-side verifier expects the field | Low | Bundle both in the same PR. Backend change is additive, no breaking. |

---

## Files to Create/Modify

```
# CREATE
packages/cli/src/runtime-env.ts                             (shared env builder)
packages/cli/src/commands/doctor.ts                         (new command)
packages/cli/src/__tests__/runtime-env.test.ts              (unit test)
packages/cli/src/__tests__/install-env-leak.test.ts         (regression test)
packages/cli/src/__tests__/doctor.test.ts                   (diagnose + fix test)
packages/cli/src/__tests__/update-verify.test.ts            (verification test)

# MODIFY
packages/cli/src/commands/install.ts                        (no shell env reads, sanitized pm2 launch, --database-url flag)
packages/cli/src/commands/restart.ts                        (use shared runtime-env, no --update-env)
packages/cli/src/commands/update.ts                         (visible verification, sanitized pm2 restart)
packages/cli/src/commands/auth/recover.ts                   (sanitized pm2 restart, no --update-env)
packages/cli/src/index.ts                                   (register doctor command)

# MODIFY (server-side, only if /health doesn't already return version)
packages/api/src/routes/health.ts                           (add version field)
```

---

## Review Results

### Plan Review (2026-04-06) — SHIP

Reviewer ran the Plan Review checklist and 5 active probes against the actual omni source. All items PASS.

**Checklist**

| Item | Verdict | Evidence |
|------|---------|----------|
| Problem statement (one sentence, testable) | PASS | Root cause traced to `install.ts:38` |
| Scope IN concrete | PASS | 8 deliverables, no overlap |
| Scope OUT explicit | PASS | 7 explicit exclusions with rationale |
| Decisions justified | PASS | Spot-checked 5/8, all sound |
| Success criteria testable | PASS | 17 criteria, all greppable / unit-testable / mutation-testable |
| Single-wave justified | PASS | `runtime-env.ts` is prerequisite for all 5 call-site fixes |
| Group 1 deliverables bite-sized | PASS | 8 deliverables, single-concern each |
| Validation block covers criteria | PASS | 5-part validation maps to 100% of criteria |
| Risks have actionable mitigations | PASS | 7 entries, medium-severity risks documented |
| File list matches deliverables | PASS | No orphaned items either direction |

**Probes (verified against `/home/genie/workspace/repos/omni`)**

| Probe | Finding |
|-------|---------|
| `grep "process.env.DATABASE_URL" packages/cli/src/commands/` | Found at `install.ts:38` — exact root cause confirmed |
| `grep "update-env" packages/cli/src/commands/` | Two active uses: `restart.ts:59` and `auth.ts:93`. Both removed by wish |
| Drift between `buildApiRuntimeEnv` copies | **Confirmed drift**: `restart.ts` is missing `OMNI_PACKAGES_DIR`, uses dynamic `serverConfig.nodeEnv`/`logLevel` while `install.ts` hardcodes `production`/`info`. Wish correctly deduplicates |
| `/api/v2/health` returns version field | **YES** — already present at `packages/api/src/routes/health.ts:79`. Deliverable 7 marked as no-op |
| Auth recover `--update-env` location | Confirmed at `auth.ts:93` |

**File:line references for the implementer (verified by reviewer)**

| Path | Why |
|------|-----|
| `packages/cli/src/commands/install.ts:38` | Root cause — `process.env.DATABASE_URL` read |
| `packages/cli/src/commands/install.ts:258` | First `buildApiRuntimeEnv` definition |
| `packages/cli/src/commands/restart.ts:29` | Duplicate `buildApiRuntimeEnv2` (drift target) |
| `packages/cli/src/commands/restart.ts:59` | First `--update-env` removal point |
| `packages/cli/src/commands/auth.ts:79-99` | `omni auth recover` implementation |
| `packages/cli/src/commands/auth.ts:93` | Second `--update-env` removal point |
| `packages/api/src/routes/health.ts:79` | Pre-existing version field for the verifier to consume |

**Findings:** CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 0

**Verdict:** SHIP. Ready for `/work` dispatch.

### Execution Review (2026-04-06) — SHIP

Reviewer ran Execution Review pipeline against commit `8a8b1313` on `feat/omni-lifecycle-hardening`. All 17 acceptance criteria PASS with independent evidence.

**Validation evidence**

| Gate | Result |
|------|--------|
| `bun run typecheck` | 19/19 packages clean (FULL TURBO cached) |
| `bun run lint` (biome) | 887 files, zero issues |
| `bun test` (full suite) | 2705 pass / 229 skip / 0 fail |
| New test files | 40 pass / 0 fail (runtime-env, install-env-leak, doctor, update-verify) |
| Grep guardrails | Zero `process.env.DATABASE_URL` in lifecycle command paths; zero `--update-env` flags; zero duplicate env builders |
| Mutation safety test | `omni doctor --fix` leaves `PGSERVE_DATA` directory untouched (file-count invariant) |

**Deliverable verdicts**

| # | Deliverable | Verdict |
|---|-------------|---------|
| 1 | `runtime-env.ts` (single hermetic source) | PASS — 116 lines, derives from config/pgserve only |
| 2 | `install.ts` refactor + `--database-url` flag | PASS — module-top read gone, flag exported |
| 3 | `restart.ts` dedup + `--update-env` removal | PASS — duplicate deleted |
| 4 | `update.ts` 3-step verification | PASS — CLI version → server `/health` version → `client.auth.validate()` |
| 5 | `auth.ts` sanitized recover | PASS — `restartApiWithNewKey` uses `buildRuntimeEnv` |
| 6 | `doctor.ts` new command | PASS — 7 checks, `DoctorDeps` injection seam, mutation-safe `--fix` |
| 7 | Server `/health` version field | PASS (no-op) — pre-existed at `health.ts:79` |
| 8 | 4 new test files | PASS — 40 tests |

**Engineer deviations evaluated**

1. **Used `client.auth.validate()` instead of raw `/api/v2/auth/status`** — superior to spec. SDK method is more maintainable, already used elsewhere in `auth.ts`/`status.ts`, functionally equivalent. Accepted.
2. **Added `DoctorDeps` injection seam** — correct test-seam pattern. Production code path unchanged (defaults to `productionDeps()`); only tests inject stubs. Accepted.

**Findings:** CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 0

**Verdict:** SHIP. PR [automagik-dev/omni#359](https://github.com/automagik-dev/omni/pull/359) opened against `dev`.
