# Wish: Sec Incident Runbook

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `sec-incident-runbook` |
| **Date** | 2026-04-23 |
| **Author** | Genie Council (split from sec-scan-progress monolith per reviewer verdict) |
| **Appetite** | small |
| **Branch** | `wish/sec-incident-runbook` |
| **Repos touched** | `automagik-dev/genie` |
| **Umbrella** | [canisterworm-incident-response/DESIGN.md](../../brainstorms/canisterworm-incident-response/DESIGN.md) |
| **Council** | [../sec-scan-progress/COUNCIL.md](../../brainstorms/sec-scan-progress/COUNCIL.md) |

## Summary

Ship the incident-response prose that ties `genie sec scan`, `genie sec print-cleanup-commands`, `genie sec remediate`, `genie sec restore`, `genie sec rollback`, `genie sec verify-install`, and `--unsafe-unverified` together into one tested operator playbook. `SECURITY.md` documents the architectural invariants and pins the signing public key. `docs/incident-response/canisterworm.md` carries the LIKELY COMPROMISED / LIKELY AFFECTED / OBSERVED ONLY decision tree with exact commands per branch. An automated cold-runbook test replays the commands against a sandboxed fixture so the playbook does not rot.

## Preconditions

- **Umbrella committed:** `canisterworm-incident-response/DESIGN.md` exists and was approved.
- **Depends on `sec-remediate` shipping** for the `remediate` / `restore` / `rollback` / `quarantine list` / `quarantine gc` subcommand surfaces to reference.
- **Depends on `genie-supply-chain-signing` shipping** for `verify-install` subcommand, the `--unsafe-unverified <INCIDENT_ID>` contract, and the pinned public key to mirror.
- **`sec-scan-progress` shipped** for `scan` / `print-cleanup-commands` subcommand surfaces.

## Scope

### IN

**SECURITY.md invariants section**
- New section "Scanner and Remediation Invariants" in `SECURITY.md` at repo root:
  - Scanner is read-only by design.
  - `genie sec remediate` is the only mutating verb; any future mutating verb must obey the same contract (dry-run default, frozen plan manifest, typed per-action consent, quarantine-by-move, signed-channel verification, audit-log append-only).
  - Distribution channel risk: `@automagik/genie` is on the scanner's own IOC list; operators are advised to pin to a post-incident release, run `genie sec verify-install`, and treat any `--unsafe-unverified` usage as incident-documented.
  - IOC list freshness is tied to release cadence; the runbook tells operators when to pin.
- Pinned public-key fingerprint in `SECURITY.md` mirrored byte-identically from `.github/cosign.pub` (owned by `genie-supply-chain-signing`).
- `/.well-known/security.txt` created (or updated) at repo root with same fingerprint + security contact.
- Verification instructions: how to run `cosign verify-blob` manually + how to check the three pinning channels.

