# DRAFT: Genie v5 — Lightweight Body

Date started: 2026-07-01
Status: CRYSTALLIZED → see DESIGN.md (WRS 100/100)

Final decisions: P1 ride stock Warp (confirmed), P2 tasks as files, P3 omni + runner IN (confirmed, revised from defer), P4 single-source skills → 3 targets, P5 tiny CLI, P6 v4-side exporter to files, P7 this repo on `v5` branch (confirmed).

REVISION 2026-07-01 (post-crystallization, user-driven): P2 superseded — codebase reanalysis (task-analyst) showed the task domain is ~90% document-shaped BUT the load-bearing invariant (atomic checkout claim across parallel agent processes) wants transactions, and v4 gitignored `.genie/state/` anyway (file-state was never git-versioned). New rule: **documents in git, operational state in `genie.db` (bun:sqlite, WAL, no daemon)** — per-repo `.genie/genie.db` for tasks/deps/boards/wish-groups (worktree-shared via common-dir), global `~/.genie/genie.db` for the omni runner queue (replaces the omni.db name). Lanes considered: A genie.db (chosen), B files+sqlite-index (rejected: dual-store sync machinery), C pure files (rejected: hand-rolled claims/queries). `genie board` confirmed as first-class daily-driver. DESIGN.md and v5-foundation WISH.md updated accordingly.

## Seed (user's framing, 2026-07-01)

- Concept: **"lightweight body"** — develop only what we need, leave the rest.
- The true asset of Genie is the **brainstorm → wish → work → review system** — could be as simple as skills.
- v4's harness (tmux orchestration, pgserve/Postgres runtime, executor registry, OTel, TUI) existed because, at creation time, Genie was *better at delegating than Claude Code itself*. That gap is gone: Claude Code got good (native teams, background agents, multi-session).
- tmux is clunky. All that was really wanted was **multi-session**, and Warp already provides that (user showed Warp driving multiple Claude Code sessions today — screenshot evidence).
- Direction: **turn Genie into a Warp integration** — "add warp's code in genie, replace the harness, keep the spirit". Keep the `.genie` taxonomy, skills, etc. Stop attempting to control Claude Code.
- Native agent targets (as of today): **Claude Code** and **Codex**. Plus **Hermes** (Nous Research) — https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills
- Note: the existing `v5-major-cutover-handoff` wish (CDN cutover, v4-upgrade, Tier-A export) is NOT what the user wants as v5 — at minimum it's a different concern; possibly partially obsolete under lightweight-body (no more Postgres runtime → nothing to migrate?). TO CLARIFY.

## Evidence gathered

