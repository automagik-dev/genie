# Council rodada 1 — lente architecture

_Rodada 1 (2026-08-25): proposta rev. 3 crua (deletar plugins, skills.sh, harness mínimo, board só standalone, sem UI). Relatório integral do subagente, recuperado do transcript._

## ARCHITECTURE lens — genie v6 "corpo leve" rev. 3

### 1. Lens response block

**Verdict:** GO, with two amendments — (a) the hooks that matter are *CLI-owned*, not plugin-owned, and survive via a 1-line `settings.json` entry written by `genie init`; (b) the 7 role-agent profiles and the `mode=` SessionStart token need an explicit new home before `plugins/` is deleted, or standalone `work` degrades silently.

**Confidence:** High on coupling facts (import graph read in full); Medium on skills.sh (only SKILL.md dirs — confirmed from vercel-labs/skills README; whether Claude Code honors SKILL.md-frontmatter `hooks` was not verified).

**Key evidence**
- The board/wish lifecycle is already an island. `src/term-commands/{v5-board,v5-task,idea,mcp,ui-bridge}.ts` import only `src/lib/v5/*`, `lib/term-format.ts`, `lib/wish-status.ts`, `lib/version.ts`. Nothing in `lib/v5/` imports `agent-sync`, `codex-*`, `runtime-integrations`, `install-*`, `hermes-*` (only `launch-worktrees.ts` → `workspace.ts`, used by doctor).
- The ONLY leaks from the delete-set into the keep-set: `context.ts:58` and `init.ts:23-27` import `lib/codex-project-mcp.ts` (`resolveGitWorktreeRoot`, `registerProjectMcpConfigs`, `genieFacadeMcpEntry`). `resolveGitWorktreeRoot` is a 10-line git helper; `.mcp.json` writing is ~30 lines. Extractable in an hour.
- `src/hooks/index.ts` registers six handlers, all `PreToolUse` (branch-guard, git-freeze-guard, freshness, audit-context, identity-inject, omni-approval). **None reads `.genie/genie.db`**; only `omni-approval` touches the global db. They run via `genie hook dispatch` (in-process fork, `src/hooks/dispatch-command.ts`). The plugin's `hooks/hooks.json` merely points `dispatch-runtime.cjs` at `$GENIE_HOME/bin/genie`. → Deleting `plugins/` loses the *wiring*, not the guards.
- What the plugin uniquely provides and `skills/` does not: `plugins/genie/agents/*.md` (7 role profiles: engineer-{trivial,standard,complex}, reviewer, fixer, scout, final-gate), `scripts/session-context.cjs` (SessionStart wish/task context, node:sqlite), `scripts/validate-wish.cjs` (Pre/PostToolUse Write|Edit template guard), `workflows/council.js`, `rules/genie-orchestration.md`, `references/*`, `mcpServers` in `.claude-plugin/plugin.json` (redundant — `genie init` already writes `.mcp.json`), `settings.json` permission allowlist.
- `skills/work/SKILL.md:280-288` hard-depends on the named roles (`engineer-standard (genie_engineer_standard)` …) with fallback "otherwise the runtime's native named-role surface"; `skills/work/references/native-surfaces.md` says the same. Without `plugins/genie/agents/`, standalone Claude Code has no `engineer-*` agents → every `work` dispatch falls to `general-purpose`.
- Board sync git hooks are **genie-repo-only**: `.husky/post-merge` runs `bun src/genie.ts task sync` gated on `-f src/genie.ts`. No code in `src/` installs post-merge/pre-commit hooks in other repos (`grep post-merge src` → only `roadmap-sync.ts` prose). The brief's "sync hooks" for standalone repos do not exist today.
- `genie-commands/doctor.ts` (95 KB) imports `agent-sync`, `codex-activation*`, `codex-config`, `codex-delivery-evidence`, `hermes-*`, `runtime-integrations`, `v5/genie-db`: 113 codex/hermes/agent-sync references. It cannot be kept as-is; it must be rewritten to the v5-only checks (db health, index-lane drift, worktree residue).
- skills.sh (`npx skills add owner/repo`): scans `skills/<name>/SKILL.md` up to 3 levels, installs by copy/symlink into `.claude/skills/`, `.agents/skills/`, `~/.codex/skills/` etc. **No agents, hooks, MCP, workflows, rules** — SKILL.md + sibling files only. `skills/*/agents/openai.yaml` and `references/`, `templates/` travel with the skill (good: `wish-template.md`, `design-review-evidence.mjs`, `lifecycle.md`, `native-surfaces.md` all survive).
- `skills/genie-orca/work/SKILL.md:69` still says `fast-tps workers (claude --model sonnet)` and line 78 references `scripts/retro-collect.ts`, contradicting the model rule at line 96 — DESIGN rev. 2 already flags this.

