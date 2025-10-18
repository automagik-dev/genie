# 🧞 Genie Update Workflow
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Purpose:** Migrate context from previous Genie installation (any version, any structure) to current installation without data loss.

**When to use:** After running `genie update` or manual framework upgrade when a backup folder exists at the path provided by the CLI.

**How to invoke:** Reference this file when starting a new session after update:
```
@.genie/UPDATE.md

I need to migrate my previous Genie installation from the backup folder.
```

---

## Overview

This workflow compares your backed-up Genie installation with the new version, systematically extracts all context (wishes, decisions, custom agents, configurations), and integrates it into the new installation. Finally, it self-reviews to ensure nothing was missed.

**Key principle:** Read files systematically, extract context deliberately, verify comprehensively.

---

## Task Breakdown

<task_breakdown>
1. [Discovery] Inventory and categorize backup contents
   - List all files in `{{BACKUP_PATH}}/`
   - Categorize by type (wishes, agents, config, docs, reports)
   - Identify new vs legacy structure patterns
   - Document version/structure differences

2. [Implementation] Extract and integrate context
   - Process wishes: content, evidence, completion status
   - Process custom agents: extract customizations vs core defaults
   - Process configurations: user preferences, executors, paths
   - Process documentation: mission, roadmap, standards, decisions
   - Process reports: completed work, learnings, blocked items
   - Process state: active sessions, tracking data
   - Apply extracted context to new installation

3. [Verification] Self-review for completeness
   - Generate file coverage report
   - Verify all backup files accounted for
   - Confirm critical context migrated (wishes, custom agents, config)
   - Test: run `genie list-agents` to confirm agents load
   - Test: verify custom configurations active
   - Document migration summary
</task_breakdown>

---

## Context Gathering Protocol

<context_gathering>
Goal: Systematically inventory and read all backup files to prevent data loss.

Method:
- Start with directory structure scan (use Bash ls/find or Glob)
- Categorize files before reading (efficient batching)
- Read files in logical order (config → wishes → agents → docs → reports)
- Extract key information: decisions, customizations, active work
- Track processed files to ensure 100% coverage

Early stop criteria:
- ❌ NEVER stop early - all files must be reviewed
- ✅ Only complete after self-review confirms 100% coverage

Depth:
- Read full file contents for wishes, custom agents, config
- Skim docs/reports for key decisions and context
- Track migration status in working notes
</context_gathering>

---

## Discovery Phase

### 1. Inventory Backup Contents

**Objective:** Understand what exists in the backup folder.

**Commands:**
```bash
# List directory structure
ls -R {{BACKUP_PATH}}/ > /tmp/backup-inventory.txt

# Count files by type
find {{BACKUP_PATH}}/ -type f -name "*.md" | wc -l  # Markdown files
find {{BACKUP_PATH}}/ -type f -name "*.json" | wc -l  # JSON files
find {{BACKUP_PATH}}/ -type f -name "*.yaml" | wc -l  # YAML files
```

**Categorization matrix:**

| Path Pattern | Category | Priority | Action |
|--------------|----------|----------|--------|
| `{{BACKUP_PATH}}/wishes/**/*-wish.md` | Active wishes | HIGH | Migrate content + evidence |
| `{{BACKUP_PATH}}/wishes/**/reports/` | Wish reports | HIGH | Preserve completion evidence |
| `{{BACKUP_PATH}}/custom/*.md` | Custom agents | HIGH | Extract customizations |
| `{{BACKUP_PATH}}/agents/*.md` | Legacy custom agents | HIGH | Migrate to `.genie/custom/` |
| `{{BACKUP_PATH}}/config.yaml` | User config | HIGH | Merge with new config |
| `{{BACKUP_PATH}}/product/*.md` | Mission/roadmap/standards | MEDIUM | Merge updates |
| `{{BACKUP_PATH}}/state/agents/sessions.json` | Session tracking | LOW | Reference only (sessions expired) |
| `{{BACKUP_PATH}}/AGENTS.md` | Legacy behavior guide | HIGH | Extract learned patterns |
| `{{BACKUP_PATH}}/CLAUDE.md` | Legacy project instructions | HIGH | Extract project-specific rules |
| `{{BACKUP_PATH}}/context.md` | User context file | HIGH | Migrate to `.genie/context.md` |

