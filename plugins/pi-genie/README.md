# Genie Pi Plugin

The pi-native surface for Genie orchestration: seven read-only tools, a `/genie`
slash command, an advisory per-turn board snapshot, a session-start hint, and
opt-in canonical skill loading — all wrapping the genie v5 CLI through an
argv-only subprocess bridge. Every tool payload reports `mutation: "none"`.

The extension is dependency-free (plain JSON Schema parameters, node built-ins
only), so it typechecks and tests under plain bun and loads under pi's jiti
loader with zero npm installs.

## Install

From the release that ships `plugins/pi-genie` in the payload, genie installs
the pi extension **automatically**:

- `install.sh` extracts the payload into `$GENIE_HOME/plugins/pi-genie` (via the
  finishing `genie install` aux-layout normalization), and
- the agent-sync **`pi` lane** — run by `genie install` and every `genie update`
  — symlinks `~/.pi/agent/extensions/genie` → `$GENIE_HOME/plugins/pi-genie`
  whenever pi is detected (pi CLI on PATH or `~/.pi/agent` present).

`genie doctor` reports the link as `agent sync: pi`. No manual step needed on
fresh installs or updates.

For a dev checkout (edits are live) or a detached, release-style copy, the
local installer remains available:

```bash
# default: symlink ~/.pi/agent/extensions/genie -> this checkout (edits are live)
plugins/pi-genie/scripts/install-local.sh

# manual equivalent (from the repo root)
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/plugins/pi-genie" ~/.pi/agent/extensions/genie

# detached, release-style copy instead of a symlink
plugins/pi-genie/scripts/install-local.sh --copy
```

pi auto-discovers `~/.pi/agent/extensions/*` (global) and `.pi/extensions/*`
(project-local, trusted projects only). The directory form is used so pi reads
the bundled `package.json` → `pi.extensions` entry; the version stamp in that
manifest is synced by the release machinery.

After installing: run `/reload` inside pi (or start a new session) to load the
extension. To replace a previously installed standalone `~/.pi/agent/extensions/genie.ts`
copy, pass `--force`.

## Smoke Test

```bash
plugins/pi-genie/scripts/smoke.sh
```

Or by hand — inside any Genie workspace (a repo with `.genie/`):

```text
/genie                  # doctor health + board column counts in the TUI
/genie status           # same, with args echoed
```

The tools are also callable by the model; `pi -p` works for headless checks:

```bash
pi -p "Call genie_status and genie_board. Summarize." --tools genie_status,genie_board
```

## Tools

All seven tools are read-only — every payload carries `mutation: "none"`.

| Tool | What it does | Mutation |
|------|--------------|----------|
| `genie_status` | Genie installation health (`genie doctor --json`) plus a `.genie/` presence check | none |
| `genie_board` | Planning board (`genie board --json`), optionally scoped to a wish slug or board | none |
| `genie_wish_status` | Composite wish status: board slice plus task list for one slug | none |
| `genie_task_list` | Task list with optional wish, status, and board filters | none |
| `genie_task_status` | One task's detail, dependencies, and stage log (raw capture) | none |
| `genie_work_plan` | Execution-plan preview via `genie launch <slug> --dry-run` | none |
| `genie_review_plan` | Board/tasks plus Success and QA Criteria extracted from the wish's WISH.md | none |

The full layer map (tools, command, hooks, skills, MCP parity) lives in
[`references/native-surface.md`](references/native-surface.md).

## Hooks

| Hook | Behavior | Mutation |
|------|----------|----------|
| `session_start` | Notifies when the session runs inside a `.genie/` workspace, nudging toward the structured tools | none |
| `before_agent_start` | Injects a bounded board snapshot (≤8 rows, ≤2 KiB) as system-prompt context — Codex H3 / Hermes `pre_llm_call` parity | none |

Both are advisory-only and never block a turn; every failure degrades to no
injection.

## Skills

pi discovers Genie skills natively from `~/.agents/skills/` and project
`.agents/skills/` — no plugin wiring needed for those. For a fresh machine
without user-tier copies, the canonical plugin mirror can be contributed via:

```bash
GENIE_PI_CANONICAL_SKILLS=1 pi
```

This loads `$GENIE_HOME/plugins/genie/skills` (the byte-checked release mirror)
through `resources_discover`. It is off by default so the plugin never collides
with user-owned skill copies pi loads first.

## Versioning and shipping

`plugins/pi-genie/package.json` carries the release version and is synced by the
same machinery as the other plugin manifests (`scripts/version.ts`,
`.github/workflows/version.yml`, `scripts/release-guard.sh`). The tarball
assembly copies the whole `plugins/` tree, so the pi plugin ships inside every
release payload.
