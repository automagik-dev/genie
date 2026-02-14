# Genie CLI

Collaborative terminal toolkit for human + AI workflows.

Genie CLI ships three CLIs:

- **`genie`** — setup wizard, prerequisites installer, and hook management
- **`term`** — tmux orchestration for managing terminal sessions (AI-safe)
- **`claudio`** — Claude Code launcher with custom LLM routing profiles

**Core idea:** tmux is the collaboration layer. AI agents run inside shared tmux sessions; humans can attach at any time to watch, assist, or take over.

---

## What you get (features)

### Workflow skills (shared across tools)
Genie provides a set of **skills** (slash commands) centered on a 4-command workflow:

`/brainstorm → /wish → /work → /review`

These skills can be loaded in:

- **Claude Code** via the `automagik-genie` Claude plugin
- **OpenClaw** via the `automagik-genie` OpenClaw plugin

✅ **Single source of truth:** all skills live in **`./skills/`** at the repo root.

### Claude Code integration (plugin)
- Installs/links the Claude plugin at `~/.claude/plugins/automagik-genie`
- Ships skills + agents + hooks

### OpenClaw integration (plugin)
- Installs/links an OpenClaw plugin with the **same id**: `automagik-genie`
- The plugin exposes the same skills to OpenClaw so they can appear as global slash commands (depending on your OpenClaw config)

> Note: after installing an OpenClaw plugin you typically need to **restart the OpenClaw Gateway** to load it.

---

## Repository layout (important)

```
./skills/                          # ✅ canonical skills directory
./plugins/automagik-genie/         # Claude Code + OpenClaw plugin wrapper
  ├── .claude-plugin/              # Claude Code plugin manifest
  ├── openclaw.plugin.json         # OpenClaw plugin manifest
  ├── automagik-genie.ts           # OpenClaw standalone extension entrypoint
  └── skills -> ../../skills       # symlink to canonical skills
```

This ensures **one SKILL.md per skill**, reused by both ecosystems.

---

## Quick start

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash
```

### Dev install (from a local clone)

```bash
./install.sh --local /path/to/genie-cli --dev
```

- `--local` builds from source and `npm link`s the CLI
- `--dev` links the OpenClaw plugin instead of copying it

---

## install.sh flags

```text
--local PATH    Install from local source directory (for development)
--dev, -d       Dev mode: link OpenClaw plugin instead of copying
uninstall       Remove Genie CLI and components
```

---

## Claude Code plugin

During install, you can choose to install the Claude Code plugin.

- If using a local clone, the installer creates a symlink:
  - `~/.claude/plugins/automagik-genie -> <repo>/plugins/automagik-genie`

Verify:

```bash
claude plugin list | rg automagik-genie
```

---

## OpenClaw plugin

During install, you can choose to install the OpenClaw plugin.

Under the hood, OpenClaw installs the standalone extension entrypoint:

- `plugins/automagik-genie/automagik-genie.ts`

Verify:

```bash
openclaw plugins list | rg automagik
```

Then restart the gateway:

```bash
openclaw gateway restart
```

---

## Configuration files

| File | Purpose |
|------|---------|
| `~/.genie/config.json` | Hook presets and session settings |
| `~/.claudio/config.json` | LLM routing profiles (API URL, model mappings) |
| `~/.claude/settings.json` | Claude Code settings (hooks registered here) |
| `~/.claude/hooks/genie-bash-hook.sh` | Hook script enforcing configured behaviors |

---

## `genie` reference

### Prerequisites check & install

```bash
genie install              # Interactive prerequisite check & install
genie install --check      # Only check, don't offer to install
genie install --yes        # Auto-approve all installations
```

**What it checks**

| Prerequisite | Required | Installation Method |
|--------------|----------|---------------------|
| tmux | Yes | brew > apt/dnf/pacman > manual |
| bun | Yes | Official installer (curl) |
| claude | No (recommended) | npm/bun global install |

### Hook configuration (`genie setup`)

```bash
genie setup          # Interactive wizard
genie setup --quick  # Use recommended defaults (collaborative + audited)
```

### Hook management (`genie hooks`)

```bash
genie hooks show

genie hooks install
genie hooks install --force

genie hooks uninstall
genie hooks uninstall --keep-script

