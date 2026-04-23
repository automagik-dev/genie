# Wish: Sec Remediate — Auditable Incident Remediation

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `sec-remediate` |
| **Date** | 2026-04-23 |
| **Author** | Genie Council (split from sec-scan-progress monolith per reviewer verdict) |
| **Appetite** | medium |
| **Branch** | `wish/sec-remediate` |
| **Repos touched** | `automagik-dev/genie` |
| **Umbrella** | [canisterworm-incident-response/DESIGN.md](../../brainstorms/canisterworm-incident-response/DESIGN.md) |
| **Council** | [../sec-scan-progress/COUNCIL.md](../../brainstorms/sec-scan-progress/COUNCIL.md) |

## Summary

`genie sec scan` tells operators what is compromised. This wish ships the reversible, auditable pathway to actually fix it: `genie sec remediate` (dry-run, plan-frozen apply, per-finding typed consent, quarantine-by-move), `genie sec restore <id>` (per-action undo), and `genie sec rollback <scan_id>` (bulk undo via audit log). Credential rotation is command-emission only in v1 — never calls cloud APIs. The wish also specifies quarantine disk-space limits + GC, handles offline-provider credential paths, and degrades gracefully on shared filesystems where `0600` mode cannot be enforced.

## Preconditions

- **Umbrella committed:** `canisterworm-incident-response/DESIGN.md` exists and was approved.
- **Base branch:** `codex/sec-scan-command` merged to `main` (per umbrella Preconditions).
- **Depends on `sec-scan-progress` shipping** for the versioned JSON envelope (`scan_id`, `reportVersion: 1`), events-file schema with `action.start`/`action.end` stubs, audit-log plumbing at `$GENIE_HOME/sec-scan/audit/<scan_id>.jsonl`, and persistence at `$GENIE_HOME/sec-scan/<scan_id>.json`.
- **Signature verification dependency gate.** Group 1 *implementation* may proceed in parallel with `genie-supply-chain-signing` and use a placeholder for the `--unsafe-unverified` contract. Group 1 *integration tests* (and the apply-mode CI gate) are explicitly blocked on `genie-supply-chain-signing` Group 2 merging to `dev` — the `src/sec/unsafe-verify.ts` helper must exist on `dev` before `sec-remediate` Group 1 can merge. Pre-merge local builds use `--unsafe-unverified <INCIDENT_ID>` with prominent stderr warning + audit-logged ack. When signing G2 lands, default flips to require verification.

## Scope

### IN

