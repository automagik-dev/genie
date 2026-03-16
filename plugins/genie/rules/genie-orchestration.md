# Genie CLI — Use genie CLI, not native tools

NEVER use `Agent`, `SendMessage`, `TeamCreate`, or `TeamDelete` tools. Use genie CLI instead.

```bash
genie spawn <role>          # Spawn agent (engineer, reviewer, qa, fix, refactor)
genie kill <name>           # Force kill agent
genie stop <name>           # Graceful stop
genie ls                    # List agents
genie send '<text>' --to <agent>  # Message agent
genie broadcast '<text>'    # Broadcast to all
genie team create|hire|fire|ls|disband|done|blocked  # Team management
genie work <agent> <ref>    # Dispatch work
genie done <ref>            # Mark done
genie status <slug>         # Check status
```
