# Orca integration research — what the Genie plugin should become in v6

Read-only research, 2026-09-19. Host Orca CLI **1.4.205** (`orca --version`), schema v1, **234 commands**
(`orca agent-context --json` → `commandCount: 234`).

**Citation key.** `[cli]` = `orca --help` / `orca agent-context --json` on this host. `[guide:X]` = the
version-matched guide the binary itself serves, `orca skills get X` (the installed `~/.claude/skills/orca-cli/SKILL.md`
and `.../orchestration/SKILL.md` are *discovery stubs only* — they say so in their own text and refuse to list flags).
`[repo:path]` = a file in `/home/genie/workspace/repos/genie`. `[gh:N]` = issue N in `stablyai/orca` (Orca's own
tracker). `[super-orca]` = `github.com/marius-patrik/super-orca`, a **third-party reconstruction** of plugin API v0 —
used only where `[gh:N]` corroborates it.

---

## A) Orca's native mechanisms

| Mechanism | What it is | CLI verb / UI surface | Citation |
|---|---|---|---|
| **Workspaces (worktrees)** | Orca's tracked view of a checkout + its terminals, tabs, metadata. Id is `<repoId>::<path>`. Folder workspaces are valid — Git is not required. | `worktree create/list/show/set/rm/current/ps` | [cli]; [guide:orca-cli §Worktrees]; [guide:orchestration §Authority] |
| **Board / kanban** | **Not a separate object.** The board's columns *are* workspace statuses; each workspace is one card. | `worktree set --workspace-status <id>`; built-in action `workspace.openBoard` | [cli] `worktree set` notes: *"Workspace status ids match the board columns (defaults: todo, in-progress, in-review, completed); custom statuses use their configured id."* |
| **Card status line** | The one-line comment on a workspace card. | `worktree set --comment "<text>"` | [guide:orca-cli §Worktree Comments] |
| **Tasks page** | Reads **external** work items from four native providers. Not a local task store. | no `orca task` verb exists; `linear …` (27 subcommands) is the only provider with a CLI | [cli] full group list has no `task`; [gh:15328] *"Orca supports four task providers — GitHub, GitLab, Linear and Jira."* |
| **Linked work item** | A workspace's link to one external item. Fields `linkedWorkItem`, `linkedTaskSourceContext`, `linkedIssue`, `linkedPR`, `linkedLinearIssue`, `linkedGitLabMR` in `src/shared/worktree/types.ts`. | `worktree create/set --issue <n>` (GitHub) or `--linear-issue <url|id>` | [cli]; [gh:15318] |
| **Agent dashboard / harnesses** | The agent picker, `+` menu, quick launch. `TuiAgent` is a **closed 35-member union** in `src/shared/types.ts` referenced by ~226 files. | `worktree create --agent <id>`; `orchestration worker-start --agent` | [guide:orca-cli §Agent/setup flags]; [gh:13306] |
| **Terminals** | Managed PTYs per workspace, with TUI-idle waits and durable send receipts. | `terminal create/list/read/send/wait/split/rename/switch/close` | [cli]; [guide:orca-cli §Terminals] |
| **Orchestration** | Run (durable namespace + coordinator inbox) → Task (work) → Dispatch (one authoritative attempt). Threaded messages, blocking ask/reply, DAG deps, decision gates, supervised workers. | `orchestration run-*/task-*/worker-*/send/check/ask/reply/gate-*` (29 verbs) | [cli]; [guide:orchestration] |
| **Automations** | A **scheduled prompt** run by a chosen provider against a new or existing workspace. Triggers: hourly/daily/weekdays/weekly/5-field cron/RRULE. Has `--precheck` (exit 0 continues) and `--source-context <TaskSourceContext JSON>`. | `automations create/edit/list/show/run/runs/remove` | [cli]; [guide:orca-cli ref `references/automations.md`] |
| **Artifacts** | Publish HTML/Markdown behind a share URL via the signed-in Orca account. **Publishing is default-off and only a human can enable it** (Settings → Artifacts); no CLI/RPC grant path. | `artifacts share/list/update/unshare/delete` | [guide:orca-cli §Artifacts] |
| **Skills** | Version-matched guides bundled with the binary, plus installed selectors. Orca reads the shared `~/.agents/skills` home. | `skills list/get/installed/install/update/share` | [cli]; [repo:CLAUDE.md skills gotcha] |
| **Agent hooks** | Per-harness shell hooks Orca installs and spools events from (`ORCA_AGENT_HOOK_ENDPOINT`, `ORCA_PANE_KEY`, `ORCA_WORKTREE_ID`). Orca-owned, not a documented extension point. | `~/.orca/agent-hooks/{claude,codex,kimi}-hook.sh` on this host | direct read |
| **Projects / repos / hosts / environments** | Durable projects, host setups, paired remote runtimes. | `project *`, `repo *`, `host list`, `environment *`, `vm recipe doctor` | [cli] |
| **"Workflows"** | **No native Orca concept.** The word comes from genie's own marketplace index: `"categories": ["workflows"]`. Nothing in 234 CLI commands or the 7 contribution points is called a workflow. | — | [repo:orca-marketplace.json]; [repo:scripts/orca-manifest-parity.test.ts] asserts `entry.categories === ['workflows']` |

