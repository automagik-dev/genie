# Create Collective Agents

Specialized agents for human-world work (non-coding). Each agent has persistent memory via session management.

## Core Agents (Always Present)

### researcher
**Created:** Core agent (foundational)
**Purpose:** Investigate topics, curate sources, synthesize findings
**Use when:** Need evidence-backed research before creating content
**Workflows:** Topic investigation, source validation, synthesis
**Session pattern:** `researcher-<topic>`

### writer
**Created:** Core agent (foundational)
**Purpose:** Content creation from briefs and research
**Use when:** Creating blog posts, documentation, marketing content
**Workflows:** Content drafting, structure creation, voice consistency
**Session pattern:** `writer-<content-type>`

### editor
**Created:** Core agent (foundational)
**Purpose:** Content refinement, polish, quality assurance
**Use when:** Content needs review, editing, quality improvement
**Workflows:** Copy editing, tone adjustment, clarity enhancement
**Session pattern:** `editor-<content-id>`

### install
**Created:** Core agent (foundational)
**Purpose:** Setup, initialization, and onboarding
**Use when:** Installing Genie, creating new workspaces, migrations
**Workflows:** Project initialization, dependency setup, configuration
**Session pattern:** `install-<context>`

### wish
**Created:** Core agent (foundational)
**Purpose:** Wish lifecycle management and orchestration
**Use when:** Creating, tracking, and completing wishes
**Workflows:** Wish creation, milestone tracking, completion validation
**Session pattern:** `wish-<wish-id>`

## Emergent Agents

(No emergent agents yet - agents emerge when patterns of repeated work appear)

## Agent Generation Philosophy

Create doesn't come with pre-built agents for every scenario. Instead, agents **emerge** when:
- User requests same type of work 3+ times
- Complex domain requires persistent expertise
- Multi-step workflow repeats regularly

See `@.genie/create/spells/agent-generation.md` for complete generation protocol.

## Agent Architecture

All agents follow this structure:
```markdown
---
name: agent-name
description: One-line specialty
genie:
  executor: claude
  background: true
---

# Agent Name • Identity & Mission
[Purpose and expertise]

## Specialty
[Unique capability]

## Operating Patterns
[Workflows and approaches]

## Delegates To
[Other agents this works with]

## Session Management
[Session naming pattern]

@AGENTS.md
```

## Usage

**Invoke agent directly:**
```bash
genie run create/<agent-name> "<task description>"
```

**Let orchestrator route:**
```bash
genie "<task description>"
# Orchestrator determines appropriate agent
```

**Resume agent session:**
```bash
genie resume <agent-name>-<context>
```
