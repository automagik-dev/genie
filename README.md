<p align="center">
  <img src=".github/assets/genie-header.png" alt="Genie" width="800" />
</p>

<p align="center"><strong>Wishes in, PRs out.</strong></p>

<p align="center">
  <a href="https://github.com/automagik-dev/genie/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
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

The installer detects Claude Code and Codex and installs the version-matched Genie plugin for each. Control this with `--integrations auto|codex|claude|all|none` or `--skip-integrations`. When Codex is selected, the install/update convergence path also synchronizes up to 23 digest-managed product-skill fallbacks into `~/.agents/skills/`; same-name unmanaged or modified user copies are preserved. Automatic integration failures warn after the verified binary succeeds; explicitly requested failures are fatal.

From inside a repo, run `genie init`. Use `genie setup --codex` to explicitly install or repair the Codex plugin, seven optional role-agent profiles, MCP routing, and the backup-first dead-OTel migration. `genie update` is the explicit update/convergence path. When crossing from a release older than `5.260711.6` to `5.260711.6` or later, let the first update finish and run `genie update` one more time: the first process may only deliver the new binary/payload, while the second runs the new convergence contract. Verify that the plugin exposes exactly H3/H4/H6, then review their hashes with `/hooks` and start a new task. Later updates converge in one operator-driven path. No Codex hook installs software, refreshes plugins, synchronizes personal skills, or writes project instructions.

Codex never auto-trusts plugin hooks. After setup or update, inspect the three Genie definitions with `/hooks`, approve only the hashes you understand, and start a new task so the reviewed definitions take effect. Until then they remain untrusted and do not run.

## Quickstart

The lifecycle is shared by Claude Code and Codex. Claude uses slash skills. A Codex plugin install uses the unambiguous owner-qualified `$genie:<skill>` selector; bare `$<skill>` resolves the user tier, which may be a CLI-managed product fallback or a separately installed personal copy:

```text
1. /brainstorm or $genie:brainstorm   an idea → a concrete DESIGN.md
2. /wish or $genie:wish               DESIGN.md → a scoped WISH.md
3. /review or $genie:review           persist an APPROVED plan or concrete gaps
4. /work or $genie:work               native role agents build each group
5. /review or $genie:review           SHIP, FIX-FIRST, or BLOCKED evidence
```

Re-run `genie board` any time for a current snapshot of task state on the kanban. The plan documents land in git as you go; the operational state lives in `.genie/genie.db`.

## What's inside

- **Skills** carry the methodology — `brainstorm → wish → work → review`, authored once for native Claude and Codex surfaces.
- **Documents in git.** Wishes, designs, and brainstorms are plain markdown under `.genie/wishes/<slug>/` and `.genie/brainstorms/<slug>/`; you diff, review, and version them like any other code.
- **One file of state.** Tasks, boards, dependency edges, and wish-group execution state live in a single per-repo SQLite file (`.genie/genie.db`), on Bun's built-in engine.
- **Small.** 14 CLI commands, 4 runtime dependencies (`@inquirer/prompts`, `commander`, `zod`, `nats`) — `nats` initializes only when the omni runner starts. A ~0.9 MB single-file bundle. Bun-powered.
- **Warp cockpit (optional).** `genie launch <slug>` turns a wish's ready groups into a Warp window — one pane per group, each in its own git worktree running that group's agent on a kickoff prompt. Emitting the launch config works on any platform; opening it needs Warp (macOS/Linux). Everywhere else the config is still written for you to open by hand.
- **Zero daemons, no Postgres.** Nothing runs in the background between invocations.

## Commands

```bash
genie --help
```

| Command | What it does |
|---------|-------------|
| `genie init` | Scaffold per-repo state and reconcile project MCP files (`.mcp.json`, `.warp/.mcp.json`, and a marker-owned `.codex/config.toml` fallback when no installed, enabled, usable Genie plugin route is proven) |
| `genie launch` | Open a Warp cockpit for a wish — one pane per ready group, each in its own worktree |
| `genie board` | Kanban view of task state, derived live by query |
| `genie task` | Inspect and drive task state (SQLite, zero-daemon) |
| `genie install` | Run the installer-owned finishing step and explicitly install selected runtime integrations |
| `genie mcp` | Serve read-only Genie task/board state over stdio MCP |
| `genie omni` | Bridge agents to WhatsApp via Omni — remote approvals + inbound one-shots (`serve`, `status`, `inbox`, `handshake`) |
| `genie setup` | Configure Genie and install/repair runtime integrations |
| `genie doctor` | Run diagnostic checks on the installation |
| `genie hook` | Provider-neutral hook middleware with Claude/Codex wire adapters |
| `genie shortcuts` | Manage terminal keyboard shortcuts |
| `genie update` | Update Genie to the latest GitHub release |
| `genie uninstall` | Remove Genie and clean up its hooks |
| `genie help` | Show help for any command |

## Skills

