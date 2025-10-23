# Token-Efficient Knowledge Architecture (Issue #155)

**Goal:** Shrink default session context from ~10k tokens to ~500 while keeping the full Genie knowledge base one lookup away.

## Current State Snapshot
- The CLAUDE entry point currently preloads `AGENTS.md`, `MASTER-PLAN.md`, `SESSION-STATE.md`, and `USERCONTEXT.md`, giving every run a full knowledge dump before work begins (`CLAUDE.md`:1-30).
- Priority tiers trim some load, but the mandatory block still weighs in at ~13.9KB every session (`.genie/cli/LOADING_STRATEGY.md`:14-64).
- Skills and workflows are stored as large narrative files, so pulling a single reminder often drags along unrelated guidance.

## Pattern 1 – Two-Stage Lazy Entry
1. **Bootstrap Capsule (≤500 tokens).** Replace the all-in `CLAUDE.md` load with a minimal manifest: identity sentence, non-negotiable guardrails, and a table pointing to where the rest lives. Any extra knowledge moves behind explicit lookups via `@` references.
2. **Module Dispatch.** Create a machine-readable manifest (e.g., `bootstrap/manifest.json`) that maps spell families to file shards. The CLI resolves this manifest to decide which fragments to stream when the agent asserts it needs more.
3. **Progressive Activation Hooks.** Teach the bootstrap to call `genie load <module>` instead of assuming the module already sits in context. The loader then brings in only the markdown chunks required for the current request.

## Pattern 2 – Redundant Prompt Pruning (Amendment #4)
1. **Automation Diff.** Maintain a ledger of automated behaviors. When a feature toggles to “automatic,” run `rg` across prompts to find lingering instructions that mention the “old way,” and remove them rather than annotating them.
2. **Phrase Fingerprinting.** Hash 3-5 sentence shingles out of `AGENTS.md` and companion docs; duplicates across files signal copy-pasted guidance ready for deletion or consolidation.
3. **Regression Guard.** Add a lint step that fails when the bootstrap capsule exceeds 500 tokens or when a removed-in-ledger phrase reappears, preventing accidental prompt bloat.

## Pattern 3 – Atomic Skill Units
1. **Skill Shards.** Split monolithic spells into tiny (~80 token) files with YAML headers describing `purpose`, `triggers`, and `depends_on`. The bootstrap loads only shard headers; the body loads on demand.
2. **Dependency Graph.** Build a directed graph from shard metadata so the loader can fetch the precise dependency chain rather than entire categories.
3. **Task-Aligned Bundles.** Define stable bundles (e.g., “Wish Discovery”, “Forge Execution”, “Review QA”) that list minimal shard sets. Bundles stay small (<250 tokens) and can be stitched together when the issue scope crosses domains.

## Pattern 4 – Context Detection Heuristics
1. **Issue Signals.** Parse labels, components, and keywords in the linked GitHub issue to pick starter bundles (e.g., `docs`, `qa`, `infra`).
2. **Worktree Signals.** Watch files touched in the worktree; editing `tests/` pulls QA shards, touching `.genie/workflows/forge/` grabs implementation guidance.
3. **Conversation Signals.** Lightweight N-gram detection inside the active chat (e.g., “plan,” “blocked,” “naming”) triggers corresponding shard loads.
4. **Tool Feedback.** Failed commands or explicit tool prompts feed back into the loader (e.g., a failing `pnpm test` automatically pulls the testing shard set).

## Instrumentation & Roadmap
1. Instrument loader metrics (tokens streamed per module, average bootstrap cost) to keep a running dashboard inside `SESSION-STATE.md`.
2. Pilot the bootstrap capsule inside a branch workspace; profile response quality versus the current baseline.
3. Once lazy-loading is stable, freeze any manual instruction that references auto-loaded modules, then prune it via the Amendment #4 workflow.
