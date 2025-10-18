# Orchestration Protocols
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Execution patterns governing sequencing and validation:**

**Success criteria:**
✅ TDD: RED → GREEN → REFACTOR enforced for features.
✅ Approval gates explicit in wishes/forge plans.

**Strategic orchestration rules:**
- Orchestrate; don't implement. Delegate to the appropriate agents and collect evidence.
- Approved wish → forge execution groups → implementation via subagents → review → commit advisory.
- Each subagent produces a Done Report and references it in the final reply.

**Done Report:**
- Location: `.genie/wishes/<slug>/reports/done-<agent>-<slug>-<YYYYMMDDHHmm>.md` (UTC).
- Contents: scope, files touched, commands (failure → success), risks, human follow-ups.

---

## Nested Context Isolation: Forge + MCP (CRITICAL PATTERN)

**Purpose:** Enable unlimited parallel work across multiple PRs without context collision

### Two-Tier Isolation Model

**Tier 1: Worktree Isolation (Forge)**
- Each Forge task runs on isolated worktree (`/var/tmp/automagik-forge/worktrees/<task-id>`)
- Worktree has own feature branch (e.g., `feat/agents-optimization`)
- File system isolation prevents cross-task changes
- Level: Filesystem + Git branches

**Tier 2: MCP Session Isolation (Within Worktree)**
- WITHIN each worktree, genies use MCP to spawn fresh agent sessions
- Each MCP session (plan, implementor, tests, genie, review) starts with clean context
- Sub-agents inherit worktree file context but maintain session isolation
- Sessions are stateless and lightweight
- Level: Token context + Agent state

### Implementation Pattern

**Within a Forge task worktree:**

```
Genie on worktree (Task #N)
│
├─ Discovers work that needs specialization
│
├─ Launches MCP session: mcp__genie__run agent="implementor"
│  └─ Implementor runs FRESH with worktree context
│     └─ Makes changes to worktree files
│     └─ Commits to feature branch (worktree-local)
│
├─ Resumes on same worktree
│
├─ Launches MCP session: mcp__genie__run agent="tests"
│  └─ Tests runs FRESH with updated worktree context
│     └─ Verifies changes
│     └─ May commit test updates
│
└─ Repeats for review, polish, etc.
```

### Critical Rules

**✅ DO:**
- Use MCP sessions INSIDE a worktree (fresh context for each agent)
- Switch between different MCP agents within same worktree
- Abandon MCP sessions when done (they're stateless)
- Create PR from worktree feature branch when ready

**❌ DON'T:**
- Reuse same MCP session across multiple worktrees
- Share context between different Forge tasks
- Persist session state between PRs
- Start MCP sessions in wrong worktree

### Why This Enables Parallel Work

**Without isolation:** 10 tasks in same context = cognitive overload + context collision
**With two-tier isolation:**
- 10 worktrees = 10 independent file systems (Forge isolation)
- Each worktree can spawn 10+ MCP sessions = 100+ parallel agents (MCP isolation)
- Zero coordination overhead between tasks
- Each PR reviewed independently by human

### Example: 10 Parallel Forge Tasks

```
Worktree 1: ce4e-wish-agents-opti
  ├─ Branch: feat/agents-optimization
  └─ MCP sessions: implementor, tests, review → PR #1

Worktree 2: edf9-wish-rc21-sessio
  ├─ Branch: feat/rc21-session-lifecycle-fix
  └─ MCP sessions: implementor, tests, debug → PR #2

... (8 more worktrees in parallel) ...

Worktree 10: 334a-triage-incomplet
  ├─ Branch: feat/triage-complete
  └─ MCP sessions: (none needed, already complete) → PR #10
```

All 10 run simultaneously with ZERO context collision.

### Orchestration Rule

**Session State Tracking:**
- Primary unit: Worktree (long-lived, matches Forge task)
- Secondary unit: MCP sessions (ephemeral, created on-demand within worktree)
- State file (SESSION-STATE.md): Track WORKTREES, not MCP sessions

**Migration from old model:**
- OLD: SESSION-STATE.md tracked MCP sessions (short-lived)
- NEW: SESSION-STATE.md tracks Forge tasks/worktrees (long-lived)
- MCP sessions within each task are implementation details

### Scalability Benefit

This pattern enables:
1. **Unlimited parallel work:** No cognitive limit (each task isolated)
2. **Team collaboration:** Multiple developers, each on own Forge task
3. **Distributed execution:** Tasks can run on different machines
4. **Independent review:** Each PR reviewed on its own merit
5. **Zero bottlenecks:** No shared state between tasks

**Critical Insight:** Forge worktree isolation + MCP session isolation = architectural solution to parallel work at scale.
