# Wish: agent-sync — `genie update` converges every detected coding agent

| Field | Value |
|-------|-------|
| **Status** | APPROVED — plan designed in-session and approved by Felipe via /plan → ExitPlanMode (2026-07-10); execution authorized |
| **Slug** | `agent-sync` |
| **Date** | 2026-07-10 |
| **Author** | Felipe (planned with Fable 5) |
| **Appetite** | small-medium (2-4 days) |
| **Branch** | `wish/agent-sync` |
| **Design** | [DESIGN.md](DESIGN.md) — approved via /plan → ExitPlanMode (2026-07-10) |

## Summary

`genie update` today refreshes only `~/.genie/{plugins,skills,templates}`; no coding agent ever sees the result (CC marketplace plugin disabled+stale, `~/.hermes/plugins` empty, `~/.codex/skills` without genie skills, council stamp hung on a hook that never fires). This wish makes `genie update` the single canonical updater — **no new command, no new visible flag** — with an internal agent-sync phase that converges every DETECTED agent (Claude Code, Codex, Hermes) on every invocation, and turns the CC plugin's SessionStart hook into a mere trigger that delegates to it.

## Scope

### IN
- Internal engine `src/lib/agent-sync.ts` (+ `src/lib/genie-home.ts`): manifest-managed dirs (`.genie-sync.json`, dir-level digest), auto-adopt-with-backup to `~/.genie/state-backups/agent-sync-<ts>/`, removal of managed orphans (backup first), staged-`.new`+rename atomicity, per-agent report.
- Adapters: **claude** (skills → `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/`, council stamp → `workflows/council.js` via TS `stampWorkflow` parity-locked to `council-stamp.cjs`, `LENS_ROOT` = stable source root), **codex** (skills as Agent-Skills folders → `~/.codex/skills/.curated/<name>/`; `.system` never touched; restart advisory), **hermes** (symlink `~/.hermes/plugins/genie -> ~/.genie/plugins/hermes-genie` + sticky-profile variant + `hermes plugins enable genie` when newly linked and binary present).
- Source root resolution: `~/.genie/plugins/genie` (fallback `~/.genie/bin/plugins/genie`); hermes source `~/.genie/plugins/hermes-genie`.
- Triggers: sync phase on EVERY `genie update` (including the already-at-latest short-circuit path); post-swap exec of the NEW binary with internal env `GENIE_UPDATE_SYNC_ONLY=1`; `genie install` runs it in-process + `normalizeAuxLayout()` (bin/ layout mismatch); smart-install.js delegates to `genie update` (env set, throttled via `~/.genie/.last-agent-sync`, non-fatal) with CLI-less fallback stamp via new `resolveStampInputs` (stable-root preference).
- Cleanups: delete `scripts/smart-install.js` + build.js copy block; lens-root anchor sentence in `skills/{review,brainstorm}/SKILL.md` + gate assertion; doctor per-agent freshness section; uninstall removes managed assets.
- Docs: plugins/genie/README.md distribution section, CLAUDE.md gotchas + row.
- council-workflow WISH amendments (ritual + Decision 6/G2 note: CLI sync primary, hook = trigger/fallback).

