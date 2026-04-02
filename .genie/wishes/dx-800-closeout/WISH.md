# Wish: Close out #800 — fix remaining DX bugs to 100%

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `dx-800-closeout` |
| **Date** | 2026-03-28 |
| **Issue** | [#800](https://github.com/automagik-dev/genie/issues/800) |

## Summary

GitHub issue #800 reported 10 DX findings from an 8-hour power session. After triage, 7/10 are already fixed. This wish closes the remaining 2 bugs + 1 enhancement to get #800 to 100%.

## Scope

### IN
- **Bug: agent_templates leak** — `disbandTeam()` doesn't clean `agent_templates` rows. Templates accumulate forever.
- **Bug: task state never auto-advances** — when a wish group completes or a PR merges, tasks stay in `ready`/`in_progress`. PMs must manually move them.
- **Enhancement: `genie spawn --prompt`** — add a direct `--prompt` flag so agents get initial instructions without the `--extra-args` workaround.

### OUT
- Items 1-3, 5, 7-8, 10 — already fixed in prior PRs
- Task auto-advance on GitHub PR merge (that's #797, separate wish)
- Full template CRUD CLI (that's #833, separate issue)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Clean templates on disband only (not prune command) | Simplest fix, prevents growth. A prune command can come later if needed. |
| Auto-advance tasks when wish group completes in `/work` | The orchestrator already knows which group finished — just needs to call `moveTask()`. |
| `--prompt` on `genie spawn` maps to existing `initialPrompt` infra | Already wired in provider-adapters.ts and agents.ts. Just needs CLI option exposure. Zero new plumbing. |

## Success Criteria

- [ ] `genie team disband` deletes associated rows from `agent_templates`
- [ ] After `/work` completes a group, tasks in that group move to the next stage
- [ ] `genie spawn engineer --prompt "implement the login page"` starts the agent with that initial prompt
- [ ] All existing tests pass (`bun test` — 1183+)
- [ ] New tests cover template cleanup and spawn --prompt

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix template leak on disband |
| 2 | engineer | Add task auto-advance on group completion |
| 3 | engineer | Add `--prompt` flag to spawn |

### Wave 2 (after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all 3 groups |

## Execution Groups

### Group 1: Template cleanup on disband

**Goal:** Delete `agent_templates` rows when a team is disbanded.

**Deliverables:**
1. Add `DELETE FROM agent_templates WHERE team = $teamName` to `disbandTeam()` in `src/lib/team-manager.ts`
2. Add test in `src/lib/team-manager.test.ts` verifying templates are cleaned

**Acceptance Criteria:**
- [ ] After `genie team disband`, `SELECT count(*) FROM agent_templates WHERE team = '<name>'` returns 0
- [ ] Existing disband tests still pass

**Validation:**
```bash
bun test src/lib/team-manager.test.ts
```

**depends-on:** none

---

### Group 2: Task auto-advance on group completion

**Goal:** When `/work` marks a wish group as complete, move associated tasks to the next stage.

**Deliverables:**
1. In the wish completion handler (likely `src/lib/wish-state.ts` `completeGroup()`), call `moveTask()` for tasks linked to that group
2. Map group completion → task stage: `build` → `review`, `review` → `qa`, `qa` → `ship`

**Acceptance Criteria:**
- [ ] After a wish group completes, linked tasks advance one stage
- [ ] Tasks already in `ship` stage are not affected
- [ ] Test verifies stage transition on group completion

**Validation:**
```bash
bun test src/lib/wish-state.test.ts
```

**depends-on:** none

---

### Group 3: Spawn --prompt flag

**Goal:** Expose the existing `initialPrompt` infrastructure as a `--prompt` CLI option on `genie spawn`.

**Context:** Claude CLI takes the prompt as a **positional argument** (`claude [options] [prompt]`), NOT a `--prompt` flag. The genie codebase already has full `initialPrompt` support:
- `src/lib/provider-adapters.ts:325` — appends prompt as positional arg via `escapeShellArg()`
- `src/term-commands/agents.ts:832` — `handleWorkerSpawn()` accepts `initialPrompt` option
- `src/term-commands/agents.ts:1283` — resume already uses `initialPrompt` for context injection

The only missing piece is the CLI option on `genie spawn`.

**Deliverables:**
1. Add `.option('--prompt <text>', 'Initial prompt for the agent')` to spawn command in `src/genie.ts`
2. Pass `options.prompt` → `initialPrompt` in the spawn handler
3. Test that the prompt appears as a positional arg in the spawned command

**Acceptance Criteria:**
- [ ] `genie spawn engineer --prompt "hello"` spawns with `"hello"` as positional prompt arg
- [ ] Without `--prompt`, behavior is unchanged
- [ ] Test verifies prompt passthrough

**Validation:**
```bash
bun test src/term-commands/dispatch.test.ts
```

**depends-on:** none

---

## QA Criteria

- [ ] `genie team create test-qa --repo . --branch dev` → `genie team disband test-qa` → no orphan templates
- [ ] Task auto-advance fires when wish group completes
- [ ] `genie spawn` help shows `--prompt` option
- [ ] Full test suite passes

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Task-to-group linkage may not exist in current schema | Medium | Check if tasks store a `group` or `wish_slug` field; if not, Group 2 may need a schema addition |
| Claude CLI prompt is positional, not a flag | None | Already verified — `initialPrompt` infrastructure handles this correctly |

---

## Files to Create/Modify

```
src/lib/team-manager.ts          — add template cleanup to disbandTeam()
src/lib/team-manager.test.ts     — test template cleanup
src/lib/wish-state.ts            — add task advance on completeGroup()
src/lib/wish-state.test.ts       — test task advance
src/term-commands/dispatch.ts    — add --prompt flag
src/term-commands/dispatch.test.ts — test --prompt passthrough
```
