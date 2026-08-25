# Council rodada 1 — lente dissent

_Rodada 1 (2026-08-25): proposta rev. 3 crua (deletar plugins, skills.sh, harness mínimo, board só standalone, sem UI). Relatório integral do subagente, recuperado do transcript._

# DISSENT lens — genie v6 rev. 3 ("delete plugins, skills.sh, orca mode")

## 1. Lens block

**Verdict:** FIX-FIRST on the proposal as stated. Points 3 (simpler harness), 4 (board stays standalone) and 6 (no UI) are sound. Points 1 (delete `plugins/` *entirely*), 2 (skills.sh as *universal* install surface) and 5 (orca = second skillset with board disabled) are each under-specified in a way that silently destroys working capability or re-creates the drift the design already rejected.

**Confidence:** high on the concrete losses (read from code); medium on skills.sh (no in-repo evidence of what it ships; only the sibling `khal-dev/skillset-publishing` skill exists, and it is marketplace/bundle-based, not skills.sh).

**Key evidence**

| Claim | Evidence |
|---|---|
| "Delete plugins" deletes *all* runtime hooks, not just delivery machinery | `plugins/genie/hooks/hooks.json` is the only registration of SessionStart (`session-context.cjs`), PreToolUse (`dispatch-runtime.cjs` → `src/hooks/index.ts` chain: branch-guard, git-freeze-guard, freshness, audit-context, identity-inject, omni-approval), and the Write/Edit `validate-wish.cjs` gate. `src/lib/claude-settings.ts` writes no hooks; nothing in `src/` installs them outside the plugin. Codex parity: `plugins/genie/hooks/codex-hooks.json` (H3/H4/H6). |
| Role profiles die with the plugin | `plugins/genie/agents/{engineer-trivial,standard,complex,reviewer,fixer,scout,final-gate}.md` are the *only* definitions. `skills/work/SKILL.md:56-62`, `review:54`, `fix:18-35`, `dream:62`, `brainstorm:119-123` hard-name them ("implicit or unnamed roles are forbidden"). Fan-out to Codex/Hermes/pi is `src/lib/agent-sync.ts` (7.4k LOC, on the delete list). |
| `/council` on Claude Code is a *workflow*, not a skill | `plugins/genie/workflows/council.js` (25k) + `agent-sync.ts:84-89` deliberately does **not** sync `skills/council` to CC to avoid name collision. Deleting the plugin either loses `/council` on CC or forces the collision the design forbade. |
| SessionStart context is load-bearing for the router | `session-context.ts` emits wish status/task cards/branch; `skills/genie/SKILL.md:55-65` routes on "Wish status FIX-FIRST/BLOCKED/SHIPPED" — that status arrives via this hook. DESIGN.md §IN also plans the `mode=` token *in this hook*. Without it, every base skill must re-derive state (`genie context` CLI only exists in standalone, and per DESIGN.md mode disambiguation was hook-first). |
| Wish validator is hook-delivered | `validate-wish.ts` (19k) runs as PreToolUse/PostToolUse on Write/Edit; template-derived; the DESIGN needs a second `wish-template.orca.md` fixture through it. No hook → no structural guard on wish writes in either mode. |
| skills.sh universality is unproven | Zero references to skills.sh in repo code/docs. The only in-house distribution skill (`/home/namastex/workspace/repos/khal-skills/khal-dev/skills/skillset-publishing/SKILL.md`) ships **SKILL.md dirs only** via a Claude marketplace bundle + `hermes skills install`, notes Hermes hub blocks security-themed skills (`supply-chain`, hooks-related content are at risk), and says nothing about Codex or pi. If skills.sh is the same class, it carries skills, not hooks/agents/workflows/rules/references. |
| Board-for-standalone + board-off-for-orca doubles the surface | Every base skill is board-shaped: `work` (checkout/done/list at lines 21-43, 75, 103-139), `wish:77-78` (`task create`), `brainstorm:117` (`task create`), `genie:74-97` (14 board/task routes), `review:192-196`, `fix:57`, `dream:50`. Orca overlays must *negate* each of these; `work` already had to be a full replacement because the negation exceeded the base. The proposal keeps both bodies alive → 2 skillsets × N runtimes. |
| Second skillset = Approach A the design rejected | `DESIGN.md:65` — "A — Fork … Perde para B por drift"; `:82` overlay chosen; Risk 5/10 name the exact hazards. Rev. 3 as phrased ("ships a DIFFERENT Orca-focused skillset") is Approach A with a new name. |
| Orca prototype already violates a stated constraint | `skills/genie-orca/work/SKILL.md:59` — "fast-tps workers (`claude --model sonnet`)"; brief's model rule forbids sonnet/haiku. Prototype is not ship-ready as "the orca skillset". |
| "No UI" is inconsistent with the CLI kept | `src/lib/v5/mcp-server.ts:4` — one server backs both `genie mcp` and `genie ui-bridge`; `hire_roster` threads through `task-state.ts`, `genie-db.ts`, `roadmap-sync.ts` (excluded from sync), `v5-task.ts`, `interactivity.ts`, `mcp-tools.ts`. Deleting ui-bridge without schema/roster surgery leaves a dead table + dead-code-guarded paths; keeping `genie mcp` write tools (17 tools, `mcp-tools.ts:582-1118`) without any non-LLM consumer is a UI-shaped API with no UI. |
| Omni is silently deleted | `omni-approval` handler is registered in `src/hooks/index.ts:24-31,103-126` and only fires through the plugin PreToolUse/PermissionRequest hooks. Delete plugins → `genie omni serve`/queue/global-db have no producer. Brief lists Omni as "not mentioned"; in practice point 1 kills it. |