Skills are the product. Invoke them as `/name` in Claude, `$genie:name` from the Codex plugin, or `$name` only when intentionally selecting the corresponding user-tier copy:

| Skill | What it does |
|-------|-------------|
| `brainstorm` | Explore a vague idea until it's a concrete DESIGN.md |
| `wish` | Turn a design into a scoped WISH.md with execution groups |
| `work` | Dispatch native role subagents wave by wave |
| `review` | Severity-gated verdict — SHIP, FIX-FIRST, or BLOCKED |
| `council` | Independent architecture, delivery, product, security, and dissent assessment |

Shared skill bodies use a runtime-neutral delegation contract. Codex maps it to the optional `genie_*` custom-agent profiles installed by the CLI; a plugin-only install still has skills but no custom agents. Codex subagents share a workspace, so task claims own scope; use `genie launch` when worktree isolation is required. The engineer reports completion, an independent reviewer returns a verdict, and only the orchestrator runs `genie task done`. `/level-up` remains Claude-only because it evaluates Claude Code mastery.

### Codex surface boundaries

These five inventories are intentionally separate:

| Surface | What ships | Ownership |
|---------|------------|-----------|
| Codex plugin | 23 physical, in-root product skills with `agents/openai.yaml`; three untrusted hooks; MCP declaration | Versioned release payload; works without copying skills into the user tier |
| CLI-managed product skills | Up to 23 digest-owned copies under `~/.agents/skills/<name>` | Explicit Codex-selected install/update fallback; clean managed copies converge, while unmanaged or modified collisions are preserved |
| CLI integration | Seven optional `genie_*` role-agent TOMLs under `~/.codex/agents/` | Installed/repaired by `genie install` or `genie setup --codex`; clean managed copies refresh on explicit update |
| Personal skills | This maintainer currently has 36 separately adapted skills under `~/.agents/skills` | User-owned; not bundled with Genie and never implied by plugin installation |
| MCP launcher | Plugin-local Node launcher for `genie mcp` | Resolves only the canonical executable under `$GENIE_HOME/bin` (default `~/.genie/bin`) and fails closed if it is missing or unsafe |

The plugin's 23 skills, CLI-managed user-tier fallbacks, and a user's personal 36-skill library are separate inventories even when names overlap. Genie preserves unmanaged and modified user copies instead of adopting them; use `$genie:<skill>` when the plugin copy is intended.

### Codex hooks: three reviewed behaviors

| Event | Behavior | Side effects |
|-------|----------|--------------|
| `SessionStart` (H3) | Inspects at most 64 candidate directories and 256 KiB of wish files, then emits at most eight validated slug/status/count records capped at 2 KiB | Read-only; no titles, free-form repository text, network, install, update, or writes |
| `PreToolUse` (H4) | Runs branch/orchestration checks for `Bash` and audit-context checks for `Write`, `Edit`, and `apply_patch` | Codex handling is deterministic and network-free; it does not invoke the unregistered freshness (`Read`) or identity (`SendMessage`) handlers, never calls Omni, and never installs or synchronizes anything |
| `PermissionRequest` (H6) | Applies the configured matcher and, only when Omni approvals are explicitly enabled, queues one bounded/redacted remote decision | The only retained hook allowed to write approval-queue state; failure, timeout, malformed output, or interruption denies with a reason |

The removed hooks were the startup installer, first-run `AGENTS.md` writer, pre/post wish validators, per-prompt context reinjection, and inert completion validator. Setup and updates are operator commands, never lifecycle side effects.

## How it works

Documents live in git; operational state lives in one SQLite file. `work` fans agents out through the active client's native subagents — each gets a task claim, with state changes serialized through `genie.db` rather than a coordinator. Review runs as a separate subagent from the one that wrote the code (reviewer ≠ engineer), so the verdict is independent evidence against the wish criteria.

All linked worktrees of a repository share one `genie.db`, resolved from the git common directory, so a task created in one worktree is immediately visible in another with no sync step.

## Omni (WhatsApp bridge)

