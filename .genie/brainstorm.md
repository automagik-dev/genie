# Brainstorm Jar

## Umbrella Roadmaps (active)

- [genie-self-healing-observability](brainstorms/genie-self-healing-observability/DESIGN.md) — CRYSTALLIZED (WRS 100/100, 2026-04-21). BUGLESS-GENIE umbrella. Coordinates sub-projects A (observability — shipping), B (self-heal — to create), C (dispatch robustness — to create), D (ghost hygiene — to create). Hybrid finish-line: targeted per-pathology gates ship, empirical 14d zero-occurrence gate labels. Tier 3 autonomy on dev unlocked by §19 v2 + PR #1251 (merged).

## Sprint Backlog (next sprint — /review + /brainstorm queue)

### Tier 1: Autonomous dispatch (dream-eligible)
- [scaffold-auto-memory](wishes/scaffold-auto-memory/WISH.md) — READY. Auto-configure `autoMemoryEnabled`/`autoMemoryDirectory` in `.claude/settings.local.json` + seed `MEMORY.md` when `genie init agent <name>` scaffolds. Closes automagik-dev/genie#1106. Twin-genie reviewed: scope 2/5, risk 2/5, clarity 4/5.
- [brain-help-passthrough](wishes/brain-help-passthrough/WISH.md) — READY. Add `addHelpText` footer to `genie brain --help` so users see the forwarded subcommands (status, health, init, search, etc.). Passthrough already works at runtime; help text just doesn't advertise it. Closes automagik-dev/genie#1118. Twin-genie reviewed: scope 1/5, risk 1/5, clarity 5/5.

### Tier 2: Agent creation (brainstorm → wish)
- **brain-cag-v2** — NEW. Seamless brain→rlmx integration. Brain is the interface, rlmx is the engine. No direct `rlmx` CLI needed.
- **brain-optimizer-agent** — `/review` existing pipeline → create `.genie/agents/brain-optimizer/` sub-agent that uses traces+grades.
- **rlmx-dogfood-agent** — `/review` rlmx → create `.genie/agents/rlmx-dogfood/` sub-agent that uses rlmx on itself.

