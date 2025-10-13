# 🧞 ENHANCED BACKUP & UPDATE SYSTEM WISH
**Status:** DRAFT
**Roadmap Item:** INIT-BACKUP-UPDATE – Framework version migration with user customization preservation
**Mission Link:** @.genie/product/mission.md §Pitch
**Standards:** @.genie/standards/best-practices.md §Core Principles
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
| @.genie/cli/src/commands/init.ts:77-137 | code | Current backup mechanism | implementation |
| @.genie/cli/src/lib/fs-utils.ts:64-72 | code | Atomic snapshot implementation | implementation |
| User clarification (items #1-3) | requirements | Always backup, tailored update agent per version | entire wish |
| @.genie/agents/wish.md | template | Wish structure requirements | wish structure |

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
Enable seamless Genie framework upgrades by:
1. **Expanding backup** to include root `AGENTS.md` and `CLAUDE.md` files alongside `.genie/` and `.claude/`
2. **Creating `genie update` command** that upgrades npm package and triggers version-specific update agent
3. **Building `update.md` agent** that intelligently merges new framework changes with user customizations

This eliminates manual migration pain and preserves user investment in customized behavioral rules and project patterns.

## Current State
- **Backup mechanism:** `init.ts:createBackup()` snapshots `.genie/` and `.claude/` to `.genie/backups/<timestamp>/`
  - Uses atomic `snapshotDirectory()` from `fs-utils.ts` to avoid partial backups
  - Does NOT capture root `AGENTS.md`/`CLAUDE.md` despite these being user-editable
- **Update process:** Manual npm install + users must manually reconcile breaking changes
- **Version tracking:** `.genie/state/version.json` records current version but no migration tooling exists
- **Pain points:**
  - Users lose customizations when re-running `genie init` after upgrades
  - No guidance for migrating old structures (e.g., pre-`custom/` folder era)
  - Framework updates with breaking changes require manual file comparisons

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
**Goal:** Include `AGENTS.md` and `CLAUDE.md` in init backup snapshots

**Surfaces:**
- @.genie/cli/src/commands/init.ts:77-137 – `createBackup()` function
- @.genie/cli/src/lib/fs-utils.ts:64-72 – `snapshotDirectory()` helper

**Deliverables:**
1. Extend `createBackup()` to snapshot root `AGENTS.md` and `CLAUDE.md` into backup directory
2. Maintain atomic snapshot guarantees (use staging pattern)
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

### Group B – Update Command Infrastructure
**Slug:** update-cli
**Goal:** Create `genie update` command that upgrades package and triggers update agent

**Surfaces:**
- @.genie/cli/src/commands/ – new `update.ts` command
- @.genie/cli/src/genie.ts – command routing
- @bin/update.js – CLI wrapper (already exists, needs implementation)

**Deliverables:**
1. Implement `genie update [--target-version X.Y.Z] [--yes]` command
2. Flow:
   ```
   1. Check current version from .genie/state/version.json
   2. Fetch latest version from npm registry (or use --target-version)
   3. Run npm install -g automagik-genie@<target>
   4. Verify new version installed successfully
   5. Re-run genie init (triggers backup + file copy)
   6. Launch update agent with version transition context
   7. Display update summary report
   ```
3. Add `--dry-run` flag to preview changes without applying
4. Integrate with existing rollback utility (`bin/rollback.js`)
5. Handle edge cases:
   - Already on latest version → no-op with message
   - Version downgrade requested → confirm with user
   - Network failure during npm install → abort cleanly

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
- @.genie/agents/core/update.md – new agent (core framework agent)
- @.claude/commands/update.md – slash command wrapper
- @.claude/agents/update.md – Task tool alias

**Deliverables:**
1. Create `update.md` agent with sections:
   - **Discovery:** Analyze backup vs current framework files, detect customizations
   - **Implementation:** Apply version-specific migration instructions
   - **Verification:** Validate merged files, report conflicts
2. Agent receives context via prompt:
   ```
   @.genie/state/version.json
   @.genie/backups/<timestamp>/root-docs/AGENTS.md
   @.genie/backups/<timestamp>/root-docs/CLAUDE.md
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
genie run update "@.genie/state/version.json" --mode debug

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
- @.genie/updates/ – new directory for version transition guides
- @.genie/updates/v2.0.0-to-v2.1.0.md – example migration guide
- @.genie/cli/src/commands/update.ts – instruction loading logic

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
  - Backup mechanism includes `AGENTS.md` and `CLAUDE.md`
  - `genie update` command automates package upgrade + agent-driven migration
  - `update.md` agent merges new framework files with user customizations
  - Version-specific update guides bundled in releases
  - Rollback support via existing `genie rollback` utility
- **Out of scope:**
  - Multi-template architecture (separate wish)
  - Provider runtime override (separate wish)
  - Automated testing of update guides (manual QA by Namastex team)
  - Update notification system (future enhancement)
- **Success metrics:**
  - 100% user customizations preserved across updates (test suite validates)
  - Zero data loss during failed updates (atomic backup + rollback)
  - Update time <60s for typical framework upgrades
  - Update reports clearly document all changes
- **External tasks:**
  - FORGE-TBD-A: Backup expansion implementation
  - FORGE-TBD-B: Update CLI command
  - FORGE-TBD-C: Update agent authoring
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
