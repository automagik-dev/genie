# Genie CLI — Agent Orchestration

Automagik Genie is installed. Load `/genie` to activate full orchestration guidance.

## Essential Commands

```bash
genie team create <name> --repo <path> --wish <slug>  # Launch autonomous team
genie spawn <role>                                     # Spawn agent (engineer, reviewer, qa, fix)
genie send '<msg>' --to <agent>                        # Message cross-session agent
genie wish status <slug>                               # Check wish progress
genie events list --since 5m                           # Recent structured events
genie events timeline <entity-id>                      # Full entity event history
genie ls --json                                        # Agent state from PG
```

## Tool Restrictions

NEVER use `Agent` to spawn agents — use `genie spawn` instead.
NEVER use `TeamCreate` or `TeamDelete` — use `genie team create` / `genie team disband` instead.

## Spawn Session Rule

NEVER pass `--session <team-name>` to `genie spawn`. The team config already stores the correct `tmuxSessionName` (resolved at team creation from the parent session). Passing `--session` overrides this and creates a separate tmux session, breaking the topology.

```bash
# WRONG — creates separate session
genie spawn reviewer --team my-team --session my-team

# CORRECT — uses team's configured session
genie spawn reviewer --team my-team
```

The `--session` flag is for rare manual overrides only. When `--team` is set, let genie resolve the session from the team config.

## Post-Dispatch Monitoring

After `genie team create` or `genie spawn`, use ONLY structured primitives. A hook enforces this automatically.

### DO — Structured monitoring
| Need | Command |
|------|---------|
| Wish progress | `genie wish status <slug>` |
| Worker state | `genie ls --json` |
| Send instructions | `genie send '<msg>' --to <agent>` |
| Event timeline | `genie events timeline <id>` |
| Error patterns | `genie events errors` |

### NEVER — Terminal scraping
- `tmux capture-pane` to check worker progress (BLOCKED by hook)
- `sleep` + poll loops to watch terminal output (BLOCKED by hook)
- Raw terminal text parsing for workflow decisions

### Post-dispatch flow
1. **Dispatch** — `genie team create` or `genie spawn`
2. **Trust** — workers execute autonomously, report via PG events
3. **Check** — `genie wish status <slug>` for progress
4. **Communicate** — `genie send` for instructions
5. **Review** — when workers report done, review output
