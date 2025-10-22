# 🧞 ENHANCED BACKUP & UPDATE SYSTEM WISH
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Status:** DRAFT
**Note:** Referenced file (update.ts) removed in refactoring - preserved for historical context
**GitHub Issue:** #38 - Enhanced backup & update system with customization preservation
**Roadmap Item:** INIT-BACKUP-UPDATE – Framework version migration with user customization preservation
**Mission Link:** @.genie/product/mission.md §Pitch
**Completion Score:** 0/100 (updated by `/review`)

## Evaluation Matrix (100 Points Total)

### Discovery Phase (30 pts)
- **Context Completeness (10 pts)**
  - [ ] All backup/update flow touchpoints mapped (4 pts)
  - [ ] Version migration strategies documented (3 pts)
  - [ ] User customization scenarios captured (3 pts)
- **Scope Clarity (10 pts)**
  - [ ] Clear current backup mechanism documented (3 pts)
  - [ ] Target update flow with agent orchestration defined (4 pts)
  - [ ] Out-of-scope explicitly stated (3 pts)
- **Evidence Planning (10 pts)**
  - [ ] Test scenarios for version migrations defined (4 pts)
  - [ ] Artifact storage paths specified (3 pts)
  - [ ] Approval checkpoints documented (3 pts)

### Implementation Phase (40 pts)
- **Code Quality (15 pts)**
  - [ ] Backup expansion preserves atomicity (5 pts)
  - [ ] Update agent follows framework conventions (5 pts)
  - [ ] CLI integration clean and minimal (5 pts)
- **Test Coverage (10 pts)**
  - [ ] Unit tests for backup inclusion logic (4 pts)
  - [ ] Integration tests for genie update flow (4 pts)
  - [ ] E2E tests for version migrations (2 pts)
- **Documentation (5 pts)**
  - [ ] Update agent instructions comprehensive (2 pts)
  - [ ] CLI help text clear (2 pts)
  - [ ] Migration guide examples provided (1 pt)
- **Execution Alignment (10 pts)**
  - [ ] No scope creep beyond backup+update (4 pts)
  - [ ] Version-specific update logic templated (3 pts)
  - [ ] Rollback mechanism verified (3 pts)

### Verification Phase (30 pts)
- **Validation Completeness (15 pts)**
  - [ ] Backup includes AGENTS.md/CLAUDE.md (6 pts)
  - [ ] Update agent applies changes successfully (5 pts)
  - [ ] User customizations preserved (4 pts)
- **Evidence Quality (10 pts)**
  - [ ] Before/after file trees captured (4 pts)
  - [ ] Update logs show merge decisions (3 pts)
  - [ ] Test migrations across version skips (3 pts)
- **Review Thoroughness (5 pts)**
  - [ ] Human approval for update agent template (2 pts)
  - [ ] Rollback tested on failed updates (2 pts)
  - [ ] Status log updated (1 pt)

