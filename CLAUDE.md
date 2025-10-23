@AGENTS.md

# ⚠️ User Context (Project-Specific Session Continuity)
# Load project-local user context from: .genie/USERCONTEXT.md (gitignored, per-user, per-project)
# This file enables session memory, user preferences, decision tracking, and parallel work for THIS project.
# Each team member has their own context file (not shared in git).
# If missing, install/update agent will create it from template.
# TODO: Create USERCONTEXT.md template and uncomment @ reference

# Claude Code Entry Point

This file loads all Genie agent knowledge and project state via @ references above.

**Architecture:**
- **AGENTS.md**: Complete Genie agent knowledge base (universal patterns, behavioral rules, workflows)
- **CLAUDE.md**: Meta-loader (this file) - auto-loads knowledge on every session
- **USERCONTEXT.md**: Per-user preferences and session continuity (gitignored)
- **.genie/.session**: Live Forge state, auto-generated (gitignored, load explicitly with `!cat .genie/.session`)

All agent instructions, patterns, and behavioral rules are in AGENTS.md for single source of truth.

**Historical:** MASTER-PLAN.md archived to `.genie/reports/architectural-evolution-may-oct-2025.md` (served its purpose, reached RC92)
