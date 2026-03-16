# Wish: Genie v2 — Fix Gaps from PR #536 Review

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `genie-v2-fix-gaps` |
| **Date** | 2026-03-14 |
| **Parent** | [genie-v2-framework-redesign](../genie-v2-framework-redesign/WISH.md) |
| **PR** | #536 (`feat/agent-directory` → `dev`) |

## Summary

Fix all gaps found during review of PR #536 and comprehensive parallel audit of all 10 groups. Two P1 state machine bugs, stale command references in skill prompts and docs, a naming deviation, missing runtime behaviors (fire doesn't kill, disband doesn't kill), a missing env var injection, and a missing crypto import.

## Scope

### IN

- P1: State file auto-initialization on first `genie work` dispatch
- P1: `completeGroup()` guard against completing `blocked` groups
- Stale command references in `skills/onboarding/SKILL.md` (7 occurrences)
- Stale command references in `skills/dream/SKILL.md` (3 occurrences)
- Stale command references in `docs/CO-ORCHESTRATION-GUIDE.md` and `README.md`
- Naming: `dispatch-work` → `work` (remove old `genie work` command that conflicts)
- `fireAgent()` doesn't kill running agent processes
- `disbandTeam()` doesn't kill running member processes
- `GENIE_AGENT_NAME` not set in launch env for non-native spawns
- `session-store.ts` missing `crypto` import — `crypto.randomUUID()` will throw

### OUT

- New features beyond what WISH `genie-v2-framework-redesign` defines
- CI/build fixes (CI is already green)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Auto-init state file in `workDispatchCommand` | Parse WISH.md for group definitions, call `createState()` if no state file exists. Eliminates manual init step. |
| Guard `completeGroup` against `blocked` status | A blocked group has unmet dependencies. Marking it done corrupts the dependency graph. |
| Remove old `genie work <target>` command | It was the task-based work command. Tasks are removed. No collision = command can be `genie work <agent> <slug>#<group>` as WISH specifies. |
| Fire/disband must kill running agents | Without this, firing an agent leaves an orphan Claude session running. Use existing `tmux kill-pane` or `registry.killWorker()` patterns. |
| Set GENIE_AGENT_NAME for all spawns | Currently only set when `nativeTeam.enabled`. Identity hooks read this env var. All spawns need it. |
| Fix crypto import in session-store | `crypto.randomUUID()` called without import. Will crash on first `--session` use. |

## Success Criteria

- [ ] `genie work agent slug#1` auto-creates state file if missing, then starts group
- [ ] `genie done slug#1` on a `blocked` group is rejected with clear error
- [ ] `genie work` (not `dispatch-work`) is the registered command name
- [ ] `skills/onboarding/SKILL.md` has zero references to `genie agent list`, `genie agent kill`, `genie team ensure`
- [ ] `skills/dream/SKILL.md` has zero references to `genie team ensure`, `genie team delete`
- [ ] `grep -rn "genie agent list\|genie agent kill\|genie team ensure\|genie team delete" skills/` returns nothing
- [ ] `fireAgent()` kills the agent's tmux pane if running
- [ ] `disbandTeam()` kills all member panes before removing worktree
- [ ] `GENIE_AGENT_NAME` is set in launch env for ALL spawns (not just native team)
- [ ] `session-store.ts` uses `crypto.randomUUID()` with proper import
- [ ] `grep -rn "genie agent list\|genie agent kill\|genie agent spawn\|genie team ensure\|genie team delete" docs/` returns nothing
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: P1 — State Machine Fixes

**Goal:** Fix the two P1 bugs in the wish state machine that break the core execution path.

**Deliverables:**

1. **Auto-init state file in `workDispatchCommand`** (`src/term-commands/dispatch.ts`)
   - Before calling `wishState.startGroup()`, check if state file exists via `wishState.getState(slug)`
   - If null, parse WISH.md content for group definitions:
     - Extract all `### Group <N>: <title>` headings
     - Extract `**depends-on:**` lines to build dependency arrays
     - Call `wishState.createState(slug, groups)` with the parsed definitions
   - Then proceed to `startGroup()` as normal
   - Add a helper function `parseWishGroups(content: string): GroupDefinition[]` for the parsing

2. **Guard `completeGroup` against blocked status** (`src/lib/wish-state.ts`)
   - In `completeGroup()`, after the existing `status === 'done'` check, add:
     ```typescript
     if (group.status === 'blocked') {
       throw new Error(`Cannot complete group "${groupName}": it is blocked (dependencies not met)`);
     }
     ```
   - This ensures only `ready` or `in_progress` groups can transition to `done`

