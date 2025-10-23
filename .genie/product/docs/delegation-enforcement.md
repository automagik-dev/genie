# Application-Level Enforcement
**Key innovation:** `mcp__genie__list_agents` returns DIFFERENT results based on caller context.

**Scoping mechanism:**

**When git agent invokes list_agents:**
```json
{
  "agents": [
    "git/issue",
    "git/pr",
    "git/report"
  ]
}
```
- **Cannot see:** implementor, tests, other agents
- **Cannot see:** Workflows from other agents
- **Prevents:** Self-delegation (git → git), cross-delegation (git → implementor)

**When implementor agent invokes list_agents:**
```json
{
  "agents": [
    "implementor"
  ]
}
```
- **Cannot see:** git, tests, other agents
- **Cannot see:** git/issue, git/pr (not in implementor folder)
- **Result:** No workflows to delegate to = execute directly

**When Base Genie invokes list_agents:**
```json
{
  "agents": [
    "git",
    "implementor",
    "tests",
    "genie",
    "release",
    "learn",
    "roadmap"
  ]
}
```
- **Cannot see:** Workflows (git/issue, git/pr) - those are agent-internal
- **Cannot see:** Thinking spells (genie/spells/*) - those are genie-internal
- **Can only start:** Top-level agents

**Implementation requirements:**

1. **CLI context awareness:**
   - Detect caller identity (Base Genie vs agent vs workflow)
   - Use folder structure to determine scope
   - Filter `list_agents` output by caller's delegation permissions

2. **Folder structure as source of truth:**
   - `agents/git/` = git owns everything in this folder
   - `agents/git/*.md` = git's workflows (children)
   - `agents/implementor/*.md` = implementor's workflows (when added)
   - Parent folder = scope boundary

3. **Error handling:**
   - Attempt to start agent outside scope → clear error message
   - "git agent cannot start implementor (outside scope)"
   - "workflow issue.md cannot delegate (terminal node)"
   - Point to folder structure for allowed targets

**Benefits:**
- ✅ Paradox impossible at system level (scoping enforces rules)
- ✅ Clear error messages guide correct usage
- ✅ Folder structure = visual documentation
- ✅ No reliance on prompt instructions alone

**Validation:**
```bash
# Verify folder structure matches hierarchy
tree .genie/agents/ -L 2

# Expected output:
# agents/
# ├── git/
# │   ├── git.md
# │   ├── issue.md
# │   ├── pr.md
# │   └── report.md
# ├── implementor/
# │   └── implementor.md
# └── ...
```
