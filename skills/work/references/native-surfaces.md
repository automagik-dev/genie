# Native runtime surfaces

Genie skills describe roles and coordination without inventing a cross-client tool API.

| Runtime | Dispatch | Isolation | Follow-up |
|---------|----------|-----------|-----------|
| Claude Code | Use its current native Agent surface and an available named role | Use the runtime's supported isolation/worktree option when present | Use the runtime's documented messaging surface when available; otherwise re-dispatch with curated context |
| Codex | Use the matching `genie_*` custom agent when the CLI-installed profiles are present; otherwise use an available generic subagent | Native subagents share the caller's workspace by default | Use the active native follow-up tool exposed in the session; do not hardcode an undocumented function name into a skill |
| Warp cockpit | `genie launch <slug>` emits one pane per ready group | Dedicated Git worktree per pane | Human-supervised; panes are not awaitable native subagents |

Every implementation brief opens with the atomic claim:

```bash
genie task checkout <task-id> --worker <name>
```

The claim owns file scope in a shared workspace. Engineers and fixers report completion but never call `genie task done`. A different reviewer validates the group; only the orchestrator marks it done after a SHIP verdict and passing evidence. Native client completion notifications replace polling.

User decisions use the runtime's native input or permission surface. Shared workflows name the semantic action—dispatch, follow up, interrupt, wait—while the active client supplies the concrete tool.