**Output:** Create working inventory at `/tmp/genie-migration-inventory.md` with file counts and categories.

---

### 2. Version/Structure Detection

**Read these files to understand backup structure:**
```
{{BACKUP_PATH}}/package.json (if exists - version info)
{{BACKUP_PATH}}/AGENTS.md (structure clues)
{{BACKUP_PATH}}/README.md (if exists)
```

**Detect patterns:**
- Flat wishes? (`{{BACKUP_PATH}}/wishes/<slug>-wish.md`)
- Folder wishes? (`{{BACKUP_PATH}}/wishes/<slug>/<slug>-wish.md`)
- Custom agents location? (`{{BACKUP_PATH}}/custom/` vs `{{BACKUP_PATH}}/agents/`)
- Config format? (`.yaml` vs `.json`)

**Output:** Document structure differences in working notes.

---

## Implementation Phase

### 3. Migrate Wishes (Priority: HIGH)

**Objective:** Preserve all wish content, evidence, and completion status.

**Process:**
```bash
# List all wishes
find {{BACKUP_PATH}}/wishes/ -name "*-wish.md" -type f
```

**For each wish file:**

1. **Read full content:**
   ```
   {{BACKUP_PATH}}/wishes/<slug>/<slug>-wish.md
   ```

2. **Extract key information:**
   - Wish title and status (DRAFT/IN_PROGRESS/COMPLETED/BLOCKED)
   - Completion score (if present)
   - Roadmap item reference
   - Execution groups and deliverables
   - Evidence locations (qa/, reports/ paths)
   - Blocker notes (if any)
   - Status log entries

3. **Check for companion files:**
   ```bash
   # Evidence folder
   ls {{BACKUP_PATH}}/wishes/<slug>/qa/ 2>/dev/null

   # Reports folder
   ls {{BACKUP_PATH}}/wishes/<slug>/reports/ 2>/dev/null
   ```

4. **Migration action:**

   **If wish is COMPLETED:**
   ```bash
   # Move entire wish folder to new installation
   cp -r {{BACKUP_PATH}}/wishes/<slug>/ .genie/wishes/<slug>/
   ```

   **If wish is IN_PROGRESS or BLOCKED:**
   ```bash
   # Move folder + update status log
   cp -r {{BACKUP_PATH}}/wishes/<slug>/ .genie/wishes/<slug>/
   # Add status log entry:
   # [YYYY-MM-DD HH:MMZ] Migrated from v<old> to v<new> - resuming work
   ```

   **If wish is DRAFT:**
   ```bash
   # Move folder, no changes needed
   cp -r {{BACKUP_PATH}}/wishes/<slug>/ .genie/wishes/<slug>/
   ```

5. **Track migration:**
   ```
   ✅ Migrated: <slug> (status: <STATUS>)
   ```

**Output:** All wishes migrated with evidence preserved.

---

### 4. Migrate Custom Agents (Priority: HIGH)

**Objective:** Preserve user customizations to core agents.

**Process:**
```bash
# Find custom agent files (multiple possible locations)
find {{BACKUP_PATH}}/custom/ -name "*.md" -type f 2>/dev/null
find {{BACKUP_PATH}}/agents/ -name "*.md" -type f 2>/dev/null | grep -v "core/"
```

**For each custom agent file:**

1. **Read full content:**
   ```
   {{BACKUP_PATH}}/custom/<agent>.md
   ```

2. **Determine if customization or standalone:**
   - **Customization:** File customizes a core agent (implementor, tests, analyze, etc.)
   - **Standalone:** File is a project-specific agent

