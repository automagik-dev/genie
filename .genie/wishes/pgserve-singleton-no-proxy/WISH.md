# Wish: genie consumer of pgserve singleton — no-proxy + tier integration + self-healing update

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `pgserve-singleton-no-proxy` |
| **Date** | 2026-05-06 |
| **Author** | Felipe Rosa <felipe@namastex.ai> |
| **Appetite** | medium (~1-2 weeks) |
| **Branch** | `wish/pgserve-singleton-no-proxy` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [SHARED-DESIGN.md](./SHARED-DESIGN.md) |

> **Companion wishes** (byte-identical SHARED-DESIGN.md): `automagik/pgserve#pgserve-singleton-no-proxy` (the big one — kills proxy, adds cosign), `automagik/omni#pgserve-singleton-no-proxy` (consumer-side wiring). All three ship in parallel.

## Summary

Wire genie as a clean consumer of the new pgserve 2.3 singleton (no proxy, native socket + TCP 5432). Add tier integration via `pgserve verify` invocation in connection setup. Make `genie update` self-healing: pm2 restart self with `--update-env`, run all migrations, invoke `genie doctor --fix` (tiered) post-restart. Add active-vendored-pgserve assertion to defend against regression. Declare `pgserve: ">=2.3"` in compile-time `requirements` manifest. See `SHARED-DESIGN.md` §1-§9 for full design context, especially §5.2 for genie-specific scope.

## Scope

### IN

**Group 1 — Tier integration in connection setup**
- New `src/lib/pgserve-tier.ts`: reads `package.json` `pgserve` block; resolves identity_chain; calls `pgserve verify` CLI on first connect; returns resolved `{ tier, identity, role }` triple.
- Wire into `_buildConnection()` in `src/lib/db.ts`: pass `application_name` to postgres reflecting tier (e.g., `signed:cosign:@automagik/genie`).
- Update default connection target: prefer `host=$XDG_RUNTIME_DIR/pgserve` (Unix socket) → fallback `host=localhost port=5432` (TCP). Drop any `8432` references.
- HMAC-cache-token consumer: read `$XDG_STATE_HOME/pgserve/verified/<fp>.token` if present; only call `pgserve verify` on cache miss or mtime change.
- Add `genie pgserve verify` CLI alias: invokes `pgserve verify <bundled-binary-path>`. Diagnostic output for support cases.

**Group 2 — Vendored-pgserve assertion**
- Active startup check in `src/genie.ts` boot path: `existsSync(node_modules/@automagik/genie/node_modules/pgserve/bin/pgserve-wrapper.cjs)`.
- If found: warn loud, emit `rot.vendored-pgserve.detected` audit event, do NOT spawn it (per consumer-only contract from canonical-cutover), continue boot.
- Add a regression test: synthetic stale-cache fixture with vendored pgserve dir → assert the warning + audit event fire.

**Group 3 — `genie update` self-healing pipeline**
- Step 4 (preInstallPeerCheck): query `pgserve --version` + `omni --version`; refuse upgrade if peer below required (`pgserve: ">=2.3"`).
- Step 6 (confirmIfActiveTasks): query `genie ls --active --json` count via local PG; if >0, show "N active tasks will be interrupted; --yes to proceed" warning.
- Step 8 (runMigrations): wire `runMigrations()` to execute all pending genie migrations including new migration 002-cleanup-legacy-pgserve-datadir (archive `~/.genie/data/pgserve` → `~/.genie/.legacy/pgserve-<ts>/` if canonical detected).
- Step 9 (pm2RestartSelfWithUpdateEnv): query `pm2 jlist`, identify entries owned by genie (`genie-serve`), `pm2 restart <entry> --update-env`. Honor `--no-pm2-restart` for environments without pm2 (CI fixtures, dev laptops without pm2).
- Step 11 (doctorFix): replace post-update `runDoctor({ json: true, dryRun: true })` with `runDoctor({ fix: true, mode: 'tiered' })` per `SHARED-DESIGN.md` §3.2. Cat 1 silent; Cat 2 prompts; Cat 3 refuses.
- Confirm prompt enhancements: pass `--ignore-peer-mismatch` typed-ack `I_ACKNOWLEDGE_PEER_MISMATCH` for debug.

