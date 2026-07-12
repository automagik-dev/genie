# Wish: agent-sync-hardening — close the ultracode blockers before the stable pointer flips

| Field | Value |
|-------|-------|
| **Status** | BLOCKED — historical PR #2546 plan is superseded criterion-by-criterion by the PR #2545 remediation ledger; exact-SHA CI, human approval, and stable-release blockers remain recorded below |
| **Slug** | `agent-sync-hardening` |
| **Date** | 2026-07-10 |
| **Author** | Felipe (planned with Fable 5) |
| **Appetite** | small (1 day — fix wave, not a redesign) |
| **Branch** | `takeover/codex-first-class` (PR #2546) |
| **Design** | Ultracode review dossier 2026-07-10 (stable-bound delta 2fe685f1..origin/dev): PR-comment triage #2540–#2544 + 26 independent findings through 2-skeptic adversarial verification |

## Summary

The ultracode review of the shipped agent-sync delta (2026-07-10) returned **NOT SAFE TO PROMOTE**: 3 HIGH + 4 MEDIUM defects, all missed by the PR bots, several triggered by the promotion itself — the SessionStart hook fires a full unattended binary update on every pre-contract CLI, the sync engine has zero cross-process guarding against multi-pane `genie launch` races, and the entire hook delegation path ships untested. `genie uninstall` additionally destroys user-modified managed skill dirs and then deletes its own backups. **The stable pointer flip is HELD until B1–B7 land.** This wish tracks that fix wave; it ships together with the codex first-class integration on PR #2546.

> **2026-07-11 supersession note.** The paragraph above is preserved as the historical finding, not current behavior. PR #2545 merged, and follow-up branch `fix/pr2545-ultra-gate` removes the SessionStart updater entirely. [`REVIEW-DISPOSITION.md`](../pr-2545-ultra-release-gate/REVIEW-DISPOSITION.md) maps B1–B7 to current evidence: H3/H4/H6 only; ownership-safe locking/sync/uninstall; transactional auxiliary trees; and explicit one-release migration guidance. The first upgrade from a pre-convergence binary can require one operator-run second `genie update` after the first command returns; no lifecycle hook performs it. This wish is not marked DONE wholesale, and exact-final-SHA CI, human approval, and stable-release blockers remain open.

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

## Dependencies

**depends-on:** pr-2545-ultra-release-gate
**blocks:** none

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

## Review results (ultracode wave 2, 2026-07-10)

Second ultracode pass on the PR #2546 head (`f7629a5f` = B1–B7 landed + codex first-class integration). Three review dimensions (codex-core, hardening-fixes, release-blast); HIGH/MEDIUM findings went through 2-skeptic adversarial verification; LOWs shipped unverified by design. Result: **9 confirmed findings + 1 invented-surface finding + 7 LOWs.** Fix wave 2 dispatched as five parallel lanes (A–E) on 2026-07-10, exclusive file ownership per lane; the integrator fills the fix-commit column at commit time.

### Revision of Decision 1 (B1) — formally acknowledged

W2-6 proves the B1 flag-only hard guard has a gap tier: binaries **v5.260710.5–.9** are env-aware but flag-unaware — they honor `GENIE_UPDATE_SYNC_ONLY=1`, but commander rejects the unknown `--sync-only` flag *before* the env var is ever read, so delegation errors out and those machines lose hook-driven sync until a manual `genie update`. Decision 1 is hereby revised: **version-probe tiering replaces the flag-only guard** — probe the binary version, pass `--sync-only` to contract binaries, invoke env-only (no flag) for the .5–.9 tier, and skip invocation entirely for pre-env binaries. The original rationale (an old binary must be *unable* to misread the contract) is preserved; only the mechanism widens.

### Confirmed findings (9)

W2-1 and W2-2 share one root cause, found independently by two review dimensions; both rows kept, cross-referenced.

| # | Sev | Finding | Anchor | Lane | Fix commit |
|---|-----|---------|--------|------|------------|
| W2-1 | HIGH | resolveBundleRoot never finds installed payload on released binaries — codex+claude integration legs fail on every real install; doctor manifest check warns forever (same root cause as W2-2) | `src/lib/runtime-integrations.ts:29-35` | A | (integrator fills) |
| W2-2 | HIGH | Same root cause as W2-1, independently e2e-proven: normalizeAuxLayout moves bin/plugins away before resolveBundleRoot runs; manifests torn from payload across two roots | `src/lib/runtime-integrations.ts` + `src/genie-commands/install.ts` | A | (integrator fills) |
| W2-3 | HIGH | claude-hooks.json invokes `genie hook dispatch --runtime claude`; every deployed binary rejects the unknown flag → fleet-wide hook dispatch breakage on plugin-first rollout (fail-closed = tool denials) | `plugins/genie/hooks/claude-hooks.json` | B | (integrator fills) |
| W2-4 | MEDIUM | setup --codex force-flips runtime.defaultAgent to codex; launch 'auto' prefers codex over claude; codex pane drops the resolved model pin | `src/genie-commands/setup.ts:396`, `src/term-commands/launch.ts:614` | D | (integrator fills) |
| W2-5 | MEDIUM | installCodexAgents unconditionally clobbers user-modified `~/.codex/agents/genie-*.toml` — no digest check, no backup (B4 data-loss class reintroduced on a new surface) | `src/lib/runtime-integrations.ts:76-88` | A | (integrator fills) |
| W2-6 | MEDIUM | --sync-only hard guard breaks delegation for env-aware flag-unaware binaries v5.260710.5–.9 — commander rejects before env is honored; those machines lose hook sync until manual update (formal revision of B1 Decision 1, above) | `plugins/genie/scripts/smart-install.js:481` | B | (integrator fills) |
| W2-7 | MEDIUM | plugins/genie/.codex-plugin/plugin.json version outside the auto-version pipeline — goes permanently stale one bump after merge | `scripts/version.ts` | E | (integrator fills) |
| W2-8 | MEDIUM | Claude's conventional hooks path (hooks/hooks.json) contains the CODEX hooks — safety rests on every deployed Claude Code honoring the plugin.json redirect exclusively | `plugins/genie/hooks/hooks.json` | B | (integrator fills) |
| W2-9 | MEDIUM | genie update never refreshes the new Codex surfaces (role-agent TOMLs + plugin registration are install/setup-only) — contradicts the agent-sync convergence contract | `src/genie-commands/update.ts` | C | (integrator fills) |

### Invented surface (from the codex integration map, fixed this wave)

| # | Sev | Finding | Anchor | Lane | Fix commit |
|---|-----|---------|--------|------|------------|
| W2-INV-1 | HIGH-impact | `~/.codex/skills/.curated/` is not a Codex discovery path (codex-rs prunes hidden dirs, regression-tested; parent root deprecated — live tier is `~/.agents/skills`). agent-sync's codex adapter ships skills nowhere; fix = `~/.agents/skills/<name>` + one-time managed migration | `src/lib/agent-sync.ts` | C | (integrator fills) |

### LOW findings (7)

| # | Sev | Finding | Anchor | Lane | Fix commit |
|---|-----|---------|--------|------|------------|
| W2-L1 | LOW | Codex PermissionRequest deny omits the documented optional message — omni phone denials surface reasonless | `src/hooks/codex-adapter.ts` | B | (integrator fills) |
| W2-L2 | LOW | Dead Codex PreToolUse matcher tokens (Read, SendMessage not Codex tool names); native-surfaces.md claims an undocumented follow-up-messaging surface | `plugins/genie/hooks` (codex file) + `references/native-surfaces.md` | B (matchers) / E (docs) | (integrator fills) |
| W2-L3 | LOW | Lock stale-steal uses unlink-then-open — two processes can steal the same stale lock and sync concurrently | `src/lib/agent-sync.ts` | C | (integrator fills) |
| W2-L4 | LOW | --sync-only flag registration untested end-to-end — removing the .option() would break fleet hook delegation with all gates green | `src/genie.ts` | E | (integrator fills) |
| W2-L5 | LOW | Partial aux-tree adoption still refreshes VERSION stamp — failed-swap tree goes permanently stale on same-version reinstalls | `src/genie-commands/install.ts` | A | (integrator fills) |
| W2-L6 | LOW | native-surfaces.md instructs nonexistent `genie task claim` (real: `genie task checkout`); genie-* vs genie_* agent-name drift | `plugins/genie/references/native-surfaces.md` | E | (integrator fills) |
| W2-L7 | LOW | work SKILL role table 'Role (Codex name)' with genie_* names creates Claude-side subagent_type ambiguity; fix/review skills lost concrete tool anchors (anchors in skills/fix + skills/review are outside lane E's files — parked for a follow-up) | `skills/work/SKILL.md` | E | (integrator fills) |
