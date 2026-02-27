# Dispatch Contract

Runtime-specific patterns for dispatching subagents from orchestrator skills (/work, /dream, /review, /fix).

## Runtime Detection

| Signal | Runtime | Dispatch path |
|--------|---------|---------------|
| `Task` tool available with `isolation: "worktree"` | Claude Code | Teams + worktrees |
| Codex environment (`CODEX_ENV` or native subagent API) | Codex | Native subagents |
| Neither above, `term` CLI available | OpenClaw | term → Claude Code → Teams |

Default: **Claude Code**. If detection is ambiguous, use Claude Code path.

## Claude Code

Primary runtime. Fully validated.

```
TeamCreate("work-<slug>")

Task(
  subagent_type: "general-purpose",
  model: "sonnet",
  isolation: "worktree",
  prompt: "<task prompt with acceptance criteria>",
  run_in_background: true
)
```

- **Isolation:** each worker gets a git worktree via `isolation: "worktree"`
- **Model:** `sonnet` for workers (cost/speed balance)
- **Coordination:** `SendMessage` for inter-agent communication within the team
- **Cleanup:** `TeamDelete` after all workers report

### Patterns

| Dispatch need | How |
|---------------|-----|
| Implementation task | `Task` with `isolation: "worktree"`, `model: "sonnet"` |
| Review task | `Task` with `isolation: "worktree"`, `model: "sonnet"` (separate agent from implementor) |
| Quick validation | `Bash` tool directly (no subagent needed) |
| Parallel tasks | Multiple `Task` calls with `run_in_background: true` in one message |

## Codex

Documented for future validation.

```
# Use Codex native subagent API
codex_subagent(
  task: "<task prompt>",
  sandbox: true
)
```

- **Isolation:** Codex-managed sandboxes (automatic)
- **Model:** Codex default
- **Coordination:** Codex response collection

## OpenClaw

Documented for future validation. Three-layer chain: OpenClaw → term → Claude Code → Teams.

```bash
# Spawn a Claude Code instance via term
term spawn --name "worker-<slug>" --model sonnet

# Or for heavy multi-file work with bead tracking
bd create "<task title>" --type task
term work <bead-id>

# Monitor
term workers
term session read <session>
```

- **Isolation:** Claude Code worktrees (same as CC path, initiated via term)
- **Model:** sonnet (passed to CC via term)
- **Coordination:** term status + bead updates
- **Risk:** 3 layers of indirection — use timeouts, fall back to sequential on failure

## Rules

- Orchestrator never executes task work directly — always dispatch
- Reviewer must be a different subagent than the implementor
- Fix and re-review must be separate subagents
- Workers get isolated contexts (worktree/sandbox) — no shared state
- On timeout or failure: mark BLOCKED, continue with next task
