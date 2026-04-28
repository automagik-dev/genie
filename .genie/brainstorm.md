# Brainstorm Jar

## Umbrella Roadmaps (active)

- [genie-self-healing-observability](brainstorms/genie-self-healing-observability/DESIGN.md) — CRYSTALLIZED (WRS 100/100, 2026-04-21). BUGLESS-GENIE umbrella. Coordinates sub-projects A (observability — shipping), B (self-heal — to create), C (dispatch robustness — to create), D (ghost hygiene — to create). Hybrid finish-line: targeted per-pathology gates ship, empirical 14d zero-occurrence gate labels. Tier 3 autonomy on dev unlocked by §19 v2 + PR #1251 (merged).
- [security-roadmap-microprs](brainstorms/security-roadmap-microprs/DESIGN.md) — CRYSTALLIZED (WRS 100/100, 2026-04-27). Dedicated Genie security board created (`Genie Security`, board-321b2548); broad assessment tasks #49-#54 moved onto it; microPR roadmap tasks #55-#61 created. First selected microPR is #55: [security-install-download-guard](wishes/security-install-download-guard/WISH.md), lint-clean, with child tasks #62 and #63 in ready. Preliminary file-backed findings remain in DRAFT: install-time download verification, `GENIE_TMUX_URL` trust boundary, localhost worker CORS/write auth, shell execution inventory, agent launch `sh -c` trust boundary, brain artifact verification, auto-approval drift control, and event token posture.

## Sprint Backlog (next sprint — /review + /brainstorm queue)

### Tier 1: Autonomous dispatch (dream-eligible)
- [owner-vs-meeseeks-spawn](brainstorms/owner-vs-meeseeks-spawn/DESIGN.md) — **CRYSTALLIZED** (WRS 100/100, 2026-04-26). Master-aware team spawn + recovery hardening (`.5` release umbrella, 11 items in 3 waves). Born from 2026-04-25 power-outage recovery thread. Core fix is ~3 lines in `protocol-router.ts:resolveResumeSessionId` — fall back to `dir:<recipientId>` chokepoint lookup when `worker == null`, so team-lead "hires" honor master agents' persistent session UUIDs instead of generating fresh `--session-id <new>`. Wave 1 (CRITICAL): spawn-path patch + `genie agent recover` verb + heal-not-wipe reconciler guardrail. Wave 2 (HIGH): `maintain_partitions` self-heal + `genie status` recoverable-session inline + jsonl preservation + jsonl-fallback identity-match relaxation. Wave 3 (MED/LOW): watchdog non-interactive guard + `--emergency` flag + stale-spawning reaper + doctor partition_count audit. **No new schema** — uses existing primitives (`kind`, `reports_to`, `team`, `task_id`/`wish_slug`, `repo_path`, `dir:` id prefix). Slug: `owner-vs-meeseeks-spawn` (rename to `master-aware-spawn` if shipping).
- [scaffold-auto-memory](wishes/scaffold-auto-memory/WISH.md) — READY. Auto-configure `autoMemoryEnabled`/`autoMemoryDirectory` in `.claude/settings.local.json` + seed `MEMORY.md` when `genie init agent <name>` scaffolds. Closes automagik-dev/genie#1106. Twin-genie reviewed: scope 2/5, risk 2/5, clarity 4/5.
- [brain-help-passthrough](wishes/brain-help-passthrough/WISH.md) — READY. Add `addHelpText` footer to `genie brain --help` so users see the forwarded subcommands (status, health, init, search, etc.). Passthrough already works at runtime; help text just doesn't advertise it. Closes automagik-dev/genie#1118. Twin-genie reviewed: scope 1/5, risk 1/5, clarity 5/5.
- [bare-genie-dashboard](wishes/bare-genie-dashboard/WISH.md) — READY (filed 2026-04-23, lint-clean). Phase 1 split out of `onboarding-unification` brainstorm. Rebuild bare `genie`: first-run provisioning (one prompt ever), `agent sync` auto-heal, 2-column dashboard (NUMBERS left + Clancy-style agent feed right via `claude -p --output-format stream-json`), `welcome.md` override, 8 toggle panels (kanban/tree/bar/severity/sparkline). 6 groups across 4 waves; medium appetite (~6–10h).
- [session-cost-extraction](wishes/session-cost-extraction/WISH.md) — DISPATCHED (team `session-cost-fix`, 2026-04-22). Extract `usage` from JSONL turns into `sessions` cost columns + `v_session_spend` view. Unblocks PG as the spend source-of-truth for the dashboard.

### Tier 2: Agent creation (brainstorm → wish)
- **brain-cag-v2** — NEW. Seamless brain→rlmx integration. Brain is the interface, rlmx is the engine. No direct `rlmx` CLI needed.
- **brain-optimizer-agent** — `/review` existing pipeline → create `.genie/agents/brain-optimizer/` sub-agent that uses traces+grades.
- **rlmx-dogfood-agent** — `/review` rlmx → create `.genie/agents/rlmx-dogfood/` sub-agent that uses rlmx on itself.
- [onboarding-unification](brainstorms/onboarding-unification/DRAFT.md) — SIMMERING. 7-phase roadmap for unifying first-run install/setup/init/wizard/dir-add into one coherent entry surface + deleting fragmented commands. Phase 1 (bare-genie-dashboard) split out to its own wish 2026-04-23. Phases 2-7 remaining: `genie agent create` atomic scaffold, `genie agent sync`, `genie workspace create/use/show`, `genie config`, removed-command hard-redirects + skill-update sweep, migration-on-upgrade.

