# Wish: Documentation & Prompt Overhaul

**Status:** DRAFT
**Slug:** `docs-overhaul`
**Created:** 2026-03-16

---

## Summary

Three documentation surfaces are stale after the v3.260316 release cycle. README.md is missing the team-lead architecture, `--wish` flag, agent directory, and worktree changes. Orchestration rules don't cover the full lifecycle. Agent prompts need the prompt-optimizer treatment for clarity and precision. Fix all three.

---

## Scope

### IN
- **README.md** — fix outdated CLI reference, add team-lead flow, `--wish`, agent directory, worktree path change, `@next` pipeline. Keep marketing structure and tone.
- **Orchestration rules** (`plugins/genie/rules/genie-orchestration.md`) — add team-lead lifecycle, `--wish`, agent directory, full command set
- **PM prompt** (`plugins/genie/agents/pm/`) — switch to `promptMode: system` with XML behavioral blocks (same treatment as team-lead)
- **Worker prompts** (engineer, reviewer, qa, fix, refactor, trace, docs, learn) — stay `promptMode: append`, refine with XML blocks via prompt-optimizer
- **Council prompts** (council parent + 10 members) — stay `promptMode: append`, refine with XML blocks, keep persona inspirations

### OUT
- Changing agent behavior or capabilities (only prompt clarity/structure)
- Adding new features or CLI commands
- Changing team-lead prompt (already done in #616)
- Changing promptMode to system for workers or council (only PM and team-lead get system)

---

## Decisions

- **DEC-1:** Keep README marketing structure (features grid, comparison table, pipeline diagram). Only fix what's wrong and add what's new.
- **DEC-2:** PM and team-lead get `promptMode: system`. All other agents stay `append`.
- **DEC-3:** Every prompt rewrite MUST go through the actual prompt-optimizer reference at `references/prompt-optimizer.md`. No shortcuts — load it, classify the prompt type, apply the patterns, validate against the quality checklist.
- **DEC-4:** Council persona inspirations are kept — they're perspective framing, not role prompting.
- **DEC-5:** Append-mode agents do NOT need tool usage sections (CC defaults provide that).

---

## Success Criteria

- [ ] README.md reflects current CLI commands, team-lead flow, `--wish`, agent directory, worktree paths
- [ ] Orchestration rules cover full team-lead lifecycle and `--wish` usage
- [ ] PM prompt uses `promptMode: system` with XML blocks
- [ ] All 8 worker prompts refined with XML blocks via prompt-optimizer
- [ ] All 11 council prompts refined with XML blocks via prompt-optimizer, personas preserved
- [ ] `bun run check` passes
- [ ] Both flat `.md` and folder `AGENTS.md` copies are in sync for every agent

---

## Assumptions

- **ASM-1:** The prompt-optimizer reference at `references/prompt-optimizer.md` is the authoritative guide for all prompt rewrites.

## Risks

- **RISK-1:** 21 prompts changed at once — if an agent test breaks, it blocks everything. Mitigation: run tests after each group.
- **RISK-2:** System mode for PM might break PM agents in user deployments. Mitigation: PM gets tool usage section since CC defaults are gone.

---

## Execution Groups

### Group 1: README + Orchestration Rules

**Goal:** Fix outdated README and orchestration rules to reflect current state.

**Deliverables:**
1. Update `README.md`:
   - Fix CLI reference table (add `genie team create --wish`, `genie team done/blocked`, `genie dir` commands)
   - Add team-lead autonomous flow to Quick Start or Features
   - Update worktree path info (now `~/.genie/worktrees/<project>/`)
   - Update agent directory section
   - Fix Hook Presets section or remove if stale
   - Keep marketing tone, features grid, comparison table
2. Update `plugins/genie/rules/genie-orchestration.md`:
   - Add team-lead lifecycle explanation
   - Add `genie team create --wish <slug>` as the primary orchestration command
   - Add agent directory commands
   - Document full command set

**Acceptance Criteria:**
- [ ] README mentions `genie team create --wish`
- [ ] README CLI reference matches actual `genie --help` output
- [ ] Orchestration rules explain the team-lead lifecycle
- [ ] No references to removed or renamed commands

**Validation:**
```bash
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: PM Prompt (system mode)

**Goal:** Refine PM prompt to system mode with XML behavioral blocks.

**Deliverables:**
1. Load `references/prompt-optimizer.md` — follow it strictly
2. Rewrite `plugins/genie/agents/pm/AGENTS.md` — classify as Workflow type, apply XML blocks, set `promptMode: system`, include tool usage section
3. Rewrite `plugins/genie/agents/pm/SOUL.md` and `plugins/genie/agents/pm/HEARTBEAT.md` if they exist — inline into AGENTS.md or keep separate if referenced
4. Sync `plugins/genie/agents/pm.md` (flat copy)
5. Update any tests that assert PM promptMode

**Acceptance Criteria:**
- [ ] PM AGENTS.md has `promptMode: system`
- [ ] PM prompt uses XML-tagged behavioral blocks
- [ ] No role prompting ("You are a PM")
- [ ] Tool usage section included
- [ ] Flat copy synced

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 3: Worker Agent Prompts (append mode, refined)

**Goal:** Refine 8 worker agent prompts with XML blocks via prompt-optimizer.

**Agents:** engineer, reviewer, qa, fix, refactor, trace, docs, learn

**Deliverables:**
1. Load `references/prompt-optimizer.md` — follow it strictly for each prompt
2. For each agent: rewrite AGENTS.md with XML blocks, keep `promptMode: append` (or add it explicitly)
3. Classify each prompt type (Task for engineer/fix, Evaluator for reviewer/qa, etc.)
4. Sync flat `.md` copies for each
5. Do NOT add tool usage sections (append mode inherits CC defaults)

**Acceptance Criteria:**
- [ ] All 8 worker AGENTS.md files use XML-tagged blocks
- [ ] No role prompting
- [ ] All flat copies synced
- [ ] `promptMode: append` explicit on all

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 4: Council Agent Prompts (append mode, refined)

**Goal:** Refine 11 council agent prompts with XML blocks via prompt-optimizer.

**Agents:** council (parent), council--architect, council--benchmarker, council--deployer, council--ergonomist, council--measurer, council--operator, council--questioner, council--sentinel, council--simplifier, council--tracer

**Deliverables:**
1. Load `references/prompt-optimizer.md` — follow it strictly for each prompt
2. For each agent: rewrite AGENTS.md with XML blocks, keep `promptMode: append`
3. Classify as Evaluator type (they critique and assess)
4. Keep persona inspirations (Linus Torvalds, Troy Hunt, etc.) as perspective framing, NOT role prompting
5. Sync flat `.md` copies for each

**Acceptance Criteria:**
- [ ] All 11 council AGENTS.md files use XML-tagged blocks
- [ ] Persona inspirations preserved but not as "You are X"
- [ ] All flat copies synced
- [ ] `promptMode: append` explicit on all

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 5: Final Validation

**Goal:** Full CI pass after all changes.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## QA Criteria

- [ ] README Quick Start works for a new user
- [ ] CLI reference table matches `genie --help` output
- [ ] All agent prompts have XML blocks
- [ ] PM and team-lead have `promptMode: system`, all others `append`
- [ ] `bun run check` passes with zero errors

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
README.md
plugins/genie/rules/genie-orchestration.md
plugins/genie/agents/pm/AGENTS.md + pm.md + SOUL.md + HEARTBEAT.md
plugins/genie/agents/engineer/AGENTS.md + engineer.md
plugins/genie/agents/reviewer/AGENTS.md + reviewer.md
plugins/genie/agents/qa/AGENTS.md + qa.md
plugins/genie/agents/fix/AGENTS.md + fix.md
plugins/genie/agents/refactor/AGENTS.md + refactor.md
plugins/genie/agents/trace/AGENTS.md + trace.md
plugins/genie/agents/docs/AGENTS.md + docs.md
plugins/genie/agents/learn/AGENTS.md + learn.md
plugins/genie/agents/council/AGENTS.md + council.md
plugins/genie/agents/council--architect/AGENTS.md + council--architect.md
plugins/genie/agents/council--benchmarker/AGENTS.md + council--benchmarker.md
plugins/genie/agents/council--deployer/AGENTS.md + council--deployer.md
plugins/genie/agents/council--ergonomist/AGENTS.md + council--ergonomist.md
plugins/genie/agents/council--measurer/AGENTS.md + council--measurer.md
plugins/genie/agents/council--operator/AGENTS.md + council--operator.md
plugins/genie/agents/council--questioner/AGENTS.md + council--questioner.md
plugins/genie/agents/council--sentinel/AGENTS.md + council--sentinel.md
plugins/genie/agents/council--simplifier/AGENTS.md + council--simplifier.md
plugins/genie/agents/council--tracer/AGENTS.md + council--tracer.md
```
