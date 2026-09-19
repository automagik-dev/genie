# Genie version timeline (from git, 2026-09-16)

Source: `automagik-dev/genie` history read from the `genie-v6-workflow` worktree. 1,456 tags. HEAD `847db5060` is the `5.260916.7` bump (tag not yet pushed; last tag `v5.260916.6` at `0915a9beb`). Every number below names the ref it was measured at. "src LOC" = `wc -l` over `.ts/.js` files at that ref, excluding tests, `dist/`, `.d.ts`. "not found" means the history does not contain it.

Two facts shape the whole timeline:

- **v1 is a separate root.** `684717280 chore: initial` (2025-07-31) has no merge-base with `v2.0.0`; `v1.0.1` is not an ancestor of HEAD. The main lineage starts at `5c0807a36 initial commit` (2025-09-27).
- **v3 is a second separate root merged in.** `4487dcf4a fix: Critical bug fixes for terminal orchestration` (2026-01-30, namastexlabs, `src/tmux.ts`) was merged at `d1c7200a5` (2026-02-01) and promoted by `21de369a5 chore: v3 promotion — replace v2 codebase with v3` (2026-03-07).

## Era boundaries

| Era | First tag (date) | Last content tag (date) | Tags | Commits | Note |
|---|---|---|---|---|---|
| v1 | v1.0.1 (2025-07-31) | v1.3.2 (2025-08-12) | 26 | 100 on its own root | `npm automagik-genie` |
| v2 | v2.0.0 (2025-10-03) | v2.5.28-rc.4 (2026-01-22) | 419 (360 in Oct 2025) | 166 pre-tag + 1,498 (v2.0.0..v2.5.28-rc.4) | RC-per-push cadence |
| v3 | v3.260302.2 (2026-03-08) | v3.260322.2 (2026-03-22) | 71 (3 stragglers carry 4.x package versions) | 351 rewrite lineage + 332 (v3.260302.2..v3.260322.2) | date-based versions begin |
| v4 | v4.260323.1 (2026-03-23) | v4.260702.10 (2026-07-02) | 669 (163 Mar, 334 Apr, 143 May, 17 Jun, 12 Jul) | 2,903 | v4.260702.11 / v4.260703.1 already carry 5.x |
| v5 | v5.260703.1 (2026-07-03) | v5.260916.6 (2026-09-16) | 270 (174 Jul, 74 Aug, 22 Sep) | 1,603 to HEAD | cut from v4.260702.10 with 12 commits between |

Straggler tags: `v3.260323.1`, `v3.260323.2`, `v3.260402.1` sit on commits whose `package.json` says 4.x; `v4.260702.11` and `v4.260703.1` say 5.x. The counts above use the `v<major>.*` tag prefix as given.

---

## v1 — NPX template initializer (2025-07-31 .. 2025-08-12)

**Body.** A pure Node.js CLI (`package.json`: "No build needed - pure Node.js", `main: lib/init.js`, bin `automagik-genie`). `npx automagik-genie init` copied a `.claude/` folder into the target repo: agent prompts, a `/wish` command, `.mcp.json`, TDD hooks (`.claude/tdd_hook.sh`, `tdd_validator.py`). Requires the Claude CLI. No server, no daemon.

**Flow.** User typed `/wish "..."` in Claude Code. `.claude/commands/wish.md` (v1.3.2) is a 5-step protocol: Intelligent Wish Analysis, Smart Clarification, Agent-Powered Execution Strategy, Intelligent Agent Orchestration, Task Management. Agents were project-prefixed (`{project}-dev-coder`, `-analyzer`, `-dev-planner`, `-dev-fixer`, `-qa-tester`, `-agent-creator`...).

**State.** Only `.claude/` in the target repo. Two flat plan files at `genie/wishes/*.md` (2025-08-01..2025-08-11) with ad-hoc headings (Objective, Analysis Summary, Implementation Sequence); no template.

