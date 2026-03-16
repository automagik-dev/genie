# Wish: Task Leader Architecture

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `task-leader-architecture` |
| **Date** | 2026-03-14 |
| **Design** | [DRAFT.md](../../brainstorms/task-leader-architecture/DRAFT.md) |

## Summary

Add a `leader` built-in role that owns a wish lifecycle autonomously. When `genie team create --wish <slug>` is used, a task leader is spawned in the worktree that hires workers, dispatches groups, reviews, creates PRs, runs QA, and sets done status — all without knowing who spawned it. Fixes #566 (bidirectional messaging) by design since all agents in a team are genie-spawned.

## Scope

### IN

- Add `leader` built-in role in `src/lib/builtin-agents.ts` with orchestration system prompt
- Add `--wish <slug>` option to `genie team create` that auto-spawns a task leader
- Task leader runs `/work` autonomously on the wish (hire → implement → review → PR → QA → done)
- Team status tracking: `genie team ls` shows team completion status
- Wish state integration: task leader uses `genie done`/`genie status`/`genie reset` for group tracking
- Task leader sets a visible done state when lifecycle is complete (PR open, CI green, QA passed)
- `autoMergeDev` config option in `~/.genie/config.json` — leader respects user preference on auto-merge

### OUT

- PM-to-leader messaging protocol (PM watches, doesn't need to be addressable)
- Changes to how solo users run `genie` (no PM required)
- Changes to the wish state machine itself
- Multi-repo task leaders
- Changes to `/dream` (future — will spawn task leaders instead of implementors, but separate wish)

## Decisions

| Decision | Rationale |
|----------|-----------|
| `leader` is a built-in role | Like implementor/tester/reviewer — ships with genie, no registration needed |
| Leader doesn't know who spawned it | No coupling to PM. Works for any user. Solo dev or PM hierarchy. |
| `--wish` on team create auto-spawns leader | One command to go from wish → autonomous execution. Lowest friction. |
| Without `--wish`, team create behaves as today | No breaking change. Manual hire/spawn still works. |
| All team agents genie-spawned | Fixes #566 — `genie send` works bidirectionally within team. |
| Leader sets done via team config status | PM polls `genie team ls` to see which teams are done. |
| Auto-merge is configurable | `autoMergeDev` in `~/.genie/config.json` (default: false). Leader checks config — merges if true, leaves PR open if false. Each user decides their own policy. |

## Success Criteria

- [ ] `leader` exists in built-in agents with orchestration-focused system prompt
- [ ] `genie team create fix/x --repo /path --wish my-slug` creates worktree + spawns leader
- [ ] Leader reads `.genie/wishes/<slug>/WISH.md` and begins `/work` autonomously
- [ ] Leader hires implementor/reviewer/tester as needed
- [ ] Leader dispatches groups respecting dependency order via `genie work`
- [ ] Leader runs local `/review` per group, `/fix` on failures
- [ ] Leader creates PR to dev after all groups pass
- [ ] Leader waits for CI, reads PR comments critically, fixes valid issues
- [ ] Leader merges PR to dev when green (if `autoMergeDev` config is true) or leaves PR open (if false)
- [ ] Leader spawns tester for QA loop on dev
- [ ] Leader sets team status to `done` when lifecycle complete
- [ ] `genie team ls` shows team status (in_progress / done / blocked)
- [ ] Workers can `genie send --to <leader-name>` (bidirectional messaging works)
- [ ] `genie team create fix/x --repo /path` without `--wish` works as before (no leader spawned)
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Leader Built-in Role

**Goal:** Add `leader` to built-in agents with an orchestration system prompt.

**Deliverables:**
1. Add `leader` entry in `src/lib/builtin-agents.ts`
   - Name: `leader`
   - Category: `role`
   - System prompt: Orchestration-focused — reads wish, hires team, dispatches groups via `genie work`, runs `/review`+`/fix` per group, creates PR, manages CI/comments, merges to dev, runs QA loop, sets done
   - Model: default (inherits from spawn)
   - promptMode: `append`
2. Add test in `src/lib/builtin-agents.test.ts`

**Acceptance criteria:**
- `genie dir ls --builtins` shows `leader` role
- `genie spawn leader --team <name>` works

**Validation:**
```bash
bun run typecheck
bun test src/lib/builtin-agents.test.ts
```

**depends-on:** none

---

### Group 2: Team Create --wish Flag

**Goal:** `genie team create --wish <slug>` auto-spawns a task leader in the worktree.

**Deliverables:**
1. Add `--wish <slug>` option to `team create` command in `src/term-commands/team.ts`
2. When `--wish` provided:
   - Create worktree as normal
   - Copy wish file into worktree: `.genie/` is typically gitignored, so a fresh worktree won't have it. The command MUST copy `.genie/wishes/<slug>/WISH.md` from the source repo (resolved via `process.cwd()` or the `--repo` path) into the worktree's `.genie/wishes/<slug>/WISH.md`. Create parent dirs with `mkdir -p`.
   - Auto-hire `leader` to the team
   - Build context file: read the copied WISH.md from the worktree path, use `writeContextFile()` (same pattern as `workDispatchCommand` in `dispatch.ts`) to create a temp file with the complete wish content + file path
   - Auto-spawn `leader` with `--append-system-prompt-file <context-file>` so leader has the wish injected
   - Leader starts working autonomously
3. Without `--wish`, behavior unchanged

**Acceptance criteria:**
- `genie team create fix/x --repo /path --wish my-slug` creates worktree + spawns leader
- `genie team create fix/x --repo /path` without `--wish` creates worktree only (no leader)
- Leader spawns in the worktree CWD
- Leader has wish context injected

**Validation:**
```bash
bun run typecheck
bun test src/term-commands/team.test.ts
```

**depends-on:** Group 1

---

### Group 3: Team Status Tracking

**Goal:** Teams have a visible status (in_progress / done / blocked) that anyone can check.

**Deliverables:**
1. Add `status` field to `TeamConfig` in `src/lib/team-manager.ts`
   - Values: `in_progress` | `done` | `blocked`
   - Default: `in_progress` on team create
2. Add `setTeamStatus(teamName, status)` function in team-manager
3. Update `genie team ls` display to show status column
4. Add `genie team done <name>` CLI command — calls `setTeamStatus(name, 'done')`. This is how the leader marks completion from bash.
5. Add `genie team blocked <name>` CLI command — calls `setTeamStatus(name, 'blocked')`
6. Add `genie team status <name>` command for detailed view (wish progress + team status)

**Acceptance criteria:**
- `genie team ls` shows status column
- Team starts as `in_progress`
- Leader can set team to `done`
- `genie team ls` shows `done` after leader completes

**Validation:**
```bash
bun run typecheck
bun test src/lib/team-manager.test.ts
```

**depends-on:** none

---

### Group 4: Leader Orchestration Prompt

**Goal:** The leader's system prompt contains the full lifecycle instructions so it can run autonomously.

**Deliverables:**
1. Write the leader system prompt covering:
   - Read wish from `.genie/wishes/<slug>/WISH.md`
   - Parse execution groups and dependency graph
   - Hire needed roles: `genie team hire implementor`, `genie team hire reviewer`, `genie team hire tester`
   - Execute groups in dependency order: `genie work implementor <slug>#<group>` for each
   - Monitor workers via `genie read`, track via `genie status`
   - Mark groups done via `genie done <slug>#<group>`
   - After all groups: run general `/review` across all changes
   - Create PR to dev: `gh pr create --base dev`
   - Wait for CI, read PR comments, critically judge each
   - `/fix` valid issues, push, wait for CI green
   - Check `autoMergeDev` in genie config — if true, merge to dev (`gh pr merge --merge`). If false, leave PR open and set team status to `done` (PR ready for human).
   - Spawn tester for QA: `genie team hire tester`, `genie spawn tester`
   - QA loop: tester validates wish criteria → `/fix` failures → re-test until green
   - Each fix round: new commits, push, CI green
   - When everything passes: `setTeamStatus('done')`, disband workers
2. The prompt must be concise enough to fit in context but complete enough to run unsupervised

**Acceptance criteria:**
- Leader reads wish and begins working without human input
- Leader hires appropriate roles
- Leader respects group dependencies
- Leader creates PR, handles CI, manages QA loop
- Leader sets done status when complete

**Validation:**
```bash
# Verify leader prompt contains essential commands
bun run typecheck
bun test src/lib/builtin-agents.test.ts
# Test that leader system prompt includes key orchestration commands:
bun -e "const {getBuiltin} = require('./src/lib/builtin-agents.ts'); const l = getBuiltin('leader'); const p = l.systemPrompt; const required = ['genie work','genie done','genie team hire','gh pr create','genie send','genie status','genie team done']; const missing = required.filter(r => !p.includes(r)); if (missing.length) { console.error('FAIL: missing', missing); process.exit(1); } else console.log('PASS: all commands present');"
```

**depends-on:** Group 1, Group 2, Group 3

---

### Group 5: Validation

**Goal:** Full quality gates pass, leader lifecycle works end-to-end.

**Deliverables:**
1. `bun run check` passes
2. `bun run build` succeeds
3. Integration test: create team with `--wish`, verify leader spawns and begins work
4. Verify bidirectional messaging: worker sends to leader, leader sends to worker

**Acceptance criteria:**
- `bun run check` exits 0
- `bun run build` succeeds
- Leader spawns autonomously with wish context
- Workers can message leader and vice versa

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## Dependency Graph

```
Group 1 (Leader Role)    Group 3 (Team Status)
       │                        │
       ├──→ Group 2 (--wish)    │
       │         │              │
       └─────────┴──────────────┘
                 │
        Group 4 (Leader Prompt)
                 │
        Group 5 (Validation)
```

Groups 1 and 3 can start in parallel.
Group 2 starts once Group 1 is done.
Group 4 starts once Groups 1, 2, 3 are done.
Group 5 starts once all others are done.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Leader prompt too long for context | Medium | Keep concise, reference skills by name not inline. Leader knows `/work`, `/review`, `/fix` — doesn't need their full content. |
| Leader gets stuck in infinite fix loop | Low | `/fix` already has max 2 loop guard. Leader escalates to blocked. |
| Leader creates bad PRs | Low | PR has CI gate + bot reviews. Leader reads comments critically. |
| Team status not updated on crash | Medium | PM monitoring loop detects stale `in_progress` teams and can `genie reset` or disband. |
| Multiple leaders in same team | Low | `genie team hire leader` rejects duplicate roles (existing guard). |
