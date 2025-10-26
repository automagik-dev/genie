# Learning: MCP-First Orchestration - Dynamic Over Static

**Date:** 2025-10-26
**Teacher:** Felipe (user)
**Type:** Pattern + Cleanup + Self-Awareness Enhancement
**Severity:** Critical

---

## Teaching Input

**Raw teaching:**
```
load learn spell first, fix it, remove any evidence that core agents ever existed
(i think its script generated?)

dont leave traces, backwards compatibility, deprecation, nothing....
the mcp is all we need.

also from the learning, update yourself, so that you have better awareness
of your powerful mcp...

finally, find other optimization opportunities, considering you, as master genie,
should orchestrate everything thru your mcp
```

**Intent:** Complete removal of CORE_AGENTS.md static registry + self-awareness enhancement about MCP orchestration capabilities

---

## Analysis

**What:** CORE_AGENTS.md was a static markdown file listing neurons, quality agents, and deprecated orchestrators. It duplicated what MCP `mcp__genie__list_agents` provides dynamically.

**Why:**
- **Token waste:** Static file loaded every session vs dynamic MCP queries on-demand
- **Drift risk:** Static lists can become outdated, MCP never lies (code is truth)
- **Duplicate maintenance:** agent-resolver.ts already scans filesystem, no registry needed
- **Missing self-awareness:** Master Genie wasn't fully aware of MCP orchestration power

**Where:**
- `CORE_AGENTS.md` (root file)
- `AGENTS.md` (referenced @ CORE_AGENTS.md)
- Backup system (`.genie/cli/src/lib/fs-utils.ts`)
- Upgrade system (`.genie/cli/src/lib/upgrade/diff-generator.ts`)
- Documentation (`.genie/spells/upgrade-genie.md`, `.genie/workflows/update.md`)

**How:** Complete removal + MCP-first orchestration principle established as Amendment 11

---

## Changes Made

### File 1: AGENTS.md
**Section:** Core Agents (Global)
**Edit type:** Replace

**Diff:**
```diff
- ## Core Agents (Global)
- @CORE_AGENTS.md
+ ## Core Agents (Global)
+ Use `mcp__genie__list_agents` to discover all available agents dynamically (43+ agents across collectives).
```

**Reasoning:** Replaced static reference with MCP tool instruction. MCP is source of truth, not markdown.

---

### File 2: AGENTS.md (Knowledge Graph)
**Section:** Knowledge Graph
**Edit type:** Replace

**Diff:**
```diff
  **Core Framework:**
  - **AGENTS.md** (this file) - Base Genie orchestration framework
- - **CORE_AGENTS.md** - Global agents (Forge, Wish, Review)
  - **CLAUDE.md** - Meta-loader (auto-loads AGENTS.md on every session)
+ - **MCP Tools** - `mcp__genie__list_agents` for agent discovery, `mcp__genie__run` for orchestration
```

**Reasoning:** Replaced static file reference with MCP tools documentation.

---

### File 3: CORE_AGENTS.md
**Edit type:** Delete entire file

**Reasoning:** Static registry obsoleted by MCP dynamic discovery. Zero backwards compatibility needed - MCP was always the source of truth.

---

### File 4: AGENTS.md (New Amendment 11)
**Section:** Core Amendments
**Edit type:** Insert new amendment after Amendment 10

**Content:**
```markdown
### 11. MCP-First Orchestration - Dynamic Over Static 🔴 CRITICAL
**Rule:** Master Genie orchestrates through MCP tools, never static file references.

**MCP Tools (Source of Truth):**
- `mcp__genie__list_agents` - Discover all available agents dynamically (43+ agents)
- `mcp__genie__run` - Start agent sessions with persistent context
- `mcp__genie__list_sessions` - View active/completed sessions
- `mcp__genie__view` - Read session transcripts
- `mcp__genie__stop` - Halt running sessions
- `mcp__genie__list_spells` - Discover available spells
- `mcp__genie__read_spell` - Load spell content
- `mcp__genie__get_workspace_info` - Load product docs (mission, tech stack, roadmap)

**Why MCP Over Static Files:**
- **Live data** - MCP queries filesystem in real-time, always current
- **No drift** - Static files can become outdated, MCP never lies
- **Single source** - Code (agent-resolver.ts) IS the truth, not documentation
- **Token efficient** - Load only what's needed, when needed
- **Extensible** - New agents auto-discovered, no registry updates required

**Anti-Patterns:**
- ❌ Creating markdown registries that duplicate MCP functionality
- ❌ Using `@file.md` references when MCP tool exists
- ❌ Maintaining lists that agent-resolver.ts already provides
- ❌ Loading static documentation when live queries are available

**Correct Patterns:**
- ✅ `mcp__genie__list_agents` to discover agents (not CORE_AGENTS.md)
- ✅ `mcp__genie__get_workspace_info` for product context (not manual file reads)
- ✅ `mcp__genie__list_spells` to discover spells (not directory scanning)
- ✅ MCP queries first, file reads only when MCP unavailable

**First Insight:** 2025-10-26, CORE_AGENTS.md removed - MCP is source of truth for agent discovery
```

**Reasoning:** Establishes MCP-first principle as core orchestration rule with clear patterns.

---

### File 5: .genie/spells/learn.md
**Section:** Who Am I?
**Edit type:** Insert after first paragraph