3. **Update tests** (`src/lib/wish-state.test.ts`)
   - Add test: `completeGroup rejects blocked groups`
   - Add test: `auto-init creates state from WISH.md content` (if dispatch tests exist)

**Acceptance criteria:**
- `startGroup` on a fresh wish auto-creates state file from WISH.md
- `completeGroup` on a blocked group throws with clear message
- `completeGroup` on `ready` or `in_progress` groups still works
- All existing wish-state tests still pass

**Validation:**
```bash
bun run typecheck
bun test src/lib/wish-state.test.ts
bun test src/term-commands/dispatch.test.ts
```

**depends-on:** none

---

### Group 2: Naming — `dispatch-work` → `work`

**Goal:** Fix the command naming to match the WISH.md spec.

**Deliverables:**

1. **Remove old `genie work <target>` command** (`src/term-commands/work.ts` / `src/genie.ts`)
   - The old `genie work` handled task-based work (beads). Tasks are removed.
   - `src/genie.ts` line 47 imports `workCmd` from `work.ts`, line 244-245 registers it as `.action()`
   - Remove the import at line 47: `import * as workCmd from './term-commands/work.js'`
   - Remove the command registration at lines 244-245
   - Delete `src/term-commands/work.ts` entirely — it is only imported by `genie.ts` (verified: no other imports exist)
   - Also delete `src/term-commands/work.test.ts` if it exists (test for removed code)

2. **Rename `dispatch-work` → `work`** (`src/term-commands/dispatch.ts`)
   - Change `.command('dispatch-work <agent> <ref>')` to `.command('work <agent> <ref>')`
   - Update description accordingly

3. **Update any references** to `dispatch-work` in tests or other files

**Acceptance criteria:**
- `genie work agent slug#1` works (not `genie dispatch-work`)
- Old task-based `genie work <target>` no longer exists
- No references to `dispatch-work` remain in codebase

**Validation:**
```bash
bun run typecheck
grep -rn "dispatch-work" src/ && echo "FAIL" || echo "PASS"
```

**depends-on:** none

---

### Group 3: Stale Command References in Skills

**Goal:** Fix all remaining stale command references in skill SKILL.md files.

**Deliverables:**

1. **Fix `skills/onboarding/SKILL.md`** — 7 occurrences:
   - Line 233: `genie agent list` → `genie ls`
   - Line 235: `genie agent kill <id>` → `genie kill <name>`
   - Line 236: `genie team ensure <name>` → `genie team create <name>`
   - Line 254: `genie team ensure default` → `genie team create default`
   - Line 441: `genie agent list` → `genie ls` (in table)
   - Line 442: `genie agent kill <id>` → `genie kill <name>` (in table)
   - Line 445: `genie team ensure <name>` → `genie team create <name>` (in table)

2. **Fix `skills/dream/SKILL.md`** — 3 occurrences:
   - Line 64: `genie team ensure dream-<date>` → `genie team create dream-<date>`
   - Line 74: `genie team ensure dream-<date>` → `genie team create dream-<date>`
   - Line 119: `genie team delete dream-<date>` → `genie team disband dream-<date>`

**Acceptance criteria:**
- `grep -rn "genie agent list\|genie agent kill\|genie team ensure\|genie team delete" skills/` returns nothing
- No other stale command patterns in any skill file

**Validation:**
```bash
grep -rn "genie agent list\|genie agent kill\|genie agent spawn\|genie team ensure\|genie team delete\|Task tool\|bd close\|beads" skills/ && echo "FAIL" || echo "PASS"
```

**depends-on:** none

---

### Group 4: Fire/Disband Kill Running Agents

**Goal:** `fireAgent` and `disbandTeam` must kill running agent processes, not just remove from config.

**Deliverables:**

1. **Update `fireAgent()` in `src/lib/team-manager.ts`**
   - After removing from members array, check if the agent has a running tmux pane
   - Use existing patterns from `src/lib/agent-registry.ts` to find the worker by name
   - Kill the pane via `tmux kill-pane` or `registry.killWorker()` (check existing kill patterns in `src/term-commands/agents.ts`)
   - Best-effort: if kill fails, log warning but don't error (agent might already be dead)

2. **Update `disbandTeam()` in `src/lib/team-manager.ts`**
   - Before removing worktree, iterate `config.members` and kill each running agent
   - Use same kill pattern as fireAgent
   - Best-effort: continue even if some kills fail

3. **Verify existing patterns** — look at how `genie kill <name>` works in agents.ts and reuse that logic

**Acceptance criteria:**
- `genie team fire agent-name` removes from team AND kills running pane
- `genie team disband feat/test` kills all member panes THEN removes worktree
- Killing a non-running agent doesn't error (best-effort)

