# Wish: genie host migrations — versioned, applied-once, auto-run on update

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-host-migrations` |
| **Date** | 2026-05-03 |
| **Author** | Felipe Rosa (via felipe agent — dogfooding live break of pre-`5567e202` install state) |
| **Appetite** | medium (~2 engineer-days) |
| **Branch** | `wish/genie-host-migrations` |
| **Design** | _No brainstorm — direct wish_ |
| **Sibling** | `pgserve/autopg-upgrade-command` (same upgrade-self-heal pattern, different subsystem) |

## Summary

Add a **versioned host-migration framework** to genie cli: numbered, applied-once-per-host migrations that detect and fix drift between current host state and current code expectations (pm2 env blocks, embedded pgserve fantasmas, config drifts, etc). Auto-run on every `genie update --next` via npm postinstall hook so users get fixes transparently — same pattern as DB migrations but for HOST state. Closes the silent-breakage class where a code fix lands but pm2 process configs persist with old behavior (live example: `5567e202 fix(install): bake DATABASE_URL` requires manual `genie install` re-run to take effect).

## Scope

### IN

- New module `src/migrations/` with: `index.js` (orchestrator), `runner.js` (per-step wrapper), `steps/` (auto-discovered migration files), tracking-store (read/write `~/.genie/migrations.json`)
- Tracking schema in `~/.genie/migrations.json`: `{"applied": [{"id": "001_pm2_env_databaseurl_bake", "appliedAt": ISO, "appliedFrom": "<genie-version>"}]}`
- Migration discovery: scan `src/migrations/steps/*.js` sorted by filename (filename = id) — strict alphabetical = strict apply order
- Each migration module exports `{id, description, check(ctx), apply(ctx), validate(ctx)}` — `check` returns true if needs apply; `apply` performs the change; `validate` post-asserts
- New CLI verb `genie migrate` with subcommands:
  - `genie migrate` — apply all pending in order, idempotent
  - `genie migrate --dry-run` — list pending without executing
  - `genie migrate --status` — show applied / pending / failed table
- Postinstall hook in `@automagik/genie` package: `scripts/postinstall.cjs` invokes `genie migrate --quiet` after `bun add -g @automagik/genie@latest`; soft-fails (warn + exit 0) so npm install never breaks
- Override: `GENIE_SKIP_MIGRATIONS=1` env var → skip postinstall (CI / containers / install-only flows)
- Initial migrations shipped (proves framework + closes live breaks):
  - `001-pm2-env-databaseurl-bake.js` — re-runs the bake-env logic from commit `5567e202` if pm2 process `genie-serve` env is missing `DATABASE_URL` AND canonical pgserve is registered
  - `002-kill-embedded-pgserve-legacy.js` — detects a postgres process owned by genie listening on a non-canonical port (NOT 8432) AND the canonical pgserve is responding; if both true, gracefully stop the legacy embedded (`pg_ctl stop` + remove pid file), and never spawn it again because migration `001` already pointed genie-serve at canonical
- Failure semantics: a migration that fails records a FAILED row + reason; subsequent `genie migrate` retries it; never silently skips
- CHANGELOG entry naming the contract: *"Users upgrading to genie@>=4.260503.x get host-state migrations applied transparently via postinstall. Manual `genie migrate` remains as the explicit escape hatch."*
- Docs: short page in `docs/migrations.md` explaining how operators write a new migration (file naming, idempotency requirement, recording semantics)

### OUT

- DB schema migrations (already covered by drizzle in `src/db/migrations/`) — this is HOST state migrations, separate concern
- Auto-rollback on failure (`genie migrate --rollback`) — explicit out; failed migrations are loud + retried, not auto-undone
- Migration of cross-host state (anything beyond `~/.genie/`, `pm2 ls`, listening ports, pgserve config dir) — single-host scope only
- Replacing `pgserve upgrade` (sibling wish) — these compose: a future genie migration `005-pgserve-canonical-flush.js` MAY shell out to `pgserve upgrade --quiet`, but pgserve owns its own upgrade primitive
- Per-app credential rotation (autopg domain, deferred to autopg-v22 wish)
- TUI for migration status (`docs:migrations` page covers it; CLI table is enough for v1)
- Migration version-locking against genie cli version (e.g. "this migration only applies if you came from <X.Y.Z>") — first ship is unconditional apply-once-per-host

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Track in `~/.genie/migrations.json` (not PG) | Migrations may need to RUN before genie-serve / canonical pgserve are healthy; can't depend on PG to know "is migration X applied". File-store is the only safe source. |
| 2 | Filename = id, alphabetical = apply order | Drizzle-style. Easy to grep history, easy to add new migrations, deterministic. |
| 3 | Postinstall auto-runs migrations, soft-fails | Matches pgserve `autopg upgrade` postinstall pattern (sibling wish). Operator never has to remember to run anything. |
| 4 | Each migration exports check + apply + validate triplet | check() lets dry-run + status be cheap (no side effects); apply() is the write side; validate() catches "applied but didn't actually fix" errors |
| 5 | Failed migrations RECORDED + retried, not silently skipped | Drift can be partial — a re-attempt may succeed (race resolved, race-y dependency now ready). Silent skip = invisible breakage. |
| 6 | First two migrations close known live breaks | Proves the framework on real data, not just synthetic tests. |
| 7 | `GENIE_SKIP_MIGRATIONS=1` escape hatch | CI / containers / sandbox installs — operator opt-out per-invocation. |
| 8 | Soft-fail postinstall (exit 0 + warn) | `bun install` must never break, even if migrations fail. Operator runs `genie migrate` manually to investigate. |

## Success Criteria

- [ ] `genie migrate --dry-run` lists pending migrations on a host that hasn't run them
- [ ] `genie migrate` applies all pending in alphabetical order; records each in `~/.genie/migrations.json`
- [ ] `genie migrate` is no-op (exit 0, < 1s) on already-up-to-date host
- [ ] `genie migrate --status` shows applied (with timestamp + version), pending, and any FAILED migrations
- [ ] `bun add -g @automagik/genie@latest` triggers postinstall which calls `genie migrate --quiet` invisibly
- [ ] `bun install` succeeds even if migration errors (soft-fail with warning to stderr)
- [ ] Migration `001-pm2-env-databaseurl-bake` detects current Felipe-style box (pm2 genie-serve missing DATABASE_URL + canonical pgserve registered) and re-bakes env on apply
- [ ] Migration `002-kill-embedded-pgserve-legacy` detects current Felipe-style box (postgres listening on 21900 owned by genie + canonical 8432 healthy) and stops the legacy embedded
- [ ] After both migrations apply: `genie send 'test' --to <agent>` succeeds (validates end-to-end the live break Felipe is currently hitting)
- [ ] Re-running `genie migrate` after success = exit 0, all migrations show "applied (no-op)" — idempotent
- [ ] CHANGELOG entry present with literal contract sentence
- [ ] `bun test packages/cli/src/migrations/` passes (orchestrator unit tests + 2 migration smoke tests)

## Execution Strategy

Single wave, sequential — all groups touch related code in `src/migrations/`. Engineer implements framework first, then 2 initial migrations, then postinstall + tests. PR is one cohesive shipment per the canonical-genie-omni-wiring SHIPPED pattern (one PR, one wish, full vertical).

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Migration framework: orchestrator + runner + tracking store + CLI verb |
| 2 | engineer | Initial 2 migrations: `001-pm2-env-databaseurl-bake`, `002-kill-embedded-pgserve-legacy` |
| 3 | engineer | Postinstall hook + soft-fail wire + CHANGELOG + smoke tests + docs/migrations.md |

---

## Execution Groups

### Group 1: Migration framework (orchestrator + runner + tracking store + CLI verb)
**Goal:** Build the host-migration runtime: discover migrations, track applied state, apply pending in order, expose CLI surface (`genie migrate` + `--dry-run` + `--status`).

**Deliverables:**
1. `src/migrations/index.js` — orchestrator (discover steps, filter pending, apply in alphabetical order, record results)
2. `src/migrations/runner.js` — per-step wrapper enforcing the `check → apply → validate` contract, consistent logging
3. `src/migrations/store.js` — read/write `~/.genie/migrations.json` with atomic write (tmp file + rename)
4. `src/migrations/discover.js` — scan `src/migrations/steps/` for `*.js` files matching `^\d{3}-.+\.js$`, sorted alphabetical
5. CLI wire — register `genie migrate` subcommand in the existing CLI dispatcher, with `--dry-run` and `--status` flags
6. Unit tests: orchestrator with synthetic migrations covering apply, no-op, retry-on-failure, dry-run, status

**Acceptance Criteria:**
- [ ] `genie migrate --dry-run` on fresh host lists all available migrations as PENDING
- [ ] `genie migrate` applies in correct order, writes `~/.genie/migrations.json`
- [ ] Re-running `genie migrate` is no-op (<1s, exit 0, all rows show APPLIED)
- [ ] `genie migrate --status` table shows id / status / appliedAt / appliedFrom
- [ ] Failed migration recorded as FAILED with reason; next `genie migrate` retries it
- [ ] Atomic store write prevents partial JSON on crash
- [ ] Unit tests cover all 5 above scenarios

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  bun test packages/cli/src/migrations/ && \
  ./bin/genie.js migrate --dry-run
```

**depends-on:** none

### Group 2: Initial migrations — close live breaks
**Goal:** Ship 2 first-class migrations that prove the framework on real Felipe-box state and close the upgrade-silent-breakage we hit live today.

**Deliverables:**
1. `src/migrations/steps/001-pm2-env-databaseurl-bake.js`:
   - `check(ctx)` returns true if `pm2 ls` shows `genie-serve` AND its env block lacks `DATABASE_URL` AND canonical pgserve is registered (port 8432 reachable)
   - `apply(ctx)` invokes the bake-env code path from commit `5567e202` (refactor it to be callable from migrations, not just `genie install`)
   - `validate(ctx)` re-reads pm2 env and asserts `DATABASE_URL` present + matches canonical pgserve URL
2. `src/migrations/steps/002-kill-embedded-pgserve-legacy.js`:
   - `check(ctx)` returns true if a postgres process owned by genie is listening on a non-canonical port (default detection: any port != 8432) AND canonical pgserve responds on 8432
   - `apply(ctx)` graceful `pg_ctl stop` the legacy postgres + remove its pid file + clean up `/tmp/pgserve-sock-*` orphans
   - `validate(ctx)` re-checks no genie-owned postgres is listening on non-canonical ports
3. Refactor the bake-env code in `genie install` so migration 001 can call it directly (single source of truth, no copy-paste)

**Acceptance Criteria:**
- [ ] On Felipe's current box (pm2 genie-serve env empty + embedded pgserve on 21900): both migrations apply, validate passes, `genie send` works after
- [ ] On a fresh install (canonical pgserve from day 0, no legacy embedded): both migrations check → false → SKIP record, no side effects
- [ ] On a partial-state host (env baked but legacy embedded still running): only 002 applies, 001 skips
- [ ] Synthetic test fixtures cover: fresh, fully-broken, half-fixed, already-good
- [ ] No regression in `genie install` standalone (refactor preserves existing behavior)

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  bun test packages/cli/src/migrations/steps/ && \
  ./bin/genie.js migrate --status
```

**depends-on:** Group 1

### Group 3: Postinstall hook + tests + CHANGELOG + docs
**Goal:** Wire the auto-run, ship the contract docs, lock the operator promise.

**Deliverables:**
1. `scripts/postinstall.cjs` — soft-fail invoker of `genie migrate --quiet`; respects `GENIE_SKIP_MIGRATIONS=1`; never breaks `bun install`
2. `package.json` — add `"postinstall": "node scripts/postinstall.cjs"` and ensure `scripts/` is in `files`
3. Smoke tests in `tests/migrations/`:
   - `postinstall.test.js` — skip flag short-circuits; missing `~/.genie/` exits 0; existing `~/.genie/` invokes migrate
   - `orchestrator.test.js` — dry-run lists discoverable steps; apply records to store; no-op on already-applied
4. `CHANGELOG.md` entry under `## v4.x.x — Host Migrations` containing literal contract: *"Users upgrading to genie@>=4.260503.x get host-state migrations applied transparently via postinstall. Manual `genie migrate` remains as the explicit escape hatch for forced re-runs."*
5. `docs/migrations.md` — operator + contributor guide: how migrations work, how to write a new one (filename pattern, check/apply/validate contract, idempotency requirement), how to inspect status

**Acceptance Criteria:**
- [ ] `bun test tests/migrations/` passes
- [ ] CHANGELOG entry present with exact contract sentence
- [ ] `docs/migrations.md` covers: lifecycle diagram, file format, error semantics, escape hatch
- [ ] `bun run lint` clean (matches genie's existing eslint config)
- [ ] `AUTOPG_SKIP_POSTINSTALL=1` (sibling pattern) inspires `GENIE_SKIP_MIGRATIONS=1` — same env var convention
- [ ] `bun add -g @automagik/genie@<latest>` in clean container triggers postinstall; observable via stderr line

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && \
  bun test tests/migrations/ && \
  bun run lint && \
  grep -F "Manual \`genie migrate\` remains as the explicit escape hatch" CHANGELOG.md
```

**depends-on:** Group 2

## Dependencies

- **depends-on:** none (genie cli has all needed primitives — no upstream blockers)
- **blocks:** future fixes that need pm2 / config / process-state self-heal — they ship as new migration files in `src/migrations/steps/`
- **sibling:** `pgserve/autopg-upgrade-command` (same self-heal philosophy, scoped to pgserve subsystem; future genie migration may shell out to `pgserve upgrade --quiet`)

## QA Criteria

After merge to dev:
1. Felipe's dogfood box (currently broken: genie-serve no DATABASE_URL + embedded pgserve on 21900) → `genie update --next` → postinstall runs migrate → both 001 + 002 apply → `genie send` works without manual intervention
2. Fresh install in clean container → `bun add -g @automagik/genie@<latest>` → postinstall → migrate runs → both 001 + 002 SKIP (already-clean state) → exit 0
3. Re-run `genie update --next` on same box → postinstall → migrate no-op → exit 0 in <1s
4. CI in pgserve repo + genie repo: smoke tests pass on both ubuntu and macos runners
5. `genie doctor` reports new section "Host Migrations" with applied/pending count

## Assumptions / Risks

- **Assumption:** `~/.genie/` directory is the operator-trusted location for genie state. Existing migrations like `~/.genie/state/upgrade.signal` (sibling autopg pattern) confirm this convention.
- **Assumption:** pm2 ls + env inspection work reliably on all supported platforms (linux + macos). pgserve smoke tests already exercise both.
- **Risk:** A migration that's idempotent in test fixtures may not be idempotent in production due to environmental variance (timing, partial state). Mitigation: validate() step catches "applied but didn't actually fix" by re-asserting end state.
- **Risk:** Postinstall running in CI / nested installs could interfere with provisioning scripts. Mitigation: `GENIE_SKIP_MIGRATIONS=1` escape hatch + explicit "skip if no `~/.genie/`" check.
- **Risk:** Concurrent `genie migrate` invocations could race on `~/.genie/migrations.json` writes. Mitigation: atomic write (tmp + rename) + advisory file lock if implementable cheaply (else accept best-effort and document).
- **Risk:** The bake-env code in `genie install` refactor (group 2) may break standalone `genie install` flow. Mitigation: preserve existing CLI surface, only EXTRACT the bake function so migration 001 can call it; CI covers `genie install` standalone.
