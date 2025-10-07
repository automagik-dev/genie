# 🧞 CORE/TEMPLATE AGENT SEPARATION WISH

**Status:** DRAFT
**Roadmap Item:** NEW – Framework restructuring for clean core/template separation
**Mission Link:** @.genie/product/mission.md §Framework Architecture
**Standards:** @.genie/standards/best-practices.md §Code Organization
**Completion Score:** 0/100 (updated by `/review`)

## Evaluation Matrix (100 Points Total)

### Discovery Phase (30 pts)
- **Context Completeness (10 pts)**
  - [ ] All relevant files/docs referenced with @ notation (4 pts)
  - [ ] Agent inventory complete with categorization (3 pts)
  - [ ] Template content audit verified (3 pts)
- **Scope Clarity (10 pts)**
  - [ ] Clear distinction between core and template defined (3 pts)
  - [ ] Spec contract complete with success metrics (4 pts)
  - [ ] Out-of-scope explicitly stated (3 pts)
- **Evidence Planning (10 pts)**
  - [ ] Validation commands specified with exact syntax (4 pts)
  - [ ] Migration path documented (3 pts)
  - [ ] Approval checkpoints documented (3 pts)

### Implementation Phase (40 pts)
- **Code Quality (15 pts)**
  - [ ] Clean directory structure (core vs templates/) (5 pts)
  - [ ] Minimal breaking changes to existing users (5 pts)
  - [ ] Clear @include path conventions (5 pts)
- **Test Coverage (10 pts)**
  - [ ] Init script tested in clean environment (4 pts)
  - [ ] Template copy verification tests (4 pts)
  - [ ] MCP agent resolution tests (2 pts)
- **Documentation (5 pts)**
  - [ ] AGENTS.md updated with new structure (2 pts)
  - [ ] Migration guide created (2 pts)
  - [ ] README architecture section updated (1 pt)
- **Execution Alignment (10 pts)**
  - [ ] Stayed within spec contract scope (4 pts)
  - [ ] No unapproved scope creep (3 pts)
  - [ ] Dependencies and sequencing honored (3 pts)

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
| User clarification | feedback | Genie orchestrator is a core agent | categorization |
| User clarification | feedback | Templates are one-way: Genie → user projects | implementation |
| Agent glob scan | discovery | 36 agents total across .genie/agents/ | categorization |
| @.genie/agents/utilities/install.md | repo | Current init logic and setup modes | implementation |
| templates/ directory | discovery | Already exists with templates/.claude/commands/ | implementation |
| .genie/ directories | discovery | entrypoints, core prompts, custom overrides, qa, guides, standards, product, instructions | audit |

## Discovery Summary

- **Primary analyst:** Human + Agent
- **Key observations:**
  - Genie repository uses `.genie/` for its own development (meta-level)
  - `templates/` directory already exists at repo root with `.claude/commands/` subdirectory
- 36 agents cataloged across entrypoints, core delivery prompts, and utilities
  - MCP config is straightforward npm package invocation, no dynamic path resolution needed
  - Template system is one-way: init copies to user projects, no upstream sync
