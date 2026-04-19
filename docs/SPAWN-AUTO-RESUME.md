# Spawn Auto-Resume

Auto-resume automatically restores agent sessions when their tmux pane dies unexpectedly (crash, OOM, terminal close). Instead of losing the entire conversation context, Genie detects the dead pane and respawns the agent using its preserved Claude session ID.

> **Canonical-UUID invariant.** Auto-resume is the mechanism that keeps the "one name = one true Claude session UUID" guarantee alive across the canonical agent's lifetime. The invariant itself — plus the single-verb state-gated spawn model, the parallel `<name>-<s4>` convention, and the five-tier team-resolution precedence — lives in [**SPAWN-TEAM-RESOLUTION.md**](SPAWN-TEAM-RESOLUTION.md). Authority trail: wishes `tui-spawn-dx`, `perfect-spawn-hierarchy`, and `fix-ghost-approval-p0` (all archived in `.genie/wishes/_archive/`). **Parallels** (`<name>-<s4>`) are **off** the bare-name auto-resume path described here; they resume only via their full id.

## How It Works

Auto-resume operates at two levels:

### 1. Spawn-time resume (immediate)

When you run `genie spawn <name>`, Genie checks if a dead worker with the same role and team already exists in the registry. If that worker has a saved `claudeSessionId` (Claude provider only), Genie resumes the existing session instead of starting fresh.

```
genie spawn engineer --team my-feature
# If engineer previously crashed:
#   Resuming existing session for "engineer" (session: a1b2c3d4...)
# Otherwise: spawns a new agent as normal
```

This check runs *before* the duplicate-role guard, so a crashed agent doesn't block re-spawning.

**Source:** `src/term-commands/agents.ts` — `findDeadResumable()` and `handleWorkerSpawn()`

### 2. Daemon auto-resume (background)

The scheduler daemon continuously monitors agent health via heartbeats. When it detects consecutive dead heartbeats (default: 2 cycles), it attempts to auto-resume the agent.

The daemon also runs recovery on startup, resuming any agents whose panes died while the daemon was down.

**Source:** `src/lib/scheduler-daemon.ts` — `attemptAgentResume()`, `reconcileOrphans()`, `recoverOnStartup()`

## Session Matching

An agent is eligible for auto-resume when **all** of these are true:

| Condition | Detail |
|-----------|--------|
| Has a `claudeSessionId` | Only Claude provider agents store session IDs. Codex agents cannot be resumed. |
| Pane is dead | The tmux pane (`w.paneId`) no longer exists or was recycled to a different session. |
| State is not `done` | Completed agents are never resumed. |
| `autoResume` is not `false` | Must not have been spawned with `--no-auto-resume`. |

For spawn-time resume specifically, the match also requires the same **role** and **team** as the agent being spawned.

## Resume vs Fresh Spawn

| Scenario | Behavior |
|----------|----------|
| Dead worker with matching role/team and session ID | **Resume** — reattaches to existing Claude session |
| Dead worker with no session ID (e.g., Codex provider) | **Fresh spawn** — starts a new agent |
| No dead worker found | **Fresh spawn** — normal spawn flow |
| Live worker with same role/team | **Rejected** — duplicate role error |
| Agent spawned with `--no-auto-resume` | **Fresh spawn** — daemon won't auto-resume on crash |

## The `--no-auto-resume` Flag

Disables daemon-level auto-resume for this agent. The agent's `autoResume` field is set to `false` in the registry and database.

```bash
# Spawn an agent that won't be auto-resumed on crash
genie spawn engineer --team my-feature --no-auto-resume
```

When auto-resume is disabled:
- The daemon skips the agent during `reconcileOrphans()` cycles
- The agent is marked as permanently failed instead of being retried
- You can still manually resume with `genie resume <name>`

This is useful for one-off tasks or agents you don't want restarting automatically.

## Dead Session Definition

An agent's session is considered "dead" when:

1. **Pane check fails** — `tmux display-message -t '<paneId>'` returns an error, meaning the pane no longer exists.
2. **Pane was recycled** — The pane ID exists but belongs to a different tmux session than the one recorded at spawn time. Genie detects this by comparing `#{session_name}` to the stored session.

In both cases, the worker is treated as dead and eligible for cleanup or resume.

## Resume Budget and Cooldown

The daemon enforces limits to prevent infinite resume loops:

| Parameter | Default | Description |
|-----------|---------|-------------|
| Max resume attempts | 3 | After 3 consecutive failed resumes, the agent is marked permanently failed ("exhausted"). |
| Cooldown | 60 seconds | Minimum time between resume attempts for the same agent. |
| Concurrency cap | `maxConcurrent` config | Resumes are skipped if the active worker count is at the limit. |

Resume attempts and state are tracked in the registry:

```
genie ls
# engineer   working (1/3 resumes, auto-resume: on)   my-feature
```

### Resetting the budget

Use `genie resume <name>` to manually resume an agent. The `genie resume` command does not consume the auto-resume budget — it directly respawns the agent regardless of attempt count.

## Manual Resume

You can manually resume any agent that has a saved Claude session:

```bash
# Resume a specific agent
genie resume engineer

# Resume all eligible agents
genie resume --all
```

Eligible agents for `--all` are those with:
- A saved `claudeSessionId`
- State not `done`
- Dead pane (not currently running)

This includes agents in `suspended`, `error`, `working`, `idle`, or `spawning` states whose panes have died.

## Related Commands

| Command | Description |
|---------|-------------|
| `genie spawn <name>` | Spawns or auto-resumes an agent |
| `genie stop <name>` | Kills pane but preserves session for later resume |
| `genie kill <name>` | Force kills agent (session preserved in registry) |
| `genie resume <name>` | Manually resume a stopped/crashed agent |
| `genie resume --all` | Resume all eligible agents |
| `genie ls` | Shows agent status including resume attempts and auto-resume state |
