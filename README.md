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

The repository-hosted `.well-known/latest.json`, `homolog.json`, and `dev.json` manifests are the authoritative channel pointers. GitHub's `/releases/latest` route and prerelease badge are deliberately not channel authority: a promotion advances only a monotonic manifest and never rewrites already-published assets or channel-significant draft/prerelease/latest metadata.

The installer detects Claude Code and Codex and installs the version-matched Genie plugin for each. Control this with `--integrations auto|codex|claude|all|none` or `--skip-integrations`. When Codex is selected, the installed plugin is the **only** Genie-managed skill provider: a fresh install writes zero Genie product skills into `~/.agents/skills/` and requires one enabled, exact-version plugin with a usable MCP launcher and complete skill payload before it mutates anything. An upgrade from a release that still seeded user-tier fallbacks quarantines only provably clean historical copies — and only after a single post-convergence plugin health proof passes; same-name unmanaged, modified, malformed-marker, or symlinked user copies are preserved in place and reported as user-owned collisions. Automatic integration failures warn after the verified binary succeeds; explicitly requested failures are fatal.

From inside a repo, run `genie init`. Use `genie setup --codex` to explicitly install or repair the Codex plugin, seven optional role-agent profiles, MCP routing, and the backup-first dead-OTel migration. A successful Codex setup also persists Codex maintenance consent: later, explicit `genie update` runs may refresh those Codex integration surfaces. That consent never writes new product skills into the user tier, never makes personal or modified skills managed, and it gives no authority to hooks. `genie update` is the explicit update/convergence path. When crossing from a release older than `5.260711.6` to `5.260711.6` or later, let the first update finish and run `genie update` one more time: the first process may only deliver the new binary/payload, while the second runs the new convergence contract. If the older release had seeded clean user-tier fallbacks, the convergence run retires them into a hidden quarantine transaction (see [Codex fallback quarantine and recovery](#codex-fallback-quarantine-and-recovery)) once one health proof passes. Verify that the plugin exposes exactly H3/H4/H6, then review their hashes with `/hooks` and start a new task. Later updates converge in one operator-driven path. No Codex hook or Claude SessionStart hook installs software, refreshes plugins, synchronizes skills, stamps workflows, or writes project instructions.

Codex never auto-trusts plugin hooks. H4/H6 definitions bind the exact plugin launcher SHA-256 and the launcher verifies itself before spawning, so launcher changes produce new definitions; the current hook schema still cannot transitively bind the mutable platform-specific Genie binary. After setup or update, inspect the three Genie definitions with `/hooks`, approve only the hashes you understand, and start a new task so the reviewed definitions take effect. Until then they remain untrusted and do not run.

## Quickstart

The lifecycle is shared by Claude Code and Codex. Claude uses slash skills. A Codex plugin install uses the unambiguous owner-qualified `$genie:<skill>` selector; bare `$<skill>` resolves the user tier, which now only ever holds a separately installed personal copy (Genie no longer seeds the user tier):

```text
1. /brainstorm or $genie:brainstorm   an idea → DESIGN.md → digest-bound mandatory design review
2. /wish or $genie:wish               accepted DESIGN.md → a scoped WISH.md
3. /review or $genie:review           mandatory plan review; persist APPROVED or concrete gaps
4. /work or $genie:work               native role agents build each approved group
5. /review or $genie:review           independent implementation review: SHIP, FIX-FIRST, or BLOCKED
```

These are manual invocation selectors. Codex starter cards embedded in each physical skill are selector-free, so the selected plugin-tier or user-tier card cannot redirect to its same-name copy in another tier.

Re-run `genie board` any time for a current snapshot of task state on the kanban. The plan documents land in git as you go; the operational state lives in `.genie/genie.db`.

## What's inside

- **Skills** carry the methodology — `brainstorm → design review → wish → plan review → work → implementation review`, authored once for native Claude and Codex surfaces.
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

Skills are the product. Invoke them as `/name` in Claude, `$genie:name` from the Codex plugin, or `$name` only when intentionally selecting a corresponding personal user-tier copy you installed yourself:

| Skill | What it does |
|-------|-------------|
| `brainstorm` | Explore a vague idea until it's a concrete DESIGN.md |
| `wish` | Turn a design into a scoped WISH.md with execution groups |
| `work` | Dispatch native role subagents wave by wave |
| `review` | Severity-gated verdict — SHIP, FIX-FIRST, or BLOCKED |
| `council` | Independent architecture, delivery, product, security, and dissent assessment |

Shared skill bodies use a runtime-neutral delegation contract. Codex maps it to the optional `genie_*` custom-agent profiles installed by the CLI; a plugin-only install still has skills but no custom agents. Every concurrent execution group uses its own branch and worktree; native subagents that cannot be placed in isolated worktrees must be sequenced or dispatched through `genie launch`. The PM owns the wish integration worktree, merges reviewed group commits, resolves conflicts, and removes merged group worktrees and branches. The engineer reports completion, an independent reviewer returns a verdict, and only the orchestrator runs `genie task done` after integration, validation, and cleanup. `/level-up` remains Claude-only because it evaluates Claude Code mastery.

At the wish boundary, Genie derives mainline ownership from Git topology. If `main` tracks a GitHub remote's `main`, local `main` is fast-forwarded and proven equal to that upstream, and completed wishes enter through reviewed GitHub PRs. A repository with no remotes is local-only: the PM validates a temporary merge candidate, archives that exact integrated closure as `archive/wish/<slug>`, removes its clean active lanes, and then fast-forwards unchanged `main` to the archived commit. Other or ambiguous remote layouts require an explicit user decision.

### Codex surface boundaries

These five inventories are intentionally separate:

| Surface | What ships | Ownership |
|---------|------------|-----------|
| Codex plugin | 23 physical, in-root product skills with `agents/openai.yaml`; three untrusted hooks; MCP declaration | Versioned release payload; the **sole** Genie-managed skill provider — nothing is copied into the user tier |
| Fallback retirement | Hidden `~/.agents/skills/.genie-codex-fallback-retirement/` quarantine transaction | Not written on fresh install. Upgrades from a fallback-seeding release move only provably clean historical copies here after one health proof; evidence is retained for recovery |
| CLI integration | Seven optional `genie_*` role-agent TOMLs under `~/.codex/agents/` | Installed/repaired by `genie install` or `genie setup --codex` behind the same plugin health gate; clean managed copies refresh on explicit update |
| Personal skills | This maintainer currently has 36 separately adapted skills under `~/.agents/skills` | User-owned; not bundled with Genie and never implied by plugin installation; preserved byte-for-byte even on same-name collision |
| MCP launcher | Plugin-local Node launcher for `genie mcp` | Resolves only the canonical executable under `$GENIE_HOME/bin` (default `~/.genie/bin`) and fails closed if it is missing or unsafe |

The plugin's 23 skills and a user's personal 36-skill library are separate inventories even when names overlap. Genie never seeds the user tier and preserves unmanaged, modified, malformed-marker, and symlinked user copies instead of adopting them; use `$genie:<skill>` when the plugin copy is intended.

### Codex hooks: three reviewed behaviors

| Event | Behavior | Side effects |
|-------|----------|--------------|
| `SessionStart` (H3) | Inspects at most 64 candidate directories and 256 KiB of wish files, then emits at most eight validated slug/status/count records capped at 2 KiB | Read-only; no titles, free-form repository text, network, install, update, or writes |
| `PreToolUse` (H4) | Runs branch/orchestration checks for `Bash` and audit-context checks for `Write`, `Edit`, and `apply_patch` | Codex handling is deterministic and network-free; it does not invoke the unregistered freshness (`Read`) or identity (`SendMessage`) handlers, never calls Omni, and never installs or synchronizes anything |
| `PermissionRequest` (H6) | Applies the configured matcher and, only when Omni approvals are explicitly enabled, queues one bounded/redacted remote decision | The only retained hook allowed to write approval-queue state; failure, timeout, malformed output, or interruption denies with a reason |

The removed hooks were the startup installer, first-run `AGENTS.md` writer, pre/post wish validators, per-prompt context reinjection, and inert completion validator. Setup and updates are operator commands, never lifecycle side effects.

### Codex fallback quarantine and recovery

Older Genie releases seeded up to 23 digest-managed product skills into `~/.agents/skills/`. When a plugin-only convergence run upgrades such a machine, it does **not** delete those copies. After one post-convergence plugin health proof passes, it moves only the provably clean, Genie-owned copies into a single durable quarantine transaction under:

```text
~/.agents/skills/.genie-codex-fallback-retirement/
  .retirement.lock          single-writer lock for the retirement root
  txn-<id>/journal.json     fsynced full-batch record of every retired identity
  txn-<id>/quarantine/<skill>/   the retired skill trees, moved intact
  txn-<id>/evidence/<skill>/     changed-tree copies archived aside during recovery races
```

A copy is only retired when it is a physical non-symlink directory, carries a valid versioned `.genie-sync.json` marker, its recomputed canonical physical digest equals the marker digest, and it matches either the verified target-plugin payload or a committed verified-release historical tuple. Anything failing any predicate — modified-managed, malformed-marker, symlinked, or an unmanaged same-name personal skill — stays in place untouched and is reported as a user-owned collision.

The transaction is idempotent and durable: repeated updates recognize the committed transaction and never create a second one or accumulate quarantine entries; an interrupted run reverse-restores every pre-commit move without clobbering conflicts. Quarantine and journal evidence are retained after commit so you can recover manually:

- **Recover a retired skill.** Move the tree back out of `txn-<id>/quarantine/<skill>/` into `~/.agents/skills/<skill>/`. This is only needed if you intentionally want a bare `$<skill>` user-tier copy; the plugin already serves it as `$genie:<skill>`.
- **"Source changed after planning".** If your live skill was edited between the health proof and the move, retirement aborts before touching disk — the changed personal copy simply stays in place at `~/.agents/skills/<skill>`; nothing is moved, republished, or archived. Review that copy, then rerun the command.
- **"Changed evidence retained".** This is the class that republishes to the live path and archives aside: when a quarantined tree changed during restore or disposal, the changed copy is retained under `txn-<id>/evidence/<skill>/` (nested inside the transaction dir, beside `quarantine/`) as your durable backup of that exact content. Diff it against the live path before removing it.

`genie doctor` reports the quarantined count and every preserved collision (name, classification, effective precedence, and remediation). It never claims literal name uniqueness while user content remains.

### Restart Codex after a Codex convergence

Codex reads its plugin catalog and skill inventory at process start. After any `genie install --integrations codex`, `genie setup --codex`, or `genie update` that touched Codex, **restart Codex** so it drops any stale bare user-tier providers and loads only the owner-qualified `genie:*` plugin skills. Then review the three hook definitions with `/hooks` and start a new task.

### Manual dogfood checklist

After a real convergence, verify from a restarted Codex session:

```text
genie --version matches the enabled genie@automagik plugin
genie doctor reports plugin-only Codex skills and usable MCP
Codex SessionStart and PreToolUse complete without hook failure
Genie MCP wish_status returns live data
loaded catalog contains genie:wish/genie:work and no managed bare duplicates
```

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
  <a href="https://github.com/automagik-dev/genie/releases"><strong>Releases</strong></a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R"><strong>Discord</strong></a> &middot;
  <a href="LICENSE"><strong>MIT License</strong></a>
</p>

<p align="center"><sub>You describe the problem. Genie does the rest.</sub></p>
