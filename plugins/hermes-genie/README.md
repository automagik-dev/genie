# Genie Hermes Plugin

The Hermes-native surface for Genie orchestration: seven read-only tools, `/genie` slash commands, advisory hooks, a `hermes genie` CLI tree, and workflow skills — all wrapping the genie v5 CLI through an argv-only subprocess bridge. Every payload reports `mutation: "none"`.

## Install

`HERMES_HOME` defaults to `$HOME/.hermes` everywhere below.

```bash
# default: symlink $HERMES_HOME/plugins/genie -> this checkout (edits are live)
plugins/hermes-genie/scripts/install-local.sh

# manual equivalent (from the repo root)
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins" && ln -sfn "$(pwd)/plugins/hermes-genie" "${HERMES_HOME:-$HOME/.hermes}/plugins/genie"

# detached, release-style copy instead of a symlink
plugins/hermes-genie/scripts/install-local.sh --copy
```

## Smoke Test

```bash
plugins/hermes-genie/scripts/smoke.sh
```

Or by hand:

```bash
hermes plugins list | grep -i genie   # authoritative: the plugin is visible to Hermes
hermes chat -q '/genie help'          # command surface (chat visibility may vary by Hermes build)
```

Then, inside a Hermes session:

```text
/genie status
/genie board
/genie help
```

## Tools

All seven tools are read-only — every payload carries `mutation: "none"`.

| Tool | What it does | Mutation |
|------|--------------|----------|
| `genie_status` | Genie installation health (`genie doctor --json`) plus a `.genie/` presence check | none |
| `genie_board` | Planning board (`genie board --json`), optionally scoped to one wish | none |
| `genie_wish_status` | Composite wish status: board slice plus task list for one slug | none |
| `genie_task_list` | Task list with optional wish and status filters | none |
| `genie_task_status` | One task's detail, dependencies, and stage log (raw capture) | none |
| `genie_work_plan` | Execution-plan preview via `genie launch <slug> --dry-run` | none |
| `genie_review_plan` | Board/tasks plus Success and QA Criteria extracted from the wish's WISH.md | none |

The full layer map (slash commands, CLI tree, hooks, skills), payload contract, and grounded tool-to-CLI mapping live in [`references/native-surface.md`](references/native-surface.md).

## Boundary

Hermes is the chat/reasoning cockpit; Genie remains the execution system and source of task truth.

This MVP performs no state writes: no task claims, no dispatch, no sends, no `.genie/` mutation. Mutation-capable operations (`genie_task_checkout`, `genie_task_done`, executing `genie launch`, spawn/send) are deferred and gated behind explicit human approval — see [`references/mutation-gates.md`](references/mutation-gates.md).

## Development

```bash
uv run --with pytest --with pyyaml --no-project python -m pytest plugins/hermes-genie/tests -q
```
