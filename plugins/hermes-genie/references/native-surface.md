# Native Surface Reference

What the Genie Hermes plugin exposes, layer by layer, and the exact contract every layer honors. Grounded against the genie v5 CLI (flag surface verified 2026-07-04 and pinned by the plugin's contract tests; re-verify with `genie --help` after major CLI updates).

## Layer map

| Layer | Provides | Declared in `plugin.yaml` |
|-------|----------|---------------------------|
| Tools (default) | `genie_status`, `genie_work_plan`, `genie_review_plan` — read-only native tools backed by standalone Genie CLI JSON | `provides_tools` |
| Retired tools | Historical duplicate board/task native tools cannot be restored by configuration or environment flags | not declared |
| Slash commands | `/genie` dispatcher (`status`, `board`, `wish`, `work-plan`, `review-plan`, `help`) plus thin wrappers `/genie-board`, `/genie-wish`, `/genie-work-plan`, `/genie-review-plan` | `provides_commands` |
| CLI tree | `hermes genie` with subcommands `status`, `board`, `wish`, `work-plan`, `review-plan` | `provides_cli_commands` |
| Hooks | `on_session_start`, `pre_tool_call`, `pre_llm_call` | `provides_hooks` |
| Skills | `genie` (one thin cockpit pointer) | `provides_skills` |

Layer semantics:

- **Slash commands** — `/genie <subcommand>` gives outcome-first, human-readable output; an unknown subcommand answers with a pointer to `/genie help`. The `/genie-*` wrappers are aliases into the same dispatcher and read through the plugin-local standalone CLI bridge.
- **CLI tree** — registered only when the Hermes build exposes `register_cli_command`. Registration of CLI commands, skills, and hooks is `hasattr`-guarded, so `register(ctx)` completes cleanly on builds that lack any of them.
- **Hooks** — advisory only, never blocking. `on_session_start` injects a short reminder when the working directory contains `.genie/`; `pre_tool_call` raises an advisory when a terminal command scrapes or sleep-polls Genie state (e.g. `tmux capture-pane`) instead of using the structured tools; `pre_llm_call` injects bounded Genie session context when the working directory contains `.genie/` and returns `None` (no injection) otherwise. All report `mutation: "none"`.
- **Skills** — a single thin cockpit pointer (`genie`) that routes to first-class product `wish`/`work`/`review` skills and standalone board/task commands. The former plugin-local duplicates are retired.

## Payload contract

Every tool returns a JSON string with one uniform envelope:

```json
{
  "success": true,
  "mutation": "none",
  "cwd": "/abs/path/to/workspace",
  "command": ["genie", "board", "--json"],
  "data": { "...": "..." },
  "parsed": true
}
```

| Field | Meaning |
|-------|---------|
| `success` | The genie subprocess exited 0. Composite tools AND their legs together. |
| `mutation` | Always `"none"` in this MVP — see [`mutation-gates.md`](mutation-gates.md). |
| `cwd` | Resolved absolute working directory the command ran in. |
| `command` \| `source` | Provenance. `command` is the argv list actually executed (composite tools carry a list of leg argvs). When no subprocess ran, `source` names the origin instead: `"input-validation"` for rejected references, or the WISH.md path in `genie_review_plan`. |
| `data` \| `error` | `data` carries the result; `error` carries stderr, the exception, or the validation message. Payloads can carry both — e.g. a nonzero-exit run (captured output + stderr error) or `genie_review_plan` (board/tasks data plus a wish-file error). |
| `parsed` | Set by the CLI bridge on every subprocess payload. `true`: stdout began with `{` or `[` and `json.loads` succeeded, so `data` is the decoded JSON. `false`: raw fallback — `data` is `{"stdout", "stderr", "returncode"}`. Composite tools carry `parsed` inside each leg under `data`, not at the top level. |

## Tool → CLI mapping (grounded)

| Tool | Genie CLI invocation | Notes |
|------|----------------------|-------|
| `genie_status` | `genie doctor --json` | gap tool (default). `data` wraps the doctor report as `data.doctor` plus `data.genie_dir` / `data.genie_dir_present` for the resolved cwd |
| `genie_work_plan` | `genie context --wish <slug> --plan [--group <g>]` | gap tool (default). Plan mode prints the versioned spawn-context payload (branch + base SHA + ready tasks, raw JSON capture) without touching anything |
| `genie_review_plan` | board + task-list composite, then reads `.genie/wishes/<slug>/WISH.md` | gap tool (default). Extracts the `## Success Criteria` and `## QA Criteria` sections into `data.criteria`; `source` is the wish-file path |
| `genie_board` | `genie board --json [--wish <slug>]` | retired duplicate native name; use the standalone command directly |
| `genie_wish_status` | `genie board --wish <slug> --json` + `genie task list --wish <slug> --json` | retired duplicate native name |
| `genie_task_list` | `genie task list --json [--wish <slug>] [--status <status>]` | retired duplicate native name |
| `genie_task_status` | `genie task status <id>` | retired duplicate native name |

## Input safety

- References (`slug`, `wish`, `id`, `status`, `group`) must match `[A-Za-z0-9][A-Za-z0-9._-]*` — no leading dash (option injection), no path separators, no `..` (traversal). Invalid input returns an error payload with `source: "input-validation"`; no subprocess runs.
- The subprocess bridge executes argv lists only — never a shell string — and rejects any argument containing `;`, `&&`, `||`, backticks, `$(`, or newlines.
- Subprocess calls run with a 30-second default timeout; every failure (timeout, missing binary, nonzero exit) becomes an error payload, never an uncaught exception.
- `genie_review_plan` refuses to follow a resolved wish path that escapes `.genie/wishes/` (symlink defense in depth on top of reference validation).
