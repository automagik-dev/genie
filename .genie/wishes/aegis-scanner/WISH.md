# Wish: Aegis Scanner — continuous workspace scanning + IOC auto-update

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `aegis-scanner` |
| **Date** | 2026-04-27 |
| **Author** | Felipe + Genie (security planning) |
| **Appetite** | medium (~2 weeks) |
| **Branch** | `wish/aegis-scanner` |
| **Repos touched** | `automagik-dev/aegis`, `automagik-dev/genie` (integration only) |
| **Design** | [DESIGN.md](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) |
| **Umbrella** | [aegis-distribution-sovereignty](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) (Wave 3, sub-project D) |

## Summary

Today `genie sec scan` is a one-shot, operator-invoked command. Threat intel updates depend on operators remembering to run `genie sec signatures update`, and detection only happens when something prompts the operator to scan. This wish ships the **continuous-protection** layer: a scanner module inside the `aegis-daemon` (sibling C) that combines scheduled deep scans (default every 6h), FS-watch incremental scans (fanotify/FSEvents) on every file write, and hourly cosign-verified signature pack pulls from `@automagik/genie-signatures`. On critical IOC hits, the daemon pauses the active genie agent process, emits a desktop notification, and writes a typed-ack quarantine prompt that feeds straight into the existing `genie sec fix` UX from `sec-fix-one-shot`. After this wish, genie operators have the equivalent of an always-on AV — without giving up control to a third-party EDR.

## Preconditions

- ✅ `genie-supply-chain-signing` shipped — cosign keyless OIDC reused for signature pack verification.
- ✅ `sec-scan-progress` shipped — `scripts/sec-scan.cjs` produces versioned envelopes + audit log entries that this wish consumes unchanged.
- ✅ `sec-signature-registry` shipped — `@automagik/genie-signatures` repo + cosign-verified pack pulling already exist; this wish triggers those pulls on a schedule from inside aegis-daemon.
- ✅ `sec-fix-one-shot` shipped — the typed-ack quarantine prompt → `genie sec fix --apply` UX already exists; this wish feeds that machinery from a new producer.
- ✅ `aegis-runtime` (sibling C) shipped — daemon scaffolding, IPC, CLI mission control, `aegis approve` surface, audit log conventions, all already exist when this wish starts.

## Scope

### IN

**Scanner module integration (Group 1)**
- New crate `aegis-scanner` inside the `automagik-dev/aegis` workspace.
- Integration tactic: `aegis-scanner` shells out to `genie sec scan --progress-json --persist --redact` (the existing CJS scanner) and ingests the structured envelope. **No Rust port of `sec-scan.cjs`** — the existing 127KB CJS is battle-tested and signature-pack-aware; duplicating it in Rust doubles maintenance for negligible latency gain. Aegis owns *orchestration*, not *detection*.
- Scheduled deep scan loop: tokio interval task, default 6h, configurable via `~/.genie/aegis/scanner-policy.yaml`. Fields: `deep_scan_interval_seconds`, `roots`, `signature_filter` (subset of loaded packs to apply), `redact_in_audit` (default true), `max_concurrent_scans` (default 1).
- Audit log: scan envelope appended to existing `~/.genie/sec-scan/audit/<scan_id>.jsonl` (no new format). Aegis adds its own metadata via a top-level field `triggered_by: aegis_scheduled | aegis_fswatch | aegis_manual` so the existing forensic tooling can distinguish manual vs. continuous scans.
- IPC: new JSON-RPC methods on aegis-daemon `scanner.status`, `scanner.trigger`, `scanner.history`, `scanner.cancel`. Surface mirrored on `aegis` CLI as `aegis scanner status|trigger|history|cancel`.
- Concurrency: scanner uses a separate worker pool from the proxy; max 1 concurrent deep scan + max N concurrent FS-watch incrementals (default N=4). Backpressure: incremental scans dropped (with audit event) if the queue exceeds 100 pending items.