### OUT
- Any new user-facing command or flag (hard requirement).
- Remote Hermes (cegonha) — only local agents converge.
- Auto-re-enabling the disabled `genie@automagik` marketplace plugin (explicit user choice; doctor reports only).
- `/council` workflow on Codex/Hermes (no dynamic-workflow runtime there — CC-only, as already decided).
- Repo-root `AGENTS.md` regeneration (buggy sed twin of CLAUDE.md — separate cleanup), `~/.codex/rules/default.rules` stale-rule reconciliation, `~/.codex/config.toml` beyond what codex-config.ts already writes.
- Refactoring the ~5 existing inline GENIE_HOME resolutions (hygiene pass later).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Internal phase, not a command | Felipe's hard requirement: one canonical verb (`genie update`); internal env `GENIE_UPDATE_SYNC_ONLY=1` is the only re-entry contract |
| 2 | Sync runs even on the short-circuit path | "Update = converge everything, not just the binary" — also what makes the hook-trigger cheap and the one-time delivery caveat a plain second `genie update` |
| 3 | Auto-adopt-with-backup, no prompts | Zero-friction requirement; backups under state-backups/ make every replacement reversible; names genie never shipped are untouched |
| 4 | Managed-orphan removal is v1-mandatory | Zombie `~/.claude/skills/council` would resurrect the skill-vs-workflow name collision council-workflow Decision 8 exists to prevent |
| 5 | Single stable source root (`~/.genie/plugins/genie`) for stamps and sync | Version-coherent (tarball cp -RL), path never changes across versions; kills the stale-plugin-cache downgrade ping-pong between hook and CLI |
| 6 | Codex gets native Agent-Skills folders in `.curated/` | Machine-verified native SKILL.md support; historical precedent (old skill-installer rule shipped genie skills); `.system` is OpenAI-owned |
| 7 | Hermes via symlink + enable | install-local.sh's documented default; the atomic source swap freshens Hermes on every future update for free |
| 8 | Delete scripts/smart-install.js (not backport) | Root cause of the clobber hazard: two diverged copies; shipped copy becomes the single source; build.js copy block dies with it |
| 9 | Post-swap exec of the new binary | Established pattern in update.ts (three existing probes); makes every FUTURE update self-syncing; delivery release carries a one-time "run `genie update` again" caveat |

## Success Criteria

