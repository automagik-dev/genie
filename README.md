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

Then, from inside your repo, run `genie setup` to configure Genie and wire up its Claude Code hooks. `genie doctor` checks the install at any time.

## Quickstart

The lifecycle runs as Claude Code skills. Open your repository in Claude Code and go:

```text
1. /brainstorm   an idea → a concrete DESIGN.md
2. /wish         DESIGN.md → a WISH.md with scoped execution groups
3. /work         dispatches agents wave by wave to build each group
4. /review       a severity-gated verdict: SHIP, FIX-FIRST, or BLOCKED
```

Re-run `genie board` any time for a current snapshot of task state on the kanban. The plan documents land in git as you go; the operational state lives in `.genie/genie.db`.

## What's inside

- **Skills** carry the methodology — `/brainstorm → /wish → /work → /review`, authored once, running natively in Claude Code.
- **Documents in git.** Wishes, designs, and brainstorms are plain markdown under `.genie/wishes/<slug>/` and `.genie/brainstorms/<slug>/`; you diff, review, and version them like any other code.
- **One file of state.** Tasks, boards, dependency edges, and wish-group execution state live in a single per-repo SQLite file (`.genie/genie.db`), on Bun's built-in engine.
- **Small.** 12 CLI commands, 4 runtime dependencies (`@inquirer/prompts`, `commander`, `zod`, `nats`) — `nats` initializes only when the omni runner starts. A ~0.9 MB single-file bundle. Bun-powered.
- **Warp cockpit (optional).** `genie launch <slug>` turns a wish's ready groups into a Warp window — one pane per group, each in its own git worktree running that group's agent on a kickoff prompt. Emitting the launch config works on any platform; opening it needs Warp (macOS/Linux). Everywhere else the config is still written for you to open by hand.
- **Zero daemons, no Postgres.** Nothing runs in the background between invocations.

## Commands

```bash
genie --help
```

| Command | What it does |
|---------|-------------|
| `genie init` | Scaffold the per-repo genie state (`.genie/INDEX.md` + `.gitignore` rules) |
| `genie launch` | Open a Warp cockpit for a wish — one pane per ready group, each in its own worktree |
| `genie board` | Kanban view of task state, derived live by query |
| `genie task` | Inspect and drive task state (SQLite, zero-daemon) |
| `genie omni` | Bridge agents to WhatsApp via Omni — remote approvals + inbound one-shots (`serve`, `status`, `inbox`, `handshake`) |
| `genie setup` | Configure Genie and wire up its Claude Code hooks |
| `genie doctor` | Run diagnostic checks on the installation |
| `genie hook` | Hook middleware for Claude Code integration |
| `genie shortcuts` | Manage terminal keyboard shortcuts |
| `genie update` | Update Genie to the latest GitHub release |
| `genie uninstall` | Remove Genie and clean up its hooks |
| `genie help` | Show help for any command |

## Skills

Skills are the product. The four core skills are rewritten for the v5 body and run natively in Claude Code today:

| Skill | What it does |
|-------|-------------|
| `/brainstorm` | Explore a vague idea until it's a concrete DESIGN.md |
| `/wish` | Turn a design into a scoped WISH.md with execution groups |
| `/work` | Dispatch subagents wave by wave to execute a wish |
| `/review` | Severity-gated verdict — SHIP, FIX-FIRST, or BLOCKED |

The rest of the v4 skill library survives and is being ported onto the new body — mostly mechanical re-plumbing of dispatch and state:

- **Being ported:** `/genie` (natural-language router), `/wizard` (onboarding), `/learn`, `/refine`, `/fix`, `/trace`, `/council`, `/docs`, `/genie-hacks`.
- **Deferred:** `/report` waits on a new observability data path; `/omni` (the natural-language skill) waits on the runner API settling, though its `genie omni` runner has landed; `/pm` and `/dream` (overnight batch execution) need a background-execution capability the zero-daemon body doesn't yet ship.

## How it works

