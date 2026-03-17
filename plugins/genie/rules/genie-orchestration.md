# Genie CLI — Agent Orchestration Rules

## Team-Lead Lifecycle

The team-lead is the autonomous orchestrator. When launched with `--wish`, it reads the wish plan, hires agents, dispatches work per execution group, runs fix/review loops, and opens a PR — all without human intervention.

**Full lifecycle:**

1. **Create team with wish:** `genie team create <name> --repo <path> --wish <slug>`
   - Creates a git worktree at `~/.genie/worktrees/<project>/<name>/`
   - Validates the wish exists at `.genie/wishes/<slug>/WISH.md`
   - Copies the wish into the worktree
   - Hires default agents (team-lead, engineer, reviewer, qa, fix)
   - Auto-spawns team-lead with wish context
2. **Team-lead executes:** Reads wish → dispatches `genie work` per group → reviews → fix loops → PR
3. **Completion:** `genie team done <name>` (marks done, kills members) or `genie team blocked <name>` (marks blocked, kills members)
4. **Cleanup:** `genie team disband <name>` (kills members, removes worktree, deletes config)

## Communication: SendMessage vs genie send

**Same-session teammates** (spawned with `genie spawn <role>` into your window):
- Use `SendMessage` — Claude Code's native IPC handles it bidirectionally
- These teammates appear as panes in your tmux window
- SendMessage works because you share the same native team

**Cross-session agents** (in different tmux windows or teams):
- Use `genie send '<text>' --to <agent>` — routes via genie's messaging layer
- These agents run in separate windows or were created with `genie team create`

## CLI Commands

### Team (autonomous execution)

```bash
genie team create <name> --repo <path>               # Form team + worktree
genie team create <name> --repo <path> --wish <slug>  # Form team + auto-spawn team-lead with wish
genie team hire <agent>                               # Add agent to team
genie team hire council                               # Hire all 10 council members
genie team fire <agent>                               # Remove agent from team
genie team ls [<name>]                                # List teams or team members
genie team done <name>                                # Mark team done, kill members
genie team blocked <name>                             # Mark team blocked, kill members
genie team disband <name>                             # Kill members, remove worktree, delete config
```

### Dispatch (wish lifecycle)

```bash
genie brainstorm <agent> <slug>       # Spawn agent with brainstorm context
genie wish <agent> <slug>             # Spawn agent with wish design context
genie work <agent> <slug>#<group>     # Check deps, set in_progress, spawn with context
genie review <agent> <slug>#<group>   # Spawn agent with review scope
genie done <slug>#<group>             # Mark group done, unblock dependents
genie reset <slug>#<group>            # Reset in-progress group back to ready
genie status <slug>                   # Show wish group states
```

### Agent lifecycle

```bash
genie spawn <name>                    # Spawn registered agent or built-in role
genie kill <name>                     # Force kill agent
genie stop <name>                     # Stop current run, keep pane alive
genie ls                              # List agents, teams, state
genie history <name>                  # Compressed session timeline
genie read <name>                     # Tail agent pane output
genie answer <name> <choice>          # Answer agent prompt
```

### Messaging

```bash
genie send '<msg>' --to <name>        # Direct message (scoped to own team)
genie broadcast '<msg>'               # Leader to all team members
genie chat '<msg>'                    # Post to team group channel
genie chat read                       # Read team channel history
genie inbox [<name>]                  # View inbox
```

### Agent directory

```bash
genie dir add <name> --dir <path>     # Register agent (--prompt-mode, --model, --roles)
genie dir rm <name>                   # Remove agent from directory
genie dir ls [<name>]                 # List all or show single entry (--builtins)
genie dir edit <name>                 # Update entry fields
```

### Infrastructure

```bash
genie setup                           # Interactive setup wizard
genie doctor                          # Diagnose configuration issues
genie update                          # Update to latest version (--next for dev, --stable for releases)
genie shortcuts show|install|uninstall  # tmux keyboard shortcuts
```

## Tool Restrictions

NEVER use `Agent` to spawn agents — use `genie spawn` instead.
NEVER use `TeamCreate` or `TeamDelete` — use `genie team create` / `genie team disband` instead.
