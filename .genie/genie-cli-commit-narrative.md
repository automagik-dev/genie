# Genie CLI: Development Narrative (Q1 2026)

> Extracted from git commit history (Jan 1 – Feb 11, 2026)

## 1. Timeline of Major Features

### Phase 1: Foundation & Unified Architecture (Feb 2 - Feb 4)
- **Unified Skills:** Common architecture for OpenClaw + Claude Code skills
- **Worker Profiles:** Configurable worker profiles with `claudio` integration
- **Self-Installation:** Major focus on `install.sh` reliability, global binaries, PATH verification
- **Transition to .genie:** Migration from `.beads` to `.genie/` for project-specific state

### Phase 2: Multi-Worker Orchestration (Feb 4 - Feb 6)
- **Parallel Spawning:** `spawn-parallel` with event-driven queue advancement and `paneId` capture (#16)
- **CLI Reorganization:** Large-scale refactoring into `session` and `task` namespaces
- **Auto-Approve Engine:** Claude Code event capture and auto-approval for high-velocity tasks
- **Genie-PDF:** `genie-pdf` package for high-quality documentation rendering

### Phase 3: Pane Orchestration & Target Resolution (Feb 7 - Feb 9)
- **Pane Targeting:** Shift from "ghost windows" to targeting specific existing tmux panes
- **Worker-Addressed Commands (v2):** Radical upgrade to `term` orchestration — commands addressed to specific workers/panes (#22)
- **Active-Pane Awareness:** Intelligent resolution of "active" window/pane instead of defaulting to first one (#24)

### Phase 4: Resilience & Self-Knowledge (Feb 10 - Feb 11)
- **Forge Resilience:** Hardening of `term work` — read-only dirs, missing beads, graceful degradation (#30)
- **Environment Continuity:** `.env` loading from root repos within worktrees
- **Consciousness Extraction:** Systematic logging into `.genie/consciousness-extract.md`

## 2. Architecture Evolution
- **From Monolith to Namespaces:** Flat commands → nested `term <namespace> <command>`
- **Window-per-Worker Model:** Split panes → dedicated tmux windows with unique `windowId` tracking
- **Hook System v2:** Shell-based → pure Node.js hooks for cross-platform compatibility
- **Target Resolver:** Sophisticated library mapping user-friendly labels to tmux addresses

## 3. PR Patterns & Review Process
- **Wish-Driven Development:** Every major feature starts with a Wish doc in `.genie/wishes/`
- **Review Criteria:** PRs checked against "Council Criteria" (group gaps, security findings)
- **The "SHIP" Label:** Merges preceded by `✅ review: <feature> SHIP` commit (100% criteria pass)
- **Retroactive Wishes:** For urgent fixes, documented after the fact to maintain trail

## 4. Active Areas (Hot Files)
- `src/term-commands/work.ts` — core worker spawning engine (highest churn)
- `src/lib/target-resolver.ts` — command routing logic
- `plugins/automagik-genie/scripts/` — CLI ↔ agent plugin bridge
- `.genie/` — memory/, wishes/, consciousness-extract.md

## 5. Team Contributions
- **Felipe:** Strategic direction, infra requests, LXC specs
- **Cezar (vasconceloscezar):** Primary reviewer, core orchestration
- **Sofia PM:** Wish documentation, process enforcement
- **Genie (Self):** Bulk implementation, testing, consciousness logging

## 6. Open Branches & In-Flight Work
- **Genie Updated 24/7:** Persistent agent presence on dedicated LXC
- **Sampa Seeds Hive:** Decentralized agent coordination for project management
- **LXC Infrastructure:** From worktrees to containerized isolation
- **Degraded Mode Pathing:** CLI functional even when external tools fail

---
**Key Insight:** The system evolved from "command runner" to "session-aware orchestrator." Future work should leverage the `target-resolver` for all terminal interaction rather than calling `tmux` directly.