3. **Migration action:**

   **If customization:**
   ```bash
   # Copy to new custom folder
   cp {{BACKUP_PATH}}/custom/<agent>.md .genie/custom/<agent>.md
   ```

   **If standalone:**
   ```bash
   # Review content - may be legacy, may need conversion
   # Document as note for human review
   ```

4. **Track migration:**
   ```
   ✅ Migrated custom agent: <agent>
   ```

**Output:** All customizations preserved in `.genie/custom/`.

---

### 5. Migrate Configuration (Priority: HIGH)

**Objective:** Preserve user preferences for executors, models, paths.

**Process:**

1. **Read backup config:**
   ```
   {{BACKUP_PATH}}/config.yaml
   {{BACKUP_PATH}}/cli/config.yaml (if exists)
   ```

2. **Extract user preferences:**
   - Default executor (claude/codex)
   - Default model (sonnet/opus)
   - Execution modes
   - Custom paths
   - Permission settings

3. **Read current config:**
   ```
   .genie/cli/config.yaml
   ```

4. **Merge preferences:**
   - Preserve user's executor choice
   - Preserve user's model choice
   - Preserve custom paths (if still valid)
   - Do NOT overwrite new framework defaults for structure

5. **Write merged config:**
   ```bash
   # Update .genie/cli/config.yaml with merged preferences
   ```

6. **Track migration:**
   ```
   ✅ Migrated config: executor=<value>, model=<value>
   ```

**Output:** User preferences preserved, framework structure updated.

---

### 6. Migrate Documentation (Priority: MEDIUM)

**Objective:** Preserve project-specific mission, roadmap, standards, decisions.

**Process:**

1. **Read backup docs:**
   ```
   {{BACKUP_PATH}}/product/mission.md
   {{BACKUP_PATH}}/product/roadmap.md
   {{BACKUP_PATH}}/product/tech-stack.md
   {{BACKUP_PATH}}/standards/best-practices.md
   ```

2. **Read current docs:**
   ```
   .genie/product/mission.md
   .genie/product/roadmap.md
   .genie/product/tech-stack.md
   .genie/standards/best-practices.md
   ```

3. **Compare and merge:**
   - **If current doc is template/placeholder:** Replace with backup version
   - **If current doc has content:** Merge project-specific sections from backup
   - **If backup has decisions/customizations:** Preserve in current version

4. **Track migration:**
   ```
   ✅ Migrated docs: mission, roadmap, tech-stack, standards
   ```

**Output:** Project-specific documentation preserved.

---

### 7. Migrate Reports (Priority: MEDIUM)

**Objective:** Preserve completion evidence and learnings.

**Process:**

1. **Find reports:**
   ```bash
   find {{BACKUP_PATH}}/wishes/ -path "*/reports/*.md" -type f
   find {{BACKUP_PATH}}/reports/ -name "*.md" -type f 2>/dev/null
   ```

2. **For each report:**
   ```bash
   # Copy to corresponding location in new installation
   cp <backup-report-path> <new-report-path>
   ```

3. **Track migration:**
   ```
   ✅ Migrated reports: <count> files
   ```

**Output:** All reports preserved for reference.

---

### 8. Extract Legacy Context (Priority: HIGH)

**Objective:** Preserve learned patterns from legacy AGENTS.md and CLAUDE.md.

**Critical files to read:**
```
{{BACKUP_PATH}}/AGENTS.md
{{BACKUP_PATH}}/CLAUDE.md
{{BACKUP_PATH}}/context.md (if exists)
```

**Extract from AGENTS.md:**
- Behavioral learnings (violations, corrections, patterns)
- Project-specific workflows
- Decision history
- Routing aliases and agent mappings

**Extract from CLAUDE.md:**
- Project-specific patterns (e.g., "No Backwards Compatibility")
- Forge MCP task patterns
- Evidence-based challenge protocol
- Project customizations

