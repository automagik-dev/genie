# Automagik Genie • Install Simulation (QA Script)

## Quickstart (Copy‑Paste Script)
Run these commands manually (humans only) to execute the QA from a clean folder. Edit the variables at the top if needed.

```bash
# 0) Settings (edit as needed)
export QA_DIR="/tmp/genie-qa-$(date +%s)"   # temp working folder
export GENIE_TEMPLATE="code"                 # or: create
export FORGE_BASE_URL="http://localhost:8887" # default private Forge

# 1) Prepare a clean repo
mkdir -p "$QA_DIR" && cd "$QA_DIR"
git init -b main

# 2) Initialize Genie (interactive: choose executor/model)
npx automagik-genie init "$GENIE_TEMPLATE" --forge-base-url "$FORGE_BASE_URL"

# 3) Inspect generated files (sanity checks)
ls -1A .
ls -1A .genie
sed -n '1,120p' .genie/config.yaml || true
cat .genie/state/version.json || true

# 4) (Optional) Use an existing Forge instead (example: 8887)
# npx automagik-genie init "$GENIE_TEMPLATE" --forge-base-url "http://localhost:8887"

# 5) Continue the Install session (replace with actual attemptId from init output)
# npx automagik-genie view <attemptId>
# npx automagik-genie resume <attemptId> "Follow-up message"
```

Paste your observed outputs in the sections below during QA.

Audience: Human QA running a clean install in a temporary folder to validate the latest Automagik Genie CLI behavior end‑to‑end.

Goal: Start from an empty repo, initialize Genie, verify MCP configuration, launch the per‑collective Install agent via Genie run, confirm Forge task creation, and capture expected outputs.

## Environment
- Node.js 18+ and Git available on PATH
- Network allowed for `npx` (to fetch the CLI) and Forge API (if targeting an existing Forge)
- Default private Forge port: `8887` (overridable via CLI flags)
- Genie MCP default HTTP port: `8885`

## 0) Clean Working Folder
```bash
TMP_DIR="/tmp/genie-qa-$(date +%s)" && \
mkdir -p "$TMP_DIR" && \
cd "$TMP_DIR" && \
 git init -b main
```

Expected output (abridged):
```
Initialized empty Git repository in /tmp/genie-qa-.../.git/
```

## 1) Initialize Genie (Code Collective)
Run init, pin the collective, and direct private Forge port via CLI flag.

```bash
npx automagik-genie init code --forge-port 8887
```

Expected behavior and output:
- Copies packaged `.genie/` into repo, preserving user areas (backups/reports/state).
- Copies `AGENTS.md` and `.gitignore` to repo root (does not copy/modify `CLAUDE.md`, except if present it appends `@AGENTS.md`).
- Backs up existing `.genie/` (if any) and root `AGENTS.md`:
  - `.genie/backups/<id>/genie/**`
  - `.genie/backups/<id>/AGENTS.md`
- Shows template selection behavior only if omitted (we passed `code`).
- Prompts for executor (arrow keys) and model (default inferred from config).
- Configures MCP: adds/updates Genie (@next) and Forge MCP entries.
- Starts Install via `genie run code/agents/install` using Forge backend.

Expected CLI output (abridged, illustrative):
```
🧞 Genie Init - Choose Your Template
  ... (skipped; we passed 'code')

🔧 Configuring MCP servers for executors...
✅ Added Genie MCP configuration to Codex
✅ Added Genie MCP configuration for Claude Code (project-local)
✅ Added Forge MCP configuration (project-local)

Genie initialization complete
  ✅ Installed Genie template at /tmp/genie-qa-.../.genie
  🔌 Default executor: codex (model: gpt-5-codex)
  💾 Backup ID: 2025-10-20T16-40-...Z
  📚 Template source: /.../node_modules/automagik-genie/.genie
  🛠️ Started Install agent via Genie run
```

Notes:
- The executor list may include `codex` and `claude`; pick one with arrows, then enter a model (or accept default).
- MCP configs:
  - Codex TOML gets `[mcp_servers.genie]` with `npx automagik-genie@next mcp`.
  - `.mcp.json` (Claude project-local) gets both `genie` and `forge` servers.

## 2) Install Agent Launch (Forge-backed)
Init automatically spawns:
```
node .genie/cli/dist/genie.js run code/agents/install "Use the install subagent... @agent-install @.genie/code/workflows/install.md"
```

