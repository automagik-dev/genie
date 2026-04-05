# Wish: Parallel Execution + Wish Template Optimization

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `parallel-execution` |
| **Date** | 2026-03-17 |
| **Design** | [DESIGN.md](../../brainstorms/parallel-execution/DESIGN.md) |

## Summary

Enable parallel group execution by auto-suffixing worker role names with group IDs, add a mandatory Execution Strategy section to the wish template, update the team-lead to dispatch full waves, and inline the wish template into the `/wish` skill.

## Scope

### IN
- `genie work` auto-suffixes role with group ID (engineer → engineer-1) to allow multiple simultaneous workers
- Mandatory Execution Strategy section in wish template defining waves
- Team-lead prompt updated: dispatch full waves in parallel, not one-at-a-time
- `/wish` skill gets wish template inlined (delete separate `references/wish-template.md`)
- Also fix: `smart-install.js` should install `@latest` not `@${pluginVersion}` (bug 1 from trace)

### OUT
- Pool-based worker management or dynamic rebalancing
- Changes to dependency enforcement logic (already works via `startGroup()`)
- Changes to other skills (/brainstorm, /review, /work)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Auto-suffix with group ID | `engineer` + group `1` → `engineer-1`. Simple, predictable, no LLM decision needed |
| Execution Strategy mandatory | Even sequential wishes need it — forces planner to think about ordering and parallelism |
| Template inlined into /wish | Single source of truth, no separate file to fall out of sync |
| `smart-install.js` installs `@latest` not `@${pluginVersion}` | Plugin cache version lags behind npm — installing from cache pins to old versions |

## Success Criteria

- [ ] `genie work engineer slug#1` and `genie work engineer slug#2` run simultaneously (no "already exists" error)
- [ ] Wish template has mandatory Execution Strategy section with waves
- [ ] Team-lead prompt says to dispatch full waves in parallel
- [ ] `/wish` SKILL.md contains the full wish template (no external reference)
- [ ] `smart-install.js` installs `@automagik/genie@latest` not `@${pluginVersion}`
- [ ] `bun run check` passes

## Execution Groups

### Group 1: CLI — auto-suffix worker roles

**Goal:** Allow multiple workers with the same agent definition to run simultaneously.

**Deliverables:**
1. In `src/term-commands/dispatch.ts` `workDispatchCommand()`: when calling `handleWorkerSpawn()`, pass the role as `${agentName}-${group}` instead of `${agentName}`. The agent directory resolution still uses `agentName` (to find AGENTS.md), but the worker registers with the suffixed name.
2. Verify the worker name appears correctly in `genie ls` and `genie read`.
3. Update the duplicate-worker check in `handleWorkerSpawn()` — it should check for `engineer-1` not `engineer`.

**Acceptance Criteria:**
- [ ] `genie work engineer slug#1` spawns `engineer-1`
- [ ] `genie work engineer slug#2` spawns `engineer-2` (no collision)
- [ ] Both workers resolve the `engineer` agent definition correctly
- [ ] `genie read <team>-engineer-1` works

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** none

---

### Group 2: Wish template — Execution Strategy + inline into /wish

**Goal:** Add mandatory Execution Strategy section and inline template into the `/wish` skill.

**Deliverables:**
1. Add Execution Strategy section to the wish template with wave-based format:
```markdown
## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Scaffold project |
| 2 | engineer | Add API endpoints |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Wire frontend |
| review | reviewer | Review Groups 1+2 |
```
2. Inline the complete wish template into `skills/wish/SKILL.md` — replace the reference to `references/wish-template.md`
3. Delete `plugins/genie/references/wish-template.md` (or `references/wish-template.md` at skills root)
4. Update the `/wish` skill's instructions to require the Execution Strategy section

**Acceptance Criteria:**
- [ ] `/wish` SKILL.md contains the full wish template inline
- [ ] Template includes mandatory Execution Strategy section
- [ ] No separate wish-template.md reference file
- [ ] Skill instructions mention Execution Strategy as required

**Validation:**
```bash
test -f skills/wish/SKILL.md && echo "Skill exists"
! test -f plugins/genie/references/wish-template.md && echo "Old template deleted"
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 3: Team-lead prompt — parallel dispatch

**Goal:** Update team-lead to dispatch full waves instead of one-at-a-time.

**Deliverables:**
1. In `plugins/genie/agents/team-lead/AGENTS.md`, update Phase 2:
   - Replace "One group per engineer dispatch" with wave-based dispatch instructions
   - Team-lead reads the Execution Strategy from the wish
   - Dispatches all groups in a wave simultaneously
   - Monitors all workers in the wave, marks done as they complete
   - Advances to next wave when all groups in current wave are done
2. Sync flat copy `plugins/genie/agents/team-lead.md`

**Acceptance Criteria:**
- [ ] Team-lead prompt describes wave-based dispatch
- [ ] Instructions reference reading Execution Strategy from wish
- [ ] Flat copy synced

**Validation:**
```bash
diff plugins/genie/agents/team-lead/AGENTS.md plugins/genie/agents/team-lead.md
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 4: Fix smart-install.js version pinning

**Goal:** Install `@latest` from npm, not the plugin cache version.

**Deliverables:**
1. In `plugins/genie/scripts/smart-install.js` `installGenieCli()`: change `@automagik/genie@${pluginVersion}` to `@automagik/genie@latest`
2. When `updateChannel === 'next'`, install `@automagik/genie@next` instead

**Acceptance Criteria:**
- [ ] `installGenieCli()` uses `@latest` or `@next` tag, not `@${pluginVersion}`
- [ ] Channel config still respected

**Validation:**
```bash
grep '@latest\|@next' plugins/genie/scripts/smart-install.js
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 5: Validate

**Goal:** Full CI pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | CLI auto-suffix worker roles |
| 2 | engineer | Wish template + inline into /wish |
| 3 | engineer | Team-lead prompt parallel dispatch |
| 4 | engineer | Fix smart-install.js version pinning |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | reviewer | Full validation |

---

## QA Criteria

- [ ] Two `genie work engineer slug#1` and `genie work engineer slug#2` run simultaneously
- [ ] Fresh wish created via `/wish` includes Execution Strategy section
- [ ] Team-lead dispatches multiple groups in a wave
- [ ] `genie update` installs from npm `@latest`, not plugin cache version
- [ ] `bun run check` passes

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/term-commands/dispatch.ts — auto-suffix role names
src/term-commands/agents.ts — update duplicate-worker check if needed
skills/wish/SKILL.md — inline wish template, add Execution Strategy
plugins/genie/references/wish-template.md — DELETE
plugins/genie/agents/team-lead/AGENTS.md + team-lead.md — wave-based dispatch
plugins/genie/scripts/smart-install.js — install @latest not @${pluginVersion}
```
