# Application-Level Enforcement
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Key innovation:** `mcp__genie__list_agents` returns DIFFERENT results based on caller context.

**Scoping mechanism:**

**When git neuron invokes list_agents:**
```json
{
  "agents": [
    "git/issue",
    "git/pr",
    "git/report"
  ]
}
```
- **Cannot see:** implementor, tests, other neurons
- **Cannot see:** Workflows from other neurons
- **Prevents:** Self-delegation (git → git), cross-delegation (git → implementor)

**When implementor neuron invokes list_agents:**
```json
{
  "agents": [
    "implementor"
  ]
}
```
- **Cannot see:** git, tests, other neurons
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
- **Cannot see:** Workflows (git/issue, git/pr) - those are neuron-internal
- **Cannot see:** Thinking skills (genie/skills/*) - those are genie-internal
- **Can only start:** Top-level neurons

**Implementation requirements:**

1. **CLI context awareness:**
   - Detect caller identity (Base Genie vs neuron vs workflow)
   - Use folder structure to determine scope
   - Filter `list_agents` output by caller's delegation permissions

2. **Folder structure as source of truth:**
   - `neurons/git/` = git owns everything in this folder
   - `neurons/git/*.md` = git's workflows (children)
   - `neurons/implementor/*.md` = implementor's workflows (when added)
   - Parent folder = scope boundary

3. **Error handling:**
   - Attempt to start agent outside scope → clear error message
   - "git neuron cannot start implementor (outside scope)"
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
tree .genie/agents/neurons/ -L 2

# Expected output:
# neurons/
# ├── git/
# │   ├── git.md
# │   ├── issue.md
# │   ├── pr.md
# │   └── report.md
# ├── implementor/
# │   └── implementor.md
# └── ...
```
