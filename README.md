<p align="center">
  <img src=".github/assets/genie-header.png" alt="Genie" width="800" />
</p>

<p align="center"><strong>Wishes in, PRs out.</strong></p>

<p align="center">
  <a href="https://github.com/automagik-dev/genie/releases"><img alt="signed release channels" src="https://img.shields.io/badge/releases-signed%20channels-00D9FF?style=flat-square" /></a>
  <a href="https://github.com/automagik-dev/genie/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://discord.gg/xcW8c7fF3R"><img alt="discord" src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" /></a>
</p>

<br />

Genie is a planning-and-execution layer for AI coding agents. You describe what you want in one sentence; Genie interviews you into a plan, dispatches agents to build it in parallel, reviews the result against acceptance criteria, and hands you something ready to merge.

The whole thing is a lightweight body: a set of skills, plain-markdown documents in git, and a single per-repo SQLite file. No daemons, no Postgres, nothing resident. A command opens the database, runs one transaction, and exits.

**Stable is declared for Linux and macOS.** Both legs run in the release gate, so a change that breaks either one does not ship. Windows is not supported; WSL2 works but is not on the tested matrix.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
```

Every release is cosign-signed (keyless OIDC) with SLSA provenance, and `genie update` verifies it **offline, with no GitHub credential**: the release's own signed delivery evidence is checked against an embedded Sigstore trust root with the publishing workflow's certificate identity pinned, and the descriptor's `artifactSha256` is bound to the downloaded tarball before anything is extracted. `gh attestation verify` is an advisory cross-check on top — a host with no `gh` still updates and says so in one line; a `gh` that ran and says the artifact does not verify still aborts.

The repository-hosted `.well-known/latest.json` and `dev.json` manifests are the authoritative channel pointers. GitHub's `/releases/latest` route and prerelease badge are deliberately not channel authority: a promotion advances only a monotonic manifest and never rewrites already-published assets or channel-significant draft/prerelease/latest metadata.

Genie ships exactly three surfaces, and nothing else:

1. **The signed binary** — installed and updated by `install.sh` and `genie update`.
2. **The skills, and the saved-workflow catalog beside them** — delivered by the [skills.sh](https://skills.sh) channel. `genie install` and `genie update` run the pinned skills CLI over the tree the signed release put on disk, deliver `.claude/workflows/*.js` into `~/.claude/workflows`, then record what landed in `~/.genie/skills-install.json`. Without the binary, the same skills install with `npx skills add automagik-dev/genie` (add `-g` for a machine-wide install; never `--all`, which asks the skills CLI to write a product home for every one of the 77 agents in its registry — 57 of them materialized on the measured dogfood host (2026-08-30, re-confirmed 2026-09-01; only 4 were recorded, leaving 53 unrecorded homes).
3. **The Orca plugin** — an optional lifecycle integration you register with Orca yourself (see below).

There is no Claude marketplace plugin, no Codex plugin, no Genie-installed hooks, and no role-agent profiles.

`--integrations auto|codex|claude|all|none` (or `--skip-integrations`) is the consent scope for the skills channel. Any value other than `none` installs to **every** detected agent skill home, because the skills CLI already installs per agent; `none` skips the channel entirely, writes no record, and reports `skills: skipped (consent: none)`. A failed skills install never rolls back the promoted binary — it prints the exact remedy command and sets a non-zero exit code.

Upgrading from a plugin-era release? The one-shot, backup-first retirement `genie update` used to run for that era shipped from `5.260711.6` through the last `5.x` release and **was removed in v6**, three stable releases after its compat window opened. A host that updated through any `5.x` release is already clean and needs nothing. A host coming straight from the plugin era to v6 is not cleaned up by genie at all any more — see [Removing plugin-era leftovers by hand](#removing-plugin-era-leftovers-by-hand). Genie still retires what the **skills** channel itself no longer delivers, backup-first, under `~/.genie/state-backups/skills-retirement-<timestamp>/`.

From inside a trusted initialized repo, run `genie init` to scaffold state and retire proven-owned historical MCP routes. Then run `genie doctor` to confirm the install: it reports one `skills: <agent> <present>/<total> @ <ref>` line per known agent skill home, `not detected` for a home this host does not have, and a warning naming `genie update` when skills are missing or older than the running binary.

## Standalone and Orca authority

Genie has two explicit lifecycle modes. `standalone` is the default, including when the configuration omits
`orchestration.mode`; merely installing or opening Orca never changes authority. Standalone keeps the existing local
task, board, and roadmap behavior. Select Orca only when you intend Orca to become the sole lifecycle authority:

```bash
genie setup --orchestration-mode orca
genie doctor
```

The switch first verifies the shipped plugin payload and a compatible Orca runtime (Orca `1.4.205` or newer with
`orchestration.contract.v1`). Only after that probe succeeds does Genie back up its configuration and atomically select
Orca. In Orca mode, Genie does not open `.genie/genie.db` for lifecycle reads or writes and refuses roadmap writes,
syncs, and exports before they can create or change local files. Existing local history is preserved in place, but it is
not imported, mirrored, or treated as current. The plugin keeps no fallback database: if Orca is unavailable, the
operation fails instead of silently returning to standalone.

In Orca mode the CLI is explicit about what it will and will not do, and three rules cover all of it:

- **`genie task`, `genie board` and `genie idea` exit 2** with one fixed line naming the remedy
  (`genie setup --orchestration-mode standalone`). Exit 2 is Genie's "the operator must act" family — the same code the
  workspace gate and `genie mikro call`'s usage refusals use — so it is never confused with a command that simply
  failed. That closed list of three root verbs is the whole list.
- **An unreadable `orchestration.mode` refuses at exit 2 too**, with its own message, because Genie cannot prove
  standalone either. That message never claims Orca owns the host — nothing was successfully read, and Orca may not be
  installed — it names the field, points at `genie doctor`, and gives the same remedy. Running
  `genie setup --orchestration-mode standalone` repairs a config Genie could not parse: it backs the original bytes up
  under `~/.genie/backups/orchestration-mode/` first, then writes a valid one, keeping every other key it could read.
- **`genie task sync` exits 0 and prints nothing**, on stdout or stderr, whether or not the repository has a `.genie`
  directory. Git hooks run it on every commit, merge and pull; in Orca mode there is no local board and no snapshot to
  reconcile, so there is nothing to report and no `board snapshot not refreshed` warning on every commit. (An unreadable
  config is not silenced — that one is worth fixing, so it still reports.)
- **`genie context --wish <slug> --plan` still answers**, exit 0 with its JSON payload. It is strictly read-only — it
  opens the database read-only or not at all and records no base — and it is the one question an agent needs answered to
  cut a worktree. Every other form of `genie context`, including a wishless `--plan`, still refuses.

Standalone mode is unchanged by all three: every one of those verbs behaves exactly as it always has.

Switching back is also deliberate and does not import Orca state:

```bash
genie setup --orchestration-mode standalone
genie doctor
```

`genie doctor` reports the selected authority, plugin ownership state, resolved runtime version, and compatibility.
`unsupported_environment` means the host cannot provide the supported public CLI/child-process boundary; install or
start a compatible Orca runtime and repeat the Orca selection. Do not work around it with a private API, internal RPC,
terminal injection, or a local fallback.

### Installing the plugin in Orca

`genie setup --orchestration-mode orca` selects Orca as Genie's lifecycle authority. It does **not** register the Genie
plugin with Orca — that is a separate, Orca-side install. Orca accepts exactly two kinds of source:

- a **marketplace source**: a git repo whose *root* holds `orca-marketplace.json`;
- a **plugin source**: a git repo whose *root* holds `orca-plugin.json`, or a local folder containing `orca-plugin.json`.

**The genie repository root can never be the plugin tree.** Orca's loader rejects any install tree containing a symlink
("unsafe file path or symlink") and caps an install at 2000 files / 50 MB. This repo has `docs -> .docs-vendor/genie`,
runs to roughly 14,000 files in a dev checkout, and keeps its manifest nested at `plugins/genie/orca-plugin.json`, which
a git plugin source never looks at. So the plugin is published as a **tree-only git ref whose root *is*
`plugins/genie`** — symlink-free, ~132 files, ~1.3 MB:

| Route | What to give Orca |
|-------|-------------------|
| Marketplace source | `https://github.com/automagik-dev/genie.git`, ref `main` — the index; the plugin itself resolves to ref `orca-plugin` |
| Plugin git source | `https://github.com/automagik-dev/genie.git`, ref `orca-plugin` (stable) or `orca-plugin-dev` (pre-release) |
| Local folder | `~/.genie/plugins/genie` (what `genie install`/`genie update` ships) |

`.github/workflows/orca-plugin-ref.yml` republishes those refs: every push to `main` that touches `plugins/genie`
force-pushes a parentless commit carrying that subtree to `refs/heads/orca-plugin`, and every such push to `dev` does the
same to `refs/heads/orca-plugin-dev`. They are tree-only by design — no history, no shared ancestry with `main`, never
merged back. Orca pins the commit it fetched, so a republish cannot retroactively change an existing install.

The repo root carries only `orca-marketplace.json`, a source-only index no release tarball contains.
`scripts/orca-manifest-parity.test.ts` fails the build if the index drifts from the plugin's identity, or if
`plugins/genie` ever grows a symlink or crosses Orca's file cap.

### What the plugin does inside Orca

Once installed and enabled, the plugin rides Orca's own mechanisms — no second board, no task provider, no panel:

- **Palette and keybindings.** Eight `Genie:` entries (`Wish`, `Work`, `Review`, `Fix`, `Report`, `Council`, `Doctor`,
  `Update`) in the command palette of any workspace, each with a `Ctrl+Alt+Shift+<letter>` chord (`W`, `K`, `R`, `F`,
  `P`, `L`, `D`, `U`). The six lifecycle verbs send their slash command, with the workspace's display name, branch,
  linked issue and path filled in, into the workspace's active agent terminal; with no agent terminal they create a Run
  and start a supervised worker whose task spec is that text. `Doctor` runs `genie doctor --json` and `Update` checks
  the stable release manifest; both answer with a desktop notification.
- **The board.** Orca's board columns are workspace statuses, so genie's lifecycle is mirrored one-way onto the
  existing cards by `genie orca mirror`: `APPROVED → todo`, `IN_PROGRESS → in-progress`, a review verdict →
  `in-review`, `SHIPPED → completed`, `BLOCKED → in-progress` (waiting on a human), each with a dated one-line card
  comment naming the evidence. Orca's status is never read back as lifecycle truth; the documents stay the record.
- **Gates.** The questions that used to stall the flow in chat — approve a wish, accept a BLOCKED group, merge,
  promote — become Orca decision gates raised by the coordinator with the orchestration verbs the Orca guide already
  owns; the human resolves them from Orca's UI, from any workspace.
- **Notifications.** When a workspace's agent settles, a changed genie card comment (a review verdict, a pending gate)
  becomes a desktop notification.

The manifest declares exactly the capabilities those handlers use (`workspace:read`, `terminal:send`,
`notifications:show`, `events:subscribe`). Orca asks for consent once per plugin and capability set, so a release that
changes that set asks once more on the next update; it never prompts per action. `genie orca mirror` works in standalone
mode too — it is a write to a card, not a lifecycle-authority question — and refuses cleanly (exit 1, one JSON line on
stderr) outside an Orca-managed worktree.

### Install, update, rollback, and uninstall

Signed release tarballs include `plugins/genie/orca-plugin.json` and the compiled Orca entrypoint on every supported
platform. The normal installer stages and verifies that payload; authority remains standalone until the explicit setup
command above. `genie update` preserves the selected mode and lifecycle history, verifies the replacement payload, and
refreshes a prior Genie ownership claim only after an Orca compatibility probe. Run `genie doctor` after installation or
update before resuming lifecycle mutations.

`genie update --rollback` checks the retained rollback state and prints signed-version reinstall guidance when a safe
in-place rollback is unavailable; follow that guidance, then run `genie doctor`. A failed update, rollback, or mode
preflight leaves the prior configuration and authority unchanged. `genie uninstall` removes only ownership-proven Genie
artifacts and registrations. Modified or unproven files are preserved, and neither local Genie history nor Orca records
are deleted. Review the command's backup/recovery output before removing any retained files manually.

### Ambiguous Orca receipts and recovery

The plugin invokes only a closed allowlist of official `orca ... --json` commands: the `orca orchestration` verbs,
`worktree show` / `worktree set`, and `terminal list`. Successful mutations
require a bounded receipt and, where the public CLI supports it, an immediate public read-back. If the process times out,
exceeds its output cap, or loses transport after launch without a complete identifying receipt, Genie reports
`ambiguous_after_possible_commit`. Do not automatically retry: Orca may already have committed the operation. Inspect
the exact public read operation named by the error only when the identifier was known before launch; otherwise confirm
the outcome with an Orca operator before deciding whether to issue a new mutation. Genie never guesses an identifier
from a collection or infers success from a partial response.

### MCP retirement

The legacy Genie MCP server is retired, and v6 removed the `genie mcp` stub that stood in for it — the verb no longer
parses. Use the standalone `genie task` and `genie board` commands instead. `genie init` removes only marker-owned or
exact Genie-owned historical project registrations and preserves unrelated or unproven user configuration
byte-for-byte. Rollback to a pre-A7 signed release remains the migration escape hatch for a host that still needs the
verb to answer at all.

Maintainers should read the [public Orca boundary and verb-amendment contract](plugins/genie/references/orca-orchestration.md)
before changing the adapter or its operator guidance.

## Quickstart

The lifecycle is shared by every agent the skills channel reaches. Claude Code invokes a skill as a slash command; Codex and the rest invoke it by name or in plain language:

```text
1. /brainstorm or "brainstorm this"   an idea → DESIGN.md → mandatory design review
2. /wish or "deliver this"            one decided task → a merge-ready PR; bigger work → a scoped WISH.md
3. /review                            mandatory plan review; persist APPROVED or concrete gaps
4. /work                              native role subagents build each approved group
5. /review                            independent implementation review: SHIP, FIX-FIRST, or BLOCKED
```

Skills are discovered from the agent's own global skills home, so there is no owner-qualified selector and no plugin tier to disambiguate against. The starter cards shipped inside each skill stay selector-free for the same reason.

Re-run `genie board` any time for a current snapshot of task state on the kanban. The plan documents land in git as you go; the operational state lives in `.genie/genie.db`.

## What's inside

- **Skills** carry the methodology — `brainstorm → design review → wish → plan review → work → implementation review`, authored once in runtime-neutral form and delivered to every agent skill home.
- **Documents in git.** Wishes, designs, and brainstorms are plain markdown under `.genie/wishes/<slug>/` and `.genie/brainstorms/<slug>/`; you diff, review, and version them like any other code.
- **One file of state.** Tasks, boards, dependency edges, and wish-group execution state live in a single per-repo SQLite file (`.genie/genie.db`), on Bun's built-in engine.
- **Small.** 16 CLI commands, 6 runtime dependencies (`@inquirer/prompts`, `commander`, `zod`, and the `@sigstore/bundle`, `@sigstore/protobuf-specs`, `@sigstore/verify` trio that verifies a release offline). A ~2 MB single-file bundle. Bun-powered.
- **Spawn-context contract.** `genie context --wish <slug> [--group g] [--plan]` emits one line of versioned JSON — composed branch + resolved base SHA + ready tasks — that a spawn consumes. `--plan` previews the same payload without side effects; the wishless form resolves the repo's integration branch for plain spawns.
- **Saved workflows.** A catalog of scripts for the procedures worth running the same way twice — `council`, `docs-audit`, `observability-review`, `pm-ledger-verify`, `research-sweep`, `skill-audit-sweep`, `skill-intake`, `wish`, `workfly` — delivered to `~/.claude/workflows` on every install and update, alongside the skills.
- **Microagents.** `genie mikro` runs narrow, repository-local agents defined by a prompt and an answer schema, returning validated JSON whose every citation is verified against the tree. `init`, `fixtures --from-commits`, `bench` and `coach` seed, measure and refine a repository's own agents, and every agent resolves repo-first behind a trusted root.
- **A linter for the plan itself.** `genie wish lint [--dir <repo>]` checks any repository's `.genie/wishes` for structure, writes nothing, and exits 0 clean, 1 findings, or 2 when `--dir` is refused — so a malformed plan fails in CI instead of after a wasted execution wave.
- **Zero daemons, no Postgres.** Nothing runs in the background between invocations.

## Commands

```bash
genie --help
```

| Command | What it does |
|---------|-------------|
| `genie init` | Scaffold per-repo state and retire proven Genie-owned project MCP registrations |
| `genie context` | Resolve spawn context — wish/group branch + base SHA, or the integration branch (versioned JSON; `--plan` previews) |
| `genie board` | Kanban view of task state, derived live by query |
| `genie idea` | Capture an idea into the roadmap board Idea lane (creates the board if absent) |
| `genie task` | Inspect and drive task state (SQLite, zero-daemon) |
| `genie install` | Finish a verified install and converge the skills channel under the recorded consent scope |
| `genie mikro` | Run and grow mikro microagents in any repository — `mikro call <agent> --prompt "…"` returns validated JSON whose every citation is verified; `init`, `fixtures --from-commits`, `bench` and `coach` seed, measure and refine that repository's own agents |
| `genie config` | Read the resolved global config — `config get budgets.maxEscalationsPerGroup` prints one schema key |
| `genie setup` | Configure Genie; `setup --orchestration-mode` selects the lifecycle authority |
| `genie orca` | Write genie's lifecycle onto the Orca workspace card, one-way — `orca mirror --to <transition> --evidence "…"` flips the board status and writes a dated comment |
| `genie doctor` | Run diagnostic checks on the installation (`--fix-global-db` repairs a contaminated machine-scope database, backup-first) |
| `genie shortcuts` | Manage terminal keyboard shortcuts |
| `genie update` | Update Genie to the latest GitHub release |
| `genie wish` | Wish-document verbs for any repository — `wish lint [--dir <repo>]` lints `<repo>/.genie/wishes` for structure, writes nothing, and exits 0 clean / 1 findings / 2 refused root |
| `genie uninstall` | Remove Genie, the recorded skills install, and plugin-era leftovers proven to be Genie-owned |
| `genie help` | Show help for any command |

## Skills

Skills are the product. Invoke them as `/name` in Claude Code, or by name or plain language in Codex and every other agent that reads the shared skills home:

| Skill | What it does |
|-------|-------------|
| `brainstorm` | Explore a vague idea until it's a concrete DESIGN.md |
| `wish` | Turn a design into a scoped WISH.md with execution groups |
| `work` | Dispatch native role subagents wave by wave |
| `review` | Independent design, plan, implementation, PR, or focused repository audit |
| `council` | Runs the saved `council` workflow (`.claude/workflows/council.js`): independent architecture, delivery, product, security, and dissent lenses plus a synthesis, assess-only |

Shared skill bodies use a runtime-neutral delegation contract: they name portable roles and let each runtime map them onto its own native subagents. Genie installs no custom agent profiles. Subagents share a workspace, so task claims own scope; worktree isolation, when required, is orchestrator-arranged per the dispatch contract. The engineer reports completion, an independent reviewer returns a verdict, and only the orchestrator runs `genie task done`. `/level-up` remains Claude-only because it evaluates Claude Code mastery.

The [skill catalog](skills/README.md) lists all eighteen skills by category (lifecycle, routing, delivery, investigation, authoring, verification, integration, skill-ops) with an advisory `mutates` axis, plus replacement routes for consolidated names. Quality audits now use optional `review` lenses, `report` includes root-cause investigation, and the core lifecycle skills handle both standalone and explicit Orca mode. `refine --for openai` and `refine --for claude` choose prompting guidance based on the official Astra and Fable documentation linked in the skill.

### Where the skills land

`genie install` and `genie update` run the pinned skills.sh CLI over the delivered tree under `~/.genie/skills`,
never over a GitHub ref — the signed tarball's own bytes are the only source genuinely pinned to your binary. The
public `npx skills add automagik-dev/genie` command serves the repository's default branch instead, so it can be
ahead of or behind any release.

Retirement runs **before** the install pass, so a home the skills CLI replaces has already been backed up. Removed
skills whose content still matches the previous install record are archived under
`~/.genie/state-backups/skills-retirement-<timestamp>/`, mirroring their path relative to `$HOME`. Modified or
unverified copies remain for manual review; a recorded agent home that no longer exists is reported and kept in the
record. If retirement fails, `genie update` retains the previous record and reports a retry.

#### Restoring from a retirement backup

Restore without asking for the backup's modes (`cp -R`, or `rsync -a --no-perms`). A plain `cp -a` copies the
backup's own directory metadata onto the agent homes that already exist, so a `drwxr-xr-x` `~/.claude` silently
becomes `drwx------`:

```bash
BK=~/.genie/state-backups/skills-retirement-<timestamp>
cp -R "$BK/." "$HOME/"
# or, equivalently:
rsync -a --no-perms "$BK/" "$HOME/"
```

Both forms work with GNU coreutils and with the BSD `cp` macOS ships; GNU's `cp -a --no-preserve=mode` is
equivalent on Linux but is rejected on macOS.

Both forms restore the removed trees and leave the modes of pre-existing directories alone.

Every known agent skill home gets a copy:

| Agent | Skill home |
|-------|------------|
| Claude Code | `~/.claude/skills` |
| Codex (and every other agent reading the shared home) | `~/.agents/skills` |
| Goose | `~/.config/goose/skills` |
| Windsurf | `~/.codeium/windsurf/skills` |

Codex reads the shared `~/.agents/skills` home; the skills CLI creates no `~/.codex/skills`. A skill directory a
different tool already owned is backed up before it is overwritten, and the backup location is reported.

After a zero-exit install, Genie records `~/.genie/skills-install.json` — the release tag, the pinned CLI version,
the skill inventory, every agent directory the install actually wrote (a bounded scan of your home, not a fixed
table), a content digest per directory, and any collisions it backed up. That record is what `genie doctor` reads
for its `skills:` lines and what `genie uninstall` proves against before it deletes anything: a directory whose
digest no longer matches is preserved and reported, never removed.

### Removing plugin-era leftovers by hand

Genie no longer removes these. Through the last `5.x` release `genie update` classified and retired them
automatically; v6 deleted that code, so on a host that never updated inside the window the files below simply stay
where the plugin era left them. None of them is read by v6 — they are inert, not harmful — so removing them is
housekeeping, at your own pace. **Back up anything you are unsure about; genie is no longer taking the backup for
you.** Anything in these paths you created yourself is yours: check before deleting.

| What | Path |
|------|------|
| Claude marketplace registration | `~/.claude/plugins/marketplaces/automagik/` |
| Claude plugin cache | `~/.claude/plugins/cache/automagik/genie/` |
| Codex plugin cache | `~/.codex/plugins/cache/automagik/genie/` |
| Codex role-agent profiles | `~/.codex/agents/genie-*.toml` |
| Codex role-agent inventory | `~/.codex/agents/.genie-role-agents.json` |
| Codex fallback transaction dirs | `~/.codex/agents/.genie-*-retirement/`, `~/.agents/skills/.genie-codex-fallback-retirement/` |
| Codex curated skill lane | `~/.codex/skills/.curated/` |
| Hermes link + marker | `~/.hermes/` genie symlinks, and the genie block in `~/.hermes/config.yaml` |
| pi link + marker | `~/.pi/extensions/` genie symlinks, and the genie block in its config |
| Codex plugin enablement | the `[plugins."genie@automagik"]` table in `~/.codex/config.toml` |
| Claude plugin enablement | the `"genie@automagik"` key under `enabledPlugins` in `~/.claude/settings.json` |
| Stamped workflow sidecar | `~/.claude/workflows/council.js.genie-sync.json` |

Two of these are keys inside files you own, not whole files: remove only the named table/key and leave the rest of
`~/.codex/config.toml` and `~/.claude/settings.json` alone. `genie doctor` does not report any of this — the checks
that observed it left with the code that acted on it.

### Verifying and removing

```bash
genie doctor      # one skills: <agent> <present>/<total> @ <ref> line per known home
genie uninstall   # removes the recorded install, then the binary
```

`genie doctor` never repairs this surface — not even with `--fix`. `genie update` owns every mutation. `genie
uninstall` deletes only the recorded skill directories it can still prove are Genie's, leaves skills you installed
yourself in place, and does not restore a foreign directory a previous install overwrote (the backup it took is
yours to restore).

## How it works

Documents live in git; operational state lives in one SQLite file. `work` fans agents out through the active client's native subagents — each gets a task claim, with state changes serialized through `genie.db` rather than a coordinator. Review runs as a separate subagent from the one that wrote the code (reviewer ≠ engineer), so the verdict is independent evidence against the wish criteria.

All linked worktrees of a repository share one `genie.db`, resolved from the git common directory, so a task created in one worktree is immediately visible in another with no sync step.

## MCP retirement

The legacy cross-client MCP server, its write tools, plugin launchers, and Genie-owned registrations are retired.
v6 also removed the `genie mcp` retirement stub itself: the verb no longer parses, so use `genie task` and
`genie board`. Host state is still cleaned up, because that was never about the verb — `genie init` removes only
historical registrations proven to be Genie-owned: in `.mcp.json` a `genie` server whose command is a genie binary
with args exactly `["mcp"]`, plus the marker-owned `.codex/config.toml` route, backing the file up first. Meanwhile
unowned same-name routes and every unrelated config key remain untouched, and `genie doctor` keeps reporting a dead
route it finds.

The UI-owned `genie ui-bridge` went the same way: there is no separate Genie UI any more, the Orca integration is the
supported UI surface, and the private stdio transport, tool registry, and change watcher behind the bridge are
deleted along with the verb. Standalone `genie task` and `genie board` retain their existing behavior in standalone
mode; Orca mode continues to use the public `orca orchestration ... --json` adapter as its sole authority.

## Roadmap

No dates — direction, not promises:

- **More emit targets.** Continue expanding native clients beyond Claude, Codex, and Hermes.
- **CDN distribution.** Serve signed releases from a CDN for faster, wider installs.

## Coming from v4?

v4 is preserved on the [`v4` branch](https://github.com/automagik-dev/genie/tree/v4), and its final npm release stays published for existing v4 users — nothing you're running today disappears.

v5 was the deliberate cutover to a lightweight body. The v4 harness — a Postgres backend, pane-based process orchestration, executor registries, the telemetry spine, the full-screen console, and the desktop app — is gone. What remains is the part that always did the work: the skills, the documents, and one SQLite file of state.

v6 is where the product and its documentation finally describe the same thing. It discharges the debt a major exists to discharge: the surfaces that had no implementation behind them are removed rather than left as stubs, the docs describe the commands that exist, and the supported platforms are stated rather than assumed. The `.genie/genie.db` schema migrates itself forward on first open under the new binary; a database at an unbridgeable version still refuses rather than guessing. See the [release notes](https://docs.automagik.dev/genie/release-notes) for what is gone and what to do instead.

---

<p align="center">
  <a href="https://docs.automagik.dev/genie"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/automagik-dev/genie/releases"><strong>Releases</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center"><sub>You describe the problem. Genie does the rest.</sub></p>

> **Channel migration (2026-07):** the `homolog` channel was retired. Configs pinned to `homolog` are migrated to **stable** automatically on next run; `genie update --homolog` no longer exists — use `--stable` or `--dev`.