**The owner is right.** Orca already has the board (workspace statuses), the Tasks page (four external providers),
and the agent dashboard. A genie-contributed second board would duplicate `workspace.openBoard`.

---

## B) What a plugin can contribute under `pluginApi: 1`

Orca has **no `plugin` CLI verb at all** (`orca plugin --help` → `Unknown command: plugin`; same for `plugins`), and
no plugin directory under `~/.orca/`. Installation is UI/marketplace only. So the API surface below is reconstructed
from Orca's own issue tracker plus [super-orca]; **there is no official public Orca plugin doc site I could reach.**

**Seven contribution points — a strict, closed object.** Corroborated independently by [gh:15655] (*"the manifest
permits only seven contribution keys: panels, commands, events, languagePacks, keybindings, vmRecipes, and agents …
there is no `settings` key in `contributes`, and the object is strict"*) and [super-orca]:

| Point | Max | Shape | Status |
|---|---|---|---|
| `commands` | 256 | `{id, title, context?, action?}` — `context` is `global` or `worktree`; with `action` it binds a **built-in** action and never reaches the worker; without, the worker must register it or activation fails | live (genie uses it) |
| `panels` | 64 | `{id, title, icon?, entry}` — sandboxed iframe, CSP `default-src 'none'; connect-src 'none'`, 64 KB/message, 30 msg/10 s, Orca design tokens injected as CSS vars | live |
| `events` | 3 | `{on}` — only `worktree.created`, `worktree.removed`, `agent.status.changed` | live |
| `keybindings` | 256 | `{command, key, when?}`; `when` must match the command's `context` | live |
| `languagePacks` | 16 | `{locale, path}` | live |
| `vmRecipes` | 64 | `{path}` | live |
| `agents` | 64 | `{path}` | **reserved, nothing consumes it** — [gh:13306]: *"nothing consumes it yet"*; the real proposal is a future `contributes.harnesses[]` |

**16 built-in actions** a command may bind with no code, including `workspace.openBoard`, `view.tasks`,
`workspace.rename`, `tab.rename`, `sidebar.{explorer,search,sourceControl,checks,ports,sleepingWorkspaces}.toggle`,
`worktree.history.back/forward` [super-orca].

**Seven capabilities** (closed set; unknown kinds fail validation): `workspace:read`, `terminal:send`,
`notifications:show`, `storage`, `secrets`, `events:subscribe`, `settings:own`. `net:fetch` and `process:exec` are
*named in the model but not implemented* [super-orca]; [gh:15655] confirms `settings:own` and the panel gating.

**Host API — 13 methods**, `host.call(method, params)`: `workspace.readContext`, `terminal.sendText`,
`notifications.show`, `storage.{get,set,delete,keys}`, `secrets.{get,set,delete}`, `settings.{get,set}`,
`events.subscribe`. Only the first three are panel-callable [super-orca], [gh:15655].

**Worker entrypoint**: ES module in a child process, default export `activate(ctx)`, optional `deactivate`;
`ctx = {commands.register, events.on, host.call, grantedCapabilities, log}`. Idle workers reaped after 60 s. The
worker has **full `fs`/`net`/`child_process`** — capability gating covers the host API only, not the OS [super-orca].
That is exactly why genie's `capabilities: []` plugin can still shell out to `orca`.

**Hard limits — what a plugin cannot do today:**
- **Cannot register a task source.** [gh:15328]: *"the plugin API exposes only a `command` extension point … a plugin
  can call the Plane REST API from its worker, but it can never register a task source, link a worktree, or appear in
  the source switcher"* — `TaskProvider` and `WorkspaceLinkedItem['provider']` are **closed unions in `src/shared/`**.
- **Cannot add a status-bar segment** — [gh:19809]: *"None of them reach the status bar."*
- **Cannot add rows to the worktree card**, and `panels` has **no placement/location field**, so a contributed panel
  cannot be positioned in the left sidebar [gh:19809 / gh:16853].
- **Cannot expose settings UI** [gh:15655]. Cannot make network calls *from a panel* (`connect-src 'none'`).
- Loader limits: rejects any tree containing a symlink; caps an install at **2000 files / 50 MB**
  [repo:scripts/orca-manifest-parity.test.ts].

**Still unknown:** the authoritative `orca-plugin.json` JSON Schema (no public doc site found); whether `pluginApi: 1`
on 1.4.205 matches the v0 reconstruction exactly; the panel↔worker RPC channel's stability; whether marketplace
install is scriptable at all. **Every "cannot" above is sourced from Orca's own tracker, not from [super-orca] alone.**

### B2) The task-source contract vs. the owner's first candidate

> *"a local genie task source that populates what already exists in Orca, with optional sync to GitHub"*

**As a plugin: impossible today.** A new source must be a new member of the closed `TaskProvider` union plus
`WorkspaceLinkedItem['provider']`, account-backed auth, a REST client, worktree linking, a Tasks-surface list view and
a card indicator [gh:15328]. [gh:15328] also concludes that *making task-provider functionality pluggable would mean
changing the same core files as building it natively*, i.e. it is an upstream PR to `stablyai/orca`, not genie work.

**But the same user-visible outcome is reachable with zero Orca-side change, because GitHub is already one of the four
native providers.** Genie's roadmap is already the canonical, git-tracked board: `.genie/roadmap.json` holds **75
cards** today (Done 56, Idea 11, Wish 5, Review 3) with `id`, `title`, `lane`, `group_name`, `wish`, `assigned_agent`,
`blocked_by`, plus `wish_groups`, `task_dependencies`, `task_events`, `stage_log` [repo:.genie/roadmap.json]. Route:
`genie task` ⇄ GitHub issue ⇄ Orca Tasks page, identity key = the issue number stored on the card (and
`worktree create --issue <n>` to link the workspace). Sync direction must be **one-way genie→GitHub for content**,
with GitHub→genie only for the issue number, or the roadmap's three-way `task sync` and GitHub become two writers of
one truth. **Missing before design:** whether Felipe wants 75 cards (56 already Done) mirrored as public issues at all;
whether `tasks.wish` maps to a label, a milestone, or a parent issue; and what happens to lanes Orca has no word for
(Idea, Brainstorm, Wish) since Orca's columns are workspace statuses, not issue states.

---

## C) What genie already does through the CLI adapter, with no plugin

`[repo:src/lib/orca-orchestration-adapter.ts]` (1469 lines) is a **closed** boundary: 19 orchestration verbs plus a
`runtime` status probe (20 operations), each with a `.strict()` zod schema compiled to an exact argv allowlist,
`shell: false`, adapter-owned `--json`, per-verb mutation receipts and read-back proofs, and a 17-member error
taxonomy including `ambiguous_after_possible_commit` and `local_lifecycle_disabled_in_orca_mode`.

Verbs: `run-{create,list,show,current,use}`, `task-{create,list,update}`,
`worker-{start,show,read,release}`, `send`, `check`, `reply`, `ask`, `gate-{create,list,resolve}`.
Deliberately excluded: `dispatch`, `dispatch-show`, `worker-stop/abandon/retain`, `reset`
[repo:.genie/brainstorms/genie-dual-mode-orca-plugin/DESIGN.md:135].

`genie setup --orchestration-mode orca` then makes Orca the sole lifecycle authority: a SQLite pre-open barrier
rejects local lifecycle reads/writes and a roadmap pre-write barrier rejects writes, syncs and exports
[repo:plugins/genie/references/orca-orchestration.md]. `skills/work/references/orca-coordinator.md` (42 lines) splits
ownership: *"Genie owns the planning documents and their evidence (WISH.md, the linked DESIGN.md, `## Review Results`)
… Orca owns Run, Task, Dispatch, and worker state."*

**The plugin adds nothing to this.** `contributes.commands` holds exactly one entry, `genie.orca.run-list`
("Genie: List Orca Runs"), `capabilities: []`, and `scripts/orca-bundle-parity.test.ts` asserts the registered set
equals exactly `['genie.orca.run-list']` [repo:plugins/genie/orca-plugin.json, orca-entrypoint.ts]. The DESIGN never
promised any Orca UI: *"The plugin is an adapter, not an orchestration implementation. It holds no lifecycle state."*
**So the honest answer to "what is it for" is: today, one command-palette entry that prints the Run list — every real
capability is in the CLI adapter, which needs no plugin at all.** Open follow-up M2 in the wish: the real-runtime
smoke has never executed against a live Orca host.

---

## D) What else of genie can live natively inside Orca — ranked by efficiency gained per line shipped

Ranked. "Today?" = expressible under `pluginApi: 1` / the public CLI **now**, with no change to Orca.

| # | Genie capability | Orca surface it rides | Today? | Size | Efficiency won |
|---|---|---|---|---|---|
| 1 | **Wish/work/review/fix as one-click runs** | `contributes.commands` (worktree context) + `terminal.sendText` into the active agent, or `worker-start` | ✅ | S | Removes the "type the skill name" step from every loop genie already owns |
| 2 | **Lane ⇄ workspace status mirror** | `worktree set --workspace-status` + `--comment`; board columns *are* statuses | ✅ | S | The existing board becomes genie-aware; **no second board** |
| 3 | **Roadmap cards → GitHub issues → native Tasks page** | GitHub task provider + `worktree create --issue <n>` | ✅ | M | Genie work appears where Orca users already look for work |
| 4 | **Nightly `dream` / `skill-audit` / `research-sweep`** | `automations create --trigger` + `--precheck` | ✅ | S | Genie's batch skills become scheduled Orca jobs; `--precheck` is a natural gate |
| 5 | **`genie doctor` health panel** | `contributes.panels` (iframe; worker does the work, panel renders) | ✅ | M | One glanceable place for skills/record/backup drift — today it is terminal-only |
| 6 | **Review verdict → card state** | `worktree set --workspace-status in-review` + comment; gate via `gate-create/resolve` | ✅ | S | SHIP/FIX-FIRST/BLOCKED become visible without opening a terminal |
| 7 | **Wish/design/review report as a shareable page** | `artifacts share` | ⚠️ human must enable publishing once | S | Handoff artifacts get a URL; blocked on a per-device human toggle |
| 8 | **Skills delivery** | `~/.agents/skills` | ✅ **already done** | 0 | Genie's 22 skills already reach Orca with zero plugin code |
| 9 | **mikro bench/coach results** | `panels`, or an artifact | ✅ | M | Low frequency; a panel is a lot of code for a rare read |
| 10 | **Git-safety guard / release+promotion state** | `events` (`worktree.created/removed`) + `notifications.show` | ⚠️ only 3 events exist; no commit/push event | M | Genie's guards fire at git time, which Orca cannot observe |
| 11 | **"genie" as a selectable agent harness** | `contributes.agents` | ❌ reserved, unconsumed [gh:13306] | — | Would be the single highest-value item; needs Orca-side `contributes.harnesses[]` |
| 12 | **A genie task provider** | Tasks source switcher | ❌ closed union [gh:15328] | — | Superseded by #3 |
| 13 | **Status-bar wish/lane indicator** | status line | ❌ no extension point [gh:19809] | — | — |

### Top three shapes, expanded

**1 — Genie verbs in the command palette and keybindings** *(rank 1+2+6; recommended)*
- **Sees:** `⌘K → "Genie: Start wish"`, `"Genie: Review this workspace"`, `"Genie: Move card to Review"`; optional keybindings.
- **Rides:** `contributes.commands` with `context: "worktree"`, `contributes.keybindings`; worker calls `host.call('terminal.sendText')` (`terminal:send`) or spawns `orca orchestration worker-start` through the adapter.
- **Genie ships:** ~6–10 manifest command entries; entrypoint handlers on the existing adapter; add `worktree set` to the adapter's allowlist (a design amendment per DESIGN:135); 2 new skills-side notes.
- **Size:** S (~200–400 lines plugin + adapter amendment). **No new Orca surface, no second board.**
- **Missing evidence:** whether `capabilities: ["terminal:send"]` triggers a consent prompt per install, and whether a `context: "worktree"` command receives the workspace id in its handler args.

**2 — Roadmap ⇄ GitHub ⇄ native Tasks page** *(rank 3; the owner's candidate, redirected)*
- **Sees:** genie's Idea/Wish/Review cards in Orca's **existing** Tasks page, under the GitHub source; "start work" opens a workspace already linked (`--issue <n>`).
- **Rides:** the native GitHub task provider — the one of four that needs no Orca change.
- **Genie ships:** a `genie task push/pull --github` verb (issue number as identity key on the card), a lane↔label map, and a `task sync` rule making GitHub a derived mirror, never a second writer.
- **Size:** M (new CLI verb + roadmap schema field + conflict policy).
- **Missing evidence:** Felipe's appetite for public issues; the mapping for lanes GitHub has no word for; whether the repo is public enough for 75 cards.

**3 — Genie health + wish state as a sidebar panel** *(rank 5; do only if 1 lands well)*
- **Sees:** one Genie panel: current wish, its groups, review verdicts, doctor warnings (skills record drift, retirement leftovers, collision backups).
- **Rides:** `contributes.panels` — the *only* place a plugin may draw.
- **Genie ships:** a panel HTML bundle (no network: `connect-src 'none'`, so all data arrives over the panel↔worker RPC), a worker-side `genie doctor --json` + `task export` reader, and Orca design-token theming.
- **Size:** M–L; the panel is real UI with a 64 KB/message, 30-msg/10 s budget.
- **Missing evidence:** panel placement is **not controllable** (no location field), so we cannot promise where it appears; and the panel↔worker channel is only documented by a third-party reconstruction.

**Explicitly not recommended:** any second board (duplicates `workspace.openBoard`), a genie task provider (closed
union), a status-bar segment (no extension point), and `contributes.agents` (reserved, unconsumed).

---

## E) The one question the owner must answer

**Is the Genie plugin's job to make Orca *drive genie* (genie's verbs and state reachable from Orca's existing
palette, board and Tasks page — everything in shape 1 and 2, shippable today), or to make genie's *documents* visible
inside Orca (a Genie panel, rank 5 — the only surface a plugin may draw, but unplaceable and evidenced only by a
third-party API reconstruction)?**

The first is small, rides three native mechanisms, adds no new surface, and needs nothing from Orca upstream. The
second is the only thing that looks like "a Genie thing inside Orca" — and it is where every remaining unknown lives.

---

## Sources (web)

- [stablyai/orca #15328 — Native Plane task provider](https://github.com/stablyai/orca/issues/15328)
- [stablyai/orca #15655 — Plugins cannot expose settings to the user](https://github.com/stablyai/orca/issues/15655)
- [stablyai/orca #15318 — Right sidebar panel for the linked task](https://github.com/stablyai/orca/issues/15318)
- [stablyai/orca #19809 — Plugin hook to contribute to the status line](https://github.com/stablyai/orca/issues/19809)
- [stablyai/orca #13306 — Make agent harnesses dynamically pluggable](https://github.com/stablyai/orca/issues/13306)
- [stablyai/orca #20650 — Declarative link routes contribution point](https://github.com/stablyai/orca/issues/20650)
- [stablyai/orca #18249 — User-defined agent entries](https://github.com/stablyai/orca/issues/18249)
- [marius-patrik/super-orca — reconstructed Orca plugin API v0 reference](https://github.com/marius-patrik/super-orca) *(third-party, unofficial)*
