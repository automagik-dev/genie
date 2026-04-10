# Brainstorm Jar

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
- [agent-stability-hardening](wishes/agent-stability-hardening/WISH.md) — SHIPPED (PR #1112). Verify on dev.
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
- [Agent Stability Hardening](wishes/agent-stability-hardening/WISH.md) — SHIPPED (PR #1112, 2026-04-09). Permission spread + remoteApproval + tmux mouse + inbox retry.
- [Session Capture v2](wishes/session-capture-v2/WISH.md) — SHIPPED (PR #825, 2026-04-09). Filewatch + lazy backfill + tool event extraction.
- [pgserve Daemon Ownership](wishes/pgserve-daemon-ownership/WISH.md) — SHIPPED (PR #827, 2026-04-09). Daemon owns PG, self-heal, doctor --fix.
- [os-services Orphan Leak](wishes/os-services-orphan-leak/WISH.md) — SHIPPED (PR #272 + #274, 2026-04-09). Layer 1+2 signal fix + orphan reaper + migration matchAll.
- [env-defaults-local-mode](wishes/env-defaults-local-mode/WISH.md) — SHIPPED (incremental, 2026-04-09). All 6 criteria met across multiple PRs.
- [Onboarding Overhaul](brainstorms/onboarding-overhaul/DRAFT.md) — ALL 3 SUB-WISHES SHIPPED:
  - **1.** [genie-model-resolution](wishes/genie-model-resolution/WISH.md) — SHIPPED (QA 2026-04-08)
  - **2.** [genie-onboarding-flow](wishes/genie-onboarding-flow/WISH.md) — SHIPPED (all 7 groups on dev)
  - **3.** [genie-layout-migration](wishes/genie-layout-migration/WISH.md) — SHIPPED (in binary)
- [Brain Obsidian](wishes/brain-obsidian/WISH.md) — ALL 6 SUB-WISHES SHIPPED in @khal-os/brain v1.22.0:
  - brain-foundation, brain-embeddings, brain-intelligence, brain-observability, brain-identity-impl, brain-init-skill
- [rlmx](wishes/rlmx-v04-gemini3/WISH.md) — v0.2 + v0.3 + v0.4 ALL SHIPPED (npm v0.260331.5)
- [Omni Lifecycle Hardening](wishes/omni-lifecycle-hardening/WISH.md) — SHIPPED (PR #359)
- [Omni Version Unify](brainstorms/omni-version-unify/DESIGN.md) — SHIPPED (PR #356)
- [Omni Skill Upgrade](wishes/omni-skill-upgrade/WISH.md) — SHIPPED (3-tier skills live)
- [remove-openclaw](wishes/remove-openclaw/WISH.md) — SHIPPED (absent from binary)
- **v4 Stability Sprint** — COMPLETE (2026-04-02). All 6 wishes merged.
- [Session Observability](brainstorms/session-observability/DESIGN.md) — CRYSTALLIZED → folds into session-capture-v2
- [X Tool](brainstorms/x-tool/DESIGN.md) — CRYSTALLIZED (WRS 100/100). Parked.

## Killed
- genie-app — superseded by genie-app-v1 / genie-studio
- session-ingester-perf — superseded by session-capture-v2
- brain-obsidian (parent spec) — all children shipped, reference only
