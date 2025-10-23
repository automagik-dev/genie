# MCP Quick Reference
**Entry Point:**
- ❌ NEVER use `./genie` (doesn't exist since v2.4.0)
- ✅ ALWAYS use `npx automagik-genie` for CLI operations

**Version Self-Awareness:**
- MCP displays version in all outputs: `Genie MCP v{version}` ✅
- Helps with debugging: "Is my MCP latest?" or "I prefer to stay on X version"

**MCP Tools (14 total):**

**Agent Orchestration:**
```
# List available agents
mcp__genie__list_agents

# Start a Genie Flow (built-in agents)
mcp__genie__run with agent="plan" and prompt="[Discovery] … [Implementation] … [Verification] …"

# Start a Core/Specialized Agent
mcp__genie__run with agent="forge" and prompt="[Discovery] … [Implementation] … [Verification] …"

# Inspect runs and view logs
mcp__genie__list_sessions
mcp__genie__view with sessionId="<session-id>" and full=false  # Use full=true only when complete history needed

# Continue a specific run by session id
mcp__genie__resume with sessionId="<session-id>" and prompt="Follow-up …"

# Stop a session
mcp__genie__stop with sessionId="<session-id>"
```

**Knowledge Discovery:**
```
# List available spells (reusable knowledge patterns)
mcp__genie__list_spells with scope="all" | "global" | "code" | "create"
mcp__genie__read_spell with spell_path="spells/learn.md"

# List available wishes (planned features/work)
mcp__genie__list_wishes with status="all" | "active" | "archived"
mcp__genie__read_wish with wish_path="wishes/stable-launch-preparation.md"

# List available workflows (wish, forge, review, install)
mcp__genie__list_workflows with collective="all" | "code" | "create"
mcp__genie__read_workflow with workflow_path="code/workflows/wish.md"
```

**Workspace Context:**
```
# Get workspace info (mission, tech stack, roadmap, environment)
mcp__genie__get_workspace_info
```

## Conversations & Resume

`mcp__genie__resume` enables continuous conversation with agents for multi-turn tasks.

- Start a session: `mcp__genie__run` with agent and prompt
- Resume the session: `mcp__genie__resume` with sessionId and prompt
- Inspect context: `mcp__genie__view` with sessionId and full=false (default; use full=true only when complete history needed)
- Discover sessions: `mcp__genie__list_sessions`

Guidance:
- Treat each session as a thread with memory; use `resume` for follow‑ups instead of starting new `run`s.
- Keep work per session focused (one wish/feature/bug) for clean transcripts and easier review.
- When scope changes significantly, start a new `run` and reference the prior session in your prompt.

**Polling Pattern:**
- After `mcp__genie__run`, either (1) do parallel work OR (2) wait ≥60 seconds before first view
- Increase wait intervals adaptively: 60s → 120s → 300s → 1200s for complex tasks
- Prefer parallel work over polling when possible

## Subagents & Genie via MCP

- Start subagent: `mcp__genie__run` with agent and prompt parameters
- Resume session: `mcp__genie__resume` with sessionId and prompt parameters
- List sessions: `mcp__genie__list_sessions`
- Stop session: `mcp__genie__stop` with sessionId parameter

Genie prompt patterns (run through any agent, typically `plan`):
- Genie Planning: "Act as an independent architect. Pressure-test this plan. Deliver 3 risks, 3 missing validations, 3 refinements. Finish with Genie Verdict + confidence."
- Consensus Loop: "Challenge my conclusion. Provide counterpoints, evidence, and a recommendation. Finish with Genie Verdict + confidence."
- Focused Deep-Dive: "Investigate <topic>. Provide findings, affected files, follow-ups."