### Tier 3: Investigation first
- **dir-scope-architecture** (automagik-dev/genie#1107) — BLOCKED on architecture decision. Twin-genie trace revealed the PG `agents` table has NO scope column; `dir add --global` and `dir add` hit the same row. Fix requires either (a) adding a scope column with migration, or (b) removing the `--global` flag and false success messaging. Human decision needed before any code change. NOT autonomous-friendly.
- **rlmx-ship-polish** — Merge rlmx-integration + rlmx-readme. `/review` then `/brainstorm`. Live API tests, version fix, README.
- **genie-studio** — `/review` genie repo app code → compare with genie-app-v1 wish → consolidate/rename.
- [sdk-executor-full](wishes/sdk-executor-full/WISH.md) — APPROVED. `/review` current 132 executor matches → `/brainstorm` gaps.
- [agent-stability-hardening](wishes/_archive/agent-stability-hardening/WISH.md) — SHIPPED (PR #1112). Verify on dev.
- [brain-benchmark-loop](wishes/brain-benchmark-loop/WISH.md) — IN_PROGRESS. `/review` progress → decide next step.

## Deferred
- [omni-turn-based-dx](wishes/omni-turn-based-dx/WISH.md) — DRAFT. Foundational architecture, not sprint-sized.
- [unified-executor-layer](wishes/unified-executor-layer/WISH.md) — DRAFT. Depends on omni-turn-based-dx.
- [workflow-action-engine](wishes/workflow-action-engine/WISH.md) — DRAFT. Depends on genie-app-v1.
- [sac-agent](wishes/sac-agent/WISH.md) — DRAFT. Niche use case (Itaú Cartões).
- [crew-simplification](brainstorms/crew-simplification/DESIGN.md) — DRAFT. Housekeeping post-v1.
- [genie-skill-graph](wishes/genie-skill-graph/WISH.md) — DRAFT. Requires architecture work.
- tmux+sdk mode coexistence — flagged for future brainstorm.

## Non-engineering (parked)
- [The Agentic Shift — Mini-Documentary](brainstorms/agentic-shift-documentary/DESIGN.md) — CRYSTALLIZED. 40-shot Veo3 script. Schedule when ready.
- Viralizador — Recurring DevRel content loop, not a shippable feature.

## Poured (shipped)

All shipped wishes live in [`wishes/_archive/`](wishes/_archive/). Listed here for reference.

- [Agent Stability Hardening](wishes/_archive/agent-stability-hardening/WISH.md) — SHIPPED (PR #1112, 2026-04-09). Permission spread + remoteApproval + tmux mouse + inbox retry.
- [Session Capture v2](wishes/_archive/session-capture-v2/WISH.md) — SHIPPED (PR #825, 2026-04-09). Filewatch + lazy backfill + tool event extraction.
- [pgserve Daemon Ownership](wishes/_archive/pgserve-daemon-ownership/WISH.md) — SHIPPED (PR #827, 2026-04-09). Daemon owns PG, self-heal, doctor --fix.
- [os-services Orphan Leak](wishes/_archive/os-services-orphan-leak/WISH.md) — SHIPPED (PR #272 + #274, 2026-04-09). Layer 1+2 signal fix + orphan reaper + migration matchAll.
- [env-defaults-local-mode](wishes/_archive/env-defaults-local-mode/WISH.md) — SHIPPED (incremental, 2026-04-09). All 6 criteria met across multiple PRs.
- [Onboarding Overhaul](brainstorms/onboarding-overhaul/DRAFT.md) — ALL 3 SUB-WISHES SHIPPED:
  - **1.** [genie-model-resolution](wishes/_archive/genie-model-resolution/WISH.md) — SHIPPED (QA 2026-04-08)
  - **2.** [genie-onboarding-flow](wishes/_archive/genie-onboarding-flow/WISH.md) — SHIPPED (all 7 groups on dev)
  - **3.** [genie-layout-migration](wishes/_archive/genie-layout-migration/WISH.md) — SHIPPED (in binary)
- [Brain Obsidian](wishes/_archive/brain-obsidian/WISH.md) — ALL 6 SUB-WISHES SHIPPED in @khal-os/brain v1.22.0:
  - brain-foundation, brain-embeddings, brain-intelligence, brain-observability, brain-identity-impl, brain-init-skill
- [rlmx](wishes/_archive/rlmx-v04-gemini3/WISH.md) — v0.2 + v0.3 + v0.4 ALL SHIPPED (npm v0.260331.5)
- [Omni Lifecycle Hardening](wishes/_archive/omni-lifecycle-hardening/WISH.md) — SHIPPED (PR #359)
- [Omni Version Unify](brainstorms/omni-version-unify/DESIGN.md) — SHIPPED (PR #356)
- [Omni Skill Upgrade](wishes/_archive/omni-skill-upgrade/WISH.md) — SHIPPED (3-tier skills live)
- [remove-openclaw](wishes/_archive/remove-openclaw/WISH.md) — SHIPPED (absent from binary)
- **v4 Stability Sprint** — COMPLETE (2026-04-02). All 6 wishes merged: [v4-database-layer](wishes/_archive/v4-database-layer/WISH.md), [v4-hook-cli-safety](wishes/_archive/v4-hook-cli-safety/WISH.md), [v4-message-routing](wishes/_archive/v4-message-routing/WISH.md), [v4-session-executor](wishes/_archive/v4-session-executor/WISH.md), [v4-spawn-resilience](wishes/_archive/v4-spawn-resilience/WISH.md), [v4-team-lifecycle](wishes/_archive/v4-team-lifecycle/WISH.md).
- [Session Observability](brainstorms/session-observability/DESIGN.md) — CRYSTALLIZED → folds into session-capture-v2
- [X Tool](brainstorms/x-tool/DESIGN.md) — CRYSTALLIZED (WRS 100/100). Parked.

## Killed
- [genie-app](wishes/_archive/genie-app/WISH.md) — superseded by genie-app-v1 / genie-studio
- [session-ingester-perf](wishes/_archive/session-ingester-perf/WISH.md) — superseded by session-capture-v2
- [brain-obsidian](wishes/_archive/brain-obsidian/WISH.md) (parent spec) — all children shipped, reference only
