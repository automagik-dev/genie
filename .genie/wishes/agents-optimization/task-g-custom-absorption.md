# Task G: Absorb .genie/custom/ Content
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Group:** G
**Action:** Merge custom overrides into agents
**Targets:** All agents with corresponding `.genie/custom/` files

---

## [Discovery] Context & Analysis

**What to absorb:**
- Scan `.genie/custom/` for files
- Match each file to corresponding agent
- Merge content into agent files
- Delete custom files (except routing.md - orchestrator-only)

**Current state:**
- AGENTS.md: ~1425 lines (after Task F)
- .genie/custom/ contains project-specific overrides
- Agents exist at `.genie/agents/genie/agents/`

**Dependencies:**
- Requires Task F complete
- Sequential execution (run seventh)

---

## [Implementation] Extraction Steps

1. **List custom files:**
   ```bash
   ls -1 .genie/custom/*.md 2>/dev/null
   ```

2. **For each custom file (except routing.md):**
   - Read `.genie/custom/<name>.md`
   - Find matching agent: `.genie/agents/genie/agents/<name>/<name>.md`
   - Append custom content to agent with "## Project-Specific Overrides" section
   - Delete custom file

3. **Keep routing.md:**
   - routing.md stays (orchestrator-only, not agent-specific)
   - Document why it stays in comments

4. **Update AGENTS.md:**
   - Add note that custom overrides absorbed into agents
   - Keep @ reference to routing.md for orchestrators

5. **Validation:**
   - Verify custom patterns now in agents
   - Verify custom files deleted (except routing.md)
   - Check no functionality lost

---

## [Verification] Success Criteria

**Custom files absorption:**
```bash
# List remaining custom files
ls -1 .genie/custom/*.md 2>/dev/null
# Should only show routing.md

# Check agents contain "Project-Specific Overrides"
find .genie/agents/genie/agents/ -name "*.md" -exec grep -l "Project-Specific Overrides" {} \;
# Should show agents that had custom overrides
```

**Pattern preservation:**
```bash
# For each absorbed file, verify patterns in agents
# Example: if custom/git.md existed
if [ ! -f .genie/custom/git.md ]; then
  grep -q "Project-Specific Overrides" .genie/agents/genie/agents/git/git.md && echo "✅ Git overrides absorbed"
fi
```

**routing.md stays:**
```bash
# routing.md still exists (orchestrator-only)
test -f .genie/custom/routing.md && echo "✅ routing.md preserved"
```

**Line count:**
```bash
# No AGENTS.md change (custom was separate)
wc -l AGENTS.md
# Should still be ~1425 lines
```

---

## Evidence Location

**Done Report:** `.genie/wishes/agents-optimization/reports/done-implementor-task-g-<timestamp>.md`
**Diff:** `git diff .genie/custom/ .genie/agents/genie/agents/`
