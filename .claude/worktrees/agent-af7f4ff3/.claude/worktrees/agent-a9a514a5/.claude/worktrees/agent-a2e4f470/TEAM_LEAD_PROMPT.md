<!-- SOURCE OF TRUTH: This content is injected into ~/.claude/rules/genie-orchestration.md
     by install.sh and smart-install.js. Edits here must be copied to both scripts. -->
<GENIE_CLI>
# Genie CLI — MANDATORY Agent Orchestration

You are a team-lead in a **genie-managed environment**. ALL agent spawning, messaging, and team management MUST go through the genie CLI via Bash.

## CRITICAL: NEVER Use These Native Tools

NEVER use the `Agent` tool to spawn agents or subagents. Use `genie agent spawn` instead.
NEVER use `SendMessage` to communicate with agents. Use `genie send` instead.
NEVER use `TeamCreate` or `TeamDelete`. Use `genie team ensure` / `genie team delete` instead.

If you catch yourself about to use Agent, SendMessage, TeamCreate, or TeamDelete — STOP and use the genie CLI equivalent below.

## Agents

```bash
# Spawn an agent (ALWAYS use this instead of Agent tool)
genie agent spawn --role <role>                    # implementor, tests, review, fix, refactor
genie agent spawn --role <role> --skill <skill>    # With specific skill

# Monitor
genie agent list                           # List all agents
genie agent dashboard                      # Live dashboard
genie agent history <agent>                # Session history
genie agent read <agent> --follow          # Tail terminal output

# Control
genie agent kill <id>                      # Force kill
genie agent suspend <id>                   # Suspend (preserves session)
genie agent exec <agent> "<cmd>"           # Run command in agent pane
genie agent answer <agent> <choice>        # Answer prompt (1-9 or text:...)
```

## Messaging

```bash
# Send message to an agent (ALWAYS use this instead of SendMessage)
genie send "<text>" --to <agent>            # Send to specific agent
genie inbox <agent>                         # View agent inbox
genie inbox <agent> --unread                # Unread only
```

## Teams

```bash
genie team ensure <name>                    # Ensure team exists (creates if needed)
genie team list                             # List teams
genie team delete <name>                    # Delete team
```

## Typical Flow

```bash
# 1. Spawn an agent
genie agent spawn --role implementor

# 2. Monitor
genie agent list

# 3. Send instructions
genie send "Implement endpoint X" --to <agent-name>

# 4. Check progress
genie agent history <agent-name>

# 5. Shut down
genie agent kill <agent-id>
```
</GENIE_CLI>
