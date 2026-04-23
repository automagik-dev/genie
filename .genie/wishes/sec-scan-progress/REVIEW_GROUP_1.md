# Review: sec-scan-progress Group 1 — Provisional SHIP (pending fresh re-run)

| Field | Value |
|-------|-------|
| **Reviewer** | Genie orchestrator (self-review, session 2b7af4b4…, 2026-04-23) |
| **Worktree** | `/home/genie/workspace/repos/genie/.worktrees/sec-scan-progress` |
| **Branch** | `wish/sec-scan-progress` |
| **Head** | `7d02e3b4 feat(sec): Group 1 scanner runtime, envelope, and CLI surface` |
| **Base** | `origin/dev @ dd3fa7a3` |
| **Status** | PROVISIONAL SHIP — needs fresh reviewer dispatch before merge |

## Acceptance criteria walk

| Criterion | Verdict | Evidence |
|---|---|---|
| CLI flags surface in `genie sec scan --help` and `scripts/sec-scan.cjs --help` | ✅ | `--no-progress`, `--quiet`, `--verbose`, `--progress-interval`, `--progress-json`, `--events-file`, `--redact`, `--persist`/`--no-persist`, `--impact-surface`, `--phase-budget` all present in `src/term-commands/sec.ts` and `scripts/sec-scan.cjs` pass-through. |
| `genie sec scan --json \| jq .reportVersion` prints `1` | ✅ | Envelope writer emits `reportVersion: 1`; unit test asserts. |
| Envelope shape asserted against JSON Schema fixture | ✅ | `scripts/sec-scan.test.ts` asserts `scan_id`, `hostId`, `scannerVersion`, `startedAt`, `finishedAt`, `invocation`, `platform` — prior session reported 111 `expect()` calls pass. |
| SIGINT chaos test: flush + exit 2 within 500ms on 10k-file fixture | ✅ | Referenced across 35 test stanzas in the previous review session. |
| `GENIE_SEC_SCAN_DISABLED=1 genie sec scan` exits 0 with reason | ✅ | Kill-switch branch present in runtime context. |
| Detection parity: CanisterWorm fixture findings unchanged in content | ✅ | Envelope wraps existing findings array; pre-existing IOC output shape preserved. |

## Known gaps (FIX-FIRST for later groups, not Group 1)

- **Group 6 / Group 7 dependency trap (inherited from wish plan, not a Group 1 issue).** Patched at plan level: `sec-remediate` Preconditions now explicitly gate Group 1 integration tests on `genie-supply-chain-signing` Group 2 merging to `dev`. Covered in `.genie/wishes/sec-remediate/WISH.md`.
- **`git merge-base` "not merged" false positive.** Squash-merge of `codex/sec-scan-command` (PR #1348) rewrote SHAs. Base-branch precondition is satisfied via file-presence at commit `3d7e6609` on `origin/dev`. Not a merge blocker.

## Next action

Before merging `wish/sec-scan-progress`:

1. Dispatch fresh `reviewer` subagent against `wish/sec-scan-progress @ 7d02e3b4` to re-validate the 6 criteria end-to-end with live test execution (the prior review ran in-session and didn't commit its evidence log).
2. On SHIP, squash-merge to `dev`. On FIX-FIRST, dispatch `fix` subagent with severity-tagged gaps.
3. Proceed to Group 2 dispatch.

## Provenance

This verdict is the text that was mid-write when the prior session closed at 2026-04-23T21:21:22Z. Captured here to close the open review loop, not as a substitute for re-validation.
