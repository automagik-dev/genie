---
name: brain-init
description: "Initialize and personalize a knowledge brain — interviews the user, refines rlmx.yaml config, generates starter entities."
---

# /brain-init — Personalize Your Knowledge Brain

Interview the user and refine a brain's rlmx.yaml configuration into a domain-specific, personalized knowledge vault.

## When to Use
- After `genie brain init` scaffolded a brain (especially generic brains)
- User wants to customize brain configuration for their domain
- Provisioning a new agent and need a tuned knowledge vault
- User explicitly invokes `/brain-init`

## Prerequisites

Requires `@automagik/genie-brain` (enterprise package). Check availability:

```bash
bun -e "try { await import('@automagik/genie-brain'); console.log('installed') } catch { console.log('missing') }"
```

If missing, inform the user: "Brain requires @automagik/genie-brain (enterprise). Install via GitHub Packages."

## Flow

### Phase 1: Detect and Read

1. **Find the brain root.** Look for `rlmx.yaml` in the current directory. If not found, check for `.obsidian/` (brain marker). If neither exists, run `genie brain init` first:
   ```bash
   genie-brain init --path .
   ```

2. **Read existing config.** Parse `rlmx.yaml` and `SYSTEM.md` to understand the current brain state. Note the detected type (codebase/agent/workspace/generic).

3. **Read context files.** Depending on detected type:
   - **Codebase**: Read `package.json`, `README.md`, `CLAUDE.md` for project context
   - **Agent**: Read `SOUL.md`, `AGENTS.md` for agent identity
   - **Workspace**: Read `.genie/` contents for workspace context
   - **Generic**: No additional context — the interview is especially important

### Phase 2: Interview (one question per message)

Ask these questions **one at a time**, waiting for the user's response before proceeding. Adapt based on the detected brain type.

**Question 1 — Domain:**
> What domain or subject area is this brain for? (e.g., "TypeScript microservices", "sales intelligence", "DevOps runbooks", "personal research")

**Question 2 — Audience:**
> Who will query this brain? (e.g., "senior engineers", "the sales team", "just me", "AI agents during code review")

**Question 3 — Reasoning style:**
> How should the brain reason? Pick one or describe:
> - **Precise**: Cite sources, show confidence levels, flag gaps
> - **Creative**: Make connections, suggest related concepts, explore
> - **Operational**: Step-by-step, runbook-style, action-oriented
> - **Analytical**: Compare tradeoffs, weigh evidence, structured output

**Question 4 — Custom tools:**
> Any specialized operations you need? The brain already has:
> [list current tools from rlmx.yaml]
>
> Suggest additions or say "these are fine". Examples:
> - `search_by_date` — find notes from a time range
> - `find_related` — semantic similarity search
> - `validate_claim` — fact-check against brain content

### Phase 3: Refine Configuration

Based on interview answers, update these sections of `rlmx.yaml`:

1. **`system:` section** — Rewrite the system prompt to be domain-specific:
   - Include the domain context from Q1
   - Tailor the audience level from Q2
   - Embed the reasoning style from Q3
   - Keep it concise (under 500 chars)

2. **`tools:` section** — Add/modify tools based on Q4:
   - Keep domain-appropriate defaults
   - Add any custom tools the user requested
   - Remove tools that don't fit the domain

3. **`criteria:` section** — Update output expectations:
   - Match the reasoning style (precise → cite sources, creative → make connections, etc.)
   - Set appropriate confidence display rules

4. **Write the updated `rlmx.yaml`.** Show the diff to the user before writing.

5. **Update `SYSTEM.md`** with the refined system prompt context.

### Phase 4: Generate Starter Entities

Create 2-3 starter entity files based on the domain:

- **Codebase**: `entities/architecture-overview.md`, `entities/conventions.md`
- **Agent**: `entities/agent-identity.md`, `entities/core-skills.md`
- **Workspace**: `entities/team-structure.md`, `entities/active-projects.md`
- **Generic**: `entities/domain-overview.md`, `entities/key-concepts.md`

Each entity uses the brain's template format:
```markdown
---
title: "<entity name>"
type: entity
entity_type: <type>
tags: [<domain-tags>]
created: <today>
updated: <today>
confidence: medium
source_type: direct
aliases: []
---

# <entity name>

## Overview
<scaffolded content based on domain>

## Context

## Relations
```

### Phase 5: Validate

1. Run `genie brain lint` (or `genie-brain health`) to verify the brain is healthy:
   ```bash
   genie-brain health --path .
   ```

2. If lint fails, fix the issues automatically and re-run.

3. Print a summary:
   ```
   Brain initialized and personalized:
     Domain: <domain>
     Audience: <audience>
     Style: <style>
     Tools: <tool count> configured
     Entities: <count> starter files created
     Health: <score>/100
   ```

## Entity Templates

### Codebase Brain Starters

```markdown
---
title: "Architecture Overview"
type: entity
entity_type: architecture
tags: [architecture, system-design]
created: {{date}}
updated: {{date}}
confidence: medium
source_type: direct
---

# Architecture Overview

## System Components

## Data Flow

## Key Decisions
```

### Agent Brain Starters

```markdown
---
title: "Agent Identity"
type: entity
entity_type: identity
tags: [identity, role]
created: {{date}}
updated: {{date}}
confidence: high
source_type: direct
---

# Agent Identity

## Role

## Capabilities

## Boundaries
```

## Rules

- **One question per message.** Never ask multiple interview questions at once.
- **Show before write.** Always show the rlmx.yaml diff before writing changes.
- **Preserve user customizations.** If rlmx.yaml was manually edited, merge changes rather than overwriting.
- **Never skip validation.** Always run lint/health after making changes.
- **Fail gracefully.** If `@automagik/genie-brain` is not installed, explain and exit. Don't attempt to scaffold manually.
- **Respect existing content.** If entities/ already has files, don't overwrite — only add new starter files that don't conflict.
