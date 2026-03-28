# Wish: genie work <slug> auto-orchestrates full wish execution

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `auto-orchestrate` |
| **Date** | 2026-03-17 |

## Summary

`genie work <slug>` (without agent or group) auto-orchestrates the entire wish — reads the Execution Strategy, spawns all agents per wave in parallel, monitors completion, advances waves, and runs review. Reduces the team-lead to 4 lines: read wish, `genie work <slug>`, create PR, `genie team done`. Closes #631.

## Scope

### IN
- New `genie work <slug>` command (no agent, no group) that orchestrates the full wish
- Parses Execution Strategy waves from WISH.md
- Spawns all agents in a wave as background processes (parallel)
- Monitors via wish state — marks groups done as workers report completion
- Advances to next wave when current wave completes
- Dispatches reviewer after all waves (if `review` group exists in strategy)
- Returns exit 0 when all groups done, exit 1 on failure
- Team-lead prompt updated to use `genie work <slug>` as primary dispatch

### OUT
- Changes to `genie work <agent> <slug>#<group>` (still works for manual dispatch)
- Changes to wish state machine logic (already works)
- QA orchestration (team-lead handles that after PR)
- Retry/fix loops within `genie work` (team-lead handles escalation)

## Decisions

| Decision | Rationale |
|----------|-----------|
| `genie work <slug>` is a new command signature, not replacing the old one | Backwards compatible. Old `genie work <agent> <slug>#<group>` still works for manual dispatch. |
| Spawns workers as background tmux panes | Workers run in parallel. `genie work` polls state file for completion, not stdout. |
| Polls wish state, not worker output | Deterministic — workers call `genie done <slug>#<group>` when complete, state file is source of truth. |
| 30s poll interval | Fast enough to be responsive, not so fast it thrashes the state file. |
| Max 30min timeout per wave | Safety valve — if a wave doesn't complete in 30min, exit with error. Team-lead decides what to do. |
| Review dispatched automatically if Execution Strategy includes a review wave | Convention: last wave with `reviewer` agent triggers review dispatch. |

## Success Criteria

- [ ] `genie work <slug>` reads Execution Strategy and spawns Wave 1 agents in parallel
- [ ] All agents in Wave 1 run simultaneously (visible in `genie ls`)
- [ ] Wave 2 starts only after all Wave 1 groups are done
- [ ] `genie work <slug>` exits 0 when all groups done
- [ ] `genie work <slug>` exits 1 if a wave times out (30min)
- [ ] `genie work <agent> <slug>#<group>` still works (backwards compatible)
- [ ] Team-lead prompt uses `genie work <slug>` as primary command
- [ ] `bun run check` passes

## Execution Groups

### Group 1: Parse Execution Strategy from WISH.md

**Goal:** Extract wave definitions from the Execution Strategy section.

**Deliverables:**
1. Add `parseExecutionStrategy(content: string)` to `src/term-commands/dispatch.ts`:
   - Parses `### Wave N` headings from the Execution Strategy section
   - Extracts the table rows: Group | Agent | Description
   - Returns `Wave[]` where each wave has `{ name: string, groups: { group: string, agent: string }[] }`
2. Handle missing Execution Strategy section — fall back to sequential (all groups in one wave, `engineer` as default agent)

**Acceptance Criteria:**
- [ ] Parses wave tables from wish template format
- [ ] Falls back to sequential if no Execution Strategy section
- [ ] Returns typed `Wave[]` array