| Ref | files | src files | src LOC | deps | agents | commands |
|---|---|---|---|---|---|---|
| v1.0.1 | 30 | 3 | 825 | 0 | 13 | 1 (`wish`) |
| v1.3.2 | 111 | 29 | 9,241 | 7 (axios, colors, fs-extra, inquirer, semver, tar, yargs) | 17 | 1 |

**Model.** `claude-sonnet-4-20250514` (3 hits at v1.0.1; first seen `592c37274` 2025-07-31). `claude-3-5-sonnet` appears in statusline tests (`49e0b9a3b` 2025-08-11). "init now asks for opus usage" (`3f6b81f9c` 2025-08-11).

**Headline commits.** `f37caf72a` universal NPX template system (2025-07-31); `96fdd5e70` initializer auto-runs claude (2025-08-01); `6700397fd` NPX update system (2025-08-01); `116e9a4aa` add `.mcp.json` on init and `3105ed3ea` TDD hooks (2025-08-05); `0e66c950b` statusline (2025-08-10).

---

## v2 — `.genie/` workspace + MCP server + Forge (2025-09-27 .. 2026-01-22)

**Body.** TypeScript CLI (`pnpm`, bins `genie`, `automagik-genie`, `-update`, `-rollback`, `-status`, `-cleanup`, `-statusline`, later `-mcp`) plus an MCP server (`fastmcp`, `@modelcontextprotocol/sdk`) and an Ink UI. README v2.0.0: "battle-tested CLI + MCP server so any agent can work in your project with context"; Genie is "the canonical source of prompts, agents, and project metadata" for Hive/Spark/Forge/Omni. By v2.5.28-rc.4 the CLI commands were `init update rollback status cleanup statusline mcp-cleanup run talk task dashboard dashboard-live help`, and `src/mcp/` had tools, resources, middleware, a websocket manager; deps included `@automagik/forge`, `express`, `ws`, `jose`, `@ngrok/ngrok`, `@xenova/transformers`.

**Flow (AGENTS.md v2.0.0).** `/plan` → `/wish` (writes `.genie/wishes/<slug>-wish.md` with inline `<spec_contract>`) → `/forge` (execution groups + validation hooks) → implementation via `mcp__genie__run` → `/review` → `/commit`; branches `feat/<wish-slug>`. By v2.5.28-rc.4 (AGENTS.md): issue → Forge task → "Base Genie creates Forge task, Forge executor takes over, Base Genie STOPS"; MCP tools `mcp__genie__task`, `list_agents`, `get_workspace_info`, `read_spell`, `list_spells`, `list_tasks`, `create_wish`, `continue_task`, `view_task`, `stop`.

**State.** `.genie/product/` (mission, roadmap), `.genie/state/` (sessions.json, provider.json, version.json), `.genie/wishes/`, `.genie/agents/`, `.genie/backups/<timestamp>` snapshots on every command; `.genie/.tasks` (gitignored) = live Forge state. v2.5.28-rc.4 `.genie/` top level: `agents code create neurons product qa reports scripts spells state upgrades utilities wishes` + `AGENTS.md README.md STATE.md config.yaml`. A recursive backup-in-backup explosion on 2025-10-22 left 155,051 backup copies of wish files in history.

**Wish template** (`.genie/agents/wish.md` v2.0.0; `.genie/product/templates/wish-template.md` v2.5.28-rc.4): `# 🧞 {FEATURE NAME} WISH` → Evaluation Matrix (100 pts: Discovery 30 / Implementation 40 / Verification 30) → Context Ledger → Discovery Summary → Executive Summary → Current State → Target State & Guardrails → Execution Groups (`### Group A – {slug}`) → Verification Plan → Evidence Checklist → `<spec_contract>` → Blocker Protocol → Status Log. Vocabulary: phase, group A/B, evidence, forge, blocker. Wishes at v2.5.28-rc.4: 22 slug dirs + 6 flat files (136 wish-matching paths); companions `forge-plan.md`, `task-a..d.md`, `reports/`, `qa/`.

