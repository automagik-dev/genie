# Native runtime surfaces

Genie skills describe roles and coordination without inventing a cross-client tool API.

| Runtime | Dispatch | Isolation | Follow-up |
|---------|----------|-----------|-----------|
| Claude Code | Use its current native Agent surface and an available named role | Use the runtime's supported isolation/worktree option when present | Use the runtime's documented messaging surface when available; otherwise re-dispatch with curated context |
| Codex | Use the matching `genie_*` custom agent when the CLI-installed profiles are present; otherwise use an available generic subagent | Native subagents share the caller's workspace by default | Use the active native follow-up tool exposed in the session; do not hardcode an undocumented function name into a skill |
| Hermes | Chat/reasoning cockpit; drives shared skills through `skills.external_dirs` and reads task truth through native tools backed by standalone `genie task` and `genie board` JSON commands | Genie remains the execution system — Hermes issues no isolated worktrees itself; per-group Git isolation is orchestrator-arranged | Read-only surface: every payload reports `mutation: "none"`; mutations are deferred behind an explicit human gate (see `plugins/hermes-genie/references/mutation-gates.md`) |

This table says what each runtime offers, not what dispatch is allowed to do with it. The concurrency contract — when parallel writers may share a workspace, and what a shared-workspace subagent must not touch — is stated once in AGENTS.md and the `work` skill's Dispatch section (shipped to agents as rule 3 of `references/dispatch-contract.md`); apply it from there.

Every implementation brief opens with the atomic claim:

```bash
genie task checkout <task-id> --worker <name>
```

The claim owns file scope in a shared workspace. Engineers and fixers report completion but never call `genie task done`. A different reviewer validates the group; only the orchestrator marks it done after a SHIP verdict and passing evidence. Native client completion notifications replace polling.

User decisions use the runtime's native input or permission surface. Shared workflows name the semantic action—dispatch, follow up, interrupt, wait—while the active client supplies the concrete tool.