- **Assumptions (ASM-#):**
  - **ASM-1:** Core agents (plan, wish, forge, review, genie/orchestrator, install, prompt, self-learn) are stable framework APIs that should never be copied
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

Separate Genie framework's built-in agents (core workflow orchestrators and stable utilities) from user-customizable templates. Core agents remain in the npm package and load automatically via MCP; template agents/docs are copied to user projects during `genie init` for project-specific customization. This enables Genie to evolve its core APIs without breaking user customizations, while providing rich starter templates.

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
   - Include framework utilities (install, prompt, self-learn, genie orchestrator)

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
- Core helpers: `commit`, `codereview`, `docgen`, `refactor`, `secaudit`, `testgen`, `tracer`, plus utilities (`analyze`, `debug`, etc.) → `@.genie/agents/core/<name>.md`
- Custom stubs: `.genie/custom/<mode>.md` auto-load with each core prompt for repository-specific guidance
- Genie-only: `genie-qa` → `@.genie/agents/qa/genie-qa.md`

## Execution Groups

### Phase 0 – Genie Mode Consolidation
- **Goal:** Enumerate all Genie modes with core prompts and matching project configuration includes, and keep orchestrator/MCP routing consistent.
- **Surfaces:**
  - @.genie/agents/orchestrator.md
  - @.genie/custom/orchestrator.md
  - @.genie/agents/core/<mode>.md and @.genie/custom/<mode>.md for refactor, testgen, docgen, secaudit, tracer, codereview, commit, bug-reporter, git-workflow, implementor, polish, qa, tests, analyze, challenge, consensus, debug, thinkdeep, risk-audit, design-review, test-strategy, compliance, retrospective, socratic, debate
  - @.genie/mcp/src/server.ts (orchestrator prompt helper)
- **Deliverables:**
  - Core prompt + custom include exist for every Genie mode
  - MCP wrapper documents mode selection via `agent="orchestrator"` prompts
  - AGENTS.md lists the mode matrix with core/custom references
- **Evidence:** `.genie/wishes/core-template-separation/qa/group-a/genie-consolidation.md`
- **Suggested personas:** `analyze`, `orchestrator`
- **External tracker:** TBD
### Phase 1 – Meta-Learning Unification
- **Goal:** Merge learn/self-learn behaviours into a single meta-learning agent while preserving violation logging.
- **Surfaces:**
  - @.genie/agents/core/learn.md
  - @.genie/agents/core/self-learn.md
  - @.claude/commands/learn.md
  - @.claude/commands/self-learn.md
  - @AGENTS.md §behavioral_learnings
- **Deliverables:**
  - New unified agent file (e.g., `.genie/agents/core/meta-learn.md`)
  - Command wrappers updated to point at the unified agent
  - Done Report template updated to cover both teaching and violation flows
- **Evidence:** `.genie/wishes/core-template-separation/qa/group-b/meta-learn-merge.md` capturing diffs and command smoke
- **Suggested personas:** `implementor`, `tests`
- **External tracker:** TBD

### Phase 2 – Core Delivery Catalog Rationalization
- **Goal:** Collapse legacy delivery prompts into the `core/` directory with matching `.genie/custom/<name>.md` includes for project overrides.
- **Surfaces:**
  - Core delivery/utility prompts: @.genie/agents/core/bug-reporter.md, git-workflow.md, implementor.md, polish.md, qa.md, tests.md, docgen.md, refactor.md, secaudit.md, testgen.md, tracer.md, codereview.md, commit.md
  - Custom configuration files: @.genie/custom/<name>.md for the same set
  - `.claude/` aliases referencing these prompts
- **Deliverables:**
  - All delivery/utility prompts live under `.genie/agents/core/` with project customization in `.genie/custom/`
  - `.claude/` wrappers and template copies point to the new core paths
  - Agent resolver/AGENTS.md documentation reflects the flattened structure
- **Evidence:** `.genie/wishes/core-template-separation/qa/group-c/delivery-catalog.md` with agent inventory diff + CLI `genie agents list`
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

1. **Genie Delegation Smoke:**
   ```bash
   pnpm exec genie agents show core/genie --mode refactor --json | rg '@.genie/agents/core/refactor.md'
   pnpm exec genie agents show core/genie --mode testgen --json | rg '@.genie/agents/core/testgen.md'
   ```

2. **Meta-Learn Command Check:**
   ```bash
   claude /learn "Violation: placeholder
   Evidence: placeholder
   Correction: placeholder
   Validation: placeholder
   Target: @AGENTS.md"
   claude /meta-learn --dry-run
   ```

3. **Specialist Catalog Regression:**
   ```bash
   pnpm exec genie agents list > .genie/wishes/core-template-separation/qa/agents-after.txt
   rg "git-lifecycle" -n .claude/commands
   rg "git-workflow" -n .claude/commands  # should be absent post-merge
   ```

4. **Documentation Consistency:**
   ```bash
   mdspell AGENTS.md .genie/agents/README.md .genie/guides/migration-core-template.md
   ```

5. **Vibe Naming Guardrail:**
   ```bash
   rg -n "sleepy" .genie/agents .claude/commands
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

**Total:** 31 prompt files shipped in `.genie/agents/` (6 entrypoints + 25 core personas), 13 customization stubs in `.genie/custom/`, 2 Genie-only QA helpers, 5 retired.

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

### CORE PROMPTS — `.genie/agents/core/`

Packaged personas that define Genie’s default behaviour. Examples:

1. `analyze.md` — System architecture deep-dive
2. `bug-reporter.md` — Incident triage & issue filing
3. `commit.md` — Commit advisory / pre-commit checks
4. `docgen.md` — Documentation outline + drafting
5. `git-workflow.md` — Branching/merge automation
6. `implementor.md` — Feature implementation with TDD
7. `prompt.md` — Advanced prompting framework
8. `qa.md` — Manual QA coordination
9. `refactor.md` — Staged refactor planning
10. `tests.md` — Test authoring + repair
11. `secaudit.md` — Security audit playbook
12. `testgen.md` — Targeted test generation
13. `tracer.md` — Instrumentation/observability plan
14. `consensus.md` — Decision facilitation
15. `thinkdeep.md` — Extended reasoning

Entry-point files (`plan`, `wish`, `forge`, `review`, `orchestrator`, `vibe`) remain at the top level and never load overrides.

### CUSTOM OVERRIDES — `.genie/custom/`

Each stub mirrors its core counterpart and records project-specific defaults (commands, docs, evidence paths). Git includes but does not ship behaviour—core prompts remain the source of truth.

### GENIE-ONLY QA — `.genie/agents/qa/`

1. `genie-qa.md` — Framework validation script
2. `README.md` — QA operating notes

### DELETED AGENTS (5) ✅ COMPLETED

1. ~~`utilities/identity-check.md`~~ ❌
2. ~~`project-manager.md`~~ ❌
3. ~~`test-claude.md`~~ ❌
4. ~~`qa/codex-parameter-test.md`~~ ❌
5. ~~`qa/claude-parameter-test.md`~~ ❌

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
- Update Genie orchestrator prompt to delegate delivery behaviours via `@.genie/agents/core/*` references
- Merge learn/self-learn flows into a single meta-learning agent and command wrapper
- Consolidate core delivery catalog (git lifecycle merge, retire prompts now served by Twin)
- Refresh documentation (AGENTS.md, agents README, migration guide) and capture validation evidence
- Preserve Vibe naming across code and docs while removing legacy “sleepy” references

**Out of Scope:**
- New feature development beyond agent/document consolidation
- Automated migration tooling for downstream projects
- Changing behaviour of surviving core prompts (beyond re-routing and clarity edits)
- Publishing updated npm package (handled separately after verification)

**Success Metrics:**
- Genie orchestrator modes (refactor/testgen/secaudit/docgen/etc.) resolve via core prompt references (verified by CLI smoke)
- Meta-learning agent passes both teaching and violation sample prompts without errors
- `pnpm exec genie agents list` shows merged git lifecycle delivery prompt and no retired entries
- Documentation updates approved with no TODO placeholders and spell-check clean
- Repository contains zero references to `sleepy` outside historical logs

**External Tasks:**
- Forge execution group IDs (TBD after `/forge`)

**Dependencies:**
- Stable core delivery prompts retained for delegation (implementor/tests/qa/polish/bug-reporter/codereview)
- CLI wrappers in `.claude/commands/`
- Agent registry tests for `genie agents list`

</spec_contract>

## Blocker Protocol

1. Pause work and create `.genie/reports/blocker-core-template-separation-<timestamp>.md` describing findings.
2. Notify owner and wait for updated instructions.
3. Resume only after wish status/log is updated.

## Status Log

- [2025-10-06 13:00Z] Wish created (planning brief approved)
- [Pending] Genie orchestrator delegates to core delivery prompts (Group A)
- [Pending] Meta-learning agent merged and wrappers updated (Group B)
- [Pending] Core delivery catalog consolidation applied (Group C)
- [Pending] Documentation + migration evidence captured (Group D)
- [Pending] Validation checklist complete
- [Pending] Human approval for merge
- [2025-10-06 15:20Z] Core prompts normalized to shared framework; project overrides moved to `.genie/custom/` with refreshed templates.
- [2025-10-06 14:45Z] Slash command includes retargeted to `.genie/agents/<name>.md` to restore `/plan`, `/wish`, `/forge`, `/review`, `/vibe`.

## Review Findings – 2025-10-06

- **Broken command includes (resolved 2025-10-06):** `.claude/commands/plan.md:7`, `wish.md:7`, `forge.md:7`, `review.md:7`, and `vibe.md:7` now point back to `@.genie/agents/<name>.md`, restoring the slash commands while the core/template move is still in flight.
- **Core prompt customization routed through `.genie/custom/`:** Entry-point agents remain immutable while each core delivery persona now exposes a `Project Customization` block wired to `.genie/custom/<agent>.md`; legacy `.genie/agents/custom/` references removed.
- **Template export pending:** `templates/` remains empty; distributable copies of the core/custom structure still need to be staged.
- **Meta-learn merge outstanding:** `@.genie/agents/core/self-learn.md` still exists alongside the new `learn.md` persona, meaning the unified meta-learning flow has not been delivered.
- **Documentation drift (resolved 2025-10-06):** `AGENTS.md:32` and `@.genie/agents/README.md:6` now call out that entrypoints stay immutable while core prompts load `.genie/custom/` overrides.
- **Templates directory empty:** `templates/` contains no scaffolded content, so the init flow still lacks the promised template separation.
