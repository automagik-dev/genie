# Wish: Leader Auto-Kickoff + Orchestration Rules Review

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `leader-auto-kickoff` |
| **Date** | 2026-03-15 |

## Summary

The task leader spawned via `genie team create --wish` sits idle until manually messaged. Fix: auto-send a kick-off message after spawn so it's truly fire-and-forget. Also review and fix the orchestration rules content in `smart-install.js` and `install.sh` to ensure they reflect the current CLI, skill chain, and task leader workflow — these rules are what every genie-managed agent loads on startup.

## Scope

### IN

- Auto-send kick-off message to leader after spawn in `spawnLeaderWithWish()`
- Review orchestration rules content (`ORCHESTRATION_PROMPT` in `smart-install.js` line 243 and matching content in `install.sh`)
- Verify orchestration rules contain: current CLI commands, skill auto-invocation chain, task leader workflow, team lifecycle, QA loop, PR review rules
- Fix any stale or missing content in orchestration rules
- Verify the orchestration rules get correctly written to `~/.claude/rules/genie-orchestration.md` on install/update

### OUT

- Changes to the leader's system prompt content
- Changes to team create flow beyond the auto-send
- New CLI commands
- Changes to how `smart-install.js` triggers (SessionStart hook)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Use `genie send` for kick-off after spawn | Simple, uses existing infra. The message triggers Claude Code's first turn. |
| Small delay before send | Leader needs a few seconds to start Claude Code before it can receive messages |
| Orchestration rules are the single source of agent knowledge | Every agent loads `~/.claude/rules/genie-orchestration.md` — it must be complete and current |

## Success Criteria

- [ ] `genie team create --wish <slug>` spawns leader AND leader begins working without manual intervention
- [ ] No manual `genie send 'Start'` needed
- [ ] Orchestration rules contain current CLI commands (no `genie agent spawn`, `genie team ensure`, etc.)
- [ ] Orchestration rules document the task leader workflow (`genie team create --wish`)
- [ ] Orchestration rules document the skill chain (brainstorm → review → wish → work → review/fix → PR → QA)
- [ ] Orchestration rules document `autoMergeDev` config
- [ ] `smart-install.js` and `install.sh` orchestration content matches
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Leader Auto-Kickoff

**Goal:** Leader starts working automatically after spawn.

**Deliverables:**
1. In `src/term-commands/team.ts`, `spawnLeaderWithWish()` function:
   - Pass the kick-off prompt as part of the spawn command itself — Claude Code accepts a `[prompt]` positional argument that becomes the first user message
   - In `handleWorkerSpawn` or the spawn params, add an `initialPrompt` field: `"Begin. Read the wish at .genie/wishes/<slug>/WISH.md and execute the full lifecycle autonomously. Your team is <team-name>."`
   - The initial prompt is appended to the claude command as the positional `[prompt]` arg (after all flags)
   - This starts the session WITH the first user message — no delay, no race, no separate send
2. In `src/lib/provider-adapters.ts`, `buildClaudeCommand()`:
   - Add optional `initialPrompt?: string` to `SpawnParams`
   - If set, append `escapeShellArg(initialPrompt)` as the last element of the command (positional arg)
3. In `src/term-commands/agents.ts`, pass `initialPrompt` through `SpawnOptions` → `SpawnParams`

**Acceptance criteria:**
- `genie team create --wish <slug>` → leader spawns AND begins reading wish immediately (no idle state)
- No manual message needed
- No sleep/delay/retry — prompt is part of the launch command
- Non-wish spawns (regular `genie spawn`) unaffected (no initialPrompt)

**Validation:**
```bash
bun run typecheck
# Manual: genie team create --wish <slug> → watch leader pane start working
```

**depends-on:** none

---

### Group 2: Orchestration Rules Audit + Fix

**Goal:** Ensure `genie-orchestration.md` content is complete and current.

**Deliverables:**
1. Read the current `ORCHESTRATION_PROMPT` in `plugins/genie/scripts/smart-install.js` (line 243)
2. Audit against the current state of genie:
   - CLI commands: spawn, kill, stop, ls, history, read, answer, team (create/hire/fire/disband/ls/done/blocked), dir, send, broadcast, chat, done, status, reset, update (--next/--stable)
   - Skill chain: brainstorm → review → wish → review → work (with genie work dispatch) → review/fix → PR → QA
   - Task leader workflow: `genie team create --wish <slug>` for autonomous execution
   - Team lifecycle: create → hire → execute → PR → merge (if autoMergeDev) → QA → done → disband
   - Rules: no native Agent/SendMessage/TeamCreate tools, role separation, critical PR review, CI green before merge
   - Config: `autoMergeDev` option
3. Fix any stale, missing, or incorrect content
4. Update matching content in `install.sh`
5. Verify both files have identical orchestration prompt content

**Acceptance criteria:**
- No stale commands in orchestration rules
- Task leader workflow documented
- `autoMergeDev` mentioned
- Skill chain documented
- `smart-install.js` and `install.sh` match

**Validation:**
```bash
grep -c 'genie agent spawn\|genie team ensure\|genie agent dashboard' plugins/genie/scripts/smart-install.js && echo "FAIL" || echo "PASS"
grep -c 'task leader\|--wish' plugins/genie/scripts/smart-install.js | xargs test 0 -lt && echo "PASS: leader documented" || echo "FAIL"
grep -c 'autoMergeDev' plugins/genie/scripts/smart-install.js | xargs test 0 -lt && echo "PASS: config documented" || echo "FAIL"
```

**depends-on:** none

---

### Group 3: Validation

**Goal:** Quality gates pass, leader auto-kickoff works E2E.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2

---

## Dependency Graph

```
Group 1 (Auto-Kickoff)    Group 2 (Orchestration Rules Audit)
         │                              │
         └──────────────────────────────┘
                      │
             Group 3 (Validation)
```

Groups 1 and 2 can start in parallel.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Leader not ready when kick-off message sent | Low | 2-3 second delay + graceful fallback (warning, not crash) |
| Orchestration rules too long for context | Medium | Keep concise — target ~150 lines max |
| `install.sh` and `smart-install.js` drift | Low | Validation step checks they match |
