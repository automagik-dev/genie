# mikro — Claude Code plugin

Registers the mikro MCP server against **the project you have open**, so every
`agent.yaml` microagent in that workspace shows up as a callable tool.

Without the plugin you register the server yourself and it inherits whatever
directory the host spawned it in. With the plugin, the registration passes
`--dir ${CLAUDE_PROJECT_DIR}` explicitly, so agent discovery, `loadConfig`,
relative `context` arguments and the REPL cwd all agree on your project root
(`src/cli.ts:1039-1054`).

| | |
|---|---|
| Plugin | `mikro` |
| Marketplace | `mikro` (this repository) |
| Install id | `mikro@mikro` |
| Ships | 1 MCP server (`mikro`), 2 skills |
| Requires | the `mikro` CLI on `PATH` |
| Verified on | Claude Code 2.1.220, mikro `v0.260725.1`, Linux |

## Install

**Step 1 — the CLI**, if you do not have it. This is the canonical installer
(see `docs/release-contract.md`); mikro is not published to npm, so there is
no npm path.

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/mikro/main/scripts/install.sh | bash
```

It clones to `~/.mikro/mikro`, builds, and links `~/.local/bin/mikro`. If you
already have a clone, `bash scripts/install.sh` from anywhere does the same.

**Step 2 — the plugin.** One command, run from anywhere:

```bash
claude plugin marketplace add ~/.mikro/mikro && claude plugin install mikro@mikro
```

Point the path at whatever clone you have — `claude plugin marketplace add
~/src/mikro` works the same. The clone *is* the marketplace: `marketplace.json`
lives at the repository root and the plugin entry is a relative path
(`./plugins/claude-code`), which is the layout Claude Code documents for
plugins living in the same repository as their marketplace.

> **Why two verbs on one line.** Claude Code has no single command that
> registers a local marketplace and installs from it; `claude plugin install`
> takes a plugin name, never a path. The line above is one copy-paste, not one
> CLI call. Nothing else is needed — no npm, no clone of a separate marketplace
> repository.

Then, in an already-running session, `/reload-plugins`. New sessions pick it up
on their own.

### Team scope

```bash
claude plugin marketplace add ~/.mikro/mikro --scope project
claude plugin install mikro@mikro --scope project
```

writes to `.claude/settings.json`, so everyone who clones your project gets the
plugin.

## Verify

From a workspace that has at least one microagent (`.mikro/agents/<name>/`):

```bash
claude mcp list
```

Expect the plugin's own server, with your project directory already
substituted:

```
plugin:mikro:mikro: mikro mcp --dir /path/to/your/project - ✔ Connected
```

Component inventory and what the plugin costs a session:

```bash
claude plugin details mikro
```

## What you get

- **`mikro_query`** — one-shot query on the configured model.
- **One tool per microagent** discovered under `~/.mikro/agents/`,
  `<project>/.mikro/agents/`, or `<project>/.agents/` — project shadows global,
  `MIKRO_AGENTS_DIR` overrides (`src/mcp/agents.ts:1-18`). A workspace with
  `.mikro/agents/explore-r/` gets `mikro_explore-r`.
- Every result carries a token/cost footer, so the offload is visible in the
  transcript rather than taken on faith.

Inside a session the plugin's tools are namespaced
`mcp__plugin_mikro_mikro__<tool>` — `mcp__plugin_mikro_mikro__mikro_explore-r` and
so on. That prefix is how you tell them apart from a bare `claude mcp add mikro`
registration, which appears as `mcp__mikro__<tool>`.

### Skills

Both ship with content. Neither is loaded until its trigger fires, so an idle
session pays only for the two description lines in the manifest.

| Skill | What it does |
|---|---|
| `/mikro:offload-guidance` | A routing rule. An explore-class question about a repository you have not read into context goes to `mikro_explore-r` **first**, ahead of Grep/Glob/Read and ahead of an Explore subagent; its citations are leads you then verify. Carries the three measured escalation triggers — citations that do not resolve, an errored or timed-out run, and work where completeness matters more than cost — plus the call shape and `session_id` resume. Every number in it is the parity report's, at the report's own scoping. |
| `/mikro:microagent-create` | Propose-only self-reflection. Streams this host's last-24h Claude Code transcripts through a bundled scanner (`scan-transcripts.mjs`), ranks recurring work into offload families by the context each returns, picks at most one candidate against five stated rules, and writes a draft `agent.yaml` + `SYSTEM.md` + `EVIDENCE.md` into `.mikro/agents/<name>.proposed/`. Then it stops and hands you the `mv`. It cannot activate anything: `.proposed` is a reserved suffix that discovery skips (see below). |

The scanner is a script rather than "read the transcripts" for the obvious
reason: `~/.claude/projects` runs to ~100 MB a day on an active machine, and
reading it into a session to find out what is filling that session's context
would be the joke telling itself. It streams and returns about a page.

### `.proposed` is a reserved directory suffix

`discoverAgents` skips any agent directory whose name ends `.proposed`,
matched case-insensitively (`src/mcp/agents.ts` — `isProposedDir`). The skip
happens before the spec is parsed and before the tool list is built, and
`tools/call` dispatches from that same scan, so a draft is **neither listed nor
callable** — calling it by name answers `Unknown tool: mikro_<name>_proposed`.
Renaming the directory publishes it on the next request, live, with no
reconnect.

The price: an agent you genuinely wanted to name `foo.proposed` is permanently
invisible, and **the skip is silent** — no warning, by design. That is why it is
documented here, in the skill, and in `docs/agent-yaml-schema.md`.

## Honest positioning

`explore-r` is a **first-pass** explorer, not a replacement for reading the
code yourself. It failed its parity gate. Everything below is from
[`docs/parity-explore.md`](../../docs/parity-explore.md), at that report's own
scoping:

- **Out-of-sample coverage 0.714** (10/14) on the holdout — run once, after the
  recipe and model were chosen, never fed back — against **0.853–0.912 on the
  fitness set it was tuned on**: "a real drop of 0.14–0.20"
  (`docs/parity-explore.md:1047-1048`). The holdout number is the one that
  describes a question you have not asked yet.
- **Citations, in the frozen configuration only**: that shot produced "215
  citations, zero unresolvable, zero fabricated"
  (`docs/parity-explore.md:827-828`). This is not a property of the tool in
  general — **earlier rounds fabricated**, repeatedly and badly (a full-24-
  iteration haiku run cited a file that does not exist,
  `docs/parity-explore.md:426-427`), and the verification block in the tuned
  prompt is what fixed it: "fabrications fell sharply wherever it ran"
  (`docs/parity-explore.md:685`).
- **Premium-token reduction, frozen configuration: 1,077×** aggregate across
  the six-task suite (per-task **530×–1,835×**), for **$0.22** of gateway
  spend (`docs/parity-explore.md:960-970`). Round 1's `r15-flash-control` — a
  different, non-shipping configuration — measured 921× for $0.14
  (`docs/parity-explore.md:554-562`); the two are not interchangeable. The
  report states the price of the number in the same breath: "It still buys an
  answer that fails the quality bar, which is why this column was never allowed
  to be the gate."
- The campaign evaluated **four generations and rejected a fifth** — gen-4,
  rejected because four training anchoring terms sit verbatim in its own prompt
  (`docs/parity-explore.md:1049-1055`). Recursion product fixes landed in commit
  `6ec4822` (child model pinning, `rlm_query` model arg, loud child failure).

Read the report before quoting any of this. If a number here and a number there
disagree, the report wins.

## How it is wired

```
<repo root>/
├── .claude-plugin/marketplace.json   the catalog — one entry, source ./plugins/claude-code
└── plugins/claude-code/              the plugin root
    ├── .claude-plugin/plugin.json    manifest — metadata + both skill entries
    ├── .mcp.json                     the MCP registration
    ├── skills/
    │   ├── offload-guidance/SKILL.md
    │   └── microagent-create/SKILL.md
    └── README.md