- [ ] `bun test src/lib/agent-sync.test.ts` green: fresh-create / idempotent re-run all-unchanged / source-change→updated / adopt-with-backup (backup exists under state-backups) / managed-orphan removed+backed-up / unmanaged-never-shipped untouched / missing-agent → skip with note / digest stable under file order + excludes manifest / stale `.new` staging pre-cleaned / hermes symlink + real-dir adopt + foreign-symlink left / codex `.curated` placement / stamp parity TS === `.cjs`
- [ ] `git grep -n 'GENIE_UPDATE_SYNC_ONLY' src/genie-commands/update.ts src/genie.ts` shows the env honored, and the short-circuit path calls the sync phase (structural greps in g2 gate)
- [ ] `scripts/smart-install.js` no longer exists; `scripts/build.js` has no smart-install copy block; `plugins/genie/scripts/smart-install.js` delegates to `genie update` and stamps only as CLI-less fallback via `resolveStampInputs`
- [ ] `skills/review/SKILL.md` + `skills/brainstorm/SKILL.md` carry the `$GENIE_HOME/plugins/genie` lens-root anchor; `validate/g4-consumers.sh` asserts it; council-workflow gates still green
- [ ] doctor prints a per-agent freshness section; uninstall removes manifest-verified managed assets (unit-tested seams)
- [ ] `bun run check` green (baseline 725 pass / 1 skip + new tests)
- [ ] Live (post-release, Felipe's ritual): `genie update` twice on the reference machine → `~/.claude/skills` current + `workflows/council.js` present, `~/.codex/skills/.curated/` populated, `~/.hermes/plugins/genie` linked; evidence in `qa/`

## Execution Strategy

| Wave | Group | Agent | Complexity | Model | Notes |
|------|-------|-------|------------|-------|-------|
| 1 | G1 engine + adapters + tests | engineer | 4 (fs engine, 3 adapters, parity) | inherit (fable·max) | New files only — safe alongside the concurrent session in this tree |
| 2 | G2 wiring + hook + cleanups | engineer | 3 (update/install/hook seams) | inherit (fable·max) | Touches skills/{review,brainstorm} — coordinate with concurrent uncommitted edits at dispatch time |
| 3 | G3 doctor + uninstall + docs + gate | engineer | 2 (surfaces + docs) | inherit (fable·max) | Final `bun run check` |

---

## Execution Groups

### Group 1: Engine + adapters + tests
**Goal:** The internal agent-sync engine exists, fully unit-tested, with claude/codex/hermes adapters and the parity-locked TS stamp — no wiring yet.

**Deliverables:**
1. `src/lib/genie-home.ts` — `resolveGenieHome()`, `resolveClaudeDir()` (honors `CLAUDE_CONFIG_DIR`), plus codex/hermes dir resolvers (env-overridable for tests).
2. `src/lib/agent-sync.ts` — public API: `runAgentSync(opts) → AgentSyncReport` (agents: claude/codex/hermes, each `{detect, sync}`), manifest+digest model, auto-adopt-with-backup, orphan removal, staged-rename writes, `stampWorkflow()` TS twin, `resolveGenieSource()`. Split into a dir module if complexity budget warrants.
3. `src/lib/agent-sync.test.ts` — the behavior matrix from Success Criteria, tmpdir-isolated (GENIE_HOME + injected agent target dirs), real files, afterEach cleanup.

**Acceptance Criteria:**
- [x] Behavior matrix covered and green; typecheck + biome clean
- [x] No wiring into commands (G2); no user-facing surface
- [x] Transient knip warnings for not-yet-wired exports are acceptable and reported (none occurred — knip clean)

**Status:** DONE (2026-07-10) — gate `G1 PASS` (orchestrator-run, 31 tests), execution review FIX-FIRST → fixer → re-review SHIP (loop 1). HIGH closed with empirical re-proof: staging suffixes were `.new`/`.old` and a user's manual-backup sibling dir (`review.old`) was silently destroyed by the pre-clean — now collision-proof `.genie-sync.staging`/`.genie-sync.prev` constants shared by writer + orphan filter, locked by on-disk survival tests. LOWs: hermes enable also fires on the adopt transition; late adapter throws preserve the partial report. 27→31 tests, watched-fail-first on every fix.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bash .genie/wishes/agent-sync/validate/g1-engine.sh
```

**depends-on:** none

### Group 2: Wiring — update/install/hook + cleanups
**Goal:** Every trigger converges into the one engine; the diverged smart-install copy dies.

**Deliverables:**
1. `src/genie-commands/update.ts`: `runAgentSyncSafe()` called on BOTH the short-circuit path and post-verify; post-swap exec of the new binary with `GENIE_UPDATE_SYNC_ONLY=1`; env honored early in `updateCommand` (sync-only fast path).
2. `src/genie-commands/install.ts`: `normalizeAuxLayout()` + in-process sync; injection seams mirroring `V4CleanupRunner`.
3. `plugins/genie/scripts/council-stamp.cjs`: `resolveStampInputs({claudePluginRoot, genieHome, exists})` (stable-root preference); `plugins/genie/scripts/smart-install.js`: delegate to `genie update` (env + throttle marker + try/catch), stamp only on the CLI-less fallback path; `src/lib/council-workflow-stamp.test.ts` extended.
4. Delete `scripts/smart-install.js`; remove the `scripts/build.js` copy block.
5. `skills/review/SKILL.md` + `skills/brainstorm/SKILL.md`: identical lens-root anchor sentence; `.genie/wishes/council-workflow/validate/g4-consumers.sh` gains the GENIE_HOME assertion.

**Acceptance Criteria:**
- [ ] g2 structural greps all pass; update/install tests extended and green
- [ ] council-workflow gates (g2-engine, g4-consumers) still green
- [ ] Coordinated with concurrent uncommitted edits to the same skill files (no clobber — rebase/merge textually at dispatch time)

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bash .genie/wishes/agent-sync/validate/g2-wiring.sh
```

**depends-on:** Group 1

### Group 3: Doctor + uninstall + docs + final gate
**Goal:** Operability and docs: freshness visibility, clean removal, documented distribution model.

**Deliverables:**
1. `src/genie-commands/doctor.ts`: per-agent freshness section (detected / managed-current / stale / unmanaged; council.js present+current; marketplace plugin reported as optional-disabled, never mutated).
2. `src/genie-commands/uninstall.ts`: manifest-verified managed-dir removal per agent + stamped council.js + hermes symlink.
3. Docs: `plugins/genie/README.md` distribution section rewrite (CLI sync primary; hook = trigger + CLI-less fallback; per-agent table); `CLAUDE.md` agent-sync row + two gotchas (one stamp root; manifest + adopt-with-backup).
4. council-workflow WISH G5 ritual + Decision 6 note amended (CLI primary; delivery-release caveat: `genie update` twice, once ever).

**Acceptance Criteria:**
- [ ] g3 gate green including full `bun run check`
- [ ] Docs match the shipped behavior exactly (no aspirational claims)

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bash .genie/wishes/agent-sync/validate/g3-gate.sh
```

**depends-on:** Group 2
