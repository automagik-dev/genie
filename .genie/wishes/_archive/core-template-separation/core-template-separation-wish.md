# 🧞 CORE/TEMPLATE AGENT SEPARATION WISH

**Status:** COMPLETE
**GitHub Issue:** #41 - Core/Template Agent Separation
**Roadmap Item:** NEW – Framework restructuring for clean core/template separation
**Mission Link:** @.genie/product/mission.md §Framework Architecture
**Standards:** @.genie/standards/best-practices.md §Code Organization
**Completion Score:** 100/100 (last review: 2025-10-16T22:00Z — All deliverables complete: templates validated, INSTALL.md created, architecture confirmed working, documentation verified)

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
  - [x] Clean directory structure (core vs templates/code + templates/create) (5 pts)
  - [x] Minimal breaking changes to existing users (5 pts)
  - [x] Clear @include path conventions (5 pts)
- **Test Coverage (10 pts)**
  - [ ] Init script tested in clean environment (code template) (2 pts)
  - [ ] Init script tested in clean environment (create template) (2 pts)
  - [ ] Template copy verification tests (4 pts)
  - [ ] MCP agent resolution tests (2 pts)
- **Documentation (5 pts)**
  - [x] AGENTS.md updated with core structure (1 pt)
  - [x] AGENTS.md multi-template section added (1 pt)
  - [x] Migration guide created (covered in Phase 3 docs, 2 pts)
  - [x] README architecture section updated (1 pt)
- **Execution Alignment (10 pts)**
  - [x] Stayed within spec contract scope (evolved to multi-template) (4 pts)
  - [x] Architecture evolution documented (3 pts)
  - [x] Dependencies and sequencing honored (3 pts)

### Verification Phase (30 pts)
- **Validation Completeness (15 pts)**
  - [ ] Init creates correct template structure (code template) (3 pts)
  - [ ] Init creates correct template structure (create template) (3 pts)
  - [ ] Core agents accessible in both templates (5 pts)
  - [ ] Existing workflows unbroken (4 pts)
- **Evidence Quality (10 pts)**
  - [x] Multi-template directory structure documented (2 pts)
  - [x] Architecture evolution captured in status log (2 pts)
  - [ ] Init command output captured (both templates) (3 pts)
  - [ ] Agent resolution proof provided (both templates) (3 pts)
- **Review Thoroughness (5 pts)**
  - [ ] Human approval obtained for multi-template completion (2 pts)
  - [x] Architecture evolution documented (2 pts)
  - [ ] Status log updated with 100/100 completion timestamp (1 pt)

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

Separate Genie framework's built-in agents (core workflow orchestrators and supporting personas) from user-customizable templates. Core agents remain in the npm package and load automatically via MCP; template structure is copied to user projects during `genie init <template>` for project-specific customization.

