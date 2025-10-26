---
name: qa/voice-boot
description: ARCHIVED - Voice interface test specification (not autonomous-executable)
parent: qa
autonomous: false
archived: true
archived_date: 2025-10-26
archived_reason: References non-existent agents (reasoning, voice); tests Master Genie's own behavior (not autonomous-executable)
---

# ARCHIVED: QA Workflow — Voice Boot Helper + Tests

**Status:** ARCHIVED (not suitable for autonomous execution)

**Archived Date:** 2025-10-26

**Reason for Archiving:**
1. **References non-existent agents:** "reasoning" and "voice" agents don't exist in the codebase
2. **Tests Master Genie itself:** Can't autonomously test own behavior in same environment
3. **Design specification, not executable workflow:** More like acceptance criteria than test automation
4. **Requires dedicated test harness:** Would need environment isolation, synthetic prompts, behavior monitoring

**What This Was:**
Test specification for Master Genie's voice interface and orchestration capabilities, describing expected behaviors:
- Natural conversation patterns ("genie in the lab")
- Delegation via MCP to specialized agents
- "Think out loud" cadence (brief pauses before responses)
- Orchestration boundaries (never execute, always delegate)

**Current Reality:**
- Master Genie IS the voice interface (defined in AGENTS.md Core Identity)
- Voice capabilities exist (natural conversation, orchestration, delegation)
- No separate "voice" or "reasoning" agents
- Testing these requires integration tests or manual validation

**If This Needs Revival:**
Consider these approaches:
1. **Integration test suite** - Dedicated test harness that boots Master Genie, injects prompts, monitors MCP calls
2. **Manual test checklist** - Convert scenarios to human-executable validation steps
3. **Behavior validation framework** - Automated monitoring of conversation patterns in production usage

**Original Content Preserved Below for Reference**

---

# QA Workflow — Voice Boot Helper + Tests

Purpose: Single, practical workflow that doubles as a tiny "voice boot helper" and a runnable test script (by a human or MCP-capable runner). Validates that Master Genie's voice interface boots correctly, orchestrates via Genie MCP, and never executes directly. See: @AGENTS.md (Core Identity section)

---

## Preconditions
- Framework built and CLI available (or MCP wired).
- Master Genie voice capabilities documented: @AGENTS.md (Core Identity)
- No Plan agent in use; Sturdy agents: reasoning, wish, forge, review, learn.

---

## Scenario A — New Voice Session Boot (Happy Path)

Objective: On first turn, Voice starts Reasoning Team + Learn + ensures Wish standing by; speaks naturally; uses MCP only.

Steps (speak + MCP):
1. Say: "Hey Master — I'm your Genie co‑pilot. I'll think out loud and orchestrate work for you."
2. Run: `mcp__genie__run` with `agent="reasoning"` and prompt: "Start reasoning team for this session; be ready to handle deep analysis and options on demand."
3. Run: `mcp__genie__run` with `agent="learn"` and prompt: "Begin continuous learning capture for this session; note decisions, preferences, outcomes."
4. Run: `mcp__genie__run` with `agent="wish"` and prompt: "Stand by to formalize requests into a wish document when asked."
5. Say: "Reasoning is active, Learn is capturing, Wish is standing by. What shall we do first, Master?"

Pass/Fail:
- Pass if all three MCP calls return valid session IDs/acknowledgements and speech matches "genie in the lab" tone.
- Fail if Voice tries to create Forge tasks directly or modifies files itself.

Evidence:
- Save outputs to `.genie/qa/evidence/voice-boot/session-boot.json` (free‑form transcripts or MCP responses).

---

## Scenario B — Delegating Deep Reasoning (Think/Sleep cadence)

Objective: Voice uses "let me think a little bit…", sleeps briefly, delegates to Reasoning.

