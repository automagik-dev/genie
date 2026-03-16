# Wish: Spawn Into Current Session

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `spawn-into-session` |
| **Date** | 2026-03-16 |

## Summary

`genie spawn engineer` without `--team` should spawn the agent as a native teammate in the current session. No cd, no team creation, no worktree. Just "give me a buddy in my window." Two modes: `genie spawn <role>` (collaborative, same session) vs `genie team create --wish <slug>` (autonomous, separate tab).

## Scope

### IN

- `genie spawn <role>` without `--team` detects current native team from `GENIE_TEAM` env var and spawns into it
- Agent appears as a pane in the current tmux window
- Agent joins as a native Claude Code teammate (SendMessage works bidirectionally)
- No cd into repo needed — uses the team's repo context
- Update orchestration rules: SendMessage is correct for same-session teammates, genie send for cross-session
- Register the interactive session (user typing `genie`) in genie's agent registry so spawned agents can find it

### OUT

- Changes to `genie team create --wish` flow (already works separately)
- Changes to how agents are hired into teams
- New commands

## Decisions

| Decision | Rationale |
|----------|-----------|
| No `--team` = spawn into current session | Most natural: "give me a buddy" without ceremony |
| `--team` = spawn into specific team (existing behavior) | For cross-team spawning or explicit targeting |
| Native SendMessage for same-session | Claude Code handles it natively, works bidirectionally, no genie send needed |
| Register interactive session in agent registry | So spawned agents can resolve the team-lead for inbox/messaging |

## Success Criteria

- [ ] `genie spawn engineer` (no --team) from a genie session spawns engineer in same window
- [ ] Spawned engineer can SendMessage to the session leader
- [ ] Session leader can SendMessage to the spawned engineer
- [ ] No cd into repo required — agent gets the right CWD from team context
- [ ] `genie spawn engineer --team other-team` still works (spawns into other team's window)
- [ ] Interactive session is registered in `~/.genie/workers.json`
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Auto-Detect Team + Spawn Into Session

**Goal:** `genie spawn <role>` without `--team` spawns into the current session.

**Deliverables:**
1. In `src/term-commands/agents.ts`, `handleWorkerSpawn()`:
   - When `options.team` is not provided, detect current team from `GENIE_TEAM` env var (already partially done at line 738)
   - Resolve CWD from the team config's repo/worktree path (so no cd needed)
   - Spawn the agent into the current session's tmux window (not a new window)
2. Register the interactive session in the agent registry:
   - In `src/genie-commands/session.ts`, after launching Claude Code, register the session in `~/.genie/workers.json` with: agent name (folder name), pane ID, team name, state
   - This allows spawned agents to resolve the leader for messaging
3. Update orchestration rules (`plugins/genie/rules/genie-orchestration.md`):
   - SendMessage is the correct tool for same-session teammates
   - genie send is for cross-session communication
   - Remove the blanket "NEVER use SendMessage" ban — replace with "use SendMessage for teammates in your session, genie send for agents in other sessions"

**Acceptance criteria:**
- `genie spawn engineer` in a genie session spawns in same window with native team comms
- No `--team` flag needed
- Bidirectional SendMessage works
- `genie spawn engineer --team other` still spawns into other team

**Validation:**
```bash
bun run typecheck
bun test src/term-commands/agents.test.ts
```

**depends-on:** none

---

### Group 2: Validation

**Goal:** Quality gates pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1

---

## Dependency Graph

```
Group 1 (Auto-Detect + Spawn)
         │
Group 2 (Validation)
```

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| GENIE_TEAM not set in some sessions | Low | Fallback to requiring --team (current behavior) |
| Registering interactive session conflicts with spawned agents | Medium | Use folder name as agent name — different from worker names |
| SendMessage un-ban confuses agents | Low | Clear rule: same session = SendMessage, different session = genie send |
