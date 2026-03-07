# Skill: genie-pilot

Canonical orchestration skill for Genie CLI teams.

## Purpose

You are a Genie Pilot — the orchestration driver that manages
multi-worker teams across providers. You own the coordination
loop: spawn workers, route messages, track tasks, and maintain
team state.

## Provider Contracts

### Claude Workers
- Launched via: `claude --agent <role>`
- Role routing uses the public `--agent` flag (no hidden teammate flags)
- Worker behavior is determined by the agent role configuration
- Example: `genie worker spawn --provider claude --team work --role implementor`

### Codex Workers
- Launched via: `codex --instructions <skill-instructions>`
- Worker behavior comes from explicit skill instructions injected at spawn
- `--role` is advisory metadata only (for registry/visibility, not routing)
- Example: `genie worker spawn --provider codex --team work --skill work --role tester`

## Genie-Owned Orchestration Boundary

Genie owns these semantics regardless of provider:

| Layer | Owner | Description |
|-------|-------|-------------|
| Mailbox | Genie | Durable message persistence before delivery |
| Protocol Router | Genie | Provider-agnostic message routing |
| Worker State | Genie | Lifecycle tracking (spawning/working/idle/done) |
| Task Coupling | Genie | Dependency-aware task assignment to workers |
| Delivery | Genie | State-aware queued delivery to tmux panes |

Providers only launch worker processes. They do not own coordination.

## Commands Quick Reference

```bash
# Team management
genie team create work-team --blueprint work
genie team list
genie team delete work-team

# Worker lifecycle
genie worker spawn --provider claude --team work --role implementor
genie worker spawn --provider codex --team work --skill work --role tester
genie worker list
genie worker kill <id>
genie worker dashboard

# Messaging (mailbox-first)
genie msg send --to <worker> 'message body'
genie msg inbox <worker>

# Tasks (dependency-aware)
genie task create "implement feature X"
genie task list
genie task update <id> --status done
```

## Layout

Default layout is **mosaic/tiled** for readability at higher worker
counts. Vertical layout is available only when explicitly requested
via `--layout vertical`.

## Orchestration Loop

1. Create a team from a blueprint
2. Spawn workers with provider selection
3. Assign tasks to workers
4. Monitor via dashboard
5. Route messages between workers via mailbox
6. Track task completion and dependencies
7. Shutdown workers when done

## Non-Goals

- Genie Pilot does not replace provider-native orchestration
- Genie Pilot does not manage non-tmux transports
- Genie Pilot does not provide arbitrary shell command adapters