**Remediate core**
- New `scripts/sec-remediate.cjs` payload (sibling CJS to `scripts/sec-scan.cjs`, no detection code).
- `genie sec remediate` subcommand with modes: `--dry-run` (default), `--apply --plan <path>`, `--resume <resume-file>`.
- `--dry-run` consumes scan JSON (via `--scan-report <path>` or `--scan-id <ulid>` resolved from `$GENIE_HOME/sec-scan/`) and produces a plan manifest at `$GENIE_HOME/sec-scan/plans/<scan_id>-<dryrun-ts>.json` (mode `0600`).
- Plan schema: `{plan_id, scan_id, generated_at, actions: [{action_id, action_type, finding_ref, target_path, proposed_quarantine_path, sha256_before, reason}]}`.
- `--apply --plan <path>` validates plan integrity (plan's `scan_id` must reference a persisted scan; `sha256_before` must match current file state — refuses on drift). Refuses when running binary is not signature-verified (unless `--unsafe-unverified <INCIDENT_ID>` + typed ack per contract from `genie-supply-chain-signing`).
- Per-finding typed confirmation string: `CONFIRM-QUARANTINE-<first-6-of-action-id>`. Keystroke prompts are prohibited.
- Prompt text per action: IOC hit, absolute path, action verb, sha256 prefix, one-line reason.

**Quarantine semantics**
- Quarantine is atomic `rename` into `~/.genie/sec-scan/quarantine/<iso-timestamp>/<action_id>/<original-basename>`.
- Sidecar manifest `action.json` per action: `{action_id, scan_id, plan_id, original_path, quarantine_path, ioc_hit, sha256_before, sha256_after, size_bytes, ts_before, ts_after, operator_uid, dry_run: false, reversal_token, actor: "remediate"}`.
- Quarantine is always move, never delete.
- On filesystems without atomic `rename` across mount boundaries, refuse with actionable error ("target and quarantine on different devices — re-run with `--quarantine-dir <same-device-path>`").

**Process-finding remediation**
- `--kill-pid <pid>` requires a matching live-process finding in the plan + typed confirmation + records `pre_state` (`ps -o comm=,pid=,ppid=,uid=,args=`) and `post_state` (`kill -0` exit code) in audit log.
- No automatic process kill without explicit per-PID flag.

**Credential rotation (command-emission only in v1)**
- `--apply` on a credential-rotation finding prints exact rotation commands to stdout and appends them to the audit log. Never calls APIs.
- Per-provider templates: npm (`npm token revoke`, with `npm token list` preamble), GitHub (`gh auth refresh --scopes` + manual URL for PAT rotation), cloud IAM (`aws sts get-caller-identity`, `gcloud auth revoke`, `az logout`), Anthropic/OpenAI (manual web-UI URLs with warning that no CLI rotation exists).
- **Offline/unreachable-provider guidance (reviewer G2)**: every emitted rotation block includes a fallback comment: `# If provider is unreachable: rotate via <web-URL> or <alternate-channel> — record completion in audit log manually`. Fallback web URLs are part of the per-provider template table.

**Resume + restore + rollback**
- Resume file at `$GENIE_HOME/sec-scan/resume/<scan_id>.json` on any partial failure. `--resume <resume-file>` reads it and continues from the next unexecuted action.
- `genie sec restore <quarantine-id>` reads sidecar manifests under `~/.genie/sec-scan/quarantine/<id>/`, restores each file to original path with sha256 verification, emits `action.restore` audit events. Partial restore writes its own resume file.
- **`genie sec rollback <scan_id>`** (reviewer G1): walks the audit log for the given `scan_id` in reverse action-time order, calls `restore` on each quarantined action, emits a summary (`rollback_summary.json`). Use case: "remediation completed, but app won't start" — one command undoes everything.
- Completion banner of remediate prints: quarantine id, action count, audit-log path, exact `genie sec restore <id>` and `genie sec rollback <scan_id>` commands.

**Coverage-gap gate**
- Pre-apply check: if feeding scan has `coverage.caps_hit > 0` or `coverage.skipped_roots > 0`, remediate refuses unless `--remediate-partial` + typed ack (`CONFIRM-INCOMPLETE-SCAN-<first-6-of-scan-id>`) is supplied.

**Disk-space safety (reviewer G3)**
- Quarantine directory size logged at completion. If >100MB, emit stderr warning banner recommending `genie sec restore` or manual GC of old quarantine dirs.
- `genie sec quarantine list` subcommand enumerates quarantine dirs with timestamp, size, status (active / restored / abandoned).
- `genie sec quarantine gc --older-than <duration>` subcommand deletes restored-or-abandoned quarantine dirs older than the threshold (refuses without `--older-than`; refuses active quarantines; typed confirmation required).

**Filesystem degradation (reviewer G4)**
- Test-assert `0600` via `fs.statSync().mode`. On filesystems without POSIX mode semantics (FAT32, some network mounts), emit stderr warning but do not fail. Warning names the filesystem and explicitly tells the operator the audit log may be world-readable.

**Audit log**
- Every action (dry-run or apply) appends to the shared audit log established by `sec-scan-progress`. Actor field distinguishes `scanner` / `remediate` / `restore` / `rollback` entries.
- `fsync`-per-event; append-only; mode `0600` with FAT32 warning path.

### OUT

- Live API credential rotation (v1 emits commands only). Real API rotation is a future wish with per-provider OAuth + scoped-token infrastructure.
- Scanner observability work (owned by `sec-scan-progress`).
- Cosign/SLSA signing infrastructure (owned by `genie-supply-chain-signing`).
- SECURITY.md invariants + full incident runbook (owned by `sec-incident-runbook`).
- Network egress firewalling during remediation.
- Automated rollback after post-remediation health check — rollback is operator-invoked, not automatic.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Sibling CJS payload (`scripts/sec-remediate.cjs`), not inline in `sec-scan.cjs` | Different blast radii, different review bars, different signing posture |
| 2 | Dry-run default; `--apply` requires frozen plan manifest | Closes TOCTOU between observation and mutation |
| 3 | Quarantine is atomic move + sidecar, never delete | False-positive IOCs must be reversible; attacker-poisoned IOC lists must be survivable |
| 4 | Typed consent string is exact: `CONFIRM-QUARANTINE-<6-hex>` | Keystroke prompts are trivially mis-fired under incident pressure |
| 5 | Credential rotation is command-emission only in v1 | Real rotation is provider-specific + requires OAuth; v1 stays auditable |
| 6 | `rollback <scan_id>` as a top-level undo, not just per-quarantine-id restore | Reviewer G1: monitoring catches breakage post-remediation; bulk undo is operator affordance |
| 7 | Quarantine size warning + `gc` subcommand | Reviewer G3: 10GB of quarantined caches can fill `$HOME` silently |
| 8 | Mode `0600` with warn-not-fail on FAT32 | Reviewer G4: permissions theater on shared FS; explicit warning > silent fail |
| 9 | `--unsafe-unverified <INCIDENT_ID>` exact-string contract defined by `genie-supply-chain-signing` | Reviewer M2 (HIGH): undefined ack = implementation guess; contract lives in signing wish |
| 10 | Offline-provider fallback URLs embedded in rotation command templates | Reviewer G2: command emission alone doesn't help when provider is unreachable |

## Success Criteria

- [ ] `genie sec remediate --dry-run --scan-id <ulid>` writes a plan manifest (`0600`).
- [ ] `--apply` without `--plan` refuses with clear error.
- [ ] `--apply --plan <path>` on a stale plan (sha256 drift) refuses with exact drifted-path name.
- [ ] `--apply` on unverified binary refuses unless `--unsafe-unverified <INCIDENT_ID>` passed; the INCIDENT_ID + typed ack is logged in audit.
- [ ] Typed confirmation `CONFIRM-QUARANTINE-<6-hex>` enforced; partial strings rejected.
- [ ] Quarantine moves files to `~/.genie/sec-scan/quarantine/<ts>/<action_id>/`; sidecar present and matches schema; original path empty.
- [ ] `genie sec restore <quarantine-id>` restores all actions; sha256 matches `sha256_before`.
- [ ] `genie sec rollback <scan_id>` walks audit log in reverse and undoes every action.
- [ ] Resume after mid-apply SIGINT completes without re-executing applied actions.
- [ ] `--remediate-partial` refuses on capped scan unless correct typed ack.
- [ ] Credential-rotation findings emit commands only; network mock asserts zero outbound requests.
- [ ] Offline-fallback URL comments appear in rotation templates.
- [ ] Quarantine size >100MB emits warning banner.
- [ ] `genie sec quarantine gc --older-than <duration>` refuses active quarantines; requires typed confirmation.
- [ ] Mode `0600` assertion passes on Linux; FAT32 mock emits warning without failing.
- [ ] Audit log is append-only + `fsync`-per-event (truncation-resistant test).
- [ ] Cross-device quarantine attempt refused with actionable error.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Remediate core: dry-run, plan manifest, typed consent, quarantine-by-move, resume, restore, credential-command-emission (incl. offline fallbacks). |
| 2 | engineer | `rollback <scan_id>` bulk undo, quarantine `list`/`gc` subcommands, disk-space warnings, FAT32 warn-not-fail, cross-device refusal. |

## Execution Groups

### Group 1: Remediate Core — dry-run, plan, consent, quarantine, restore, resume, credential-emission

**Goal:** Ship the primary `genie sec remediate` surface with its safety rails and the per-finding credential-emission pathway.

**Deliverables:**
1. `scripts/sec-remediate.cjs` payload + `src/term-commands/sec.ts` subcommand dispatch for `remediate` and `restore`.
2. `--dry-run` mode + plan-manifest writer.
3. `--apply --plan <path>` mode with sha256-before drift check + signature-verification check (calls `genie sec verify-install` when available; falls back to `--unsafe-unverified` posture with prominent warning).
4. Typed confirmation `CONFIRM-QUARANTINE-<6-hex>` prompt handler.
5. Quarantine-by-move (atomic `rename` into `~/.genie/sec-scan/quarantine/<ts>/<action_id>/`) + sidecar manifest writer.
6. `--resume <resume-file>` handler + resume-file writer on partial failure.
7. `genie sec restore <quarantine-id>` subcommand with sha256 verification + per-restore audit events.
8. Credential-rotation command templates for npm / GitHub / AWS / GCP / Azure / Anthropic / OpenAI, each with an offline-fallback URL comment block.
9. `--kill-pid <pid>` handler gated on plan match + typed confirmation.
10. Cross-device quarantine refusal with actionable error.
11. `scripts/sec-remediate.test.ts`: typed-consent enforcement, plan-drift rejection, quarantine atomicity, restore round-trip, resume idempotency, credential-network-mock (asserts zero outbound requests), cross-device refusal.

**Acceptance Criteria:**
- [ ] Dry-run → apply → restore round-trip on CanisterWorm fixture: original file unchanged, sha256 matches pre-remediation.
- [ ] Plan drift: mutating the target file between dry-run and apply triggers refusal with drifted-path in error message.
- [ ] Typed-consent unit test: `CONFIRM-QUARANTINE-123abc` accepts; `CONFIRM-QUARANTINE` and `yes` and empty string all reject.
- [ ] Resume: SIGINT mid-apply → resume file written → `--resume` completes without re-executing applied actions.
- [ ] Credential rotation: network-mocked test asserts zero `fetch`/`http.request` calls; stdout contains both the primary rotation command and the offline-fallback URL comment.
- [ ] `--kill-pid <pid>` refuses when no matching live-process finding exists in the plan.
- [ ] Cross-device quarantine attempt refused with `EXDEV`-aware error message.

**Validation:**
```bash
bun test scripts/sec-remediate.test.ts scripts/sec-scan.test.ts src/term-commands/sec.test.ts
bun run typecheck
bunx biome check scripts/sec-remediate.cjs scripts/sec-remediate.test.ts src/term-commands/sec.ts src/term-commands/sec.test.ts
scripts/sec-remediate.cjs --dry-run --scan-id <test-ulid> --json
scripts/sec-remediate.cjs --apply --plan /tmp/plan.json --unsafe-unverified TEST_HARNESS_2026_04_23
genie sec restore <test-quarantine-id>
```

**depends-on:** none

---

### Group 2: Bulk Rollback, Quarantine Lifecycle, Degradation Paths

**Goal:** Ship the operator affordances that make remediation safe at scale — bulk undo, disk-space hygiene, and graceful degradation on non-POSIX filesystems.

**Deliverables:**
1. `genie sec rollback <scan_id>` subcommand: walks `$GENIE_HOME/sec-scan/audit/<scan_id>.jsonl` in reverse action-time order, calls `restore` on each quarantined action, emits `rollback_summary.json`.
2. `genie sec quarantine list` subcommand enumerating quarantine dirs with columns `id`, `timestamp`, `size`, `status`, `scan_id`.
3. `genie sec quarantine gc --older-than <duration>` subcommand with typed confirmation, refusing active quarantines.
4. Completion banner on remediate prints both `restore` and `rollback` commands so operators see the bulk-undo path upfront.
5. Disk-space warning: at completion of `--apply`, compute quarantine dir size; if >100MB emit stderr banner naming exact size + `quarantine list` / `gc` hints.
6. Mode-`0600` warn-not-fail: test asserts warning banner on a mock FAT32 mount; no failure.
7. Audit-log integrity test: opens log with `O_APPEND`, attempts `ftruncate`, asserts truncation refused on supported filesystems.
8. Rollback summary schema: `{rollback_id, scan_id, started_at, finished_at, actions_undone, actions_failed: [{action_id, reason}], duration_ms}`.

**Acceptance Criteria:**
- [ ] `genie sec rollback <scan_id>` after a complete apply restores every file; original paths re-populated; sha256 matches `sha256_before` from sidecar.
- [ ] Partial rollback: one action fails → summary records it in `actions_failed`; non-failing actions still undone.
- [ ] `quarantine list` shows correct size, status, timestamp.
- [ ] `quarantine gc --older-than 30d` refuses active quarantines; succeeds only on restored/abandoned ones; requires `CONFIRM-GC-<6-hex>` typed.
- [ ] `quarantine gc` without `--older-than` refuses with clear error.
- [ ] Remediate completion banner contains both `restore` and `rollback` commands verbatim.
- [ ] Quarantine size 150MB fixture triggers stderr banner with exact size printed.
- [ ] FAT32 mock test: `0600` warning emitted; no failure; audit-log still writeable.
- [ ] Audit-log truncation-attempt test passes on Linux ext4 (refusal) + emits warning on non-POSIX FS.

**Validation:**
```bash
bun test scripts/sec-remediate.test.ts
bun run typecheck
bunx biome check scripts/sec-remediate.cjs scripts/sec-remediate.test.ts src/term-commands/sec.ts src/term-commands/sec.test.ts
scripts/sec-remediate.cjs --apply --plan /tmp/plan.json --unsafe-unverified TEST_HARNESS
genie sec rollback <test-scan-id>
genie sec quarantine list
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] Dry-run writes plan manifest (`0600`); `--apply` without plan refuses.
- [ ] Plan-drift refusal: mutate target between dry-run and apply → apply refuses with drifted-path.
- [ ] Typed confirmation `CONFIRM-QUARANTINE-<6-hex>` enforced (unit + integration).
- [ ] Quarantine is move-not-delete; sidecar + audit entry present.
- [ ] `genie sec restore <id>` restores cleanly with sha256 verification.
- [ ] `genie sec rollback <scan_id>` undoes all actions in reverse order; partial rollback reports failed actions.
- [ ] `--resume` after SIGINT completes idempotently.
- [ ] Credential-rotation network-mock: zero outbound requests; commands + offline-fallback URLs both emitted.
- [ ] `--remediate-partial` refuses on capped scan unless typed ack correct.
- [ ] Quarantine size >100MB emits stderr banner.
- [ ] `genie sec quarantine gc --older-than 30d` refuses active; requires typed confirmation.
- [ ] FAT32 mode-`0600` warn-not-fail path.
- [ ] Cross-device quarantine refused with actionable error.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Attacker-poisoned IOC list triggers mass remediation | Critical | Quarantine-by-move only; typed per-action confirmation; `--remediate-partial` gated; plan manifest required; signature verification required unless explicit override; audit log append-only |
| Unsigned local build runs `--apply` | Critical | Default refusal on signature mismatch when `genie-supply-chain-signing` ships; pre-ship interim is `--unsafe-unverified <INCIDENT_ID>` with prominent warning + audit-logged ack |
| Remediate acts on stale plan manifest (TOCTOU) | High | `--apply` verifies `sha256_before` matches current file state; refuses on drift |
| SIGINT mid-remediate leaves half-applied state | High | Resume file written on every failure; `--resume` picks up cleanly; quarantine atomic per-action |
| Bulk rollback misbehaves (partial undo succeeds then fails) | High | Summary records failed actions with reason; operator can re-run rollback or `restore` individually |
| Quarantine fills `$HOME` silently | Medium | >100MB warning; `quarantine list` + `gc` subcommands; GC refuses active quarantines |
| Credential rotation commands become stale (provider URL changes) | Medium | Each per-provider template is a small file referenced by sec-incident-runbook; runbook wish tests URLs resolve (HEAD check in CI) |
| Cross-device quarantine (target and `~/.genie` on different mounts) | Medium | Actionable refusal + `--quarantine-dir <path>` override to co-locate on target device |
| `0600` theater on shared FS | Medium | Warn-not-fail; audit log path in warning names the exposure |
| Operator overuses `--unsafe-unverified` for convenience | Medium | `<INCIDENT_ID>` contract defined by signing wish; typed ack logged in audit; runbook documents legitimate contexts |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
scripts/sec-remediate.cjs                   # create: dry-run, apply, resume, quarantine, restore, rollback, quarantine list/gc, credential emission
scripts/sec-remediate.test.ts               # create: typed consent, plan drift, resume, network-mock, rollback, FAT32 warn, cross-device refusal
src/term-commands/sec.ts                    # modify: add remediate, restore, rollback, quarantine subcommands
src/term-commands/sec.test.ts               # modify: subcommand dispatch tests

# Test fixtures
test-fixtures/canisterworm/                 # existing; reused for remediate round-trip tests
test-fixtures/cross-device-quarantine/      # create: harness for EXDEV refusal
test-fixtures/fat32-mock/                   # create: mock-fs harness for 0600 warn path
```
