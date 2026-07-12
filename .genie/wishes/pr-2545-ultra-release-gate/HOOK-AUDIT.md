# PR 2545 Codex hook audit

The reviewed PR head defines all nine commands in `plugins/genie/hooks/codex-hooks.json`, selected explicitly by `plugins/genie/.codex-plugin/plugin.json`. The user-facing prompt came from the installed Automagik Genie v5.260710.9 plugin: that older manifest has no explicit `hooks` field, so Codex loads its default `hooks/hooks.json` from the marketplace source/cache, which contains the same nine Codex commands. They are not random workspace hooks.

The original installed source/cache paths were recorded during provenance review but are intentionally omitted from operator documentation. Repository edits do not alter an installed cache. Containment removed the old hook trust after the 2026-07-11 update incident. After the follow-up lands, an explicit `genie setup --codex` or `genie update` must install the new definitions; only then may the user inspect the changed hashes in `/hooks` and start a new task. Codex runs trusted commands on the host, outside the model tool sandbox.

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

## Follow-up evidence (2026-07-11)

| Criterion | Repository evidence | Status |
|-----------|---------------------|--------|
| Exactly H3/H4/H6 | `plugins/genie/hooks/codex-hooks.json`; `src/hooks/__tests__/codex-manifest.test.ts` asserts three events/commands and forbids the six removed targets | Implemented; installed hashes remain untrusted |
| Previous-binary/portable launch | `plugins/genie/scripts/dispatch-runtime.test.ts` covers env-selected wire compatibility, absolute canonical binary selection, POSIX/Windows paths, stdin/stdout, signal forwarding, timeout and SIGKILL | Implemented |
| Malformed/structurally invalid input | `dispatch-runtime.test.ts`, `src/hooks/__tests__/dispatch-command.test.ts`, and `src/hooks/codex-adapter.test.ts` require valid event-specific deny/block JSON | Implemented |
| Canonical inputs/matcher privacy | `src/hooks/codex-adapter.test.ts`, `src/hooks/__tests__/omni-approval.test.ts`, and `src/hooks/__tests__/omni-dispatch.test.ts` cover `apply_patch` command decoding, matcher narrowing, preview caps/redaction, and exactly one Omni invocation | Implemented |
| Timeout/failure/interruption cleanup | `omni-approval.test.ts`, `omni-dispatch.test.ts`, and `codex-manifest.test.ts` couple the 110s poll, 115s child, and 125s host budgets; denial/timeout/SIGTERM cleanup is regression-tested | Implemented |
| H3 bounded/read-only | `plugins/genie/scripts/src/session-context.ts` caps 8 records, 256 KiB per input, and 2 KiB output; manifest tests reject free-form context and lifecycle writes | Implemented |
| Guardrail limitation documented | `README.md`, `plugins/genie/README.md`, and `plugins/genie/references/codex-integration-map.md` state that H4 is incomplete defense in depth and that sandbox/branch protection remain authoritative | Implemented |
| Cold-fork/payload measurement | Starting nine-hook medians were 36.889–49.508 ms per process (panel, 21 runs); retained H3 now measures 19.486 ms median/21.348 ms p95 over 21 local runs. Lifecycle entries fall 9→3, SessionStart forks 3→1, and per-prompt forks 1→0. Product payload: 23 skills + 19 reference files; physical plugin mirror: 64 files / 209,675 logical bytes | Recorded |
| Repository aggregate | Final stable `bun run check`: 1,169 pass, 1 pre-existing skip, 0 fail across 60 files; complexity 2/7 warnings, max 35/42, 0/8 suppressions. Repository-controlled hook/runtime/lifecycle cross-reviews returned SHIP after fixes | PASS locally |
| Outer host startup | The bare-Node hook/MCP startup probe cannot be completed under the current Codex schema. Inner deterministic launcher/MCP fixtures remain green; this is not represented as proof of outer host startup | BLOCKED-UPSTREAM |
| Live trust | Old trust removed during containment. No follow-up hook was trusted or executed from the installed cache; `/hooks` review plus a new task is still a user gate | Pending after release |
