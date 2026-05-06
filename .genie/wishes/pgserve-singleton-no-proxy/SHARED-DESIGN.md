# SHARED-DESIGN: pgserve singleton, no proxy, self-healing updates

**Status**: design locked 2026-05-06.

**Companion wishes** (byte-identical SHARED-DESIGN.md across all three):
- `automagik/pgserve#pgserve-singleton-no-proxy` — pgserve major v2.3 (kill proxy, add cosign, new CLI verbs)
- `automagik-dev/genie#pgserve-singleton-no-proxy` — genie consumer-side wiring + self-healing `genie update`
- `automagik/omni#pgserve-singleton-no-proxy` — omni consumer-side wiring + self-healing `omni update`

**Goal**: One synchronized cutover that converges three things — kill the bun proxy from the data plane, layer cosign-based publisher-attestation on top of host-signed identity, and lock down a self-healing `<cli> update` contract so every update converges drift to known-good state without manual operator intervention.

**Version target**: pgserve **2.3** (not 3.0 — 3.0 reserved for the post-npm-departure cutover per `distribution-exodus`).

---

## 1. Today's friction (the diagnosis)

### Three independent symptoms that have one root

1. **Two pgserves on disk, only one understood.** `pm2 pgserve` (autopg 2.2.4) runs the bun bridge on TCP 8432 → routes to internal postgres on 9432 → exposes `/tmp/pgserve-sock-<pid>-<ts>` Unix socket. Genie expects pgserve socket at `$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432`. **Mismatch:** genie's `requirePgserveDaemon()` (`src/lib/db.ts:307`) only checks the canonical Unix socket; throws "no daemon" even when bun bridge + postgres backend are both healthy on TCP. Live diagnostic on this server (2026-05-05): pgserve binary `pgserve port` returns `8432` ✅, postgres backend listening on 9432 ✅, but `/run/user/1000/pgserve/` directory does not exist ❌.

2. **Genie was already cut over to consumer-only — but the cutover is invisible at runtime.** `pgserve-canonical-cutover` shipped on dev (commits `eefc9a94`, `bd8845eb`, `0ae69eb3`). `_ensurePgserve()` (`db.ts:749`) explicitly throws "Genie is consumer-only after the canonical-pgserve cutover; it does not spawn pgserve." Vendored pgserve binary in `node_modules/@automagik/genie/node_modules/pgserve/` was removed. Yet pm2 `genie-serve` (id 14) shows **18 restarts in 3 hours** with scheduler.log spamming "pgserve v2 daemon exited before binding". The canonical socket the cutover code expects doesn't exist; the cutover landed but didn't land cleanly because the **autopg pgserve doesn't publish to the canonical socket path** genie was consuming.

3. **`genie update` is not self-healing.** Operator runs `genie update`, new binary installs to disk, BUT pm2's running process keeps the OLD binary in memory (no `pm2 restart genie-serve --update-env`). `<cli> doctor --fix` is not invoked. Migrations don't run automatically. Result: the cutover code shipped 2 days ago is on disk but not in any running process. Operator manually runs `pm2 restart genie-serve` after every update to actually pick up the new bits — and most don't.

### The pattern

