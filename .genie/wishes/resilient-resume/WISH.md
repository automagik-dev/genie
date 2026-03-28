# Wish: resilient-resume

**Status:** SHIPPED
**Issues:** #741, #744
**Priority:** P1

## Problem

When agents crash during multi-team execution, `genie resume` returns them to the existing Claude Code session but with no context about what they were doing. The agent has conversation history from `--resume` but no structured prompt telling it "you were working on wish X, group Y, here's the state." Meanwhile, the auto-resume path (template-based respawn) DOES inject context via `injectResumeContext()` but manual `genie resume` does not.

## Solution

Wire `injectResumeContext()` into the manual resume path (`resumeAgent` in agents.ts). After the agent's pane is created with `--resume <sessionId>`, deliver a structured resume context message via native inbox so the agent receives it as its next user turn in the existing session.

## Scope

**IN:**
- `resumeAgent()` calls `injectResumeContext()` after pane creation
- Resume context includes: wish slug, group status, group section from WISH.md, git log, git status (uncommitted work)
- `injectResumeContext()` enhanced with git status (files changed but not committed)
- Both manual (`genie resume`) and auto-resume paths deliver context consistently

**OUT:**
- Crash prevention (not our layer — Claude Code manages its own sessions)
- New auto-resume trigger mechanisms
- Changes to the Claude Code `--resume` flag behavior

## Acceptance Criteria

1. `resumeAgent()` calls `injectResumeContext()` after pane creation and registry update
2. `injectResumeContext()` includes `git status --short` output alongside git log
3. Resumed agent receives a native inbox message with wish/group context within 10s
4. The resumed agent continues in its EXISTING session (--resume), not a fresh session
5. Tests pass (`bun test`)
6. Manual test: kill an engineer pane mid-work, run `genie resume <name>`, verify it gets context message

## Execution Strategy

### Wave 1 (single group — small scoped fix)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Wire injectResumeContext into resumeAgent + enhance with git status |

## Execution Groups

### Group 1: Wire resume context into manual resume path

**Files to modify:**
- `src/term-commands/agents.ts` — `resumeAgent()` function (~line 1183)
- `src/lib/protocol-router-spawn.ts` — `injectResumeContext()` function (~line 237)

**Changes:**

1. **`resumeAgent()` in agents.ts (~line 1251):** After `notifySpawnJoin(ctx, paneId)` and registry update, call `injectResumeContext`:
```typescript
// Import at top of file
import { injectResumeContext } from '../lib/protocol-router-spawn.js';

// After notifySpawnJoin (line ~1251)
await injectResumeContext(ctx.cwd ?? process.cwd(), agent.id, agent.role ?? agent.id, params.team);
```

2. **`injectResumeContext()` in protocol-router-spawn.ts:** Add git status to the resume prompt:
```typescript
// After getRecentGitLog, add:
const gitStatus = await getGitStatus(repoPath);

// In the prompt array, add:
gitStatus ? `Uncommitted changes:\n${gitStatus}` : '',
```

Add helper:
```typescript
async function getGitStatus(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git -C '${repoPath}' status --short 2>/dev/null`);
    return stdout.trim();
  } catch {
    return '';
  }
}
```

3. **Export `injectResumeContext`** from protocol-router-spawn.ts if not already exported.

**Validation:** `bun test`
