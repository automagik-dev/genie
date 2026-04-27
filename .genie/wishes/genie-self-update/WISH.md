# Wish: Genie Self-Update — channel-aware, atomic, reversible

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-self-update` |
| **Date** | 2026-04-27 |
| **Author** | Felipe + Genie (security planning) |
| **Appetite** | medium (~2 weeks) |
| **Branch** | `wish/genie-self-update` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) |
| **Umbrella** | [aegis-distribution-sovereignty](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) (Wave 2, sub-project B) |

## Summary

Once `distribution-exodus` ships, every install lands a cosign-verified binary on disk — but operators still need a way to **stay** verified across releases. This wish ships `genie self-update`: a channel-aware (stable/beta/canary), cosign-and-SLSA-verified, atomically-replaceable binary updater with a binary-history rollback path. After this wish, the entire install lifecycle (acquisition → update → rollback) flows through verification pipes the genie team owns end-to-end, without depending on `npm update -g` or any package manager.

## Preconditions

- ✅ `genie-supply-chain-signing` shipped — cosign keyless OIDC + SLSA L3 + verify-install primitives reused.
- ✅ `distribution-exodus` shipped — CDN, manifest schema (v1), per-platform binaries, static portable verifiers (`sigstore-rs`, `slsa-verifier`), 4-channel cosign fingerprint pinning, `~/.genie/` directory layout, `genie install` subcommand all already exist when this wish starts.
- This wish reuses the manifest schema, verification stack, and CDN paths from `distribution-exodus` without modification — any change to those primitives is owned by sibling A, not this wish.

## Scope

### IN

**Self-update core (Group 1)**
- New top-level `genie self-update` subcommand registered in `src/genie.ts`.
- Default flow:
  1. Resolve current channel from `~/.genie/config.json` (default `stable`).
  2. Fetch `cdn.automagik.dev/genie/<channel>/latest/<platform>/manifest.json`.
  3. Compare manifest's `version` against running binary's `--version`. Exit 0 with "already on latest <version>" if equal.
  4. Download new binary + signatures + provenance to `~/.genie/downloads/<version>/` with size + checksum streaming validation.
  5. Verify SHA256 (always) + cosign signature (via static verifier from `distribution-exodus`) + SLSA L3 provenance. Refuse on any failure.
  6. Atomic replace: rename current binary at `~/.local/bin/genie` to `genie.old.<old-version>`; move verified new binary to `~/.local/bin/genie`; chmod +x.
  7. Verification post-replace: `genie sec verify-install` (from `genie-supply-chain-signing`) on the new binary. Failure rolls back to `genie.old.<old-version>` and exits non-zero.
  8. `exec` the new binary with `--post-update <from-version> <to-version>` so the new binary can run any one-shot migration tasks and print the upgrade summary.
- CDN failover: tries Cloudflare → Fastly → GitHub Releases on connect / HTTP-5xx (reuses install.sh failover pattern from sibling A).
- `INSECURE=1` SHA256-only opt-out path (matching install.sh contract; loud red banner; audit-logged).
- Concurrency lock: `~/.genie/state/self-update.lock` prevents two concurrent self-updates; stale lock (>10 min, dead PID) is force-removed with audit-log entry.

**Channels + rollback + version history (Group 2)**
- `--channel <stable|beta|canary>` flag. Operator-pinned channel persisted in `~/.genie/config.json` after first explicit `--channel` use.
- Each channel has a separate cosign signing identity from `genie-supply-chain-signing`. Self-update verifies against the channel's expected identity; signing-identity mismatch refuses (exit code 3, matching `genie sec verify-install` semantics).
- Channel switching: `genie self-update --channel beta` opts in. Subsequent updates pull from beta. `genie self-update --channel stable` switches back. Switch is audit-logged.
- `~/.genie/state/binary-history.json` schema (versioned, v1):
  ```json
  {
    "schema_version": 1,
    "current": { "version": "4.260427.5", "channel": "stable", "path": "~/.local/bin/genie", "installed_at": "..." },
    "history": [
      { "version": "...", "channel": "...", "path": "~/.genie/downloads/<version>/genie.old.<...>", "installed_at": "...", "verified": true },
      ...
    ]
  }
  ```
- Last 3 versions retained on disk; older versions evicted at next successful update with audit-log entry.
- `genie self-update --rollback` reverts to the previous version in history (verified at rollback time via cosign before activation). `--rollback --to <version>` targets a specific historical version.
- `genie self-update --list-history` prints the binary history.

**Audit log + safety + recovery (Group 3)**
- `~/.genie/audit/self-update.jsonl` append-only, mode 0600, fsync-per-event. Schema:
  ```json
  {
    "schema_version": 1,
    "event_type": "update.start | update.success | update.failure | rollback | channel.switch | insecure-bypass",
    "timestamp": "...",
    "from_version": "...",
    "to_version": "...",
    "channel": "...",
    "verification_result": { "sha256": "ok", "cosign": "ok | failed | skipped", "slsa": "ok | failed | skipped" },
    "elapsed_ms": ...,
    "exit_code": ...,
    "error_message": "..."
  }
  ```
- Mid-update interruption recovery: on every binary launch, check for orphaned `~/.genie/downloads/<version>/.in-progress` markers. If found and >24h old, audit-log + clean up. If <24h old, leave for explicit `--resume`.
- `genie self-update --resume` continues an interrupted update from the verified-binary stage (skips download if already complete).
- Pre-update sanity check: free disk space ≥3× new binary size (download + old binary kept + breathing room). Refuse with helpful message if insufficient.
- Cross-platform binary replacement:
  - Linux: atomic `rename(2)` works for in-use binaries (kernel keeps old inode for running processes).
  - macOS: same atomic `rename(2)` semantics; codesign-verified binaries do NOT need re-signing after rename (the cosign signature lives in the cert/sig artifacts, not embedded).
  - Windows: deferred to v2 (matches `distribution-exodus` platform matrix).
- Re-signing handoff: when self-update replaces the binary, the new binary's first-launch in `--post-update` mode runs `~/.local/share/zsh/site-functions/_genie` regeneration (via the `genie install` subcommand's idempotent code path) to refresh shell completions for new commands.
- `--dry-run` flag: prints what would be done without modifying disk.
- `--check` flag: returns exit 0 if no update available, 1 if update available, 2 if cannot determine. Useful for `cron` / `launchd` / shell-prompt integrations.

### OUT

- **Differential updates / zstd-bsdiff payloads** — defer to v2 follow-up. v1 always downloads the full binary. Bandwidth cost (~80 MB per update) is acceptable; mid-update integrity is simpler than diff-and-patch logic.
- **Auto-update on launch / cron / launchd integration** — operators must explicitly run `genie self-update`. Background auto-update is a separate UX wish; this wish ships the manual update verb.
- **Update notifications** — `genie --version` does NOT phone home to check for updates. Notification UX is a separate wish; respects the no-default-telemetry posture.
- **Native Windows update path** — deferred to v2 alongside Windows native distribution.
- **Update-channel signing key rotation logistics** — operational, owned by `genie-supply-chain-signing`'s key-rotation runbook.
- **Aegis daemon self-update** — owned by `aegis-runtime` wish. Aegis has its own update verb, not this one.
- **npm package update flow changes** — npm shim from `distribution-exodus` Group 5 still delegates to install.sh; this wish does not modify the npm path.
- **Anti-rollback enforcement** (refusing to rollback to a vulnerable version) — out of scope for v1. Operators have full control over rollback target. v2 may add a "deprecated version" flag in the manifest.
- **Multi-binary parallel updates** (e.g., updating both genie + aegis-daemon in one verb) — out. Each binary owns its own update verb.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `genie self-update` as a top-level subcommand, not `genie sec self-update` | Discoverability; mirrors `genie install` placement; operators expect update commands at top level (cf. `bun upgrade`, `rustup update`) |
| 2 | Atomic `rename(2)` for binary replacement (Linux + macOS) | Kernel-level atomicity; running processes keep old inode; no special downtime handling needed |
| 3 | Always-full-download (no diff/patch in v1) | Avoids the diff-and-patch attack surface; ~80 MB per update is acceptable; defer bsdiff to v2 if bandwidth becomes a real complaint |
| 4 | Channels = `stable / beta / canary` with separate cosign identities | Reuses sibling A's channel scheme; channel-pinned signing identity prevents cross-channel binary substitution |
| 5 | Binary history retains last 3 versions on disk | Bounded disk usage; covers the common rollback case (last release was bad) without unbounded growth |
| 6 | `~/.genie/state/binary-history.json` is the rollback source-of-truth (not git tags / npm) | Self-contained; works offline; survives npm sunset |
| 7 | `INSECURE=1` SHA256-only matches `install.sh` contract | Consistency between install + update flows; same audit-log discipline |
| 8 | Concurrency lock at `~/.genie/state/self-update.lock` | Prevents corruption from two simultaneous updates; stale-lock cleanup avoids permanent deadlock |
| 9 | Mid-update interruption is recoverable via `--resume` | Operators on flaky networks (CanisterWorm hostpiles run on shared wifi) shouldn't lose progress; `.in-progress` marker is the recovery anchor |
| 10 | Post-update `genie sec verify-install` self-check | Defense-in-depth; catches scenarios where verifier passed during download but binary corrupted during atomic move |
| 11 | `exec` (not spawn) the new binary with `--post-update` after replace | Replaces the running process atomically; old binary's PID becomes the new binary's PID; subsequent `genie` invocations use the new bits |
| 12 | `--check` flag for shell-prompt / cron integrations | Standard pattern (`apt-get -s upgrade`, `brew outdated`); operators can wire it into their own UI |
| 13 | No auto-update / no telemetry in v1 | Privacy posture; operators opt-in to running update; consistent with no-telemetry-by-default install flow |
| 14 | `--rollback` re-verifies signature before activating | Historical binary on disk could have been tampered with post-install; verify-at-rollback closes the gap |
| 15 | Audit-log schema versioned (v1) | Forward-compatible field discipline mirrors manifest.json; survive future schema additions |

## Success Criteria

- [ ] `genie self-update` on a clean install (channel: stable, no update available) exits 0 with "already on latest <version>" stderr message; no audit-log noise beyond a single `update.start` + `update.success` (no-op) entry.
- [ ] `genie self-update` on a clean install with an update available downloads, verifies (SHA256 + cosign + SLSA), atomically replaces, runs `--post-update`, and `genie --version` reflects the new version.
- [ ] Tamper test: byte-flip the published binary on the CDN; `genie self-update` refuses; exit code 4 (signature-mismatch from `genie sec verify-install` semantics); current binary unchanged.
- [ ] Atomic-replace test: kill `genie self-update` mid-rename (signal SIGKILL during step 6); on relaunch, current binary is either fully old or fully new — never a corrupted state. (Tested via stress harness in Group 1.)
- [ ] `genie self-update --rollback` reverts to the previous version; verifies signature against the historical binary's recorded cosign sig before activating.
- [ ] `genie self-update --rollback --to <version>` reverts to a specific historical version if present in `binary-history.json`; non-existent version exits non-zero with helpful message.
- [ ] `genie self-update --channel beta` switches channel; subsequent `genie self-update` pulls from beta directory; channel pin persisted in `~/.genie/config.json`; switch audit-logged.
- [ ] Cross-channel signing identity refusal: artificially serve a `stable`-signed binary on the `beta` channel path; `--channel beta` self-update refuses; exit code 3 (signer-identity-mismatch).
- [ ] `genie self-update --check` exits 0 if no update available, 1 if available, 2 if cannot determine. No state modification on `--check`.
- [ ] `genie self-update --dry-run` prints the planned operation without modifying disk; no entries written to audit log; no lock acquired.
- [ ] Concurrency lock: two `genie self-update` invocations in parallel — second waits or exits with helpful "another update in progress" (depending on `--wait` flag).
- [ ] Mid-update interruption: `--resume` after an interrupted download continues from the verified-binary stage; full retry from manifest if `.in-progress` marker is corrupt.
- [ ] Pre-update disk-space check: <3× new binary size free → refuse with helpful "free at least <X> MB; current free: <Y> MB" message.
- [ ] `INSECURE=1 genie self-update` produces a 5-line red warning to stderr; SHA256 verified; cosign + SLSA skipped; bypass logged with `event_type: insecure-bypass`.
- [ ] Audit log: every update attempt produces a single `update.start` + terminal `update.success` / `update.failure` / `update.aborted` event; bypass + rollback events distinguishable; jsonl is mode-0600 + fsync-per-event.
- [ ] Binary history bounded: 4 successive successful updates leave exactly 3 historical versions on disk; oldest version evicted automatically at update 4.

## Dependencies / Related Wishes

| Relationship | Wish | Reason |
|--------------|------|--------|
| depends-on | `genie-supply-chain-signing` (shipped) | Cosign + SLSA + verify-install primitives reused; channel-cosign-identity contract reused |
| depends-on | `distribution-exodus` | CDN + manifest schema + static portable verifiers + `~/.genie/` layout + `genie install` subcommand are prerequisites |
| umbrella | `aegis-distribution-sovereignty` | Sibling B (Wave 2) of the umbrella |
| related | `aegis-runtime` | Sibling C runs in parallel; both consume sibling A's CDN + verification stack |
| related | `sec-incident-runbook` (shipped) | Runbook references `genie self-update --rollback` as a recovery action when a published version is implicated in an incident |

## Execution Strategy

### Wave 1 — Self-update core (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | `genie self-update` subcommand: manifest fetch, cosign + SLSA verification, atomic replace, exec handoff, concurrency lock, CDN failover. |

### Wave 2 — Channels + rollback (sequential after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | `--channel` flag + binary-history.json + `--rollback` + `--list-history` + channel-cosign-identity verification. |

### Wave 3 — Audit log + recovery + edge cases (sequential after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Audit log schema + `--resume` + `--check` + `--dry-run` + disk-space check + INSECURE=1 + interruption recovery + cross-platform replacement validation. |

## Execution Groups

### Group 1: Self-update core

**Goal:** `genie self-update` performs a single end-to-end update cycle on the default `stable` channel — manifest fetch, verify, atomic replace, exec — with concurrency locking and CDN failover.

**Deliverables:**
1. `src/term-commands/self-update.ts` (new): `genie self-update` subcommand registered in `src/genie.ts`. Flags accepted in this group: none beyond default behavior + `--dry-run` stub (full logic in Group 3).
2. `src/lib/self-update/manifest.ts` (new): manifest fetcher with multi-CDN failover (Cloudflare → Fastly → GitHub Releases). Returns parsed manifest or throws structured error.
3. `src/lib/self-update/verify.ts` (new): chains SHA256 (always) + cosign + SLSA verification by shelling out to the static portable verifiers from `distribution-exodus` Group 3. Returns structured result with per-step status.
4. `src/lib/self-update/atomic-replace.ts` (new): atomic-replace logic with rename-old → move-new → chmod → post-replace verify-install. On any failure, restores `genie.old.<version>` to canonical path. Cross-platform tested for Linux + macOS.
5. `src/lib/self-update/lock.ts` (new): file lock at `~/.genie/state/self-update.lock` with PID + start time. Stale lock detection (>10 min + dead PID) force-removes with audit-log marker.
6. `src/lib/self-update/exec-handoff.ts` (new): exec's the new binary with `argv[0]=genie`, `argv[1]=--post-update`, `argv[2]=<from-version>`, `argv[3]=<to-version>`. New binary's `--post-update` handler regenerates shell completions and prints upgrade summary.
7. Tests: `src/term-commands/self-update.test.ts` covers happy path on tmpdir-mocked CDN + `~/.genie/`, tamper rejection, network-failure rollback, concurrency-lock contention, atomic-replace stress (kill mid-rename) — last one as a separate `scripts/stress-test-self-update.sh` since bun:test doesn't easily kill subprocesses mid-syscall.

**Acceptance Criteria:**
- [ ] `genie self-update` on a tmpdir-mocked CDN with a newer manifest version downloads + verifies + replaces + exec's the new binary.
- [ ] Tamper test (byte-flip mocked CDN binary) refuses with exit code 4.
- [ ] Atomic-replace test: kill SIGKILL during the rename window; on relaunch, current binary is either fully old or fully new (never half-written).
- [ ] Concurrency-lock test: two `self-update` invocations — second exits with `"another update in progress (PID <pid>)"` and exit code 11.
- [ ] CDN failover: simulated Cloudflare 503 → Fastly serves; simulated Fastly 503 → GitHub Releases serves; all three verify identically.
- [ ] `--post-update` handoff: new binary receives `from-version` + `to-version` in argv; prints upgrade summary; regenerates shell completions idempotently.
- [ ] Post-replace `genie sec verify-install` self-check: corrupted-after-rename binary triggers rollback to `genie.old.<old-version>`; current binary restored.

**Validation:**
```bash
bun test src/term-commands/self-update.test.ts
bun test src/lib/self-update/
bash scripts/stress-test-self-update.sh
```

**depends-on:** none (cross-wish dependency on `distribution-exodus` documented in Dependencies table)

---

### Group 2: Channels + rollback + binary history

**Goal:** Operators can switch channels, view history, and roll back to any retained version with re-verified signatures.

**Deliverables:**
1. `src/term-commands/self-update.ts` extension: `--channel <stable|beta|canary>`, `--rollback`, `--rollback --to <version>`, `--list-history` flags wired up.
2. `src/lib/self-update/binary-history.ts` (new): reads + writes `~/.genie/state/binary-history.json` with schema v1 validation. Eviction at 3-version cap with audit-log entry.
3. `src/lib/self-update/channel.ts` (new): channel resolution (CLI flag → env var → config.json → default `stable`). Channel pin persistence in `~/.genie/config.json`.
4. `src/lib/self-update/channel-identity.ts` (new): per-channel expected cosign signing identity table; verification step that refuses cross-channel binary substitution.
5. Schema: `~/.genie/schemas/binary-history-v1.schema.json` (new), JSON-Schema-validated on every read/write.
6. Tests:
   - `src/lib/self-update/binary-history.test.ts` — eviction, rollback, missing-version handling, schema-violation refusal.
   - `src/lib/self-update/channel.test.ts` — resolution priority, pin persistence, switch-back behavior.
   - `src/lib/self-update/channel-identity.test.ts` — cross-channel binary rejection (artificially serve stable-signed binary on beta path).

**Acceptance Criteria:**
- [ ] `genie self-update --channel beta` pulls from `cdn.automagik.dev/genie/beta/...`; channel pin written to `~/.genie/config.json`; switch audit-logged.
- [ ] `genie self-update --rollback` reverts to the previous version's binary on disk; signature re-verified at rollback time.
- [ ] `genie self-update --rollback --to <version>` reverts to a specific historical version; non-existent version exits non-zero.
- [ ] `genie self-update --list-history` prints a JSON array of (version, channel, installed_at, verified) for each historical entry.
- [ ] After 4 successive successful updates, exactly 3 historical versions remain on disk; oldest evicted with audit-log entry.
- [ ] Cross-channel binary substitution: artificially serve stable-signed binary on the beta channel path; `--channel beta` self-update refuses with exit code 3 (signer-identity-mismatch).
- [ ] Schema violation: corrupt `binary-history.json` (invalid JSON or schema-non-conformant) → self-update refuses to proceed; suggests `genie self-update --reset-history` (manual recovery).

**Validation:**
```bash
bun test src/lib/self-update/binary-history.test.ts
bun test src/lib/self-update/channel.test.ts
bun test src/lib/self-update/channel-identity.test.ts
genie self-update --channel beta --dry-run
genie self-update --list-history --json | jq '.entries | length'
```

**depends-on:** Group 1

---

### Group 3: Audit log + recovery + edge cases

**Goal:** Self-update is observable, recoverable, and operator-friendly across the full envelope of edge cases (interrupt, low disk, INSECURE=1, dry-run, --check).

**Deliverables:**
1. `src/lib/self-update/audit-log.ts` (new): append-only, mode-0600, fsync-per-event jsonl writer with schema v1. Entry types: `update.start`, `update.success`, `update.failure`, `update.aborted`, `rollback`, `channel.switch`, `insecure-bypass`, `lock.stale-cleanup`.
2. `--resume` flag implementation in `src/term-commands/self-update.ts`: detects `~/.genie/downloads/<version>/.in-progress` markers, validates partial download, resumes from verified-binary stage if download complete, full retry otherwise.
3. `--check` flag implementation: exit 0 if no update, 1 if available, 2 if cannot determine. JSON output via `--check --json`.
4. `--dry-run` full implementation: prints planned operation; touches no files; acquires no lock; no audit log.
5. `INSECURE=1` env-var path: 5-line red warning to stderr; SHA256 verified; cosign + SLSA skipped; `insecure-bypass` audit event with cosign-fingerprint-of-record + reason field (env var only — CLI flag rejected to prevent CI accidents).
6. Pre-update disk-space check: `src/lib/self-update/preflight.ts` (new). Refuses if <3× new binary size free. Helpful error names current free + required.
7. Cross-platform binary-replacement validation:
   - Linux integration test: `scripts/integration/self-update-linux.sh` runs in Docker against an actual CDN fixture.
   - macOS integration test: `scripts/integration/self-update-macos.sh` runs locally; CI-skip annotation honored.
   - Windows test: `scripts/integration/self-update-windows.sh` exits with helpful "v2 deferred" message.
8. Schema: `~/.genie/schemas/self-update-audit-v1.schema.json` (new), JSON-Schema-validated on every audit log append (defense-in-depth for forensic tools).
9. Tests:
   - `src/lib/self-update/audit-log.test.ts` — schema validation, fsync ordering, mode-0600 verification.
   - `src/lib/self-update/resume.test.ts` — interrupt-and-resume paths.
   - `src/lib/self-update/preflight.test.ts` — disk-space refusal.
   - `src/term-commands/self-update.test.ts` extension — `--check`, `--dry-run`, `--insecure` env var paths.

**Acceptance Criteria:**
- [ ] Every successful update produces exactly 2 audit-log events (`update.start` + `update.success`); failures produce `update.failure`; rollbacks produce `rollback`.
- [ ] Audit log file mode is 0600 (verified via `stat -c %a`); fsync-per-event verified by interleaved-write stress test.
- [ ] `genie self-update --check` exits 0 (no update) / 1 (update available) / 2 (cannot determine — e.g., CDN unreachable).
- [ ] `genie self-update --dry-run` prints planned operation; no audit log entries; no lock file; no disk modification (verified via inotify watch in test).
- [ ] `INSECURE=1 genie self-update` shows 5-line red banner to stderr; cosign + SLSA skipped; SHA256 verified; `insecure-bypass` audit event recorded with cosign-fingerprint-of-record.
- [ ] `genie self-update --insecure` (CLI flag) is REJECTED with helpful "use INSECURE=1 env var" message — env var is the only opt-out to prevent accidental CI flag usage.
- [ ] Disk-space refusal: artificially constrain to 1.5× new binary size; self-update refuses with exact bytes-free + bytes-required message.
- [ ] Mid-update interrupt + `--resume`: kill SIGTERM during download (after partial bytes received); `--resume` continues from verified-binary stage if download complete, full retry otherwise.
- [ ] Linux Docker integration test: full lifecycle (install via `install.sh` → self-update to next version → rollback → re-update) green.
- [ ] macOS integration test (when run locally): same lifecycle green.
- [ ] Audit log schema: malformed event rejected before write; corrupt log on read produces structured error pointing to the bad line.

**Validation:**
```bash
bun test src/lib/self-update/audit-log.test.ts
bun test src/lib/self-update/resume.test.ts
bun test src/lib/self-update/preflight.test.ts
bun test src/term-commands/self-update.test.ts
bash scripts/integration/self-update-linux.sh
INSECURE=1 genie self-update --dry-run 2>&1 | grep -E '⚠.*cosign'
genie self-update --check; echo "exit=$?"
stat -c '%a' ~/.genie/audit/self-update.jsonl
```

**depends-on:** Group 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] End-to-end: install via `install.sh` → `genie self-update` → `genie --version` reflects the new version → `genie self-update --rollback` reverts. Linux + macOS.
- [ ] Tamper detection: byte-flip published binary on canary CDN; `genie self-update --channel canary` refuses; exit code 4.
- [ ] Channel switch + back: stable → beta → canary → stable; `genie --version` correct after each; pins persist; audit log contains 3 `channel.switch` events.
- [ ] Cross-channel binary substitution: serve stable-signed binary on beta path; refused with exit code 3.
- [ ] Atomic-replace stress: 100 iterations of kill-during-rename; current binary always fully old or fully new — never corrupt.
- [ ] Concurrency-lock: 10 parallel `self-update` invocations; only one acquires lock; others exit cleanly with code 11.
- [ ] Mid-update interrupt + `--resume`: 10 iterations of kill-during-download; `--resume` recovers cleanly each time.
- [ ] Disk-space refusal: constrained-FS test refuses with helpful message; no partial state on disk.
- [ ] INSECURE=1 audit: bypass logged with timestamp + cosign-fingerprint-of-record; cannot be silenced.
- [ ] Audit-log integrity: 1000 successive update events; jsonl remains valid; mode-0600 preserved; no fsync gaps under power-loss simulation.
- [ ] Binary history bounded at 3 across 100 updates; total disk usage <250 MB.
- [ ] `bun run check` (typecheck + lint + dead-code + skills:lint + wishes:lint + lint:emit + tests) passes on the wish branch.
- [ ] `genie sec verify-install` returns VERIFIED on a binary acquired via self-update — confirms cross-wish contract preserved.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Atomic `rename(2)` semantics differ across Linux filesystems (ext4, btrfs, zfs, tmpfs) | High | Group 1 stress test runs on each filesystem in CI; if any fails, Group 1 BLOCKED until fix; documented in `docs/security/self-update.md` |
| Self-updater compromised = entire binary lifecycle compromised | High | Highest review bar; per-channel signing identities; verify-before-AND-after replace; rollback re-verifies; audit log integrity |
| Mid-update interrupt corrupts `binary-history.json` | High | Atomic write via temp-file rename; schema validation on read; `--reset-history` recovery path documented |
| Channel-pinned signing identity gets rotated and operators on stale config refuse all updates | High | Channel identity is the *primary* expected identity; rotation runbook (in `genie-supply-chain-signing`) documents grace-period dual-identity acceptance; refusal exit code 3 with helpful "rotate via SECURITY.md" message |
| CDN partial-failure (manifest served, binary 404) | Medium | Manifest schema v1 includes `binary_url`; install.sh / self-update both retry on 404 with multi-CDN failover; `update.failure` audit event captures failed URL |
| Operator on a forked / development build runs `genie self-update` | Medium | Self-update warns if `genie --version` does not match a known channel manifest; refuses unless `--force` (audit-logged); preserves dev-mode safety |
| `exec` handoff fails (kernel ENOEXEC, denied permission) | Medium | Failure rolls back to `genie.old.<old-version>`; user can re-launch manually; audit event `update.failure` with kernel error code |
| Signature verification static binary itself is compromised | Medium | Static verifiers signed by same cosign-keyless OIDC; SHA256 of verifiers inlined in self-update.ts (compile-time constant); mismatch refuses verification step (defense-in-depth even when verifier is stale) |
| Concurrent updates from `genie self-update` + `genie install --reinstall` | Medium | Both acquire the same lock; second waits or exits cleanly |
| INSECURE=1 misuse in CI accidentally bypasses cosign | Low | Env var only (no CLI flag); 5-line red banner to stderr; `insecure-bypass` audit event with cosign-fingerprint-of-record makes misuse traceable; documentation discourages |
| Binary history grows unbounded due to schema bug | Low | 3-version eviction enforced at every successful update; integration test asserts cap; audit log records every eviction |
| `--rollback --to <very-old-version>` activates a version that lacks `--post-update` argv handler | Low | Backward-compatible argv: old binaries silently ignore unknown flags; rollback's worst case is a missed completion regen, which `genie install` re-runs idempotently |
| Self-update consumes too much disk during retention | Low | 3-version × ~80 MB = ~240 MB ceiling; preflight check warns; `--prune-history` flag (deferred to v2) |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Top-level command
src/term-commands/self-update.ts                      create — `genie self-update` subcommand
src/term-commands/self-update.test.ts                 create — full subcommand test matrix
src/genie.ts                                          modify — register `self-update` subcommand

# Self-update library
src/lib/self-update/manifest.ts                       create — manifest fetcher with CDN failover
src/lib/self-update/verify.ts                         create — chained verification (SHA256 + cosign + SLSA)
src/lib/self-update/atomic-replace.ts                 create — atomic rename + post-replace verify
src/lib/self-update/atomic-replace.test.ts            create — stress + cross-fs tests
src/lib/self-update/lock.ts                           create — concurrency lock with stale detection
src/lib/self-update/lock.test.ts                      create — contention + stale-cleanup tests
src/lib/self-update/exec-handoff.ts                   create — exec the new binary with --post-update
src/lib/self-update/binary-history.ts                 create — history file management with eviction
src/lib/self-update/binary-history.test.ts            create — schema + eviction tests
src/lib/self-update/channel.ts                        create — channel resolution + pin persistence
src/lib/self-update/channel.test.ts                   create — channel priority tests
src/lib/self-update/channel-identity.ts               create — per-channel signing-identity verification
src/lib/self-update/channel-identity.test.ts          create — cross-channel substitution refusal tests
src/lib/self-update/audit-log.ts                      create — append-only jsonl writer with schema v1
src/lib/self-update/audit-log.test.ts                 create — schema + fsync + mode tests
src/lib/self-update/resume.ts                         create — `--resume` recovery from interrupted updates
src/lib/self-update/resume.test.ts                    create — interrupt-and-resume tests
src/lib/self-update/preflight.ts                      create — disk-space check + sanity gates
src/lib/self-update/preflight.test.ts                 create — disk-space refusal tests

# Schemas
.genie/schemas/binary-history-v1.schema.json          create — JSON schema for binary-history.json
.genie/schemas/self-update-audit-v1.schema.json       create — JSON schema for self-update.jsonl events

# Integration + stress
scripts/stress-test-self-update.sh                    create — kill-during-rename stress harness
scripts/integration/self-update-linux.sh              create — Docker-based end-to-end test
scripts/integration/self-update-macos.sh              create — local macOS end-to-end test
scripts/integration/self-update-windows.sh            create — "v2 deferred" notice script

# Documentation
docs/security/self-update.md                          create — threat model, atomic-replace semantics, rollback flow
SECURITY.md                                           modify — link to self-update docs + rollback as incident-response action
```
