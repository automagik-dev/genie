# Wish: agent-sync-hardening — close the ultracode blockers before the stable pointer flips

| Field | Value |
|-------|-------|
| **Status** | EXECUTING — 5 parallel fix lanes dispatched 2026-07-10 on the PR #2546 head |
| **Slug** | `agent-sync-hardening` |
| **Date** | 2026-07-10 |
| **Author** | Felipe (planned with Fable 5) |
| **Appetite** | small (1 day — fix wave, not a redesign) |
| **Branch** | `takeover/codex-first-class` (PR #2546) |
| **Design** | Ultracode review dossier 2026-07-10 (stable-bound delta 2fe685f1..origin/dev): PR-comment triage #2540–#2544 + 26 independent findings through 2-skeptic adversarial verification |

## Summary

The ultracode review of the shipped agent-sync delta (2026-07-10) returned **NOT SAFE TO PROMOTE**: 3 HIGH + 4 MEDIUM defects, all missed by the PR bots, several triggered by the promotion itself — the SessionStart hook fires a full unattended binary update on every pre-contract CLI, the sync engine has zero cross-process guarding against multi-pane `genie launch` races, and the entire hook delegation path ships untested. `genie uninstall` additionally destroys user-modified managed skill dirs and then deletes its own backups. **The stable pointer flip is HELD until B1–B7 land.** This wish tracks that fix wave; it ships together with the codex first-class integration on PR #2546.

## Defects (B1–B7, from the dossier)

| # | Sev | Defect | Anchor |
|---|-----|--------|--------|
| B1 | HIGH | SessionStart delegation triggers a full unattended update on pre-contract CLIs — old binaries ignore `GENIE_UPDATE_SYNC_ONLY`, auto-confirm when non-TTY, never write the throttle marker → silent download + binary swap per session start, 45s SIGTERM mid-swap risk | `plugins/genie/scripts/smart-install.js:444` |
| B2 | HIGH | No cross-process lock on the sync engine — N simultaneous session starts all pass the stale throttle and race the rename dance on live skill dirs (ENOTEMPTY, deleted live trees) | `src/lib/agent-sync.ts:275` |
| B3 | HIGH | Hook delegation path completely untested (`findGenieBinary`, `agentSyncThrottleAllows`, `delegateAgentSync`, `stampCouncilFallback`) — known-broken edges include future-dated marker suppressing sync forever | `plugins/genie/scripts/smart-install.js:406–495` |
| B4 | MEDIUM (data loss) | Uninstall deletes user-MODIFIED managed skill dirs on marker alone — no digest check, no backup — then deletes `~/.genie/state-backups/` itself; contradicts "only ever touch what genie provably shipped" | `src/genie-commands/uninstall.ts:89,167–179,231–235` |
| B5 | MEDIUM | Reinstall via `curl \| bash` syncs agents from STALE canonical trees — `normalizeAuxLayout` never swaps a fresh `bin/<name>` over an existing canonical target; doctor reports all-current | `src/genie-commands/install.ts:49` (+ `install.sh:265`, `agent-sync.ts:156`) |
| B6 | MEDIUM | Windows: shell probe detects `.cmd` shims that shell-less `execFileSync` cannot spawn (EINVAL) — sync fails every session start AND the /council fallback stamp is suppressed on exactly the machines it exists for | `plugins/genie/scripts/smart-install.js:410,444,496` |
| B7 | MEDIUM (docs truth) | README's "On every run" convergence claim is false for the exact update that DELIVERS agent-sync (old binary has no sync phase); the one-time caveat existed nowhere user-visible | `plugins/genie/README.md:44` |

Fast-follows F1–F10 and the deferred log stay in the dossier and are tracked against this wish post-promotion — they do not gate the pointer flip.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | B1 fix = delegation-flag hard guard, not a version probe | Invoke a flag/contract an old binary *cannot* misread — an unknown flag makes old commander error out immediately with no network. A version probe leaves a parse-fragile window and still spends a spawn on every pre-contract machine. Throttle marker written from the hook side so failures can't retry every session start. |
| 2 | B4 fix = kept-dir over surviving-backup | On digest mismatch, rename the modified dir in place (`<dir>.genie-kept`) rather than copying to a backup location uninstall might also own — the user's data stays where the user put it, survives `~/.genie` removal by construction, and the confirmation prompt can name it. |
| 3 | Ship with codex first-class on PR #2546 | The fixes and the codex integration land as one reviewed delta on `takeover/codex-first-class`; one CI gate, one merge, then the pointer flip. No separate hardening PR racing the promotion. |

## Success Criteria

- [ ] **B1**: hook delegation is impossible for a pre-contract binary to misread (errors out, zero network); throttle marker written hook-side before/around the spawn so a failing delegation cannot loop every session start
- [ ] **B2**: cross-process lock (`O_EXCL` lockfile with stale-lock age-out) guards the sync engine; second process skips with an advisory; throttle marker written at sync *start*; multi-process interleave test green per the repo's `Promise.allSettled()` norm
- [ ] **B3**: spawn-based tests cover the hook path with a fake `genie` on PATH + `GENIE_HOME` fixture — throttle boundaries (absent/stale/fresh/future-dated/NaN marker), delegation success writes marker, delegation failure routes to the council fallback
- [ ] **B4**: uninstall digest-verifies every managed dir; divergent dirs are kept (renamed, named in the prompt), never silently deleted; backups are not self-destroyed; divergent-digest test in `uninstall.test.ts`
- [ ] **B5**: reinstall over an existing install converges agents from the FRESH extracted trees (atomic swap or unconditional prefer-extracted), never stale canonical content
- [ ] **B6**: delegation exec succeeds on Windows `.cmd` shims (`shell: IS_WINDOWS` parity with the probe); delegation failure falls through to `stampCouncilFallback()` + marker write
- [ ] **B7**: `plugins/genie/README.md` carries the one-time delivery caveat (old binary only swaps — run `genie update` once more or let the hook converge within ~6h); stable release notes repeat it
- [ ] Integrator: full `bun run check` green on the combined branch; review SHIP; only then does the stable pointer flip

## Execution Strategy

Five parallel fix lanes in one worktree on the PR #2546 head, exclusive file ownership per lane; the integrator owns commits and the full gate.

| Lane | Defects | Complexity | Model | Files (exclusive) |
|------|---------|------------|-------|-------------------|
| hook | B1 + B3 + B6 | 4 (delegation guard, Windows parity, spawn tests) | inherit (fable·max) | `plugins/genie/scripts/smart-install.js` + new hook-path tests |
| engine | B2 | 3 (O_EXCL lock, stale age-out, multi-process test) | inherit (fable·max) | `src/lib/agent-sync.ts`, `src/lib/agent-sync.test.ts` |
| uninstall | B4 | 3 (digest classify, kept-dir rename) | inherit (fable·max) | `src/genie-commands/uninstall.ts`, `src/genie-commands/uninstall.test.ts` |
| install | B5 | 3 (atomic swap, VERSION/digest guard) | inherit (fable·max) | `src/genie-commands/install.ts` (+ installer seam) |
| wish/docs | B7 + this document | 1 (docs only) | inherit (fable·max) | `plugins/genie/README.md`, this WISH, `.genie/INDEX.md` |

**Validation:** targeted `bun test <file>` per lane; the integrator runs the single full `bun run check` (parallel full gates collide) and commits.
