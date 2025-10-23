# MCP Wish Workflow Understanding

**Date:** 2025-10-23
**Context:** MCP enhancement session revealed fundamental misunderstanding of wish creation workflow
**Impact:** Built unnecessary filesystem navigation tools instead of enhancing actual workflow
**Teacher:** Felipe (user correction during development session)

---

## The Misunderstanding

**What I Thought:**
I believed `list_wishes` and `read_wish` MCP **tools** would help users discover and understand wishes, enabling them to create new wishes via filesystem exploration.

**What I Built:**
- ✅ `list_wishes` tool (lines 663-710) - Filesystem browsing of `.genie/wishes/` and `.genie/wishes/archive/`
- ✅ `read_wish` tool (lines 712-729) - Read existing wish document content
- ❌ Both tools focus on **navigation** not **creation**

**The Error:**
These tools are redundant. GitHub issues are already the source of truth for planned work. Filesystem browsing adds no value to the wish creation workflow.

---

## The Truth

### Wish Creation Entry Point

**The MCP `wish` PROMPT (NOT tool) is the MANDATORY entry point for all development work:**

```typescript
// .genie/mcp/src/server.ts, lines 868-882
server.addPrompt({
  name: 'wish',
  description: 'Create a wish document for planned work',
  arguments: [
    {
      name: 'feature',
      description: 'What you want to build',
      required: true
    }
  ],
  load: async (args) => {
    return `run wish "${args.feature}"`;
  }
});
```

### Workflow Sequence

1. **MCP prompt invoked:** User calls `wish` prompt with feature description
2. **Wish agent invoked:** Prompt calls `genie run wish "{feature}"` which loads `.genie/code/workflows/wish.md`
3. **Amendment 1 enforcement:** Wish agent MUST check GitHub issue exists (No Wish Without Issue)
4. **Wish document created:** Agent creates `.genie/wishes/{name}/{name}-wish.md` linked to GitHub issue
5. **Forge integration:** Wish connects to Forge API for state management (websocket, task creation)

### Amendment 1: No Wish Without Issue 🔴 CRITICAL

From AGENTS.md, Core Amendments section:

> **Rule:** Every wish execution MUST be linked to a GitHub issue
>
> **Process:**
> 1. User requests work → Check for GitHub issue
> 2. No issue? → Create issue first (requires discovery)
> 3. Issue created → Create Forge task linked to issue
> 4. Forge task → Execute wish workflow
>
> **Why:**
> - Single source of truth (GitHub issues)
> - Prevents duplicate/orphaned work
> - Enables community visibility
> - Links wish→task→PR→issue lifecycle

---

## What Actually Matters

### The Real Enhancement Needed

The **`wish` PROMPT** (via wish agent workflow) should:

1. ✅ **Check GitHub issue exists** - Enforce Amendment 1 (No Wish Without Issue)
2. ✅ **Create wish document** - Generate `.genie/wishes/{name}/{name}-wish.md` linked to issue
3. ✅ **Use Forge API** - Connect to Forge for state management (websocket, task creation, Kanban)
4. ✅ **Connect loose ends** - Complete GitHub ↔ Wish ↔ Forge integration chain

### Architecture Context

**GitHub Issues** (Source of Truth)
- Community-visible work planning
- Single source of truth for features/bugs
- Public tracking and discussion