### Warp (researched 2026-07-01)
- **Warp client is open-source since ~Apr 2026** — github.com/warpdotdev/warp, Rust, **AGPLv3** for the client; the WarpUI framework crates (`warpui_core`, `warpui`) are **MIT**. Sources: warp.dev/blog/warp-is-now-open-source, helpnetsecurity.com 2026-04-30.
- **Proprietary remains**: AI agents cloud, Warp Drive collaboration, Oz (cloud agent orchestrator), "agentic management workflows" — vendor-operated, not self-hostable.
- **Integration surfaces available to a third party** (docs.warp.dev/agent-platform):
  - CLI agents framework: Warp natively manages Claude Code, Codex, OpenCode etc. with rich input, notifications, code review, remote session control (this is what the user's screenshot shows).
  - **Launch Configurations (YAML)** — open specific pane layouts/environments programmatically → the direct tmux replacement.
  - **MCP** — Warp's agents consume MCP servers.
  - **Oz CLI / API / SDK** — programmatically create + monitor agent runs (local, CI, remote).
  - Agent profiles & rules (permissions/behavior), environments & secrets, event triggers (Slack/Linear/GitHub Actions), session sharing.
  - Warp SDK / Wasm extensions (2026), webhooks API.
- **License tension**: genie is MIT. Vendoring the AGPL client would be viral; `warpui` crates are MIT and safe. Forking a huge Rust terminal contradicts "lightweight body".

### Hermes (Nous Research, researched 2026-07-01)
- Skills = **SKILL.md with YAML frontmatter**, same basic shape as Claude Code, organized `skills/<category>/<name>/SKILL.md` + optional `scripts/`.
- Frontmatter richer than CC: `requires_toolsets/tools`, platform restrictions, `required_environment_variables`, credential files, `config`, and `blueprint` (cron automation) blocks.
- Discovery: directory scan, hub repos with security scanning, custom taps (`hermes skills tap add`), `.well-known/skills/index.json` endpoints. Publish via `hermes skills publish`.
- Skills delivered to agent via `skill_view` tool with `${HERMES_SKILL_DIR}` substitution.
- Implication: one skill source → 3 targets is feasible; Hermes even has a distribution channel genie could publish to.
- v4 repo facts (from earlier exploration this session):
  - Skills live in `skills/<name>/SKILL.md` with YAML frontmatter; orchestration happens by shelling out to `genie` CLI.
  - Harness = tmux spawn + pgserve/PG (~45 tables) + executor/agent registries + OTel + emit + TUI (OpenTUI) + Tauri app + hooks (branch-guard etc.).
  - `.genie/` taxonomy: wishes/, brainstorms/, agents/, state/, reports/, qa/.

## Provisional decisions (user AFK — to confirm)

| # | Decision | Rationale | Status |
|---|----------|-----------|--------|
| P1 | **Ride stock Warp — no fork, no vendored code.** Genie drives Warp via Launch Configurations (YAML), rules/profiles, and optionally MCP. | User's own words: "this is enough" re: stock Warp; "lightweight body"; AGPL client vs MIT genie; forking a giant Rust terminal is the opposite of lightweight. WarpUI-only and fork options recorded as rejected alternatives. | **CONFIRMED by user 2026-07-01** |

| P2 | **Tasks/boards = files in `.genie/`** — tasks as markdown/JSON in git alongside wishes; boards are derived views (skill/CLI render), not a stateful system. | Zero infra, diffable, worktree-shareable via git common-dir; consistent with filesystem-as-source-of-truth. Alternatives: GitHub Issues (network+vendor coupling for local planning), SQLite (binary state, schema to own). | PROVISIONAL (user AFK; recommended default) |

## Omni in v5 — the daemon problem (to decide)

v4's omni bridge assumed a resident genie runtime. v5 has none. Omni hub is an external service either way; what changes is who receives its events:
- **(a) Event-driven via Warp/Oz triggers** — Omni → webhook → Oz API creates an agent run. No local process; but couples omni flows to Warp's proprietary cloud.
- **(b) Tiny local relay** — a minimal `genie omni listen` process (the ONE resident thing) that maps channel messages → `claude -p`/session injection. Keeps it local; reintroduces a daemon-ish component.
- **(c) Defer omni to post-v5.0** — survives as a concept, ships as its own follow-up wish once the lightweight core is proven.

## v5 shape sketch (working hypothesis)

**Genie v5 = a skills product + a thin, stateless-ish CLI. No daemon, no Postgres, no tmux, no TUI, no OTel.**

Layers:
1. **Skills (the asset)** — brainstorm/wish/work/review + siblings, authored once, targeted at 3 runtimes: Claude Code (`.claude/skills` / plugin), Codex (prompts/AGENTS.md conventions), Hermes (SKILL.md + taps/publish). Frontmatter differences handled by a small build/translate step (Hermes superset: requires_toolsets, blueprint cron, etc.).
2. **Taxonomy (`.genie/`)** — wishes/, brainstorms/, state as **files in git** again (filesystem-as-source-of-truth principle the user already stated in the v4→v5 cutover design). Wish state returns to JSON/markdown; no PG tables.
3. **Delegation** — stop controlling agents. Claude Code native teams/background agents do intra-session delegation; **multi-session = Warp**: `genie work` (or the /work skill) emits a **Warp Launch Configuration** that opens N panes, each running `claude`/`codex` in its own worktree with the right prompt. Warp's CLI-agent management (notifications, rich input, remote control) replaces executor-registry/mailbox/watchdogs.
4. **Optional glue** — an MCP server exposing wish/task state to all three agents + Warp agents (one integration, three consumers). To validate: is it needed at all, or are files + git enough?

**Dies from v4**: pgserve + 76 migrations, executor/agent registries, tmux spawn machinery, mailbox/team-chat over PG, OTel receiver/emit spine, OpenTUI TUI, Tauri app, scheduler-daemon, self-healing detectors, most of the 40 CLI namespaces.
**Survives**: skills/ + .genie taxonomy, wish/task semantics (as files), branch-guard-style hooks (they're Claude Code hooks, cheap to keep), doctor/setup (much smaller), install.sh + cosign distribution (from distribution-exodus — still relevant, maybe simpler).
**User-sorted (2026-07-01)**:
- **SURVIVES: task/board system** (form TBD — file-based? see Q below)
- **SURVIVES: omni channels** (form TBD — no daemon in v5, so bridge mechanism must change)
- **DROPPED: brain/memory** (@khal-os/brain, vaults — gone; agents' own memory + git suffice)
- **DROPPED: sec-scan suite** (sec-scan/sec-remediate/sec-fix — could be spun out as separate tool later; not part of v5)
- `v5-major-cutover-handoff` wish needs a rewrite: old plan assumed v5 had Postgres ("import-from-v4"). Under lightweight body, exit ramp = "v4 PG export → .genie/ files".

| P3 | **REVISED — Omni ships in v5.0 with its runner.** User: "it's acceptable we still have a runner to integrate, omni still needs to be able to reach it, and the integration works fine, we should keep it." v5 keeps ONE optional resident process (a slimmed `genie serve`) whose sole job is Omni reachability: NATS subscriptions (`omni.message.*`, `omni.event.>`), approval token/reaction matching, HMAC-signed agent registration (`OMNI_API_URL`). | The integration works today; Omni is push-based and needs a listener. Exception to daemon-less is explicit and single-purpose. | **CONFIRMED by user 2026-07-01** |
| P3a | **Omni runner internals must come off PG.** v4's approval queue + resolution (omni-approval-handler → claude-sdk-remote-approval) is PG-backed; v5 has no PG. Port the queue to a file/JSONL store owned by the runner (exact store + how approvals surface from stock Claude Code vs the old SDK path = design detail for the wish). NATS remains a dependency only when omni is enabled. | Keep the working behavior, not the storage engine. | PROVISIONAL |
| P4 | **Skills: single source, three emitted targets.** Authored once in genie repo; emitted as Claude Code plugin (repo already has `plugins/genie/` + `.claude-plugin/`), Codex (AGENTS.md/prompt conventions), Hermes (SKILL.md tap via `hermes skills publish` / `.well-known/skills/index.json`). Small build step handles frontmatter dialects. | Hermes format is a near-superset of CC's; Codex is the lossy target. Keeps one source of truth. | PROVISIONAL |
| P5 | **v5 CLI = tiny.** Roughly: `init` (scaffold `.genie/` + install skills into targets), `work`/`launch` (create worktrees + emit Warp Launch Configuration), `task`/`board` (file CRUD + rendered views), `doctor`, `update`. Branch-guard survives as a Claude Code hook shipped by the plugin. Everything else (serve, db, exec, team, agent registry, hook dispatch infra) dies. | Lightweight body: CLI exists only where files+skills can't do the job. | PROVISIONAL |
| P6 | **Exit ramp simplification:** replace `v4-upgrade → import-from-v4 (DB)` with `v4 export → .genie/ files`. v4's final npm release ships an exporter that writes tasks/projects/boards/wishes from PG into v5's file taxonomy. No import code in v5 at all. | v5 has no DB; the 14-table Tier-A contract collapses into a file-writing exporter on v4. Even truer to "v5 embeds zero v4 knowledge". | PROVISIONAL |

## Scope draft

### IN (v5.0)
- Skills: brainstorm, wish, work, review (+ the router and the small siblings worth keeping — exact list TBD) authored once, emitted for Claude Code (plugin), Codex, Hermes (tap).
- `.genie/` taxonomy as git files: wishes/, brainstorms/, tasks/, state/ (JSON/markdown only).
- Warp integration: `/work` and `genie launch` emit Warp Launch Configurations (one pane per agent per worktree); Warp rules/profile templates shipped by `genie init`.
- Worktree creation/cleanup helpers (the good part of v4's work dispatch).
- Omni integration: slimmed single-purpose runner (NATS listener, approval matching, agent registration) — the one resident process; internals ported off PG (P3a).
- Tiny CLI (P5) + branch-guard hook.
- Signed CDN distribution (consumes distribution-exodus install.sh work), much smaller artifact.
- v4 exit ramp per P6 (exporter lives on v4 side).

### OUT (v5.0)
- pgserve/Postgres, all 45 tables, migrations, scheduler-daemon, self-healing detectors.
- tmux orchestration, executor/agent registries, mailbox/team-chat, OTel receiver + emit spine, audit events.
- OpenTUI TUI, Tauri desktop app, design tokens consumers.
- brain/memory (@khal-os/brain) — dropped per user.
- sec-scan suite — dropped per user (candidate for separate tool).
- ~~Omni bridge deferred~~ — REVISED: omni + its runner are IN (P3); what's OUT is PG/NATS as *core* dependencies (NATS loads only when omni is enabled).
- Forking/vendoring Warp code (P1). No Oz cloud dependency in core.

## Risks draft

| Risk | Severity | Mitigation |
|------|----------|------------|
| Warp coupling: launch-config format / CLI-agent features are Warp's to change or paywall | Medium | Orchestration lives in skills (markdown) + worktrees; Warp is a *rendering* layer. Fallback: plain terminal tabs or CC native teams — degrade gracefully, don't break. |
| Concurrent agents writing `.genie/` files without PG locks | Medium | Task-per-file layout (append/create, rarely edit-in-place); keep v4's lockfile.ts (~200 LoC) for the few shared files. |
| Codex parity: no rich skill format → translation lossy | Medium | Treat CC as reference target; Codex gets AGENTS.md + prompt bundle; document parity gaps per skill. |
| Loss of observability (no OTel/audit spine) | Low | Accept per lightweight body; provider session logs + Warp's own UI cover the daily need. |
| v4 users expect DB continuity | Medium | P6 exporter + clear goodbye messaging; pgdump snapshot still taken for rollback. |
| Hermes is young; skills spec may drift | Low | Hermes is an emit target, not a dependency; regenerate on spec change. |
| Omni runner port: approval queue is PG-backed and remote approvals rode the claude-sdk path; stock Claude Code surfaces permissions differently | High | Wish must design the file-based queue + how approvals are captured from stock CC (hooks/AskUserQuestion interception) before porting; keep v4 behavior as the acceptance spec. |

## Success criteria draft

- [ ] Fresh machine: install v5, `genie init`, run /brainstorm → /wish → /work in Claude Code; /work creates N worktrees and emits a Warp Launch Configuration that opens N panes each driving its own agent; PR opened; **zero resident genie processes, zero Postgres**.
- [ ] The same wish is executable with Codex as the driving agent.
- [ ] `hermes skills tap add <genie tap>` surfaces genie skills in Hermes.
- [ ] `.genie/` state is fully inspectable/diffable in git; a second worktree sees the same task state.
- [ ] v4 exporter run on a populated v4 install produces `.genie/` files v5 reads with no import step.
- [ ] v5 artifact is dramatically smaller than v4 (target: CLI < 1/10 of v4's surface; no runtime deps like pgserve/@khal-os/brain/nats/postgres/react).

## Open questions

1. What does "add Warp's code in genie" mean concretely? (Warp is closed-source — integration surface is likely launch configs / MCP / CLI / rules / Warp Drive, not vendored code.)
2. What survives from v4 besides skills + taxonomy? (hooks like branch-guard? task system? mailbox? anything PG?)
3. Distribution: does lightweight-body change the CDN-only v5 plan? Is v5 even a CLI anymore, or a skills+config package?
4. What is the cross-agent contract — one skill source compiled to 3 targets (Claude Code, Codex, Hermes), or lowest-common-denominator markdown?
5. What happens to existing v5 wish (v5-major-cutover-handoff) and data migration if there's no PG in v5?

## WRS

WRS: ██░░░░░░░░ 20/100
 Problem ✅ | Scope ░ | Decisions ░ | Risks ░ | Criteria ░
