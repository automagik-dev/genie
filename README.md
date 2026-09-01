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

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash
```

Every release is cosign-signed (keyless OIDC) with SLSA provenance; the installer verifies the binary — via `gh attestation verify`, falling back to `cosign verify-blob` — before it runs.

The repository-hosted `.well-known/latest.json` and `dev.json` manifests are the authoritative channel pointers. GitHub's `/releases/latest` route and prerelease badge are deliberately not channel authority: a promotion advances only a monotonic manifest and never rewrites already-published assets or channel-significant draft/prerelease/latest metadata.

Genie ships exactly three surfaces, and nothing else:

1. **The signed binary** — installed and updated by `install.sh` and `genie update`.
2. **The skills** — delivered by the [skills.sh](https://skills.sh) channel. `genie install` and `genie update` run the pinned skills CLI over the tree the signed release put on disk, then record what landed in `~/.genie/skills-install.json`. Without the binary, the same skills install with `npx skills add automagik-dev/genie` (add `-g --all` for every agent home).
3. **The Orca plugin** — an optional lifecycle integration you register with Orca yourself (see below).

There is no Claude marketplace plugin, no Codex plugin, no Genie-installed hooks, and no role-agent profiles.

`--integrations auto|codex|claude|all|none` (or `--skip-integrations`) is the consent scope for the skills channel. Any value other than `none` installs to **every** detected agent skill home, because the skills CLI already installs per agent; `none` skips the channel entirely, writes no record, and reports `skills: skipped (consent: none)`. A failed skills install never rolls back the promoted binary — it prints the exact remedy command and sets a non-zero exit code.

Upgrading from a plugin-era release? `genie update` runs a one-shot, backup-first retirement of what that era left on the host — Codex and Claude plugin registrations and caches, the stamped Claude workflow, role-agent TOMLs, managed skill mirrors, Hermes and pi links. Every asset is classified before anything is touched, and only the ones provably Genie-owned and unmodified are removed; modified, unmanaged or ambiguous assets are preserved and reported. Backups land under `~/.genie/state-backups/integration-retirement-<timestamp>/`. The window covers assets written by releases `5.260711.6` or newer; older hosts follow the manual steps in the docs.

From inside a trusted initialized repo, run `genie init` to scaffold state and retire proven-owned historical MCP routes. Then run `genie doctor` to confirm the install: it reports one `skills: <agent> <present>/<total> @ <ref>` line per known agent skill home, `not detected` for a home this host does not have, and a warning naming `genie update` when skills are missing or older than the running binary.

## Standalone and Orca authority

Genie has two explicit lifecycle modes. `standalone` is the default, including when the configuration omits
`orchestration.mode`; merely installing or opening Orca never changes authority. Standalone keeps the existing local
task, board, and roadmap behavior. Select Orca only when you intend Orca to become the sole lifecycle authority:

```bash
genie setup --orchestration-mode orca
genie doctor
```

The switch first verifies the shipped plugin payload and a compatible Orca runtime (Orca `1.4.192` or newer with
`orchestration.contract.v1`). Only after that probe succeeds does Genie back up its configuration and atomically select
Orca. In Orca mode, Genie does not open `.genie/genie.db` for lifecycle reads or writes and refuses roadmap writes,
syncs, and exports before they can create or change local files. Existing local history is preserved in place, but it is
not imported, mirrored, or treated as current. The plugin keeps no fallback database: if Orca is unavailable, the
operation fails instead of silently returning to standalone.

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

The plugin invokes only a closed subset of official `orca orchestration ... --json` commands. Successful mutations
require a bounded receipt and, where the public CLI supports it, an immediate public read-back. If the process times out,
exceeds its output cap, or loses transport after launch without a complete identifying receipt, Genie reports
`ambiguous_after_possible_commit`. Do not automatically retry: Orca may already have committed the operation. Inspect
the exact public read operation named by the error only when the identifier was known before launch; otherwise confirm
the outcome with an Orca operator before deciding whether to issue a new mutation. Genie never guesses an identifier
from a collection or infers success from a partial response.

### MCP retirement

The legacy Genie MCP server is retired. `genie mcp` exits non-zero with a stable diagnostic and never starts a server;
use the standalone `genie task` and `genie board` commands instead. `genie init` removes only marker-owned or exact
Genie-owned historical project registrations and preserves unrelated or unproven user configuration byte-for-byte.
Rollback to a pre-A7 signed release remains the migration escape hatch.

Maintainers should read the [public Orca boundary and verb-amendment contract](plugins/genie/references/orca-orchestration.md)
before changing the adapter or its operator guidance.

## Quickstart

The lifecycle is shared by every agent the skills channel reaches. Claude Code invokes a skill as a slash command; Codex and the rest invoke it by name or in plain language:

```text
1. /brainstorm or "brainstorm this"   an idea → DESIGN.md → mandatory design review
2. /wish or "turn that into a wish"   accepted DESIGN.md → a scoped WISH.md
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
- **Small.** 15 CLI commands, 4 runtime dependencies (`@inquirer/prompts`, `commander`, `zod`, `nats`) — `nats` initializes only when the omni runner starts. A ~0.9 MB single-file bundle. Bun-powered.
- **Spawn-context contract.** `genie context --wish <slug> [--group g] [--plan]` emits one line of versioned JSON — composed branch + resolved base SHA + ready tasks — that a spawn consumes. `--plan` previews the same payload without side effects; the wishless form resolves the repo's integration branch for plain spawns.
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
| `genie ui-bridge` | Return the stable non-zero UI-bridge-retirement diagnostic |
| `genie install` | Finish a verified install and converge the skills channel under the recorded consent scope |
| `genie mcp` | Return the stable non-zero MCP-retirement diagnostic |
| `genie omni` | Bridge agents to WhatsApp via Omni — remote approvals + inbound one-shots (`serve`, `status`, `inbox`, `handshake`) |
| `genie setup` | Configure Genie; `setup --orchestration-mode` selects the lifecycle authority |
| `genie doctor` | Run diagnostic checks on the installation |
| `genie shortcuts` | Manage terminal keyboard shortcuts |
| `genie update` | Update Genie to the latest GitHub release |
| `genie uninstall` | Remove Genie, the recorded skills install, and plugin-era leftovers proven to be Genie-owned |
| `genie help` | Show help for any command |

