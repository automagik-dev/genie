<!--
Triad Validation Metadata
last_updated: 2025-10-17T01:04:00Z
active_tasks: 0
completed_tasks: 0
validation_commands:
  has_priority_sections: grep -q "## 🔥 CRITICAL Priority" .genie/TODO.md && grep -q "## ⚠️ HIGH Priority" .genie/TODO.md
  completed_marked: test $(grep -c "✅ COMPLETE" .genie/TODO.md) -ge 0
  has_effort_tracking: grep -q "## 📊 Effort Tracking" .genie/TODO.md
-->

# 🎯 Genie Development TODO
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Context:** Prioritized work queue for Genie framework

---

## 🔥 CRITICAL Priority (Do First)

- Voice Agent v1 — Spec & Orchestration Contract
  - Define `voice` agent spec (identity, tone, constraints, protocol)
  - Orchestrates via Genie MCP only; never executes directly
  - Session start protocol: immediately spin up Reasoning Team; Keep Learn + Wish active
  - Uses Wish → Forge → Review workflow; no Plan agent
  - Natural voice behavior: “let me think a little bit…”, sleep/poll cadence for realism
  - Deliverable: `.genie/code/agents/voice.md` (complete spec with examples)
  - Acceptance: Spec approved; references to MCP calls and workflows are precise

- Voice Session Boot Protocol — MCP Kickoff Flow
  - Document exact first-turn behavior for a new voice session
  - Start Reasoning Team (delegation target) via `mcp__genie__run`
  - Start Learn agent (always-on) via `mcp__genie__run`
  - Ensure Wish agent is active (always-on) and ready to capture/route requests
  - Define natural interleaving of talk → think → sleep → update pattern
  - Deliverable: `.genie/qa/workflows/voice-boot-qa-workflow.md` (helper + tests)
  - Acceptance: Step-by-step flow with concrete MCP sequences and timing hints
  - Status: ✅ COMPLETE (v1) — covered by `.genie/qa/workflows/voice-boot-qa-workflow.md` and spec `.genie/code/agents/voice.md`

- Reasoning Team — Composition & Protocol
  - Define `reasoning` agent (team orchestrator) that delegates hard thinking
  - Composition options for v1: (a) analyze + deep-dive + consensus; or (b) Tech Council advisory
  - Uses `@.genie/code/skills/team-consultation-protocol.md`
  - Clear handoff back to voice for user-facing responses
  - Deliverable: `.genie/code/agents/reasoning.md`
  - Acceptance: Agent spec complete; sample prompts; delegation boundaries clear

---

## ⚠️ HIGH Priority (Do After Critical)

- MCP Orchestration Map (Voice → Wish/Forge/Review/Learn/Reasoning)
  - Enumerate exact MCP tool calls for common flows
  - Patterns: create wish, forge breakdown, review validation, continuous learn capture
  - Deliverable: `.genie/docs/voice-mcp-orchestration-map.md`
  - Acceptance: Sequences validated against existing MCP tools

- Model Profiles — Fast (Voice) vs Deep (Reasoning)
  - Define executor profiles for speed-first voice vs deep-reasoning team
  - Configuration stubs and guidance in `.genie/cli/config.yaml`
  - Deliverable: `.genie/docs/voice-model-profiles.md`
  - Acceptance: Clear mapping and fallback guidance

- Always-On Agents — Learn + Wish
  - Responsibilities and lifecycle (start, monitor, resume)
  - Safety switches and degradation when unavailable
  - Deliverable: `.genie/docs/always-on-agents.md`
  - Acceptance: Documented responsibilities; health/monitoring notes

- Conversational Scriptbook & Timing
  - Library of natural phrases and delay cadences for realism
  - Incorporate “sleep, don’t stop” monitoring pattern
  - Deliverable: `.genie/docs/voice-scriptbook.md`
  - Acceptance: Usable snippets and guidance referenced by voice agent spec

---

## 🔍 INVESTIGATION Queue

- Multi‑Wish / Multi‑Task Coordination via MCP
  - Clarify how voice delegates to create multiple wishes and targeted tasks
  - Patterns for assigning tasks to specific agents via Genie MCP
  - Deliverable: `.genie/docs/voice-multi-task-wish-patterns.md`
  - Acceptance: Concrete examples; aligns with Wish → Forge → Review

- Minimal Runtime Hooks for Voice Boot
  - Identify minimal integration points to auto-start Reasoning/Learn/Wish on voice session start
  - No code changes now; document hooks and acceptance tests
  - Deliverable: Section in `voice-boot-protocol.md`
  - Acceptance: Feasible, incremental, testable

---

## 📋 MEDIUM Priority (Backlog)

- Acceptance Tests — Voice Orchestration (Spec-Only v1)
  - 3 scripted scenarios: new session kickoff; heavy-reasoning delegation; continuous learn
  - Non-functional targets: <800ms first response; natural turn-taking language
  - Deliverable: `.genie/qa/voice-scenarios/` scripts + checklist
  - Acceptance: Scripts runnable by human; pass/fail criteria recorded

---

## ⏸️ PAUSED / BLOCKED

*Add blocked tasks here with blocker description*

---

## 🔄 Priority Rules

**1. CRITICAL > HIGH > MEDIUM > INVESTIGATION**

**2. System health > New features**
- Fix blocking issues before adding features
- Investigate bugs before creating new work
- Clean up technical debt systematically

**3. Complete before starting**
- Finish CRITICAL #1 before CRITICAL #2
- One task deeply, not many shallowly
- Document completion evidence

**4. Evidence-based decisions**
- Always analyze before implementing
- Read existing code before editing
- Check for partial implementations

---

## 📊 Effort Tracking

**Total estimated work:**
- CRITICAL: 14 hours
- HIGH: 12 hours
- MEDIUM: 6 hours
- INVESTIGATION: 6 hours

**Current capacity:** [Your availability]

**Next action:** See STATE.md for current session focus
