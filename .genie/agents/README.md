# GENIE Agents Documentation

## Overview
This directory contains agent definitions that power GENIE's intelligent orchestration capabilities via MCP. Agents are organized as:

- **Entrypoints** – the four workflow phases (`plan.md`, `wish.md`, `forge.md`, `review.md`) stored at the root of this folder.
- **Utilities** (`utilities/`) – reusable helpers (twin, analyze, debug, commit workflow, prompt, etc.).
- **Specialists** (`specialists/`) – project-tailored delivery/qa/learning agents that the install flow customizes.

Each agent is a specialized persona with specific expertise and behavioral patterns.

## Agent Parameter Configuration

When agents are invoked through the GENIE CLI, they inherit a set of default parameters that can be overridden through agent frontmatter or config.yaml.

### Codex Core Execution Parameters

| Parameter | Default | Valid Values | Description |
|-----------|---------|--------------|-------------|
| **model** | `gpt-5-codex` | Model name | AI model to use |
| **reasoningEffort** | `low` | `low`, `medium`, `high` | Reasoning depth |
| **sandbox** | `workspace-write` | `read-only`, `workspace-write`, `danger-full-access` | File system access level |
| **approvalPolicy** | `on-failure` | `never`, `on-failure`, `on-request`, `untrusted` | When to ask for approval |
| **fullAuto** | `true` | `true`, `false` | Enable full automation mode |
| **includePlanTool** | `false` | `true`, `false` | Enable planning capabilities |
| **search** | `false` | `true`, `false` | Enable web search capability |
| **profile** | `null` | String or null | Codex profile to use |
| **skipGitRepoCheck** | `false` | `true`, `false` | Skip git repository validation |
| **json** | `false` | `true`, `false` | JSON output mode |
| **experimentalJson** | `true` | `true`, `false` | Enhanced JSON output mode |
| **color** | `auto` | `auto`, `always`, `never` | Color output control |
| **cd** | `null` | Directory path | Working directory override |
| **outputSchema** | `null` | JSON schema path | Structured output schema |
| **outputLastMessage** | `null` | File path | Extract last message to file |
| **additionalArgs** | `[]` | Array of strings | Extra CLI flags passed to Codex |
| **images** | `[]` | Array of file paths | Image inputs for vision models |

### Codex Resume Parameters

| Parameter | Default | Valid Values | Description |
|-----------|---------|--------------|-------------|
| **includePlanTool** | `false` | `true`, `false` | Enable planning capabilities |
| **search** | `false` | `true`, `false` | Enable web search |
| **last** | `false` | `true`, `false` | Resume last session |
| **additionalArgs** | `[]` | Array of strings | Extra CLI flags |

### Claude Executor Parameters

| Parameter | Default | Valid Values | Description |
|-----------|---------|--------------|-------------|
| **model** | `sonnet` | `sonnet`, `opus`, `haiku` | Claude model variant |
| **permissionMode** | `default` | `default`, `acceptEdits`, `plan`, `bypassPermissions` | Permission level |
| **outputFormat** | `stream-json` | `stream-json` | Output format (fixed) |
| **allowedTools** | `[]` | Array of tool names | Whitelist of allowed tools (empty = all) |
| **disallowedTools** | `[]` | Array of patterns | Blacklist of blocked tools (empty = none) |
| **additionalArgs** (exec) | `[]` | Array of strings | Extra CLI flags for exec |
| **additionalArgs** (resume) | `[]` | Array of strings | Extra CLI flags for resume |

### Infrastructure Parameters (Both Executors)

These parameters control executor binaries and session management:

| Parameter | Codex Default | Claude Default | Description |
|-----------|---------------|----------------|-------------|
| **binary** | `npx` | `claude` | Executable command |
| **packageSpec** | `@namastexlabs/codex@0.43.0-alpha.5` | `null` | npm package for npx |
| **sessionsDir** | `~/.codex/sessions` | `null` | Session storage directory |
| **sessionExtractionDelayMs** | `null` | `1000` | Delay before reading session (ms) |

**Note:** Infrastructure parameters are typically configured in `.genie/cli/config.yaml` rather than agent frontmatter.

### Parameter Inheritance Hierarchy

1. **Agent File Metadata** (highest priority)
   - Defined in agent markdown frontmatter
   - Example: `reasoning_effort: medium`

2. **Execution Mode Configuration** (`config.yaml`)
   - Named execution modes for common scenarios (default, careful, danger, debug)
   - Applied automatically based on agent frontmatter settings

3. **Global Defaults** (`codex.ts`)
   - Fallback values for all parameters
   - Current defaults optimized for safety + speed

## Agent File Structure

Each agent file follows this structure:

```markdown
---
meta:
  name: agent-name
  reasoning_effort: medium  # Optional override
  include_plan_tool: true   # Optional override
  sandbox: workspace-write  # Optional override
---

# Agent Name

## Identity
[Agent description and purpose]

## Instructions
[Detailed behavioral instructions - becomes base-instructions]

## Capabilities
[What the agent can do]

## Constraints
[What the agent should not do]
```

