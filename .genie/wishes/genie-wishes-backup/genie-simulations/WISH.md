# Wish: Genie Simulations — Agent Evaluation via Real Multi-Turn Conversations

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-simulations` |
| **Date** | 2026-04-09 |
| **Design** | [DESIGN.md](../../brainstorms/genie-simulations/DRAFT.md) |

## Summary

Build a simulation and evaluation pipeline for genie agents. Sim agents (full genie agents playing human personas) converse with a target agent through real Omni sessions. Each agent gets 100 curated scenarios scored 0-100 via compound LLM-as-judge + human annotation. Scenarios are extracted from real WhatsApp conversations with PII anonymized. All data persists to PG for full transcript reconstruction in genie-app.

## Scope

### IN
- PG schema: simulation tables (runs, scenarios, turns, scores, annotations)
- Simulation service (`src/services/simulator/`) — orchestrator, scenario loader, scoring pipeline
- Sim agent convention: `.genie/simulations/<scenario>/AGENTS.md` with standard genie frontmatter
- Scenario extraction: `genie sim create` — pull real Omni conversation, anonymize PII, generate sim agent scaffold
- Simulation runner: `genie sim run <scenario>` (single) and `genie sim run --all` (full suite, wave-based concurrency)
- Real Omni session injection — sim agents and target agents communicate through a dedicated sim Omni instance
- Compound scoring: 9 dimensions (script adherence, goal completion, response quality, latency, tool usage, recovery, hallucination, instruction compliance, human eval)
- LLM-as-judge per dimension with reasoning + evidence stored in PG
- `genie sim results` — per-scenario and aggregate score display
- `genie sim done` — sim agent exit signal, triggers scoring and teardown
- `/simulate` skill for interactive simulation piloting
- `simulator` agent type in genie's built-in agent registry
- CLI namespace: `genie sim` with subcommands (create, run, results, annotate, list)
- Session lifecycle: same mechanics as omni-bridge (PG tracking, 100-turn hard cap, stale cleanup)
- Genie-app Simulations view: runs dashboard, scenario list, transcript replay with WhatsApp-like chat bubbles, per-dimension score breakdown, human annotation (thumbs up/down per turn)
- Backend NATS subjects + PG queries for simulation data (follows existing pg-bridge pattern)
- Manifest + component registration for Simulations nav item

### OUT
- Automatic scenario extraction / auto-generation (v1 is manual curation only)
- Real-time production monitoring (offline evaluation only)
- Eugenia-specific scenario content (this wish builds the framework; scenario authoring is per-agent work)
- `@langwatch/scenario` OTel integration (evaluated during brainstorm, not needed — we build our own scoring pipeline)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Sim agents are full genie agents (AGENTS.md, frontmatter) | Same spawn mechanics, no special-casing. A sim agent is just an agent playing a human persona |
| Sim agents live under `.genie/simulations/` not `.genie/agents/` | Keeps sim agents separate from production agents, all sim context co-located |
| Conversations flow through real Omni (not mocked) | Tests the full stack: NATS, bridge, executor, tools, latency, concurrency. Target agent is unaware |
| Dedicated sim Omni instance/channel for side effects | Handoffs, replies, tool side effects flow to sim channel — no per-agent customization needed |
| Manual scenario curation (not automated) | Quality over quantity. Real conversations are manually selected and PII-anonymized |
| 100-turn hard cap with goal-based exit | `genie sim done` as primary exit, turn cap as safety net. Loops score 0 — that's valid data |
| PG stores full transcript (every turn, tool call, latency) | Enables genie-app to reconstruct simulations for human annotation |
| LLM-as-judge with per-dimension reasoning | Brain repo pattern (answer-judge.ts). Reasoning stored for transparency and debugging |
| Human annotation is a weight in the score, not a gate | Annotations are post-hoc via genie-app, feed into aggregate score. Sims run without waiting for humans |
| Inside genie core (`src/services/simulator/`) not a plugin | Needs executor, PG, NATS internals. Same codebase as omni-bridge |
| Target agent spawned from specific git branch | `genie sim run --target agent@branch` — enables before/after comparison across branches |
| Genie-app view follows existing patterns | Same stack: React 19 + Vite + NATS req/reply + pg-bridge. Lazy-loaded view in manifest.ts/components.ts. Reuses shared components (ChatBubble, SearchBar, KpiCard, LoadingState) |
| Annotation UI in app, not CLI-only | Human annotation requires reviewing full transcripts with context — WhatsApp-like chat replay is far more usable than CLI for this |

## Success Criteria

- [ ] `genie sim create <name> --source <omni-chat-id>` extracts a real conversation into an anonymized sim agent under `.genie/simulations/`
- [ ] `genie sim run <scenario> --target <agent>@<branch>` spawns both agents through Omni, produces a scored result in PG
- [ ] `genie sim run --all --target <agent>@<branch>` runs all scenarios with wave-based concurrency, produces aggregate 0-100 score
- [ ] `genie sim results [--run <id>]` shows per-scenario and aggregate scores from PG
- [ ] `genie sim list` lists available scenarios for an agent
- [ ] `genie sim annotate <scenario> --run <id>` allows human verdict (up/down) per turn or scenario, stored in PG
- [ ] Sim agent is a standard genie agent (AGENTS.md frontmatter, same spawn mechanics as any agent)
- [ ] Target agent runs from specified git branch, completely unaware it's being simulated
- [ ] All conversations flow through real Omni instance (dedicated sim channel captures side effects)
- [ ] LLM-as-judge scores each scenario across applicable dimensions with reasoning persisted
- [ ] Full transcript (turns, tool calls, latency) stored in PG, sufficient for UI reconstruction
- [ ] Scenarios that loop or error score 0, with status recorded (loop/error/done)
- [ ] `/simulate` skill registered for interactive simulation piloting
- [ ] `simulator` agent type registered in genie's built-in agent types
- [ ] PII anonymization enforced at scenario creation time — no raw customer data in repo
- [ ] Genie-app "Simulations" view shows runs list with aggregate scores, click-through to scenario breakdown
- [ ] Transcript replay renders as WhatsApp-like chat bubbles (reuses ChatBubble shared component)
- [ ] Per-dimension score breakdown visible per scenario with LLM judge reasoning
- [ ] Human can annotate (thumbs up/down) individual turns in the app, annotations persist to PG
- [ ] Real-time run progress updates via NATS subscription (scenarios completing as they finish)

## Execution Strategy

### Wave 1 (parallel — foundations)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | PG schema: migration for simulation tables |
| 2 | engineer | Sim agent convention: loader, validator, frontmatter spec |

### Wave 2 (parallel — after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Scenario extraction: `genie sim create` + PII anonymizer |
| 4 | engineer | Simulation service: orchestrator + Omni session injection |

### Wave 3 (parallel — after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Scoring pipeline: LLM judge + dimension evaluators |
| 6 | engineer | CLI commands: `genie sim` namespace + `/simulate` skill |

### Wave 4 (parallel — after Wave 3)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Session lifecycle: `genie sim done`, turn cap, stale cleanup, annotation storage |
| 8 | engineer | Backend: NATS subjects + PG query handlers for simulation data |

### Wave 5 (parallel — after Wave 4)
| Group | Agent | Description |
|-------|-------|-------------|
| 9 | engineer | App: Simulations view — runs dashboard, scenario list, score breakdown |
| 10 | engineer | App: Transcript replay + human annotation UI |

### Wave 6 (after Wave 5)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: PG Schema — Simulation Tables
**Goal:** Create the database schema for storing simulation runs, scenarios, turns, scores, and annotations.

**Deliverables:**
1. Migration file creating 5 tables: `genie_sim_runs`, `genie_sim_scenarios`, `genie_sim_turns`, `genie_sim_scores`, `genie_sim_annotations`
2. Indexes for common queries: runs by agent, scenarios by run, turns by scenario, annotations by turn

**Schema:**
```
genie_sim_runs
├── id (uuid PK), target_agent, target_branch, executor_type
├── sim_instance_id (Omni instance used), started_at, completed_at
├── status (pending|running|done|error)
├── total_scenarios, completed_scenarios
└── aggregate_score (numeric 0-100)

