# 🧞 CORE/TEMPLATE AGENT SEPARATION WISH

**Status:** IN PROGRESS
**Roadmap Item:** NEW – Framework restructuring for clean core/template separation
**Mission Link:** @.genie/product/mission.md §Framework Architecture
**Standards:** @.genie/standards/best-practices.md §Code Organization
**Completion Score:** 25/100 (last review: 2025-10-07T04:40Z — see `qa/review-parent-wish-202510070440.md`)

## Evaluation Matrix (100 Points Total)

### Discovery Phase (30 pts)
- **Context Completeness (10 pts)**
  - [x] All relevant files/docs referenced with @ notation (4 pts)
  - [x] Agent inventory complete with categorization (3 pts)
  - [ ] Template content audit verified (3 pts)
- **Scope Clarity (10 pts)**
  - [x] Clear distinction between core and template defined (3 pts)
  - [x] Spec contract complete with success metrics (4 pts)
  - [x] Out-of-scope explicitly stated (3 pts)
- **Evidence Planning (10 pts)**
  - [x] Validation commands specified with exact syntax (4 pts)
  - [ ] Migration path documented (3 pts)
  - [x] Approval checkpoints documented (3 pts)

### Implementation Phase (40 pts)
- **Code Quality (15 pts)**
  - [ ] Clean directory structure (core vs templates/) (5 pts)
  - [ ] Minimal breaking changes to existing users (5 pts)
  - [x] Clear @include path conventions (5 pts)
- **Test Coverage (10 pts)**
  - [ ] Init script tested in clean environment (4 pts)
  - [ ] Template copy verification tests (4 pts)
  - [ ] MCP agent resolution tests (2 pts)
- **Documentation (5 pts)**
  - [x] AGENTS.md updated with new structure (2 pts)
  - [ ] Migration guide created (2 pts)
  - [x] README architecture section updated (1 pt)
- **Execution Alignment (10 pts)**
  - [x] Stayed within spec contract scope (4 pts)
  - [x] No unapproved scope creep (3 pts)
  - [x] Dependencies and sequencing honored (3 pts)

### Verification Phase (30 pts)
- **Validation Completeness (15 pts)**
  - [ ] Init creates correct template structure (6 pts)
  - [ ] Core agents accessible in all projects (5 pts)
  - [ ] Existing workflows unbroken (4 pts)
- **Evidence Quality (10 pts)**
  - [ ] Before/after directory structure comparison (4 pts)
  - [ ] Init command output captured (3 pts)
  - [ ] Agent resolution proof provided (3 pts)
- **Review Thoroughness (5 pts)**
  - [ ] Human approval obtained before merge (2 pts)
  - [ ] All blockers resolved or documented (2 pts)
  - [ ] Status log updated with completion timestamp (1 pt)

## Context Ledger

| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| User clarification | feedback | MCP config is `npx automagik-genie mcp` | wish, implementation |
| User clarification | feedback | .genie/ is Genie's own (meta), templates/ is external | wish, implementation |
| User clarification | feedback | Orchestrator is the mode router agent | categorization |
| User clarification | feedback | Templates are one-way: Genie → user projects | implementation |
| Agent inventory | discovery | 30 agents total: 6 top-level + 10 core + 14 modes | categorization |
| Reality check | validation | CLI: `genie list agents` (not `genie agents list`) | verification |
| @.genie/agents/core/install.md | repo | Current init logic and setup modes | implementation |
| templates/ directory | discovery | Already exists with templates/.claude/commands/ | implementation |
| .genie/ directories | discovery | entrypoints, core prompts, custom overrides, qa, guides, standards, product, instructions | audit |

## Discovery Summary

- **Primary analyst:** Human + Agent
- **Key observations:**
  - Genie repository uses `.genie/` for its own development (meta-level)
  - `templates/` directory already exists at repo root with `.claude/commands/` subdirectory
- 30 agents cataloged: 6 top-level + 10 core delivery + 14 orchestrator modes
  - MCP config is straightforward npm package invocation, no dynamic path resolution needed
  - Template system is one-way: init copies to user projects, no upstream sync
