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
| User clarification | feedback | Twin is core (stable framework utility) | categorization |
| User clarification | feedback | Templates are one-way: Genie → user projects | implementation |
| Agent glob scan | discovery | 36 agents total across .genie/agents/ | categorization |
| @.genie/agents/utilities/install.md | repo | Current init logic and setup modes | implementation |
| templates/ directory | discovery | Already exists with templates/.claude/commands/ | implementation |
| .genie/ directories | discovery | agents, specialists, utilities, qa, guides, standards, product, instructions | audit |

## Discovery Summary

- **Primary analyst:** Human + Agent
- **Key observations:**
  - Genie repository uses `.genie/` for its own development (meta-level)
  - `templates/` directory already exists at repo root with `.claude/commands/` subdirectory
  - 36 agents cataloged across core workflow, specialists, and utilities
  - MCP config is straightforward npm package invocation, no dynamic path resolution needed
  - Template system is one-way: init copies to user projects, no upstream sync
- **Assumptions (ASM-#):**
  - **ASM-1:** Core agents (plan, wish, forge, review, twin, install, prompt, self-learn) are stable framework APIs that should never be copied
  - **ASM-2:** Template agents are starter kits customized per-project with no upstream sync
  - **ASM-3:** MCP server can load core agents from npm package installation automatically
  - **ASM-4:** `templates/` directory structure mirrors user project layout (`.claude/`, `.genie/`)
- **Open questions (Q-#):**
  - ~~Q-1: Is twin core or template?~~ **RESOLVED: Core**
  - ~~Q-2: How to handle template updates?~~ **RESOLVED: One-way copy, no sync back**
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
- `.genie/agents/` contains all agents (plan, wish, forge, review, specialists, utilities)
- `.claude/commands/` and `.claude/agents/` provide slash command and Task tool aliases via @include
- `templates/` directory exists at root with initial `.claude/commands/` structure
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

## Target State & Guardrails

**Desired Behavior:**

1. **Core Agents (Built-In):**
   - Live in npm package under `dist/templates/core/` or similar
   - Loaded automatically by MCP server
   - Never copied to user projects
   - Provide stable workflow APIs (plan → wish → forge → review)
   - Include framework utilities (install, prompt, self-learn, twin)

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

**Updated all `.claude/` aliases to new directory structure:**

### Commands Updated:
- Core agents: `plan`, `wish`, `forge`, `review`, `install`, `prompt`, `learn`, `debug` → `@.genie/agents/core/`
- Specialist: `commit` → `@.genie/agents/specialists/`
- Genie-only: `genie-qa` → `@.genie/agents/qa/`
- **Renamed:** `sleepy.md` → `vibe.md` pointing to `@.genie/agents/core/vibe.md`

### Agents Updated:
- Core agents: All thinking utilities → `@.genie/agents/core/`
- Specialists: All 13 template agents → `@.genie/agents/specialists/`
- Genie-only: `genie-qa` → `@.genie/agents/qa/`
- **Renamed:** `sleepy.md` → `vibe.md`
- **Deleted:** `project-manager.md`, `self-learn.md` (already deleted from source)

## Execution Groups

### Group A – Agent Inventory & Categorization
- **Goal:** Catalog all 36 agents and categorize as core vs template
- **Surfaces:**
  - @.genie/agents/plan.md
  - @.genie/agents/wish.md
  - @.genie/agents/forge.md
  - @.genie/agents/review.md
  - @.genie/agents/specialists/ (8 agents)
  - @.genie/agents/utilities/ (15 agents)
  - @.genie/agents/qa/ (test agents)
- **Deliverables:**
  - Categorization matrix (agent name, type, rationale, destination)
  - Core agents list (stays in npm package)
  - Template agents list (goes to templates/)
- **Evidence:** `.genie/wishes/core-template-separation/agent-categorization.md`
- **Suggested personas:** `analyze`, `codereview`
- **External tracker:** TBD

### Group B – Template Directory Restructure
- **Goal:** Build complete `templates/` directory with all user-facing scaffolding
- **Surfaces:**
  - @templates/ (existing)
  - @.genie/standards/
  - @.genie/product/
  - @.genie/guides/
  - @.genie/instructions/ (assess if needed in templates)
- **Deliverables:**
  - `templates/.genie/agents/specialists/` (all customizable agents)
  - `templates/.genie/agents/utilities/` (commit, codereview, refactor, etc.)
  - `templates/.genie/standards/` (best-practices, naming, tech-stack templates)
  - `templates/.genie/product/` (mission, roadmap, tech-stack, environment templates)
  - `templates/.genie/guides/` (getting-started, onboarding)
  - `templates/.genie/state/` (sessions.json placeholder)
  - `templates/.claude/commands/` (user-facing slash commands)
  - `templates/.claude/agents/` (Task tool aliases)
- **Evidence:** Directory structure diff (before/after), file list
- **Suggested personas:** `implementor`, `refactor`
- **External tracker:** TBD

### Group C – Init Script & MCP Updates
- **Goal:** Update install.md and MCP server to handle core/template separation
- **Surfaces:**
  - @.genie/agents/utilities/install.md
  - @.genie/mcp/ (MCP server source)
  - Package build/distribution scripts
- **Deliverables:**
  - Modified install.md logic: copy only `templates/*` to user project
  - MCP agent resolution order: user .genie/agents/ → core (npm package)
  - Updated package.json build scripts (if needed)
  - Init command includes MCP config instruction
- **Evidence:**
  - Init run in clean directory (screenshot/log)
  - Agent resolution test (core agent accessible, template agent customizable)
  - MCP server response time benchmark
- **Suggested personas:** `implementor`, `tests`
- **External tracker:** TBD

### Group D – Documentation & Migration
- **Goal:** Update all framework docs and provide migration guide
- **Surfaces:**
  - @AGENTS.md
  - @.claude/README.md
  - @CLAUDE.md (if applicable)
  - @README.md
- **Deliverables:**
  - AGENTS.md updated with core vs template distinction
  - .claude/README.md architecture section rewritten
  - Migration guide at `.genie/guides/migration-core-template.md`
  - Updated getting-started guide referencing new structure
- **Evidence:** Doc diff, migration guide walkthrough
- **Suggested personas:** `docgen`, `polish`
- **External tracker:** TBD

## Verification Plan

**Validation Steps:**

1. **Template Copy Test:**
   ```bash
   cd /tmp && mkdir test-project && cd test-project
   npx automagik-genie init
   # Verify templates/.genie/agents/specialists/ copied
   # Verify core agents (plan, wish, forge, review) NOT copied
   ls -la .genie/agents/
   ls -la .claude/commands/
   ```

2. **Core Agent Resolution Test:**
   ```bash
   cd /tmp/test-project
   # Add MCP config to .claude/settings.json
   # Verify /plan command works (loads core agent from npm package)
   # Verify template agents accessible (e.g., implementor)
   ```

3. **Customization Test:**
   ```bash
   cd /tmp/test-project
   echo "# Custom note" >> .genie/agents/specialists/implementor.md
   # Verify modified template agent used
   # Verify core agents unaffected
   ```

4. **Migration Test:**
   ```bash
   # Clone existing Genie-enabled project
   # Run migration steps from guide
   # Verify workflows still function
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

**Total:** 31 Agents (15 Core + 13 Template + 2 Genie-Only + 5 Deleted)

**Meta Pattern:** Template agents exist in BOTH `.genie/agents/specialists/` (Genie's own) AND `templates/` (for distribution)

### NEW DIRECTORY STRUCTURE ✅ COMPLETED

```
.genie/agents/
├── core/                    # 15 core agents (built into npm package)
│   ├── plan.md
│   ├── wish.md
│   ├── forge.md
│   ├── review.md
│   ├── install.md
│   ├── prompt.md
│   ├── self-learn.md
│   ├── twin.md
│   ├── learn.md
│   ├── analyze.md
│   ├── challenge.md
│   ├── consensus.md
│   ├── debug.md
│   ├── thinkdeep.md
│   └── vibe.md           # ✅ RENAMED from sleepy.md
│
├── specialists/             # 13 template agents (copied to user projects)
│   ├── implementor.md
│   ├── tests.md
│   ├── qa.md            # Template for user projects
│   ├── polish.md
│   ├── bug-reporter.md
│   ├── git-workflow.md
│   ├── commit.md
│   ├── codereview.md
│   ├── refactor.md
│   ├── testgen.md
│   ├── docgen.md
│   ├── secaudit.md
│   └── tracer.md
│
├── qa/                      # ⚙️ Genie-only dev folder (NOT distributed)
│   ├── genie-qa.md      # Genie framework self-validation
│   └── README.md        # QA testing docs
│
└── README.md             # Agent system documentation
```

### CORE AGENTS (15) — `.genie/agents/core/`

**All in core/ now, built into npm package, never copied:**

1. `plan.md` — Product planning orchestrator
2. `wish.md` — Wish creation architect
3. `forge.md` — Execution planning with planner mode
4. `review.md` — QA validation coordinator
5. `install.md` — Template installation
6. `prompt.md` — Prompting guidance
7. `self-learn.md` — Behavioral learning
8. `twin.md` — Pressure-testing and second opinions
9. `learn.md` — Meta-learning for new patterns
10. `analyze.md` — Deep analysis (generic enough for any request)
11. `challenge.md` — Assumption breaking
12. `consensus.md` — Decision facilitation
13. `debug.md` — Systematic debugging
14. `thinkdeep.md` — Extended reasoning
15. `vibe.md` — Autonomous coordinator ✅ RENAMED from sleepy.md

### TEMPLATE AGENTS (13) — `.genie/agents/specialists/`

**All in specialists/ now, copied to user projects during init:**

1. `implementor.md` — Feature implementation
2. `tests.md` — Test writing
3. `qa.md` — Quality assurance (user project template)
4. `polish.md` — Code refinement
5. `bug-reporter.md` — Bug triage & filing
6. `git-workflow.md` — Git operations
7. `commit.md` — Commit advisory
8. `codereview.md` — Code review
9. `refactor.md` — Refactor planning
10. `testgen.md` — Test generation
11. `docgen.md` — Documentation generation
12. `secaudit.md` — Security audit
13. `tracer.md` — Instrumentation planning

**Important:** These exist in `.genie/agents/specialists/` for Genie's own development AND will be copied to `templates/` for distribution

### GENIE-REPO-ONLY (2) — `.genie/agents/qa/`

**All Genie-only files in qa/ folder (NOT distributed):**

1. `genie-qa.md` — Genie framework self-validation
2. `README.md` — QA testing docs

**Note:** The `qa/` folder is for Genie's own development/testing. User projects get `specialists/qa.md` template.

### DELETED AGENTS (5) ✅ COMPLETED

1. ~~`utilities/identity-check.md`~~ ❌
2. ~~`specialists/project-manager.md`~~ ❌
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
- Categorize all 36 agents as core (npm package) or template (copied during init)
- Build complete `templates/` directory structure with agents, standards, product scaffolding, guides
- Update `install.md` to copy only `templates/*` to user projects
- Ensure MCP server loads core agents from npm package automatically
- Update AGENTS.md, .claude/README.md, and create migration guide
- Verify init works in clean environment, core agents accessible, template agents customizable

**Out of Scope:**
- Automated MCP config installation (planned for next version)
- Template versioning/update propagation system
- Migration automation tool (manual guide sufficient for now)
- Changes to core agent logic (only file moves/renames)

**Success Metrics:**
- Init completes in <5 seconds
- Core agents resolve in <100ms
- Zero breaking changes to existing workflows
- Migration guide enables existing users to upgrade without data loss
- Template structure mirrors user project conventions exactly

**External Tasks:**
- Forge execution group IDs (TBD after `/forge`)

**Dependencies:**
- MCP server agent discovery implementation
- npm package build/distribution pipeline
- Existing `.genie/agents/` content preserved during transition

</spec_contract>

## Blocker Protocol

1. Pause work and create `.genie/reports/blocker-core-template-separation-<timestamp>.md` describing findings.
2. Notify owner and wait for updated instructions.
3. Resume only after wish status/log is updated.

## Status Log

- [2025-10-06 13:00Z] Wish created (planning brief approved)
- [Pending] Agent categorization completed
- [Pending] Template structure built
- [Pending] Init script updated
- [Pending] Documentation updated
- [Pending] All validation tests passed
- [Pending] Human approval for merge
