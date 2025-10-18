# 🧞 GENIE Framework
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**The Universal Agent Orchestration Framework**

GENIE is a self-contained framework for managing AI agent conversations, wishes, and orchestration. It works with any AI system (Claude, Cursor, etc.) and provides consistent tooling for agent management.

## Structure

```
.genie/
├── agents/          # Agent personalities (forge-coder, forge-tests, etc.)
├── wishes/          # Structured development wishes
├── reports/         # Done Reports and execution reports
├── cli/            # Command-line tools
│   └── genie.ts    # Universal agent conversation manager
├── templates/      # Wish and report templates
└── knowledge/      # Shared knowledge base
```

## Quick Start

### Using MCP Tools

Start a conversation with any agent:
```
mcp__genie__run with agent="template-implementor" and prompt="implement authentication"
```

Continue the conversation:
```
mcp__genie__resume with sessionId="<session-id>" and prompt="add OAuth support"
```

List active sessions:
```
mcp__genie__list_sessions
```

### Available Agents

- **forge-coder** - Feature implementation agent
- **forge-tests** - Test writing expert
- **forge-master** - Task creation and orchestration
- **forge-quality** - Code quality enforcement
- **forge-hooks** - Hook configuration agent
- **forge-qa-tester** - QA and testing coordinator
- **learn** - Unified behavioral learning and improvement

#### Local agents in this repo
- **evaluator** – {{DOMAIN}} evaluation rubric and scoring prompt (`.genie/agents/evaluator.md`)
- **refactorer** – Prompt refactoring agent (`.genie/agents/refactorer.md`)
- **rules-integrator** – Minimal, non-destructive rules updater (`.genie/agents/rules-integrator.md`)

---

<!-- NEURAL_TREE_START -->
## Agent Neural Tree

**Auto-generated** from `.genie/agents/` folder structure

**Summary:**
- Universal neurons: 17
- Code neurons: 8
- Git workflows: 3
- Create neurons: 1
- Orchestrators: 2
- **Total: 31 agents**

### Universal Neurons (Shared)

- **analyze**
- **audit**
- **challenge**
- **consensus**
- **debug**
- **docgen**
- **explore**
- **forge** → `forge`
- **learn** → `learn`
- **plan** → `...`, `genie`, `plan`
- **polish** → `polish`
- **prompt**
- **qa** → `learn`
- **refactor**
- **review** → `review`
- **roadmap** → `roadmap`
- **vibe** → `sleepy`, `$agent`

### Code Template

**Orchestrator:** `code`

**Neurons:**
- **commit**
- **git** → `git`, `report`, `pr`, `issue`
- **implementor** → `implementor`
- **install** → `review`, `forge`, `wish`, `plan`
- **release** → `release`, `commit`
- **tests** → `tests`
- **tracer**
- **wish** → `wish`

**Git workflows:** `issue`, `pr`, `report`

### Create Template

**Orchestrator:** `create`

**Neurons:**
- **wish**

<!-- NEURAL_TREE_END -->

---

### For AI Agents (Claude, etc.)

Instead of using one-shot Task tools, use MCP for full conversations:

```
# Start implementing a wish
mcp__genie__run with agent="template-implementor" and prompt=" implement Group A"

# Continue with error handling
mcp__genie__resume with sessionId="<session-id>" and prompt="tests failing, debug the issue"
```

## Conventions

### Wishes
- Stored in `.genie/wishes/`
- Named as `<feature>-wish.md`
- Contain structured implementation plans

### Reports
- Done Reports in `.genie/wishes/<slug>/reports/`
- Named as `done-<agent>-<slug>-<YYYYMMDDHHmm>.md`
- Document execution evidence and risks

### Agents
- Defined in `.genie/agents/`
- Markdown files with structured prompts
- Loaded as Codex base instructions

## Configuration

Agents configure their execution environment via two independent settings in YAML frontmatter:

### Sandbox (File System Access)
- **read-only** - Read files only (analysis, review agents)
- **workspace-write** - Read/write in workspace (default, implementation agents)
- **danger-full-access** - Full system access (rare, externally sandboxed only)

### Approval Policy (Human Interaction)
- **never** - No approvals (fully automated)
- **on-failure** - Ask when commands fail (default)
- **on-request** - Ask for risky operations (interactive)
- **untrusted** - Ask for everything (high-security)

### Agent Front Matter Reference

Each file in `.genie/agents/` can override executor behaviour by adding a YAML
front matter block. The CLI loads that block, merges it with `config.yaml`, and
translates it to `npx -y @namastexlabs/codex@0.43.0-alpha.5 exec` flags. The structure is:

```yaml
---
name: my-agent
description: Optional prompt summary
genie:
  executor: codex            # Which executor profile to use (defaults to `codex`)
  background: false          # Force foreground (otherwise inherits CLI default)
  binary: npx                # Override executable name if needed
  packageSpec: "@namastexlabs/codex@0.43.0-alpha.5"
  sessionsDir: .genie/state/agents/codex-sessions
  sessionExtractionDelayMs: 2000
  exec:
    fullAuto: true           # --full-auto
    model: gpt-5-codex       # -m
    sandbox: workspace-write # -s
    profile: null            # -p
    includePlanTool: true    # --include-plan-tool
    search: true             # --search
    skipGitRepoCheck: true   # --skip-git-repo-check
    json: false              # --json
    experimentalJson: true   # --experimental-json
    color: never             # --color
    cd: null                 # -C <path>
    outputSchema: null       # --output-schema
    outputLastMessage: null  # --output-last-message
    reasoningEffort: high    # -c reasoning.effort="high"
    images: []               # -i <path> for each entry
    additionalArgs: []       # Raw flags appended verbatim
  resume:
    includePlanTool: true
    search: true
    last: false              # --last when resuming
    additionalArgs: []
---
```

Supported keys are derived from the codex executor defaults
(`.genie/cli/src/executors/codex.ts`). Any value omitted in front matter keeps
the executor default. Unknown keys under `genie.exec` become additional `npx ...
exec` overrides, so the safest pattern is to use the fields above. Put extra
flags in `additionalArgs` to avoid accidentally shadowing future options.

## Integration

### With Claude
Claude continues to use its specific configuration in `.claude/` but leverages GENIE for agent orchestration.

### With Other Systems
Copy the `.genie/` directory to any project to enable GENIE orchestration.

## Future Extensions

- Session history and search
- Background execution monitoring
- Multi-session per agent support
- Conversation export and analysis

---

*GENIE: Making agent orchestration magical* 🧞✨