**Risks / objections**
- Rev. 3 removes the *enforcement* layer (branch-guard §19 humans-only-main, git-freeze-guard #2705, validate-wish) and keeps only prose. AGENTS.md invariants revert to "enforced by brief prose alone" — the exact regression git-freeze-guard was written to fix.
- Two skillsets, one CLI: standalone skills hard-fail without `genie task` rows? No — `work:106` has a "no task row → drive from WISH.md" fallback, which means the board is *already optional* in the base skills. The orca fork duplicates prose to remove something the base already tolerates.
- `session-context.cjs` parity gate, `hook-bundle-parity`, `codex-plugin-only-smoke`, `sync-plugin-skills` all go — fine — but DESIGN.md Success Criteria (`:117`) and Risks 5/6/9/10 are written against those and must be rewritten, not just "absorbed".
- Deprecation: Codex/Hermes users' `~/.codex` / `~/.hermes` managed trees (`.genie-sync.json` manifests, `agent-sync.ts:10-15`) will be orphaned with no remover once `uninstall`'s classifier lanes are deleted.

**Required conditions (to flip to SHIP)**
1. A written **home for each non-skill plugin asset**: hooks (→ `genie init` writing project `.claude/settings.json` hooks? or drop with an explicit "no enforcement" decision), agents (→ `.claude/agents/` via `genie init`, or inline role prose into `work`), council workflow (→ decide skill-only everywhere), validate-wish (→ CLI verb or delete), references/rules (→ fold into skills).
2. Empirical check of skills.sh: does `npx skills add` (or whatever) install into Codex/Hermes/pi *and* what does it do with `agents/`, `hooks/`, `references/`? Until known, "universal" is an assumption.
3. Replace "different skillset" with what DESIGN.md already decided: **mode guard at the top of base skills + overlays**; `genie-orca-work` full replacement only. One published skillset, mode-branching inside. Otherwise write the drift test the design demanded.
4. Decide Omni explicitly (keep with a non-plugin hook path, or delete `omni-*`, `global-db.ts`, `omni-queue.ts`, `omni` command, `skills/omni`).
5. If `ui-bridge` leaves, also drop `hire_roster` (migration) and `interactivity.ts` roster paths; if `genie mcp` stays, name its consumer (LLM tools only) and prune write tools nobody calls.
6. Fix `genie-orca-work:59` sonnet mention; make orca board-disable concrete (only task/board/mcp verbs? also git sync hooks and `init` scaffold? — brief unknown #5 must be answered before code).

**Unknowns:** skills.sh install contract; whether any external Codex/Hermes install exists; whether Felipe wants *any* mechanical guard left on CC (if "prose is enough", say so and delete `src/hooks/` too — 6.9k LOC with no caller is worse than deleting).

## 2. LEAVES / STAYS / STAYS-RESCOPED (dissent call)

| Area | Call | Disagreement / note |
|---|---|---|
| `plugins/genie/.claude-plugin,.codex-plugin,.kimi-plugin`, marketplace manifests | LEAVES | agree |
| `plugins/genie/hooks/*.json`, `scripts/dispatch-runtime`, `src/hooks/**` | **STAYS-RESCOPED** | disagree with wholesale delete: keep `src/hooks/index.ts` + branch-guard + git-freeze-guard + session-context, registered by `genie init` into project settings (Claude) — or delete `src/hooks/` entirely; no half-state |
| `plugins/genie/scripts/src/session-context.ts` | **STAYS-RESCOPED** | move to `src/`; it's the `mode=` carrier the design depends on; drop parity gate |
| `plugins/genie/scripts/src/validate-wish.ts` | STAYS-RESCOPED | becomes `genie wish validate [--mode]` or is folded into `review`; hook wiring leaves |
| `plugins/genie/agents/*.md` | **STAYS-RESCOPED** | must not die: either ship as `agents/` in the skillset if skills.sh supports it, or inline into `work`/`review`/`fix` role tables |
| `plugins/genie/workflows/council.js` | LEAVES | agree, *only if* `skills/council` becomes the CC surface too (collision rule in `agent-sync.ts:84` becomes moot) |
| `plugins/genie/rules`, `references/*` | STAYS-RESCOPED | fold dispatch-contract/review-criteria/lenses into the owning skills; not deletable content |
| `plugins/genie/skills` mirror, `sync-plugin-skills`, `codex-plugin-only-smoke` | LEAVES | agree |
| `plugins/hermes-genie`, `plugins/pi-genie`, `codex-agents` | LEAVES | agree, with a deprecation note and a one-shot cleaner for `.genie-sync.json`-managed dirs |
| `src/genie-commands/{codex-*,install-promote,update-integrations,legacy-v4,local-delivery-repair,auxiliary-trees}` + `src/lib/{codex-*,install-*,agent-sync,runtime-integrations,hermes-*,update-capabilities,trusted-executable,ordered-lifecycle-leases}` | LEAVES | agree — this is the real weight (~25k LOC) |
| `install`, `update`, `uninstall`, `setup`, `doctor` | STAYS-RESCOPED | keep binary self-update + doctor; strip plugin/marketplace/Codex convergence |
| `omni-*` (lib, runner, command, `global-db`, `omni-queue`, `skills/omni`) | **decide** | proposal is silent; without hooks it is dead → LEAVES unless a non-plugin hook path stays |
| `src/lib/v5/{genie-db,task-state,roadmap-sync,base-state,resolve-wish-branch,sqlite-open,card-render}` + `board`, `task`, `idea`, `context`, `init` | STAYS | agree (standalone) |
| `src/lib/v5/mcp-server.ts`, `mcp-tools.ts`, `genie mcp` | STAYS-RESCOPED | keep read tools; audit 12 write tools for a real caller |
| `ui-bridge.ts`, `bridge-watcher.ts`, `hire_roster`, `UI-BRIDGE.md`, `packages/genie-ui`, `docs/_internal/{genie-ui-two-faces,design-system,tui-host}` | LEAVES | agree; add the `hire_roster` schema/roster-path removal so it's not a zombie |
| `shortcuts` (tmux), `show` | LEAVES / STAYS-RESCOPED | "only what is needed" — tmux shortcuts are v4 residue; propose LEAVES |
| `scripts/` release/sign/attest, codex smokes, dogfood matrices | LEAVES (codex/dogfood) / STAYS-RESCOPED (sign/verify for the single binary) | agree |
| `skills/genie-orca/` prototype | LEAVES as a tree | promote per DESIGN (flat `skills/genie-orca-*`), fix `:59` sonnet |
| CI workflows: musl-adapter-smoke, signing-identity-pin, audit-next-tag, release-orphan-alert | STAYS-RESCOPED | binary release still needs sign/attest; codex-specific jobs leave |

## 3. Base vs orca skill deltas (as read)

| Skill | Orca mode | What board-disabled removes | Note |
|---|---|---|---|
| `genie` (router) | base, needs `mode=` guard | 14 of the "Operational Command Mapping" rows (`:74-97`) route to `board/task` — in orca they must route to `ORCA orchestration …`; router today is standalone-only |
| `brainstorm` | base | `:117 genie task create` at crystallize (DESIGN: "INDEX.md é o ponteiro") | tiny delta, overlay-able |
| `wish` | overlay `genie-orca-wish` | `:77-78 task create/list`, `:83,107 genie context`; adds header `Orchestration/Tracker`, SCOUT.md, Dispatch plan, waves, escape hatches | prototype has 0 shared headings with base (DESIGN:65) — overlay instruction exists only on paper |
| `work` | **replaced** by `genie-orca-work` | all of it: checkout/done/list/board, role table, freeze rule, spawn via native Agent → replaced by Orca run/task/worker-start/check loop, Linear at transitions, coordinator-owned merges | replacement drops the base's escalation-diagnosis and validation-scope rules (`work:65-73`) — those are mode-independent and get lost |
| `review` | overlay `genie-orca-review` | `:192-196 task done`, orchestrator-persists-status rule; adds worker-dispatch reviewer, 3-reviewer gate tiers, retro | base's 213 lines of criteria (`review-criteria` reference) are what the overlay implicitly relies on; if `references/` leaves, the overlay has no base to overlay |
| `fix`, `dream` | unaddressed | `fix:57`, `dream:50` call `task done/checkout`; `dream` batch-runs `work` → both silently standalone-only | rev. 3 must state whether they exist in orca mode |
| `council` | base | none (board-free) | on CC it's currently the workflow, not the skill — see above |
| Audit lanes (`architecture … supply-chain`), `trace`, `report`, `refine`, `pm`, `docs`, `genie-hacks` | base, mode-agnostic | none | `pm` references board? (not read; flag for check) |

Net: the honest count is **1 replacement (work) + 2 overlays (wish, review) + 3 small guards (genie, brainstorm, fix/dream)** on one skillset — not "a different skillset". Publishing two is the fork the design already lost the argument for.