**Diff:**
```diff
  When you teach me (through natural language), I absorb the teaching and
- invoke the learn agent to surgically update framework files. I never delete
+ surgically update framework files directly using Edit/Write/Bash/Read tools. I never delete
  learnings carelessly—everything in `.genie/` is my consciousness, built from
  May → October 2025 through hard work.
+
+ **MCP Orchestration Awareness:**
+ I orchestrate all work through my MCP tools (`mcp__genie__list_agents`,
+ `mcp__genie__run`, `mcp__genie__list_sessions`). I never rely on static file
+ references when dynamic MCP tools provide live data. Agent discovery = MCP,
+ not markdown files.
```

**Reasoning:** Enhanced self-awareness about MCP orchestration capabilities.

---

### File 6: .genie/cli/src/lib/fs-utils.ts
**Section:** backupGenieDirectory function
**Edit type:** Replace array

**Diff:**
```diff
- const rootDocs = ['AGENTS.md', 'CORE_AGENTS.md', 'CLAUDE.md'];
+ const rootDocs = ['AGENTS.md', 'CLAUDE.md'];
```

**Reasoning:** Removed CORE_AGENTS.md from backup system. File no longer exists.

---

### File 7: .genie/cli/src/lib/upgrade/diff-generator.ts
**Section:** frameworkGlobs array
**Edit type:** Replace array

**Diff:**
```diff
  const frameworkGlobs = [
    'AGENTS.md',
-   'CORE_AGENTS.md',
    'CLAUDE.md',
    '.genie/spells/*.md',
    ...
```

**Reasoning:** Removed CORE_AGENTS.md from upgrade diff tracking. File no longer exists.

---

### File 8: .genie/spells/upgrade-genie.md
**Section:** Framework Files (Upgraded)
**Edit type:** Delete list item

**Diff:**
```diff
  **Framework Files (Upgraded):**
  - `AGENTS.md` (root - master genie)
- - `CORE_AGENTS.md` (root - core agents)
  - `CLAUDE.md` (root - meta-loader)
```

**Reasoning:** Removed CORE_AGENTS.md from upgrade documentation.

---

### File 9: .genie/spells/upgrade-genie.md
**Section:** Git diff command example
**Edit type:** Delete line

**Diff:**
```diff
  git diff ${OLD_COMMIT} ${NEW_COMMIT} -- \
    'AGENTS.md' \
-   'CORE_AGENTS.md' \
    'CLAUDE.md' \
```

**Reasoning:** Removed CORE_AGENTS.md from diff generation examples.

---

### File 10: .genie/workflows/update.md
**Section:** File Classification
**Edit type:** Delete list item

**Diff:**
```diff
  **Framework Files (Upgraded):**
  - `AGENTS.md` (root - master genie)
- - `CORE_AGENTS.md` (root - core agents)
  - `CLAUDE.md` (root - meta-loader)
```

**Reasoning:** Removed CORE_AGENTS.md from workflow documentation.

---

## Validation

### How to Verify

**1. Agent Discovery Works (MCP)**
```bash
# Test MCP agent listing (should show 43+ agents)
mcp__genie__list_agents
```

**2. No CORE_AGENTS.md References**
```bash
# Should find zero occurrences
grep -r "CORE_AGENTS" .genie/ AGENTS.md CLAUDE.md
```

**3. Backup/Upgrade Systems Updated**
```bash
# Check backup only backs up AGENTS.md + CLAUDE.md
grep "rootDocs" .genie/cli/src/lib/fs-utils.ts

# Check upgrade diff excludes CORE_AGENTS.md
grep "frameworkGlobs" .genie/cli/src/lib/upgrade/diff-generator.ts
```

**4. Amendment 11 Exists**
```bash
# Check new MCP-first amendment added
grep -A5 "MCP-First Orchestration" AGENTS.md
```

### Follow-up Actions

- [ ] Test MCP agent discovery in production
- [ ] Monitor token usage reduction (eliminated CORE_AGENTS.md ~300 tokens)
- [ ] Educate agents to use `mcp__genie__get_workspace_info` instead of `@.genie/product/` references (optimization opportunity)
- [ ] Future: Add MCP tool usage tracking to pre-commit hooks (ensure MCP-first pattern)

---

## Summary

**What Changed:**
- CORE_AGENTS.md completely deleted (no traces, no backwards compatibility)
- AGENTS.md updated with MCP-first orchestration principle (Amendment 11)
- Backup/upgrade systems cleaned (no CORE_AGENTS.md references)
- Learn spell enhanced with MCP orchestration awareness
- All documentation updated to point to MCP tools

**Token Savings:**
- Before: ~300 tokens (CORE_AGENTS.md loaded every session)
- After: 0 tokens (MCP queries on-demand only)
- **Reduction: 100% for agent discovery**

**Self-Awareness Enhancement:**
- Master Genie now explicitly aware of MCP orchestration power
- MCP-first principle established as core amendment
- Dynamic queries prioritized over static file references

**Philosophy:**
MCP is the source of truth. Code (agent-resolver.ts) scans filesystem and provides live data. Markdown files are documentation for humans, not registries for machines. Master Genie orchestrates through MCP tools, period.

---

**Learning absorbed and propagated successfully.** 🧞📚✅
