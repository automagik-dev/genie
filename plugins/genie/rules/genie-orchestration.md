# Genie CLI — Agent Orchestration

Automagik Genie is installed. Load `/genie` to activate full orchestration guidance.

## Essential Commands

```bash
genie team create <name> --repo <path> --wish <slug>  # Launch autonomous team
genie spawn <role>                                     # Spawn agent (engineer, reviewer, qa, fix)
genie send '<msg>' --to <agent>                        # Message cross-session agent
genie status <slug>                                    # Check wish progress
```

## Tool Restrictions

NEVER use `Agent` to spawn agents — use `genie spawn` instead.
NEVER use `TeamCreate` or `TeamDelete` — use `genie team create` / `genie team disband` instead.