**Risks / objections**
1. **Silent role degradation** (High): after `plugins/` deletion, standalone `work` on Claude Code dispatches `general-purpose` for everything; reviewer≠engineer holds but the profile prompts (role charter, model/effort) vanish. Needs `genie init` to write `.claude/agents/genie-*.md` from a template dir shipped in the tarball, or the skill must inline the role charter into the dispatch prompt.
2. **Mode token has no carrier** (High for orca): DESIGN's whole selection mechanism is `mode=` injected by `session-context.cjs`. With no plugin hook, base skills must read the mode themselves (`genie context --mode` or `cat .genie/config.json`). Guard-in-base-skill (DESIGN decision 3) already assumes self-check; make that the *only* mechanism and drop hook dependence.
3. **Hook fan-out via settings** (Medium): `genie init` writing `.claude/settings.json` hooks (`{"PreToolUse":[{"matcher":"Bash|Read|Write|Edit|SendMessage","hooks":[{"command":"genie hook dispatch"}]}]}`) is a repo-level trust decision identical to writing `.mcp.json` — acceptable, but it re-opens "which binary" (PATH `genie` vs `$GENIE_HOME/bin/genie`). Keep the plugin's fail-closed absolute-path rule inside the entry.
4. **Two install stories** (Medium): skills.sh for prose + curl install.sh for the binary. Version skew between skill text and CLI verbs is now unpinned (today `sync-plugin-skills` + plugin version bind them). Mitigation: `genie doctor` lint that installed SKILL.md `genie` verbs exist in `--help` (the `genie` skill already mandates this at runtime, line 109).
5. **Deleting sigstore/release scripts alongside** (Low-Medium): authenticated delivery is plugin-motivated but `update` binary verification is not; keep `verify-release.sh` + `@sigstore/verify` for the binary, drop delivery-evidence/dogfood-matrix/codex-* smokes.

**Required conditions**
- Extract `resolveGitWorktreeRoot` + `.mcp.json` writer out of `codex-project-mcp.ts` before deleting it.
- Ship `templates/agents/*.md` in the tarball; `genie init` (standalone) writes/refreshes `.claude/agents/genie-*.md` (marker-owned, ~60 LOC — the entire replacement for `agent-sync.ts` 295 KB).
- `genie init` writes the PreToolUse hook entry and, if kept, a SessionStart entry `genie context --session` (port `session-context.ts` logic into the CLI; it already imports `src/lib/wish-status.ts` + `resolve-wish-branch.ts`, so the CLI port is a move, not a rewrite; the node:sqlite dual-driver disappears).
- Base skills `wish|work|review|brainstorm|genie` open with a mode check that does not depend on injected context.
- `doctor.ts` rewritten to v5-only checks; `uninstall.ts` (146 KB) and `update.ts` (148 KB) rewritten to plain binary + `.claude/*` marker cleanup.
- Fix `genie-orca/work` sonnet contradiction and retro-collect reference when promoting.
- `validate-wish` Pre/PostToolUse guard: either port to `genie hook dispatch` handler (reuse `wish-status.ts`) or accept loss and rely on `wishes:lint` at handoff (wish step 10). Recommend the latter in orca, the former in standalone.

**Unknowns**
- Whether Claude Code accepts `hooks:` in SKILL.md frontmatter (skills.sh README hints some agents do) — would let `work` carry its own PreToolUse guard without `settings.json`.
- Codex/Hermes/pi user count beyond Felipe (affects deprecation loudness only; architecture answer is the same).
- Omni: Felipe silent. It is fully decoupled from the board (own db, own handler, own runner, own skill) — a keep/leave decision that does not block anything.

### 2. LEAVES / STAYS / STAYS-RESCOPED per inventory area