**Incident runbook: `docs/incident-response/canisterworm.md`**
- Three-branch decision tree keyed off scanner status bands:
  - **LIKELY COMPROMISED** branch:
    1. `ps -o pid=,comm=,args= -p <pid-from-findings>` to snapshot live processes before any kill action.
    2. Host-level firewall egress to known exfil hosts (`telemetry.api-monitor.com`, `raw.icp0.io`, additional entries from COUNCIL.md): exact `iptables` / `pf` / Windows Firewall commands.
    3. Run `genie sec scan --all-homes --root / --json --persist` with `GENIE_SEC_SCAN_DISABLED` unset; verify signed binary via `genie sec verify-install`.
    4. `genie sec remediate --dry-run --scan-id <id>` → review plan → `genie sec remediate --apply --plan <path>`.
    5. Credential rotation order (from operator's Round 1 council post): npm → GitHub → cloud provider → AI providers. Each step has the exact command block emitted by `--apply` plus the offline-fallback URL.
    6. Image rebuild or snapshot restore.
    7. Post-mortem template with the persisted `scan_id`.
  - **LIKELY AFFECTED** branch: purge cache entries → re-scan → confirm delta empty → rotate credentials that were in env during the compromise window.
  - **OBSERVED ONLY** branch: clear cache entries → re-scan → no credential action unless executing history is later found.
- Each branch maps to exact shell commands using the sibling wishes' subcommand surfaces.
- Escalation paths: `genie sec rollback <scan_id>` if remediation breaks things; `--unsafe-unverified` if key burned.

**Automated cold-runbook test (reviewer M3)**
- `scripts/test-runbook.sh` executes the runbook steps against a sandboxed fixture and times the run.
- Fixture: a Docker-in-Docker or `unshare`-based sandbox with a CanisterWorm IOC seeded at a known path.
- Test harness verifies every referenced command is a real subcommand (parses markdown for ``` ` ``` blocks, runs `--help` on each command, asserts non-error exit).
- Timing gate: total runbook playback completes in <15 minutes on CI runner.
- CI merge-gate: `scripts/test-runbook.sh` runs on every PR that touches `docs/incident-response/canisterworm.md` or `SECURITY.md`.

**`--unsafe-unverified` legitimate-use documentation (reviewer M5)**
- Runbook section "When to use `--unsafe-unverified`":
  - Burned public key (confirmed by Namastex security team; link to rotation procedure).
  - CI pre-signing period (before `genie-supply-chain-signing` ships to a specific release channel).
  - Integration test harness with typed ack format.
  - Explicitly NOT legitimate: "it's faster", "the prompt is annoying", "I don't have the key locally" (without confirmed burn).
- Each legitimate context has an example invocation + audit-log verification step.

**Help-text examples for blast-radius flags**
- Updates to `genie sec scan --help`, `genie sec remediate --help`, `genie sec restore --help`, `genie sec rollback --help`, `genie sec quarantine list --help`, `genie sec quarantine gc --help`, `genie sec verify-install --help`, `genie sec print-cleanup-commands --help`:
  - Every flag that changes blast radius (`--all-homes`, `--root`, `--remediate`, `--apply`, `--plan`, `--impact-surface`, `--remediate-partial`, `--unsafe-unverified`, `--kill-pid`, `--events-file`, `--redact`, `--no-persist`) has a worked example and a "when to reach for this" sentence.

**Link-check + markdown-lint**
- `markdownlint-cli2` replaces biome for markdown sources.
- CI link-check runs on every PR touching docs (asserts internal + external links resolve).

### OUT

- New scanner capabilities or IOC expansion.
- New remediation command surfaces.
- Signing-pipeline changes (owned by `genie-supply-chain-signing`).
- Incident-specific runbook for CanisterWorm variants other than the current family.
- Translations of the runbook into non-English languages.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Runbook lives in `docs/incident-response/canisterworm.md` | Incident-family-named file; future incident families get their own runbooks |
| 2 | Automated cold-runbook test (`scripts/test-runbook.sh`) replays commands in a sandbox | Reviewer M3: manual-cold-run claim can't be CI-enforced; automation makes the gate real |
| 3 | `markdownlint-cli2` replaces biome for markdown sources | Reviewer M4: biome does not lint markdown |
| 4 | Three-branch decision tree keyed off scanner status bands | Operator's Round 1 council post; bands already exist in scanner output |
| 5 | `--unsafe-unverified` legitimate contexts documented in runbook, not in code | Code contract lives in `genie-supply-chain-signing`; runbook documents the human side |
| 6 | Help-text updates are part of this wish, not siblings | Centralizes operator-facing prose in one wish for coherent voice |

## Success Criteria

- [ ] `SECURITY.md` contains "Scanner and Remediation Invariants" section verbatim.
- [ ] `SECURITY.md`, `/.well-known/security.txt`, and the pinned GH-issue fingerprint are byte-identical (CI check asserts).
- [ ] `docs/incident-response/canisterworm.md` has three branches with exact shell commands keyed off scanner status bands.
- [ ] `scripts/test-runbook.sh` exists, completes in <15 minutes on CI, and fails if any referenced command or flag has disappeared.
- [ ] Markdown lint passes on `SECURITY.md` + `docs/incident-response/canisterworm.md`.
- [ ] Link-check passes on all internal + external links in runbook and SECURITY.md.
- [ ] Every blast-radius flag has a worked example + "when to reach for this" sentence in `--help`.
- [ ] `--unsafe-unverified` legitimate contexts + invocation examples documented.
- [ ] Runbook cold-test timed run published in the PR description as evidence.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | `SECURITY.md` invariants section + key pinning mirror + `/.well-known/security.txt` + three-channel fingerprint CI check. |
| 2 | engineer | `docs/incident-response/canisterworm.md` decision tree + `scripts/test-runbook.sh` cold-test + help-text updates + markdownlint/link-check CI. |

## Execution Groups

### Group 1: SECURITY.md Invariants, security.txt, Fingerprint Consistency

**Goal:** Ship the architectural-invariants prose and the public-key pinning mirror across all three channels.

**Deliverables:**
1. `SECURITY.md` "Scanner and Remediation Invariants" section with the four bullets (scanner read-only, remediate-only-mutating-verb, distribution-channel-risk, IOC-freshness).
2. Pinned public-key fingerprint in `SECURITY.md` mirrored from `.github/cosign.pub`.
3. `/.well-known/security.txt` created at repo root (or updated if present) with fingerprint + security contact.
4. CI script `scripts/check-fingerprint-pinning.sh` greps all three channels for the fingerprint and fails if they diverge. Runs as a workflow step on every PR touching `SECURITY.md` or `.github/cosign.pub`.
5. Link to the pinned GitHub issue for the out-of-band channel included in both `SECURITY.md` and `security.txt`.
6. Verification instructions: how to run `cosign verify-blob` manually, how to check the three channels match, how to escalate on fingerprint divergence.

**Acceptance Criteria:**
- [ ] `SECURITY.md` "Scanner and Remediation Invariants" section present with all four bullets verbatim.
- [ ] Fingerprint in `SECURITY.md` byte-matches `.github/cosign.pub` (CI check).
- [ ] `/.well-known/security.txt` exists with matching fingerprint.
- [ ] `scripts/check-fingerprint-pinning.sh` passes locally and in CI.
- [ ] Verification instructions include copy-paste command for operator-side check.

**Validation:**
```bash
bunx markdownlint-cli2 SECURITY.md
scripts/check-fingerprint-pinning.sh
grep -c "$(cat .github/cosign.pub | sha256sum | cut -d' ' -f1)" SECURITY.md .well-known/security.txt
```

**depends-on:** none

---

### Group 2: Incident Runbook, Cold-Test Automation, Help-Text Updates

**Goal:** Ship the three-branch decision tree, the automated playback test that keeps it from rotting, and the help-text examples for every blast-radius flag.

**Deliverables:**
1. `docs/incident-response/canisterworm.md` with:
   - Preamble: when to use this runbook + what scanner output triggers it.
   - LIKELY COMPROMISED branch: 7-step sequence with exact commands.
   - LIKELY AFFECTED branch: 4-step sequence.
   - OBSERVED ONLY branch: 3-step sequence.
   - Escalation paths: `rollback`, `--unsafe-unverified` legitimate contexts.
   - Post-mortem template referencing persisted `scan_id`.
2. `scripts/test-runbook.sh`:
   - Creates a Docker or `unshare` sandbox.
   - Seeds a CanisterWorm IOC fixture.
   - Parses `docs/incident-response/canisterworm.md` for ``` `genie sec ...` ``` blocks.
   - Runs each command with `--help` (dry-mode) to assert subcommand + flags exist.
   - Executes the LIKELY AFFECTED branch end-to-end against the fixture.
   - Times total execution; fails if >15 minutes.
3. `.github/workflows/runbook-test.yml`: triggered on PRs touching `docs/incident-response/canisterworm.md`, `SECURITY.md`, or subcommand sources.
4. Help-text updates in `src/term-commands/sec.ts`:
   - Every blast-radius flag gets `.description(...)` text with a one-sentence "when to reach for this".
   - Every subcommand (`scan`, `print-cleanup-commands`, `remediate`, `restore`, `rollback`, `quarantine list`, `quarantine gc`, `verify-install`) gets `.addHelpText('after', ...)` with a worked example.
5. `--unsafe-unverified` legitimate-context section in runbook with invocation examples + audit-log verification step.
6. Markdown lint + link-check CI workflow (`markdownlint-cli2` + `lychee` or `markdown-link-check`) runs on every docs PR.

**Acceptance Criteria:**
- [ ] Runbook contains three-branch decision tree with exact commands.
- [ ] `scripts/test-runbook.sh` completes in <15 minutes on GitHub Actions CI runner (timing recorded in PR description).
- [ ] Every `genie sec ...` command referenced in runbook exists and passes `--help` dry-mode check.
- [ ] LIKELY AFFECTED end-to-end fixture playback succeeds.
- [ ] Markdown lint + link-check both pass on `SECURITY.md` + runbook.
- [ ] `genie sec scan --help`, `genie sec remediate --help`, etc. all include worked example + "when to reach for this".
- [ ] `--unsafe-unverified` section lists three legitimate contexts with verbatim invocation examples.
- [ ] Post-mortem template present with `scan_id` field placeholder.
- [ ] CI workflow triggers on doc-or-source PRs and fails closed if test-runbook.sh fails.

**Validation:**
```bash
bunx markdownlint-cli2 SECURITY.md docs/incident-response/canisterworm.md
bunx lychee --verbose --no-progress SECURITY.md docs/incident-response/canisterworm.md
scripts/test-runbook.sh --sandbox docker --fixture canisterworm
genie sec scan --help | grep -A2 'when to reach for this'
genie sec remediate --help | grep -A2 'when to reach for this'
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] `SECURITY.md` invariants section present + fingerprint byte-matches `.github/cosign.pub` + `security.txt`.
- [ ] `docs/incident-response/canisterworm.md` runbook three-branch tree exists with exact commands.
- [ ] `scripts/test-runbook.sh` cold-test completes in <15 minutes on CI.
- [ ] Markdown lint + link-check passes on docs.
- [ ] Help-text for every blast-radius flag includes worked example + "when to reach for this".
- [ ] `--unsafe-unverified` legitimate contexts documented with invocation examples.
- [ ] Fingerprint-pinning CI check passes.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Runbook drifts as subcommand surfaces change | High | Automated cold-test is a CI merge-gate; PRs touching subcommands must keep runbook green |
| Fingerprint drift between three pinning channels | High | `scripts/check-fingerprint-pinning.sh` as CI merge-gate; divergence fails the PR |
| Runbook cold-test takes longer than 15 minutes | Medium | Fixture is deliberately minimal; sandbox reuses Docker layers where possible; target runtime is ~5 minutes |
| Operator skips the signed-binary check in a hurry | Medium | Runbook preamble marks `genie sec verify-install` as a non-optional first step |
| `markdownlint-cli2` rejects valid runbook content | Low | `.markdownlint.json` pinned with explicit rules; new rules require PR with justification |
| External links in runbook (GitHub issues, cosign docs) move or 404 | Medium | Link-check in CI catches this; pinned GitHub issues for out-of-band channel are owned by Namastex |
| Post-mortem template fields become stale as envelope evolves | Low | Template lives next to runbook; any envelope-schema change requires runbook PR |
| `test-runbook.sh` sandbox can't run on macOS CI (Docker-in-Docker requirements) | Low | Linux CI runs the full cold-test; macOS CI runs the `--help` dry-mode subset only |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
SECURITY.md                                 # modify: add invariants section + pinned fingerprint + verification instructions
.well-known/security.txt                    # create (or modify): pinned fingerprint + contact
docs/incident-response/canisterworm.md      # modify: full three-branch decision tree
scripts/check-fingerprint-pinning.sh        # create: CI check for fingerprint byte-identity across three channels
scripts/test-runbook.sh                     # create: sandboxed cold-test replay + timing gate
.github/workflows/runbook-test.yml          # create: CI workflow triggering on doc/source PRs
src/term-commands/sec.ts                    # modify: help-text updates per blast-radius flag + per subcommand
.markdownlint.json                          # create (or modify): lint rules for docs
package.json                                # modify: add markdownlint-cli2 + lychee or markdown-link-check as devDeps
```