## Skills

Skills are the product. Invoke them as `/name` in Claude Code, or by name or plain language in Codex and every other agent that reads the shared skills home:

| Skill | What it does |
|-------|-------------|
| `brainstorm` | Explore a vague idea until it's a concrete DESIGN.md |
| `wish` | Turn a design into a scoped WISH.md with execution groups |
| `work` | Dispatch native role subagents wave by wave |
| `review` | Severity-gated verdict — SHIP, FIX-FIRST, or BLOCKED |
| `council` | Independent architecture, delivery, product, security, and dissent assessment |

Shared skill bodies use a runtime-neutral delegation contract: they name portable roles and let each runtime map them onto its own native subagents. Genie installs no custom agent profiles. Subagents share a workspace, so task claims own scope; worktree isolation, when required, is orchestrator-arranged per the dispatch contract. The engineer reports completion, an independent reviewer returns a verdict, and only the orchestrator runs `genie task done`. `/level-up` remains Claude-only because it evaluates Claude Code mastery.

### Where the skills land

`genie install` and `genie update` run the pinned skills.sh CLI over the delivered tree under `~/.genie/skills`,
never over a GitHub ref — the signed tarball's own bytes are the only source genuinely pinned to your binary. The
public `npx skills add automagik-dev/genie` command serves the repository's default branch instead, so it can be
ahead of or behind any release.

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

## Omni (WhatsApp bridge)

`genie omni` wires a running agent to WhatsApp through an [Omni](https://automagik.dev) hub, so you can drive approvals and short tasks from your phone.

**How it works** (verified by the test suite against a fake transport; the live WhatsApp round-trip is a documented manual-QA step — see `.genie/wishes/omni-runner-port/qa.md`):

- **Remote approvals.** `genie omni serve` bridges a chat to the global approval queue: reply `y`/`n` (or `sim`/`nao`), or react 👍/👎. The feature is off by default and the queue is now driven by CLI-originated approvals only — Genie no longer installs the in-session permission hook, so an agent's own permission prompt is not approvable from a chat.
- **Inbound one-shots.** Each mapped chat selects `agent: claude|codex`. Codex JSONL thread ids persist per provider/instance/chat and resume on later messages. Unmapped chats are stored, not answered.

**What it needs:**

- An **Omni hub** plus a connected **WhatsApp instance** — Genie speaks to Omni over NATS; the hub owns the WhatsApp session.
- `genie omni handshake` once per host — registers an ed25519 keypair so outbound sends are signed.
- `genie omni serve` running as the one resident process. It is the *only* NATS client — `--help`, `task`, `board`, and every other command stay transport-free (`nats` never initializes on those paths).

## MCP retirement

The legacy cross-client MCP server, its write tools, plugin launchers, and Genie-owned registrations are retired.
`genie mcp` prints `Error: genie mcp has been retired; use \`genie task\` and \`genie board\`, or roll back to a
pre-A7 signed release.` to stderr and exits 1 without reading or speaking MCP. `genie init` removes only historical
registrations proven to be Genie-owned; unowned same-name routes and every unrelated config key remain untouched.

The UI-owned `genie ui-bridge` is retired on the same terms: there is no separate Genie UI any more, the Orca
integration is the supported UI surface, and the private stdio transport, tool registry, and change watcher behind the
bridge are deleted. `genie ui-bridge` prints `Error: genie ui-bridge has been retired; the Orca integration is the
supported UI surface, or roll back to a pre-retirement signed release.` to stderr and exits 1. Standalone `genie task`
and `genie board` retain their existing behavior in standalone mode; Orca mode continues to use the public
`orca orchestration ... --json` adapter as its sole authority.

## Roadmap

No dates — direction, not promises:

- **More emit targets.** Continue expanding native clients beyond Claude, Codex, and Hermes.
- **CDN distribution.** Serve signed releases from a CDN for faster, wider installs.

## Coming from v4?

v4 is preserved on the [`v4` branch](https://github.com/automagik-dev/genie/tree/v4), and its final npm release stays published for existing v4 users — nothing you're running today disappears.

v5 is a deliberate cutover to a lightweight body. The v4 harness — a Postgres backend, pane-based process orchestration, executor registries, the telemetry spine, the full-screen console, and the desktop app — is gone. What remains is the part that always did the work: the skills, the documents, and one SQLite file of state.

---

<p align="center">
  <a href="https://automagik.dev/genie"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/automagik-dev/genie/releases"><strong>Releases</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center"><sub>You describe the problem. Genie does the rest.</sub></p>

> **Channel migration (2026-07):** the `homolog` channel was retired. Configs pinned to `homolog` are migrated to **stable** automatically on next run; `genie update --homolog` no longer exists — use `--stable` or `--dev`.