| Area | Call | Why / paths |
|---|---|---|
| `src/genie.ts` registrations | STAYS-RESCOPED | Keep `init, board, task, idea, context, mcp, hook dispatch, doctor, update, uninstall, shortcuts?`; drop `setup --codex`, `install --integrations`, `__install-promote`, `ui-bridge`, `update --post-delivery-converge/--publish-local-delivery/--sync-only`. `shortcuts` (tmux) is orthogonal — LEAVES unless Felipe uses it. |
| `src/genie-commands/` 31.6k | LEAVES (rewrite 3 files) | `codex-*`, `install-promote`, `legacy-v4`, `local-delivery-repair`, `update-integrations`, `auxiliary-trees`, `setup` leave. `doctor.ts` → new ~600-line v5 doctor (db health, index-lane, worktree residue). `install.ts/update.ts/uninstall.ts` → plain binary lifecycle. |
| `src/lib/` 65.7k | LEAVES bulk | Leave: `agent-sync`, `runtime-integrations`, all `codex-*`, `hermes-*`, `install-promotion/transaction/link/version-marker`, `update-capabilities`, `ordered-lifecycle-leases`, `trusted-executable`? (**no — STAYS**: hooks handlers depend on it), `system-detect`, `claude-settings` (STAYS, needed for hook entry). Stay: `wish-status`, `term-format`, `version`, `genie-home`, `genie-config`, `defaults`, `interactivity`, `workspace` (rescope), `omni-*` (decision-pending). |
| `src/lib/v5/` | STAYS | Minus `bridge-watcher.ts`, `UI-BRIDGE.md`, `hire_roster` table/migration in `genie-db.ts`. `global-db`/`omni-queue` follow the Omni decision. |
| `src/hooks/` 6.9k | STAYS-RESCOPED | Handlers stay verbatim; `codex-adapter.ts`, `trust.ts` (already quarantined), Codex runtime branch in `dispatch-command.ts` leave. Wiring moves to `genie init` → `.claude/settings.json`. Disagree with brief's framing "plugin-delivered hooks leave": the guards are CLI code. |
| `plugins/genie/scripts` | LEAVES (port 2) | `session-context.ts` → `genie context --session` (CLI); `validate-wish.ts` → optional dispatch handler or drop. `dispatch-runtime.cjs`, `mcp-launcher.cjs`, `council-stamp.cjs`, `statusline.sh`, `first-run-check`, `smart-install` leave. Parity gate (`hook-bundle-parity`) leaves with them. |
| `plugins/genie/agents/*.md` | STAYS-RESCOPED | Move to `templates/agents/`; `genie init` materializes into `.claude/agents/`. Orca mode: not written (Dispatch plan `agent|model|effort` columns replace them). |
| `plugins/genie/workflows/council.js` + `council-workflow-lint` | LEAVES | Claude-Workflow-only artifact, no skills.sh home; `skills/council/SKILL.md` (52 lines, lens-based) is the portable form. |
| `plugins/genie/rules`, `references/*`, `codex-agents`, `.kimi-plugin`, `.codex-plugin`, `hooks/*.json` | LEAVES | `dispatch-contract.md` / `review-criteria.md` content already duplicated in `skills/work` & `skills/review`; fold any unique lines into the skills. |
| `plugins/hermes-genie`, `plugins/pi-genie` | LEAVES | Self-contained bridges; skills.sh covers Hermes skill install. |
| `plugins/genie/skills` mirror + `sync-plugin-skills.ts`, `codex-plugin-only-smoke.ts` | LEAVES | Single source in `skills/`. |
| `skills/` | STAYS | Add `skills/genie-orca-{wish,work,review}/` flat (skills.sh flat layout), delete nested `skills/genie-orca/` + `scripts/`. `omni` skill follows Omni decision. `dream/pm/report` standalone-only (they read the board). |
| `packages/genie-ui` | LEAVES | Only consumer is `ui-bridge`. |
| `scripts/` 16.7k | STAYS-RESCOPED | Keep: `skills-lint`, `wishes-lint`, `complexity-budget`, `version`, `build*`, `verify-release.sh`, `release-guard/immutability`, `backfill-roadmap-wish`. Leave: all `codex-*`, `*delivery-evidence*`, `*dogfood*`, `hook-bundle-parity`, `hook-content-binding`, `hook-budgets-lint`, `plugin-executables-check`, `council-workflow-lint`, `sync-plugin-skills`, `generate-codex-fallback-allowlist`, `verify-codex-activation-payload`. |
| CI workflows | STAYS-RESCOPED | Keep `ci, commitlint, docs-lint, version, release, release-publish, sign-attest` (binary only). Leave `musl-adapter-smoke`, `audit-next-tag`, `signing-identity-pin`, `release-orphan-alert` unless they guard the binary path specifically. |
| `docs/` | STAYS-RESCOPED | Leave `_internal/{genie-ui-two-faces,design-system,tui-host,co-orchestration-guide,sdk-executor-guide,spawn-*,agent-profiles?}`, `cli/` pages for removed verbs, Codex/Hermes install pages. |
| Omni (`omni-runner`, `omni-queue`, `global-db`, handler, skill) | STAYS (decision-pending) | Zero coupling to board; leaving it is a separate wish, not part of this cut. |
| Board sync git hooks | STAYS-RESCOPED | Currently genie-repo `.husky` only. Either make `genie init` install them (new) or document `genie task sync` as manual. Don't claim more than exists. |