Expected runtime output from Forge-backed session (abridged):
```
▸ Creating Forge task for code/agents/install...
▸ Task attempt created: 1a2b3c4d-...
Open in Forge: http://localhost:8887/tasks/1a2b3c4d-...   # (printed when backend provides URL)

  View output:
    npx automagik-genie view 1a2b3c4d-...
  Continue conversation:
    npx automagik-genie resume 1a2b3c4d-... "..."
  Stop the agent:
    npx automagik-genie stop 1a2b3c4d-...
```

Notes:
- If the backend does not return a URL on first response, only the attempt ID appears. The URL may show up on subsequent calls or in your Forge UI.
- The private Forge base URL defaults to `http://localhost:8887`. Use `--forge-base-url` or `--forge-port` with `init` to override.

## 3) Validate Files and State
Check that the expected files exist after init.

```bash
ls -1A . | sed -n '1,120p'
ls -1A .genie | sed -n '1,120p'
```

Expected key entries:
- Repo root:
  - `AGENTS.md` (copied)
  - `.gitignore` (copied)
- `.genie/`:
  - `config.yaml`
  - `state/version.json`
  - `state/provider-status.json`
  - `backups/<id>/...`
  - `code/**` and/or `create/**` collective files

Example: `.genie/state/version.json` (values will differ):
```json
{
  "version": "2.4.0-rc.36",
  "installedAt": "2025-10-20T16:40:55.123Z",
  "lastUpdated": "2025-10-20T16:40:55.123Z",
  "migrationInfo": { "backupId": "2025-10-20T16-40-...Z", "claudeBackedUp": false }
}
```

`.genie/config.yaml` should reflect your selections:
```
defaults:
  executor: codex
...
executionModes:
  default:
    description: Workspace automation via Forge-backed executors.
    executor: codex
    overrides:
      exec:
        model: gpt-5-codex
```

## 4) Optional: Target an Existing Forge
If you want to use an existing Forge (e.g., 8887), re-run init with the override.

```bash
rm -rf .genie && \
 git checkout -- . 2>/dev/null || true && \
 npx automagik-genie init code --forge-base-url http://localhost:8887
```

Expected differences:
- The install run points to `http://localhost:8887`.
- Task attempt id still prints; URL prints if backend returns it.

## 5) MCP Quick Checks
This ensures Genie MCP responds and clients can connect.

### Stdio transport (Claude Desktop)
- `.mcp.json` (project-local) now includes both `genie` and `forge` servers.
- Open Claude Desktop; converse with Genie via the MCP tool palette.

### HTTP transport (custom clients)
If you start MCP in HTTP mode, it will listen on `8885` by default.

```bash
MCP_TRANSPORT=httpStream MCP_PORT=8885 node .genie/mcp/dist/server.js &
# Then visit http://localhost:8885/mcp or /health for checks
```

Expected health output:
```
{"status":"ok","service":"genie-mcp","port":8885}
```

## 6) Next Steps and Recovery
- Continue the Install conversation from the CLI tips:
  - `npx automagik-genie view <attemptId>`
  - `npx automagik-genie resume <attemptId> "…"`
- If anything fails mid‑init, backups are under `.genie/backups/<id>/`.

## Appendix A • Full Expected Console (Example)
This concatenates an example of the most useful lines you should see during a healthy run.

```
🔧 Configuring MCP servers for executors...
✅ Added Genie MCP configuration to Codex
✅ Added Genie MCP configuration for Claude Code (project-local)
✅ Added Forge MCP configuration (project-local)

Genie initialization complete
  ✅ Installed Genie template at /tmp/genie-qa-.../.genie
  🔌 Default executor: codex (model: gpt-5-codex)
  💾 Backup ID: 2025-10-20T16-40-...Z
  📚 Template source: .../node_modules/automagik-genie/.genie
  🛠️ Started Install agent via Genie run

▸ Creating Forge task for code/agents/install...
▸ Task attempt created: 1a2b3c4d-...
Open in Forge: http://localhost:8887/tasks/1a2b3c4d-...

  View output:
    npx automagik-genie view 1a2b3c4d-...
  Continue conversation:
    npx automagik-genie resume 1a2b3c4d-... "..."
  Stop the agent:
    npx automagik-genie stop 1a2b3c4d-...
```

## Appendix B • Troubleshooting
- If you don’t see `Genie initialization complete`, scroll up for an error view with details.
- MCP config might skip Codex if `~/.codex/config.toml` is missing; that’s OK.
- If the Forge URL is not printed, open the Forge UI directly and locate the task by attempt ID.
- No `update` command in this release (intentionally removed).

---
This document is a simulation based on the current codebase. Use it to guide human QA from a clean workspace through init to an active Install session.
