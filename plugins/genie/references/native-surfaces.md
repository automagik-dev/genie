# Native runtime surfaces

Genie skills describe roles and coordination without binding themselves to one client.

- Claude Code dispatches roles with its Agent tool and sends follow-ups with SendMessage.
- Codex dispatches the matching `genie-*` custom subagent and uses native follow-up messaging.
- Every implementation brief carries a `genie task claim` command. A task claim, not the client, owns file scope in a shared workspace.
- Native Codex subagents do not imply separate worktrees. Use `genie launch` when worktree isolation or a human-supervised cockpit is required.
- User decisions use the runtime's native input or permission surface; shared workflows do not hardcode a client-specific tool name.

The role names and lifecycle contracts are stable across clients. Runtime syntax is an adapter detail.
