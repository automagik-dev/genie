# AGENTS.md → CLAUDE.md Merge Plan

**Date:** 2025-10-17
**Goal:** Single source of truth for faster iteration
**Strategy:** Merge all AGENTS.md content into CLAUDE.md, delete AGENTS.md

---

## Current State

**CLAUDE.md (206 lines):**
- User context loading ()
- Claude-specific patterns
- Project conventions
- Critical behavioral overrides
- File/naming rules
- Tool requirements
- Strategic orchestration rules
- Execution patterns
- Agent playbook (minimal)

**AGENTS.md (1,374 lines):**
- Repository self-awareness
- Developer welcome flow
- GitHub workflow integration
- Experimentation protocol
- Unified agent stack
- Directory map
- Agent configuration standards
- Natural flow protocol
- Universal workflow architecture
- Evidence & storage conventions
- Testing & evaluation
- Prompting standards
- Branch & tracker guidance
- Blocker protocol
- MCP quick reference
- Chat-mode helpers
- Meta-learn & behavioral corrections
- Agent playbook (detailed)
- Strategic orchestration rules
- Routing decision matrix
- Execution patterns
- Wish document management
- Genie integration framework
- Parallel execution framework
- Genie workspace system
- Forge integration framework
- Behavioral principles
- Master principles

---

## Merge Strategy

### Phase 1: Structure Design
Create new CLAUDE.md sections to hold AGENTS.md content:

```markdown
CLAUDE.md (New Structure)
├─ [EXISTING] User Context Loading
├─ [EXISTING] Claude-Specific Patterns
├─ [EXISTING] Critical Behavioral Overrides
├─ [NEW] Repository Self-Awareness
├─ [NEW] Developer Welcome Flow
├─ [NEW] GitHub Workflow Integration
├─ [NEW] Experimentation Protocol
├─ [NEW] Agent Stack & Configuration
├─ [NEW] Natural Flow Protocol (Plan → Wish → Forge → Review)
├─ [NEW] Universal Workflow Architecture
├─ [NEW] Prompting Standards Framework
├─ [NEW] MCP Integration
├─ [NEW] Strategic Orchestration
├─ [NEW] Routing Decision Matrix
├─ [NEW] Execution Patterns
├─ [NEW] Genie Integration Framework
├─ [EXISTING] File & Naming Rules
├─ [EXISTING] Tool Requirements
└─ [EXISTING] Agent Playbook (merge both versions)
```

### Phase 2: Content Consolidation

**Deduplicate overlapping sections:**
- Both have "Agent Playbook" → Merge into single comprehensive section
- Both have "Strategic Orchestration" → Combine rules
- Both have "Execution Patterns" → Merge

**Priority order (top to bottom in CLAUDE.md):**
1. **Identity & Context** (who am I, what am I building)
2. **User Preferences** (load USERCONTEXT.md)
3. **Critical Overrides** (must-follow rules)
4. **Framework Knowledge** (how Genie works)
5. **Operational Protocols** (how to execute work)
6. **Tool & File Rules** (mechanics)

### Phase 3: @ Reference Updates

**Files that reference AGENTS.md:**
```bash
# Find all @ references to AGENTS.md
grep -r "@AGENTS.md" .genie/ .claude/ --include="*.md"
```

**Update strategy:**
- `@AGENTS.md` → `@CLAUDE.md` (or remove @ if within CLAUDE.md)
- Agent prompts: "documented in AGENTS.md" → "documented in CLAUDE.md"
- Framework Reference sections: already say "AGENTS.md §Section" → update to "CLAUDE.md §Section"

### Phase 4: Validation

**After merge, verify:**
1. All agent Framework References point to valid CLAUDE.md sections
2. No broken @ references
3. CLAUDE.md loads successfully
4. All workflows still work
5. Templates unaffected (they reference their own structure)

---

## Execution Plan

### Step 1: Backup
```bash
cp CLAUDE.md CLAUDE.md.backup
cp AGENTS.md AGENTS.md.backup
```

### Step 2: Read & Merge
1. Read AGENTS.md completely
2. Read CLAUDE.md completely
3. Create merged CLAUDE.md with logical section ordering
4. Preserve all content (no deletions yet)

### Step 3: Deduplicate
1. Identify duplicate sections
2. Merge overlapping content
3. Keep best version of each section

### Step 4: Update References
1. Find all files with `@AGENTS.md` or "AGENTS.md §"
2. Update to `@CLAUDE.md` or "CLAUDE.md §"
3. Test that references resolve correctly

### Step 5: Delete AGENTS.md
```bash
git rm AGENTS.md
```

### Step 6: Commit
```bash
git add CLAUDE.md
git commit -m "feat(docs): merge AGENTS.md into CLAUDE.md for faster iteration"
git push
```

---

## Risk Analysis

**Low Risk:**
- Content preservation (just moving, not deleting)
- Reversible (git history has backup)
- @ references easy to update

**Medium Risk:**
- File size explosion (206 → ~1,500 lines)
- Context loading time (full CLAUDE.md on every session)
- Section organization (need clear hierarchy)

**Mitigation:**
- Use clear section headers
- Test loading performance
- Can split back later if needed

**High Risk:**
- Breaking agent prompts that reference sections
- Missing @ references
- Template confusion (do they load CLAUDE.md or AGENTS.md?)

**Mitigation:**
- Comprehensive @ reference audit
- Test all agents after merge
- Templates unaffected (self-contained)

---

## Section Mapping

| AGENTS.md Section | Target Location in CLAUDE.md | Notes |
|-------------------|-------------------------------|-------|
| Repository Self-Awareness | Top (after user context) | Identity |
| Developer Welcome Flow | After self-awareness | Onboarding |
| GitHub Workflow Integration | With git agent section | Operational |
| Experimentation Protocol | After welcome flow | Philosophy |
| Agent Stack & Config | Middle section | Framework |
| Natural Flow Protocol | After agent stack | Core workflow |
| Universal Workflow | After natural flow | Architecture |
| Prompting Standards | After universal workflow | Framework |
| MCP Quick Reference | After prompting standards | Tools |
| Strategic Orchestration | After MCP | Execution |
| Routing Decision Matrix | After orchestration | Navigation |
| Execution Patterns | After routing | Patterns |
| Genie Integration | After execution patterns | Meta |
| File & Naming Rules | Existing location | Merge |
| Tool Requirements | Existing location | Merge |
| Agent Playbook | Existing location | Merge both |

---

## Success Criteria

- ✅ AGENTS.md deleted
- ✅ All content in CLAUDE.md
- ✅ All @ references updated
- ✅ All agents still work
- ✅ File loads without errors
- ✅ No duplicate sections
- ✅ Clear navigation structure

---

**Ready to execute after rc5 is live and I reset.**