| Ref | files | src files | src LOC | deps | agents | skills |
|---|---|---|---|---|---|---|
| v2.0.0 | 324 | 77 | 10,671 | 8 | 34 (`.genie/agents`) | 0 |
| v2.5.28-rc.4 | 673 | 212 | 41,496 | 15 | 59 | 1 (`council-router`) |

**Model.** v2.0.0: `claude-sonnet-4`, `claude-sonnet-4-5-20250929` (first `042558b7d` 2025-09-30); v2.2.0 (2025-10-14): "Sonnet 4.5" x22; "Haiku 4.5" first `32fa82152` 2025-10-18; `claude-opus-4-20250514` first `f3843ab43` 2025-11-03.

**Headline commits.** `0a88275fa` reinstate CLI bootstrap commands (2025-10-03); `e771a8b70` voice mode + MCP consolidation (2025-10-28) amid a run of MCP transport fixes (RC.85–RC.89, 2025-10-28); `f3843ab43` Folder Structure Migration v2.5.10-rc.3 (2025-11-03); `b8125e902`/`f6c096f9f` session→task rename + unified `genie run` on Forge (2025-11-14/15); `efc46c2c7` headless HTTP MCP server (2025-11-21); `7892ff315` council consolidation (2025-12-05).

---

## v3 — tmux-orchestrated agents, Claude Code plugin, TUI (2026-01-30 .. 2026-03-22)

**Body.** Bun + TypeScript CLI `genie` (`@automagik/genie`, single bin) that spawns Claude Code agents in tmux panes and ships a Claude Code plugin (`.claude-plugin/`, `plugins/genie/`; renamed `4bc294435` 2026-02-27). README v3.260302.2: "Markdown-native agent framework"; `genie tui` is "your cockpit"; `genie daemon` starts a background daemon; `genie agent spawn/list/dashboard/approve/answer/history/events/close/ship/kill/suspend`, `genie team create/list/delete/blueprints`, `genie task create/update/ship/close/ls/link`, `genie work <id>`, `genie council`, `genie send`, `genie inbox`, `genie install/setup/doctor`. Installer handles "tmux, bun, Claude Code plugin". `9b480cd6a feat(db): embed pgserve as genie's persistent brain` (2026-03-20) and NATS (`ac8e78c1c` 2026-03-20) arrive at the very end of the era.

**Flow.** `/brainstorm → /wish → /work → /review → ship`; `/dream` overnight batch; `/brain` Obsidian-style vault in `.genie/brain/`; `/learn`; Council of 10 lenses. Skills at v3.260302.2 (13): brain brainstorm council debug docs dream fix genie-pilot learn refine review wish work. Agents (20): council + 10 `council--*` lenses, debug docs fix implementor learn quality-reviewer refactor spec-reviewer tests.

**State (CLAUDE.md v3.260322.2, "fragmented across 4 scopes").** Wish state `<repo>/.genie/state/<slug>.json`; worker registry `~/.genie/workers.json`; teams `~/.genie/teams/<name>.json`; mailbox `<repo>/.genie/mailbox/<worker>.json`; team chat `<repo>/.genie/chat/<team>.jsonl`; sessions `~/.genie/sessions.json`; native teams `~/.claude/teams/`; config `~/.genie/config.json`. "tmux is required for agent spawn — no fallback."

**Wish template** (`plugins/genie/references/wish-template.md`): `# Wish: <Title>` → Summary → Scope (IN/OUT) → Decisions → Success Criteria → Assumptions → Risks → Execution Groups (`### Group A/B: <Name>`) → Review Results → Files to Create/Modify. `.genie/wishes/<slug>/WISH.md` first appears `2026-02-24`; `.genie/brainstorms/<slug>/DRAFT.md|DESIGN.md` first `2026-03-10`. Wishes in the repo at v3.260322.2: 0 (they lived in a workspace outside the repo until `57f51be97 chore(wishes): migrate workspace wish artifacts to repo`, 2026-04-10).

| Ref | files | src files | src LOC | deps | skills | agents |
|---|---|---|---|---|---|---|
| v3.260302.2 | 200 | 90 | 21,259 | 5 (@inquirer/prompts, commander, js-yaml, uuid, zod) | 13 | 20 |
| v3.260322.2 | 257 | 87 | 19,650 | 5 | 14 | 21 |