**FS watcher + incremental scan (Group 2)**
- New crate `aegis-fswatch` inside the workspace.
- Linux: fanotify via `fanotify-rs` crate (or `inotify-rs` fallback if fanotify is too privileged on operator's distro). Watch in `FAN_MARK_ADD | FAN_CLOSE_WRITE | FAN_MOVED_TO` event-mask mode.
- macOS: FSEvents via `fsevent-rs` crate. Watch in `kFSEventStreamCreateFlagFileEvents` mode.
- Windows: deferred to v2 (mirrors `aegis-runtime` Windows-deferred decision).
- Watch root list (operator-editable in `scanner-policy.yaml`):
  - Workspace: current `$PWD` and configured workspaces from `~/.genie/config.json`.
  - Global install: `~/.local/bin/`, `~/.bun/install/global/`, `~/.npm/_npx/`.
  - npm cache: `~/.npm/_cacache/`.
  - Browser profiles (READ-ONLY snapshot, no write events): Chrome / Brave / Edge / Chromium profile dirs (paths platform-specific; sourced from `genie sec scan` existing detection).
- Debounce + batch: 500ms window per path; dedupe duplicate writes; coalesce burst writes (e.g., `npm install` writing 10k files) into a single batched scan over the affected directory.
- Incremental scan: re-runs `genie sec scan --root <changed-path> --signatures <relevant-packs> --json` with progress disabled; merge findings into in-memory current state.
- Skip rules: `.git/`, `node_modules/.cache/`, `.next/`, `dist/`, common build dirs (operator-editable in `scanner-policy.yaml`).
- Resource cap: FS watcher uses ≤2% CPU on idle developer host (verified via `pidstat` integration test).

**Signature pack auto-updater (Group 3)**
- New crate `aegis-signatures-poller` inside the workspace.
- Hourly tokio interval task (configurable: `signature_poll_interval_seconds`, default 3600).
- Pulls latest `@automagik/genie-signatures` via the existing `sec-signature-registry` infrastructure: `genie sec signatures update --json` shell-out (consistent with Group 1 integration tactic).
- Cosign verification: handled inside `genie sec signatures update` (already in `sec-signature-registry`); aegis records the structured result.
- Hot reload: on successful pack update, aegis invalidates the in-memory pack cache; next scan picks up new packs without daemon restart. In-flight scans grandfather under the prior pack set.
- Audit event `signatures.updated`: emitted to `~/.genie/aegis/audit/scanner.jsonl` with `from_version`, `to_version`, `packs_added`, `packs_removed`, `verified`, `elapsed_ms`.
- Failure handling: pack-update failure (network error, signature mismatch, corrupt pack) is logged but does NOT halt scanning; the previously verified pack set continues serving. After 6 consecutive failures, daemon emits a desktop notification suggesting operator intervention.
- Manual override: `aegis scanner update-signatures` triggers immediate pull (no wait for next interval).

**Critical-finding pipeline + sec-fix integration (Group 4)**
- Severity routing: every scan envelope from Group 1 carries `summary.signatures[]` aggregation (per `sec-signature-registry` schema). Aegis filters findings where any matched signature has `severity: critical`.
- Critical-finding actions (in order, per finding):
  1. Pause active genie agent process: aegis-daemon emits a JSON-RPC notification to genie's process manager (`aegis.critical-finding-detected` over the existing IPC socket genie polls). Genie receives, sets `paused: true` on the active agent session, and surfaces the pause to the operator.
  2. Emit desktop notification: `notify-rust` crate cross-platform (libnotify on Linux, `osascript` notification on macOS as fallback). Body: short summary ("CanisterWorm IOC detected: <host> in <file>"), action: "Open mission control".
  3. Write typed-ack quarantine prompt to `~/.genie/aegis/prompts/<prompt-id>.json`. Schema reuses `sec-fix-one-shot`'s typed-ack format: `{prompt_id, scan_id, finding, severity, suggested_action, typed_ack_string, expires_at}`.
- Operator response paths:
  - `aegis approve <prompt-id>` (already in v0.1 from sibling C) — types the ack string; aegis hands off to `genie sec fix --apply --plan <plan-path>` (existing UX from `sec-fix-one-shot`).
  - `aegis approve --reject <prompt-id> --reason <text>` — dismisses prompt with operator-supplied reason; audit-logged but no remediation action.
  - `aegis prompts list [--pending]` — shows pending prompts.
  - `aegis prompts show <prompt-id>` — full details: finding, suggested action, typed-ack hint.
- Genie's pause behavior: when paused, genie agent suspends new tool invocations + new model calls; operator UI displays a banner "Paused by Aegis: <reason>; resolve via `aegis approve <prompt-id>`".
- Auto-unpause: on successful `aegis approve` and `genie sec fix --apply` completion, aegis-daemon emits `aegis.critical-finding-resolved` notification; genie auto-unpauses unless additional pending prompts remain.
- Prompt expiration: prompts expire after 24h (configurable in `scanner-policy.yaml`); expired prompts are audit-logged + auto-rejected; genie auto-unpauses if no pending prompts remain.
- Severity-below-critical handling: high/medium/low findings are audit-logged and visible via `aegis scanner findings` but do NOT pause genie or emit desktop notifications. Operators can promote any finding to a prompt via `aegis scanner promote <finding-id>`.

### OUT

- **Rust port of `scripts/sec-scan.cjs`** — explicit OUT. Aegis owns scanner orchestration; existing CJS owns detection logic. v2 may revisit if the latency penalty becomes a real complaint.
- **Native Windows FS watcher** — deferred to v2 with the rest of `aegis-runtime`'s Windows path.
- **Network-IOC-only scanning** (matching scan signatures against live network traffic) — separate future wish; this wish scans the filesystem only. Network observability is sibling C's territory.
- **New IOC detection logic** — Aegis consumes `sec-signature-registry` packs unchanged; no new matchers in this wish.
- **Cloud-side aggregation of findings** — `@khal-os` enterprise tier owns this. v1 is single-host self-managed.
- **Multi-tenant scanning** (one daemon scanning multiple operator workspaces) — out; one daemon per operator host.
- **Browser profile WRITE detection** (catching exfiltration-in-progress) — read-only snapshot scanning only in v1; live process monitoring is `@khal-os` territory.
- **Replacement of `genie sec scan` / `sec-fix` one-shot UX** — both continue to work for power users + CI; Aegis is additive.
- **In-process aegis-daemon scanning** (running scanner in-process for lower latency) — explicit OUT for v1; subprocess shell-out preserves crash isolation.
- **Memory / live-process scanning** (beyond what `genie sec scan --impact-surface` already does) — covered by existing scanner; this wish does not expand the surface.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Scanner integration via shell-out to `genie sec scan` (not Rust port) | Battle-tested CJS, signature-pack aware, ~127KB; Rust port doubles maintenance for marginal latency win; subprocess crash isolation > in-process performance |
| 2 | Scheduled deep scan default cadence: 6 hours | Balances detection latency vs. host cost; operators can tune via policy file; aligns with industry AV scan cadences (Defender ≈8h) |
| 3 | FS watcher = fanotify (Linux) + FSEvents (macOS), Windows deferred | Native platform tooling; minimal third-party crate trust; fanotify is privileged but already a documented runbook for security tooling |
| 4 | Watch paths include browser profiles (read-only) | CanisterWorm-class incidents exfil through browser session storage; scanning browser profiles closes a known IOC pathway |
| 5 | Signature pack poll cadence: 1 hour | Matches `sec-signature-registry` recommended SLA for production / CI runners; configurable for lower-volume operators |
| 6 | Audit log reuses existing `~/.genie/sec-scan/audit/<scan_id>.jsonl` | No new on-disk format; existing forensic tools work unchanged; aegis adds `triggered_by` field for distinguishing source |
| 7 | Critical-finding response: pause + notify + typed-ack prompt | Mirrors industry AV "found critical, took action" UX; pause prevents in-flight agent from continuing toward unsafe state; typed-ack respects operator agency |
| 8 | Sec-fix integration: `aegis approve` invokes `genie sec fix` (the existing one-shot entrypoint shipped by `sec-fix-one-shot`) without passing a plan path; sec-fix runs its standard scan→dry-run→apply chain | sec-fix-one-shot does NOT define a `--prompt` or `--plan-from-aegis` interface in v1; the existing entrypoint is the contract. Aegis's typed-ack prompt carries finding evidence (path, IOC, severity), NOT a plan path; sec-fix re-discovers the finding during its own scan stage and routes accordingly. Avoids coupling that would require a follow-up update to sec-fix-one-shot. |
| 8b | New JSON-RPC namespace `scanner.*` extends `aegis-protocol` crate (shared with sibling C) | Sibling C (aegis-runtime) reserves the `scanner.*` namespace at workspace creation time; this wish adds the actual method definitions (`scanner.notify-critical-finding`, `scanner.notify-resolved`, etc.) into `crates/aegis-protocol/schemas/v1/scanner-notification.json`. Versioned at `protocol_version: 1` matching sibling C's contract. |
| 8c | Genie-side process-manager pause is a NEW component owned by this wish | Sibling C's Decision #19 explicitly notes "aegis approve ships in v1 even though no producer exists yet" — this wish adds the producer (scanner notification) and the genie-side listener (`src/lib/aegis-pause.ts`) that translates the notification into agent-session pause state. No existing genie process manager handles this; this wish creates it. |
| 9 | Scanner subprocess concurrency: max 1 deep scan + max 4 FS-watch incremental | Prevents resource exhaustion on busy hosts; backpressure drops to audit log rather than blocking; tunable via policy |
| 10 | Pack-update failure does NOT halt scanning | Robustness: stale-but-verified packs > no protection; 6-failure desktop notification surfaces persistent issues |
| 11 | Prompt expiration default: 24h | Long enough for weekend-out-of-office operators; short enough to prevent prompt-pollution; auto-reject + auto-unpause on expiration |
| 12 | Severity-below-critical findings: log only, no genie pause | Avoids notification fatigue; high-severity findings still visible via `aegis scanner findings`; operator can promote any to prompt |
| 13 | Browser profile scans are read-only snapshots | Avoids race conditions with active browser; covers the "bad cert in profile" / "exfil token in localStorage" detection without browser cooperation |
| 14 | Aegis-scanner crate sits inside the existing `automagik-dev/aegis` workspace | Reuses CI, signing, CDN distribution; ships as part of `aegis-daemon` binary (no separate binary); operators install once, get scanner + sandbox |
| 15 | FS watcher debounce window: 500ms | Long enough to coalesce burst writes (npm install, git checkout); short enough that operator-perceived latency is sub-second |
| 16 | Operator can promote sub-critical findings to prompts via `aegis scanner promote` | Forward-looking surface for operators tuning their detection sensitivity; explicit acknowledgment that severity is signature-author opinion, operator can override |
| 17 | Genie pause is implemented via existing genie process manager IPC, not a new mechanism | Reuses `aegis-runtime`'s aegis.sock + JSON-RPC; no new attack surface |

## Success Criteria

- [ ] `aegis scanner status` reports scanner state (idle / scanning / error), last deep scan time, last signature update time, pending prompts count.
- [ ] Scheduled deep scan: with `deep_scan_interval_seconds: 60` (test override), scanner runs `genie sec scan --persist` every 60s; envelope appended to `~/.genie/sec-scan/audit/<scan_id>.jsonl`; aegis adds `triggered_by: aegis_scheduled` field.
- [ ] FS watcher Linux: writing a file matching a known IOC pattern triggers an incremental scan within 500ms; finding emitted to audit log; netflow event `scanner.fswatch-triggered` recorded.
- [ ] FS watcher macOS: same behavior with FSEvents.
- [ ] Watch path coverage: workspace, global install, npm cache, browser profiles all under fswatch; documented in `aegis scanner watched-paths`.
- [ ] Signature pack auto-update: hourly poll; on new pack version, aegis hot-reloads; `aegis scanner status` reports new `signatures_version`; in-flight scans complete with prior packs.
- [ ] Pack-update failure resilience: 5 consecutive simulated network failures; scanner continues with prior packs; 6th failure triggers desktop notification.
- [ ] Critical-finding end-to-end: plant a critical IOC fixture; FS-watch detects on write; aegis emits `aegis.critical-finding-detected`; genie agent pauses; desktop notification visible; `aegis approve <prompt-id>` types ack and runs `genie sec fix --apply`; agent auto-unpauses on success.
- [ ] Sub-critical findings: high/medium/low findings appear in `aegis scanner findings` but do NOT pause genie or emit notifications.
- [ ] Severity promotion: `aegis scanner promote <finding-id>` upgrades a sub-critical finding into a typed-ack prompt; subsequent `aegis approve` flows identically.
- [ ] Prompt expiration: prompt with `expires_at` in past auto-rejects; audit event `prompt.expired`; genie auto-unpauses if no other prompts pending.
- [ ] Concurrency cap: launch 10 simultaneous fswatch triggers + 1 scheduled scan; max-concurrent observed = 1 (deep) + 4 (incremental); 5 incremental events queued or dropped (with audit event); no deadlock.
- [ ] Resource utilization: idle developer laptop with full watch path set: aegis-daemon CPU ≤2% over 5-minute window; verified via `pidstat`.
- [ ] Audit log integrity: 100 successful scans + 100 fswatch triggers; existing `~/.genie/sec-scan/audit/` jsonl entries valid; aegis-added `triggered_by` field present on every scanner-originated entry.
- [ ] CLI mission control: `aegis scanner status / trigger / history / cancel / findings / promote / watched-paths / update-signatures` all functional with `--json` output validating against schemas.

## Dependencies / Related Wishes

| Relationship | Wish | Reason |
|--------------|------|--------|
| depends-on | `genie-supply-chain-signing` (shipped) | Cosign primitives reused for signature pack verification |
| depends-on | `sec-scan-progress` (shipped) | Existing `genie sec scan` envelope + audit log format consumed unchanged |
| depends-on | `sec-signature-registry` (shipped) | `@automagik/genie-signatures` repo + pack-update pathway reused |
| depends-on | `sec-fix-one-shot` (shipped) | Typed-ack quarantine prompt → `genie sec fix --apply` UX reused |
| depends-on | `aegis-runtime` | Daemon scaffold + IPC + CLI mission control + `aegis approve` surface + audit log conventions are prerequisites |
| umbrella | `aegis-distribution-sovereignty` | Sibling D (Wave 3) of the umbrella |
| related | `sec-incident-runbook` (shipped) | Runbook references continuous-scanner findings as an incident-response trigger |

## Execution Strategy

### Wave 1 — Scanner module integration (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | aegis-scanner crate, shell-out to `genie sec scan`, scheduled deep-scan loop, JSON-RPC methods, audit-log integration. |

### Wave 2 — FS watcher ‖ Signature poller (parallel after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | aegis-fswatch crate, fanotify + FSEvents implementations, debounce + batch, watched-paths management. |
| 3 | engineer | aegis-signatures-poller crate, hourly poll via `genie sec signatures update`, hot reload, failure resilience. |

### Wave 3 — Critical-finding pipeline + sec-fix integration (sequential after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Severity router, genie-pause IPC, desktop notifications, typed-ack prompts, sec-fix handoff, expiration timer, promote subcommand. |

## Execution Groups

### Group 1: Scanner module integration

**Goal:** aegis-daemon runs scheduled deep scans via `genie sec scan` shell-out, ingests envelopes, exposes scanner state via JSON-RPC + `aegis scanner` CLI.

**Deliverables:**
1. `crates/aegis-scanner/` (new crate in `automagik-dev/aegis` workspace).
2. `crates/aegis-scanner/src/runner.rs`: tokio-based interval task; spawns `genie sec scan --progress-json --persist --redact --root <root> [--signatures <pack-ids>]` as subprocess; captures stdout NDJSON event stream.
3. `crates/aegis-scanner/src/policy.rs`: YAML loader for `~/.genie/aegis/scanner-policy.yaml` with schema v1: `{schema_version, deep_scan_interval_seconds, roots, signature_filter, redact_in_audit, max_concurrent_scans, fswatch_debounce_ms, signature_poll_interval_seconds, prompt_expiration_seconds}`.
4. JSON-RPC methods on aegis-daemon: `scanner.status`, `scanner.trigger {root, signatures}`, `scanner.history {since, until, limit}`, `scanner.cancel {scan_id}`. Schemas in `crates/aegis-protocol/schemas/v1/scanner.json`.
5. CLI subcommands on `aegis`: `aegis scanner status|trigger|history|cancel|findings|watched-paths`. `--json` mode on each.
6. Audit log integration: scan envelope from CJS appended to `~/.genie/sec-scan/audit/<scan_id>.jsonl` (existing path); aegis prepends `aegis_metadata: {triggered_by, scanner_version, daemon_version}` field to every entry.
7. Concurrency: tokio Semaphore caps deep scans at 1 + incremental at 4 (configurable). Backpressure: queue bounded at 100; overflow drops with `scanner.queue-overflow` audit event.
8. Tests: `crates/aegis-scanner/tests/runner_test.rs` (subprocess invocation, envelope ingestion, audit-log appending), `tests/concurrency_test.rs` (semaphore behavior, backpressure), `tests/policy_test.rs` (schema validation).

**Acceptance Criteria:**
- [ ] `aegis scanner trigger --root /tmp/test-fixture --signatures canisterworm-2026-04` runs `genie sec scan` as subprocess; envelope appears in `~/.genie/sec-scan/audit/<scan_id>.jsonl`; aegis_metadata field present.
- [ ] Scheduled deep scan: with `deep_scan_interval_seconds: 60`, daemon runs scan every 60s; visible in `aegis scanner history --json`.
- [ ] `aegis scanner status --json` returns `state, last_deep_scan_at, last_deep_scan_findings, queue_depth, max_concurrent_scans`.
- [ ] Concurrency: 10 parallel `aegis scanner trigger` calls — at most 1 deep scan + 4 incremental scans run simultaneously; remainder queued or dropped per backpressure rules.
- [ ] `aegis scanner cancel <scan-id>` sends SIGTERM to subprocess; subprocess exits cleanly; audit log records `scanner.cancelled` event.
- [ ] Schema validation: malformed `scanner-policy.yaml` refused with line-number error; daemon continues serving prior policy.
- [ ] Subprocess crash resilience: SIGKILL the `genie sec scan` subprocess mid-scan; aegis-scanner records `scanner.subprocess-failed` audit event; subsequent triggers succeed.

**Validation:**
```bash
cargo test -p aegis-scanner
./target/release/aegis-daemon &
./target/release/aegis scanner trigger --root ./test-fixtures/canisterworm-fixture --json | jq .scan_id
./target/release/aegis scanner status --json | jq .state
./target/release/aegis scanner history --since 5m --json | jq '.scans | length'
```

**depends-on:** none

---

### Group 2: FS watcher + incremental scan

**Goal:** File-system writes to watched paths trigger incremental scans within 500ms; debounce + batch prevent burst-write floods.

**Deliverables:**
1. `crates/aegis-fswatch/` (new crate).
2. Linux backend: `fanotify-rs` for FAN_MARK_ADD on watched paths; FAN_CLOSE_WRITE + FAN_MOVED_TO event mask. Privileged-init fallback to `inotify-rs` if fanotify unavailable.
3. macOS backend: `fsevent-rs` with `kFSEventStreamCreateFlagFileEvents`.
4. Watch path resolution: reads `roots` from `scanner-policy.yaml`; expands tilde + globs; deduplicates; honors a default skip list (`.git/`, `node_modules/.cache/`, `.next/`, `dist/`, `target/`, build dirs).
5. Debounce: 500ms window per absolute path; coalesces duplicate writes; batches burst writes (10k+ files in one `npm install`) into a single batched scan over the affected directory.
6. Browser profile read-only snapshot: scanner walks profile dirs without watching them (snapshot once per deep scan); avoids race conditions with active browser writes.
7. CLI integration: `aegis scanner watched-paths --json` lists current watch roots + skip list; `aegis scanner watched-paths add <path>` / `remove <path>` modifies the policy file.
8. Resource cap enforcement: tracks CPU usage of fswatch loop; throttles to ≤2% on idle host (verified via `pidstat` integration test).
9. Tests:
   - `crates/aegis-fswatch/tests/linux_fanotify.rs` (Linux only, CI-skipped on macOS) — write + verify event delivery latency.
   - `crates/aegis-fswatch/tests/macos_fsevents.rs` (macOS only) — same.
   - `tests/debounce_test.rs` — burst write coalescing, dedup correctness.
   - `tests/skip_list_test.rs` — `.git/` and `node_modules/.cache/` writes ignored.

**Acceptance Criteria:**
- [ ] Linux: `echo "fixture" > /tmp/test-watch/iocfile.txt` triggers an incremental scan within 500ms; finding emitted to audit log; `scanner.fswatch-triggered` audit event recorded.
- [ ] macOS: same behavior with FSEvents.
- [ ] Burst-write coalescing: `npm install` writing 10000 files in `~/.npm/_cacache/` triggers ≤10 batched incremental scans (not 10000 individual scans).
- [ ] Skip list: writes inside `.git/objects/` do NOT trigger scans (verified via audit log absence).
- [ ] `aegis scanner watched-paths add /opt/myapp` updates policy; daemon reloads watcher; subsequent writes to `/opt/myapp` trigger scans.
- [ ] Resource cap: idle 5-minute window — fswatch crate CPU ≤2% (verified via `pidstat -p <pid> 1 300`).
- [ ] Browser profile snapshot: deep scan inspects Chrome `~/Library/Application Support/Google/Chrome/Default/Login Data` (macOS) without active fswatch on it; finding ingestion works.

**Validation:**
```bash
cargo test -p aegis-fswatch
./target/release/aegis-daemon &
./target/release/aegis scanner watched-paths --json | jq .roots
echo "test ioc string telemetry.api-monitor.com" > /tmp/aegis-test/iocfile.txt
sleep 1
./target/release/aegis scanner findings --since 5s --json | jq '.findings[0].sni_match'  # matches
pidstat -p $(pgrep aegis-daemon) 1 30 | awk 'NR>3 {sum+=$8; n++} END {print sum/n "% avg CPU"}'
```

**depends-on:** Group 1

---

### Group 3: Signature pack auto-updater

**Goal:** Aegis pulls latest `@automagik/genie-signatures` hourly with cosign verification; hot reload; failure resilience.

**Deliverables:**
1. `crates/aegis-signatures-poller/` (new crate).
2. Hourly tokio interval task; configurable via `signature_poll_interval_seconds` in `scanner-policy.yaml`.
3. Polling logic: shell-out to `genie sec signatures update --json` (existing command from `sec-signature-registry`); parse structured output `{from_version, to_version, packs_added, packs_removed, verified, elapsed_ms}`.
4. Hot reload: on successful update, daemon sends `scanner.signatures-changed` event over IPC; in-flight scans grandfather under prior packs (subprocess invocations already started keep their packs); next scan invocation picks up new packs via `--signatures` flag.
5. Failure resilience: pack-update failure (network error, signature mismatch via cosign refusal, corrupt YAML) audit-logged but does NOT halt scanning. Failure counter persisted in `~/.genie/aegis/state/signatures-poller.json`. On 6 consecutive failures, daemon emits desktop notification + audit event `signatures.persistent-failure`.
6. Manual override: `aegis scanner update-signatures` triggers immediate pull (no wait for next interval); useful for incident response.
7. Audit events: `signatures.update-attempt`, `signatures.update-success`, `signatures.update-failure`, `signatures.persistent-failure`. All written to `~/.genie/aegis/audit/scanner.jsonl` (NEW audit file separate from netflow.jsonl, mode 0600).
8. Tests:
   - `crates/aegis-signatures-poller/tests/poll_test.rs` — successful pull, hot reload, in-flight grandfather behavior.
   - `tests/failure_resilience_test.rs` — 5 simulated failures don't halt scanning; 6th triggers persistent-failure event.
   - `tests/manual_override_test.rs` — manual trigger immediate; counter reset on success.

**Acceptance Criteria:**
- [ ] With `signature_poll_interval_seconds: 30` (test override) + a fixture signatures repo: aegis pulls every 30s; `aegis scanner status --json | jq .signatures_version` reflects latest version.
- [ ] Hot reload: publish a new pack to fixture repo; within 30s, aegis loads it; next scan applies new pack matchers; old in-flight scan keeps prior packs.
- [ ] Cosign refusal: serve a tampered pack from fixture; aegis refuses; counter increments; prior packs continue serving; audit event `signatures.update-failure` recorded with `reason: cosign-failed`.
- [ ] 6-failure desktop notification: simulate 6 consecutive failures; aegis emits desktop notification (verified via `notify-rust` mock); audit event `signatures.persistent-failure` recorded.
- [ ] Manual override: `aegis scanner update-signatures --json` returns within 5s with `{from_version, to_version, packs_added, packs_removed}`.
- [ ] Audit log: `~/.genie/aegis/audit/scanner.jsonl` mode 0600; valid jsonl after 1000 update events.

**Validation:**
```bash
cargo test -p aegis-signatures-poller
./target/release/aegis-daemon &
./target/release/aegis scanner update-signatures --json | jq .to_version
./target/release/aegis scanner status --json | jq .signatures_version
stat -c '%a' ~/.genie/aegis/audit/scanner.jsonl  # 600
```

**depends-on:** Group 1

---

### Group 4: Critical-finding pipeline + sec-fix integration

**Goal:** Critical IOC hits write a typed-ack prompt, notify the operator, pause the active genie agent, and on approval hand off to the existing `genie sec fix` entrypoint (no plan path) which runs its own scan→dry-run→apply chain.

**Deliverables:**
1. `crates/aegis-scanner/src/severity_router.rs`: filters scan findings; routes critical → prompt creation; sub-critical → audit log only.
2. **JSON-RPC scanner-notification schema (extends sibling C's reserved `scanner.*` namespace):** new file `crates/aegis-protocol/schemas/v1/scanner-notification.json` defines methods:
   - `scanner.notify-critical-finding {prompt_id, scan_id, finding_summary, severity, signature_id, expires_at}` — daemon → genie subscriber notification (push).
   - `scanner.notify-resolved {prompt_id, resolution: "approved" | "rejected" | "expired"}` — daemon → genie subscriber notification.
   - `scanner.subscribe-notifications {client_id}` — genie → daemon long-poll subscription RPC; daemon retains client_id and pushes notifications until the connection closes.
   - All methods carry `protocol_version: 1` matching sibling C's contract; CLI/genie reject mismatched versions per sibling C Group 1 Deliverable 5.
3. Daemon-side notification dispatch (`crates/aegis-scanner/src/notify.rs`): on critical finding routed by Deliverable 1, writes prompt file (Deliverable 5), emits desktop notification (Deliverable 4), broadcasts `scanner.notify-critical-finding` to all subscribed JSON-RPC clients.
4. Desktop notification: `notify-rust` crate cross-platform. Body: "<n> critical IOC(s) detected. Run `aegis prompts list` to review." Linux: libnotify; macOS: falls back to `osascript -e 'display notification "..."'` if no notify daemon.
5. Typed-ack prompt creation: writes `~/.genie/aegis/prompts/<prompt-id>.json` schema v1 — note `finding_evidence` replaces the old `suggested_action`/plan-path coupling:
   ```json
   {
     "schema_version": 1,
     "prompt_id": "...",
     "scan_id": "...",
     "finding_evidence": {
       "path": "<absolute path triggering match>",
       "ioc_kind": "string|file_basename|sha256|network_host",
       "ioc_value": "<matched value, redacted if requested>",
       "severity": "critical",
       "signature_id": "canisterworm-2026-04",
       "first_seen_at": "..."
     },
     "recommended_command": "genie sec fix --yes --incident-id <auto-generated>",
     "typed_ack_string": "CONFIRM-AEGIS-CRITICAL-<6hex>",
     "expires_at": "...",
     "status": "pending|approved|rejected|expired"
   }
   ```
   Schema at `crates/aegis-protocol/schemas/v1/prompt.json`. The prompt does NOT carry a sec-fix plan path — sec-fix discovers the finding during its own scan stage.
6. `aegis approve <prompt-id>` (extends sibling C's reserved CLI surface from Decision #19): operator types the `typed_ack_string`; on match, aegis spawns `genie sec fix --yes --incident-id <prompt-id>` (existing one-shot entrypoint from `sec-fix-one-shot`). Sec-fix runs its standard scan → dry-run → apply chain and re-discovers the finding. Result audit-logged; on success, aegis emits `scanner.notify-resolved {resolution: "approved"}`.
7. `aegis approve --reject <prompt-id> --reason <text>` — dismisses prompt; audit event `prompt.rejected`; emits `scanner.notify-resolved {resolution: "rejected"}`; auto-unpause if no other pending.
8. `aegis prompts list [--pending|--resolved|--rejected|--expired]` — filtered prompt list (extends sibling C's reserved CLI).
9. `aegis prompts show <prompt-id>` — full details: finding evidence, recommended command, typed-ack hint, expiration.
10. `aegis scanner promote <finding-id> [--severity critical]` — manually promotes a sub-critical finding into a typed-ack prompt; audit event `finding.promoted`. Operator override of signature-author severity; documented in `docs/scanner.md`.
11. Prompt expiration timer: tokio interval scans `~/.genie/aegis/prompts/` every minute; expired prompts auto-reject with `reason: expired`; emits `scanner.notify-resolved {resolution: "expired"}`. 24h default expiration; operator overrides via `prompt_expiration_seconds` in `~/.genie/aegis/scanner-policy.yaml` (range: 1h–7d).
12. **Genie-side integration (NEW components — no existing process manager handles this):**
    - `src/lib/aegis-pause.ts` (new): subscribes to `scanner.subscribe-notifications` over the aegis socket (reuses sibling C's aegis-detect connection); on `scanner.notify-critical-finding`, sets `paused: true` on the active agent session row in PG (uses existing `sessions` table — adds an in-memory pause flag, NO schema migration required for v1); surfaces banner in TUI + tasks view via existing genie status aggregator (from `invincible-genie` work).
    - On `scanner.notify-resolved`, clears the pause flag if no other prompts are pending (genie queries `aegis prompts list --pending --json` to check).
    - Pause semantics: agent suspends new tool invocations + new model calls until unpaused; in-flight tool calls complete; UI banner shows "Paused by Aegis: <prompt-id>; resolve via `aegis approve <prompt-id>` or `aegis approve --reject <prompt-id>`".
    - Reactive fallback: if the JSON-RPC notification subscription drops mid-session, genie polls `aegis prompts list --pending --json` once per minute as a backstop; reconnects on next aegis-detect cycle.
12. Tests:
   - `crates/aegis-scanner/tests/severity_router_test.rs` — critical → prompt; sub-critical → audit only.
   - `tests/prompt_lifecycle_test.rs` — create → approve → resolve; create → reject; create → expire.
   - `src/lib/aegis-pause.test.ts` (genie repo) — pause-on-notification, unpause-on-resolved.
   - Integration: `scripts/integration/critical-finding-e2e.sh` — plant fixture IOC → watch fswatch → confirm pause → approve → confirm sec-fix runs → confirm unpause.

**Acceptance Criteria:**
- [ ] JSON-RPC schema extension: `crates/aegis-protocol/schemas/v1/scanner-notification.json` defines `scanner.notify-critical-finding`, `scanner.notify-resolved`, `scanner.subscribe-notifications` with `protocol_version: 1`; CLI `aegis status --json | jq .protocol_version` returns `1`.
- [ ] Genie subscribes to scanner notifications: `aegis-detect` opens long-poll subscription via `scanner.subscribe-notifications`; daemon retains client_id; subscription survives until aegis-detect connection closes.
- [ ] Plant fixture: write file with critical IOC string in a watched path; fswatch (Group 2) triggers scan; severity router (this group) filters critical; prompt created at `~/.genie/aegis/prompts/<id>.json` validating against `crates/aegis-protocol/schemas/v1/prompt.json`; desktop notification visible; daemon broadcasts `scanner.notify-critical-finding` to subscribed genie session; genie session sets in-memory pause flag and surfaces TUI banner.
- [ ] Operator runs `aegis approve <prompt-id>`: typed-ack string verified; aegis spawns `genie sec fix --yes --incident-id <prompt-id>` (existing `sec-fix-one-shot` entrypoint, NO `--plan` arg); sec-fix runs its own scan→dry-run→apply chain; on success aegis emits `scanner.notify-resolved {resolution: "approved"}`; genie auto-unpauses if no other prompts pending.
- [ ] Operator runs `aegis approve --reject <prompt-id> --reason "false positive: known dev fixture"`: prompt status → rejected; audit event recorded; aegis emits `scanner.notify-resolved {resolution: "rejected"}`; genie unpauses if no other pending.
- [ ] Sub-critical finding (severity: high): logged to `aegis scanner findings`; NO desktop notification; NO genie pause; NO prompt creation.
- [ ] Promote: `aegis scanner promote <high-severity-finding-id> --severity critical` creates a prompt; same approve/reject flow.
- [ ] Prompt expiration: prompt with `expires_at: now() - 1h` auto-rejected on next minute-tick; audit event `prompt.expired`; aegis emits `scanner.notify-resolved {resolution: "expired"}`; genie auto-unpauses if applicable.
- [ ] Operator override expiration via `prompt_expiration_seconds` in scanner-policy.yaml: setting `259200` (3 days) makes new prompts use 3d expiration; setting outside `[3600, 604800]` range refused with helpful error.
- [ ] Multiple critical findings simultaneously: 3 fixture IOCs detected at once → 3 prompts → 3 desktop notifications (or 1 batched if `notify-rust` supports) → genie pauses on first; remains paused until ALL 3 resolved.
- [ ] Notification subscription drop fallback: kill aegis-detect subscription mid-session; genie polls `aegis prompts list --pending --json` once per minute; subscription reconnects on next aegis-detect cycle without missing prompts.
- [ ] Integration test `scripts/integration/critical-finding-e2e.sh` passes end-to-end on Linux + macOS.
- [ ] No schema migration to genie's PG `sessions` table required for v1 (in-memory pause flag only).

**Validation:**
```bash
cargo test -p aegis-scanner
bun test src/lib/aegis-pause.test.ts  # in genie repo
bash scripts/integration/critical-finding-e2e.sh
./target/release/aegis prompts list --pending --json
```

**depends-on:** Group 2, Group 3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] End-to-end Linux: install genie + aegis; plant CanisterWorm IOC fixture in `~/.npm/_cacache/`; FS watcher detects; aegis pauses genie agent; desktop notification visible; `aegis approve` runs `genie sec fix --apply` cleanly; agent unpauses.
- [ ] End-to-end macOS: same lifecycle.
- [ ] Scheduled deep scan: 24-hour soak run; deep scans every 6h on schedule; no resource leak; total disk usage ≤500 MB across audit logs + downloads.
- [ ] Signature pack hot reload: publish new pack to canary signatures repo; aegis loads within 1 hour; subsequent scans apply new pack matchers.
- [ ] Failure resilience: 6 consecutive simulated pack-update failures → desktop notification + persistent-failure audit event; scanning continues with prior packs.
- [ ] Concurrency: 10 simultaneous `aegis scanner trigger` calls + active fswatch → max 1 deep + 4 incremental concurrent; no deadlock; backpressure dropped scans audit-logged.
- [ ] Resource cap: idle 5-minute window with full watch path set → aegis-daemon CPU ≤2%; verified via `pidstat`.
- [ ] Audit log integrity: 1000 fswatch triggers + 100 deep scans + 50 critical-finding prompts → all audit logs valid jsonl, mode 0600 preserved, no corruption under SIGKILL.
- [ ] Sub-critical findings: 50 high-severity fixture findings → all in `aegis scanner findings`, NONE pause genie or emit desktop notifications.
- [ ] Promote: 5 promoted high-severity findings → 5 prompts, 5 approve flows complete cleanly.
- [ ] `cargo test --workspace` (Aegis repo) passes; ≥80% coverage on new crates.
- [ ] `bun run check` (genie repo) passes after `aegis-pause` integration lands.
- [ ] Existing `genie sec scan` + `sec-fix` one-shot UX continues to work unchanged (no regression in existing tests).
- [ ] Browser profile snapshot: deep scan inspects Chrome profile without active fswatch; finding ingestion works on Linux + macOS.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Subprocess shell-out latency (`genie sec scan`) is too high for fswatch incremental scans | High | Group 2 incremental scans use `--root <single-path>` + signature filter to limit scope; benchmarked ≤2s per single-file scan; if too slow, fallback is a Rust-side IOC-string scanner that pre-filters before invoking the full CJS scanner |
| fanotify requires CAP_SYS_ADMIN on some distros (privileged) | High | Documented fallback to `inotify-rs` (unprivileged); operator-runbook explains the privilege model; aegis-daemon does NOT run as root by default — fanotify mode is opt-in via `aegis scanner enable-fanotify` |
| FS watcher resource exhaustion on busy hosts (CI runners, large monorepos) | High | Skip list + debounce + concurrency cap + backpressure-with-audit; operator-tunable in policy file; resource cap enforced at ≤2% CPU |
| Pack-update via shell-out coupled to genie binary's availability | High | If `genie sec signatures update` fails (genie binary missing or broken), aegis logs failure but keeps scanning with prior packs; documented as known coupling; v2 may add Rust-native pack pulling |
| Genie pause IPC ↔ aegis-daemon protocol drift | Medium | JSON-RPC schema versioned (v1); both genie + aegis-daemon report `protocol_version`; mismatch refuses with helpful upgrade message |
| Desktop notification spam on noisy hosts (many low-confidence critical hits) | Medium | Critical-only desktop notifications (sub-critical is silent); coalescing for batched findings; operator can mute via `aegis scanner mute-notifications` (deferred to v2 if real complaint) |
| Browser profile read failures (locked files, missing access) | Medium | Best-effort: silently skip with audit event `scanner.browser-profile-skipped`; finding count reflects accessible-only profiles |
| 24h prompt expiration is too short / too long for some operators | Medium | Configurable in `scanner-policy.yaml`; operator documentation explains tradeoffs |
| Signature pack false positives pause genie unnecessarily | Medium | `aegis approve --reject` flow handles this; sub-critical-by-default for new pack types via `signature_filter` policy; operator runbook explains how to triage |
| FS watcher misses writes during daemon-down windows | Medium | On daemon restart, scheduled deep scan catches up within `deep_scan_interval_seconds`; operator runbook documents the recovery latency |
| Aegis pauses genie at a critical workflow moment (mid-deploy, mid-data-migration) | Medium | Pause is reversible via `aegis approve --reject`; banner in genie UI explains what's blocking; operator can tune severity threshold for their workflow |
| Concurrency-cap backpressure drops legit fswatch events under load | Low | Backpressure events audit-logged; operator can raise `max_concurrent_scans`; rare in normal operation; documented |
| `notify-rust` crate dependency churn / cross-platform inconsistencies | Low | Fallback to `osascript` on macOS; fallback to logging-only on hosts without notification daemon; integration tests assert at-least-one-channel-works |
| `~/.genie/aegis/prompts/` directory permissions issue → operators can't read | Low | Mode 0700 on directory; mode 0600 on individual prompt files; matches existing `~/.genie/audit/` conventions |
| Scanner subprocess crashes mid-scan corrupt audit log | Low | `genie sec scan` already writes audit log via fsync-per-event; partial scan visible as `scanner.subprocess-failed` aegis event; existing forensic tools tolerate truncated jsonl |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# automagik-dev/aegis (sibling C's repo, this wish adds new crates)
crates/aegis-scanner/Cargo.toml                       create
crates/aegis-scanner/src/lib.rs                       create
crates/aegis-scanner/src/runner.rs                    create — subprocess invocation + envelope ingest
crates/aegis-scanner/src/policy.rs                    create — scanner-policy.yaml loader
crates/aegis-scanner/src/severity_router.rs           create — critical-finding routing
crates/aegis-scanner/src/notify.rs                    create — daemon-side notification dispatch + JSON-RPC broadcast
crates/aegis-scanner/tests/runner_test.rs             create
crates/aegis-scanner/tests/concurrency_test.rs        create
crates/aegis-scanner/tests/policy_test.rs             create
crates/aegis-scanner/tests/severity_router_test.rs    create
crates/aegis-scanner/tests/prompt_lifecycle_test.rs   create
crates/aegis-scanner/tests/notify_test.rs             create — JSON-RPC notification broadcast + subscription drop fallback

crates/aegis-fswatch/Cargo.toml                       create
crates/aegis-fswatch/src/lib.rs                       create — backend dispatcher
crates/aegis-fswatch/src/linux.rs                     create — fanotify + inotify fallback
crates/aegis-fswatch/src/macos.rs                     create — FSEvents
crates/aegis-fswatch/src/debounce.rs                  create — coalescing logic
crates/aegis-fswatch/tests/                           create — platform-specific tests

crates/aegis-signatures-poller/Cargo.toml             create
crates/aegis-signatures-poller/src/lib.rs             create
crates/aegis-signatures-poller/tests/                 create

crates/aegis-protocol/schemas/v1/scanner.json              create — JSON-RPC scanner.{status,trigger,history,cancel} (methods reserved by sibling C, defined here)
crates/aegis-protocol/schemas/v1/scanner-notification.json create — scanner.{notify-critical-finding,notify-resolved,subscribe-notifications} (producer methods)
crates/aegis-protocol/schemas/v1/prompt.json               create — typed-ack prompt schema (finding_evidence + recommended_command, NO plan path)

crates/aegis-cli/src/cmds/scanner.rs                  create — `aegis scanner ...` subcommands
crates/aegis-cli/src/cmds/prompts.rs                  create — `aegis prompts ...` subcommands

docs/scanner.md                                       create — scanner architecture + threat model
docs/scanner-policy-defaults.md                       create — default scanner-policy.yaml fields

# automagik-dev/genie (integration)
src/lib/aegis-pause.ts                                create — listen for aegis.critical-finding-detected, pause agent
src/lib/aegis-pause.test.ts                           create
src/term-commands/aegis.ts                            modify — pass-through `aegis scanner` + `aegis prompts`
scripts/integration/critical-finding-e2e.sh          create — plant IOC → fswatch → pause → approve → resolve
SECURITY.md                                           modify — link to aegis scanner runbook
```
