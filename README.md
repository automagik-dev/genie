<p align="center">
  <img src=".github/assets/genie-logo.png" alt="Automagik Genie Logo" width="400">
</p>
<h2 align="center">The Universal AI Development Companion</h2>

<p align="center">
  <strong>🎯 Initialise, update, and orchestrate AI agents across any codebase</strong><br>
  Ship the Genie toolkit in minutes, keep it patched with smart updates, and command projects through MCP-integrated agents
</p>

<p align="center">
  <a href="https://github.com/namastexlabs/automagik-genie/actions/workflows/validate.yml"><img alt="Build Status" src="https://img.shields.io/github/actions/workflow/status/namastexlabs/automagik-genie/validate.yml?branch=main&style=flat-square" /></a>
  <a href="https://github.com/namastexlabs/automagik-genie/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/namastexlabs/automagik-genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://discord.gg/xcW8c7fF3R"><img alt="Discord" src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" /></a>
</p>

<p align="center">
  <a href="#-key-features">Features</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-mcp-integration">MCP Integration</a> •
  <a href="#-roadmap">Roadmap</a> •
  <a href="#-development">Development</a> •
  <a href="#-contributing">Contributing</a>
</p>

---

## 🚀 What is Automagik Genie?

**Automagik Genie** is the glue between your AI agents and your repositories. It ships a ready-to-run `.genie/` workspace, keeps it in sync with upstream templates, and exposes a battle-tested CLI + MCP server so any agent can work in your project with context.

### 🎭 Why Traditional Bootstrapping Fails

- **Manual setup drift** – each repo receives a slightly different `.claude` folder
- **No update path** – templates go stale, breaking downstream agents
- **Scattered backups** – figuring out what changed between runs is painful
- **Agent isolation** – MCP tooling cannot rely on a consistent project schema

### ✅ The Genie Approach

- **One-command initialise** – `npx automagik-genie init` migrates legacy `.claude`, writes provider preferences, and snapshots the workspace
- **Smart updates** – `npx automagik-genie update` diff-checks templates, creates recoverable backups, and applies only what changed
- **Automatic rollbacks** – `npx automagik-genie rollback` restores any prior snapshot in seconds
- **MCP-native** – the CLI and the MCP server share the same state, so agents always see the latest project context

---

## 🌟 Key Features

- **🧞 CLI bootstrap commands** – `init`, `update`, `rollback`, `statusline`, and compatibility shims for `status`/`cleanup`
- **📦 Template migration** – automatic conversion of historical `.claude` setups into the unified `.genie` layout
- **🔐 Provider memory** – stores Codex/Claude preference in `.genie/state/provider.json` and respects env overrides
- **💾 Version tracking** – `.genie/state/version.json` records install vs. update timestamps for diagnostics
- **🛟 Snapshot backups** – every command saves `.genie/backups/<timestamp>` (and `.claude` if present) before changing files
- **🤖 MCP server** – expose Genie agents to Claude Code, Cursor, Gemini CLI, Roo Code, and any generic MCP client
- **📋 Ink-powered UI** – rich terminal output for help, diffs, warnings, and summary panels

---

## 🧭 How Genie Fits in the Automagik Suite

```mermaid
flowchart LR
    subgraph Workspace
      Repo[Your Repository]
      GenieFolder[.genie/ structure]
    end

    InitCLI[automagik-genie init] --> GenieFolder
    UpdateCLI[automagik-genie update] --> GenieFolder
    RollbackCLI[automagik-genie rollback] --> GenieFolder

    GenieFolder --> MCPServer[Genie MCP Server]
    MCPServer --> Hive[Automagik Hive]
    MCPServer --> Spark[Automagik Spark]
    MCPServer --> Forge[Automagik Forge]

    GenieFolder --> Agents[Genie Agents & Prompts]
```

Genie is the canonical source of prompts, agents, and project metadata. Other Automagik products (Hive, Spark, Forge, Omni) rely on Genie to keep repository context predictable.

---

## 📦 Quick Start

### Prerequisites