**Validation:**
```bash
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: Implement genie work <slug> orchestrator

**Goal:** The core auto-orchestration loop.

**Deliverables:**
1. Add `autoOrchestrateCommand(slug: string)` to `src/term-commands/dispatch.ts`:
   - Read WISH.md, parse groups and execution strategy
   - Auto-initialize wish state
   - For each wave in order:
     a. Dispatch all groups in the wave using `Promise.all()` — call `workDispatchCommand(agent, slug#group)` for each group concurrently. `workDispatchCommand` spawns a tmux pane and returns — it does NOT wait for the worker to finish, so `Promise.all` resolves once all panes are created.
     b. Poll `wishState.getState(slug)` every 30s until all groups in the wave show `done`
     c. If 30min elapsed without wave completion, exit 1 with error
   - After all waves complete, exit 0
2. Register the new command signature using Commander's optional arg pattern:
   - `genie work <ref> [agent]` — if `agent` is provided AND `ref` contains `#`, it's manual mode (`workDispatchCommand`). If only `ref` (no `#`), it's auto mode (`autoOrchestrateCommand`).
   - This avoids Commander ambiguity — single command, detect mode by args.

**Acceptance Criteria:**
- [ ] `genie work <slug>` spawns all Wave 1 agents concurrently (visible in `genie ls`)
- [ ] Polls state every 30s, advances waves correctly
- [ ] Times out after 30min per wave
- [ ] `genie work <agent> <slug>#<group>` still works unchanged
- [ ] Exit codes: 0 success, 1 timeout/failure

**Validation:**
```bash
bun run typecheck && bun run lint && bun test
```

**depends-on:** Group 1

---

### Group 3: Engineer reports completion via genie done

**Goal:** Workers must call `genie done <slug>#<group>` when they finish, so the orchestrator's state poll detects completion.

**Deliverables:**
1. Update `plugins/genie/agents/engineer/AGENTS.md` — add instruction: "After completing all deliverables and validation, call `genie done <slug>#<group>` to report completion. The slug and group are in your initial prompt."
2. Update the `initialPrompt` in `workDispatchCommand()` to include the `genie done` instruction: "When done, run: `genie done <slug>#<group>`"
3. Sync flat copy `plugins/genie/agents/engineer.md`

**Acceptance Criteria:**
- [ ] Engineer prompt mentions `genie done`
- [ ] initialPrompt includes completion instruction
- [ ] Flat copy synced

**Validation:**
```bash
bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 4: Update team-lead prompt

**Goal:** Simplify team-lead to use `genie work <slug>`.

**Deliverables:**
1. Update `plugins/genie/agents/team-lead/AGENTS.md` Phase 2:
   - Primary command: `genie work <slug>` — handles all wave orchestration automatically
   - Fallback: `genie work <agent> <slug>#<group>` for manual dispatch if auto fails
   - `genie spawn` as escape hatch for custom agents
2. Sync flat copy `plugins/genie/agents/team-lead.md`

**Acceptance Criteria:**
- [ ] Phase 2 says `genie work <slug>` as the primary command
- [ ] Manual dispatch documented as fallback
- [ ] Flat copy synced

**Validation:**
```bash
diff plugins/genie/agents/team-lead/AGENTS.md plugins/genie/agents/team-lead.md
bun run typecheck && bun run lint
```

**depends-on:** Group 2

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
| 1 | engineer | Parse Execution Strategy |
| 3 | engineer | Engineer reports completion via genie done |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Auto-orchestration loop |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Team-lead prompt update |

### Wave 4 (after Wave 3)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | reviewer | Full validation |

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Workers don't call `genie done` and state never updates | Medium | 30min timeout exits with error. Team-lead can investigate. |
| Git conflicts between parallel workers in same worktree | Medium | Wish groups should be scoped to different files. If conflict happens, team-lead resolves. |
| Command parsing ambiguity between `work <slug>` and `work <agent> <ref>` | Low | Detect by: 1 arg = auto mode, 2 args with `#` = manual mode. |

---

## QA Criteria

- [ ] `genie work auto-orchestrate` spawns parallel agents per wave
- [ ] Waves advance correctly — Wave 2 only after Wave 1 complete
- [ ] Team-lead uses `genie work <slug>` and it works end-to-end
- [ ] Manual `genie work engineer slug#1` still works

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/term-commands/dispatch.ts — parseExecutionStrategy(), autoOrchestrateCommand(), command registration, initialPrompt update
plugins/genie/agents/engineer/AGENTS.md + engineer.md — add genie done completion reporting
plugins/genie/agents/team-lead/AGENTS.md + team-lead.md — simplified Phase 2
```