genie_sim_scenarios
├── id (uuid PK), run_id (FK), sim_agent_name, scenario_slug
├── status (pending|running|done|loop|error)
├── score (numeric 0.00-1.00), turn_count
├── started_at, completed_at
└── scoring_weights (jsonb)

genie_sim_turns
├── id (uuid PK), scenario_id (FK), turn_number
├── role (sim|target), content (text), message_type (text|audio|image)
├── tool_calls (jsonb), latency_ms (int)
├── timestamp, omni_message_id
└── INDEX (scenario_id, turn_number)

genie_sim_scores
├── id (uuid PK), scenario_id (FK), dimension (text)
├── score (numeric 0.00-1.00), weight (numeric)
├── reasoning (text), evidence (jsonb)
└── INDEX (scenario_id, dimension)

genie_sim_annotations
├── id (uuid PK), turn_id (FK nullable), scenario_id (FK)
├── annotator (text), verdict (up|down)
├── comment (text nullable), created_at
└── INDEX (scenario_id)
```

**Acceptance Criteria:**
- [ ] Migration runs cleanly on a fresh DB
- [ ] All FK constraints and indexes are present
- [ ] Schema supports full transcript reconstruction (turns ordered by turn_number)

**Validation:**
```bash
bun run migrate && bunx tsc --noEmit
```

**depends-on:** none

---

### Group 2: Sim Agent Convention — Loader and Validator
**Goal:** Define and implement the sim agent format, loader, and validator so sim agents follow genie's standard agent conventions.

**Deliverables:**
1. `src/services/simulator/sim-loader.ts` — loads `.genie/simulations/<scenario>/AGENTS.md`, validates frontmatter, returns structured scenario config
2. Sim agent frontmatter spec: extends standard genie agent frontmatter with sim-specific fields (`scenario_slug`, `target_agent`, `scoring_dimensions`, `source_conversation`, `max_turns`)
3. `src/services/simulator/pii-anonymizer.ts` — utility for replacing PII (names, phones, CPFs, addresses) with fictional equivalents during scenario creation

**Acceptance Criteria:**
- [ ] Sim agent AGENTS.md uses standard genie frontmatter (parseable by existing agent-sync)
- [ ] Loader validates required sim fields and returns typed ScenarioConfig
- [ ] PII anonymizer handles Brazilian PII patterns (CPF, phone +55, common names)

**Validation:**
```bash
bunx biome check src/services/simulator/ && bunx tsc --noEmit
```

**depends-on:** none

---

### Group 3: Scenario Extraction — `genie sim create`
**Goal:** CLI command that extracts a real Omni conversation into an anonymized sim agent scaffold.

**Deliverables:**
1. `src/term-commands/sim/create.ts` — pulls conversation history from Omni API, anonymizes PII, generates `.genie/simulations/<name>/AGENTS.md` with persona + roleplay script + scoring config
2. Conversation fetcher: uses Omni API (or SSH to remote server) to retrieve full chat history
3. Output: ready-to-edit sim agent directory with AGENTS.md, source.md (anonymized source reference), scoring.md (applicable dimensions + weights)

**Acceptance Criteria:**
- [ ] `genie sim create <name> --source <chat-id> [--instance <id>] [--server <ssh-host>]` produces a complete sim agent directory
- [ ] All PII in output files is replaced with fictional data
- [ ] Generated AGENTS.md is a valid genie agent (parseable frontmatter, clear persona and roleplay script)
- [ ] source.md records which conversation inspired the scenario (anonymized)

**Validation:**
```bash
bunx biome check src/term-commands/sim/ && bunx tsc --noEmit
```

**depends-on:** Group 2

---

### Group 4: Simulation Service — Orchestrator + Omni Session Injection
**Goal:** Core simulation engine that spawns sim agents and target agents through real Omni sessions.

**Deliverables:**
1. `src/services/simulator/orchestrator.ts` — loads scenarios, manages wave-based concurrency, tracks run state in PG, coordinates spawn/teardown
2. `src/services/simulator/sim-session.ts` — creates Omni sessions for sim agent ↔ target agent pairs, injects messages through NATS, captures replies
3. Integration with omni-bridge: sim sessions use the same executor interface (tmux or SDK) for the target agent
4. Sim agent spawned as a genie agent with its AGENTS.md persona, connected to the sim Omni instance
5. `genie sim run <scenario> --target <agent>@<branch>` single-scenario runner
6. `genie sim run --all --target <agent>@<branch> [--concurrency <n>]` full-suite runner with wave-based concurrency

**Acceptance Criteria:**
- [ ] Single scenario: sim agent and target agent exchange messages through real Omni
- [ ] Target agent is unaware it's a simulation (receives standard Omni messages)
- [ ] Full suite: scenarios run in waves respecting concurrency limit
- [ ] Run state tracked in `genie_sim_runs` and `genie_sim_scenarios` tables
- [ ] Every turn persisted to `genie_sim_turns` with content, tool calls, latency, omni_message_id

**Validation:**
```bash
bunx biome check src/services/simulator/ && bunx tsc --noEmit
```

**depends-on:** Group 1, Group 2

---

### Group 5: Scoring Pipeline — LLM Judge + Dimension Evaluators
**Goal:** Compound scoring system that evaluates completed simulation transcripts across 9 dimensions.

**Deliverables:**
1. `src/services/simulator/judge.ts` — LLM-as-judge (Gemini Flash or Claude Haiku for cost), evaluates a transcript against a single dimension, returns score + reasoning + evidence
2. `src/services/simulator/dimensions/` — one evaluator per dimension:
   - `script-adherence.ts` — checks agent followed expected conversation flow
   - `goal-completion.ts` — checks if scenario objective was achieved
   - `response-quality.ts` — per-turn quality assessment (accuracy, tone, helpfulness)
   - `latency.ts` — threshold-based scoring from measured turn latencies
   - `tool-usage.ts` — checks correct tools called at correct times
   - `recovery.ts` — checks handling of off-script/adversarial input
   - `hallucination.ts` — checks against agent's KB ground truth
   - `instruction-compliance.ts` — checks against agent's rules (AGENTS.md, .claude/rules/*)
   - `human-eval.ts` — aggregates human annotations into a score
3. `src/services/simulator/scorer.ts` — runs applicable dimensions per scenario (from scoring.md weights), computes weighted average, persists to `genie_sim_scores`
4. Aggregate score calculator: sum of per-scenario scores → 0-100

**Acceptance Criteria:**
- [ ] Each dimension produces a 0.00-1.00 score with reasoning text and evidence (turn references)
- [ ] Scorer respects per-scenario dimension selection and weights from scoring.md
- [ ] All scores + reasoning persisted to `genie_sim_scores` table
- [ ] Aggregate score computed and stored on `genie_sim_runs.aggregate_score`
- [ ] Instruction compliance evaluator loads agent's actual rules from its repo

**Validation:**
```bash
bunx biome check src/services/simulator/ && bunx tsc --noEmit
```

**depends-on:** Group 1, Group 4

---

### Group 6: CLI Commands + `/simulate` Skill
**Goal:** User-facing CLI namespace and skill for managing simulations.

**Deliverables:**
1. `src/term-commands/sim/index.ts` — `genie sim` command group registration
2. `src/term-commands/sim/run.ts` — `genie sim run` (single + --all)
3. `src/term-commands/sim/results.ts` — `genie sim results [--run <id>]` with table output
4. `src/term-commands/sim/list.ts` — `genie sim list` shows available scenarios
5. `src/term-commands/sim/annotate.ts` — `genie sim annotate <scenario> --run <id>` for CLI-based human verdicts
6. `skills/simulate.md` — `/simulate` skill prompt for interactive simulation piloting
7. Register `simulator` agent type in genie's built-in agent registry

**Acceptance Criteria:**
- [ ] `genie sim` shows help with all subcommands
- [ ] `genie sim results` renders table with scenario scores and run aggregate
- [ ] `genie sim list` shows scenarios with status (has sim agent, last run score)
- [ ] `/simulate` skill loads and routes to appropriate sim commands
- [ ] `simulator` type appears in `genie agent directory`

**Validation:**
```bash
bunx biome check src/term-commands/sim/ skills/simulate.md && bunx tsc --noEmit
```

**depends-on:** Group 4, Group 5

---

### Group 7: Session Lifecycle — Exit Signals, Turn Cap, Cleanup, Annotations
**Goal:** Production-grade lifecycle management for sim sessions.

**Deliverables:**
1. `genie sim done` command — sim agent calls this to signal scenario completion, triggers scoring pipeline, tears down both sessions
2. Turn cap enforcement: orchestrator kills sessions at 100 turns (configurable), marks scenario status as `loop`, scores 0
3. Stale session cleanup: reuse omni-bridge's pattern (PG tracking, orphan detection on restart)
4. Annotation storage: `genie sim annotate` writes to `genie_sim_annotations`, human-eval dimension reads from it
5. Error handling: if sim or target agent crashes, mark scenario as `error`, score 0, clean up sessions

**Acceptance Criteria:**
- [ ] `genie sim done` from inside a sim agent triggers scoring and teardown within 5s
- [ ] Sessions hitting 100-turn cap are killed and scored 0 with status `loop`
- [ ] Orphaned sim sessions are detected and cleaned up on restart
- [ ] Annotations persist to PG and are reflected in human-eval dimension score
- [ ] Crashed scenarios are marked `error` with cleanup, don't block the run

**Validation:**
```bash
bunx biome check src/services/simulator/ src/term-commands/sim/ && bunx tsc --noEmit
```

**depends-on:** Group 4, Group 5, Group 6

---

### Group 8: Backend — NATS Subjects + PG Query Handlers
**Goal:** Backend data layer for the genie-app Simulations view, following the existing pg-bridge + NATS req/reply pattern.

**Deliverables:**
1. `packages/genie-app/lib/subjects.ts` — add `simulations` domain with subjects: `simulations.runs`, `simulations.scenarios`, `simulations.turns`, `simulations.scores`, `simulations.annotate`
2. `packages/genie-app/src-backend/pg-bridge.ts` — add PG query handlers for:
   - `simulations.runs` — list runs with aggregate scores, filter by agent/branch/status
   - `simulations.scenarios` — list scenarios for a run with per-scenario scores
   - `simulations.turns` — get full transcript for a scenario (ordered turns with tool calls, latency)
   - `simulations.scores` — get per-dimension score breakdown with reasoning for a scenario
   - `simulations.annotate` — write human annotation (turn-level or scenario-level verdict)
3. NATS event bridge: add `sim_scenario_complete` and `sim_run_complete` PG LISTEN/NOTIFY channels for real-time UI updates

**Acceptance Criteria:**
- [ ] All 5 NATS subjects registered and handled in pg-bridge
- [ ] Queries return typed responses matching the PG schema from Group 1
- [ ] Annotation writes validate input (verdict must be up/down, turn_id or scenario_id required)
- [ ] Real-time events bridged so the UI can subscribe to run progress

**Validation:**
```bash
bunx biome check packages/genie-app/src-backend/ packages/genie-app/lib/subjects.ts && bunx tsc --noEmit
```

**depends-on:** Group 1, Group 7

---

### Group 9: App — Simulations View (Runs Dashboard + Scenario List)
**Goal:** Main Simulations view in genie-app showing runs and scenario breakdowns.

**Deliverables:**
1. `packages/genie-app/views/simulations/ui/SimulationsView.tsx` — main view with:
   - **Runs list** — table showing all runs with: target agent, branch, date, status, aggregate score (0-100), scenario progress (completed/total)
   - **Run detail** — click a run to see scenario breakdown table: scenario name, status (done/loop/error), score, turn count, duration
   - **Score breakdown** — expandable per-scenario showing 9-dimension radar or bar chart with LLM judge reasoning
   - **KPI cards** — top bar with: latest score, score trend (vs previous run), pass rate, avg latency
2. `packages/genie-app/manifest.ts` — register Simulations view entry
3. `packages/genie-app/components.ts` — add lazy import for SimulationsView
4. `src/App.tsx` — add Simulations to NAV_ITEMS

**Acceptance Criteria:**
- [ ] "Simulations" appears in sidebar nav
- [ ] Runs list loads from NATS `simulations.runs` subject
- [ ] Click-through from run → scenario list → score breakdown works
- [ ] Real-time updates: new scenario completions appear without manual refresh
- [ ] Reuses shared components: SearchBar, LoadingState, ErrorState, EmptyState, KpiCard

**Validation:**
```bash
bunx biome check packages/genie-app/views/simulations/ && bunx tsc --noEmit
```

**depends-on:** Group 8

---

### Group 10: App — Transcript Replay + Human Annotation
**Goal:** WhatsApp-like transcript replay with per-turn annotation capability.

**Deliverables:**
1. Transcript panel in SimulationsView (or sub-component):
   - **Chat replay** — WhatsApp-style bubbles using shared `ChatBubble` component. Sim agent messages on left (as "customer"), target agent messages on right. Tool calls rendered inline via `ToolCallCard`
   - **Per-turn metadata** — latency badge, timestamp, tool calls expandable
   - **Annotation controls** — thumbs up/down button on each turn bubble. Click persists to PG via `simulations.annotate` NATS subject
   - **Scenario-level annotation** — summary verdict (up/down + optional comment) at bottom of transcript
2. Score overlay: alongside transcript, show per-dimension scores with reasoning expandable
3. Annotation summary: visual indicator showing how many turns have been annotated vs total

**Acceptance Criteria:**
- [ ] Transcript loads from `simulations.turns` and renders as chat bubbles
- [ ] Sim agent (customer) messages on left, target agent on right — visually distinct
- [ ] Thumbs up/down on each turn persists to PG immediately
- [ ] Scenario-level annotation with optional comment supported
- [ ] Tool calls rendered inline (expandable) using existing ToolCallCard
- [ ] Annotation count shown (e.g. "12/18 turns annotated")

**Validation:**
```bash
bunx biome check packages/genie-app/views/simulations/ && bunx tsc --noEmit
```

**depends-on:** Group 8, Group 9

---

## QA Criteria

- [ ] Full simulation run (at least 3 scenarios) completes end-to-end with scores in PG
- [ ] Sim agent and target agent converse through real Omni with no awareness leak
- [ ] `genie sim results` displays correct aggregate and per-scenario scores
- [ ] Turn cap triggers correctly at configured limit
- [ ] `genie sim create` produces anonymized scenario with no real PII in output
- [ ] Scoring pipeline produces per-dimension breakdown with reasoning
- [ ] Genie-app Simulations view loads, displays runs, and navigates to scenario detail
- [ ] Transcript replay renders correctly with chat bubbles and tool calls
- [ ] Human annotation persists and reflects in human-eval dimension score
- [ ] `bun run check` passes (typecheck + lint + dead-code + test)

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Infinite loops between agents | Medium | 100-turn hard cap + `genie sim done` exit signal. Loops score 0 |
| Lost/orphaned sim sessions | Low | Same recovery pattern as omni-bridge (PG tracking, stale cleanup) |
| PII leakage in scenario files | High | Anonymization mandatory at extraction. Never store raw customer data in repo |
| Tool side effects during sim | Medium | Dedicated sim Omni instance/channel captures all side effects (handoffs, replies) |
| Cost (LLM calls for judge + 2 agents per scenario) | Medium | Budget per run. Use Haiku/Gemini Flash for judge. Wave concurrency limits blast radius |
| Sim agent recognized as AI by target | Low | Full persona roleplay with realistic WhatsApp patterns. Target has no detection mechanism |
| Omni instance availability | Medium | Sim requires running Omni with dedicated sim instance. `genie sim` checks prerequisites |
| Large PG data volume (100 scenarios × ~20 turns × multiple runs) | Low | Partition by run_id. Archive old runs. Turn content is text, not large |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
# New files
src/services/simulator/orchestrator.ts       — Core simulation engine
src/services/simulator/sim-session.ts        — Omni session injection for sim pairs
src/services/simulator/sim-loader.ts         — Scenario loader + validator
src/services/simulator/pii-anonymizer.ts     — PII detection and replacement
src/services/simulator/judge.ts              — LLM-as-judge core
src/services/simulator/scorer.ts             — Weighted scoring aggregator
src/services/simulator/dimensions/           — Per-dimension evaluators (9 files)
src/term-commands/sim/index.ts               — CLI command group
src/term-commands/sim/create.ts              — genie sim create
src/term-commands/sim/run.ts                 — genie sim run
src/term-commands/sim/results.ts             — genie sim results
src/term-commands/sim/list.ts                — genie sim list
src/term-commands/sim/annotate.ts            — genie sim annotate
src/term-commands/sim/done.ts                — genie sim done
skills/simulate.md                           — /simulate skill prompt
migrations/XXXX_create_simulation_tables.sql — PG schema

# App — backend
packages/genie-app/lib/subjects.ts           — Add simulations NATS subjects
packages/genie-app/src-backend/pg-bridge.ts  — Add simulation PG query handlers

# App — frontend
packages/genie-app/views/simulations/ui/SimulationsView.tsx — Main view (runs, scenarios, scores)
packages/genie-app/manifest.ts               — Register Simulations view
packages/genie-app/components.ts             — Add lazy import
packages/genie-app/src/App.tsx               — Add Simulations to NAV_ITEMS

# Modified files
src/genie.ts                                 — Register sim command group
src/lib/agent-types.ts                       — Add simulator to built-in types
```
