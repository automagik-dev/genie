# Design: Sec Scan Progress And Bounded Runtime

| Field | Value |
|-------|-------|
| **Slug** | `sec-scan-progress` |
| **Date** | 2026-04-23 |
| **WRS** | 100/100 |

## Problem

`genie sec scan` gives no intermediate feedback during large host scans, so operators cannot tell whether it is working, stuck, or blocked on an expensive filesystem path. More broadly, the CanisterWorm/TeamPCP compromise that motivated this scanner is active, the scanner's own distribution channel (`@automagik/genie`) is on its IOC list, and most developers running genie do not have EDR/MDM coverage to act on a JSON report. A plumbing-only wish will not meet the incident's needs. This design therefore delivers the full incident-response posture — observability, bounded walks, load-bearing-code-only, versioned telemetry, auditable remediation, and supply-chain signing — in one coherent package.

## Scope

### IN

- Add progress reporting to the scanner with phase name, elapsed time, scanned entries, findings count, and current root or path when useful.
- Preserve machine-readable output by keeping final `--json` output valid and emitting progress separately or not at all when disabled.
- Add scan budgets and caps for expensive traversal phases, with skipped/capped coverage recorded in the final report.
- Add CLI controls for progress and troubleshooting, including quiet/no-progress and verbose diagnostics.
- Add tests and fixtures for slow scans, capped scans, JSON output integrity, and final coverage summaries.
- Update security docs so incident responders know how to interpret progress, caps, and coverage gaps.

### OUT

- Expanding malware-family detection coverage.
- Automated remediation, quarantine, or destructive cleanup.
- Replacing the scanner with a daemon, worker pool, or TUI dashboard.
- Scanning every byte of every mounted filesystem by default.

## Approach

Implement a small scanner runtime context inside `scripts/sec-scan.cjs` and thread it through the existing scan phases. The context owns phase lifecycle, progress emission, elapsed timing, entry and finding counters, budget checks, cap/skip records, telemetry events, and coverage summary generation. The scanner stays a single universal CJS payload; mutating code lives in a sibling CJS payload (`scripts/sec-remediate.cjs`) so detection and remediation have different blast radii, different review bars, and can be signed/verified independently.

**Base branch:** this work builds on `codex/sec-scan-command`, not `main` — `scripts/sec-scan.cjs` and `src/term-commands/sec.ts` only exist downstream of that PR. See `WISH.md` Preconditions for the rebase contract.

**Clock boundary:** the runtime context accepts an injectable clock and interval provider. Default wiring uses `Date.now` + `setInterval`; tests substitute a deterministic fake so the "progress within 5 seconds" success criterion can be verified without wall-clock flake.

**Envelope boundary:** the JSON report gets `reportVersion: 1` + `scan_id` (ULID) + `hostId` + `scannerVersion` + timestamps + `invocation` + `platform` as non-optional fields. Every consumer (persisted reports, events file, plan manifests, audit log, remediate input) keys off `scan_id`.

**Detection vs remediation split:** the detection scanner is read-only; `scripts/sec-remediate.cjs` is the ONLY mutating verb. Quarantine is always move (atomic `rename`) into `~/.genie/sec-scan/quarantine/<iso-timestamp>/<action_id>/` with a sidecar manifest. `--apply` requires a frozen plan manifest from a prior `--dry-run` (closes TOCTOU), per-action typed confirmation, and a signature-verified binary (override exists for emergency IR on a burned key). Credential rotation is command-emission only in v1; no outbound API calls.

**Supply-chain signing:** cosign-signed release artifacts with SLSA Level 3 provenance, public key pinned in three independent locations (`SECURITY.md`, `/.well-known/security.txt`, out-of-band channel). `genie sec verify-install` checks the running binary's identity before any mutating operation proceeds.

**Telemetry boundary:** `--events-file <path.jsonl>` is explicit-flag-only (never implicit under `--verbose`). File mode is `0600`, alias sidecar maps `root_id` → path locally, loud stderr banner names the file as incident-sensitive. Silent `catch {}` blocks in `safe*` helpers route caught errors through structured `walk.error` events without changing helper return semantics.

