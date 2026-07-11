# Native runtime surfaces

Genie skills describe roles and coordination without binding themselves to one client.

- Claude Code dispatches roles with its Agent tool (`subagent_type: engineer-standard`, ...) and sends follow-ups to a running subagent with SendMessage.
- Codex dispatches the matching `genie_*` custom agent (installed under `~/.codex/agents/`). Follow-up messaging to a running Codex subagent is **undocumented — verify live**: `features.multi_agent` exposes spawn/send/resume/wait/close tools, but their contracts are not in the public Codex docs. If a follow-up surface is unavailable, re-dispatch with curated context instead.
- Every implementation brief opens with the atomic claim `genie task checkout <task-id> --worker <name>`. A task claim, not the client, owns file scope in a shared workspace.
- Native Codex subagents do not imply separate worktrees. Use `genie launch` when worktree isolation or a human-supervised cockpit is required.
- User decisions use the runtime's native input or permission surface; shared workflows do not hardcode a client-specific tool name.

The role names and lifecycle contracts are stable across clients. Runtime syntax is an adapter detail.
