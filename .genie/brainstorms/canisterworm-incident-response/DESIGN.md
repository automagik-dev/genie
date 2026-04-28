# Design: CanisterWorm Incident Response (Umbrella)

| Field | Value |
|-------|-------|
| **Slug** | `canisterworm-incident-response` |
| **Date** | 2026-04-23 |
| **Status** | CRYSTALLIZED (WRS 100/100) |
| **WRS** | 100/100 |
| **Council** | [COUNCIL.md](../sec-scan-progress/COUNCIL.md) (10-perspective deliberation, 2026-04-23) |

## Problem

`@automagik/genie` itself is on the CanisterWorm/TeamPCP IOC list. The scanner that detects the compromise ships through the same npm pipe that was weaponized. Most developers running genie do NOT have EDR/MDM coverage that would act on a JSON report. Operators need the full incident-response kit — observable scanning, bounded walks, structured telemetry, signed releases, auditable remediation, and a tested runbook — the first time they reach for it.

A single monolithic wish absorbing all of that was drafted and reviewed. Two independent reviewers (one self, one dispatched) returned BLOCKED citing: (H1) circular dependency between remediation and signing, (H2) three wish-sized scopes bundled into one long-lived branch, (H3) unmerged base branch `codex/sec-scan-command` amplifying rebase drift, plus missed gaps (G1: no bulk rollback, G2: offline credential rotation guidance, G3: quarantine disk-space, G4: `0600` mode theater, M2: `--unsafe-unverified` ack string undefined). Fixing structure in the monolith would preserve the single-PR narrative at the cost of a 6–8 week sequential branch.

This umbrella replaces the monolith with **four sibling wishes** that deliver the same full scope, independently shippable, with a clean dependency graph. Nothing from the council recommendations is dropped; the delivery topology changes.

## Scope

### IN (shared across sibling wishes)

- Full CanisterWorm incident-response posture as captured in COUNCIL.md — observability, bounded walks, load-bearing-code-only, versioned telemetry, detect-→-exec pathway, detect-→-remediate pathway, signed distribution, incident runbook.
- Four sibling wishes with explicit cross-wish dependencies.
- Shared architectural invariants (detect-only scanner; remediation as sibling CJS payload; quarantine-by-move; signed-channel for mutation; audit-log append-only).

### OUT

- Replacing the scanner with a daemon, worker pool, or TUI dashboard.
- Expanding CanisterWorm/TeamPCP IOC coverage (separate wish if a new family lands).
- Scanning every mounted filesystem by default.
- Automated credential rotation against live cloud APIs (v1 emits commands only).
- Network-delivered IOC list updates.
- Destructive delete in quarantine.

## Preconditions

- ✅ **`codex/sec-scan-command` merged via PR #1348** (squash into `dev`, 2026-04-23T17:53Z). Scanner files live on `origin/main` and `origin/dev` at commit `3d7e6609`. Sibling wishes branch from `dev`. This removes the long-lived-branch risk the reviewer flagged as H3.

## Sibling Wishes

| Slug | Scope | Appetite | Depends on |
|------|-------|----------|-----------|
| [`sec-scan-progress`](../../wishes/sec-scan-progress/WISH.md) | Runtime context, versioned envelope, CLI, bounded walks, `dev:ino`, phase measurement, fs fingerprint, deletion pass, matcher collapse, phase registry, events file + redaction, persistence + audit log, `print-cleanup-commands`. | medium (~4 weeks) | codex/sec-scan-command merged |
| [`sec-remediate`](../../wishes/sec-remediate/WISH.md) | `genie sec remediate` (dry-run, plan manifest, typed consent, quarantine-by-move, resume), `genie sec restore` (per-action), `genie sec rollback` (bulk via audit log), offline credential-rotation guidance, quarantine disk-space limits and GC. | medium (~2 weeks) | sec-scan-progress (for versioned envelope + events schema) |
| [`genie-supply-chain-signing`](../../wishes/genie-supply-chain-signing/WISH.md) | Cosign-signed release tarballs + SLSA Level 3 provenance, public-key pinning in three channels, `genie sec verify-install` subcommand, `--unsafe-unverified <INCIDENT_ID>` exact contract. | medium (~2 weeks) | none (independent release-engineering) — runs parallel with sec-remediate |
| [`sec-incident-runbook`](../../wishes/sec-incident-runbook/WISH.md) | `SECURITY.md` invariants section, `docs/incident-response/canisterworm.md` LIKELY COMPROMISED / LIKELY AFFECTED / OBSERVED ONLY decision tree with exact commands, help-text examples, automated cold-runbook test. | small (~1 week) | sec-remediate + genie-supply-chain-signing (consumes both command surfaces) |