- **Node.js 18+** (tested with pnpm 10+)
- **Git** for snapshot creation
- (Optional) **pnpm** if you plan to run tests locally: `corepack enable`

### One-Time Installation

```bash
# Initialise Genie in your repository
npx automagik-genie init --provider codex

# Show planned updates without applying them
npx automagik-genie update --dry-run

# Apply template changes and create a backup
npx automagik-genie update

# Restore the most recent backup if needed
npx automagik-genie rollback --latest
```

### CLI Help at a Glance

```bash
npx automagik-genie            # Shows the command palette
npx automagik-genie init --help
npx automagik-genie update --help
npx automagik-genie rollback --help
```

After running `init` you'll have:

- `.genie/agents/` – prompt, specialist, and utility agents
- `.genie/product/` – mission, roadmap, environment docs
- `.genie/state/` – provider, version, provider-status state
- `.genie/backups/<timestamp>/` – snapshots of previous states

---

## 📡 MCP Integration

Genie ships with a FastMCP server so any MCP-compatible coding agent can orchestrate Genie workflows.

### Typical Workflow

1. Initialise Genie in your repo (`npx automagik-genie init`)
2. Launch the MCP server via `genie mcp -t stdio`
3. Configure your tool of choice (Claude Code, Cursor, Gemini CLI, Roo Code, etc.) with the MCP command `npx automagik-genie mcp -t stdio`
4. Run Genie agents (`plan`, `wish`, `forge`, `review`, etc.) from within your editor or terminal

### Available MCP Tools

| Tool | Description | Example Usage |
|------|-------------|---------------|
| `mcp__genie__run` | Start a new Genie agent session | "Run plan with mission + roadmap context" |
| `mcp__genie__resume` | Continue a previous session | "Resume session RUN-1234 with follow-up prompt" |
| `mcp__genie__list_agents` | List available agents | "Show all specialists" |
| `mcp__genie__list_sessions` | Inspect active/archived sessions | "Which sessions ran today?" |
| `mcp__genie__view` | Fetch a transcript (full or tail) | "Fetch transcript for RUN-1234" |
| `mcp__genie__stop` | Halt a running session | "Stop RUN-5678" |

### Claude Code Configuration

```json
{
  "mcpServers": {
    "automagik-genie": {
      "command": "npx",
      "args": ["automagik-genie", "mcp", "-t", "stdio"]
    }
  }
}
```

Other MCP clients (Cursor, Roo, Gemini CLI, Cline) follow the same pattern—just change the command/args if you need HTTP or SSE transports.

---

## 🧪 Development

```bash
pnpm install             # Install dependencies
pnpm run build:genie      # Compile the TypeScript CLI
pnpm run test:genie       # Run CLI + smoke tests
```

All CLI code lives under `.genie/cli/src/`. Rebuild (`pnpm run build:genie`) before committing so `.genie/cli/dist/**/*` stays in sync for npm consumers.

---

## 🗺️ Roadmap

### Completed ✅
- Reinstated bootstrap commands (`init`, `update`, `rollback`)
- Automatic migration from legacy `.claude` directories
- Provider/Version state tracking and backup snapshots
- MCP server parity with the agent CLI

### Next Up 🚀
- Rich diff previews during `update`
- Extended provider health checks and auto-detection
- JSON output mode for CI integrations
- Replacement flows for deprecated `status` / `cleanup`

---

## 🤝 Contributing

We love contributions! Before you start:

1. Read the [CONTRIBUTING guidelines](CONTRIBUTING.md) for philosophy and standards
2. Open an issue to align on intent
3. Follow Conventional Commits (`feat: ...`, `fix: ...`, etc.) and co-author with 🧞
4. Run `pnpm run test:genie` and rebuild the dist bundle before submitting

---

## 📄 License

Automagik Genie is released under the MIT License. See [LICENSE](LICENSE) for details.

---

**Automagik Genie** – the faster, safer way to keep AI agents in sync with your repositories.

<a href="https://deepwiki.com/namastexlabs/automagik-genie"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
