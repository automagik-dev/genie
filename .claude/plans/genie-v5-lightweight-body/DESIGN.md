# Design: Genie v5 — Lightweight Body

| Field | Value |
|-------|-------|
| **Slug** | `genie-v5-lightweight-body` |
| **Date** | 2026-07-01 |
| **WRS** | 100/100 |
| **Supersedes** | `.genie/brainstorms/v5-major-cutover-handoff/` premise that v5 has a Postgres backend (its distribution/goodbye work is partially reusable; its import-from-v4 concept is obsolete — see D6) |

## Problem

Genie v4 carries a 79K-LoC harness (pgserve/Postgres, tmux orchestration, executor registries, OTel spine, TUI, desktop app) built to out-delegate early Claude Code — a gap that no longer exists now that Claude Code has native teams/multi-session and Warp manages CLI agents natively, so the harness is now dead weight around Genie's true asset: the brainstorm → wish → work → review skill system and the `.genie` taxonomy.

## Scope

### IN

- **Skills as the product**: brainstorm, wish, work, review (+ router and the small siblings worth keeping — exact list decided in the skills-portability wish), authored once in this repo, freed of any dependency on the v4 runtime (no PG-backed `genie task` calls inside skill prompts).
- **Three native agent targets**: emitted as a Claude Code plugin (repo already has `plugins/genie/` + `.claude-plugin/`), Codex conventions (AGENTS.md/prompt bundle), and a Hermes tap (SKILL.md publish via `hermes skills publish` / `.well-known/skills/index.json`).
- **`.genie/` taxonomy**: planning documents (wishes/, brainstorms/) as markdown in git; operational state (tasks, dependencies, stage logs, boards, wish-group state) in per-repo `.genie/genie.db` (bun:sqlite, worktree-shared via git common-dir, gitignored — as v4's state already was). `genie task export` emits JSON for portability/debugging. Boards are queries over genie.db, not stored views.
- **Warp integration (ride stock Warp)**: `/work` and `genie launch` emit Warp Launch Configurations (one pane per agent per worktree); `genie init` ships Warp rules/profile templates. Warp's CLI-agent management (notifications, rich input, remote session control) replaces tmux, executor registry, mailbox, and watchdogs.
- **Worktree helpers**: create/cleanup per execution group (salvaged from v4 work dispatch).
- **Tiny CLI**: `init`, `launch`/`work`, `task`/`board` (genie.db CRUD + render — `genie board` is first-class), `doctor`, `update`. Branch-guard survives as a plugin-shipped Claude Code hook.
- **Omni integration with its runner**: one resident process (slimmed `genie serve`) whose sole job is Omni reachability — NATS subscriptions (`omni.message.*`, `omni.event.>`), approval token/reaction matching, ed25519-signed agent registration. Internals ported off PG to the global-scope `~/.genie/genie.db` (bun:sqlite, WAL mode).
- **v4 exit ramp**: exporter shipped on the v4 final npm release writing tasks/projects/boards/wish state from PG into v5's `genie.db` (+ wish/brainstorm documents already in git); pgdump snapshot retained as rollback floor; goodbye banner (salvaged from the old cutover wish).
- **Distribution**: signed CDN install.sh (consumes `distribution-exodus` work); dramatically smaller artifact.
- **Home**: this repo, long-lived `v5` branch; v4 maintenance continues on `dev`/`main`.

### OUT

- pgserve/Postgres, all 54 tables across 76 migrations, scheduler-daemon, self-healing detectors, session-capture/backfill.
- tmux orchestration, executor/agent registries, PG mailbox/team-chat, OTel receiver + emit spine, audit-event system.
- OpenTUI TUI, Tauri desktop app, genie-tokens consumers.
- Brain/memory (`@khal-os/brain`, vaults) — dropped (user decision 2026-07-01).
- sec-scan suite (sec-scan/sec-remediate/sec-fix) — dropped; candidate for a separate tool.
- Forking or vendoring Warp code (AGPL client, WarpUI crates) and any Oz-cloud dependency in core.
- The old `import-from-v4` v5-side importer and the 14-table Tier-A JSONL bundle contract — obsolete under D6.
- Native Windows distribution (unchanged deferral).

## Approach

Invert the architecture: instead of a runtime that controls agents, Genie becomes **content plus glue**. Skills carry the methodology; git carries the documents and genie.db carries the operational state; stock Warp carries multi-session orchestration; Claude Code/Codex/Hermes carry execution. The only resident process is the Omni runner, kept because the integration works and Omni is push-based.

Alternatives considered and rejected: forking/embedding the now-open-source Warp client (AGPL vs MIT, giant Rust codebase — the opposite of lightweight body); building a cockpit on the MIT WarpUI crates (owning a UI again); deferring Omni (rejected by user — the runner is acceptable); fresh repo (rejected by user — this repo's history and salvageable code outweigh the demolition discipline cost); GitHub Issues for tasks (vendor/network coupling); task-per-file markdown for operational state (rejected on codebase analysis 2026-07-01: atomic checkout claims across parallel agent processes want transactions, and v4 never git-versioned task state anyway); files-as-truth + sqlite index dual-store (hidden sync machinery).

## Decisions

| Decision | Rationale |
|----------|-----------|
| **D1 — Ride stock Warp; no fork, no vendored code** (user-confirmed) | Stock Warp already manages Claude Code/Codex sessions ("this is enough"). Launch Configurations replace tmux. AGPL client vs MIT genie; owning a terminal contradicts lightweight body. |
| **D2 (revised 2026-07-01, user-confirmed) — Documents in git, operational state in `genie.db` (bun:sqlite), zero daemons** | Planning documents (WISH.md, DESIGN.md, brainstorms) stay markdown in git — humans diff and review them. Operational state (tasks, dependencies, stage logs, boards, wish execution-group state) lives in per-repo `.genie/genie.db`, worktree-shared via git common-dir. Evidence for the revision: v4 gitignores `.genie/state/` (task state was never git-versioned); the load-bearing invariant — atomic checkout claims across parallel agent processes — is native in SQLite transactions and hand-rolled in files; `bun:sqlite` is built-in (zero deps, no daemon). Schema kept deliberately minimal (~6 tables vs v4's 54) + `genie task export` to JSON for portability. Supersedes the original task-per-file decision (rejected as the "oogabooga" lane); files+sqlite-index dual-store rejected as hidden sync machinery. |
| **D3 — Omni ships in v5.0 with one single-purpose runner** (user-confirmed) | "The integration works fine, we should keep it." Omni is push-based and needs a listener; the exception to daemon-less is explicit and minimal. Internals port off PG to the global-scope `~/.genie/genie.db` (bun:sqlite, WAL) — the queue needs real lookups (match by `omni_message_id`, status transitions, retry scans); same engine and naming as the per-repo state DB (D2). NATS loads only when omni is enabled. **Known tension with D1**: v4 remote approvals work because genie runs agents through the claude-agent-sdk (`permissionMode: 'remoteApproval'`); riding stock Warp/CC removes that interception point. Group 5 therefore opens with a feasibility spike; named fallback = remote approvals available only when the agent is launched via the SDK path. |
| **D4 — Skills: single source, three emitted targets** | Hermes SKILL.md is a near-superset of Claude Code's; Codex is the lossy target handled via AGENTS.md conventions. One source of truth, mechanical translation. |
| **D5 — Tiny CLI; capabilities live in skills+files wherever possible** | CLI exists only where files and skills can't do the job (worktrees, launch-config emit, doctor, update, omni runner). **`genie board` is explicitly first-class at top level** — a daily-driver kanban render over task files (user, 2026-07-01: "I use it often"); it counts inside the ≤10 command budget. |
| **D6 — Exit ramp is a v4-side exporter writing v5's genie.db + documents** | The old bundle/import contract collapses: v4's final npm release exports PG straight into v5's genie.db schema (and wish/brainstorm documents are already in git); v5 contains zero v4 knowledge and zero import code. |
| **D7 — v5 lives on a long-lived `v5` branch in this repo** (user-confirmed) | Preserves history, CI, and salvageable code (lockfile.ts, omni handlers, worktree helpers). Demolition discipline enforced by dependency purge + dead-code gates rather than repo boundaries. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| Omni runner port: approval queue is PG-backed and remote approvals rode the claude-sdk path (`permissionMode: 'remoteApproval'` — only exists when genie launches the agent via SDK); stock CC under D1 removes that interception point | High | Group 5 opens with a feasibility spike (stock-CC capture via hooks/permission interception) before any porting; fallback: remote approvals supported only for SDK-launched agents. If the spike fails and the fallback is unacceptable, Group 5 scope is renegotiated — it is unshippable as written. v4 behavior is the acceptance spec. |
| Warp coupling: launch-config format and CLI-agent features are Warp's to change or paywall | Medium | Orchestration truth lives in skills + worktrees; Warp is a rendering layer. Fallback: plain terminal tabs or CC native teams — degrade gracefully. |
| genie.db schema ownership: minimal schema drifts back toward v4's 54-table sprawl | Medium | Hard cap in review: new tables need a written justification; schema versioned by a single PRAGMA user_version, no migration framework; `genie task export`/`import` JSON keeps data portable if the schema must reset. |
| Concurrent agents writing shared markdown documents (WISH.md status fields, plans INDEX) | Low | Documents are single-writer in practice (the orchestrating session); operational multi-writer state lives in genie.db transactions; salvage v4's lockfile.ts if a shared doc write shows up. |
| Codex parity: no rich skill format, translation lossy | Medium | Claude Code is the reference target; per-skill parity gaps documented in the emit step. |
| In-place demolition on a shared repo lets dead weight survive | Medium | Dedicated demolition group with dependency purge (postgres, nats-in-core, react, opentui, tauri...) verified by knip/dead-code gates and bundle-size criterion. |
| v4 users expect DB continuity | Medium | D6 exporter + goodbye messaging; pgdump snapshot still taken for rollback. |
| Loss of observability (no OTel/audit spine) | Low | Accepted per lightweight body; provider session logs + Warp's UI cover daily needs. |
| Hermes is young; skills spec may drift | Low | Hermes is an emit target, not a dependency; regenerate on spec change. |

## Execution Groups (seed for /wish)

This is umbrella-scale: each group below is sized to become its own wish (or a group in a small number of wishes) on the `v5` branch, shippable independently.

| Grupo | Entregável | Depende de | Validação |
|-------|-----------|------------|-----------|
| 1. Skills portability | Core skills (brainstorm/wish/work/review + kept siblings) rewritten v4-runtime-independent: documents in git, operational state via the v5 state surface. Dispatch mechanism for /work at this stage = **CC native teams/subagents** (intra-session parallelism); Warp multi-pane arrives in Group 3 as the multi-session upgrade, not a Group 1 dependency | — | Run full lifecycle incl. a 2-group parallel /work via CC native teams, zero genie daemons/PG running |
| 2. genie.db state engine + task CLI | Minimal bun:sqlite schema (~6 tables: tasks, dependencies, stage logs, boards, wish-group state), atomic checkout claim, `genie task`/`genie board` CRUD + render, `genie task export` JSON | — | Two worktrees see consistent task state via common-dir genie.db; parallel checkout race test; `bun test` on new modules |
| 3. Warp integration | Launch-config emitter, worktree helpers, `genie init` with rules/profiles | 2 | `/work` on a 3-group wish opens 3 Warp panes, each agent in its own worktree |
| 4. Multi-target emit | Build step producing CC plugin, Codex bundle, Hermes tap | 1 | Plugin loads in CC; `hermes skills tap add` surfaces genie skills; parity gaps doc exists |
| 5. Omni runner port | Slim `genie serve` (NATS listener, approval queue in global `~/.genie/genie.db`, registration) off PG | 2 | WhatsApp approve/deny round-trip against a live agent, no Postgres running |
| 6. Harness demolition | Delete pgserve/TUI/registries/OTel/tauri + dependency purge on `v5` branch | 1–5 | `bun run check` green; deps postgres/react/opentui/tauri gone; **top-level CLI command count ≤ 10** (v4: ~40 namespaces) |
| 7. v4 exit ramp | Exporter on v4 (`dev`) writing v5 genie.db state (+ documents already in git) + goodbye banner + pgdump snapshot | 2 (schema) | Populated v4 install exports; v5 reads the state with no import step |
| 8. Distribution | Signed CDN install.sh for the v5 artifact | 6 | Fresh-machine install → `genie init` → lifecycle works |

## Success Criteria

- [ ] Fresh machine: install v5, `genie init`, run /brainstorm → /wish → /work in Claude Code; /work creates N worktrees and emits a Warp Launch Configuration that opens N panes, each driving its own agent; PR opened; zero resident genie processes except the (optional) Omni runner; zero Postgres.
- [ ] The same wish is executable with Codex as the driving agent.
- [ ] `hermes skills tap add <genie-tap>` surfaces genie skills in Hermes.
- [ ] Planning documents (WISH.md/DESIGN.md/brainstorms) are inspectable/diffable in git; a second worktree sees the same task state through the shared `.genie/genie.db`; `genie task export` emits the full state as JSON.
- [ ] Omni round-trip (message → agent, approval via WhatsApp reply/reaction) works with only the slim runner resident and no Postgres.
- [ ] v4 exporter run on a populated v4 install produces v5 genie.db state that v5 reads directly (no import step in v5).
- [ ] v5 dependency tree contains no postgres/pgserve, no react/opentui/tauri, no @khal-os/brain; NATS present only behind the omni feature; the only database engine anywhere is Bun's built-in `bun:sqlite` (per-repo `.genie/genie.db` + global `~/.genie/genie.db` — no new dependency, no daemon); top-level CLI command count ≤ 10 (v4: ~40 namespaces).
