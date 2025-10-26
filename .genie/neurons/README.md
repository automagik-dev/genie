# Neurons • Master Orchestrators

**Neurons** are persistent master orchestrators that live in Forge and coordinate work across domains. Unlike regular agents, neurons:

- **Persist indefinitely** (survive MCP server restarts)
- **Live in Forge worktrees** (`/var/tmp/automagik-forge/worktrees/`)
- **Have read-only filesystems** (can only read, delegate, coordinate)
- **Reuse across sessions** (ONE neuron per type per project)
- **Use Claude Haiku** (fast, efficient orchestration)

## Available Neurons

| Neuron | File | MCP Tool | Purpose |
|--------|------|----------|---------|
| **Wish Master** | `neuron-wish.md` | `create_wish` | Coordinates wish authoring |
| **Forge Master** | `neuron-forge.md` | `run_forge` | Coordinates execution |
| **Review Master** | `neuron-review.md` | `run_review` | Coordinates validation |

## When to Use Neurons

✅ **Use neurons for:**
- Persistent coordination that spans multiple sessions
- Work that requires maintaining state across disconnects
- Delegating to domain-specific executors
- Managing complex multi-step workflows

❌ **Don't use neurons for:**
- Direct implementation (use regular agents instead)
- One-off tasks that don't need persistence
- File modifications (neurons are read-only)

## Architecture

```
MCP Client (Claude Code)
    ↓ calls create_wish()
SessionManager
    ↓ queries Forge SQLite
Existing Neuron? → YES → followUpTaskAttempt()
                → NO  → createAndStartTask(variant: 'wish')
    ↓
Neuron Master (Haiku)
    ↓ delegates via mcp__genie__run
Domain Executor (e.g., create/wish)
    ↓ implements
Actual Work Done
```

## Discovery

Neurons are **automatically discovered** by:
1. MCP server scans `.genie/neurons/*.md` on startup
2. Creates executor profiles for each neuron
3. Syncs to Forge backend
4. Available as executor variants: `CLAUDE_CODE:neuron-wish`

## Executor Configuration

All neurons use:
```yaml
genie:
  executor: CLAUDE_CODE
  model: haiku      # Fast, efficient for orchestration
  background: true  # Runs in Forge worktree
```

## Self-Awareness

Neurons can detect their role:
```bash
# Branch name pattern
git branch --show-current
# → forge/XXXX-wish-description

# Role detection
if [[ $branch =~ ^forge/[0-9a-f]+-(\w+)- ]]; then
  role="${BASH_REMATCH[1]}-master"
fi
```

## Neuron Behavior

### Persistence
- Task stored in Forge SQLite (`~/.local/share/automagik-forge/db.sqlite`)
- Status: `agent` (hidden from main Kanban)
- Parent: None (masters are top-level)

### Reconnection
When MCP tool called again:
1. Query existing neuron by: `status='agent' && executor.includes(':neuron-wish') && !parent_task_attempt`
2. If found: Send follow-up via `continue_task` tool
3. If not: Create new neuron

### Read-Only Filesystem
Neurons cannot modify files. Instead:
```typescript
// ❌ NOT ALLOWED
fs.writeFileSync('wish.md', content);

// ✅ ALLOWED
mcp__genie__create_subtask(
  parent_attempt_id: myAttemptId,
  title: "Create wish document",
  prompt: "Write wish to .genie/wishes/...",
  executor: "CLAUDE_CODE:DEFAULT"  // Subtask CAN write
);
```

## vs Regular Agents

| Feature | Regular Agents | Neurons |
|---------|---------------|---------|
| **Persistence** | Session-scoped | Forever |
| **Filesystem** | Read/write | Read-only |
| **Invocation** | `genie run <agent>` | MCP tools |
| **Storage** | sessions.json | Forge SQLite |
| **Delegation** | Optional | **Required** |
| **Executor** | Various | Haiku (all) |
| **Location** | `.genie/agents/` or collective | `.genie/neurons/` |

## Adding New Neurons

1. Create `.genie/neurons/neuron-<name>.md`
2. Add frontmatter with `model: haiku`
3. Define delegation strategy
4. Document read-only constraints
5. Restart MCP server (auto-discovers new neuron)
6. Create corresponding MCP tool if needed

## Legacy Cleanup

**OLD terminology** (deprecated):
- "neurons" folder in old migrations → Now "agents"
- "neuron" as synonym for "agent" → Now separate concept

**NEW terminology** (current):
- **Agent** = Executable unit (regular agents in `.genie/agents/`)
- **Neuron** = Persistent master orchestrator (`.genie/neurons/`)
- **Master** = Synonym for neuron orchestrator

## Related Documentation

- **MCP Tools**: `.genie/mcp/src/tools/` (create_wish, run_forge, run_review, continue_task, create_subtask)
- **Session Manager**: `.genie/mcp/src/lib/session-manager.ts` (Forge-backed persistence)
- **Role Detection**: `.genie/mcp/src/lib/role-detector.ts` (Branch pattern matching)
- **CORE_AGENTS.md**: Global agent documentation (includes neuron references)
