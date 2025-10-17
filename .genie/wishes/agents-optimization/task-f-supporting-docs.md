# Task F: Extract Supporting Documentation

**Group:** F
**Targets:** `.genie/docs/` (create 4 supporting docs)
**Lines to extract:** AGENTS.md 479-569, 571-698, 1633-1767, 1884-1930

---

## [Discovery] Context & Analysis

**What to extract:**
- Application-Level Enforcement (lines 479-569) → `delegation-enforcement.md`
- Persistent Tracking Protocol (lines 571-698) → `session-state-protocol.md`
- Triad Maintenance Protocol (lines 1633-1767) → `triad-protocol.md`
- CLI Command Interface (lines 1884-1930) → `mcp-interface.md`

**Current state:**
- AGENTS.md: ~1797 lines (after Task E)
- Target sections contain supporting documentation
- `.genie/docs/` directory needs creation

**Dependencies:**
- Requires Task E complete
- Sequential execution (run sixth)

---

## [Implementation] Extraction Steps

1. **Create .genie/docs/ directory:**
   ```bash
   mkdir -p .genie/docs
   ```

2. **Extract to delegation-enforcement.md:**
   - Read lines 479-569 from AGENTS.md
   - Create `.genie/docs/delegation-enforcement.md`
   - Add frontmatter explaining application-level enforcement

3. **Extract to session-state-protocol.md:**
   - Read lines 571-698 from AGENTS.md
   - Create `.genie/docs/session-state-protocol.md`
   - Add frontmatter explaining SESSION-STATE.md protocol

4. **Extract to triad-protocol.md:**
   - Read lines 1633-1767 from AGENTS.md
   - Create `.genie/docs/triad-protocol.md`
   - Add frontmatter explaining triad validation system

5. **Extract to mcp-interface.md:**
   - Read lines 1884-1930 from AGENTS.md
   - Create `.genie/docs/mcp-interface.md`
   - Add frontmatter explaining MCP vs CLI interface

6. **Replace in AGENTS.md:**
   - Remove all 4 sections (lines 479-569, 571-698, 1633-1767, 1884-1930)
   - Insert @ references for each:
     - ``
     - ``
     - ``
     - ``
   - Keep surrounding sections intact

7. **Validation:**
   - Verify all 4 docs created
   - Verify AGENTS.md has all @ references
   - Check line count reduction

---

## [Verification] Success Criteria

**Files created:**
```bash
# All 4 files exist
test -f .genie/docs/delegation-enforcement.md && echo "✅ delegation-enforcement.md"
test -f .genie/docs/session-state-protocol.md && echo "✅ session-state-protocol.md"
test -f .genie/docs/triad-protocol.md && echo "✅ triad-protocol.md"
test -f .genie/docs/mcp-interface.md && echo "✅ mcp-interface.md"
```

**Pattern preservation:**
```bash
# Application-Level Enforcement
grep -q "Application-Level Enforcement" .genie/docs/delegation-enforcement.md && echo "✅ Enforcement patterns preserved"

# Persistent Tracking
grep -q "SESSION-STATE.md" .genie/docs/session-state-protocol.md && echo "✅ Tracking patterns preserved"

# Triad validation
grep -q "pre-commit hook" .genie/docs/triad-protocol.md && echo "✅ Triad patterns preserved"

# MCP interface
grep -q "mcp__genie__" .genie/docs/mcp-interface.md && echo "✅ MCP patterns preserved"
```

**AGENTS.md update:**
```bash
# @ references added
grep -q "" AGENTS.md && echo "✅ Delegation ref"
grep -q "" AGENTS.md && echo "✅ Session ref"
grep -q "" AGENTS.md && echo "✅ Triad ref"
grep -q "" AGENTS.md && echo "✅ MCP ref"

# Old content removed
! grep -q "Application-Level Enforcement" AGENTS.md && echo "✅ Content removed"
```

**Line count:**
```bash
# Expected reduction: ~372 lines
wc -l AGENTS.md
# Should be ~1425 lines after this extraction
```

---

## Evidence Location

**Done Report:** `.genie/wishes/agents-optimization/reports/done-implementor-task-f-<timestamp>.md`
**Diff:** `git diff AGENTS.md .genie/docs/`
