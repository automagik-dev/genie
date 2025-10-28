# Task H: Final Validation
**Group:** H
**Action:** Verify optimization results
**Target:** Complete system validation

---

## [Discovery] Context & Analysis

**What to validate:**
- AGENTS.md ≤500 lines
- Zero knowledge loss (all patterns preserved)
- @ references valid (all paths exist)
- Agents load correctly (MCP test)
- Build/tests pass

**Current state:**
- AGENTS.md: ~1425 lines (after Task F, before final condensing)
- All sections extracted to agents/docs
- Custom overrides absorbed

**Dependencies:**
- Requires Tasks A-G complete
- Sequential execution (run last)

---

## [Implementation] Final Condensing + Validation

1. **Condense remaining AGENTS.md sections:**
   - Natural Flow Protocol (753-848) → reduce to 1-paragraph summary + @ reference
   - Universal Workflow Architecture (852-987) → reduce to core principle + @ reference
   - Remaining critical behavioral overrides → keep (Delegation, Role Clarity, Execution Integrity)
   - Agent Playbook → reduce to concise identity + @ references

2. **Target structure (≤500 lines):**
   ```markdown
   # Genie Template Overview (~50 lines)
   ## Repository Self-Awareness
   ## No Backwards Compatibility
   ## Experimentation Protocol
   ## Unified Agent Stack
   ## Directory Map

   # Architectural Foundations (~150 lines)
   ## Genie Loading Architecture (critical)
   ## Agent Invocation Hierarchy (critical)

   # Natural Flow Protocol (~20 lines summary)
   @.genie/code/agents/plan.md
   @.genie/code/agents/wish/discovery.md
   @.genie/code/agents/review.md

   # Universal Workflow Architecture (~20 lines summary)
   # Critical Behavioral Overrides (~150 lines)
   - Evidence-Based Thinking
   - Delegation Discipline (critical)
   - Role Clarity Protocol (critical)
   - Execution Integrity Protocol (critical)

   # Agent Playbook (~80 lines)
   - Identity & Tone (concise)
   - @ references to agents for patterns

   # File/Naming Rules (~30 lines)
   ```

3. **Comprehensive validation:**
   - Line count check
   - Pattern preservation check
   - @ reference validation
   - MCP agent load test
   - Build/test validation

---

## [Verification] Success Criteria

**Line count:**
```bash
# CRITICAL: Must be ≤500 lines
wc -l AGENTS.md
# Expected: ~450-500 lines
test $(wc -l < AGENTS.md) -le 500 && echo "✅ Line count ≤500" || echo "❌ FAILED: Still too long"
```

**Knowledge preservation:**
```bash
# All key patterns findable in repo
grep -r "Developer Welcome Flow" .genie/ && echo "✅ GitHub patterns preserved"
grep -r "Task Breakdown Structure" .genie/ && echo "✅ Prompting standards preserved"
grep -r "Forge MCP Task Pattern" .genie/ && echo "✅ Forge patterns preserved"
grep -r "Meta-Learn" .genie/ && echo "✅ Learning patterns preserved"
grep -r "Publishing Protocol" .genie/ && echo "✅ Release protocol preserved"
grep -r "Application-Level Enforcement" .genie/ && echo "✅ Delegation enforcement preserved"
grep -r "Persistent Tracking Protocol" .genie/ && echo "✅ Session protocol preserved"
grep -r "Triad Maintenance Protocol" .genie/ && echo "✅ Triad protocol preserved"
grep -r "CLI Command Interface" .genie/ && echo "✅ MCP interface preserved"
```

**@ references valid:**
```bash
# All @ references point to existing files
grep '@.genie/' AGENTS.md | sed 's/.*@\([^ ]*\).*/\1/' | while read path; do
  test -f "$path" && echo "✅ $path exists" || echo "❌ $path MISSING"
done
```

**MCP agent load test:**
```bash
# List agents (should not error)
# Note: May fail due to Bug #101, document if so
# Expected: Shows all agents successfully registered
```

**Build/test validation:**
```bash
# Full validation suite
pnpm run check
# Expected: All checks pass (types, lint, tests)
```

**Evidence checklist:**
```bash
# All wish evidence items checked
grep -c "\[x\]" .genie/wishes/agents-optimization/agents-optimization-wish.md
# Should be 100% complete
```

---

## Post-Validation Actions

**If validation passes:**
1. Create Done Report
2. Update wish status: active → completed
3. Commit with message: "feat: optimize AGENTS.md context (2272→~500 lines, zero knowledge loss)"
4. Celebrate optimization success 🎉

**If validation fails:**
- Document failure point
- Create Blocker Report
- Rollback if necessary
- Resume at failed task

---

## Evidence Location

**Done Report:** `.genie/wishes/agents-optimization/reports/done-implementor-task-h-<timestamp>.md`
**Final Diff:** `git diff AGENTS.md` (show before/after)
**Line Count:** `wc -l AGENTS.md` (final result)
**Pattern Check:** `bash .genie/wishes/agents-optimization/validate-patterns.sh` (comprehensive grep)
