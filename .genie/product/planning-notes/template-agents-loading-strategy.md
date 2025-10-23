# Planning Brief: Template Agents Loading Strategy
**Date:** 2025-10-09
**Context:** Debug investigation of `genie init` missing files
**Related Wish:** `.genie/wishes/core-template-separation/core-template-separation-wish.md`
**Phase:** 2/3 (Core Delivery Catalog + Documentation)

---

## Problem Statement

When users run `genie init`, the entire `.genie/agents/` directory is copied to their workspace, including core workflow agents (plan, wish, forge, review, orchestrator, vibe) and all core delivery agents. This violates the architectural vision where:

1. **Core agents** should remain in the NPM package and be loaded automatically by MCP
2. **No separate custom overrides folder** — project-specific guidance lives inline as "Project Notes" within agents/spells
3. **Template scaffolding** (standards, product docs, guides) should be copied to workspace

**Current Behavior:**
- `.genie/agents/` fully copied to user projects (blacklist only excludes: cli, mcp, state, backups)
- Users can modify core agents, breaking framework assumptions
- Framework updates require manual merges in user projects

**Expected Behavior:**
- Core agents loaded from NPM package location
- Workspace contains no `.genie/custom/` folder
- MCP server resolves: NPM core agents + inline project notes inside agents/spells

---

## Discovery Questions

1. **MCP Agent Resolution:** How does the MCP server currently discover and load agents?
   - Path: `.genie/mcp/src/server.ts`
   - Does it already support loading from package location?

2. **Blacklist vs Allowlist:** Should we:
   - Add `agents` to blacklist (prevents copy)?
   - Create allowlist of folders to copy instead?

3. **Project Notes Guidance:** Provide guidance on adding "Project Notes" sections in agents/spells instead of creating stubs

4. **Migration Path:** How do existing users upgrade?
   - Do they need to manually remove copied agents?
   - Can we provide a migration script?

5. **Template Content:** What exactly should be in `templates/.genie/`?
   - standards/, product/, guides/, state/
   - No `custom/` directory

---

## Proposed Solution

### Option A: Blacklist `agents/` Folder

**Changes:**
1. Update `.genie/cli/src/lib/paths.ts:16` to add `'agents'` to blacklist
2. Remove `custom/` entirely; add docs on "Project Notes" pattern
3. Update MCP server to load core agents from package location

**Pros:**
- Minimal code changes
- Clear separation: package agents vs workspace docs

**Cons:**
- Loses `.genie/agents/README.md` in user projects (could be valuable reference)
- Custom stubs need to be maintained separately

### Option B: Template-Specific `.genie/` Structure

**Changes:**
1. Create `templates/.genie/` with only:
   - (no `custom/`)
   - `standards/`
   - `product/`
   - `guides/`
   - `state/`
2. Remove blacklist logic, copy entire templates `.genie/`
3. Keep framework `.genie/agents/` separate (not in templates)

**Pros:**
- Clean conceptual model: templates/ = user workspace structure
- Framework `.genie/` = development/testing only
- No blacklist maintenance needed

**Cons:**
- Requires restructuring templates/ directory
- More upfront work
- Migration path more complex

### Recommendation: **Option A** (Blacklist)

**Rationale:**
- Faster to implement
- Less disruptive to current structure
- MCP changes isolated from template changes
- Can iterate to Option B later if needed

---

## Implementation Plan

### Task 1: Update Blacklist
**File:** `.genie/cli/src/lib/paths.ts`
**Change:**
```typescript
export function getTemplateRelativeBlacklist(): Set<string> {
  return new Set(['cli', 'mcp', 'state', 'backups', 'agents']);
}
```

### Task 2: Document Project Notes Pattern
Provide a short section in AGENTS.md describing how to add "Project Notes" inside agents/spells for repository-specific guidance (no stubs created).

### Task 3: Verify MCP Agent Resolution
**File:** `.genie/mcp/src/server.ts`
**Action:** Confirm MCP server already loads agents from package location
**Test:** Run `mcp__genie__list_agents` after init in clean project

### Task 4: Update Documentation
**Files to Update:**
- `AGENTS.md` - Note that core agents live in NPM package
- `` - Architecture diagram
- Templates `AGENTS.md` - User-facing version explaining Project Notes pattern

### Task 5: Test & Validate
```bash
# Clean directory init test
cd /tmp/test-genie-init
node /path/to/genie.js init --yes
ls -la .genie/  # Should NOT contain agents/ folder
test ! -d .genie/custom/  # custom folder retired
```

---

## Success Criteria

- ✅ `genie init` does NOT copy `.genie/agents/` to user projects
- ✅ No `.genie/custom/` directory created
- ✅ MCP server loads core agents from NPM package location
- ✅ Project Notes pattern documented and discoverable
- ✅ Documentation updated to reflect new architecture
- ✅ No breaking changes to MCP tool signatures

---

## Risks & Mitigation

**Risk 1:** MCP server doesn't support loading from package location
- **Mitigation:** Investigate MCP code first (Task 3)
- **Fallback:** Keep agents/ copied until MCP updated

**Risk 2:** Users rely on `.genie/agents/README.md` as reference
- **Mitigation:** Include agents/README.md in templates root docs
- **Alternative:** Link to online documentation

**Risk 3:** Existing users confused by upgrade
- **Mitigation:** Clear migration guide + version warning
- **Consider:** Detection logic that warns about copied agents

---

## Dependencies

- ✅ Quick Fix (Option 1) complete - templates/ populated with AGENTS.md, CLAUDE.md, .claude/
- ⏳ MCP server agent resolution investigation
- ⏳ Custom stub content templates

---

## Next Steps

1. Investigate MCP server agent loading (`.genie/mcp/src/server.ts`)
2. If MCP supports package loading → Proceed with Task 1-5
3. If MCP needs updates → Create separate wish for MCP changes
4. Run validation tests
5. Create PR with evidence

---

## Related Documents

- Wish: `.genie/wishes/core-template-separation/core-template-separation-wish.md`
- Debug Report: `.genie/reports/debug/genie-init-missing-files-20251009T1605Z.md`
- Phase 2 spec: Wish lines 68-81
- Phase 3 spec: Wish lines 83-97