- **Assumptions (ASM-#):**
- **ASM-1:** Core agents (plan, wish, forge, review, genie/orchestrator, install, prompt, learn) are stable framework APIs that should never be copied
  - **ASM-2:** Template agents are starter kits customized per-project with no upstream sync
  - **ASM-3:** MCP server can load core agents from npm package installation automatically
  - **ASM-4:** `templates/` directory structure mirrors user project layout (`.claude/`, `.genie/`)
- **Open questions (Q-#):**
  -  - ~~Q-2: How to handle template updates?~~ **RESOLVED: One-way copy, no sync back**
  - ~~Q-3: What about standards/product docs?~~ **RESOLVED: Include in templates/**
  - ~~Q-4: MCP config strategy?~~ **RESOLVED: Simple npx invocation**
- **Risks:**
  - **RISK-1:** Breaking existing projects if migration not handled correctly
  - **RISK-2:** Template content incompleteness (missing essential scaffolding files)
  - **RISK-3:** Confusion between Genie's own .genie/ and template structure

## Executive Summary

Separate Genie framework's built-in agents (core workflow orchestrators and supporting personas) from user-customizable templates. Core agents remain in the npm package and load automatically via MCP; template agents/docs are copied to user projects during `genie init` for project-specific customization. This enables Genie to evolve its core APIs without breaking user customizations, while providing rich starter templates.

## Current State

**Genie's Structure (Meta-Level):**
- `.genie/agents/` keeps entrypoints at the root (plan, wish, forge, review, orchestrator, vibe) and delivery/utility prompts under `core/`
- `.genie/custom/` stores project overrides that core prompts auto-include when present
- `.genie/custom/` stores project overrides that core prompts auto-include when present
- `.claude/commands/` and `.claude/agents/` provide slash command and Task tool aliases via @include
- `templates/` directory exists at repo root with initial `.claude/commands/` structure
- MCP server published as `automagik-genie` npm package

**User Projects (Post-Init):**
- Currently copies everything from Genie's `.genie/` into user project
- No distinction between framework-essential and customizable
- Updates to Genie core require manual merges in user projects

**Gaps/Pain Points:**
- Core workflow agents get copied unnecessarily
- Users modify core agents, breaking framework assumptions
- Template updates don't propagate cleanly
- Confusion between Genie's own development setup and template structure
- Command wrappers temporarily point back at `@.genie/agents/<entrypoint>.md` (as of 2025-10-06) until the entrypoint files migrate into `core/`.

## Target State & Guardrails

**Desired Behavior:**

1. **Core Agents (Built-In):**
   - Live in npm package under `dist/templates/core/` or similar
   - Loaded automatically by MCP server
   - Never copied to user projects
   - Provide stable workflow APIs (plan → wish → forge → review)
  - Include framework core agents (install, prompt, learn, genie orchestrator)

2. **Template Structure:**
   - Located at `templates/` in Genie repository root
   - Mirrors user project structure (`.genie/`, `.claude/`)
   - Contains customizable agents, standards, product scaffolding
   - Copied wholesale during `genie init`
   - Populated with project context ({{PROJECT_NAME}}, etc.)

3. **MCP Configuration:**
   - Users add to `.claude/settings.json`:
     ```json
     "genie": {
       "command": "npx",
       "args": ["-y", "automagik-genie", "mcp"]
     }
     ```
   - MCP server auto-discovers core agents from package
   - MCP server resolves user agents from project `.genie/agents/`

**Non-Negotiables:**
- Zero breaking changes to existing user workflows
- Clean separation: meta (Genie's own .genie/) vs templates/ vs core (npm package)
- One-way template propagation (no upstream sync)
- Fast agent resolution (<100ms)

## Alias Updates ✅ COMPLETED

### Commands Updated:
- Root agents: `plan`, `wish`, `forge`, `review`, `orchestrator`, `vibe` → `@.genie/agents/<name>.md`
- Core helpers: `commit`, `codereview`, `docgen`, `refactor`, `secaudit`, `testgen`, `tracer`, along with support agents (`analyze`, `debug`, etc.) → `@.genie/agents/core/<name>.md`
- Custom stubs: `.genie/custom/<mode>.md` auto-load with each core prompt for repository-specific guidance
- Genie-only: `genie-qa` → `@.genie/agents/qa/genie-qa.md`

## Execution Groups

### Phase 0 – Genie Mode Consolidation
- **Goal:** Enumerate all Genie modes with core prompts and matching project configuration includes, and keep orchestrator/MCP routing consistent.
- **Surfaces:**
  - @.genie/agents/orchestrator.md
  - @.genie/custom/orchestrator.md
  - @.genie/agents/core/modes/<mode>.md and @.genie/custom/<mode>.md for analyze, challenge, codereview, consensus, deep-dive, design-review, docgen, explore, refactor, risk-audit, secaudit, test-strategy, testgen, tracer
  - @.genie/mcp/src/server.ts (orchestrator prompt helper)
- **Deliverables:**
  - ✅ Mode consolidation (socratic/debate/challenge merged, thinkdeep→explore, bloat variants removed) — commit 544bd0d, score 92/100
  - ✅ All 14 orchestrator modes have matching `.genie/custom/<mode>.md` stubs — commit 96f3ca2
  - ✅ MCP wrapper documents mode selection via `agent="orchestrator"` prompts (orchestrator.md updated)
  - ✅ AGENTS.md lists the mode matrix with core/custom references
- **Evidence:**
  - Mode consolidation: `qa/review-mode-consolidation-202510070437.md`, `reports/commit-advice-mode-consolidation-202510070431.md`
  - Full Phase 0: `.genie/wishes/core-template-separation/qa/group-a/genie-consolidation.md` (pending)
- **Suggested personas:** `analyze`, `orchestrator`
- **External tracker:** TBD
### Phase 1 – Meta-Learning Unification
- **Goal:** Merge the legacy self-learn behaviours into the unified learn agent while preserving violation logging.
- **Surfaces:**
  - @.genie/agents/core/learn.md
  - @.genie/custom/learn.md
  - @.claude/commands/learn.md
  - @AGENTS.md §behavioral_learnings
- **Deliverables:**
  - ✅ Unified `learn` agent replaces legacy self-learn behaviour with violation + pattern support
  - ✅ Command wrappers point exclusively at the unified agent (no aliases)
  - ✅ Done Report / Learning Report templates updated with new `done-learn-<slug>-<timestamp>.md` convention
- **Evidence:** `.genie/wishes/core-template-separation/qa/group-b/meta-learn-merge.md` capturing diffs and command smoke
- **Suggested personas:** `implementor`, `tests`
- **External tracker:** TBD

### Phase 2 – Core Delivery Catalog Rationalization
- **Goal:** Collapse legacy delivery prompts into the `core/` directory with matching `.genie/custom/<name>.md` includes for project overrides.
- **Surfaces:**
  - Core delivery/utility prompts: @.genie/agents/core/{commit,debug,git-workflow,implementor,install,learn,polish,prompt,qa,tests}.md
  - Core modes: @.genie/agents/core/modes/{analyze,challenge,codereview,consensus,deep-dive,design-review,docgen,explore,refactor,risk-audit,secaudit,test-strategy,testgen,tracer}.md
  - Custom configuration files: @.genie/custom/<name>.md for the same set
  - `.claude/` aliases referencing these prompts
- **Deliverables:**
  - All delivery/utility prompts live under `.genie/agents/core/` with project customization in `.genie/custom/`
  - `.claude/` wrappers and template copies point to the new core paths
  - Agent resolver/AGENTS.md documentation reflects the flattened structure
- **Evidence:** `.genie/wishes/core-template-separation/qa/group-c/delivery-catalog.md` with agent inventory diff + CLI `genie list agents`
- **Suggested personas:** `implementor`, `codereview`
- **External tracker:** TBD

### Phase 3 – Documentation & Validation
- **Goal:** Document the new architecture and prove no regressions in agent discovery.
- **Surfaces:**
  - @AGENTS.md
  - @.genie/agents/README.md
  - @.genie/guides/migration-core-template.md (new)
  - @.claude/README.md
  - @.genie/wishes/core-template-separation/qa/
- **Deliverables:**
  - Updated docs describing core vs template split and Vibe naming convention
  - Migration guide detailing steps for existing installs
  - Recorded validation commands (agent inventory before/after, Genie mode smoke tests)
- **Evidence:** `.genie/wishes/core-template-separation/qa/group-d/docs-and-validation.md` + captured command outputs
- **Suggested personas:** `docgen`, `qa`
- **External tracker:** TBD

## Verification Plan

**Validation Steps:**

1. **Orchestrator Mode Verification:**
   ```bash
   # Verify modes exist
   ls -1 .genie/agents/core/modes/*.md | wc -l  # Should be 14

   # Verify orchestrator can be invoked via MCP
   # Mode selection happens IN PROMPT, not via CLI flags
   # Example: mcp__genie__run with agent="orchestrator" and prompt="Mode: refactor. ..."
   ```

2. **Learn Command Check:**
   ```bash
   claude /learn "Violation: placeholder
   Evidence: placeholder
   Correction: placeholder
   Validation: placeholder
   Target: @AGENTS.md"
   claude /learn "Pattern: placeholder
   Description: placeholder
   Example: placeholder
   Evidence: @AGENTS.md"
   ```

3. **Agent Catalog Verification:**
   ```bash
   genie list agents > .genie/wishes/core-template-separation/qa/agents-after.txt

   # Verify agent counts
   ls -1 .genie/agents/*.md | wc -l  # Should be 7 (6 agents + README)
   ls -1 .genie/agents/core/*.md | wc -l  # Should be 10
   ls -1 .genie/agents/core/modes/*.md | wc -l  # Should be 14

   # Total: 30 agent files (6 + 10 + 14)
   ```

4. **Documentation Consistency:**
   ```bash
   mdspell AGENTS.md .genie/agents/README.md .genie/guides/migration-core-template.md
   ```

5. **Vibe Agent Verification:**
   ```bash
   # Verify vibe exists (not sleepy)
   ls .genie/agents/vibe.md && echo "✓ vibe.md exists"
   rg -n "vibe" .claude/commands | grep -v "# " && echo "✓ vibe references found"
   ```

**Evidence Storage:** `.genie/wishes/core-template-separation/qa/`

**Branch Strategy:** Dedicated branch `feat/core-template-separation`

### Evidence Checklist

- **Validation commands (exact):**
  - `pnpm test` (if unit tests exist)
  - `npx automagik-genie init` in clean directory
  - `/plan` command in test project
  - `ls -R templates/` to verify structure
  - `git diff main --stat` to review changes
- **Artifact paths (where evidence lives):**
  - `.genie/wishes/core-template-separation/agent-categorization.md`
  - `.genie/wishes/core-template-separation/qa/init-test-output.log`
  - `.genie/wishes/core-template-separation/qa/directory-structure.txt`
  - `.genie/wishes/core-template-separation/qa/mcp-resolution-test.md`
- **Approval checkpoints (human sign-off required):**
  - Agent categorization matrix (Group A completion)
  - Template directory structure (Group B completion)
  - Init script changes (Group C completion before testing)
  - Migration guide accuracy (Group D completion)

## Agent Inventory & Categorization (FINAL)

**Total:** 30 prompt files shipped in `.genie/agents/` (6 top-level + 10 core + 14 modes), customization stubs in `.genie/custom/`, 1 Genie-only QA helper.

**Meta Pattern:** Entry-point orchestrators remain immutable. Delivery/utility prompts live under `.genie/agents/core/` and auto-include `.genie/custom/<agent>.md` if projects need overrides. Template exports will be wired up once this structure settles.

### CURRENT DIRECTORY STRUCTURE ✅ COMPLETED

```
.genie/agents/
├── plan.md                 # Entrypoint (immutable)
├── wish.md                 # Entrypoint (immutable)
├── forge.md                # Entrypoint (immutable)
├── review.md               # Entrypoint (immutable)
├── orchestrator.md         # Entrypoint (immutable)
├── vibe.md                 # Entrypoint (immutable)
├── core/                   # Delivery + utility prompts packaged with Genie
│   ├── analyze.md
│   ├── bug-reporter.md
│   ├── commit.md
│   ├── docgen.md
│   ├── git-workflow.md
│   ├── implementor.md
│   ├── prompt.md
│   ├── qa.md
│   ├── refactor.md
│   ├── tests.md
│   └── … (full catalog in AGENTS.md)
├── qa/
│   ├── genie-qa.md
│   └── README.md
└── README.md

.genie/custom/              # Project-level overrides loaded by core prompts
├── analyze.md
├── bug-reporter.md
├── git-workflow.md
├── implementor.md
├── qa.md
├── tests.md
└── …
```

### CORE DELIVERY AGENTS — `.genie/agents/core/` (10)

Packaged delivery agents that define Genie's default behaviour:

1. `commit.md` — Commit advisory / pre-commit checks
2. `debug.md` — Debug issues, root-cause analysis
3. `git-workflow.md` — Branching/merge automation
4. `implementor.md` — Feature implementation with TDD
5. `install.md` — Genie initialization and setup
6. `learn.md` — Meta-learning for framework improvements
7. `polish.md` — Linting, formatting, type-checking
8. `prompt.md` — Advanced prompting framework
9. `qa.md` — Manual QA coordination
10. `tests.md` — Test authoring + repair

### ORCHESTRATOR MODES — `.genie/agents/core/modes/` (14)

Reasoning modes loaded by orchestrator agent:

1. `analyze.md` — System architecture analysis
2. `challenge.md` — Critical evaluation (merged socratic/debate)
3. `codereview.md` — Severity-tagged code review
4. `consensus.md` — Multi-model decision synthesis
5. `deep-dive.md` — In-depth investigation
6. `design-review.md` — Component coupling/scalability review
7. `docgen.md` — Documentation outline + drafting
8. `explore.md` — Discovery-focused reasoning (renamed from thinkdeep)
9. `refactor.md` — Staged refactor planning
10. `risk-audit.md` — Risk enumeration + mitigation
11. `secaudit.md` — Security audit playbook
12. `test-strategy.md` — Layered testing approach
13. `testgen.md` — Targeted test generation
14. `tracer.md` — Instrumentation/observability plan

Entry-point files (`plan`, `wish`, `forge`, `review`, `orchestrator`, `vibe`) remain at the top level and never load overrides.

### CUSTOM OVERRIDES — `.genie/custom/`

Each stub mirrors its core counterpart and records project-specific defaults (commands, docs, evidence paths). Git includes but does not ship behaviour—core prompts remain the source of truth.

### GENIE-ONLY QA — `.genie/agents/qa/` (1)

1. `genie-qa.md` — Framework self-validation

### Template Scaffolding (Non-Agent Files)

**Standards:**
- `standards/best-practices.md`
- `standards/naming-conventions.md`
- `standards/tech-stack.md` (template with placeholders)

**Product Documentation:**
- `product/mission.md` (template)
- `product/mission-lite.md` (template)
- `product/roadmap.md` (template with phase structure)
- `product/tech-stack.md` (template)
- `product/environment.md` (template)
- `product/decisions.md` (ADR log template)

**Guides:**
- `guides/getting-started.md`
- `guides/onboarding.md`

**State:**
- `state/agents/sessions.json` (empty)

## <spec_contract>

**Scope:**
- ✅ Update orchestrator prompt to delegate to modes via `@.genie/agents/core/modes/*` references
- ✅ Merge the legacy self-learn flow into a single meta-learning learn agent and command wrapper
- Consolidate core delivery catalog (verify all 10 core agents + 14 modes documented)
- Refresh documentation (AGENTS.md, agents README, migration guide) and capture validation evidence
- Verify vibe agent exists and is properly referenced
- ✅ Adopt the wish folder convention (`.genie/wishes/<slug>/<slug>-wish.md`, `qa/`, `reports/`) and migrate existing artifacts

**Out of Scope:**
- New feature development beyond agent/document consolidation
- Automated migration tooling for downstream projects
- Changing behaviour of surviving core prompts (beyond re-routing and clarity edits)
- Publishing updated npm package (handled separately after verification)

**Success Metrics:**
- ✅ Orchestrator modes (refactor/testgen/secaudit/docgen/etc.) exist at `.genie/agents/core/modes/` (verified: 14 modes)
- ✅ Meta-learning agent passes both teaching and violation sample prompts without errors
- `genie list agents` shows 30 agents total (6 + 10 + 14) with correct structure
- Documentation updates approved with no TODO placeholders and spell-check clean
- `vibe` agent exists and is properly referenced (not "sleepy")
- ✅ Wishes store documents/reports/evidence under the nested folder structure

**External Tasks:**
- Forge execution group IDs (TBD after `/forge`)

**Dependencies:**
- Stable core delivery prompts (10): commit, debug, git-workflow, implementor, install, learn, polish, prompt, qa, tests
- Stable orchestrator modes (14): analyze, challenge, codereview, consensus, deep-dive, design-review, docgen, explore, refactor, risk-audit, secaudit, test-strategy, testgen, tracer
- CLI wrappers in `.claude/commands/`
- Agent registry via `genie list agents`

</spec_contract>

## Blocker Protocol

1. Pause work and create `reports/blocker-core-template-separation-<timestamp>.md` inside the wish folder describing findings.
2. Notify owner and wait for updated instructions.
3. Resume only after wish status/log is updated.

## Status Log

- [2025-10-06 13:00Z] Wish created (planning brief approved)
- [2025-10-07 04:31Z] **Phase 0 PARTIAL:** Orchestrator mode consolidation (5→3 core modes, removed bloat) — commit 544bd0d, score 92/100 — see `reports/commit-advice-mode-consolidation-202510070431.md` and `qa/review-mode-consolidation-202510070437.md`
- [2025-10-07 04:50Z] **Wish corrected against reality** — removed hallucinated commands/agents (bug-reporter, git-lifecycle, genie agents show --mode), fixed CLI syntax (genie list agents), corrected paths (core/modes/), updated agent counts (30 not 36) — see `qa/reality-check-202510070445.md`
- [2025-10-07 05:05Z] **Phase 0 COMPLETE:** All 14 orchestrator modes have custom stubs — commit 96f3ca2, created .genie/custom/explore.md
- [2025-10-07 17:45Z] **Phase 1 COMPLETE:** Meta-learning agent unified and wrappers updated — see `reports/done-learn-core-template-separation-20251007T1745Z.md`
- [Pending] Phase 2: Core delivery catalog consolidation applied
- [Pending] Phase 3: Documentation + migration evidence captured
- [Pending] Validation checklist complete
- [Pending] Human approval for merge
- [2025-10-06 23:25Z] CLI wrappers updated to new `core/` layout, wish assets migrated to folder structure (`.genie/wishes/core-template-separation/`), identity smoke + MCP integration adjusted to `genie` binary; `pnpm run test:genie` passing.
- [2025-10-06 15:20Z] Core prompts normalized to shared framework; project overrides moved to `.genie/custom/` with refreshed templates.
- [2025-10-06 14:45Z] Slash command includes retargeted to `.genie/agents/<name>.md` to restore `/plan`, `/wish`, `/forge`, `/review`, `/vibe`.

## Review Findings – 2025-10-06

- **Broken command includes (resolved 2025-10-06):** `.claude/commands/plan.md:7`, `wish.md:7`, `forge.md:7`, `review.md:7`, and `vibe.md:7` now point back to `@.genie/agents/<name>.md`, restoring the slash commands while the core/template move is still in flight.
- **Core prompt customization routed through `.genie/custom/`:** Entry-point agents remain immutable while each core delivery persona now exposes a `Project Customization` block wired to `.genie/custom/<agent>.md`; legacy `.genie/agents/custom/` references removed.
- **Template export pending:** `templates/` remains empty; distributable copies of the core/custom structure still need to be staged.
- **CLI smoke passing:** `pnpm run test:genie` succeeds with identity smoke test verifying the `**Identity**` block and the MCP integration invoking the installed `genie` binary; see `scripts/qa/bug1-validate.sh`, `tests/identity-smoke.sh`, `tests/mcp-*.js`.
- **Meta-learn merge completed (2025-10-07):** Legacy self-learn prompt retired; `learn.md` now embeds violation/pattern workflows, docs updated (`AGENTS.md`, `.claude/README.md`, `.genie/custom/learn.md`), and new `done-learn` reporting convention recorded.
- **Documentation drift (resolved 2025-10-06):** `AGENTS.md:32` and `@.genie/agents/README.md:6` now call out that entrypoints stay immutable while core prompts load `.genie/custom/` overrides.