## Context Ledger
| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| .genie/cli/src/commands/update.ts (removed in refactoring):133+ | code | Current backup mechanism (update flow) | implementation |
| @.genie/cli/src/commands/init.ts:86-106 | code | Backup mechanism (init flow) | implementation |
| @.genie/cli/src/lib/fs-utils.ts:64-72 | code | Atomic snapshot implementation | implementation |
| @.genie/cli/src/commands/rollback.ts | code | Existing rollback command | implementation |
| User clarification (items #1-3) | requirements | Always backup, tailored update agent per version | entire wish |
|  | template | Wish structure requirements | wish structure |

## Discovery Summary
- **Primary analyst:** Human (namastex) + Genie planning agent
- **Key observations:**
  - Current backup excludes root `AGENTS.md`/`CLAUDE.md` despite being copied during init
  - No automated update mechanism exists; users manually run `npm install -g automagik-genie@latest`
  - Framework ships version-agnostic; update agent needs version-specific instructions bundled per release
  - User customizations in `AGENTS.md`/`CLAUDE.md` must be preserved and intelligently merged
- **Assumptions (ASM-#):**
  - ASM-1: Users customize `AGENTS.md` (behavioral learnings) and `CLAUDE.md` (project patterns)
  - ASM-2: Newer Genie versions bring breaking changes to agent prompts and structure
  - ASM-3: Update agent instructions can be pre-written for known version transitions
  - ASM-4: Namastex will maintain version-specific update guides in framework releases
- **Open questions (Q-#):**
  - Q-1: Should `genie update` support skipping versions (e.g., 2.0.0 → 2.3.0 directly)?
  - Q-2: How to handle conflicts when user's `AGENTS.md` contradicts new framework rules?
  - Q-3: Should update agent run interactively (prompt user) or autonomously with report?
- **Risks:**
  - RISK-1: Merge logic may accidentally overwrite critical user customizations
  - RISK-2: Failed updates could leave `.genie/` in inconsistent state
  - RISK-3: Version-specific update instructions increase maintenance burden

## Executive Summary
Enhance existing `genie update` command to preserve user customizations during framework upgrades by:
1. **Expanding backup scope** - Include root `AGENTS.md`, `CLAUDE.md`, and `.claude/` in `update.ts:createBackup()`
2. **Creating `update.md` agent** - Intelligently merge new framework changes with backed-up user customizations
3. **Adding version-specific guides** - Per-release migration instructions for breaking changes

Current `genie update` command works but **overwrites user customizations**. This wish adds intelligent merge logic to preserve user investment in behavioral learnings (`AGENTS.md`) and project patterns (`CLAUDE.md`).

## Current State
- **Backup mechanism:**
  - `update.ts:createBackup()` snapshots `.genie/` to `.genie/backups/<timestamp>/` (atomic via `snapshotDirectory()`)
  - `init.ts:86-106` creates backups of `.genie/` and `.claude/` before re-initialization
  - Does NOT capture root `AGENTS.md`/`CLAUDE.md` despite these being user-editable
  - Atomic guarantee via staging pattern in `fs-utils.ts:64-72` prevents partial backups
- **Update commands exist:**
  - `genie update` (`.genie/cli/src/commands/update.ts`) - Automates template sync with diff preview and backup
  - `genie rollback` (`.genie/cli/src/commands/rollback.ts`) - Restores from backups with `--latest` or `--id` flags
  - Version tracking via `.genie/state/version.json`
- **What's missing:**
  - Backup expansion: AGENTS.md, CLAUDE.md, .claude/ not included in `update.ts:createBackup()`
  - Intelligent merge: Current update overwrites everything; no customization preservation
  - Migration agent: No `update.md` agent to handle version-specific transformations
  - Update guides: No per-version instructions for breaking changes
- **Pain points:**
  - Users lose customizations in `AGENTS.md`/`CLAUDE.md` during updates (files not backed up)
  - No guidance for migrating old structures (e.g., pre-`custom/` folder era)
  - Framework updates with breaking changes overwrite user learnings/patterns

## Target State & Guardrails
- **Desired behaviour:**
  - `genie update` command upgrades package and runs tailored update agent automatically
  - Backup snapshots include ALL user-customizable files: `.genie/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`
  - Update agent intelligently merges new framework files with backed-up customizations
  - Users receive clear update report showing what changed and why
- **Non-negotiables:**
  - Atomic backups: no partial snapshots that could corrupt during failures
  - Rollback safety: users can revert to previous version via `genie rollback <backup-id>`
  - Customization preservation: user's `AGENTS.md` learnings and `CLAUDE.md` patterns must survive updates
  - Version-specific logic: update agent instructions tailored per release (not generic)

## Execution Groups

### Group A – Backup Enhancement
**Slug:** backup-expansion
**Goal:** Include `AGENTS.md`, `CLAUDE.md`, and `.claude/` in update backup snapshots

**Surfaces:**
- .genie/cli/src/commands/update.ts (removed in refactoring):133+ – `createBackup()` function (primary target)
- @.genie/cli/src/commands/init.ts:86-106 – Init backup flow (secondary alignment)
- @.genie/cli/src/lib/fs-utils.ts:64-72 – `snapshotDirectory()` helper (reuse atomic pattern)

**Deliverables:**
1. Extend `update.ts:createBackup()` to snapshot:
   - Root `AGENTS.md` (if exists)
   - Root `CLAUDE.md` (if exists)
   - `.claude/` directory (if exists)
2. Maintain atomic snapshot guarantees (existing staging pattern continues to work)
3. Update backup directory structure:
   ```
   .genie/backups/<timestamp>/
   ├── genie/           # existing
   ├── claude/          # existing
   └── root-docs/       # NEW: AGENTS.md, CLAUDE.md
   ```
4. Add unit tests verifying root docs are backed up
5. Update `version.json` schema to track root doc snapshot paths

**Evidence:**
- Store test outputs in `qa/group-a/backup-tests/`
- Capture before/after file trees showing new `root-docs/` directory
- Log backup operations showing AGENTS.md/CLAUDE.md inclusion

**Validation:**
```bash
# Test backup includes root docs
genie init --provider codex
ls -la .genie/backups/<timestamp>/root-docs/
# Expect: AGENTS.md, CLAUDE.md

# Verify atomicity with forced interruption
# (kill process mid-backup, verify no partial snapshots)
```

**Suggested personas:** implementor, tests

**External tracker:** FORGE-TBD-A

---

### Group B – Update Agent Integration
**Slug:** update-agent-integration
**Goal:** Integrate `update.md` agent into existing `genie update` command for intelligent merge

**Surfaces:**
- .genie/cli/src/commands/update.ts (removed in refactoring):73-77 – Post-backup, pre-template-copy hook point
**Current behavior:**
```typescript
// update.ts:73-77
const backupId = await createBackup(targetGenie);
await copyTemplateGenie(templateGenie, targetGenie); // ← Overwrites everything
await touchVersionFile(cwd);
```

**Desired behavior:**
```typescript
const backupId = await createBackup(targetGenie);
await runUpdateAgent(backupId, templateGenie, targetGenie); // ← Intelligent merge
await touchVersionFile(cwd);
```

**Deliverables:**
1. Add `runUpdateAgent()` function that:
   - Launches `update.md` agent with backup context
   - Passes version transition info (old → new)
   - Waits for agent completion
   - Captures merge decisions in update report
2. Agent invocation uses existing MCP infrastructure (`mcp__genie__run`)
3. Fallback: If agent fails, revert to current overwrite behavior with warning
4. Update summary view includes merge report from agent

**Evidence:**
- Store CLI output logs in `qa/group-b/update-cli-tests/`
- Capture version transition sequences (2.0.0 → 2.1.0 → 2.2.0)
- Document error scenarios and recovery paths

**Validation:**
```bash
# Test upgrade flow
cd /tmp/test-project
genie init --provider codex --yes
genie update --target-version 2.1.0
cat .genie/state/version.json | jq .version
# Expect: "2.1.0"

# Test dry-run mode
genie update --dry-run
# Expect: Shows planned changes, no modifications

# Test rollback after update
genie rollback <backup-id>
cat .genie/state/version.json | jq .version
# Expect: previous version restored
```

**Suggested personas:** implementor, tests

**External tracker:** FORGE-TBD-B

---

### Group C – Update Agent
**Slug:** update-agent
**Goal:** Create `update.md` agent that intelligently merges framework updates with user customizations

**Surfaces:**
**Deliverables:**
1. Create `update.md` agent with sections:
   - **Discovery:** Analyze backup vs current framework files, detect customizations
   - **Implementation:** Apply version-specific migration instructions
   - **Verification:** Validate merged files, report conflicts
2. Agent receives context via prompt:
   ```
   <timestamp>/root-docs/AGENTS.md
   <timestamp>/root-docs/CLAUDE.md
   [VERSION_SPECIFIC_INSTRUCTIONS]
   ```
3. Migration strategies:
   - **AGENTS.md:** Extract user's `<learning_entries>`, merge into new template
   - **CLAUDE.md:** Preserve user's `@` file references, adopt new patterns
   - **.genie/custom/:** Copy forward entire directory (user-managed)
   - **.genie/agents/:** Accept new framework agents, prompt for conflicts
4. Output format:
   ```markdown
   # Genie Update Report – v2.0.0 → v2.1.0

   ## Changes Applied
   - ✅ AGENTS.md: 3 user learnings preserved, 2 new framework patterns added
   - ✅ CLAUDE.md: Custom project patterns migrated
   - ✅ .genie/agents/: 5 agents updated with new frontmatter

   ## Conflicts Detected
   - ⚠️ .genie/custom/analyze.md: User override conflicts with new core agent signature
     - Recommended action: Review and update custom override

   ## Manual Steps Required
   - [ ] Review .genie/custom/analyze.md for compatibility
   - [ ] Test updated agents with `genie run plan --mode debug`
   ```
5. Conflict resolution modes:
   - `--auto`: Accept all framework changes (document overrides)
   - `--interactive`: Prompt user for each conflict
   - `--preserve`: Keep user versions, log framework changes separately

**Evidence:**
- Store update reports in `reports/update-<from>-<to>-<timestamp>.md`
- Capture test migrations across version ranges in `qa/group-c/migrations/`
- Document merge strategies with examples

**Validation:**
```bash
# Test agent directly
genie run update "" --mode debug

# Test via update command (integrated)
genie update --target-version 2.1.0
cat reports/update-*.md
# Expect: Update report with changes summary

# Test conflict handling
# (Create custom AGENTS.md, update to new version, verify merge)
echo "Custom learning" >> AGENTS.md
genie update --interactive
# Expect: Prompt for merge decision
```

**Suggested personas:** implementor (agent authoring), tests (migration scenarios)

**External tracker:** FORGE-TBD-C

---

### Group D – Version-Specific Update Instructions
**Slug:** update-templates
**Goal:** Create template system for embedding version-specific update instructions in releases

**Surfaces:**
- v2.0.0-to-v2.1.0.md – example migration guide
- .genie/cli/src/commands/update.ts (removed in refactoring) – instruction loading logic

**Deliverables:**
1. Create `.genie/updates/` directory structure:
   ```
   .genie/updates/
   ├── README.md           # Update instruction format spec
   ├── v2.0.0-to-v2.1.0.md
   ├── v2.1.0-to-v2.2.0.md
   └── [future versions]
   ```
2. Update instruction format (markdown):
   ```markdown
   # Update Guide: v2.0.0 → v2.1.0

   ## Breaking Changes
   - `.genie/custom/` directory introduced
   - Agent frontmatter schema updated (new `background: true` default)

   ## Migration Steps
   1. Move user overrides from `.genie/agents/` to `.genie/custom/`
   2. Update agent frontmatter to include `genie.background` field
   3. Preserve user's `AGENTS.md` learnings under `<learning_entries>`

   ## File Mappings
   - `.genie/agents/custom-analyze.md` → `.genie/custom/analyze.md`

   ## Validation Commands
   - `genie run plan --mode debug` (verify agent loading)
   - `pnpm run check` (type-check CLI)
   ```
3. Update agent loads appropriate guide based on version transition:
   ```typescript
   const fromVersion = readJsonFile('.genie/state/version.json').version;
   const toVersion = getPackageVersion();
   const guidePath = `.genie/updates/v${fromVersion}-to-v${toVersion}.md`;
   const instructions = await readFile(guidePath, 'utf8');
   // Pass to update agent as context
   ```
4. Fallback for missing guides:
   - If exact version guide missing, load nearest (e.g., 2.0.0 → 2.3.0 uses 2.0.0 → 2.1.0 + 2.1.0 → 2.2.0 + 2.2.0 → 2.3.0)
   - If no guides found, use generic update instructions
5. Bundle guides in npm package (add to `package.json:files`)

**Evidence:**
- Store example update guides in `qa/group-d/update-guides/`
- Document guide authoring process for Namastex team
- Capture version transition test matrix

**Validation:**
```bash
# Test guide loading
ls -la .genie/updates/
# Expect: README.md + version guides

# Test update with guide
genie update --target-version 2.1.0
# Expect: Update agent references guide instructions in report

# Test version skip with chained guides
genie update --target-version 2.3.0
# Expect: Agent applies 2.0→2.1, 2.1→2.2, 2.2→2.3 guides sequentially
```

**Suggested personas:** docgen (guide authoring), implementor (loading logic), tests

**External tracker:** FORGE-TBD-D

## Verification Plan
- **Validation steps:**
  1. Run `genie init` in fresh project, verify backup includes root docs
  2. Customize `AGENTS.md` with test learning entry
  3. Run `genie update --target-version X.Y.Z`
  4. Verify customization preserved in updated `AGENTS.md`
  5. Check update report shows merge decisions
  6. Test rollback: `genie rollback <backup-id>`, verify restoration
- **Evidence storage:**
  - Backup structure tests: `qa/group-a/backup-tests/`
  - Update CLI flows: `qa/group-b/update-cli-tests/`
  - Migration scenarios: `qa/group-c/migrations/`
  - Update guides: `qa/group-d/update-guides/`
  - Update reports: `reports/update-*.md`
- **Branch strategy:** Dedicated branch `feat/backup-update-system`

### Evidence Checklist
- **Validation commands (exact):**
  ```bash
  # Backup verification
  genie init && ls -la .genie/backups/<timestamp>/root-docs/

  # Update flow
  genie update --target-version 2.1.0 && cat reports/update-*.md

  # Customization preservation
  echo "test-learning" >> AGENTS.md && genie update && grep "test-learning" AGENTS.md

  # Rollback
  genie rollback <backup-id> && cat .genie/state/version.json
  ```
- **Artefact paths:**
  - Test outputs: `qa/group-{a,b,c,d}/`
  - Update reports: `reports/update-<from>-<to>-<timestamp>.md`
  - Update guides: `.genie/updates/v*-to-v*.md`
- **Approval checkpoints:**
  - [ ] Human review of backup expansion logic (Group A) before implementation
  - [ ] Update agent prompt reviewed (Group C) before integration
  - [ ] First version-specific update guide (Group D) approved as template

## <spec_contract>
- **Scope:**
  - **Group A:** Expand `update.ts:createBackup()` to include `AGENTS.md`, `CLAUDE.md`, `.claude/`
  - **Group B:** Integrate `update.md` agent into existing `genie update` command flow
  - **Group C:** Create `update.md` agent that merges new framework files with backed-up user customizations
  - **Group D:** Author version-specific update guides bundled in releases
  - Leverage existing infrastructure: `genie update`, `genie rollback`, atomic snapshot pattern
- **Already built (out of scope):**
  - `genie update` command (`.genie/cli/src/commands/update.ts`) - exists, needs enhancement
  - `genie rollback` command (`.genie/cli/src/commands/rollback.ts`) - exists, no changes needed
  - Atomic backup pattern (`fs-utils.ts:snapshotDirectory()`) - exists, reuse as-is
  - Version tracking (`.genie/state/version.json`) - exists, no changes needed
- **Out of scope:**
  - Multi-template architecture (separate wish)
  - Provider runtime override (separate wish)
  - Automated testing of update guides (manual QA by Namastex team)
  - Update notification system (future enhancement)
  - npm package installation automation (users run `npm install` manually before `genie update`)
- **Success metrics:**
  - 100% user customizations preserved across updates (test suite validates)
  - Zero data loss during failed updates (atomic backup + rollback)
  - Update time <60s for typical framework upgrades
  - Update reports clearly document merge decisions
- **External tasks:**
  - FORGE-TBD-A: Backup expansion implementation
  - FORGE-TBD-B: Update agent integration
  - FORGE-TBD-C: Update agent authoring
  - FORGE-TBD-D: Version guide authoring
  - FORGE-TBD-D: Update guide template system
- **Dependencies:**
  - Existing `genie init` backup mechanism
  - npm registry access for version checks
  - Existing rollback utility (`bin/rollback.js`)
</spec_contract>

## Blocker Protocol
1. Pause work and create `reports/blocker-backup-update-system-<timestamp>.md` describing findings.
2. Notify owner (namastex) and wait for updated instructions.
3. Resume only after wish status/log is updated.

## Status Log
- [2025-10-12 00:00Z] Wish created from planning brief (items #1-3)