### Tier 3: Investigation first
- [aegis-distribution-sovereignty](brainstorms/aegis-distribution-sovereignty/DESIGN.md) — **CRYSTALLIZED** (WRS 100/100, 2026-04-27). Umbrella for moving genie off npmjs entirely + Aegis runtime sandbox. **4 sibling wishes**, W2 distribution-first sequencing (~6 weeks): (A) `distribution-exodus` — `curl -fsSL get.automagik.dev/genie | bash` mirrors Claude Code bootstrap; per-platform `bun build --compile` binaries on `cdn.automagik.dev` with cosign + SLSA + SHA256; npm becomes 50-LOC deprecation shim. (B) `genie-self-update` — channel-aware (stable/beta/canary), atomic replace, rollback. (C) `aegis-runtime` — NEW `automagik-dev/aegis` Rust daemon, network sandbox observe-only-by-default, CLI mission control. (D) `aegis-scanner` — continuous scanner module inside aegis daemon, hourly `@automagik/genie-signatures` poll, FS watchers, critical-finding pipeline → `sec-fix`. **Two-org separation**: OSS lite in `automagik-dev`, enterprise suite (prompt-injection / PII / data-leak / sandbox / mission control) deferred entirely to `@khal-os`. Prerequisites: `genie-supply-chain-signing` + `sec-signature-registry`. Sister umbrella to `canisterworm-incident-response` (prevention vs. response). Parallel to `security-assessment-roadmap` (active sovereignty vs. passive inventory).
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

- [canisterworm-incident-response](brainstorms/canisterworm-incident-response/DESIGN.md) — **UMBRELLA** (WRS 100/100, 2026-04-23). Full CanisterWorm incident-response posture split into 4 sibling wishes after 10-perspective council + dispatched reviewer both returned BLOCKED on the monolith. Council record: [COUNCIL.md](brainstorms/sec-scan-progress/COUNCIL.md). Preconditions: `codex/sec-scan-command` must merge to `main` before any sibling dispatches. Shared invariants: detect-only scanner, quarantine-by-move never delete, append-only audit log, dry-run default, typed consent strings, signature-verified `--apply`. Total wall-time with parallelism ~6 weeks.
  - [sec-scan-progress](wishes/sec-scan-progress/WISH.md) — READY (5 groups, medium). Scanner observability + envelope + telemetry + deletion pass + `print-cleanup-commands`. Depends on: base merge. Unblocks: sec-remediate + sec-incident-runbook.
  - [sec-remediate](wishes/sec-remediate/WISH.md) — READY (2 groups, medium). `genie sec remediate` + `restore` + `rollback` + quarantine lifecycle + offline-credential guidance. Depends on: sec-scan-progress (envelope + audit log).
  - [genie-supply-chain-signing](wishes/genie-supply-chain-signing/WISH.md) — READY (2 groups, medium). Cosign + SLSA provenance + `verify-install` + `--unsafe-unverified <INCIDENT_ID>` contract. Runs parallel to sec-remediate; independent of scanner surface.
  - [sec-incident-runbook](wishes/sec-incident-runbook/WISH.md) — READY (2 groups, small). SECURITY.md invariants + `canisterworm.md` three-branch decision tree + automated cold-runbook test + help-text examples. Depends on: sec-remediate + genie-supply-chain-signing.
  - [sec-scan-av-ui](wishes/sec-scan-av-ui/WISH.md) — DRAFT (4 groups, medium, 2026-04-24). Follow-up after first-operator field test (Felipe's Mac) revealed noisy UX + false positives. Ships: (A) real-time AV-grade progress UI (sticky compact renderer, per-file ticks, spinner, live findings counter), (B) false-positive reduction (self-path exclusion, version-gated matching, shell-history exclusion table, scoring recalibration). Depends on: sec-scan-progress G1+G2 merged (#1362) + sec-scan-temp-hang-hotfix (#1371). Unblocks: `LIKELY COMPROMISED` verdict on clean hosts, "2050 antivirus" feel.
  - [sec-signature-registry](wishes/sec-signature-registry/WISH.md) — DRAFT (6 groups, large ~2-3 weeks, 2026-04-24). Product-vision evolution after Felipe asked "how do we add new signatures as incidents emerge". Rearchitects scanner from single-incident hardcode to signature-pack-driven engine. Ships: YAML pack schema + loader + cosign-verified installation, new `@automagik/genie-signatures` npm package (separate repo, independent publish cadence), `genie sec signatures list/verify/add/remove/update/search` subcommands, per-finding attribution, community contribution pathway. Runs parallel to sec-scan-av-ui; recommended to ship sec-scan-av-ui first for per-signature attribution rendering. Turns genie into the `npm audit` operators actually trust.
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
