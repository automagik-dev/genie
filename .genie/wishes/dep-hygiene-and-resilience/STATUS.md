# Wish Status — dep-hygiene-and-resilience

**Branch:** `wish/dep-hygiene-and-resilience` (cut from `origin/dev` 2026-05-05)
**Worktree:** `/home/genie/workspace/repos/genie-dep-hygiene`

## Done

| Group | Commit | Scope |
|-------|--------|-------|
| **G3** Hook-fallback log security | `1baaf6e5` | Mode 0600 + token-shape redaction at write. New `src/hooks/redaction.ts` (gh / sk / glpat / 40+ hex). 12 new tests, all 31 hook tests pass, typecheck clean. |
| **G4** Postinstall SHA-256 pinning | `bc1cc414` | `package.json#binarySha256` pins 4 tmux tarballs (real upstream SHAs computed). `postinstall-tmux.js` pin-or-fail. `postinstall-hook-binary.js` logs source path (local-compile exempt). `.github/workflows/binary-sha-drift.yml` re-checks pins on PR. Bootstrap doc inside wish dir. Tamper-test verified locally. |

## Not started

| Group | Reason |
|-------|--------|
| **G1** pgserve-wrapper PATH fallback | Lives in sibling `automagik-dev/pgserve` repo. Out-of-branch; needs PR there + version bump here once merged. |
| **G2** TUI pgserve-unreachable degrade panel | Needs new `PgserveUnreachable.tsx` + mocked-pgserve test. Recommend pulling `src/lib/pgserve-recovery.ts` first as the shared recovery-text constant (also used by G6). |
| **G5** pm2 lifecycle | Largest group. Recommend splitting per /review MEDIUM-1: 5a (pm2 declared dep + self-redeploy via `ensurePm2Installed`) and 5b (canonical-supervisor lock + orphan-prevention pidfile semantics). 5a is independently shippable and unblocks G6. |
| **G6** Doctor real probes | Depends on G2 (recovery-text constant) and G5a (`ensurePm2Installed` for `--fix`). |
| **G7** Dep audit + manifest cleanup | Depends on G5 having added `pm2` to manifest first (so audit sees the final shape). |
| **G8** QA / outage replay | Final group; depends on everything. |

## Outstanding /review MEDIUMs

From the Plan-review verdict (SHIP, two MEDIUMs flagged for pre-execution wish edits):

1. **Split G5 → 5a + 5b.** 11 deliverables / 11 tests in one group is the largest in the wish; G6 only needs 5a's `ensurePm2Installed`.
2. **G5 deliverable 7 missing failure path** for `pm2 restart` itself failing. Add a 5th return state `pm2_unavailable` to `routeServeStartThroughPm2()` so recovery doesn't silently fall through to detached-spawn.

Both are wish edits, not implementation — folded into the G5 brief whenever it's picked up.

## /review LOWs (defer, inline during execution)

- darwin variant for `repro-empty-oven-bun.sh` and pidfile parent check
- Document initial SHA bootstrap process (✅ done in `binary-sha-bootstrap.md`)
- Make post-cutover `trustedDependencies` action conditional in G7
- Specify per-probe timeout budgets in G6 (UDS+SELECT=2s, bun/pgserve/tmux=1s each, `Promise.all`)

## Validation gates passed in this session

- `bun test src/hooks/__tests__/redaction.test.ts` — 12/12 pass
- `bun test src/hooks/__tests__/dispatch.test.ts` (regression) — 19/19 pass
- `bun run typecheck` — clean
- `bunx biome check` — clean across all G3+G4 files
- Manual SHA tamper-test — match passes, mutation detected