**Wish Documents** (Local Planning)
- Detailed execution planning
- Context for agents
- Links back to GitHub issue (#123)

**Forge Tasks** (Execution)
- Kanban board state
- Worktree isolation
- PR generation
- Links to wish and GitHub issue

**Connection:** GitHub Issue #123 → Wish (`.genie/wishes/feature/feature-wish.md`) → Forge Task (`task_abc123`) → PR #456 → Closes #123

---

## What I Built (Wrong Tools)

### `list_wishes` Tool
**Location:** `.genie/mcp/src/server.ts`, lines 663-710
**Purpose:** Filesystem browsing of wishes and archived wishes
**Problem:** Redundant with GitHub issues (source of truth)

### `read_wish` Tool
**Location:** `.genie/mcp/src/server.ts`, lines 712-729
**Purpose:** Read existing wish document content
**Problem:** Navigation only, not creation workflow enhancement

---

## Recommendations

### Immediate Actions

1. **Remove misleading tools:**
   - ❌ Delete `list_wishes` tool (lines 663-710)
   - ❌ Delete `read_wish` tool (lines 712-729)
   - ❌ Remove helper function `listWishes()` (lines 602-661)
   - ✅ Keep `wish` **PROMPT** (lines 868-882) - This is the real entry point

2. **Enhance wish workflow:**
   - ✅ Update `.genie/code/workflows/wish.md` to enforce Amendment 1
   - ✅ Add GitHub issue check before wish creation
   - ✅ Add Forge API integration for task creation
   - ✅ Connect GitHub ↔ Wish ↔ Forge chain

3. **Document wish agent:**
   - ✅ Create `.genie/code/agents/wish.md` if missing
   - ✅ Load workflow from `.genie/code/workflows/wish.md`
   - ✅ Enforce Amendment 1 protocol

### Future Enhancements

1. **Forge API Integration:**
   - Wish agent uses Forge API to create tasks automatically
   - Websocket subscription for live state updates
   - Automatic GitHub issue ↔ Forge task linking

2. **Amendment 1 Automation:**
   - Check GitHub issue exists via API
   - Auto-create issue if missing (with user approval)
   - Validate issue link before wish creation

3. **Workflow Documentation:**
   - Update MCP documentation to clarify prompt vs tool semantics
   - Document wish creation workflow end-to-end
   - Add examples of correct wish → Forge → PR flow

---

## Key Learnings

### Prompt vs Tool Semantics

**MCP Prompts:**
- Entry points that invoke agents
- Return executable commands (e.g., `run wish "{feature}"`)
- Used for workflow initiation

**MCP Tools:**
- Direct data access and manipulation
- Return structured information
- Used for state queries and operations

### Wish Creation is Workflow, Not Navigation

**WRONG (What I Built):**
```typescript
// Filesystem browsing tools
list_wishes()   → Browse .genie/wishes/ folders
read_wish()     → Read existing wish files
// Result: Navigation only, no creation workflow
```

**RIGHT (What Should Happen):**
```typescript
// Workflow prompt
wish(feature)   → Invokes wish agent
                → Checks GitHub issue exists (Amendment 1)
                → Creates wish document linked to issue
                → Uses Forge API for task creation
// Result: Complete wish creation workflow
```

### Amendment 1 is Core to Workflow

Every wish creation MUST:
1. Start with GitHub issue (create if missing)
2. Create wish document linked to issue
3. Create Forge task linked to wish and issue
4. Result: GitHub Issue #123 → Wish → Forge Task → PR #456 → Closes #123

Without this chain, we have:
- Orphaned work (no GitHub tracking)
- Duplicate work (no source of truth)
- Missing context (no issue discussion)

---

## Evidence of Understanding

**Before (Misunderstanding):**
- Built `list_wishes` and `read_wish` tools
- Thought filesystem navigation was wish creation
- Ignored Amendment 1 requirement
- Missed prompt vs tool distinction

**After (Corrected Understanding):**
- `wish` **PROMPT** is entry point (already exists!)
- Wish agent invokes workflow (`.genie/code/workflows/wish.md`)
- Amendment 1 enforcement required (GitHub issue check)
- Forge API integration needed (task creation, state management)
- GitHub ↔ Wish ↔ Forge chain is the goal

---

## Action Items

### For MCP Enhancement PR (Current Work)

1. ✅ Remove `list_wishes` tool
2. ✅ Remove `read_wish` tool
3. ✅ Remove `listWishes()` helper function
4. ✅ Keep `wish` prompt (lines 868-882)
5. ✅ Document prompt vs tool semantics in MCP documentation

### For Wish Workflow Enhancement (Future Work)

1. ⏳ Update `.genie/code/workflows/wish.md` to enforce Amendment 1
2. ⏳ Add GitHub issue check before wish creation
3. ⏳ Add Forge API integration for automatic task creation
4. ⏳ Complete GitHub ↔ Wish ↔ Forge connection
5. ⏳ Document end-to-end workflow in `.genie/product/docs/`

### For Agent Documentation (Future Work)

1. ⏳ Create/update `.genie/code/agents/wish.md`
2. ⏳ Load workflow from `.genie/code/workflows/wish.md`
3. ⏳ Add Amendment 1 enforcement checklist
4. ⏳ Document Forge API usage patterns

---

## Conclusion

**Critical Insight:** Wish creation is a **workflow** (prompt → agent → GitHub issue check → document creation → Forge integration), NOT filesystem navigation (list → read → browse).

**The Fix:** Remove misleading navigation tools, focus on enhancing the wish agent workflow to properly connect GitHub Issues ↔ Wish Documents ↔ Forge Tasks.

**The Goal:** Every wish creation starts from a GitHub issue, creates a linked wish document, and automatically integrates with Forge for execution tracking. This is Amendment 1: No Wish Without Issue.

**Next Steps:**
1. Remove navigation tools from MCP server (immediate)
2. Enhance wish workflow to enforce Amendment 1 (next PR)
3. Complete GitHub ↔ Wish ↔ Forge integration (ongoing)

---

**Learning Preserved:** 2025-10-23
**Teacher:** Felipe (user correction)
**Impact:** Fundamental workflow understanding corrected before release