**Scope-shrink boundary:** the simplifier's four cuts (kill `inspectPackageDirectory`'s recursive walk, bound `walkProjectRoots` + cap `COMMON_WORKSPACE_DIRS`, collapse matcher tables + text-walks into one classifier pass, gate `scanImpactSurface` + rebuild `timeline` post-hoc + collapse `main()` into a phase-registry) land as real source changes in Group 3. Detection parity against existing CanisterWorm fixtures is a hard merge gate. Benchmarker's hyperfine baseline (cold + warm, three profiles) ships as a reproducible script (`scripts/sec-scan-bench.cjs`) with fixtures generated deterministically.

**Coverage-gap discipline:** capped/skipped roots render as a banner at the TOP of the human report and flip the exit code to `2`. Remediation refuses to run against a capped scan unless `--remediate-partial` + typed ack ("Incomplete scan; I accept that unreached IOCs may persist") is provided.

**Alternatives considered and rejected by the council:**

- *Ship scan-progress minimal; queue remediation as a separate wish.* Rejected because the CanisterWorm incident does not allow for "detect now, maybe remediate later" — operators need the full kit the first time they reach for it.
- *Delegate remediation to platform tools (EDR/MDM/IAM) and never build it.* Declined because the genie user base is predominantly developers on laptops without EDR/MDM coverage, and the org that knows what to remediate is the genie team itself.
- *Single-file scanner payload with remediation inline.* Rejected — mutating code needs different boundaries and different signing posture than detection code.
- *Measure-first-then-delete ordering.* Partially adopted: Group 2 ships wall/CPU + fs fingerprint instrumentation before Group 3's deletion pass lands, so the deletion has a baseline to beat and a regression fence. Benchmarker's hyperfine runs are part of Group 3's merge gate.
- *Events file default-on under `--verbose`.* Rejected in favor of explicit-flag-only with `0600` + banner; measurer's concern ("security telemetry that's opt-in gets turned off the one night you need it") is addressed by remediate automatically writing its own audit log at a known path.
- *Persist reports only with `--persist`.* Rejected; default-on persistence to `$GENIE_HOME/sec-scan/<scan_id>.json` (mode `0600`, loud banner) is the audit trail that makes remediate possible; `--no-persist` covers ephemeral/CI use.

Alternatives considered:

- Minimal heartbeat: fastest to build but too opaque for incident response because it does not identify the slow phase or root.
- Phase progress in the existing process: recommended because it provides useful operator feedback without packaging churn.
- Full async worker/event architecture: more powerful but too large for the immediate incident-response problem.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Emit progress to stderr | Keeps stdout valid for the final human report or JSON output. |
| Use a central runtime context | Avoids scattering progress and budget logic across every scanner function. |
| Add bounded traversal defaults | A security scanner that can appear hung for an hour is operationally unsafe; caps should be visible and configurable. |
| Record coverage gaps in the report | If a scan stops early or skips a root, the user must know what remains uninspected. |
| Preserve current detection semantics | The wish is about operability, not changing IOC matching behavior. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| Progress output breaks consumers using `--json` | High | Emit progress on stderr and add stdout JSON parse tests. |
| Default caps miss evidence on very large hosts | Medium | Make caps visible in coverage output and configurable by CLI flags. |
| Verbose path output exposes sensitive directory names in shared logs | Medium | Default progress should show phase/root; path-level detail only under `--verbose`. |
| Refactoring the CJS script introduces detection regressions | Medium | Keep changes isolated to runtime/context plumbing and add fixture tests around existing findings. |
| Cross-platform behavior differs on macOS, Linux, and WSL | Medium | Use temp fixtures and platform-agnostic assertions; avoid OS-specific timing assumptions where possible. |

## Success Criteria

- [ ] Long scans emit progress within 5 seconds and continue emitting at the configured interval.
- [ ] `genie sec scan --json` writes parseable JSON to stdout while progress goes to stderr or is disabled.
- [ ] The final report includes scan coverage with phase timings, roots, entries scanned, findings, errors, caps, skips, and elapsed time.
- [ ] Slow and huge fixture tests demonstrate progress, cap recording, and completion without hanging.
- [ ] CLI help documents progress flags, budget flags, and how to interpret capped coverage.