## Reasoning Effort Levels

| Level | Use Case | Performance | Cost |
|-------|----------|-------------|------|
| **low** | Simple tasks, file edits, queries | Fast responses | Minimal |
| **medium** | Complex analysis, debugging | Balanced | Moderate |
| **high** | Architecture decisions, critical fixes | Thorough analysis | Higher |

## Sandbox Modes for Agents

| Mode | Permissions | Recommended For |
|------|------------|-----------------|
| **read-only** | Read files only | Analysis, review agents |
| **workspace-write** | Read/write in workspace | Implementation agents |
| **danger-full-access** | Full system access | System configuration (rare) |

## Approval Policy Modes (Codex)

Codex uses approval policies to control when human approval is required:

| Policy | Behavior | Best For |
|--------|----------|----------|
| **never** | No approvals (requires `fullAuto: true`) | Fully automated workflows |
| **on-failure** | Ask when commands fail (default) | Semi-automated tasks |
| **on-request** | Ask for risky operations | Interactive development |
| **untrusted** | Ask for everything | High-security contexts |

**Note:** Claude uses `permissionMode` instead (see Claude Executor Parameters section).

## Common Agent Configurations

### Implementation Agent (implementor)
```yaml
reasoning_effort: low
sandbox: workspace-write
approval_policy: on-failure
include_plan_tool: false
```

### Planning Agent (forge)
```yaml
reasoning_effort: medium
sandbox: workspace-write
approval_policy: on-failure
include_plan_tool: true
```

### Review Agent (qa)
```yaml
reasoning_effort: medium
sandbox: read-only
approval_policy: on-failure
include_plan_tool: false
```

### Twin Analysis (twin)
```yaml
reasoning_effort: high
sandbox: read-only
approval_policy: on-failure
include_plan_tool: true
```

### Prompt Author (prompt)
```yaml
reasoning_effort: medium
sandbox: read-only            # prompt agent must never edit files
approval_policy: on-request   # escalate if asked to exceed prompt-only scope
include_plan_tool: true       # uses planning notes for context staging
```

- Sole output is the constructed prompt text; no Done Reports or implementation steps.
- Reads repository context to enrich prompts but remains in read-only mode.
- Rejects or escalates requests that require file edits, testing, or artifact generation.

## Running Agents with Custom Parameters

### Via Frontmatter Configuration
Configure these settings in the agent's frontmatter:
```yaml
---
genie:
  executor: codex
  exec:
    reasoningEffort: high
    sandbox: read-only
    includePlanTool: true
---
```

Then run via MCP: `mcp__genie__run` with agent and prompt parameters

### Via Execution Modes
Optional convenience modes defined in `config.yaml`:
```yaml
executionModes:
  high-effort:
    exec:
      reasoningEffort: high

  safe-review:
    exec:
      sandbox: read-only
      approvalPolicy: on-request
```

Agents reference these via frontmatter, but direct configuration is preferred.

### Via Agent Metadata
Add to agent markdown frontmatter:
```yaml
---
meta:
  name: my-agent
  reasoning_effort: high
  sandbox: read-only
---
```

## Background Execution

Agents run in background by default:
```
# Starts in background, returns immediately
mcp__genie__run with agent="implementor" and prompt="Implement feature"

# Check status
mcp__genie__list_sessions

# View output
mcp__genie__view with sessionId="<session-id>" and full=true
```

## Agent Routing Map

Current agent routing (see AGENTS.md for updates):
- `implementor` → `specialists/implementor.md`
- `qa` → `specialists/qa.md`
- `polish` → `specialists/polish.md`
- `tests` → `specialists/tests.md`
- `git` | `git-workflow` → `specialists/git-workflow.md`
- `project-manager` → `specialists/project-manager.md`
- `twin` → `utilities/twin.md`
- More utilities live in `.genie/agents/utilities/`

## Best Practices

1. **Match reasoning effort to task complexity**
   - Simple edits: `low`
   - Debugging: `medium`
   - Architecture: `high`

2. **Use appropriate sandbox modes**
   - Analysis/review: `read-only`
   - Implementation: `workspace-write`
   - Never use `danger-full-access` unless absolutely necessary

3. **Configure approval policies based on trust**
   - Automated CI/CD: `never` with `--full-auto`
   - Development: `on-failure` or `on-request`
   - Production changes: `untrusted`

4. **Use frontmatter for consistency**
   - Define agent configurations in YAML frontmatter
   - Share standard patterns via agent templates

5. **Override parameters judiciously**
   - Start with defaults
   - Adjust based on observed behavior
   - Document overrides in agent metadata

## Troubleshooting

### Agent not using expected parameters?
Check priority order:
1. Agent frontmatter `genie:` section (highest priority)
2. Executor defaults in config.yaml (`executors.codex.exec` or `executors.claude.exec`)
3. Global defaults in executor source (codex.ts or claude.ts)

**Note:** Direct CLI flag overrides are not currently supported. All configuration must be done via frontmatter or config.yaml.

