# PR 2545 Codex hook audit

The reviewed PR head defines all nine commands in `plugins/genie/hooks/codex-hooks.json`, selected explicitly by `plugins/genie/.codex-plugin/plugin.json`. The user-facing prompt came from the installed Automagik Genie v5.260710.9 plugin: that older manifest has no explicit `hooks` field, so Codex loads its default `hooks/hooks.json` from the marketplace source/cache, which contains the same nine Codex commands. They are not random workspace hooks.

Installed source: `/Users/feliperosa/.codex/worktrees/79e0/genie`. Installed cache: `/Users/feliperosa/.codex/plugins/cache/automagik/genie/5.260710.9`. Repository edits do not alter that cache. After fixes land, an explicit plugin refresh must install the new definitions; only then may the user inspect the changed hashes in `/hooks` and start a new task. Codex runs trusted commands on the host, outside the model tool sandbox.

| # | Event | Original command | Outside-sandbox behavior/problem | Disposition | Replacement contract | Trust state |
|---|-------|------------------|----------------------------------|-------------|----------------------|-------------|
| H1 | SessionStart | `node ${PLUGIN_ROOT}/scripts/smart-install.js` (60s) | Can install Bun via `curl \| bash`/PowerShell `irm \| iex`, install dependencies, mutate Genie config and tmux files, sync global skills, and spawn update work. | REMOVE from Codex | Explicit `genie install/setup/update` only | Current hash untrusted; removed hash is never trusted |
| H2 | SessionStart | `node ${PLUGIN_ROOT}/scripts/first-run-check.cjs` (5s) | Silently writes `AGENTS.md` into an arbitrary current directory. | REMOVE | Explicit `genie init` | Current hash untrusted; removed |
| H3 | SessionStart | `node ${PLUGIN_ROOT}/scripts/session-context.cjs` (10s) | Injects free-form repository titles/group headings as developer context. | KEEP, rewrite | One bounded run; validated slug/status/counts only; cap records/bytes; no free-form headings | Trust only rewritten hash in a new task |
| H4 | PreToolUse | `env GENIE_HOOK_RUNTIME=codex genie hook dispatch` (15s) | Unix-only launcher; bare PATH dependency; can invoke 110s Omni polling behind a 15s host timeout; PreTool interception is incomplete. | KEEP, narrow | Plugin-local portable launcher; deterministic local guards only; canonical Bash/apply_patch/MCP inputs; no Omni | Trust only rewritten hash; docs call it a guardrail, not branch protection |
| H5 | PreToolUse | `node ${PLUGIN_ROOT}/scripts/validate-wish.cjs` (5s) | Expects `file_path`, but Codex apply_patch uses `tool_input.command`; exit 1 does not block; new files skip. | REMOVE | `wishes:lint` plus independent review/tests | Current hash untrusted; removed |
| H6 | PermissionRequest | `env GENIE_HOOK_RUNTIME=codex genie hook dispatch` (120s) | Direct adapter bypasses registry/tool matcher; may send excluded tool previews remotely; timeout/failure can produce no decision. | KEEP, rewrite | Registry-routed matcher, canonical apply_patch, Omni exactly once, host timeout above poll, deny with reason on failure/interruption | Trust only rewritten hash in a new task |
| H7 | PostToolUse | `node ${PLUGIN_ROOT}/scripts/validate-wish.cjs` (5s) | Runs after side effects and cannot undo them; same input mismatch; reported enforcement is illusory. | REMOVE | Executable QA/review gate | Current hash untrusted; removed |
| H8 | UserPromptSubmit | `node ${PLUGIN_ROOT}/scripts/session-context.cjs` (10s) | Repeats repository-controlled developer-context injection on every prompt and adds a measured cold fork. | REMOVE | SessionStart H3 only | Current hash untrusted; removed |
| H9 | Stop | `node ${PLUGIN_ROOT}/scripts/validate-completion.cjs` (10s) | Emits `{}` and warnings to stderr on exit 0, so Codex receives no continuation; stale `/forge` text. | REMOVE | `$work`/`$genie-review` workflow state and explicit final gate | Current hash untrusted; removed |

## Required retained-hook evidence

- Previous supported Genie binary starts the launcher without unknown-flag or wrong-wire behavior.
- Native Windows/WSL path handling is fixture-tested; stdin/stdout/exit status and signals are preserved.
- Malformed JSON and structurally invalid but parseable envelopes fail closed with valid event-specific JSON.
- PermissionRequest matcher scoping includes canonical `apply_patch`, excludes nonmatching tools, redacts bounded previews, and invokes Omni once.
- Remote denial, timeout, process interruption, and handler crash clear/expire the request and return a documented deny reason.
- PreToolUse never performs remote approval and is documented as incomplete interception; server-side branch protection and sandbox permissions remain the hard controls.
- After install, `/hooks` must show only H3/H4/H6. The user reviews each changed hash, starts a new task, and never uses a trust-bypass flag.
- Group A reports evidence to the PM. Only Group E/PM updates this audit and the disposition ledger, preserving exclusive file ownership.
