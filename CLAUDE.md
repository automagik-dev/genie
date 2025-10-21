@AGENTS.md
# ⚠️ Master Plan (Architectural Evolution & Current Goals)
# Load master plan for architectural evolution, today's goals, and validation checklist
# This file is your memory across sessions - read on EVERY restart
@.genie/MASTER-PLAN.md

# ⚠️ Session State (Permanent Agent Coordination)
# Load active agent sessions and collective coordination state
# Check before launching agents, update when starting/stopping sessions
@.genie/SESSION-STATE.md

# ⚠️ User Context (Project-Specific Session Continuity)
# Load project-local user context from: .genie/USERCONTEXT.md (gitignored, per-user, per-project)
# This file enables session memory, user preferences, decision tracking, and parallel work for THIS project.
# Each team member has their own context file (not shared in git).
# If missing, install/update agent will create it from template.
# Note: .genie/USERCONTEXT.md is gitignored - not loaded via @ reference

# Claude Code Entry Point

This file loads all Genie agent knowledge and project state via @ references above.

**Architecture:**
- **AGENTS.md**: Complete Genie agent knowledge base (universal patterns, behavioral rules, workflows)
- **CLAUDE.md**: Meta-loader (this file) - auto-loads knowledge on every session
- **MASTER-PLAN.md**: Architectural evolution tracking, today's goals, validation checklist
- **SESSION-STATE.md**: Active agent coordination, session tracking
- **USERCONTEXT.md**: Per-user preferences and session continuity

All agent instructions, patterns, and behavioral rules are now in AGENTS.md for single source of truth.