### 3. Base-skill vs orca-skill deltas

| Skill | Standalone | Orca mode | Board-disabled removes |
|---|---|---|---|
| `genie` (router, 108 lines) | routes by wish status; ops table lines 73-90 all `genie board/task/context` | STAYS, mode-aware: State Detection `APPROVED → genie-orca-work`; ops table rows map to `orca orchestration task-list/run-show`; "is healthy" → `genie doctor` still | every `genie task *`/`board` verb, `genie context --plan` |
| `brainstorm` (167) | step 5 `genie task create` pointer | STAYS unchanged except step 5 skipped (DESIGN: "INDEX.md é o ponteiro") | `genie task create`; nothing else — design-review-evidence.mjs, INDEX.md, DESIGN.md untouched |
| `wish` (113) | steps 9 (`genie task create/list`), 12 (`genie context --wish` wave base) | OVERLAID by `genie-orca-wish`: adds Orchestration/Tracker header, Dispatch plan table, SCOUT.md, disjoint-Files rule, integrator group, model rule; base steps 1-8,10,11 apply | steps 9 & 12; `validate-wish --mode orca` needs the second fixture |
| `work` (150) | claim/done loop (`task checkout/done`, `board --wish`), role table, freeze rule, escalation diagnosis | REPLACED by `genie-orca-work`: Run/Task/worker-start/check --wait loop, coordinator-owned merges, tracker writes, gates; **loses** the Escalation Diagnosis table (lines 336-356) and the Context Curation contract (311-325) — worth copying, both are mechanism-neutral | entire State Management section; role-profile table (Dispatch plan columns replace it) |
| `review` (213) | verdict → `genie task done` (orchestrator), reviewer snapshot worktrees, lens panels, escalation table | OVERLAID by `genie-orca-review`: reviewer = read-only Orca worker, `VERDICT:` first line, tiers (group/gate/council/retro), must re-run validation; base checklists, lens panels, FIX-FIRST loop apply | "Verdict Reporting" table's `genie task done` row; snapshot-worktree provisioning (Orca gives `--worktree name:`) |
| `fix`, `dream`, `pm`, `report` | board-coupled (`task done/checkout/list`) | `fix` STAYS (only line 57 `task done` is board); `dream/pm/report` standalone-only per DESIGN OUT | — |
| `council`, `refine`, `trace`, `docs`, lenses (`architecture, perf, qa, …`) | no board refs | identical in both modes | — |

**Minimal harness (what "really needed" resolves to):** `src/term-commands/{init,v5-board,v5-task,idea,context,mcp}.ts` + `src/lib/v5/*` (−bridge-watcher) + `src/hooks/{index,dispatch-command,types,env-identity,shell-quoting,handlers/*}` + `lib/{wish-status,term-format,version,genie-home,genie-config,claude-settings,trusted-executable,interactivity}` + new ~1k lines (doctor-lite, plain install/update/uninstall, agents materializer, session context port). ≈12–14k LOC against ≈105k today; every retained module already exists and is tested.