`genie omni` wires a running agent to WhatsApp through an [Omni](https://automagik.dev) hub, so you can drive approvals and short tasks from your phone.

**How it works** (verified by the test suite against a fake transport; the live WhatsApp round-trip is a documented manual-QA step — see `.genie/wishes/omni-runner-port/qa.md`):

- **Remote approvals.** Reply `y`/`n` (or `sim`/`nao`) or react 👍/👎. The feature is off by default. When explicitly enabled, Codex evaluates Omni exactly once on a matching `PermissionRequest`; approval allows, denial denies, and timeout/transport/interruption returns a reasoned deny rather than silently allowing the tool. `PreToolUse` never waits on Omni.
- **Inbound one-shots.** Each mapped chat selects `agent: claude|codex`. Codex JSONL thread ids persist per provider/instance/chat and resume on later messages. Unmapped chats are stored, not answered.

**What it needs:**

- An **Omni hub** plus a connected **WhatsApp instance** — Genie speaks to Omni over NATS; the hub owns the WhatsApp session.
- `genie omni handshake` once per host — registers an ed25519 keypair so outbound sends are signed.
- Approval-gated agents launched with `--permission-mode default`. Under `auto` mode a passthrough `ask` can auto-resolve to allow, which defeats the timeout→ask fail-safe.
- `genie omni serve` running as the one resident process. It is the *only* NATS client — `--help`, `task`, `board`, and every other command stay transport-free (`nats` never initializes on those paths).

## MCP server (Warp + Claude Code + Codex)

`genie mcp` is a zero-dependency, read-only [MCP](https://modelcontextprotocol.io) server over stdio. The Codex plugin bundles a declaration and a small launcher, not another Genie binary. The launcher resolves only `$GENIE_HOME/bin/genie` (default `~/.genie/bin/genie`); missing, symlinked, or path-escaped executables fail closed. When no installed, enabled, usable Genie plugin route can be proven, `genie init` merges an absolute-path, marker-owned fallback into project `.codex/config.toml` without duplicating the server.

**How it gets picked up.** `genie init` reconciles Claude and Warp project configs and may change the three project files named below; review those project-scoped commands before trusting the workspace. Codex normally gets MCP from the plugin. The marker-owned project fallback is retained whenever Genie's probe cannot prove one installed, enabled, usable plugin route — including absent, disabled, malformed, timed-out, or unsafe plugin state. `genie launch` applies the same policy to its worktrees:

- `.mcp.json` — Claude Code's project MCP config. Project-scope servers are *pending approval* until you trust the workspace (accept the trust dialog in an interactive `claude` session) — expected, not a bug.
- `.warp/.mcp.json` — Warp auto-detects this on save (no restart) and lists `genie` under Settings → AI/Agents → MCP servers.
- `.codex/config.toml` — marker-owned absolute-path fallback, written whenever no installed, enabled, usable native Genie plugin route is proven.

The Claude and Warp JSON files use the identical `mcpServers` shape and are merged idempotently; the Codex TOML fallback uses marker-owned root-level dotted assignments so it cannot capture following keys. Re-running `genie init` preserves every other server and top-level key and rewrites byte-identical. A compiled Genie records the absolute executable plus `mcp`; an interpreted `bun src/genie.ts` or `bun dist/genie.js` run records the absolute Bun executable plus the absolute script and `mcp`. No route relies on bare `genie`, which is not reliably on PATH. Because `genie init`/`launch` run on the box that owns the repo, the recorded paths are correct even under Warp's SSH-remote feature, where Warp spawns the server on that same box.

**What it exposes** — five read-only tools backed by the per-repo `.genie/genie.db`:

- `genie_board` — board counts + tasks (optional wish filter)
- `genie_wish_status` — a wish's group/DAG progress
- `genie_worktree_context` — resolves the pane's `wish/<slug>-<group>` branch to its wish, group, and tasks (the per-pane "what am I here for")
- `genie_task` — full task detail by id
- `genie_active` — every in-progress task and who claimed it

**Honest limitation — genie does not push into your tabs.** Warp exposes no external tab-push API, so genie cannot inject state into a pane. The flow is pull, not push: the pane's agent *asks* genie over MCP (`genie_worktree_context`, `genie_board`, …) when it wants to know the board state. `genie launch` still seeds each pane with a kickoff prompt at open time, but ongoing awareness is the agent querying the MCP server, not genie writing into the tab.

## Hermes-native surface

Genie also ships a Hermes-native plugin under `plugins/hermes-genie/` — seven read-only tools (doctor, board, wish/task queries, `launch --dry-run` plans), `/genie` slash commands, advisory hooks, and workflow skills, all wrapping the genie CLI through an argv-only subprocess bridge that marks every payload `mutation: "none"`. The boundary is deliberate: Hermes is the chat/reasoning cockpit; Genie remains the execution system and the source of task truth. Install and smoke-test instructions: [`plugins/hermes-genie/README.md`](plugins/hermes-genie/README.md).

## Roadmap

No dates — direction, not promises:

- **Deeper Warp integration.** A Tab Config upgrade and richer pane orchestration on top of today's `genie launch`.
- **More emit targets.** Continue expanding native clients beyond Claude, Codex, and Hermes.
- **CDN distribution.** Serve signed releases from a CDN for faster, wider installs.

## Coming from v4?

v4 is preserved on the [`v4` branch](https://github.com/automagik-dev/genie/tree/v4), and its final npm release stays published for existing v4 users — nothing you're running today disappears.

v5 is a deliberate cutover to a lightweight body. The v4 harness — a Postgres backend, pane-based process orchestration, executor registries, the telemetry spine, the full-screen console, and the desktop app — is gone. What remains is the part that always did the work: the skills, the documents, and one SQLite file of state.

---

<p align="center">
  <a href="https://automagik.dev/genie"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/automagik-dev/genie/releases/latest"><strong>Releases</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center"><sub>You describe the problem. Genie does the rest.</sub></p>