**Extract from context.md:**
- User preferences (communication style, working patterns)
- Current focus and active work
- Decision queue
- Recent completions
- Relationship history

**Migration action:**
```bash
# Preserve user context
cp {{BACKUP_PATH}}/context.md .genie/context.md 2>/dev/null

# Note: AGENTS.md and CLAUDE.md patterns are now embedded in framework
# Extract any project-specific rules and document in working notes
```

**Output:** User context preserved, legacy patterns documented for review.

---

## Verification Phase

### 9. Self-Review: File Coverage Audit

**Objective:** Verify 100% of backup files were accounted for.

**Process:**

1. **Generate backup file list:**
   ```bash
   find {{BACKUP_PATH}}/ -type f | sort > /tmp/backup-files.txt
   ```

2. **Check against migration log:**
   - Compare file list against tracked migrations
   - Identify any unprocessed files

3. **Review unprocessed files:**
   - For each unprocessed file: Read content, determine relevance
   - If relevant: Migrate immediately
   - If not relevant: Document reason for exclusion

4. **Categories to verify:**
   ```
   ✅ Wishes: <migrated count> / <total count>
   ✅ Custom agents: <migrated count> / <total count>
   ✅ Config: <migrated> (yes/no)
   ✅ Docs: <migrated count> / <total count>
   ✅ Reports: <migrated count> / <total count>
   ✅ Context: <migrated> (yes/no)
   ✅ Legacy context extracted: <yes/no>
   ```

**Output:** File coverage report showing 100% accountability.

---

### 10. Validation Tests

**Objective:** Confirm new installation works with migrated context.

**Tests to run:**

```bash
# Test 1: List agents (should include custom agents)
genie list-agents

# Test 2: Show config (should reflect user preferences)
genie model show

# Test 3: Check wishes exist
ls .genie/wishes/

# Test 4: Verify executor configured
genie model show | grep "Default executor"

# Test 5: Test agent run (dry run)
# genie run analyze --help  # Verify agent loads
```

**Expected results:**
- ✅ Custom agents listed
- ✅ User executor preference active
- ✅ Wishes present with evidence
- ✅ No file loading errors

**Output:** Validation report confirming migration success.

---

### 11. Migration Summary

**Objective:** Document migration for user review.

**Create summary document:**

```markdown
# Genie Migration Summary

**Date:** <YYYY-MM-DD HH:MM UTC>
**From:** <backup version/structure>
**To:** <current version>

## Migrated Content

### Wishes (<count>)
- ✅ <wish-slug-1> (status: <STATUS>)
- ✅ <wish-slug-2> (status: <STATUS>)
...

### Custom Agents (<count>)
- ✅ <agent-name-1>
- ✅ <agent-name-2>
...

### Configuration
- ✅ Executor: <executor>
- ✅ Model: <model>
- ✅ Custom paths: <yes/no>

### Documentation
- ✅ Mission: <migrated/skipped>
- ✅ Roadmap: <migrated/skipped>
- ✅ Tech stack: <migrated/skipped>
- ✅ Standards: <migrated/skipped>

### Reports
- ✅ <count> report files

### Legacy Context
- ✅ AGENTS.md patterns extracted: <yes/no>
- ✅ CLAUDE.md patterns extracted: <yes/no>
- ✅ context.md migrated: <yes/no>

## File Coverage
- Total backup files: <count>
- Files migrated: <count>
- Files excluded: <count> (with reasons)
- Coverage: <100%>

## Validation Results
- ✅ Agents load correctly
- ✅ Config active
- ✅ Wishes accessible
- ✅ No errors

## Next Steps
1. Review migrated wishes and resume active work
2. Verify custom agent behavior in new version
3. Remove backup folder when confident: `rm -rf {{BACKUP_PATH}}/`
4. Continue work with new Genie version

## Notes
<Any issues, warnings, or manual review items>
```