**Total wall-time with parallelism:** ~6 weeks (down from the monolith's 6–8 weeks sequential).

## Approach

### Shared invariants (every wish must honor)

1. **Detect-only scanner.** `scripts/sec-scan.cjs` never mutates state. Any mutating verb is a separate subcommand on a separately-signed channel.
2. **Quarantine is always move + sidecar manifest, never delete.** Every mutating action is reversible via `genie sec restore` (per-action) or `genie sec rollback` (bulk).
3. **Append-only audit log.** `$GENIE_HOME/sec-scan/audit/<scan_id>.jsonl`, mode `0600`, `fsync`-per-event, shared between scanner telemetry and remediate actions.
4. **Dry-run is the default.** `--apply` requires a frozen plan manifest produced by a prior `--dry-run` (closes TOCTOU).
5. **Typed confirmation strings are exact.** Keystroke prompts are prohibited. Scanner uses `CONFIRM-QUARANTINE-<6-hex-of-action-id>`. Signing override uses `--unsafe-unverified <INCIDENT_ID>` where `INCIDENT_ID` matches a documented schema.
6. **Signature-verified binary for `--apply`.** `sec remediate --apply` refuses on unverified binary unless `--unsafe-unverified <INCIDENT_ID>` is passed and logged.
7. **Coverage gaps stop remediation.** Capped/skipped roots banner at TOP of scan report; remediate refuses unless `--remediate-partial` + typed ack.
8. **Versioned envelope.** `reportVersion: 1`, `scan_id` (ULID), `hostId`, `scannerVersion`, timestamps, `invocation`, `platform`. Every sibling wish keys off `scan_id`.

### Wish-split rationale

| Rationale | Monolith risk | Split mitigation |
|-----------|---------------|------------------|
| Single-PR narrative preserves atomicity | 6–8 week branch; reviewers can't form an opinion on 2k+ LOC diff | Each wish is a reviewable unit; scan-progress ships first and unblocks remediate |
| Signing and remediate coupled by `--apply` refusal | Workers on Group 6 hit CI failure before Group 7a's signing pipeline exists | Signing runs parallel to remediate; both land; runbook closes loop |
| Runbook content depends on command surfaces | Runbook drifts during 6-week build | Runbook wish starts last, consumes frozen surfaces |
| Council-validated content preserved | — | Every IN bullet from the monolith maps to exactly one sibling wish |

### Reviewer additions absorbed by the split

- **G1** (bulk rollback) → sec-remediate Group 2
- **G2** (offline credential rotation) → sec-remediate Group 1
- **G3** (quarantine disk-space) → sec-remediate Group 2
- **G4** (`0600` mode theater on shared FS) → sec-scan-progress Group 4 + sec-remediate Group 2
- **M2** (`--unsafe-unverified <INCIDENT_ID>` contract) → genie-supply-chain-signing Group 2
- **M3** (cold-runbook automation) → sec-incident-runbook Group 2 as automated test (`scripts/test-runbook.sh` replays commands in a sandboxed fixture)
- **M4** (biome on markdown) → sec-incident-runbook Group 2 uses `markdownlint-cli2` instead
- **H1** (ordering inversion) → resolved by split — signing runs parallel to remediate
- **H2** (bundling) → resolved by split
- **H3** (base branch drift) → resolved by Preconditions above

### Alternatives considered and rejected

- **Single monolithic wish with H1/M2/G1–G4 fixed in place.** Preserves single-PR narrative but accepts 6–8 week branch + rebase risk + reviewer fatigue on 2k+ LOC diffs. Lower schedule predictability than the split.
- **Ship minimal scan-progress now; queue remediate/signing/runbook as future work.** Rejected by user: "we need all of it." Council and reviewer both flagged that queueing remediation for later means operators caught in the next compromise wave have detection without a fix path.
- **Keep remediation out permanently; delegate to platform (EDR/MDM/IAM).** Questioner's position. Rejected because genie's userbase is predominantly developers on laptops without EDR/MDM coverage, and the org that knows what to remediate is the genie team itself.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Split the monolith into 4 sibling wishes under this umbrella | Independent review, independent QA, parallelism between signing and remediate, no long-lived branch |
| Hard-block all siblings on `codex/sec-scan-command` merging to `main` | Removes H3 entirely; cheap win; single upstream pivot |
| Scanner and remediate ship as sibling CJS payloads (`sec-scan.cjs` + `sec-remediate.cjs`) | Different blast radii, different review bars, different signing posture; preserves zero-config install for scanner |
| Signing runs parallel to remediate, not ahead of it | `sec remediate --apply` ships with `--unsafe-unverified` as the interim mode; when signing lands, verification becomes default; no gating on signing timeline |
| COUNCIL.md remains under `brainstorms/sec-scan-progress/` | Historical artifact — captures the deliberation that produced the split; every sibling wish references it |
| `sec-scan-progress` slug stays on the scanner wish | Back-compat with existing task board + council output; sibling wishes take new slugs |

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Sibling wishes drift apart as they ship separately | Medium | Umbrella DESIGN.md is the shared source of truth for invariants; each wish references it in its Preconditions |
| Signing wish delayed; remediate ships without verification | Medium | `--unsafe-unverified` is the interim default; audit log records the flag so a post-hoc signing pass can retroactively mark runs as verified or not |
| Runbook written before command surfaces stabilize | Medium | sec-incident-runbook explicitly depends on sec-remediate + genie-supply-chain-signing; linter in runbook wish checks that every command referenced in `canisterworm.md` is a real subcommand |
| `codex/sec-scan-command` never merges | Low | Each wish has a fallback: branch from `codex/sec-scan-command` with daily main-sync; escalation to Felipe for merge decision |
| User regrets the split mid-execution and asks to re-merge | Low | Sibling wishes can be re-umbrella'd into a release train PR at merge time if desired; wish structure is independent of git branch structure |

## Success Criteria (umbrella-level)

- [ ] All 4 sibling wishes exist with structurally-clean WISHes (`genie wish lint` passes on each).
- [ ] Every IN bullet from the monolith appears in exactly one sibling wish (no gaps, no duplicates).
- [ ] Reviewer's G1–G4 + M2 + M3 + M4 gaps are addressed in the sibling wish that owns them.
- [ ] Dependency graph across siblings is acyclic: scan-progress → remediate (+ signing in parallel) → runbook.
- [ ] COUNCIL.md is referenced from each sibling wish's Preconditions.
- [ ] User approves the split before any sibling wish dispatches to `/work`.

## WRS

██████████ 100/100

Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅ | Preconditions ✅ | Council-validated ✅