### Performance issues?
- Lower reasoning effort for simple tasks
- Use `low` as default, increase only when needed
- Monitor with `mcp__genie__view` for token usage

### Permission errors?
- Check sandbox mode matches task requirements
- Verify approval policy isn't blocking operations
- Review workspace scope with `/status` command

## Executor Selection: Codex vs Claude

Agents can be executed with either **Codex** or **Claude** backends. Choose based on your requirements:

### When to Use Codex (Default)
- Tasks requiring reasoning effort control (low/medium/high)
- Standard automation workflows
- Established patterns in existing agents

### When to Use Claude
- Tasks requiring Claude-specific features (MCP servers, permission modes)
- Alternative model characteristics or behaviors
- Testing or comparing outputs across executors

### Executor Configuration

Specify the executor in agent frontmatter:

```yaml
---
name: my-agent
description: Example agent
genie:
  executor: claude  # or codex (default if omitted)
  model: sonnet     # Claude model (required for claude executor)
---
```

**Available Claude Models:**
- `sonnet` - Claude Sonnet (balanced performance)
- `opus` - Claude Opus (highest capability)
- `haiku` - Claude Haiku (fastest, most efficient)

### Claude Executor Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| **model** | `sonnet` | Claude model variant |
| **permissionMode** | `default` | Permission level (see below) |
| **allowedTools** | `[]` | Whitelist of allowed tools (empty = all) |
| **disallowedTools** | `[]` | Blacklist of blocked tools (empty = none) |
| **background** | `true` | Run in background (same as Codex) |

### Claude Permission Modes

Claude uses permission modes instead of sandbox modes:

| Mode | Behavior | Use Case |
|------|----------|----------|
| **default** | Standard workspace write access | General automation |
| **acceptEdits** | Read-only mode, asks before writes | Careful/review workflows |
| **plan** | Planning mode with restricted tools | Strategic planning |
| **bypassPermissions** | Full access (dangerous) | System admin tasks |

### Tool Filtering

Control which tools agents can use:

```yaml
---
genie:
  executor: claude
  model: sonnet
  allowedTools: ["Read", "Grep", "Glob"]  # Only allow search/read
  disallowedTools: []
---
```

Block dangerous operations:

```yaml
---
genie:
  executor: claude
  model: sonnet
  allowedTools: []
  disallowedTools:
    - "Bash(rm:*)"        # Block rm commands
    - "Bash(sudo:*)"      # Block sudo
    - "Write"             # Block file writes
---
```

**Pattern Matching:**
- Exact match: `"Write"` blocks the Write tool
- Wildcard match: `"Bash(rm:*)"` blocks all Bash commands starting with rm
- Tool names are case-sensitive

### Example Agent Configurations

#### Claude Planning Agent
```yaml
---
name: claude-planner
description: Strategic planning with Claude
genie:
  executor: claude
  model: sonnet
  permissionMode: plan
  background: true
---
```

#### Claude Review Agent (Read-Only)
```yaml
---
name: claude-reviewer
description: Code review with Claude
genie:
  executor: claude
  model: sonnet
  permissionMode: acceptEdits
  allowedTools: ["Read", "Grep", "Glob"]
  background: false
---
```

#### Claude Implementation Agent
```yaml
---
name: claude-implementor
description: Feature implementation with Claude
genie:
  executor: claude
  model: sonnet
  permissionMode: default
  disallowedTools: ["Bash(rm:*)", "Bash(sudo:*)"]
  background: true
---
```

### Migrating Agents from Codex to Claude

To convert a Codex agent to Claude:

1. Add `executor: claude` to frontmatter
2. Add `model: sonnet` (or preferred model)
3. Map sandbox modes to permission modes:
   - `read-only` → `acceptEdits`
   - `workspace-write` → `default`
   - `danger-full-access` → `bypassPermissions`
4. Remove `reasoningEffort` (Claude-specific feature not exposed)
5. Test with `mcp__genie__run` with agent and prompt parameters

**Example Migration:**

Before (Codex):
```yaml
genie:
  executor: codex
  model: gpt-5-codex
  reasoningEffort: medium
  sandbox: workspace-write
```

After (Claude):
```yaml
genie:
  executor: claude
  model: sonnet
  permissionMode: default
```

### Session Management

Both executors create sessions that can be resumed and viewed:

```
mcp__genie__run with agent="my-agent" and prompt="start task"
mcp__genie__list_sessions
mcp__genie__resume with sessionId="<session-id>" and prompt="continue task"
mcp__genie__view with sessionId="<session-id>" and full=true  # View transcript
```

**Note:** Claude's `--resume` creates a new session ID that links to the previous conversation. Context is preserved, but session IDs differ per resume (by design).

### Default Executor

The default executor is set in `.genie/cli/config.yaml`:

```yaml
defaults:
  executor: codex  # Change to 'claude' to make Claude the default
```

Agents without explicit `executor:` frontmatter use this default.

## Future Enhancements

- Dynamic reasoning effort based on task analysis
- Agent-specific sandbox profiles
- Automatic parameter tuning based on success rates
- Parameter validation in agent metadata
- Unified permission model across executors