**Model.** `claude-opus-4-5-20251101` (first seen in the rewrite root `4487dcf4a`, 2026-01-30; the only id at both v3 tags); "Opus 4.5" `77f63be7a` 2026-02-02; "Opus 4.6" `c7b1c95c9` 2026-02-10.

**Headline commits.** `e86cee4f8` genie-cli-teams, provider-selectable orchestration (2026-02-24); `21de369a5` v3 promotion (2026-03-07); `ed968fea9` agent system: pane colors, hook dispatch, identity inject (2026-03-09); `ba7006b7b` session-per-folder, tui rename, plugin rename, `/report` (2026-03-10); `d08b12d6d` zero-touch install.sh (2026-03-10); `409784301` worktrees moved out of repo (2026-03-16); `223d13b81` `--continue` by session name (2026-03-18); `99439a805` fire-and-forget `genie work` + agent auto-exit and `9b480cd6a` pgserve (2026-03-20).

---

## v4 — the harness: Postgres, NATS, executors, desktop app (2026-03-23 .. 2026-07-02)

**Body.** Same CLI + tmux + plugin as v3, growing into a full harness. README v4.260323.1: "Wishes in, PRs out"; interactive `genie` then `/wish ...`, or autonomous `genie team create auth-fix --repo . --wish auth-bug` where a team-lead "hires agents, dispatches work, runs review loops". Additions dated by first-parent log: `/pm` skill `b0a43ffc4` (03-25); executor model separating agent identity from runtime `7e1836850` (03-28); CLI restructured into 4 namespaces agent/task/team/exec `a3724dc24` (03-29); Tauri desktop "Genie App — AI Orchestration Cockpit" `aa600da09` (03-29); NATS Omni bridge `f95135d17` (04-03), unified Omni bridge (04-05), Postgres Omni queue (04-08); Claude Agent SDK executor `0ee7c6592` (04-04); brain skill removed `6aef8b244` (04-03); hooks trust allowlist + `genie hook trust` `64bf48468` (04-29). At the peak (v4.260601.1) deps were 18: `@anthropic-ai/claude-agent-sdk`, `@opentui/{core,keymap,react}`, `@tauri-apps/api`, `@xterm/headless`, `chokidar`, `postgres`, `nats`, `react`, `react-dom`, `systeminformation`, plus the v3 five; top level held `packages/`, `tools/`, `UPGRADING-pgserve-v3.md`, `VELOCITY.md`.

**Flow / vocabulary (skills/wish/SKILL.md v4.260323.1).** Wish sections: Summary, Scope IN/OUT, Decisions, Success Criteria, Execution Strategy (Wave 1 parallel / Wave 2 after), Execution Groups (`### Group 1: <Name>` with a validation command that exits 0), QA Criteria, Assumptions/Risks, Review Results, Files to Create/Modify, plus "Task Lifecycle Integration (v4)": parent task, child task per group, dependencies. Words: task (14), acceptance criteria (6), engineer, reviewer, team-lead, wave, group. Skills at v4.260702.10 (17): brainstorm council docs dream fix genie genie-hacks learn omni pm refine report review trace wish wizard work (no `agents/*.md` files match at that ref). Wishes in repo at v4.260702.10: 8 dirs + 1 brainstorm.

| Ref | files | src files | src LOC | deps | skills | agents |
|---|---|---|---|---|---|---|
| v4.260323.1 | 306 | 107 | 28,607 | 8 (+nats, pgserve, postgres) | 14 | 22 |
| v4.260501.1 | 1,245 | 461 | 127,294 | 18 | 17 | 0 |
| v4.260601.1 | 1,390 | 497 | 139,014 | 18 | 17 | 0 |
| v4.260702.10 | 211 | 65 | 13,696 | 4 | 17 | 0 |

