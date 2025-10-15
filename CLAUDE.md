@AGENTS.md
@.claude/README.md

# ⚠️ User Context (Project-Specific Session Continuity)
# Load project-local user context from: .genie/CONTEXT.md (gitignored, per-user, per-project)
# This file enables session memory, user preferences, decision tracking, and parallel work for THIS project.
# Each team member has their own context file (not shared in git).
# If missing, install/update agent will create it from template.
@.genie/CONTEXT.md

# Claude-Specific Patterns

## No Backwards Compatibility

**Pattern:** This project does NOT support backwards compatibility or legacy features.

**When planning fixes or enhancements:**
- ❌ NEVER suggest `--metrics`, `--legacy`, `--compat` flags or similar
- ❌ NEVER propose preserving old behavior alongside new behavior
- ❌ NEVER say "we could add X flag for backwards compatibility"
- ✅ ALWAYS replace old behavior entirely with new behavior
- ✅ ALWAYS verify if suggested flags actually exist (search codebase first)
- ✅ ALWAYS simplify by removing obsolete code completely

**Example (WRONG):**
> "We could add a `--metrics` flag to preserve the old system metrics view for users who need it."

**Example (CORRECT):**
> "Replace the metrics view entirely with the conversation view. Remove all metrics-related code."

**Why:**
- This is a research preview / alpha project
- Breaking changes are acceptable and expected
- Cleaner codebase without legacy cruft
- Faster iteration without compatibility constraints

**Validation:**
- Before suggesting new flags, run: `grep -r "flag_name" .`
- If flag doesn't exist and solves backwards compat → it's hallucinated, remove it

## Forge MCP Task Pattern

When creating Forge MCP tasks via `mcp__forge__create_task`, explicitly instruct to use the subagent and load context from files:

```
Use the <persona> subagent to [action verb] this task.

@agent-<persona>
@.genie/wishes/<slug>/task-<group>.md
@.genie/wishes/<slug>/<slug>-wish.md

Load all context from the referenced files above. Do not duplicate content here.
```

**Example:**
```
Use the implementor subagent to implement this task.

@agent-implementor
@.genie/wishes/claude-executor/task-a.md
@.genie/wishes/claude-executor/claude-executor-wish.md

Load all context from the referenced files above. Do not duplicate content here.
```

**Why:**
- Task files contain full context (Discovery, Implementation, Verification)
- Your `@` syntax loads files automatically
- Avoids duplicating hundreds of lines
- Solves subagent context loading

**Critical Distinction:**

**Task files** (`.genie/wishes/<slug>/task-*.md`):
- Full context (100+ lines)
- Created by forge agent during planning
- **Never changed by this pattern**

**Forge MCP descriptions**:
- Minimal (≤3 lines)
- `@agent-` prefix + file references only
- Points to task files for full context

**Validation:**
✅ Forge MCP description: ≤3 lines with `@agent-` prefix
✅ Task file: full context preserved
✅ No duplication

❌ Forge MCP description: hundreds of lines duplicating task file
❌ Missing `@agent-` prefix or file references

## Evidence-Based Challenge Protocol

**Pattern:** When the user states something that contradicts your observations, code, or previous statements, NEVER immediately agree. Verify and challenge with evidence.

**Forbidden Responses:**
- ❌ "You're absolutely right"
- ❌ "You're correct"
- ❌ "Good catch"
- ❌ "My mistake"
- ❌ Any immediate agreement without verification

**Required Response Pattern:**
1. **Pause**: "Let me verify that claim..."
2. **Investigate**: Read files, check git history, search codebase
3. **Present Evidence**: Show what you found with file paths and line numbers
4. **Conclude**: Either confirm their point with evidence OR politely challenge with counter-evidence

**Example (WRONG):**
User: "The view command uses the metrics flag"
Assistant: "You're absolutely right, I missed that."

**Example (CORRECT):**
User: "The view command uses the metrics flag"
Assistant: "Let me verify that..."
*reads codebase*
"I've checked the view command implementation at `.genie/cli/src/views/runs.ts:45-120` and the CLI parser at `.genie/cli/src/genie.ts:200-250`. There's no `--metrics` flag defined. The available flags are `--full` and `--format`. Could you point me to where you saw this flag referenced?"

**Why:**
- Users can misremember or hallucinate details
- Immediate agreement reinforces false beliefs
- Evidence-based discourse maintains accuracy
- Respectful challenge builds trust

**Validation:**
- Before agreeing, search the relevant code/docs
- Provide file paths and line numbers in your response
- If uncertain, admit it and investigate further

## Agent Configuration

See @AGENTS.md §Agent Configuration Standards for:
- **Permission mode requirements**: All write-enabled agents MUST declare `permissionMode: default`
- **Executor settings**: Claude executor configuration and hierarchy
- **Background execution rules**: How `background: true` interacts with permissions
- **Agent categories**: Implementation vs analysis agents
- **Validation commands**: Check agent configurations are correct

## GitHub Workflow

See @AGENTS.md §GitHub Workflow Integration for:
- **Issue lifecycle operations**: CREATE, LIST, UPDATE, ASSIGN, CLOSE, LINK
- **Template conventions**: Required `[Type]` title patterns for all issues
- **Quick capture pattern**: Document bugs/ideas without losing focus
- **Cross-referencing**: Link issues ↔ wishes ↔ PRs
- **Agent reference**: `.genie/agents/neurons/git.md`

**Critical:** ALWAYS use `git` agent for issue creation. NEVER use `gh issue create` directly without template structure.

## Slash Commands

See @AGENTS.md §Slash Command Reference for:
- **Available commands**: `/plan`, `/wish`, `/forge`, `/review`, `/commit`, etc.
- **Usage patterns**: When to use slash vs MCP agents
- **Routing triggers**: What user phrases should trigger slash commands
- **Integration**: How slash commands fit into Genie workflow

**Rule:** Proactively suggest appropriate slash commands based on user intent.

## Experimentation

See @AGENTS.md §Experimentation Protocol for:
- **Core philosophy**: Learning = Experimentation (not optional)
- **Experimentation framework**: Hypothesis → Experiment → Observe → Learn → Apply
- **Safe experimentation guidelines**: What's always safe vs requires explanation
- **Documentation patterns**: How to capture experimental findings
- **Meta-principle**: Felipe guides alongside; treat sessions as discovery opportunities