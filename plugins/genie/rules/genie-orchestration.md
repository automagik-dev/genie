# Genie CLI — Agent Orchestration Rules

## Communication: SendMessage vs genie send

**Same-session teammates** (spawned with `genie spawn <role>` into your window):
- Use `SendMessage` — Claude Code's native IPC handles it bidirectionally
- These teammates appear as panes in your tmux window
- SendMessage works because you share the same native team

**Cross-session agents** (in different tmux windows or teams):
- Use `genie send '<text>' --to <agent>` — routes via genie's messaging layer
- These agents run in separate windows or were created with `genie team create`

## CLI Commands

```bash
genie spawn <role>          # Spawn agent (engineer, reviewer, qa, fix, refactor)
genie kill <name>           # Force kill agent
genie stop <name>           # Graceful stop
genie ls                    # List agents
genie send '<text>' --to <agent>  # Message agent (cross-session)
genie broadcast '<text>'    # Broadcast to all
genie team create|hire|fire|ls|disband|done|blocked  # Team management
genie work <agent> <ref>    # Dispatch work
genie done <ref>            # Mark done
genie status <slug>         # Check status
```

## Tool Restrictions

NEVER use `Agent` to spawn agents — use `genie spawn` instead.
NEVER use `TeamCreate` or `TeamDelete` — use `genie team create` / `genie team disband` instead.