The last row is the v5 cutover already applied on the v4 line: `972b46949 chore(v5)!: dependency + config purge — 3 runtime deps` and `d3a8b271b chore(v5)!: delete non-src harness — apps, tokens, watchdog, tmux/sec scripts, dead tests` (both 2026-07-02), merged via PRs #2499/#2500 (`v5` branch) and #2504 `wish/v5-completion`.

**Model.** v4.260323.1: `claude-opus-4-5-20251101`, `claude-sonnet-4-20250514`. "Opus 4.7" first `8119e6824` 2026-04-19; `claude-opus-4-7` pinned `25172361a` 2026-04-28 ("reject cross-provider model values"); `claude-haiku-4-5` `57f51be97` 2026-04-10; v4.260601.1: `claude-opus-4-7` x13. "Opus 4.8" first `d19c6a43a` 2026-06-14 (Hermes profile seed).

**Headline commits.** `6a22cfc32` skills-v4-core-trio (03-23); `a3724dc24` 4-object CLI namespaces (03-29); `aa600da09` desktop cockpit (03-29); `0ee7c6592` SDK executor (04-04); `64bf48468` hook trust (04-29); `6f21095b2 feat(v5): genie.db state engine` (07-01) and `e5606ae3b feat(v5): genie launch — wish slug to opened Warp cockpit` (07-02) open the cutover.

---

## v5 — lightweight body: skills + markdown + one SQLite file (2026-07-03 .. now)

**Body at v5.260703.1.** README: "a set of skills, plain-markdown documents in git, and a single per-repo SQLite file. No daemons, no Postgres, nothing resident." 12 commands (`init launch board task omni setup doctor hook shortcuts update uninstall help`), 4 deps (`@inquirer/prompts commander nats zod`), ~0.9 MB bundle, cosign-signed releases. Claude Code plugin still shipped (`.claude-plugin/`, `plugins/genie/`). `/work` fans out through Claude Code native teams; reviewer ≠ engineer. v4 preserved on the `v4` branch.

**Flow.** `/brainstorm` (DESIGN.md) → `/wish` (WISH.md with groups) → `/work` (waves) → `/review` (SHIP / FIX-FIRST / BLOCKED); `genie board`; `genie task checkout/heartbeat/report/done`. State: `<repo>/.genie/genie.db` (tasks, boards, dependency edges), `~/.genie/genie.db` (omni queue + inbox, `a2e44f261` 2026-07-02), docs in `.genie/wishes/<slug>/`, `.genie/brainstorms/<slug>/`, `.genie/INDEX.md`; `.genie/roadmap.json` canonical via three-way sync from `80f375e1e` (2026-07-28).

**Sub-eras (first-parent dates).**

