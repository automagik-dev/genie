# PR 2545 review finding disposition

This ledger deduplicates every finding from the seven specialist lanes and the native reviewer. Aliases: RH = repository hygiene, AR = architecture, SEC = security/supply chain, CQ = code quality, QA = quality engineering, PERF = performance, DX = developer experience/docs, NR = native review in display order. “Inherited” means unchanged from the PR base; it can still block stable release but is not silently mixed into this remediation.

| ID | Source findings | Origin | Disposition / owner | Acceptance evidence | Final evidence |
|----|-----------------|--------|---------------------|---------------------|----------------|
| F01 | RH1 | External gate | E records; GitHub/human action required | Repository CI jobs run and pass on exact final SHA | Pending |
| F02 | RH2 | External gate | OUT of code; human approval required | Independent APPROVED review on final SHA | Pending |
| F03 | RH3, DX4 | PR/exposed | E | Migration caveat in create and promotion/edit notes; hardening criteria mapped | Pending |
| F04 | RH4, SEC10, DX9 | Mixed | Current version-parity/build checks in B/D1/E; inherited verifier contract to stable-release wish | Extracted payload parity passes; inherited verifier remains explicitly blocked | Pending |
| F05 | RH5 | PR | E | Retired metrics state/README marker removed or superseding decision + schema test | Pending |
| F06 | RH6, AR1, DX1, DX6, NR9 | PR/exposed | B | Source copy and extracted plugin contain all valid in-root skills; parity test | Pending |
| F07 | RH7, DX8 | PR | E | Contributor/plugin docs match final CLI, skills, hooks, and agents | Pending |
| F08 | RH8 | PR | E | Build Tarballs PR filters cover all artifact inputs | Pending |
| F09 | AR2, NR2 | PR | A | Portable launcher fixtures preserve stdin/stdout/exit/signals on POSIX/Windows paths | Pending |
| F10 | AR3, SEC4, QA1, PERF1, NR1, NR6 | PR | A | Omni only on PermissionRequest, matched exactly once; timeout/failure deny | Pending |
| F11 | AR4, QA2, QA10, NR4 | PR | A | Canonical apply_patch paths decoded or file-policy hook removed; fixtures prove behavior | Pending |
| F12 | AR5, QA8 | PR | D1 using C API | Manual update refreshes plugin/hooks/agents; sync-only stays bounded | Pending |
| F13 | AR6, SEC9, CQ4, QA3 | PR | C | One digest-backed classifier; modified role artifacts survive refresh/uninstall | Pending |
| F14 | AR7, DX5 | PR | D2 | Root/nested/worktree fixtures keep exactly one usable plugin/fallback MCP route | Pending |
| F15 | AR8 | PR/exposed | A + D2 | Hook config writer removed; TypeScript config owner and runtime choice are consistent | Pending |
| F16 | SEC1 | Inherited CRITICAL | OUT → stable-release-security-gate | Arbitrary-ref stable publish eliminated/protected | Blocking |
| F17 | SEC2 | Inherited HIGH | OUT → stable-release-security-gate | Inputs validated and artifacts bound to approved workflow/ref/SHA | Blocking |
| F18 | SEC3 | Inherited HIGH | OUT → stable-release-security-gate | Third-party actions pinned, frozen installs, least privilege | Blocking |
| F19 | SEC5, SEC7, QA7, PERF2, PERF3, DX7 | PR/exposed | A | H1/H2/H8 removed; H3 bounded; no lifecycle install/config/workspace mutation | Pending |
| F20 | SEC6 | PR/exposed | C | All 36 live skill digests unchanged after isolated fixture tests and read-only comparison | Pending |
| F21 | SEC8, QA11, QA12 | PR | A | Event-specific valid envelopes, previous-binary compatibility, malformed-input fail closed | Pending |
| F22 | CQ1, QA5, DX3, NR3 | PR | B | Manifest formatted; build/version rewrites preserve formatting; full gate green | Pending |
| F23 | CQ2 | PR | D1 | Final/RC/malformed comparison tests pass | Pending |
| F24 | CQ3 | PR | D3 | Non-empty reply invariant rejects unrelated/empty/truncated JSONL | Pending |
| F25 | CQ5, QA4, DX2 | PR | C owns removal results; D1/D2 propagate them through install/update/setup/doctor/init/launch | Failure is nonzero, actionable, retryable; no caller prints false success | Pending |
| F26 | CQ6, NR8 | PR | C | Lock I/O/race/future-time tests never sync without ownership | Pending |
| F27 | CQ7, QA8, QA9, NR7 | PR | D1 | Each tree-swap failure preserves old/fresh artifacts; identical residue removed; digest comparison | Pending |
| F28 | CQ8 | PR | C (uninstall) + D2 (init) | Wrong-shaped valid JSON returns typed/actionable failure, not crash | Pending |
| F29 | CQ9 | PR | D1 | Invalid integration option rejected before cleanup/sync/install finishers | Pending |
| F30 | CQ10 | PR | D2 | One Codex-home resolver with explicit empty-override test | Pending |
| F31 | QA6 | Inherited HIGH | OUT → stable-release-security-gate; D1 covers only the distinct PR-added auxiliary-tree swap | Transactional live-binary/promotion design independently reviewed in the separate wish | Blocking |
| F32 | PERF4 | PR | D2 | Doctor external probes queried once, timed out, and benchmarked against budget | Pending |
| F33 | PERF5 | PR | C | Every runtime integration subprocess has a deadline and structured failure result | Pending |
| F34 | DX10 | PR process | E owns `plugins/genie/codex-agents/genie-reviewer.toml` + tests | Reviewer profile permits temp/cache fixture writes but not repo/live-home mutation | Pending |
| F35 | NR5 | PR | D3 | `--version`, `--help`, `-m` delivered as prompt text via `--` separator | Pending |
| F36 | NR10 | PR | D3 | Missing resume retries fresh once and atomically replaces/clears stale thread state | Pending |
| F37 | Panel detail: interrupted pending Omni request | PR | A | SIGTERM/interruption fixture expires/clears request and emits deny | Pending |
| F38 | Panel detail: review-thread setup/doctor/init/launch gaps | PR | D2 | Timeout, git-root fallback, merge fallback create/update, shellQuote and agent-choice tests | Pending |
| F39 | Panel detail: hook/skill cold-fork and payload measurements | PR | A/B | Reduced hook count; before/after benchmark and payload inventory recorded | Pending |
| F40 | Panel detail: release notes/index/wish drift | PR | E | PR body/docs/wishes/index name exact final version, SHA, disposition, and still-blocked gates | Pending |

## Agent-sync hardening supersession map

The existing `.genie/wishes/agent-sync-hardening/WISH.md` remains authoritative history. It is not marked complete wholesale.

| Existing criterion | New evidence owner | Status rule |
|--------------------|--------------------|-------------|
| B1/B3/B6 SessionStart delegation and compatibility | A, H1/H4/H6, F09/F10/F19/F21/F37 | Supersede only after manifest fixtures and previous-binary tests pass |
| B2 sync lock | C, F26 | Supersede only after race, I/O, stale, and future-time tests pass |
| B4 user-data preservation | C, F13/F20/F25 | Supersede only after fixture and live read-only digest evidence |
| B5 fresh reinstall convergence | D1, F27 | Supersede only after every injected failure/identical-residue test passes |
| B7 release caveat | E, F03/F40 | Supersede only after create/edit notes and final documentation evidence |
| Wave-2 plugin/skills/runtime items | B/C/D2, F06/F12–F15/F22/F30/F32/F33 | Close individually; never infer completion from version equality |

PR-remediation SHIP closes only non-blocking rows with concrete evidence. Rows F16–F18 and F31 continue to block stable promotion through the separate wish even if this PR-scope review later returns SHIP.
