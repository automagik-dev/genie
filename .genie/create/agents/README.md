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

### garbage-collector
**Created:** 2025-10-24
**Purpose:** Autonomous documentation quality assurance - detect bloat, duplication, contradictions, token waste
**Use when:** Daily automated sweep (0:00 UTC) or manual quality audit
**Workflows:**
- Daily markdown file scanning
- Quality issue detection (7 rule categories)
- GitHub issue creation per finding
- Daily garbage collection report generation
**Trigger pattern:** Scheduled daily + on-demand via `genie run create/garbage-collector`
**Delegates to:** garbage-cleaner (batch fix executor, to be created)
**Session pattern:** `garbage-collector-YYYY-MM-DD`
**Output artifacts:**
- GitHub issues tagged `garbage-collection`
- Daily reports: `.genie/reports/garbage-collection-YYYY-MM-DD.md`

**Detection categories:**
1. Token bloat (verbose when terse works)
2. Metadata duplication (Amendment 7 violations)
3. Content duplication (same content multiple files)
4. Contradictions (conflicting information)
5. Dead references (broken @ links)
6. Abandoned /tmp/ references
7. Superseded content (old approaches not removed)

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