| Sub-era | Dates | Evidence |
|---|---|---|
| Foundation + Warp + MCP stdio | 2026-07-01 .. 07-23 | `6f21095b2` genie.db (07-01); `e5606ae3b` `genie launch` Warp (07-02); `d5d232702 feat(mcp): genie mcp stdio server — Warp + Claude Code read genie state` (07-03); `1430def4a` routing model pins (07-09); agent-sync claude/codex/hermes adapters `dbe5a829a`..`411e3de89` (07-10); hook-injection-hardening #2536 (07-09); first `.claude/workflows/` script `pm-ledger-verify.js` `a11f785b2` (07-12; `/council` as saved workflow referenced `c6f5978d5` 07-10); `2ff71abe1` ui-bridge (07-21); `c89cf5c2f` Codex marker-owned MCP route (07-22); in-process Sigstore verify deps `331a8b1ec` and `nats` → `@nats-io/transport-node` `bd5033c3a` (07-23); `80f375e1e` roadmap.json canonical (07-28) |
| Launch retirement | 2026-08-13 | `782a34397 feat: retire genie launch atomically with its consumers` |
| Orca dual-mode + MCP retirement | 2026-08-29 .. 08-30 | `80f3f88ea` lifecycle mode guards; `f71f1b1f0` public Orca adapter; `cfc70cd59` native plugin runtime; `c8280d403 feat(mcp): retire legacy server surfaces` (#2820); `f45d634b8` retire ui-bridge (#2834); `b1a31c469` retire dead `genie mcp` entry in `.mcp.json`; `7b48ee196` `orca-plugin` ref + marketplace (08-30) |
| skills.sh channel | 2026-08-30 .. 09-01 | `b43bd80c7` skills.sh installer (08-30); `6c15d26a5` legacy retirement + doctor surface (08-30); `1b34d7d4b` skills as top-level skills.sh-visible dirs (08-31); `e250b9463 refactor(hooks): delete the hook runtime and the Claude/Kimi plugin payload` (08-31, `.claude-plugin` gone); skills-everywhere b/c merged (08-31, 09-01) |
| Board + workflow catalog | 2026-09-07 .. 09-16 | `b8b64cf6c` board and delivery (09-07); roadmap-board republish #2898 (09-09); `e641eb312 genie config get` (09-15); workflows-catalog #2908 with `council.js`, `skill-audit-sweep.js`, `workfly.js` (09-15) and `docs-audit.js`, `research-sweep.js` (09-16); workfly #2911 (09-16); `bdcb5ec8d` revalidate retired dirs (09-15); fix/skill-leftovers #2928 (09-16) |

**Wish template.** v5.260703.1 `templates/wish-template.md`: `# Wish: <TODO: Title>` → Summary → Scope IN/OUT → Decisions → Success Criteria → Execution Strategy (Wave 1 sequential) → Execution Groups (`### Group 1`, validation command exits 0) → QA Criteria → Assumptions / Risks → Review Results → Files to Create/Modify. HEAD `skills/wish/templates/wish-template.md` adds **Simplicity Case** and **Dependencies** after Decisions. A live wish (`.genie/wishes/workflows-catalog/WISH.md`) records Review Results as dated entries: "Plan review — 2026-09-15 — SHIP", "Execution — council run — … `proceed-with-conditions`". Durable statuses per CLAUDE.md: DRAFT, FIX-FIRST, APPROVED, IN_PROGRESS, BLOCKED, SHIPPED; lanes Idea → Brainstorm → Wish → Work → Review → Done. Wishes in repo: 8 dirs + 2 brainstorms at v5.260703.1; 51 wish dirs + 30 brainstorm dirs at HEAD.

| Ref | files | src files | src LOC | deps | skills | commands | workflows |
|---|---|---|---|---|---|---|---|
| v5.260703.1 | 217 | 65 | 13,768 | 4 | 17 | 12 | 0 |
| HEAD (5.260916.7) | 601 | 129 | 54,500 | 7 (`@inquirer/prompts @nats-io/transport-node @sigstore/{bundle,protobuf-specs,verify} commander zod`) | 21 (+authoring merge quick research skill-audit verify workfly; −pm trace wizard) | 16 (`board idea doctor init install config context mcp omni setup shortcuts task ui-bridge uninstall update help`; `mcp` and `ui-bridge` are exit-1 stubs) | 6 |

**Model.** "Fable 5" and "Mythos" first `821eeb4c7 docs(wish): skills-fable5-revamp` (2026-07-04); `claude-opus-4-8` and "Sonnet 5" `3d40966ca` (07-09); `claude-fable-5` `b7a6da54a` (07-21); `claude-opus-5` `829ffc9a3` (08-30); `claude-fable-5-1` `b599fdc0e feat(skills): make refine target-aware with per-model refiner prompts` (2026-09-15). HEAD counts: Fable 5 x30, Opus 4.8 x16, claude-opus-4-8 x7, Sonnet 5 x7, claude-opus-5 x6, Fable 5.1 x6, claude-fable-5-1 x2, Haiku 4.5 x2.

**Headline commits.** `6f21095b2` genie.db state engine (07-01); `d5d232702` `genie mcp` stdio server (07-03) → `c8280d403` retired (08-29); `f71f1b1f0` Orca adapter + `cfc70cd59` native plugin runtime (08-29); `b43bd80c7` skills.sh channel (08-30); `e250b9463` hook runtime + plugin payload deleted (08-31); workflows-catalog #2908 + workfly #2911 (09-15/16).

---

## Wish paths over time

Counting from `git log --all --name-only -- '*wish*'`: 156,373 matching paths ever, of which 155,051 are inside `.genie/backups/…` (the 2025-10-22 recursive backup chain) and 1,322 are not. Excluding backups and `.claude/worktrees/**` nests:

| Pattern | Files added | First | Last | Era |
|---|---|---|---|---|
| `genie/wishes/<slug>.md` | 2 | 2025-08-01 | 2025-08-11 | v1 (separate root) |
| `.genie/wishes/<slug>.md` (flat, `<slug>-wish.md`) | 14 | 2025-09-27 | 2026-04-30 | v2 convention; last stragglers in v4 |
| `.genie/wishes/<slug>/WISH.md` | 284 | 2026-02-24 | 2026-09-15 | v3 rewrite → today (468 `WISH.md` paths ever incl. worktree nests) |
| `.genie/wishes/<slug>/wish.md` (lowercase) | 16 | 2026-02-02 | 2026-03-03 | v3 rewrite lineage, before the `WISH.md` casing settled |
| `.genie/wishes/<slug>/forge-plan.md` | 2 | 2025-10-15 | 2025-10-15 | v2 Forge |
| `.genie/wishes/<slug>/task-*.md` | 12 | 2025-10-07 | 2025-10-17 | v2 |
| `.genie/wishes/<slug>/reports/*` | 82 | 2025-10-07 | 2026-07-13 | v2..v5 |
| `.genie/wishes/<slug>/qa/*` | 34 | 2025-09-27 | 2026-09-01 | v2..v5 |
| `.genie/wishes/<slug>/qa.md` | 3 | 2026-07-02 | 2026-07-02 | v5 cutover |
| `.genie/wishes/<slug>/validate/*` | 8 | 2026-07-09 | 2026-07-10 | v5 |
| `.genie/wishes/<slug>/REVIEW*.md` | 4 | 2026-04-23 | 2026-07-11 | v4/v5 |
| `.genie/wishes/<slug>/REPORT.md` | 5 | 2026-04-28 | 2026-05-03 | v4 |
| `.genie/wishes/<slug>/HANDOFF.md` | 2 | 2026-08-06 | 2026-08-31 | v5 |
| `.genie/wishes/<slug>/DESIGN.md` | 1 | 2026-07-10 | 2026-07-10 | v5 |
| `.genie/brainstorms/<slug>/DRAFT.md` / `DESIGN.md` / any `.md` | 65 / 47 / 124 | 2026-03-10 | 2026-09-03 | v3..v5 |
| any `.genie/wishes/<slug>/<sub>/<file>` | 332 | 2025-09-27 | 2026-09-01 | |

Distinct `.genie/wishes/<slug>/` directories ever: 353. Prompt-side locations that also matched: `.claude/commands/wish.md` (v1/v2 templates), `.genie/agents/wish.md` (v2.0.0), `.genie/neurons/wish.md` + `.genie/spells/wish-*.md` (v2.5), `plugins/genie/references/wish-template.md` (v3), `skills/wish/SKILL.md` (v3→HEAD), `templates/wish-template.md` (v5.260703.1), `skills/wish/templates/wish-template.md` (HEAD).

## Model timeline (first appearance in any ref)

| Model string | First commit | Date | Era |
|---|---|---|---|
| `claude-sonnet-4-20250514` / "Sonnet 4" | `592c37274` chore: base genie template | 2025-07-31 | v1 |
| `claude-3-5-sonnet` | `49e0b9a3b` statusline test expectations | 2025-08-11 | v1 |
| `claude-sonnet-4-5-20250929` / "Sonnet 4.5" | `042558b7d` update genie | 2025-09-30 | v2 |
| "Haiku 4.5" | `32fa82152` MCP session disappearance investigation | 2025-10-18 | v2 |
| `claude-opus-4-20250514` | `f3843ab43` Folder Structure Migration v2.5.10-rc.3 | 2025-11-03 | v2 |
| `claude-opus-4-5-20251101` | `4487dcf4a` terminal orchestration root | 2026-01-30 | v3 rewrite |
| "Opus 4.5" | `77f63be7a` upd | 2026-02-02 | v3 |
| "Opus 4.6" | `c7b1c95c9` self-knowledge Feb 10 session | 2026-02-10 | v3 (`claude-opus-4-6` id: not found) |
| `claude-haiku-4-5` | `57f51be97` migrate workspace wish artifacts | 2026-04-10 | v4 |
| "Opus 4.7" | `8119e6824` forward team context | 2026-04-19 | v4 |
| `claude-opus-4-7` | `25172361a` reject cross-provider model values | 2026-04-28 | v4 |
| "Opus 4.8" | `d19c6a43a` portable Hermes Genie profile seed | 2026-06-14 | v4 |
| "Fable 5", "Mythos" | `821eeb4c7` skills-fable5-revamp wish | 2026-07-04 | v5 |
| `claude-opus-4-8`, "Sonnet 5", `opus-4-1` | `3d40966ca` token-efficiency program / `1430def4a` routing pins | 2026-07-09 | v5 |
| `claude-fable-5` | `b7a6da54a` routing day-3 QA closed | 2026-07-21 | v5 |
| `claude-opus-5` | `829ffc9a3` codex-skill-installer design | 2026-08-30 | v5 |
| `claude-fable-5-1` / "Fable 5.1" | `b599fdc0e` refine target-aware per-model prompts | 2026-09-15 | v5 |
| `claude-sonnet-5`, `claude-mythos`, `claude-opus-4-1-20250805`, `claude-3-7-sonnet` | not found | | |

## Simplification curve

| Era / ref | files | src LOC | runtime deps | skills / agents / commands | What the body was |
|---|---|---|---|---|---|
| v1.0.1 (2025-07-31) | 30 | 825 | 0 | 0 / 13 / 1 | Node script that copies `.claude/` agents + `/wish` into a repo |
| v1.3.2 (2025-08-12) | 111 | 9,241 | 7 | 0 / 17 / 1 | same + update, statusline, TDD hooks, `.mcp.json` |
| v2.0.0 (2025-10-03) | 324 | 10,671 | 8 | 0 / 34 / 7 bins | TS CLI + MCP server + Ink UI over a `.genie/` workspace; plan→wish→forge→review |
| v2.5.28-rc.4 (2026-01-22) | 673 | 41,496 | 15 | 1 / 59 / 13 | MCP server + Forge executor integration, spells/neurons, `genie run`/`talk`/`task` |
| v3.260302.2 (2026-03-08) | 200 | 21,259 | 5 | 13 / 20 / ~35 | Bun CLI spawning Claude Code in tmux; Claude Code plugin; `genie tui`, `genie daemon`; JSON state in 4 scopes |
| v4.260323.1 (2026-03-23) | 306 | 28,607 | 8 | 14 / 22 / 4 namespaces | v3 + teams/team-lead, Postgres (pgserve), NATS |
| v4.260601.1 (2026-06-01, peak) | 1,390 | 139,014 | 18 | 17 / 0 / — | full harness: Postgres, NATS, SDK executor, Tauri desktop app, opentui console, telemetry |
| v5.260703.1 (2026-07-03) | 217 | 13,768 | 4 | 17 / 0 / 12 | skills + markdown in git + one SQLite file; Warp launch; MCP stdio read server; plugin still shipped |
| HEAD 5.260916.7 (2026-09-16) | 601 | 54,500 | 7 | 21 / 0 / 16 (+6 workflows) | zero-daemon CLI; MCP/UI-bridge/launch/hook runtime/plugin payload retired; skills.sh delivery; Orca dual-mode; Sigstore-verified updates; workflow catalog |

HEAD's growth over v5.260703.1 is tests, the Sigstore verifier, the skills.sh installer/retirement machinery, the Orca adapter, and 51 wish + 30 brainstorm directories under `.genie/` (220 `.md` files vs 61).