```

Only `plugins/claude-code/` is copied into the plugin cache on install — the
marketplace file stays behind in the clone.

`.mcp.json`, in full:

```json
{
  "mcpServers": {
    "mikro": {
      "command": "mikro",
      "args": ["mcp", "--dir", "${CLAUDE_PROJECT_DIR}"]
    }
  }
}
```

`${CLAUDE_PROJECT_DIR}` is a Claude Code plugin variable that substitutes into
an stdio MCP server's `command`, `args` and `env`. It resolves to the project
root.

## Limits, stated

- **`mikro` must be on `PATH`** in the environment Claude Code runs in.
  Installed plugins are copied into `~/.claude/plugins/cache` and cannot
  reference files outside their own directory, so the plugin cannot point at a
  `dist/` inside the clone it shipped from. `scripts/install.sh` putting `mikro`
  in `~/.local/bin` is what makes the registration resolve. If the server shows
  as failed in `claude mcp list`, check `command -v mikro` in the shell that
  launched Claude Code.
- **The MCP server is only as current as your checkout.** `mikro` is a symlink
  into the clone's `dist/`. `mikro update` refreshes it; the plugin does not.
- **Updating the plugin** is separate from updating the CLI:
  `claude plugin marketplace update mikro && claude plugin update mikro`. The
  plugin pins an explicit `version`, so a changed file in the clone is not
  picked up until that version is bumped.
- **The marketplace name `mikro` is global per user.** Adding a second
  marketplace under the same name replaces the first.

## Uninstall

```bash
claude plugin uninstall mikro
claude plugin marketplace remove mikro
```