**Validation:**
```bash
bun run typecheck
bun test src/lib/team-manager.test.ts
```

**depends-on:** none

---

### Group 5: Spawn Env & Session Fix

**Goal:** Fix GENIE_AGENT_NAME not being set for non-native spawns, and fix missing crypto import in session store.

**Deliverables:**

1. **Set GENIE_AGENT_NAME for all spawns** (`src/lib/provider-adapters.ts`)
   - Currently `GENIE_AGENT_NAME` is only set inside `appendNativeTeamFlags()` (line ~198), which is conditional on `nativeTeam.enabled`
   - Move the env var setting to `buildClaudeCommand()` itself, before the native team conditional
   - Use the `role` or agent name from SpawnParams
   - The identity-inject hook at `src/hooks/handlers/identity-inject.ts` reads `process.env.GENIE_AGENT_NAME` and will fail silently without it

2. **Fix crypto import in session-store.ts** (`src/lib/session-store.ts`)
   - Line 73: `const uuid = crypto.randomUUID()` — `crypto` is not imported
   - Add `import { randomUUID } from 'node:crypto'` at top of file
   - Replace `crypto.randomUUID()` with `randomUUID()`
   - Or use Bun's global `crypto` if available (check if it works in Bun runtime)

**Acceptance criteria:**
- `GENIE_AGENT_NAME` appears in launch command env for non-native spawns
- `getOrCreateSession('test')` doesn't throw ReferenceError
- Existing native team spawn still works

**Validation:**
```bash
bun run typecheck
bun test src/lib/provider-adapters.test.ts
```

**depends-on:** none

---

### Group 6: Stale References in Docs

**Goal:** Fix stale command references in documentation files.

**Deliverables:**

1. **Fix `docs/CO-ORCHESTRATION-GUIDE.md`**
   - Replace `genie agent list` → `genie ls`
   - Replace `genie agent kill` → `genie kill`
   - Replace `genie agent spawn` → `genie spawn`
   - Remove or update beads/bd references to reflect wish state machine

2. **Fix `README.md`**
   - Line 144: `genie council <topic>` → describe `/council` skill usage
   - Lines 154-162: Replace `genie agent spawn/list/kill` → `genie spawn/ls/kill`

**Acceptance criteria:**
- `grep -rn "genie agent list\|genie agent kill\|genie agent spawn\|genie team ensure\|genie team delete" docs/ README.md` returns nothing

**Validation:**
```bash
grep -rn "genie agent list\|genie agent kill\|genie agent spawn" docs/ README.md && echo "FAIL" || echo "PASS"
```

**depends-on:** none

---

### Group 7: Final Validation

**Goal:** All fixes integrated, full quality gates pass.

**Deliverables:**

1. Run `bun run check` (typecheck + lint + dead-code + tests)
2. Run `bun run build`
3. Verify ALL success criteria from this wish
4. Run all validation grep commands:
   ```bash
   grep -rn "dispatch-work" src/ && echo "FAIL" || echo "PASS"
   grep -rn "genie agent list\|genie agent kill\|genie team ensure\|genie team delete" skills/ && echo "FAIL" || echo "PASS"
   grep -rn "genie agent list\|genie agent kill\|genie agent spawn" docs/ README.md && echo "FAIL" || echo "PASS"
   ```
5. Push to `feat/agent-directory`

**Acceptance criteria:**
- `bun run check` exits 0
- `bun run build` succeeds
- All grep validations pass
- Changes pushed to remote

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2, Group 3, Group 4, Group 5, Group 6

---

## Dependency Graph

```
G1 (State Machine)  G2 (Naming)  G3 (Skills)  G4 (Fire/Kill)  G5 (Spawn/Session)  G6 (Docs)
       │                │             │              │                │                 │
       └────────────────┴─────────────┴──────────────┴────────────────┴─────────────────┘
                                                │
                                        G7 (Validation)
```

Groups 1-6 are fully independent — can execute in parallel.
Group 7 waits for all.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `parseWishGroups` regex may not handle all WISH.md formats | Medium | Test with the actual genie-v2-framework-redesign WISH.md |
| Removing old `genie work` may break existing agents relying on it | Low | Tasks are already removed. Old work command is dead code |
| Kill patterns may differ across providers (Claude vs Codex) | Low | Best-effort kill. Only target tmux panes, which is Claude-only |
| `crypto.randomUUID()` may work as global in Bun runtime | Low | Test in Bun first. If works, no import needed. If not, use `node:crypto` import |
| GENIE_AGENT_NAME change may affect existing native team flows | Low | Native team path still sets it. Just ensuring non-native path also sets it |