Documents live in git; operational state lives in one SQLite file. `/work` fans agents out through Claude Code's native teams — each subagent gets its own task to claim, build, and mark done, with state changes serialized through `genie.db` rather than a coordinator. Review runs as a separate subagent from the one that wrote the code (reviewer ≠ engineer), so the verdict is an independent read of the diff against the wish's acceptance criteria, not the author grading their own work.

All linked worktrees of a repository share one `genie.db`, resolved from the git common directory, so a task created in one worktree is immediately visible in another with no sync step.

## Omni (WhatsApp bridge)

`genie omni` wires a running agent to WhatsApp through an [Omni](https://automagik.dev) hub, so you can drive approvals and short tasks from your phone.

**How it works** (verified by the test suite against a fake transport; the live WhatsApp round-trip is a documented manual-QA step — see `.genie/wishes/omni-runner-port/qa.md`):

- **Remote approvals.** When an approval-gated agent hits a permission request, the runner forwards it to your WhatsApp. Reply `y`/`n` (or `sim`/`nao`) or react 👍/👎 to approve or deny — the decision resolves the agent's pending request. Nothing is decided? The request times out to a safe `ask`.
- **Inbound one-shots.** A WhatsApp message on a *mapped* chat reaches a bounded `claude -p` in that chat's repo; the reply comes back to the same chat. Unmapped chats are stored, not answered — read them with `genie omni inbox`.

**What it needs:**

- An **Omni hub** plus a connected **WhatsApp instance** — Genie speaks to Omni over NATS; the hub owns the WhatsApp session.
- `genie omni handshake` once per host — registers an ed25519 keypair so outbound sends are signed.
- Approval-gated agents launched with `--permission-mode default`. Under `auto` mode a passthrough `ask` can auto-resolve to allow, which defeats the timeout→ask fail-safe.
- `genie omni serve` running as the one resident process. It is the *only* NATS client — `--help`, `task`, `board`, and every other command stay transport-free (`nats` never initializes on those paths).

## MCP server (Warp + Claude Code)

`genie mcp` is a zero-dependency, read-only [MCP](https://modelcontextprotocol.io) server over stdio. It lets the AI agent inside a Warp pane or Claude Code session query live board and wish state without shelling out to the CLI.

**How it gets picked up.** `genie init` registers the server into two project-scope config files, and `genie launch` writes the same pair into every worktree it opens:

- `.mcp.json` — Claude Code's project MCP config. Project-scope servers are *pending approval* until you trust the workspace (accept the trust dialog in an interactive `claude` session) — expected, not a bug.
- `.warp/.mcp.json` — Warp auto-detects this on save (no restart) and lists `genie` under Settings → AI/Agents → MCP servers.

Both files use the identical `mcpServers` shape and are merged idempotently: re-running `genie init` preserves every other server and top-level key and rewrites byte-identical. The registered `command` is the **absolute path to the running genie binary** (resolved from `process.execPath`), not bare `genie` — genie is not reliably on PATH (on macOS it lives only at `~/.genie/bin/genie`). Because `genie init`/`launch` run on the box that owns the repo, the recorded path is correct even under Warp's SSH-remote feature, where Warp spawns the server on that same box.

**What it exposes** — five read-only tools backed by the per-repo `.genie/genie.db`:

- `genie_board` — board counts + tasks (optional wish filter)
- `genie_wish_status` — a wish's group/DAG progress
- `genie_worktree_context` — resolves the pane's `wish/<slug>-<group>` branch to its wish, group, and tasks (the per-pane "what am I here for")
- `genie_task` — full task detail by id
- `genie_active` — every in-progress task and who claimed it

**Honest limitation — genie does not push into your tabs.** Warp exposes no external tab-push API, so genie cannot inject state into a pane. The flow is pull, not push: the pane's agent *asks* genie over MCP (`genie_worktree_context`, `genie_board`, …) when it wants to know the board state. `genie launch` still seeds each pane with a kickoff prompt at open time, but ongoing awareness is the agent querying the MCP server, not genie writing into the tab.

## Roadmap

No dates — direction, not promises:

- **Deeper Warp integration.** A Tab Config upgrade and richer pane orchestration on top of today's `genie launch`.
- **More emit targets.** Codex and Hermes as skill targets alongside Claude Code.
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