genie hooks test
```

---

## Hook presets

### Collaborative (recommended)

**What:** All terminal commands run through tmux

**Why:** You can watch AI work in real-time

**How:** Bash commands are rewritten to `term exec <session> '<command>'`

```bash
tmux attach -t genie
```

Example config:

```json
{
  "hooks": {
    "enabled": ["collaborative"],
    "collaborative": {
      "sessionName": "genie",
      "windowName": "shell"
    }
  }
}
```

### Supervised

**What:** File changes require your approval

Example config:

```json
{
  "hooks": {
    "enabled": ["supervised"],
    "supervised": {
      "alwaysAsk": ["Write", "Edit"]
    }
  }
}
```

### Sandboxed

**What:** Restrict file access to specific directories

Example config:

```json
{
  "hooks": {
    "enabled": ["sandboxed"],
    "sandboxed": {
      "allowedPaths": ["~/projects", "/tmp"]
    }
  }
}
```

### Audited

**What:** Log all AI tool usage to a file

Example config:

```json
{
  "hooks": {
    "enabled": ["audited"],
    "audited": {
      "logPath": "~/.genie/audit.log"
    }
  }
}
```

### Combining presets

```json
{ "hooks": { "enabled": ["collaborative", "audited"] } }
```

---

## Worker Profiles

Worker profiles configure how genie-cli spawns Claude Code workers. Each profile bundles a launcher (`claude` or `claudio`) with CLI arguments.

### Quick Commands

```bash
genie profiles list              # List all profiles (* = default)
genie profiles add <name>        # Add new profile (interactive)
genie profiles show <name>       # Show profile details
genie profiles rm <name>         # Delete profile
genie profiles default <name>    # Set default profile
```

### Using Profiles

```bash
term spawn implementor --profile coding-fast   # Use specific profile
term work bd-123 --profile autonomous          # Complex task with opus
```

### Example Config

```json
{
  "workerProfiles": {
    "coding-fast": {
      "launcher": "claudio",
      "claudioProfile": "coding-fast",
      "claudeArgs": ["--dangerously-skip-permissions"]
    },
    "safe": {
      "launcher": "claude",
      "claudeArgs": ["--permission-mode", "default"]
    }
  },
  "defaultWorkerProfile": "coding-fast"
}
```

For full documentation, see [docs/worker-profiles.md](docs/worker-profiles.md).

---

## `term` reference

### Command tree

```
term
├── new <name>              Create session (-d workspace, -w worktree)
├── ls                      List sessions (--json)
├── attach <name>           Attach interactively
├── rm <name>               Remove session (--keep-worktree)
├── read <session>          Read output (-n, --grep, --json, -f)
├── exec <session> <cmd>    Run command (async)
├── send <session> <keys>   Send keys with Enter (--no-enter for raw)
├── split <session> <h|v>   Split pane (-d, -w)
├── info <session>          Session info (--json)
├── watch <session>         Watch events in real-time
├── run <session> <msg>     Fire-and-forget with auto-approve
├── window
│   ├── new <session> <name>
│   ├── ls <session> (--json)
│   └── rm <window-id>
├── pane
│   ├── ls <session> (--json)
│   └── rm <pane-id>
├── orc
│   ├── start <session>     Start Claude with monitoring
│   └── status <session>    Claude state (idle/busy/permission)
└── hook
    ├── set <event> <cmd>
    ├── list
    └── rm <event>
```

### Common options

| Option | Description |
|------|-------------|
| `--json` | Output as JSON (essential for agents) |
| `-n <lines>` | Number of lines to read |
| `-f` | Follow mode (live tail) |
| `-d <path>` | Working directory |
| `-w` | Create git worktree |
| `--grep <pattern>` | Filter output by pattern |

---

## `claudio` reference

claudio launches Claude Code with custom LLM routing profiles.

**Key principle**: `claude` = vanilla Anthropic, `claudio` = your custom router setup.

### Commands

### Brainstorm

- `genie brainstorm crystallize --slug <slug> [--file <path>]`
  - Reads draft markdown (default: `.genie/brainstorms/<slug>/draft.md`)
  - Writes/overwrites: `.genie/brainstorms/<slug>/design.md`
  - Upserts: `.beads/issues.jsonl` (default depends_on: `["hq-roadmap"]`)
  - Prints the written paths

### Ledger

- `genie ledger validate [--repo <path>] [--json]`
  - Validates `.beads/issues.jsonl` JSONL structure (scriptable)

### `term beads-validate` (deprecated)

Deprecated in favor of **`genie ledger validate`**.

Validate the local Beads JSONL ledger file:

- Path: `.beads/issues.jsonl`
- Checks: file exists, each non-empty line is valid JSON, and `id` is present/unique.

```bash
# preferred
genie ledger validate --repo .
genie ledger validate --repo . --json

# deprecated
term beads-validate --repo .
term beads-validate --repo . --json
```

```
claudio                     Launch with default profile
claudio <profile>           Launch with named profile

claudio setup               First-time setup wizard
claudio profiles            List all profiles (* = default)
claudio profiles add        Add new profile
claudio profiles rm <name>  Delete profile
claudio profiles default <name>  Set default profile
claudio profiles show <name>     Show profile details

claudio models              List available models from router
claudio config              Show current config
```

Config lives in `~/.claudio/config.json`.

---

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash -s -- uninstall
```

The uninstaller will offer to remove:
- the Genie CLI package
- Claude Code plugin
- OpenClaw plugin (disable + remove extension dir)
- `~/.genie` config directory (optional; default is to keep)

---

## License

MIT
