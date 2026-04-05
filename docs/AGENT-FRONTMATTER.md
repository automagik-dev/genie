# Agent Frontmatter Schema

AGENTS.md files use YAML frontmatter to configure agent behavior. This document describes the schema, validation rules, and usage patterns.

**Source of truth:** [`src/lib/frontmatter.ts`](../src/lib/frontmatter.ts) — `AgentFrontmatterSchema`

## Schema Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | No | — | Agent identifier. Used for spawn resolution and display. |
| `description` | `string` | No | — | One-line summary of what the agent does. Shown in `genie agent directory` and agent listings. |
| `model` | `string` | No | — | Model to use. Set to `"inherit"` to use the parent session's model. Any model string is accepted (e.g., `"sonnet"`, `"opus"`, `"haiku"`). |
| `color` | `string` | No | — | Display color for the agent in team UIs and status output. |
| `promptMode` | `"system"` \| `"append"` | No | — | How the AGENTS.md body is injected into the agent's prompt. `"system"` replaces the Claude Code default system prompt; `"append"` preserves it and appends the agent body. |
| `provider` | `"claude"` \| `"codex"` \| `"claude-sdk"` | No | — | Which AI provider to use for spawn. Determines the executor backend. |
| `tools` | `string[]` | No | — | List of tools the agent is allowed to use (e.g., `["Read", "Write", "Edit", "Bash", "Glob", "Grep"]`). |
| `permissionMode` | `string` | No | — | Permission mode for the agent session (e.g., `"plan"`, `"auto"`, `"bypassPermissions"`). |
| `sdk` | `Record<string, unknown>` | No | — | SDK configuration block. Accepts any key-value pairs so new SDK options don't require parser updates. Used for advanced settings like `maxTurns`, `effort`, thinking config, and beta features. |

## Validation Behavior

The frontmatter parser uses a **warn-not-reject** strategy:

1. **Missing fields are fine.** All fields are optional. An AGENTS.md with no frontmatter (or empty frontmatter) produces an empty config object — the agent is still discoverable.

2. **Unknown fields are warned, not rejected.** If you add a key not in the schema (e.g., `author: "Alice"`), the parser logs a warning (`[frontmatter] Unknown field "author" — ignored.`) but continues parsing.

3. **Invalid enum values fall back to `undefined`.** If `promptMode` is set to an invalid value like `"prepend"`, the parser warns (`[frontmatter] Invalid value for "promptMode": "prepend" — using default.`) and treats the field as unset.

4. **Never throws.** The parser catches YAML syntax errors, type mismatches, and malformed delimiters. Agents should always be discoverable even with broken frontmatter.

### Parse flow

```
Content → extract YAML between --- delimiters
       → warn on unknown keys
       → validate with Zod schema
       → if full validation passes: return parsed object
       → if full validation fails: validate field-by-field, keeping valid ones
       → return result (never throws)
```

## Examples

### Minimal agent

```yaml
---
name: my-agent
description: "A simple task runner."
---
```

### Standard role agent

```yaml
---
name: engineer
description: "Task execution agent. Reads wish from disk, implements deliverables, validates, and reports what was built."
model: inherit
color: blue
promptMode: append
tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
---
```

### Council agent (read-only tools, specific provider)

```yaml
---
name: council--architect
description: "Systems thinking, backwards compatibility, and long-term stability review."
model: haiku
color: yellow
promptMode: append
provider: claude
tools: ["Read", "Glob", "Grep", "Bash"]
---
```

### Agent with SDK configuration

```yaml
---
name: deep-thinker
description: "Extended reasoning agent with high effort."
model: opus
promptMode: system
sdk:
  maxTurns: 42
  effort: high
---
```

### Empty frontmatter (still valid)

```yaml
---
---

This agent has no configuration. It uses all defaults and is still
discoverable by the agent system.
```

## Field Details

### `promptMode`

Controls how the AGENTS.md body text is injected into the agent's session:

- **`system`** — Replaces the Claude Code default system prompt with the AGENTS.md body. Use when you want full control over the agent's instructions.
- **`append`** — Preserves the Claude Code default system prompt and appends the AGENTS.md body. Use when you want the agent to retain standard Claude Code capabilities while adding role-specific instructions.

### `provider`

Determines which executor backend spawns the agent:

- **`claude`** — Claude Code CLI (default). Spawns via `claude` command in a tmux pane.
- **`codex`** — OpenAI Codex CLI. Spawns via `codex` command.
- **`claude-sdk`** — Claude Agent SDK. Uses the programmatic SDK executor.

### `sdk`

A permissive record that passes configuration to the SDK executor. The schema intentionally uses `z.record(z.unknown())` so new SDK options can be used without updating the parser. Common keys include:

- `maxTurns` — Maximum conversation turns
- `effort` — Reasoning effort level (`"low"`, `"medium"`, `"high"`)
- `permissionMode` — SDK-level permission mode
- Thinking/beta configuration objects

### `tools`

An array of tool names the agent is allowed to use. This maps to the `--allowedTools` flag in Claude Code. Common tool names:

- `Read`, `Write`, `Edit` — File operations
- `Bash` — Shell command execution
- `Glob`, `Grep` — File search
- `Agent` — Sub-agent spawning

## File Structure

An AGENTS.md file follows this structure:

```markdown
---
name: agent-name
description: "What the agent does."
model: inherit
color: blue
promptMode: append
tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
---

Agent body content goes here. This is the prompt injected
according to the promptMode setting.
```

The frontmatter block must be at the very start of the file, delimited by `---` on its own line. Everything after the closing `---` is the agent's prompt body.

## API

The parser is exported from `src/lib/frontmatter.ts`:

```typescript
import { parseFrontmatter, AgentFrontmatterSchema } from './lib/frontmatter.js';

// Parse frontmatter from markdown content
const config = parseFrontmatter(fileContent);
// config.name, config.model, config.promptMode, etc.

// Access the Zod schema for programmatic use
const fields = Object.keys(AgentFrontmatterSchema.shape);
```
