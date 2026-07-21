# Wish: genie-ui do-over — dash as base

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `genie-ui-dash` |
| **Date** | 2026-07-21 |
| **Author** | Felipe (ratified verbatim) + Fable orchestrator |
| **Appetite** | large |
| **Branch** | `wish/genie-ui-dash` |
| **Repos touched** | dash fork (base `syv-ai/dash`, working copy `~/prod/genie-ui-ab/dash-fork`), genie (this repo: wish docs only — roster migration moved to genie-ui-bridge) |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Rebuild the genie UI direction on **dash** — the working ~63k-LoC Electron desktop app — instead of the rejected from-scratch browser shell in `packages/genie-ui`. Only four additions, in Felipe's ratified words (2026-07-21): *"DASH as base. only adding the kanban, extra coding agents that arent present, following the same contract, extend current claude code integration, and make paralel so that we can add new ones."* Dash's entire product surface (worktrees, git panels, diff viewer, commit graph, terminal persistence, themes, keybindings) is kept, not rebuilt.

**Decision lineage (do not re-litigate):** the prior `genie-ui` wish shipped a from-scratch browser substrate whose fresh-over-dash A/B reversal was never surfaced to Felipe as its own decision (independent review 2026-07-21: FIX-FIRST on the decision — no judge artifact on disk, dash-fork passed all 7 A/B items, rubric excluded Felipe's stated values). Felipe then saw the running fresh UI and rejected it explicitly, choosing dash-as-base in his own words. That ratification is the governing authority for this wish. Full evidence: `.genie/brainstorms/genie-ui/DRAFT.md` (lines 74–76, 125–127, 233), `.genie/wishes/genie-ui/WISH.md` (D11/D12), and the orchestrator memory handoff `HANDOFF-genie-ui.md`.

## Scope

### IN

- A genie-owned dash fork branch built from upstream `syv-ai/dash` main, building and packaging as a desktop app on Felipe's box (the A/B `fleet/` browser-lane commits are dropped from this branch — that lane was the rejected direction).
- An **agent-adapter contract** extracted from dash's existing Claude Code integration (`ptyManager.ts` `buildClaudeArgs`/spawn, `claudeCli.ts` binary + session-jsonl discovery, `SessionWatcherService`/`jsonlParser` activity + token observability, `HookServer`), with Claude Code as the reference adapter and **zero behavior change** for existing dash users.
- **Parallel adapters** for the agents dash lacks — `codex`, `hermes -p <profile> --tui`, `rlmx` — registered through the contract so a new agent is added by writing one adapter module, not editing core. Per-task agent selection in the UI. Real agent CLIs only — no placeholder panes (the btop stand-ins are explicitly dead).
- A **genie kanban lane**: when an opened project is a genie repo, surface its wishes + board state as a kanban view alongside dash's Projects/tasks sidebar — state arrives through the `genie ui-bridge` stdio child (reads + change notifications), wish titles from git-tracked `.genie/wishes/*/WISH.md` markdown. The UI never opens genie.db with a SQLite driver (amendment 2026-07-21).
- A **hire roster** persisted in the genie repo's `.genie/genie.db` **by genie itself**: hiring calls the bridge's `roster_hire`/`roster_unhire` tools (writer invariants stay in genie) and opens a real dash task terminal running that agent bound to the wish's worktree.

### OUT

- The from-scratch browser shell (`packages/genie-ui` fresh substrate) — rejected as the UI. It is not deleted by this wish, but no further UI investment lands there.
- The inter-agent group chat / conductor. The portable ~1,270-LoC chat-backend payload in `packages/genie-ui` (no PTY-layer imports by contract) is salvage material for the future conductor wish, not this one.
- Browser-served delivery as a requirement. Dash is a desktop app; that is the point. (Dash's existing QR/URL remote-control feature stays as-is; we do not extend it.)
- Rewriting or "improving" any existing dash feature (git panels, worktree pool, themes, ADO/GitHub integrations) beyond what the adapter extraction strictly requires.
- Upstreaming to `syv-ai/dash` — a later decision for Felipe, not a deliverable here.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Base = fresh branch from upstream `syv-ai/dash` main; the A/B `fleet/` commits on the existing `genie-ui` branch are NOT carried forward. | The fleet lane was the browser direction Felipe rejected; carrying it invites drift back into the rejected substrate. Salvageable pieces stay recoverable from git history. |
| 2 | Adapter contract is extracted **around** the existing Claude path, not a rewrite of it — Claude Code remains the reference implementation and must behave identically for current dash flows. | Felipe: "following the same contract, extend current claude code integration." Regression-free extraction is the acceptance bar; a rewrite would violate "only adding." |
| 3 | Adapter capabilities are declared, not assumed: spawn is mandatory; session discovery / activity / token observability / hooks are optional per adapter, degrading gracefully in the UI when absent. | Claude Code has `~/.claude/projects` jsonl + hooks; codex/hermes/rlmx have different or no equivalents. Forcing full parity would block shipping adapters; hiding the gap would lie to the UI. |
| 4 | _(Amended 2026-07-21)_ All genie state crosses the repo boundary through the `genie ui-bridge` stdio child — reads, the two roster write tools, and change-push. The UI repo never imports a SQLite driver for genie.db; the roster schema and writer invariants live entirely in the `genie-ui-bridge` wish. | Felipe's explicit channel choice (stdio bridge over direct SQLite / CLI-as-API): schema stays private, genie stays sole writer, version skew is handled by the protocol handshake. |
| 5 | _(Resolved 2026-07-21, Felipe)_ The fork's home is the **private** repo `khal-os/genie-desktop` (created same day; `main` = upstream `syv-ai/dash` main `20cf1ec`, A/B lane archived as `genie-ui-ab-archive`). Deliberately **no hard gates** — no branch protection, no required CI — for easy development; work may land on `main` directly. When Felipe is happy with it, a polish pass moves the repo to its final home and gates are added then. The local working copy keeps `origin`=upstream and `khal`=the private repo. | Felipe's explicit instruction: private fork bound to KHAL first, frictionless dev now, polish-and-relocate later. Gates deferred is a recorded choice, not an omission. |

## Dependencies

**depends-on:** genie-ui-bridge
**blocks:** none

_Amendment 2026-07-21 (Felipe-ratified via the `genie-ui-bridge` brainstorm): G4/G5 no longer touch `.genie/genie.db` with any SQLite driver. Reads, writes, and change-push flow through the `genie ui-bridge` stdio child (see `.genie/wishes/genie-ui-bridge/WISH.md`); the genie-side `hire_roster` migration moved to that wish's G1. Groups 1–3 are unaffected and may execute while the bridge wish is in flight; G4 and G5 additionally wait on the bridge wish shipping._

## Success Criteria

- [ ] The genie dash branch builds, runs (`pnpm dev`), and packages (`package:linux`; `package:mac` where runnable) from a clean clone; the packaged app launches on Felipe's box.
- [ ] Existing dash Claude Code flow is regression-free after adapter extraction: create project → create task → Claude terminal spawns with resume/hooks/ports env exactly as before (existing dash tests pass unchanged; before/after spawn fixture identical).
- [ ] `codex`, one `hermes -p <profile> --tui`, and `rlmx` each spawn as a real task terminal via their adapter, selectable per task in the UI; kill/restart works through the same lifecycle as Claude tasks.
- [ ] Adding a new agent requires only a new adapter module + registry entry — proven by the adapter contract doc plus a test that registers a dummy adapter without touching core files.
- [ ] Opening a genie repo as a dash project shows the kanban lane: wishes with board state from `.genie/genie.db` + wish markdown, read-only; a non-genie repo shows dash unchanged (degrade-to-absent).
- [ ] Hiring an agent for a wish produces exactly one roster row in that repo's `.genie/genie.db` (written by genie via the bridge's `roster_hire` tool) and opens the agent's terminal in the wish's worktree; unhiring removes the row and kills the terminal; roster rows appear in `genie task export`.
- [ ] The UI repo performs zero direct genie.db access — no SQLite driver import in genie-facing modules; reads, writes, and change-push all flow through the `genie ui-bridge` child (grep/test gate).
- [ ] Zero placeholder commands in any shipped config — no `btop`/stand-in panes anywhere.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 2 — multi-repo setup (+1), no deterministic test for "packaged app launches" (+1) | engineer-standard / medium | Base branch from upstream dash main, clean build/run/package proof, drop fleet lane |

### Wave 2 (sequential, after Group 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 5 — stateful PTY/session work (+2), subjective regression acceptance on real terminals (+2), prior rework in this area (+1) | engineer-complex / high | Extract the agent-adapter contract; Claude Code as reference adapter, regression-free |

### Wave 3 (parallel, after listed deps)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 4 — stateful spawn/lifecycle per harness (+2), subjective acceptance on real TUIs (+2) | engineer-complex / high | Codex / Hermes / rlmx adapters + per-task agent selection (depends: G2) |
| 4 | engineer | 3 — multi-repo read path (+1), stateful DB read + degrade rules (+2) | engineer-standard / high | Genie kanban lane, read-only from `.genie/genie.db` + wish markdown (depends: G1) |

### Wave 4 (sequential, after Groups 3 + 4)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 5 | engineer | 4 — UI write path via bridge tools (stateful +2), hire→spawn lifecycle orchestration (+2) | engineer-complex / high | Hire roster: dash bridge-tool write module + hire→terminal flow (genie-side schema owned by genie-ui-bridge G1) |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Codex maps these to
the `genie_*` profiles; other runtimes use their matching native roles. Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: Base branch + build proof

**Goal:** Stand up the genie dash branch from upstream main, prove the desktop app builds, runs, and packages on this box, with the rejected fleet lane dropped.

**Deliverables:**
1. The genie lane lives in the private `khal-os/genie-desktop` repo (Decision 5): its `main` is already upstream `syv-ai/dash` main with no `fleet/` lane; G1 commits land there (directly on `main` or on `genie-dash` — executor's choice, no gate either way). The A/B history stays archived as `genie-ui-ab-archive`.
2. Clean build proof: `pnpm install`, `pnpm dev` (app opens, Claude task terminal works), `pnpm package:linux` produces a launchable artifact; commands + output captured in group evidence.
3. A short `GENIE.md` at the fork root recording lineage (upstream base SHA, this wish's slug, what genie adds) so the fork is self-describing.

**Acceptance Criteria:**
- [ ] `git log --oneline origin/main..khal/main` (or the working branch) shows only genie-added commits; no `fleet/` path exists on the working branch.
- [ ] Packaged Linux artifact launches and can open a project + spawn a Claude task terminal (manual proof, capture in evidence).
- [ ] Existing dash test suite passes on the branch — pre-existing failures, if any, recorded as baseline.

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && git fetch origin khal && test -z "$(git ls-tree khal/main --name-only | grep '^fleet$')" && pnpm install --frozen-lockfile && pnpm test
```

**depends-on:** none

---

### Group 2: Agent-adapter contract extraction (Claude = reference)

**Goal:** Extract a pluggable agent-adapter interface from the existing Claude Code integration with zero behavior change for current dash flows.

**Deliverables:**
1. `src/main/agents/contract.ts` + `registry.ts` — the contract: `AgentAdapter` (mandatory: id, displayName, resolveBinary, buildSpawn(task ctx) → {command,args,env,cwd}; optional capabilities: sessionDiscovery, activityParser, tokenStats, hooks) and `AgentRegistry` (register/list/get; per-task adapter id persisted in dash's DB).
2. `src/main/agents/claude/` — the reference adapter: today's `buildClaudeArgs`, `claudeCli.ts` discovery, session-jsonl watching, hook wiring wrapped behind the contract; `ptyManager` consumes the registry instead of hardcoding Claude.
3. Adapter contract doc `src/main/agents/README.md`: the interface, capability table, how to add an agent, what degrades when a capability is absent.
4. Dummy-adapter test proving registration + spawn-arg construction without touching core files.

**Acceptance Criteria:**
- [ ] All pre-existing dash tests pass unchanged; any `buildClaudeArgs`-shaped test still passes against the adapter path.
- [ ] A task created with the Claude adapter produces the same spawn (command/args/env incl. resume, `DASH_HOOK_PORT`, port env) as pre-extraction — asserted by a before/after fixture test.
- [ ] Dummy adapter registers and spawns in tests with zero edits outside `src/main/agents/`.

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && pnpm test -- agents && pnpm test
```

**depends-on:** Group 1

---

### Group 3: Codex, Hermes, rlmx adapters + per-task agent selection

**Goal:** Ship real adapters for the agents dash lacks, selectable per task, with declared (not faked) capabilities.

**Deliverables:**
1. `src/main/agents/{codex,hermes,rlmx}/` — one adapter each: binary resolution, spawn construction (`codex`, `hermes -p <profile> --tui` with profile input, `rlmx`), kill/restart through the existing PTY path; capabilities declared per the contract — only what each harness really supports; absent observability renders as absent, never as placeholder data.
2. Renderer: agent picker on task creation (defaulting to Claude) showing the adapter's declared capabilities; task header shows which agent runs the terminal.
3. Real-spawn smoke evidence on this box for each of the three (captured in evidence; CI stays at unit level where binaries are absent).

**Acceptance Criteria:**
- [ ] Each of codex / hermes(profile) / rlmx spawns a real interactive terminal in a dash task on this box; kill + restart work through the same UI as Claude tasks.
- [ ] Agent choice persists per task across app restart (task reopens with the right adapter).
- [ ] No placeholder commands anywhere: repo-wide grep for `btop` in `src/` is clean.

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && pnpm test -- agents && ! grep -rn 'btop' src/
```

**depends-on:** Group 2

---

### Group 4: Genie kanban lane (read-only)

**Goal:** When an opened dash project is a genie repo, render its wishes as a kanban board from `.genie/genie.db` + wish markdown — read-only, degrade-to-absent otherwise.

**Deliverables:**
1. `src/main/services/GenieStateService.ts` — a **bridge client**, not a DB reader: detect a genie repo (`.genie/` present), spawn one `genie ui-bridge` stdio child per open genie project, complete the version handshake, read tasks/board/wish status through the bridge's read tools, and refresh on the bridge's change notifications (no fs-watching of the db, no SQLite driver against genie.db). Wish markdown titles are still read from `.genie/wishes/*/WISH.md` directly (git-tracked docs, not DB state). Child lifetime is owned by the service: killed on project close/app quit.
2. Renderer kanban view: wishes as cards grouped by durable status (`DRAFT` / `FIX-FIRST` / `APPROVED` / `IN_PROGRESS` / `BLOCKED` / `SHIPPED`) with task/group rows; sidebar entry point next to dash's Projects; clicking a wish shows its groups + linked worktrees.
3. Non-genie repos: no kanban entry point appears; a genie repo with an absent/empty db shows an empty board, never an error.

**Acceptance Criteria:**
- [ ] Opening the genie repo itself shows real wishes with correct statuses (spot-check ≥3 known wishes against `genie board`).
- [ ] No SQLite driver touches genie.db from the UI repo — grep gate: no `better-sqlite3`/`node:sqlite`/`bun:sqlite` import in any genie-facing module; all genie state arrives via the bridge client.
- [ ] Board reflects an external change (e.g. `genie task create` from a terminal) without app restart, driven by a bridge change notification (not UI-side polling).
- [ ] Bridge child lifecycle: closing the project/app terminates the child (no orphaned `genie ui-bridge` processes).

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && pnpm test -- genie && ! grep -rnE "better-sqlite3|node:sqlite|bun:sqlite" src/main/services/GenieStateService.ts
```

**depends-on:** Group 1 _(plus the `genie-ui-bridge` wish shipped — see Dependencies amendment)_

---

### Group 5: Hire roster — the single write path

**Goal:** Hire is a first-class UI action: a roster row in the genie repo's `.genie/genie.db` plus a real agent terminal opened in the wish's worktree; unhire reverses both.

**Deliverables:**
1. `src/main/services/HireRosterService.ts` — the hire/unhire flow as **bridge tool calls**: hire(wish, agent, profile?) calls the bridge's `roster_hire` tool (the write happens inside genie — the UI never touches genie.db) and opens a dash task terminal via the agent's adapter, cwd = the wish's existing `genie launch` per-group worktree (reuse, never mint); unhire calls `roster_unhire` and kills the terminal. _(The genie-side `hire_roster` migration + export extension moved to the `genie-ui-bridge` wish G1 — amendment 2026-07-21.)_
2. Renderer: hire/unhire actions on the kanban wish card; roster shown on wish detail with adapter capability badges.

**Acceptance Criteria:**
- [ ] Hire from the UI → roster row visible via `genie task export` → terminal running the chosen agent in the wish worktree; unhire → row gone, terminal killed.
- [ ] The UI repo performs zero direct writes to `.genie/genie.db` — hire/unhire round-trips through bridge tools only (same grep gate as G4: no SQLite driver import in genie-facing modules).
- [ ] Worktree binding reuses `genie launch` worktrees (asserted in test).

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && pnpm test -- hire && ! grep -rnE "better-sqlite3|node:sqlite|bun:sqlite" src/main/services/HireRosterService.ts
```

**depends-on:** Group 3, Group 4

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: packaged desktop app → open genie repo → kanban shows wishes → hire codex on a wish → real codex terminal opens in the wish worktree → unhire cleans up.
- [ ] Integration: `genie task create` from a terminal appears on the dash kanban without restart; hire-roster row round-trips through `genie task export`.
- [ ] Regression: a plain (non-genie) repo behaves exactly as stock dash — Claude task flow, git panels, diff viewer, worktree pool all unchanged; existing dash test suite green.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Upstream dash moves under us (fork drifts) | Low | GENIE.md records the base SHA; rebase is a deliberate later act, not continuous |
| Hermes/codex/rlmx TUIs misbehave inside dash's xterm (keybinding/altscreen quirks) | Medium | G3 smoke-tests each on the real box before UI polish; adapter capability table records known quirks |
| Roster write concurrency (hire vs genie CLI writers) | Low | Handled inside genie by the bridge write path (see genie-ui-bridge Risk 4); dash issues a `roster_hire` tool call, never a direct write |
| genie-side roster schema drift vs this wish's expectations | Low | Schema and migration are owned by genie-ui-bridge G1; the bridge protocol handshake insulates dash from schema changes |
| Fork remote/publishing undecided (stays local) | Low | Decision 5: not blocking; Felipe runs `gh repo fork` when he wants a remote |
| dash-fork working copy carries uncommitted A/B state | Low | G1 cuts a clean branch off upstream main; existing `genie-ui` branch left untouched as archive |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan Review — 2026-07-21T17:30:04Z
- Reviewer: independent read-only (genie:review plan pipeline)
- Target: .genie/wishes/genie-ui-dash/WISH.md (direct wish; brainstorm-absence user-ratified, not flagged)
- Verdict: SHIP (advisory fixes; MEDIUM-1 required before Group 5)

Commands run / outcomes:
- git -C ~/prod/genie-ui-ab/dash-fork remote -v → origin = https://github.com/syv-ai/dash (origin IS upstream)
- git rev-parse origin/main → 20cf1ec; remote HEAD branch = main; local main tracks origin/main
- git rev-list --left-right --count origin/main...genie-ui → 0 behind / 7 ahead (the fleet lane)
- git ls-tree origin/main | grep fleet → absent;  HEAD → 'fleet' present → G1 reset drops fleet cleanly
- Seams on origin/main: ptyManager.ts, claudeCli.ts, HookServer.ts, SessionWatcherService.ts,
  jsonlParser.ts, RtkService.ts ALL present (upstream, not local-only)
- ptyManager anchors verified: buildClaudeArgs@359, spawn@456/473, generic tui spawn@825/857
- pnpm-lock.yaml present on origin/main + HEAD → frozen-lockfile install runnable
- package.json scripts confirmed: dev, test, package:linux (all G1 validation refs exist)
- DASH_HOOK_PORT confirmed real env contract (ptyHookSettings.ts / hookSettingsMerge.ts)
- btop: absent from src/ on both branches (G3 gate trivially green; stand-ins were under fleet/)
- genie repo: genie task export lives in src/term-commands/v5-task.ts (NOT task.ts, which does not exist);
  exportState()/StateExport in src/lib/v5/task-state.ts is a HARDCODED per-table shape (not generic)
- genie-db.ts migration pattern: user_version stays 1, additive CREATE TABLE IF NOT EXISTS + EXPECTED_TABLES
- Prior wish lineage D11/D12 confirmed accurate

Findings:
- MEDIUM-1: G5 file map named nonexistent src/term-commands/task.ts; export is NOT automatic —
  hire_roster must be added to StateExport+exportState() in src/lib/v5/task-state.ts and to
  EXPECTED_TABLES in genie-db.ts, or G5 AC "rows appear in genie task export" fails silently.
- MEDIUM-2: G5 spans genie + dash-fork branches with implicit ordering (genie migration before dash
  write path); make per-group commit landing + ordering explicit.
- LOW-1: Risk row "user_version bump" contradicts additive genie-db pattern (stay at 1).
- LOW-2: G2 depends-on should be Group 1, not "none".
- LOW-3: G3 btop grep already green (informational).

Gaps blocking a later wave: MEDIUM-1 before Group 5. Waves 1–3 unaffected.

_Orchestrator disposition (2026-07-21): all five findings applied to this document post-review — G5 deliverable + file map corrected to task-state.ts/EXPECTED_TABLES (MEDIUM-1), explicit cross-repo ordering added to G5 (MEDIUM-2), risk row corrected to the additive no-bump pattern (LOW-1), G2 depends-on set to Group 1 (LOW-2), LOW-3 noted as regression guard. Status set to APPROVED on the SHIP verdict._

### Plan Review (Amendment) — 2026-07-21T18:50:26Z
- Reviewer: independent read-only (genie:review plan pipeline)
- Target: .genie/wishes/genie-ui-dash/WISH.md — 2026-07-21 amendment only (G1–G3 not re-reviewed)
- Verdict: SHIP — MEDIUM-A required before G5; Waves 1–3 unblocked; LOW-B..E advisory

Amendment substance coherent: dep direction correct (bridge blocks dash; dash depends-on bridge);
  moved hire_roster owned once in bridge G1, referenced-as-moved in dash G5 deliverable + file map;
  amended grep gates reference real wish-defined services (GenieStateService.ts / HireRosterService.ts).
Residual stale references (amendment sweep incomplete):
- MEDIUM-A (before G5): Wave-4 table still listed G5 as "cross-repo schema migration … genie.db schema (genie repo)" —
  contradicts the move to bridge G1; duplicated scope + double-counted complexity. Fix: drop schema from G5 row, recompute (→4).
- LOW-B: Repos-touched still said "wish docs + .genie/genie.db roster migration" → "wish docs only".
- LOW-C: "Waves 1–2 (G1–G3)" mislabeled waves (G3=Wave3; Wave3 also holds affected G4) → state groups, not waves.
- LOW-D: G4 grep gate referenced G5's not-yet-created HireRosterService.ts (! grep on missing file passes for wrong reason).
- LOW-E: "(dash → genie.db)" direct-write risk phrasing + migration-conflict risk described genie-side work now owned by the bridge wish.
Gaps blocking a later wave: MEDIUM-A before Group 5. Groups 1–3 unaffected.
Task rows: genie task list --wish genie-ui-dash → 5 (group-1..5), ready.

_Orchestrator disposition (2026-07-21): all five amendment findings applied — G5 wave row rescored to 4 with schema ownership noted (MEDIUM-A), Repos-touched corrected (LOW-B), amendment note states groups not waves (LOW-C), G4 grep gate no longer references the G5 file (LOW-D), both stale risk rows reframed to bridge ownership (LOW-E). Status restored to APPROVED on the SHIP verdict; G4/G5 additionally gated on genie-ui-bridge shipping._

---

## Files to Create/Modify

```
# dash fork (branch genie-dash off upstream main)
GENIE.md                                         # G1 — lineage + base SHA
src/main/agents/contract.ts                      # G2 — AgentAdapter + capability types
src/main/agents/registry.ts                      # G2 — AgentRegistry
src/main/agents/README.md                        # G2 — contract doc
src/main/agents/claude/*                         # G2 — reference adapter (wrapped Claude path)
src/main/agents/__tests__/*                      # G2 — dummy-adapter + before/after fixture tests
src/main/agents/codex/*                          # G3
src/main/agents/hermes/*                         # G3
src/main/agents/rlmx/*                           # G3
src/main/services/ptyManager.ts                  # G2/G3 — consume registry (modify)
src/renderer/**                                  # G3/G4/G5 — agent picker, kanban view, hire actions
src/main/services/GenieStateService.ts (+tests)  # G4 — read-only genie.db + wishes reader
src/main/services/HireRosterService.ts (+tests)  # G5 — the single write path

# genie repo (this repo)
# (hire_roster migration, task-state roster ops, and export extension moved to the
#  genie-ui-bridge wish G1 — amendment 2026-07-21; this wish touches only its own doc here)
.genie/wishes/genie-ui-dash/WISH.md              # this document
```