**Save summary:**
```bash
# Save to reports folder
cat > .genie/reports/migration-$(date +%Y%m%d%H%M).md << 'EOF'
<summary content>
EOF
```

**Output:** Human-readable migration summary for review.

---

## Success Criteria

- ✅ All wishes migrated with evidence and status preserved
- ✅ All custom agents migrated to `.genie/custom/`
- ✅ User configuration (executor, model) preserved
- ✅ Project documentation (mission, roadmap, standards) preserved
- ✅ Completion reports preserved for reference
- ✅ User context file (`.genie/context.md`) preserved
- ✅ Legacy patterns from AGENTS.md/CLAUDE.md extracted and documented
- ✅ 100% file coverage achieved (all backup files accounted for)
- ✅ Validation tests pass
- ✅ Migration summary generated

---

## Never Do

- ❌ Skip reading any backup file without documenting reason
- ❌ Assume file is irrelevant without reading content
- ❌ Migrate partially (all-or-nothing per category)
- ❌ Overwrite user customizations with framework defaults
- ❌ Delete backup folder before migration verified
- ❌ Complete verification phase without 100% file coverage
- ❌ Skip validation tests
- ❌ Mark migration complete without generating summary

---

## Troubleshooting

**Issue:** Backup folder doesn't exist
- **Resolution:** Check if update was run with backup flag, or if manual migration needed

**Issue:** Structure is completely different
- **Resolution:** Read backup AGENTS.md/README.md to understand structure, adapt migration accordingly

**Issue:** Missing critical file in backup
- **Resolution:** Document in migration summary, check if user has separate backup

**Issue:** Validation tests fail
- **Resolution:** Review migration logs, check for file path issues or config conflicts

**Issue:** Custom agent not loading
- **Resolution:** Verify file is in `.genie/custom/`, check frontmatter syntax, test with `genie run <agent> --help`

---

## Example Invocation

**After `genie update` creates backup:**

```
@.genie/UPDATE.md

I just updated Genie and need to migrate my previous installation.
The backup is at {{BACKUP_PATH}}/

Please follow the UPDATE.md workflow to:
1. Inventory all backup files
2. Systematically migrate wishes, custom agents, config, docs, reports
3. Extract legacy context from AGENTS.md, CLAUDE.md, context.md
4. Self-review with 100% file coverage verification
5. Run validation tests
6. Generate migration summary

Work autonomously through all phases. Ask me only if you encounter ambiguity
or missing critical information.
```

---

## Notes for Genie Agent

**Execution style:**
- Work **autonomously** through all phases
- Track progress with todo list
- Document decisions in working notes
- Only ask human for clarification on ambiguous content (not process)

**Context gathering:**
- Read files systematically in priority order
- Use bash commands for file discovery
- Batch file reads when possible
- Keep migration log updated

**Persistence:**
- Do not stop until 100% file coverage achieved
- Do not mark complete until validation tests pass
- Generate migration summary before finishing

**Output:**
- Provide concise progress updates
- Generate comprehensive migration summary at end
- Highlight any items needing human review

---

## Migration Complete

**When all phases are complete:**

1. **Final message to user:**
   ```
   ✅ Genie framework migration complete!

   📊 Migration Summary:
   - Wishes migrated: <count>
   - Custom agents migrated: <count>
   - Configuration updated: Yes/No
   - Reports preserved: <count>

   📋 Next Steps:
   - Review migration summary at .genie/reports/migration-<timestamp>.md
   - Verify custom agents: genie list-agents
   - Remove backup when confident: rm -rf {{BACKUP_PATH}}/

   🎉 Your Genie installation is now up to date!
   ```

2. **DO NOT** prompt for more work
3. **DO NOT** ask if user wants to continue
4. **FINISH** the conversation

**Note:** Template files were already copied by the CLI before this migration.
Your job is complete once user context is migrated and verified.