Each symptom looks like a separate bug. The pattern is one architectural drift: the system has two control planes (bun pgserve daemon supervision via pm2, plus genie's own daemon supervision via pm2-and-process-tree-walking), and updates touch one but not the other. Every release widens the drift until the operator does manual reconciliation.

---

## 2. The shift (architectural target)

### 2.1 Data plane: pure postgres, two transports, no proxy

Postgres backend listens on **both** transports natively. Zero bun in the data path:

- **Unix socket** at `$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432` (canonical, primary). Set via postmaster `-k $XDG_RUNTIME_DIR/pgserve` argument.
- **TCP** on port `5432` (canonical port, not 8432). Set via postmaster `-p 5432` and `listen_addresses = 'localhost'`.

Clients connect with libpq directly — `PGHOST=$XDG_RUNTIME_DIR/pgserve` for socket, or `host=localhost port=5432` for TCP. No bridge. No router. No `8432`.

The bun process that exists today as the proxy/router **dies in the data plane**. It survives only as the `pgserve` CLI binary, invoked on-demand for control operations.

### 2.2 Control plane: CLI on-demand, zero always-on bun process

The bun pgserve daemon is **deleted as a process**. All control-plane operations move to `pgserve` CLI subcommands invoked on-demand:

- `pgserve provision <fingerprint>` — creates DB + role, validates trust tier (cosign / host_signed / path), idempotent. Called by client SDK on `3D000` (database-not-found) errors with `pg_advisory_lock` to dedupe concurrent races.
- `pgserve gc` — sweeps orphaned databases (uid removed, project deleted via project-marker mtime checks). Run by cron / systemd timer, NOT a long-running scheduler. `pgserve install` wires the timer automatically.
- `pgserve verify <binary-path>` — performs cosign / host_signed validation against trust list, writes HMAC-signed cache token at `$XDG_STATE_HOME/pgserve/verified/<fingerprint>.token`.
- `pgserve trust add` / `pgserve trust list` / `pgserve trust remove` — manage user-extensible trust roots (cosign keys, OIDC issuer identities).
- `pgserve doctor` (default) / `pgserve doctor --fix` (auto-mute safe mutations + prompt risky ones) / `pgserve doctor --fix --aggressive` (no prompts, CI mode).

Audit becomes a postgres `pgaudit` extension load — no application-level audit-log writer. Logrotate config shipped with `pgserve install`.

### 2.3 Identity & trust: signed vs not-signed (binary classification)

Two outcomes, both persistent (no ephemeral, no TTL). Persistence is universal; the tier decides only trust + role grants.

| Class | Verifies as | DB | Role grants | UX |
|-------|-------------|-----|-------------|-----|
| **signed** | cosign-verified OR host_signed handshake OR operator-pretrusted self-sign | persistent project DB | named role; full owner of own DB; can request explicit cross-DB grants (Tier 2 cosign-named only via `pgserve grant`) | silent run; badge in `pgserve doctor` |
| **not signed** | everything else (no `pgserve` block in package.json, OR no signature, OR no handshake) | persistent project DB | full owner of own DB; **zero** cross-DB; whitelisted extensions only | RUN with warning banner: "⚠ UNSIGNED — DEV ONLY" |

**Critical**: not-signed apps are NOT ephemeral. They get the same project-scoped persistent DB as signed apps. The differences are: (a) trust attestation, (b) named-role specifics (signed gets `pgserve_app_<publisher>`; not-signed gets generic `app_<fp>`), and (c) cross-DB grant capability (signed only).

### 2.4 Trust list (cosign tier)

- **Hardcoded automagik-dev**: compiled into `pgserve` binary. Identities accepted by default: `https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v*`, `https://github.com/automagik/omni/.github/workflows/release.yml@refs/tags/v*`, `https://github.com/automagik/pgserve/.github/workflows/release.yml@refs/tags/v*`. Updates to this list propagate via `pgserve update`.
- **User self-sign**: `pgserve trust add --identity <issuer> --key <pubkey>` writes to `~/.pgserve/trust/identities.json`. HTTPS-self-signed analog: works locally for the operator, doesn't grant trust globally.
- **Verification cadence**: HMAC-signed cache token at `$XDG_STATE_HOME/pgserve/verified/<fingerprint>.token` (web-session-style). Sliding expiry (1h idle, 7d max). Re-verify on binary mtime change. Steady-state connections pay 0ms; updates pay re-verify.

### 2.5 No revocation infra v1

Rationale: building a revocation pipeline (Rekor consultation, revoked.json sync, sigstore policy plugins) is overengineering for a local-DB use case where bad versions reach operators via `pgserve update` itself. The release pipeline IS the revocation channel:

1. Bad version published (CVE, accidental data deletion, key compromise).
2. Namastex publishes new release with the bad version added to the **hardcoded blocklist** in the new `pgserve` binary's compile-time constants.
3. Operators get the fix via `pgserve update` — which now refuses the bad version.

Trade: hosts that don't update for weeks remain vulnerable. Acceptable: cosign tier = official apps published controllably; if a host doesn't update, the operator has bigger problems than one bad genie release.

### 2.6 No offline / TUF embedding v1

Rationale: cosign keyless OIDC verification needs network for sigstore TUF roots + Rekor inclusion. But: genie/omni install ALREADY needs network to download the binary from the CDN. If the host can hit `cdn.automagik.dev`, it can hit `sigstore.dev`. Air-gap is not the target deployment for v1.

Escape hatch: `pgserve trust add --offline-cosign-key <pubkey>` lets an operator pre-trust a static cosign key and run `pgserve verify --skip-sigstore` for fully air-gapped boxes. Not the default; not the marketing.

### 2.7 Failure modes (Gatekeeper model)

| Scenario | Behavior |
|----------|----------|
| App without `pgserve` block in `package.json` | RUN with warning banner; not-signed tier; persistent project DB; isolated role |
| App with `package.json` `pgserve.identity_chain: ["cosign_signed", ...]`, ALL chain entries fail verify | **REFUSE** with diagnostic. App declared a tier and didn't deliver — that's tampering, not dev. |
| App with `identity_chain` and at least one entry verifies | RUN at highest verified tier, silent |
| Operator emergency override | `--unsafe-unverified <INCIDENT_ID>` typed-ack (existing pattern from `genie-supply-chain-signing`, helper `src/sec/unsafe-verify.ts`) |
| Light dev-mode silence | `--accept-unsigned-dev` flag silences the warning banner for one invocation (no typed-ack required) |

### 2.8 `package.json` opt-in shape

```jsonc
{
  "pgserve": {
    "publisher": "@automagik/genie",
    "identity_chain": [
      { "kind": "cosign_signed", "issuer": "https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v*" },
      { "kind": "self_signed", "trust_root": "$HOME/.pgserve/trust/" }
    ],
    "on_chain_exhausted": "refuse"
  }
}
```

App declares ordered chain; pgserve tries each in order; falls back to next on miss; refuses if all fail. Apps with no `pgserve` block default to path/not-signed tier.

---

## 3. Self-healing `<cli> update` contract

Every `<cli> update` (pgserve, genie, omni) — after this wish ships — converges drift to known-good state. The contract:

### 3.1 Update pipeline (locked across all three CLIs)

```
1. resolveChannel(opts, config)             — already shipped (update-unify-stages)
2. checkLatestVersion(channel)              — already shipped
3. shortCircuitIfCurrent(...)               — already shipped
4. preInstallPeerCheck(requirements)        — NEW: query peers' --version, refuse if upgrade would break
5. confirmIfTTY(--yes)                      — already shipped
6. confirmIfActiveTasks(genie ls --active)  — NEW: warn about in-flight work that pm2 restart will kill
7. installBinary(channel)                   — already shipped
8. runMigrations()                          — NEW: pg-side schema migrations + filesystem cleanup migrations (idempotent)
9. pm2RestartSelfWithUpdateEnv()            — NEW: pm2 jlist → restart own pm2 entries with --update-env
10. postRestartVerifyProbe()                — already shipped (verifyProbe + decideVerify)
11. doctorFix(tiered: cat 1 + cat 2 prompts) — NEW: replaces the JSON dry-run-only post-update maintenance
12. captureDiagnostics()                    — already shipped
13. successBanner() OR refuseWithRemediation()
```

Steps marked NEW are what this wish adds.

### 3.2 `<cli> doctor` tiered modes

| Mode | Mutations | Prompts | Use case |
|------|-----------|---------|----------|
| `<cli> doctor` (default) | none — check only | n/a | Operator-initiated audit, exits non-zero on issues with remediation |
| `<cli> doctor --fix` | auto-mutate **category 1** (safe), prompt **category 2** (data-touching) | one prompt per category-2 mutation | Default invocation by `<cli> update` step 11 |
| `<cli> doctor --fix --aggressive` | auto-mutate cat 1 + cat 2, refuse cat 3 (irreversible-destructive) | none | CI / automation / explicit operator opt-in |

**Mutation categories** (boundary rule):

> **Cat 1 = reversible within 1 command** (e.g. pm2 restart can be re-run). **Cat 2 = data-touching but recoverable** (archives preserved in `.legacy/`, .bak backups, prompts before mutation). **Cat 3 = irreversible / destructive** (DROP DATABASE on populated, role privilege escalation). Refuses without `--unsafe-unverified <INCIDENT_ID>` typed-ack.

| Category | Examples | Authority |
|----------|----------|-----------|
| **Cat 1 (auto-mutate)** | pm2 restart, pm2 env update, config file rewrite (with .bak), forward-only schema migrations, install canonical socket symlink, refresh `pg_hba.conf` / `pg_ident.conf` | No prompt; audit-log entry per mutation |
| **Cat 2 (prompt)** | Archive legacy data dirs (`~/.genie/data/pgserve` → `.legacy/pgserve-<ts>/`), drop dangling DBs over a size threshold, role permission changes | One prompt per mutation; `--yes` skips |
| **Cat 3 (refuse)** | DROP DATABASE with content > 1MB, role privilege escalation, irreversible destructive | Refuse with `--unsafe-unverified <INCIDENT_ID>` typed-ack as override |

### 3.3 Cross-CLI dependency enforcement

- **Compile-time `requirements` manifest**: each binary has `<cli> --requirements --json` returning `{ pgserve: ">=2.3", omni: ">=2.5" }` etc.
- **Pre-install check** (step 4 above): `<cli> update` queries `<peer> --version` for each declared peer; if upgrade would create incompatibility, refuses with remediation message: "genie 5.0 requires pgserve ≥3.0, you have 2.2.4. Run `pgserve update` first, then re-run `genie update`."
- **Runtime check**: `<cli> serve` boot revalidates peer versions; refuses with same remediation if peer was downgraded or rolled back post-update. Reuses the canonical-cutover hard-error pattern.
- **Override**: `<cli> update --ignore-peer-mismatch` typed-ack `I_ACKNOWLEDGE_PEER_MISMATCH` for debug/exotic flows.
- **No orchestrator binary**: no `automagik update --all`. 3 sequential CLIs is fine; error messages guide ordering.
- **Operator update order (locked)**: `pgserve update` → `genie update` → `omni update`. pgserve is the foundation; consumers come after. Each `<cli> update`'s pre-install peer check enforces this — if you run them out of order, the second one refuses with explicit remediation.

### 3.4 Rollback (manual)

If `<cli> update` step 10 (verify) fails:
- Exit non-zero with remediation that points to existing `<cli> self-update --rollback` (per `genie-self-update` wish).
- Do NOT auto-revert the binary. Forward-only schema migrations stay applied; partial-update state is operator's call to resolve.
- Audit log captures the failure point with full diagnostics.

### 3.5 Drain (no drain)

`<cli> update` step 9 (`pm2 restart`) kills in-flight work. Auto-resume infra (worker rows, scheduler lease-recovery, mailbox retry) handles recovery. Step 6 (`confirmIfActiveTasks`) warns operator before kicking restart: "12 active tasks will be interrupted; --yes to proceed".

---

## 4. Roles & GRANTs (SQL preview)

```sql
-- For NOT SIGNED apps (default fallback when no signature/handshake/cosign)
CREATE ROLE app_<fp> NOLOGIN NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
ALTER DATABASE app_<fp>_db OWNER TO app_<fp>;
GRANT ALL PRIVILEGES ON DATABASE app_<fp>_db TO app_<fp>;
GRANT USAGE ON FUNCTION install_whitelisted_extension(text) TO app_<fp>;
-- nothing cross-DB. peer auth via pg_hba+ident.

-- For SIGNED apps (host_signed, self_signed, OR cosign_signed)
-- Same as above, plus:
ALTER ROLE app_<fp> SET application_name TO 'signed:<identity_kind>:<publisher>';
-- Visible in pg_stat_activity for ops debugging.

-- For COSIGN_SIGNED with publisher in hardcoded official list:
CREATE ROLE pgserve_app_<sanitize(name)> NOLOGIN NOCREATEROLE INHERIT;
GRANT app_<fp> TO pgserve_app_<sanitize(name)>;  -- inherits per-fingerprint role
-- Allows `pgserve grant <from-publisher> <to-publisher> SELECT ON <table>` for explicit cross-DB grants.
```

`pg_hba.conf` peer auth on Unix socket maps OS user → role via `pg_ident.conf`:
```
# pg_ident.conf (auto-generated by `pgserve provision`)
pgserve_uid_to_role  <uid>   app_<resolved_fp>
```

---

## 5. Repository scope

### 5.1 `automagik/pgserve` (the big one, breaking-major v2.3)

**Delete:**
- Bun proxy from data plane: the libpq protocol routing layer, the always-on daemon listening on TCP 8432, the SO_PEERCRED-based startup-message rewriting, the in-memory connection routing.
- `pgserve.persist: true` package.json flag (persistence is universal now).
- Script-fallback fingerprint (`cmdline[1]`-based). Only path-based fingerprint (sha256(uid ‖ realpath(package.json or cwd))).
- Ephemeral TTL 24h logic.

**Add:**
- `pgserve provision <fingerprint>` CLI verb (idempotent, `pg_advisory_lock`-deduped).
- `pgserve verify <binary-path>` CLI verb (cosign + HMAC-signed cache token).
- `pgserve trust add/list/remove` CLI verbs.
- `pgserve gc` CLI verb (replaces in-daemon GC sweep).
- `pgserve doctor` / `--fix` / `--fix --aggressive` tiered modes.
- Hardcoded blocklist of known-bad versions (compile-time constant).
- Cosign keyless OIDC verification primitives (reuse `genie-supply-chain-signing` if shared lib emerges; else vendor the verifier).
- Postmaster boot args: `-k $XDG_RUNTIME_DIR/pgserve -p 5432 listen_addresses=localhost`.
- `pgserve install` wires postgres systemd user unit / launchd plist / pm2 entry pointing at postmaster directly (no bun bridge).
- `pgserve install` wires `pgserve gc` cron / systemd timer / launchd job.
- `pgserve install` enables `pgaudit` extension and ships logrotate config.
- Self-healing `pgserve update`: detects old proxy layout, stops bun bridge process, reconfigures postmaster args, updates pm2 entry, runs migrations, post-restart `pgserve doctor --fix`.
- Compile-time `--requirements` manifest output.

**Migration tooling for existing hosts** (one-shot, runs inside `pgserve update`):
- Detect: pm2 has `pgserve` entry running bun on 8432 (old layout).
- Action: stop bun process, reconfigure pm2 entry to launch postmaster directly with new args, update `~/.autopg/admin.json` to publish new socket dir, archive old socket dir to `.legacy/`.
- Rollback: not auto; manual via `pgserve install --restore-bridge` if needed (operator-decided).

### 5.2 `automagik-dev/genie`

**Add:**
- Active assertion in startup: if `node_modules/@automagik/genie/node_modules/pgserve/bin/` is present (legacy host with stale cache), warn loud + skip + emit `rot.vendored-pgserve.detected` audit event. Defensive against regression.
- Tier integration in `src/lib/db.ts` connection path: read package.json `pgserve` block, call `pgserve verify` CLI on first connect, present resulting tier identity to postgres via `application_name`.
- `genie update` step 8 (runMigrations): ensure all genie migrations (incl. cleanup of `~/.genie/data/pgserve` legacy data dir → `.legacy/`) run.
- `genie update` step 9 (pm2 restart): after binary install, run `pm2 restart genie-serve --update-env`. Honor `--no-pm2-restart` for environments without pm2.
- `genie update` step 11 (doctor --fix): wire the tiered `genie doctor --fix` invocation, default mode (cat 1 auto + cat 2 prompts).
- `genie doctor` extended with `--fix` and `--fix --aggressive` flags per the tiered model.
- Compile-time `requirements` manifest declaring `pgserve: ">=2.3"`. Pre-install check enforces.
- Pre-install confirm: query `genie ls --active --json` count; if >0, show warning ("N active tasks will be interrupted; --yes to proceed").
- Update `package.json` to declare `pgserve.identity_chain: [{ kind: "cosign_signed", issuer: "https://github.com/automagik-dev/genie/.github/workflows/release.yml@refs/tags/v*" }]`.
- `genie pgserve handshake` CLI command continues to work (existing from `pgserve-host-signed-identity`); now also exposes `genie pgserve verify` (alias for `pgserve verify` against the bundled binary path).

**Delete:**
- Any leftover dependency on TCP 8432 in db.ts connection-string defaults. Default to `host=$XDG_RUNTIME_DIR/pgserve port=5432` (Unix socket) with TCP-localhost fallback.

### 5.3 `automagik/omni`

**Add:**
- Same self-healing wiring as genie: pm2 restart self, doctor --fix tiered, requirements manifest, pre-install peer check.
- Tier integration in connection setup: `package.json` `pgserve.identity_chain` declared; `pgserve verify` invoked.
- `omni doctor --fix` tiered modes (cat 1+2 prompted, --aggressive opts in).
- Update default `DATABASE_URL` env construction to prefer Unix socket → `$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432`. TCP localhost:5432 fallback.

**Delete:**
- TCP 8432 dependence in `buildRuntimeEnv` and any hardcoded port references.
- Phase-2 canonical-pgserve preflight `checkCanonicalPgservePreflight` — it was a transitional guard for phase 2; phase 3 (this wish) makes the canonical socket the default.

---

## 6. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | pgserve **2.3** (not 3.0) | 3.0 reserved for post-npm-departure cutover (`distribution-exodus`). 2.3 captures architectural shift cleanly without conflating with the npm exit. |
| 2 | Daemon dies entirely; CLI on-demand for control plane | Council 3-of-4 (simplifier, operator, questioner) lean toward kill-the-daemon. Architect's load-bearing concern (provision rate >1/min steady state) doesn't apply: provisions are once-per-fingerprint-per-host-lifetime. |
| 3 | Postgres exposes BOTH Unix socket AND TCP 5432 natively | Unix socket = canonical fast path (no TCP overhead). TCP 5432 = compat with clients that can't do Unix sockets (some bun runtimes, k8s pod-to-pod, dev tools). Both native = zero proxy. |
| 4 | Binary classification signed-vs-unsigned (not 3 tiers) | Within "signed" sub-cases (host_signed, self_signed, cosign_signed) differ in role grants but not persistence/UX. Two-state mental model. |
| 5 | All apps get persistent project-scoped DB (no ephemeral) | Drops complexity (script-fallback fingerprint, TTL sweep, persist flag). Persistence is universal; tier decides only trust + role grants. |
| 6 | Hardcoded automagik trust list compiled into pgserve binary | Trust root is opaque to operators; updates flow via `pgserve update`. User self-sign via `pgserve trust add` for personal apps. |
| 7 | No active revocation infra v1 | Rekor consultation + revoked.json sync = overengineering. Bad versions blocked via hardcoded blocklist propagated through `pgserve update`. |
| 8 | No offline TUF v1; air-gap = `pgserve trust add --offline-cosign-key` escape | Sigstore.dev is reachable from any host that can reach our CDN. Air-gap is a niche; ship escape hatch, don't complicate the default. |
| 9 | Update step 9 (pm2 restart) without drain; auto-resume recovers in-flight tasks | Drain semantics = engineering effort with marginal payoff. Existing `auto-resume`, `lease-recovery`, mailbox-retry handle the recovery class. |
| 10 | Manual rollback (no auto-revert on verify failure) | Exit non-zero + remediation; operator decides. Forward-only schema migrations + `genie self-update --rollback` cover the backward path. |
| 11 | No orchestrator binary | 3 sequential `<cli> update` commands is fine. Error messages guide ordering. `automagik update --all` is YAGNI. |
| 12 | Independent implementations per repo, byte-identical SHARED-DESIGN.md only | Same pattern as `update-unify-stages`, `output-primitives-unified`. Coupling cost > duplication cost. |

---

## 7. Cross-wish dependencies

- **builds-on** `pgserve-canonical-cutover` (genie, merged) — consumer-only model is the foundation; this wish completes the remaining gap.
- **builds-on** `pgserve-host-signed-identity` (genie merged, pgserve pending) — this wish adds cosign as Tier 2 on top of the host_signed Tier 1.
- **builds-on** `update-unify-stages` (all merged) — pre-flight check, decideVerify, diagnostics JSON shape inherited; this wish extends with steps 4, 6, 8, 9, 11 of the pipeline.
- **builds-on** `genie-supply-chain-signing` — reuses `--unsafe-unverified <INCIDENT_ID>` typed-ack helper.
- **enables** `distribution-exodus` v3 cutover (post-npm) — clean separation of concerns means npm departure can be its own wish without entangling the proxy/socket cutover.

---

## 8. Breaking-change inventory

| Surface | Old behavior | New behavior | Affected |
|---------|--------------|--------------|----------|
| Connection target | `localhost:8432` (bun bridge) | `$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432` (Unix) or `localhost:5432` (TCP) | Every consumer; transition handled by self-healing `<cli> update` |
| pm2 entry `pgserve` | Tracks bun bridge process | Tracks postgres backend directly | Operators (transparent if they only `pgserve update`) |
| Bun daemon process | Always-on on every host | Deleted | Anyone querying the daemon's API directly (none known) |
| `pgserve_meta.identity_kind = 'script'` rows | Existed | Migrated to 'path' or archived | Existing pgserve installs |
| `pgserve.persist: true` package.json flag | Read by daemon for TTL override | Ignored; persistence is universal | Apps that set it (no-op) |

---

## 9. Definition of done

- [ ] All 3 PRs merged to their respective `dev` (or `main` for pgserve) branches.
- [ ] `pgserve@2.3.0` published to CDN with cosign signature.
- [ ] On a host with old layout (pm2 pgserve = bun bridge): single `pgserve update` reconfigures everything to new layout; `pgserve doctor` returns all-green; genie + omni + new test app all connect via `$XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432`; pm2 only has 1 pgserve entry tracking postgres directly.
- [ ] On a fresh host: `pgserve install` → `genie install` → `omni install` → all green, with `pg_isready -h $XDG_RUNTIME_DIR/pgserve` returning OK and `psql -h $XDG_RUNTIME_DIR/pgserve` connecting cleanly.
- [ ] Cosign verification: tampered binary at install fails verify with diagnostic; legitimate binary passes; cache token written and reused.
- [ ] Self-healing: dirty pm2 env (binary on disk newer than running process) → `<cli> update` detects + `pm2 restart --update-env` heals. After update, running process matches filesystem version.
- [ ] Cross-CLI deps: pre-install check refuses incompatible upgrade; runtime check refuses incompatible peer; `--ignore-peer-mismatch` typed-ack works.
- [ ] No regression: existing host_signed handshake (genie #1569 merged) continues to work; existing `--unsafe-unverified` ack contract honored.
- [ ] Audit trail: every `<cli> doctor --fix` mutation logs to diagnostics JSON; every blocked update logs reason; every verify failure logs identity expected vs received.

---

## 10. Out of scope

- Sigstore policy plugins, transparency-log consultation, revoked.json sync (revocation infra v1 = blocklist-via-update).
- Embedded TUF roots / offline-by-default verifier (escape hatch only).
- `automagik update --all` orchestrator binary.
- Cross-host pgserve federation (still single-host design per pgserve-v2).
- npm departure (`distribution-exodus`-owned; this wish is npm-agnostic but assumes CDN binary distribution exists).
- Drain-before-restart for in-flight tasks (auto-resume handles recovery).
- Aegis runtime sandboxing (separate umbrella).
- Migrating brain, rlmx, hapvida-eugenia, email consumer apps to use the new tier system (each app gets its own follow-up wish; this trio covers genie + omni only).
