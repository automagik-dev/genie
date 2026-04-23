# Brainstorm: sec-scan-progress

## Seed

`genie sec scan --all-homes --root "$PWD"` can appear stuck for an hour because the scanner does large synchronous filesystem walks and emits no intermediate status. During a security incident, that silence is operationally harmful: users cannot tell whether the scanner is working, what phase is slow, what path is being scanned, or whether they should interrupt and retry with narrower scope.

## Problem

`genie sec scan` needs visible progress, bounded scan behavior, and enough diagnostics for operators to distinguish slow-but-working from stuck or pathological scans.

## Scope

### IN

- Human-readable progress for long scans, including current phase, scanned entries, findings count, elapsed time, and current path or root when useful.
- JSON-safe behavior: final `--json` report must stay parseable, with progress emitted separately or disabled.
- Scan budgets and guardrails for expensive phases such as project roots, temp/cache roots, all-homes scans, and browser extension discovery.
- A final "scan coverage" summary that shows what was scanned, skipped, capped, errored, or timed out.
- CLI options to control progress and scope, such as quiet/no-progress, verbose/debug, and max-duration or per-phase budget settings.
- Tests and fixtures that prove progress appears during slow scans and does not corrupt JSON.

### OUT

- Malware detection expansion beyond the existing CanisterWorm/TeamPCP family.
- Automated remediation or destructive cleanup.
- Rewriting the scanner into a daemon, service, or multi-process architecture.
- Full UI/TUI scan dashboard.

## Alternatives Considered

1. Minimal heartbeat only: print "still running" every N seconds.
   - Lowest effort, but does not tell users which phase or path is slow.
2. Phase-based progress and budgets in the existing scanner process.
   - Good balance. Keeps the scanner deployable as a single CJS payload while making long runs observable and bounded.
3. Full async worker architecture with cancellation and streaming JSON events.
   - Better long-term architecture, but too broad for an urgent post-incident tool improvement.

## Recommended Approach

Use phase-based progress and scan budgets inside the existing `scripts/sec-scan.cjs` payload. Add a small scanner runtime context that owns progress emission, phase timing, entry counts, finding counts, budget checks, and skipped/capped records. Keep the current final report contract intact. For human output, emit progress to stderr so stdout can remain reserved for the final human report; for `--json`, keep stdout as JSON only and emit progress to stderr unless `--no-progress` is passed.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Add a scanner runtime context instead of scattered `console.log` calls | Keeps progress, budgets, and coverage accounting testable and isolated. |
| Emit progress on stderr | Preserves stdout for final report and keeps `--json` machine-readable. |
| Keep one CJS payload | The scanner ships as a universal script; preserving this avoids packaging churn during incident response. |
| Default to bounded scans with explicit caps recorded in the report | Users need the scan to finish and tell them what it could not fully inspect. |
| Add `--verbose` for current path details | Default progress should be useful but not leak too much path detail in logs unless requested. |

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Progress output corrupts JSON automation | High | Emit progress to stderr and test `--json` stdout parsing. |
| Caps hide evidence | Medium | Record every cap/skip in the final coverage summary and provide flags to raise budgets. |
| All-homes scans are slow on network-mounted or huge home directories | High | Add phase budgets, skipped-root reporting, and current root progress. |
| Too much progress noise scares users | Medium | Default to phase summaries and periodic updates; use verbose for path-level diagnostics. |
| Large refactor destabilizes detection logic | Medium | Isolate progress/runtime plumbing and avoid changing IOC matching behavior. |

## Success Criteria

- `genie sec scan --all-homes --root "$PWD"` emits a visible progress update within 5 seconds and at least every configured interval during long phases.
- `genie sec scan --json` produces valid JSON on stdout even while progress is enabled.
- The final report includes a scan coverage section listing phases, roots, entries scanned, findings, errors, capped phases, skipped roots, and elapsed time.
- Slow or huge fixtures can trigger progress, caps, and coverage records deterministically in tests.
- Operators can run with `--no-progress` or `--quiet` for automation, and `--verbose` for path-level troubleshooting.

WRS: ██████████ 100/100
Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