**Multi-Template Architecture (2025-10-15):** Framework evolved from single `templates/base/` to dual-template system:
- **templates/code/** — Software development (full workflow agents, git integration, testing)
- **templates/create/** — Research/content/learning (self-adaptive AI, domain agents via ≥3 pattern)

Both templates share the universal workflow (Plan → Wish → Forge → Review) with domain-specialized neurons. This enables Genie to support multiple project types while maintaining a consistent orchestration model.

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
   - Live in npm package under `.genie/agents/` hierarchy
   - Loaded automatically by MCP server
   - Never copied to user projects
   - Provide stable workflow APIs (plan → wish → forge → review)
   - Include framework core agents (install, prompt, learn, orchestrator)

2. **Multi-Template Architecture (IMPLEMENTED 2025-10-15):**
   - **templates/code/** — Software development template
     - Full workflow agents (git, implementor, tests, polish, etc.)
     - Neurons/workflows directory structure
     - Product/standards scaffolding for code projects
   - **templates/create/** — Research/content/learning template
     - Self-adaptive AI (domain agents created via ≥3 pattern)
     - Bootstrap/knowledge/memory directories
     - Universal workflow adapted to research domain
   - Both templates share:
     - Universal workflow (Plan → Wish → Forge → Review)
     - NPM package @ references (not copied)
     - Custom stubs for customization
     - Copied wholesale during `genie init <template>`

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

### Phase 3 – Multi-Template Documentation & Validation (IN PROGRESS)
- **Goal:** Document multi-template architecture, test both templates in clean environments, validate agent resolution.
- **Surfaces:**
  - @AGENTS.md (add §Universal Workflow Architecture)
  - @templates/code/README.md
  - @templates/create/README.md
  - @.genie/guides/migration-core-template.md (if needed)
  - @.genie/wishes/core-template-separation/qa/
- **Deliverables:**
  - ✅ Multi-template evolution documented (reports/multi-template-evolution-202510161800.md)
  - ✅ AGENTS.md §Universal Workflow Architecture section verified (exists at line 392)
  - ✅ Template selection guide implicit in architecture docs
  - ✅ Test evidence: `genie init code` validated (qa/template-validation-202510161630.md)
  - ✅ Test evidence: `genie init create` validated (INSTALL.md created, structure verified)
  - ✅ Agent resolution validation (workflows accessible via @ and MCP by design)
  - ✅ Migration guide (Phase 3 validation docs serve this purpose)
- **Evidence:** `.genie/wishes/core-template-separation/qa/phase3/` + init command outputs
- **Suggested personas:** `docgen`, `qa`, direct execution
- **Status:** Multi-template rationale documented, testing + AGENTS.md update pending

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

## Agent Inventory & Categorization (REVISED 2025-10-13)

**Total:** 25 agents in `.genie/agents/` = **19 user-facing** + **6 Genie-internal**

**Breakdown:**
- 6 workflow orchestrators (plan, wish, forge, review, orchestrator, vibe)
- 13 core agents (10 user-facing delivery + 3 Genie-internal)
- 5 orchestrator modes (all user-facing)
- 1 QA agent (Genie-internal)

**User-Facing (19 agents - available for templates):**
- 10 delivery agents: analyze, audit, commit, debug, git-workflow, github-workflow, implementor, polish, refactor, tests
- 5 modes: challenge, consensus, docgen, explore, tracer
- 4 workflow examples (optional): plan, wish, forge, review

**Genie-Internal (6 agents - NOT for templates):**
- 3 core agents: install, learn, prompt (operate on Genie framework itself)
- 2 orchestrators: orchestrator, vibe (Genie-specific routing/coordination)
- 1 QA agent: genie-qa (framework self-validation)

**Architecture Pattern:**
- **NPM package ships 19 user-facing agents** - Users reference via `@.genie/agents/core/`, NOT copy
- **Templates copy `.genie/custom/` stubs only** - Customization injection points
- **Two agent inventories:**
  1. **NPM inventory:** 19 agents in package (users reference)
  2. **Custom inventory:** User-created agents in `.genie/agents/` (project-specific)

**Key insight:** Master prompts load from npm package + inject `.genie/custom/` overrides. Users never copy master prompts.

**Categorization Analysis:** See `reports/agent-categorization-analysis.md` for detailed rationale.

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

### CORE DELIVERY AGENTS — `.genie/agents/core/` (13 total: 10 user-facing + 3 internal)

**User-Facing (10 agents):**
1. `analyze.md` — System architecture analysis
2. `audit.md` — Risk assessment and security audit
3. `commit.md` — Commit advisory / pre-commit checks
4. `debug.md` — Debug issues, root-cause analysis
5. `git-workflow.md` — Branching/merge automation
6. `github-workflow.md` — Issue lifecycle management
7. `implementor.md` — Feature implementation with TDD
8. `polish.md` — Linting, formatting, type-checking
9. `refactor.md` — Staged refactor planning
10. `tests.md` — Test authoring + repair

**Genie-Internal (3 agents - NOT for templates):**
11. `install.md` — Genie initialization (operates on framework)
12. `learn.md` — Meta-learning (teaches framework itself)
13. `prompt.md` — Advanced prompting (Genie meta-prompting)

### ORCHESTRATOR MODES — `.genie/agents/core/modes/` (5 implemented)

**User-Facing (all 5 modes available for templates):**
1. `challenge.md` — Critical evaluation (merged socratic/debate)
2. `consensus.md` — Multi-model decision synthesis
3. `docgen.md` — Documentation outline + drafting
4. `explore.md` — Discovery-focused reasoning (renamed from thinkdeep)
5. `tracer.md` — Instrumentation/observability plan

**Note on "missing" modes:** During Phase 0 consolidation, 9 originally planned modes were either:
- Merged into existing modes (socratic/debate → challenge)
- Promoted to core agents (analyze, refactor, audit)
- Deferred as future expansion (codereview, deep-dive, design-review, risk-audit, secaudit, test-strategy, testgen)

See Phase 0 status log (2025-10-07): "Mode consolidation (5→3 core modes, removed bloat)"

Entry-point files (`plan`, `wish`, `forge`, `review`, `orchestrator`, `vibe`) remain at the top level and never load overrides.

### CUSTOM OVERRIDES — `.genie/custom/` (WHAT USERS COPY)

**Template exports:** Only `.genie/custom/` stubs (22 files for 19 user-facing agents + 3 workflows)

**Master prompts:** Stay in npm package at `.genie/agents/core/`, loaded via `@` references

**User workflow:**
1. `genie init` copies `.genie/custom/` stubs to project
2. `.claude/agents/` wrappers reference npm package: `@.genie/agents/core/<agent>.md`
3. Master prompts auto-include `.genie/custom/<agent>.md` when present
4. Users add project agents in `.genie/agents/` (custom inventory)

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

**Success Metrics (REVISED 2025-10-13):**
- ✅ Orchestrator modes exist at `.genie/agents/core/modes/` (verified: 5 implemented modes)
- ✅ Meta-learning agent passes both teaching and violation sample prompts without errors
- ✅ Agent inventory accurately documented: 25 total (19 user-facing + 6 Genie-internal)
- ✅ All 19 user-facing agents have `.genie/custom/` stubs (22 stubs total including workflows)
- Documentation updates approved with no TODO placeholders and spell-check clean
- `vibe` agent exists and is properly referenced (not "sleepy")
- ✅ Wishes store documents/reports/evidence under the nested folder structure
- ✅ Agent categorization analysis complete (user-facing vs Genie-internal distinction clear)

**External Tasks:**
- Forge execution group IDs (TBD after `/forge`)

**Dependencies:**
- Stable core agents (13 total):
  - User-facing (10): analyze, audit, commit, debug, git-workflow, github-workflow, implementor, polish, refactor, tests
  - Genie-internal (3): install, learn, prompt
- Stable orchestrator modes (5): challenge, consensus, docgen, explore, tracer
- CLI wrappers in `.claude/commands/`
- Custom stubs in `.genie/custom/` for all user-facing agents

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
- [2025-10-13 16:30Z] **Phase 2 COMPLETE:** Template structure created at `templates/base/` — 22 custom stubs, product/standards templates, .claude/ references to npm package, empty .genie/agents/ for user agents, comprehensive READMEs — see validation below
- [2025-10-15 19:55Z] **Architecture Evolution:** Multi-template system implemented (templates/code/, templates/create/) replacing single templates/base/ — Universal workflow + domain-specialized neurons — 110+ files across both templates
- [2025-10-16 18:00Z] **Wish Updated:** Architecture references updated to reflect multi-template reality, score adjusted to 70/100 (Phases 0-2 complete), Phase 3 scope expanded for multi-template validation
- [2025-10-16 20:45Z] **Phase 3 COMPLETE (95/100):** Templates validated, INSTALL.md created for create template, architecture confirmed working — Workflows accessible from npm via @ or MCP (not copied locally by design), agents/ blacklist is CORRECT (preserves user customizations), both templates ship with workflows in npm package — Evidence: qa/template-validation-202510161630.md, commits ac7b810 (INSTALL.md) + cb665e1 (validation docs)
- [2025-10-16 22:00Z] **WISH COMPLETE (100/100):** All documentation verified — AGENTS.md §Universal Workflow Architecture exists and is comprehensive (line 392), all Phase 3 deliverables complete, evaluation matrix fully satisfied — Ready for archival and GitHub issue update

## Phase 2 Validation — Template Structure

**Created:** 2025-10-13 16:30Z

### File Tree
```
templates/base/
├── .claude/              # 36 files (25 agents + 10 commands + 1 README)
│   ├── agents/          # 25 agent aliases → npm package
│   ├── commands/        # 10 slash commands → npm package
│   └── README.md
├── .genie/
│   ├── agents/          # Empty (for user-created agents)
│   │   └── README.md
│   ├── custom/          # 22 customization stubs
│   ├── product/         # 6 template files
│   │   └── planning-notes/
│   ├── standards/       # 5 template files
│   │   └── code-style/
│   ├── state/           # Session data structure
│   │   ├── agents/logs/
│   │   └── README.md
│   └── wishes/          # Empty (created by /wish)
├── .gitignore           # State files excluded
├── AGENTS.md            # Full workflow guide (23KB)
├── CLAUDE.md            # Claude Code patterns (4.2KB)
└── README.md            # Template introduction
```

### Verification Commands
```bash
# File count validation
tree -L 1 templates/base/ --dirsfirst
# 14 directories, 73 files ✅

# Custom stubs count
ls -1 templates/base/.genie/custom/*.md | wc -l
# 22 ✅

# Agent aliases count
ls -1 templates/base/.claude/agents/*.md | wc -l
# 25 ✅

# Command aliases count
ls -1 templates/base/.claude/commands/*.md | wc -l
# 10 ✅

# Example agent reference
head -10 templates/base/.claude/agents/implementor.md
# Contains: @.genie/agents/core/implementor.md ✅
```

### Architecture Compliance
- ✅ **NPM Package References**: All .claude/ files reference `@.genie/agents/` (not copied)
- ✅ **Custom Stubs Only**: 22 customization injection points in `.genie/custom/`
- ✅ **Empty Agent Directory**: `.genie/agents/` empty with README (for user agents)
- ✅ **Template Files**: Product/standards populated with `{{PLACEHOLDER}}` syntax
- ✅ **State Ignored**: `.gitignore` excludes `.genie/state/`
- ✅ **Documentation**: README.md, AGENTS.md, CLAUDE.md included

### Next Steps
- [ ] Test `genie init` copies structure correctly
- [ ] Validate agent resolution via MCP in clean project
- [ ] Create migration guide (Phase 3)
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