**Group 4 — `genie doctor` tiered modes**
- Existing `genie doctor`: extend with `--fix` flag (tiered model: cat 1 auto, cat 2 prompt) and `--fix --aggressive` (cat 1+2 no prompt).
- New mutations the doctor knows about:
  - **Cat 1**: pm2 restart genie-serve with --update-env when filesystem version > running version; refresh tmux config / theme symlinks; refresh `~/.claude/plugins/cache/automagik/genie/<ver>` symlink; remove stale `.genie/state/*` lockfiles.
  - **Cat 2**: archive `~/.genie/data/pgserve` legacy dir; clean orphaned worker rows >7 days old; drop ghost executor rows.
  - **Cat 3**: any DROP DATABASE on a populated genie DB; role privilege escalation; force-overwrite of operator-modified config.
- Audit-log every mutation with `{ category, action, before, after, durationMs }`.

**Group 5 — `requirements` manifest + `--requirements` flag**
- New compile-time constant `REQUIREMENTS = { pgserve: ">=2.3", omni: ">=2.5" }` in `src/lib/requirements.ts`.
- New CLI: `genie --requirements --json` outputs the manifest as JSON.
- `genie update` step 4 (preInstallPeerCheck) reads the published manifest of the target version (via `bunx npm view @automagik/genie@<channel> requirements` or via the binary's `--requirements` once installed) and verifies against currently-installed peer versions.
- Refuse with diagnostic: "genie 5.0 requires pgserve ≥3.0, you have 2.2.4. Run `pgserve update` first."

**Group 6 — `package.json` `pgserve` block + cosign identity declaration**
- Update `package.json` with `pgserve.identity_chain`:
  ```json
  "pgserve": {
    "publisher": "@automagik/genie",
    "identity_chain": [
      { "kind": "cosign_signed", "issuer": "https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v*" },
      { "kind": "host_signed" }
    ],
    "on_chain_exhausted": "refuse"
  }
  ```
- Drop `pgserve.persist: true` (universal persistence now per `SHARED-DESIGN.md` decision #5).
- Documentation in `docs/install.md`: explain `identity_chain` semantics for downstream consumers.

**Group 7 — Tests + docs + CHANGELOG**
- Tier integration tests: `pgserve verify` invocation + cache-token roundtrip + `application_name` propagation.
- Self-healing update tests: pm2-stale-binary fixture → `genie update` heals; pre-install peer mismatch → refuses; active-tasks confirm prompt.
- Doctor tiered modes: cat 1 / cat 2 / cat 3 mutation behavior.
- Vendored-pgserve assertion test.
- Migration 002 archive idempotency.
- README + install docs updated for new socket path + cosign tier model.
- CHANGELOG entry.

### OUT

- Changes to pgserve repo itself (companion wish owns).
- Changes to omni repo (companion wish owns).
- New auth model beyond what `pgserve verify` returns (genie has no API-key auth concept today; `auth-invalid` variant of `VerifyResult` stays reserved-null).
- Source-install path (`GENIE_SRC=...`) overhaul — existing path stays as-is; just the connection default changes.
- Plugin cache sync changes — orthogonal.
- Tmux config / theme refresh changes — orthogonal.
- Aegis runtime sandboxing — separate umbrella.
- Migrating brain consumer to use the new tier system — separate wish.

## Decisions

See `SHARED-DESIGN.md` §6 for the cross-repo decision table. genie-specific:

| # | Decision | Rationale |
|---|----------|-----------|
| G1 | Default connection target = Unix socket (`$XDG_RUNTIME_DIR/pgserve`), TCP fallback | Performance + matches `resolvePgserveLibpqSocketPath()` already in `db.ts`. |
| G2 | `pgserve verify` invocation cached via HMAC-signed token; never re-invoked steady-state | Per `SHARED-DESIGN.md` §2.4: web-session-style cache. Steady-state queries pay 0ms. |
| G3 | `genie update` step 9 always restarts pm2 entries owned by genie (`genie-serve`); honors `--no-pm2-restart` for pm2-less environments | Self-healing requires the pm2 process to pick up new binary. Without this, the stale-binary defect persists indefinitely. |
| G4 | Migration 002 archives `~/.genie/data/pgserve` → `.legacy/` (Cat 2 prompted in interactive mode; auto in `--aggressive`) | Forensic preservation; never auto-delete. |
| G5 | Vendored-pgserve assertion is warn-only (not refuse) | Stale node_modules cache is operator's fault, not actively harmful (we don't spawn it). Loud warning is enough. |
| G6 | `application_name` carries tier identity (e.g., `signed:cosign:@automagik/genie`) | Visible in `pg_stat_activity` for ops debugging without needing pgserve_meta lookup. |
| G7 | `--ignore-peer-mismatch` requires typed-ack `I_ACKNOWLEDGE_PEER_MISMATCH` | Reuses pattern from `--unsafe-unverified`; not a casual override. |

## Success Criteria

- [ ] `_buildConnection()` defaults to Unix socket; TCP fallback works when XDG_RUNTIME_DIR unset.
- [ ] No `8432` literal anywhere in genie source post-this-PR (`grep -rn '8432' src/` returns 0 hits in non-test, non-comment lines).
- [ ] `genie pgserve verify` invokes `pgserve verify` against bundled binary; outputs tier identity.
- [ ] First `genie spawn` after fresh install: `pgserve verify` runs, cache token written.
- [ ] Second `genie spawn`: cache token read, `pgserve verify` not re-invoked.
- [ ] Vendored `node_modules/.../pgserve/bin/` present: warning emitted, `rot.vendored-pgserve.detected` event written, boot continues.
- [ ] `genie update` from stale-pm2 fixture: `pm2 jlist` shows running version < filesystem version pre-update; post-update they match.
- [ ] `genie update` with peer mismatch (synthetic pgserve@2.2.x): refuses with remediation.
- [ ] `genie update --ignore-peer-mismatch I_ACKNOWLEDGE_PEER_MISMATCH`: proceeds despite mismatch.
- [ ] `genie update --no-pm2-restart`: skips pm2 restart cleanly.
- [ ] `genie update` with 5 active tasks: shows warning prompt; `--yes` proceeds; declined exits 0.
- [ ] `genie doctor --fix` (default): mutates Cat 1 silently; prompts Cat 2; refuses Cat 3.
- [ ] `genie doctor --fix --aggressive`: cat 1+2 no prompt; refuses cat 3.
- [ ] `genie --requirements --json` returns valid JSON `{"pgserve":">=2.3","omni":">=2.5"}`.
- [ ] Migration 002: legacy `~/.genie/data/pgserve` archived to `.legacy/pgserve-<ts>/`; idempotent (re-run is no-op).
- [ ] `package.json` declares `pgserve.identity_chain` + `publisher` + `on_chain_exhausted`.
- [ ] Existing tests pass byte-identically.
- [ ] `bun run check` passes.
- [ ] CHANGELOG entry references socket path change + tier integration + self-healing update.

## Execution Strategy

### Wave 1 — Foundation (parallel)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Tier integration: pgserve-tier helper + `_buildConnection` rewrite + Unix socket default. |
| 2 | engineer | Vendored-pgserve assertion + audit event + regression test. |
| 5 | engineer | Compile-time `requirements` manifest + `--requirements` flag. |

### Wave 2 — Self-healing (sequential after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `genie update` self-healing pipeline: peer check, active-tasks confirm, migrations, pm2 restart, doctor --fix. |
| 4 | engineer | `genie doctor` tiered modes (--fix / --fix --aggressive). |
| 6 | engineer | `package.json` `pgserve` block + `identity_chain` declaration + docs. |

### Wave 3 — Validation

| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Tests + docs + CHANGELOG. |

## Execution Groups

### Group 1: Tier integration in connection setup

**Goal:** Genie connects to canonical pgserve via Unix socket by default; reads tier identity via `pgserve verify`; HMAC cache-token short-circuits steady-state.

**Deliverables:**
1. New `src/lib/pgserve-tier.ts`:
   - `resolveTier(): Promise<TierResult>` reads `package.json` pgserve block, walks identity_chain, invokes `pgserve verify` CLI on cache miss.
   - `TierResult` is tagged-union: `{ kind: 'cosign' | 'host_signed' | 'self_signed' | 'path', identity, role, applicationName }`.
2. Modify `src/lib/db.ts` `_buildConnection()`:
   - Default `host` = `$XDG_RUNTIME_DIR/pgserve` (Unix socket).
   - Fallback `host=localhost port=5432` (TCP) if Unix socket unreachable.
   - Set `application_name` from `TierResult`.
3. Drop any `8432` literals from connection-string defaults.
4. New `genie pgserve verify` CLI alias.
5. Tests: cache-token roundtrip, fallback path, application_name propagation.

**Acceptance Criteria:**
- [ ] `_buildConnection()` defaults to Unix socket on hosts where `$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432` exists.
- [ ] `_buildConnection()` falls back to TCP 5432 when Unix socket unreachable.
- [ ] `pgserve verify` is invoked exactly once per fingerprint per cache window.
- [ ] `application_name` in `pg_stat_activity` matches resolved tier (e.g., `signed:cosign:@automagik/genie`).
- [ ] `grep -rn '8432' src/` matches only test fixtures or comments referencing legacy.

**Validation:**
```bash
bun test src/lib/__tests__/pgserve-tier.test.ts
bun test src/lib/__tests__/db.test.ts
grep -rn '8432' src/ | grep -v test | grep -v '//'
```

**depends-on:** none

---

### Group 2: Vendored-pgserve assertion

**Goal:** Defensive assertion at boot prevents regression where stale node_modules cache reintroduces vendored pgserve. Warn loud, do not spawn.

**Deliverables:**
1. New helper `src/lib/vendored-pgserve-check.ts`: `existsSync(node_modules/@automagik/genie/node_modules/pgserve/bin/pgserve-wrapper.cjs)`.
2. Wire into `src/genie.ts` boot path: emit warning to stderr + audit event `rot.vendored-pgserve.detected` + continue.
3. Audit event schema: `{ vendored_path, host_pgserve_version, timestamp }`.
4. Regression test: synthetic node_modules fixture with vendored pgserve → assert warning + event fire.

**Acceptance Criteria:**
- [ ] On host without vendored pgserve: zero overhead, no event.
- [ ] On host with vendored pgserve: warning to stderr; audit event written; boot continues.
- [ ] Boot does not spawn the vendored pgserve.
- [ ] `genie doctor` reports the rot signal (signal source from existing rot detector pattern).

**Validation:**
```bash
bun test src/lib/__tests__/vendored-pgserve-check.test.ts
```

**depends-on:** none

---

### Group 3: `genie update` self-healing pipeline

**Goal:** `genie update` post-this-PR converges drift to known-good state.

**Deliverables:**
1. Modify `src/genie-commands/update.ts` to add 5 new pipeline steps per `SHARED-DESIGN.md` §3.1:
   - **Step 4 (preInstallPeerCheck)**: query `pgserve --version` + `omni --version`; refuse upgrade if peer < required from manifest.
   - **Step 6 (confirmIfActiveTasks)**: query `genie ls --active --json`; show count + warning prompt; `--yes` skips.
   - **Step 8 (runMigrations)**: invoke migration runner (already exists from `update-unify-stages` G3); ensure migration 002-cleanup-legacy-pgserve-datadir runs.
   - **Step 9 (pm2RestartSelfWithUpdateEnv)**: query pm2 jlist; for entries matching `genie-serve` pattern, run `pm2 restart <name> --update-env`. Honor `--no-pm2-restart`.
   - **Step 11 (doctorFix)**: replace existing post-update maintenance with `runDoctor({ fix: true, mode: 'tiered' })`.
2. New migration 002 at `src/migrations/steps/002-cleanup-legacy-pgserve-datadir.ts`:
   - Detect `~/.genie/data/pgserve/` exists + canonical pgserve registered.
   - Cat 2 prompted (default) or auto in `--aggressive`: `mv ~/.genie/data/pgserve ~/.genie/.legacy/pgserve-<iso>/`.
   - Idempotent.
3. `--ignore-peer-mismatch` typed-ack flag (reuse `src/sec/unsafe-verify.ts` pattern).
4. Tests for all 5 new steps + the migration.

**Acceptance Criteria:**
- [ ] Stale-pm2 fixture: pre-update `pm2 jlist` shows version A; filesystem has version B; post-update `pm2 jlist` shows version B.
- [ ] Synthetic pgserve@2.2.x peer: `genie update` refuses with remediation.
- [ ] `genie update --ignore-peer-mismatch I_ACKNOWLEDGE_PEER_MISMATCH`: proceeds.
- [ ] `--no-pm2-restart`: skips step 9 cleanly.
- [ ] 5 active tasks fixture: prompt appears; `--yes` skips; declined exits 0.
- [ ] Migration 002: legacy dir archived; second run no-op.

**Validation:**
```bash
bun test src/genie-commands/__tests__/update.test.ts
bun test src/migrations/__tests__/002-cleanup-legacy-pgserve-datadir.test.ts
```

**depends-on:** Group 5 (requirements manifest)

---

### Group 4: `genie doctor` tiered modes

**Goal:** Doctor implements tiered fix authority: cat 1 silent, cat 2 prompt, cat 3 refuse.

**Deliverables:**
1. Extend `src/genie-commands/doctor.ts`:
   - `--fix`: tiered (cat 1 auto, cat 2 prompt).
   - `--fix --aggressive`: cat 1+2 no prompt.
2. Cat 1 mutations enumerated:
   - pm2 restart `genie-serve` when filesystem-version > running-version.
   - Refresh tmux config / theme / `osc52-copy.sh` symlinks (existing logic in update.ts).
   - Refresh `~/.claude/plugins/cache/automagik/genie/<ver>` symlink.
   - Remove stale `.genie/state/*` lockfiles older than 1h.
3. Cat 2 mutations enumerated:
   - Archive `~/.genie/data/pgserve` legacy dir (delegates to migration 002).
   - Clean orphaned worker rows >7 days old.
   - Drop ghost executor rows (no live PID, no recent heartbeat).
4. Cat 3 refusals enumerated:
   - DROP DATABASE on populated genie DB.
   - Role privilege escalation.
   - Force-overwrite operator-modified config.
5. Audit-log every mutation: `{ category, action, before, after, durationMs }`.
6. Tests for each category.

**Acceptance Criteria:**
- [ ] `genie doctor` (no flags): check-only.
- [ ] `genie doctor --fix`: mutates cat 1 silently; prompts each cat 2; refuses cat 3.
- [ ] `genie doctor --fix --aggressive`: mutates cat 1+2 no prompt.
- [ ] Audit log entry per mutation with full diff.

**Validation:**
```bash
bun test src/genie-commands/__tests__/doctor-tiered.test.ts
```

**depends-on:** Group 3

---

### Group 5: `requirements` manifest + `--requirements` flag

**Goal:** Genie declares peer version requirements at compile time; pre-install check enforces.

**Deliverables:**
1. New `src/lib/requirements.ts`:
   - `export const REQUIREMENTS = { pgserve: ">=2.3", omni: ">=2.5" } as const;`
   - `export function checkPeerVersion(peer, version): { ok: boolean, required: string }`.
2. New CLI: `genie --requirements --json` outputs JSON.
3. `genie update` step 4 (preInstallPeerCheck) calls `checkPeerVersion` for each peer; refuses on mismatch.
4. Tests: requirements parse, peer check satisfied/unsatisfied paths.

**Acceptance Criteria:**
- [ ] `genie --requirements --json` outputs `{"pgserve":">=2.3","omni":">=2.5"}`.
- [ ] `checkPeerVersion('pgserve', '2.3.0')` returns `{ok: true}`.
- [ ] `checkPeerVersion('pgserve', '2.2.4')` returns `{ok: false, required: '>=2.3'}`.
- [ ] `genie update` with peer < required refuses with remediation.

**Validation:**
```bash
bun test src/lib/__tests__/requirements.test.ts
genie --requirements --json | jq '.pgserve'
```

**depends-on:** none

---

### Group 6: `package.json` `pgserve` block + identity_chain

**Goal:** Declare genie as cosign-signed app via package.json `pgserve` block.

**Deliverables:**
1. Update `package.json`:
   ```json
   "pgserve": {
     "publisher": "@automagik/genie",
     "identity_chain": [
       { "kind": "cosign_signed", "issuer": "https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v*" },
       { "kind": "host_signed" }
     ],
     "on_chain_exhausted": "refuse"
   }
   ```
2. Drop `pgserve.persist: true` (universal persistence).
3. Update `docs/install.md` with `identity_chain` explanation.

**Acceptance Criteria:**
- [ ] `package.json` has new `pgserve` block.
- [ ] `pgserve.persist` flag removed.
- [ ] Docs updated.
- [ ] On signed release, `pgserve verify` resolves cosign tier; on local dev build, falls back to host_signed (TOFU); if both fail, refuse.

**Validation:**
```bash
jq '.pgserve.identity_chain | length' package.json | grep -q 2
test -f docs/install.md && grep -q identity_chain docs/install.md
```

**depends-on:** none

---

### Group 7: Tests + docs + CHANGELOG

**Goal:** Lock the contracts; document the migration; verify cross-repo coordination.

**Deliverables:**
1. Test suite: tier integration, vendored assertion, self-healing pipeline (5 new steps), doctor tiered, migration 002, requirements manifest.
2. README + `docs/install.md` updates: new socket path, tier model, identity_chain.
3. CHANGELOG entry: tier integration, self-healing update, doctor tiered, requirements manifest, breaking-change notice (TCP 8432 → 5432; default Unix socket).
4. Cross-repo coordination: confirm pgserve + omni companion wishes referenced.

**Acceptance Criteria:**
- [ ] `bun run check` clean.
- [ ] CHANGELOG entry present with literal contract sentences.
- [ ] README + install docs updated.
- [ ] No regression in existing wishes' acceptance criteria.

**Validation:**
```bash
bun run check
grep -F "self-healing genie update" CHANGELOG.md
test -f docs/install.md
```

**depends-on:** Group 4, Group 6

---

## Cross-wish dependencies

- **paired-with** `automagik/pgserve#pgserve-singleton-no-proxy` — needs pgserve 2.3 CLI verbs + canonical socket. This wish targets a `dev` branch where pgserve 2.3 is installed; integration smoke test runs after pgserve sibling lands.
- **paired-with** `automagik/omni#pgserve-singleton-no-proxy` — same semantics on omni side; ships in lockstep.
- **builds-on** `pgserve-canonical-cutover` (merged) — consumer-only model is foundation; this wish completes the gap by wiring tier resolution + self-healing pm2 restart.
- **builds-on** `pgserve-host-signed-identity` (merged) — host_signed Tier 1 stays; cosign Tier 2 layered.
- **builds-on** `update-unify-stages` (merged) — pre-flight + decideVerify + diagnostics.
- **builds-on** `genie-supply-chain-signing` — reuses `--unsafe-unverified` typed-ack pattern.

## QA Criteria

- [ ] Functional — `genie spawn engineer` on fresh host with pgserve 2.3: cosign verify runs once, cache persisted, subsequent spawns reuse cache.
- [ ] Functional — `genie update` with stale pm2 binary: post-update pm2 version matches filesystem.
- [ ] Functional — `genie update` with peer pgserve below required: refuses; remediation prints exact next command.
- [ ] Functional — `genie doctor --fix` mutates Cat 1 silently; prompts Cat 2; refuses Cat 3 with remediation.
- [ ] Functional — Migration 002 archives legacy data dir; idempotent.
- [ ] Functional — Vendored pgserve fixture: warning + audit event fire; boot continues.
- [ ] Integration — Companion pgserve provides canonical socket; genie connects via Unix socket primary.
- [ ] Integration — `application_name` in `pg_stat_activity` reflects resolved tier.
- [ ] Regression — All existing tests pass byte-identically.
- [ ] Regression — Locked source-string for "post-update maintenance does not auto-start pgserve" still holds.
- [ ] Cross-repo — Smoke test on canary host: pgserve 2.3 + genie 5.x + omni equivalent all green.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `pgserve verify` slow on cold cache: blocks first connect by ~200ms | Medium | Acceptable for cold path; cache short-circuits steady-state. Benchmark in Group 1. |
| pm2 restart kills in-flight tasks during update | Medium | Auto-resume infra recovers; confirm prompt warns operator. |
| `--no-pm2-restart` becomes default in CI by accident | Low | Lint rule against in CI configs; warning emitted on every use. |
| Vendored pgserve assertion fires on legitimately-old node_modules cache during `bun install` mid-flight | Low | Boot warning is informational; doesn't block. Operator clears cache and re-runs `bun install`. |
| Identity_chain misconfigured (typo in issuer URL) → tier refusal in production | High | CI lint validates `package.json` pgserve block schema; tests cover the refuse path. |
| Operator removed `~/.genie/data/pgserve` manually pre-migration | Low | Migration 002 detects absence and is no-op. |
| Cosign verify requires network on first install in air-gapped CI | Medium | Document `pgserve trust add --offline-cosign-key` + `genie install --skip-cosign-verify` fallback (typed-ack required). |
| Existing locked-string test "consumer-only after the canonical-pgserve cutover" needs string-mod | Low | Update test fixture; net behavior preserved. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Modify
src/lib/db.ts                                          # _buildConnection default to Unix socket; drop 8432
src/genie.ts                                           # vendored-pgserve assertion at boot
src/genie-commands/update.ts                           # 5 new pipeline steps; --ignore-peer-mismatch
src/genie-commands/doctor.ts                           # --fix tiered modes
package.json                                           # pgserve.identity_chain block; drop persist:true
CHANGELOG.md
docs/install.md
README.md

# Create
src/lib/pgserve-tier.ts
src/lib/__tests__/pgserve-tier.test.ts
src/lib/vendored-pgserve-check.ts
src/lib/__tests__/vendored-pgserve-check.test.ts
src/lib/requirements.ts
src/lib/__tests__/requirements.test.ts
src/migrations/steps/002-cleanup-legacy-pgserve-datadir.ts
src/migrations/__tests__/002-cleanup-legacy-pgserve-datadir.test.ts
src/genie-commands/__tests__/doctor-tiered.test.ts

# Reference (read-only)
.genie/wishes/pgserve-singleton-no-proxy/SHARED-DESIGN.md
```