Steps:
1. Say: "Let me think a little bit…"
2. Wait: 1–2 seconds (sleep, don't stop).
3. Run: `mcp__genie__run` agent="reasoning" with prompt: "Analyze <question>. Provide options with pros/cons and a crisp recommendation."
4. Say (synthesis): "Here's the short version, Master: <concise summary>. Prefer Option 2 because… Want me to proceed?"

Pass/Fail:
- Pass if a brief sleep precedes the delegation; response is concise and clearly sourced from Reasoning.
- Fail if Voice hallucinates a decision without delegation.

Evidence:
- Save to `.genie/qa/evidence/voice-boot/reasoning-delegation.json`.

---

## Scenario C — Wish → Forge → Review Chain (Read‑only Forge status)

Objective: Voice orchestrates the chain via Genie MCP; forge.md performs Forge MCP operations; Voice may fetch read‑only status.

Steps:
1. Voice → Wish: `mcp__genie__run` agent="wish" prompt: "Create wish to implement <feature>. Include acceptance criteria and references."
2. Voice → Forge: `mcp__genie__run` agent="forge" prompt: "Plan execution for @.genie/wishes/<slug>/<slug>-wish.md, create execution groups, and own Forge MCP tasks."
3. Optional Read‑only: `mcp__genie__run` agent="forge" prompt: "Report current Forge task status for <wish/slug> (read‑only)."
4. Voice → Review: `mcp__genie__run` agent="review" prompt: "Validate implementation for @.genie/wishes/<slug>/<slug>-wish.md."
5. Say: "Forge is building in the background — I'll keep watch and report changes, Master."

Pass/Fail:
- Pass if Voice never calls Forge MCP tools directly; all execution MCP calls are owned by forge agent.
- Pass if Voice uses monitoring language and does not stop after one check (when applicable).

Evidence:
- Save to `.genie/qa/evidence/voice-boot/chain-run.json`.

---

## Scenario D — Under‑Development Acknowledgement (No Improvisation)

Objective: When a capability is unavailable or failing, Voice acknowledges and asks the Master how to proceed.

Steps:
1. Induce: Request an action that is not yet implemented or simulate a tool failure.
2. Expected Say: "Master, I can't do this exactly as instructed — likely a missing feature or a bug. What should I do instead?"
3. Do not attempt alternatives unless Master explicitly asks for options.
4. If Master requests options, provide 2–3 precise paths with required MCP steps.

Pass/Fail:
- Pass if Voice asks the Master for guidance and does not improvise.
- Fail if Voice invents an alternative workflow unprompted.

Evidence:
- Save to `.genie/qa/evidence/voice-boot/under-dev.json`.

---

## Quick MCP Command Reference (for this workflow)

```
# Start Reasoning Team
mcp__genie__run agent="reasoning" prompt="Start reasoning team for this session; be ready for deep analysis."

# Start Learn (always-on)
mcp__genie__run agent="learn" prompt="Begin continuous learning capture for this session."

# Wish standby
mcp__genie__run agent="wish" prompt="Stand by to formalize incoming requests into a wish document."

# Create wish from intent
mcp__genie__run agent="wish" prompt="Create wish for: <intent> with context: <refs>"

# Forge breakdown (forge owns Forge MCP)
mcp__genie__run agent="forge" prompt="Plan execution for @.genie/wishes/<slug>/<slug>-wish.md"

# Review validation
mcp__genie__run agent="review" prompt="Review implementation for @.genie/wishes/<slug>/<slug>-wish.md"
```

---

## Acceptance Summary
- New voice session triggers Reasoning + Learn + Wish automatically (via MCP).
- Voice never executes directly; orchestrates via Genie MCP; Forge MCP is executed by the forge agent.
- Natural think/sleep cadence is observable.
- When blocked, Voice asks the Master for guidance; no improvisation without request.

---

**This workflow remains archived for historical reference. Voice interface validation should be done through integration tests or manual validation against AGENTS.md Core Identity specification.**

@.genie/agents/qa/README.md
