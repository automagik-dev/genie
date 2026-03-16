# Wish: Genie v2 QA Fixes

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `v2-qa-fixes` |
| **Date** | 2026-03-14 |
| **Design** | [DESIGN.md](../../brainstorms/v2-qa-fixes/DESIGN.md) |
| **Parent** | `genie-v2-framework-redesign` |

## Summary

Fix 10 issues (#546-#555) found during comprehensive QA of the v2 redesign. All fixes are scoped to match the original v2 spec — no plan changes, no architecture changes, no new features beyond `genie reset` (leader recovery from stuck groups). The v2 plan stays exactly as designed.

## Scope

### IN

- Extract shared file-lock utility from 3 duplicated implementations (#550)
- Fix spawn CWD to use team worktree for built-in agents (#546)
- Add file lock to mailbox send/markDelivered (#547)
- Add file lock to team-chat postMessage (#555)
- Add cycle detection + dangling dep validation in createState (#548)
- Enforce `in_progress` before `done` in completeGroup (#549)
- Add `resetGroup()` + `genie reset slug#group` CLI command (#552)
- Validate team name against git branch naming rules (#551)
- Make parseWishGroups regex case-insensitive (#554)
- Document getState() lockless read as intentional (#553)
- **Move team configs to global `~/.genie/teams/` — eliminate CWD dependency for all team commands**
- **Fix `genie update` — read version from package.json at runtime instead of hardcoded in dist**

### OUT

- New wish state (`failed`) — replaced by `genie reset`
- Lock on getState() reads — documented as eventually consistent
- Project registry / project-scoped team listing (future wish)
- Changes to the v2 plan or architecture
- New dependencies or packages

## Decisions

| Decision | Rationale |
|----------|-----------|
| Extract file-lock first | Enables mailbox + team-chat fixes cleanly. DRY. Same constants everywhere. |
| `resetGroup()` not `failGroup()` | Leader recovery: detect stuck → kill worker → reset → redeploy. No new state needed, just a reset valve. |
| Enforce strict state transitions | Spec says `in_progress → done`. Prevents orphaned groups with no assignee or startedAt. |
| Case-insensitive parsing | Robustness. All existing WISH.md files use correct case. Zero risk. |
| Document lockless reads | Low impact. Locking reads would slow `genie status` for no real benefit. |
| Validate branch names proactively | Opaque git errors are unacceptable. Fail fast with clear message. |

## Success Criteria

- [ ] `src/lib/file-lock.ts` exists with `acquireLock()` and `withLock()`, used by 5 modules
- [ ] 10 concurrent `mailbox.send()` retains all 10 messages
- [ ] 20 concurrent `postMessage()` retains all 20 messages
- [ ] `createState()` throws on circular deps (A→B→A)
- [ ] `createState()` throws on self-referential deps (A→A)
- [ ] `createState()` throws on dangling dep references
- [ ] `completeGroup()` throws if group is not `in_progress`
- [ ] `resetGroup()` moves `in_progress` back to `ready`, clears assignee/startedAt
- [ ] `genie reset slug#group` works from CLI
- [ ] Built-in agent spawn in team uses worktree CWD (not process.cwd())
- [ ] `genie team create "spaces here"` fails with clear validation error
- [ ] `parseWishGroups()` handles `### group N:` (lowercase)
- [ ] `genie team create X --repo /path` then `genie team hire Y --team X` works from ANY CWD
- [ ] `genie team ls` from any CWD shows all teams across all repos
- [ ] Team configs stored at `~/.genie/teams/`, not per-repo
- [ ] `genie --version` matches `package.json` version after `genie update`
- [ ] `bun run check` exits 0
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Shared File Lock Extraction

**Goal:** Single source of truth for the file-lock pattern used across 5 modules.

**Deliverables:**
1. Create `src/lib/file-lock.ts`
   - Extract `acquireLock()`, `tryCreateLock()`, `tryCleanStaleLock()` from `agent-directory.ts`
   - Export `acquireLock(filePath: string): Promise<() => Promise<void>>`
   - Export `withLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T>`
   - Constants: `LOCK_TIMEOUT_MS=5000`, `LOCK_RETRY_MS=50`, `LOCK_STALE_MS=10000`
2. Update `src/lib/agent-directory.ts` — remove inline lock code, import from `file-lock.ts`
3. Update `src/lib/wish-state.ts` — remove inline lock code, import from `file-lock.ts`
4. Update `src/lib/agent-registry.ts` — remove inline lock code, import from `file-lock.ts`
   - **NOTE:** agent-registry's `acquireLock(registryPath?)` at line 202 takes an optional param with a module-level default `lockPath`. Normalize to the shared `acquireLock(filePath)` API — the caller must pass the lock path explicitly.

**Acceptance criteria:**
- `src/lib/file-lock.ts` exists with both exports
- All 3 updated modules import from `file-lock.ts`
- No duplicate lock code remains in the 3 source modules
- All existing tests pass unchanged (behavior identical)

**Validation:**
```bash
bun run typecheck
bun test src/lib/agent-directory.test.ts src/lib/wish-state.test.ts src/lib/agent-registry.test.ts
grep -rn 'LOCK_TIMEOUT_MS\|LOCK_RETRY_MS\|LOCK_STALE_MS' src/lib/ --include='*.ts' | grep -v file-lock | grep -v test && echo "FAIL: lock constants still duplicated" || echo "PASS"
```

**depends-on:** none

---

### Group 2: Concurrency Fixes

**Goal:** Eliminate message loss under concurrent writes in mailbox and team-chat.

**Deliverables:**
1. Update `src/lib/mailbox.ts`
   - Import `acquireLock` from `file-lock.ts`
   - Wrap `send()` in lock: acquire lock on mailbox file path before loadMailbox/saveMailbox
   - Wrap `markDelivered()` in lock: same pattern
   - Lock path: `${mailboxFilePath(repoPath, workerId)}.lock`
2. Update `src/lib/team-chat.ts`
   - Import `acquireLock` from `file-lock.ts`
   - Wrap `postMessage()` in lock: acquire before appendFile
   - Lock path: `${chatFilePath(repoPath, teamName)}.lock`
   - **NOTE:** `appendFile()` with small payloads (<4KB) may be atomic on Linux via `O_APPEND`. A single JSONL message is well under 4KB. If Bun's `appendFile` is confirmed atomic, document this instead of locking. Test first — lock only if needed.
3. Update concurrency tests
   - Fix test C-MB-01: 10 concurrent `send()` should now retain all 10 messages
   - Add test for team-chat: 20 concurrent `postMessage()` retains all 20

**Acceptance criteria:**
- 10 concurrent `mailbox.send()` retains all 10 messages (was losing 9/10)
- 20 concurrent `postMessage()` retains all 20 messages
- Existing messaging tests still pass

**Validation:**
```bash
bun run typecheck
bun test src/lib/team-chat.test.ts src/lib/__tests__/mailbox-concurrency.test.ts src/lib/__tests__/file-lock-concurrency.test.ts
```

**depends-on:** Group 1

---

### Group 3: Wish State Hardening

**Goal:** Make the wish state machine robust: catch invalid graphs, enforce transitions, provide leader recovery.

**Deliverables:**
1. Add cycle detection in `createState()` (`src/lib/wish-state.ts`)
   - Implement topological sort (Kahn's algorithm) on the dependency graph
   - Throw with clear error listing cycle participants: `"Dependency cycle detected: 1 → 2 → 1"`
   - Also detect self-referential deps: `"Group 1 depends on itself"`
2. Add dangling dep validation in `createState()`
   - Verify all `dependsOn` references point to groups in the `groups` array
   - Throw: `"Group 3 depends on non-existent group 99"`
3. Enforce strict transition in `completeGroup()`
   - Change line 268 condition from `if (status === 'blocked')` to `if (status !== 'in_progress')`
   - Error: `"Cannot complete group X: must be in_progress (currently ready)"`
4. Add `resetGroup()` function
   - Signature: `resetGroup(slug: string, groupName: string, cwd?: string): Promise<GroupState>`
   - Only allowed on `in_progress` groups
   - Sets status to `ready`, clears `assignee` and `startedAt`
   - Uses `withStateLock` for safety
5. Add `genie reset <slug>#<group>` CLI command in `src/term-commands/state.ts`
   - Parse ref using existing `parseRef()`
   - Call `resetGroup()`
   - Print confirmation: `"Group X reset to ready"`
6. Add JSDoc comment to `getState()` documenting lockless read (#553)
7. Update tests:
   - Update any tests that call `completeGroup()` on non-`in_progress` groups
   - Add tests for cycle detection, dangling deps, resetGroup, strict transitions

**Acceptance criteria:**
- `createState([{name:'1', dependsOn:['1']}])` throws "depends on itself"
- `createState([{name:'1', dependsOn:['2']}, {name:'2', dependsOn:['1']}])` throws "cycle detected"
- `createState([{name:'1', dependsOn:['99']}])` throws "non-existent group"
- `completeGroup()` on `ready` group throws "must be in_progress"
- `resetGroup()` on `in_progress` group returns `{status:'ready', assignee:undefined, startedAt:undefined}`
- `resetGroup()` on `ready` group throws "must be in_progress"
- `genie reset slug#1` works from CLI
- `getState()` has JSDoc noting lockless-by-design

**Validation:**
```bash
bun run typecheck
bun test src/lib/wish-state.test.ts src/term-commands/state.test.ts
```

**depends-on:** Group 1

---

### Group 4: Spawn & Team Fixes

**Goal:** Fix CWD resolution for team spawns, validate team names, make parsing robust.

**Deliverables:**
1. Fix CWD resolution in `src/term-commands/agents.ts`
   - **IMPORTANT:** `resolveAgentForSpawn()` runs BEFORE the team is known (line 735 vs 738). The fix MUST go in `handleWorkerSpawn()` AFTER team resolution.
   - Between lines 743 and 745 (after `rejectDuplicateRole`, before `buildSpawnParams`), add team worktree override:
     ```typescript
     const teamConfig = await teamManager.getTeam(agent.repoPath, team);
     if (teamConfig?.worktreePath) {
       agent = { ...agent, repoPath: teamConfig.worktreePath };
     }
     ```
   - `teamManager` is already imported at line 24. `getTeam` is already exported.
   - This makes `agent.repoPath` flow correctly into `ctx.cwd` at line 781.
2. Add `validateBranchName()` in `src/lib/team-manager.ts`
   - Reject names containing: spaces, `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, control chars
   - Reject names ending in `.lock`, `/`, or `.`
   - Reject names starting with `-`
   - Call from `createTeam()` before any git operations
   - Error: `"Invalid team name 'X': must be a valid git branch name (contains spaces)"`
3. Make `parseWishGroups()` case-insensitive in `src/term-commands/dispatch.ts`
   - Change regex from `/^### Group (\d+):/gm` to `/^### Group (\d+):/gmi`
   - (This only makes "Group" case-insensitive; the `###` heading level stays strict which is correct)
4. Update tests:
   - Add test: spawn built-in into team → CWD is worktree path
   - Add test: `createTeam("spaces here")` throws validation error
   - Test U-DC-08 now passes (lowercase heading parsed)

**Acceptance criteria:**
- `genie spawn tester --team feat/x` uses team's worktreePath as CWD
- `genie team create "my feature"` fails with "must be a valid git branch name"
- `genie team create "feat..test"` fails with same
- `parseWishGroups("### group 1: Test\n**depends-on:** none")` returns 1 group
- All existing team and spawn tests pass

**Validation:**
```bash
bun run typecheck
bun test src/term-commands/agents.test.ts src/lib/team-manager.test.ts src/term-commands/dispatch.test.ts
```

**depends-on:** none

---

### Group 5: Global Team Configs

**Goal:** Eliminate CWD dependency for all team commands. Teams discoverable from anywhere.

**Deliverables:**
1. Move team config storage in `src/lib/team-manager.ts`
   - Change `teamsDir()` from `join(repoPath, '.genie', 'teams')` to `join(getGenieDir(), 'teams')`
   - `getGenieDir()` returns `process.env.GENIE_HOME || join(homedir(), '.genie')`
   - `teamFilePath()` no longer needs `repoPath` param for path resolution
2. Update all team-manager functions:
   - `createTeam()` — write config to `~/.genie/teams/<safeName>.json` (already stores `repo` in config)
   - `getTeam()` — change signature: `getTeam(name)` instead of `getTeam(repoPath, name)`. Read `repo` from the config itself.
   - `listTeams()` — change signature: `listTeams()` no args. Lists ALL teams globally.
   - `listMembers()` — change signature: `listMembers(teamName)` — get repo from config
   - `hireAgent()` — resolve `repoPath` from config: `const config = await getTeam(teamName); const repoPath = config.repo;`
   - `fireAgent()` — same pattern
   - `disbandTeam()` — same pattern
3. Update `src/term-commands/team.ts`
   - Remove `const repoPath = process.cwd()` from lines 48, 80, 109, 128
   - All team commands resolve repo from the team config, not CWD
   - `team create` still takes `--repo` (required, sets the repo in config)
   - `team hire/fire/ls/disband` no longer need repo — they get it from the config
4. Update all callers of `getTeam()`, `listTeams()` across codebase
   - `src/term-commands/agents.ts` line 620: `teamManager.getTeam(repoPath, team)` → `teamManager.getTeam(team)`
   - Search for all other callsites and update signatures
5. Update tests in `src/lib/team-manager.test.ts` and `src/term-commands/team.test.ts`

**Acceptance criteria:**
- `genie team create X --repo /path/a` then `genie team hire Y --team X` from `/path/b` works
- `genie team ls` from any CWD shows all teams
- Team configs exist at `~/.genie/teams/`, not in repo `.genie/teams/`
- `genie team disband X` from any CWD works
- All existing team tests pass (updated for new signatures)

**Validation:**
```bash
bun run typecheck
bun test src/lib/team-manager.test.ts src/term-commands/team.test.ts
grep -rn 'process\.cwd()' src/term-commands/team.ts && echo "FAIL: CWD dependency remains" || echo "PASS"
```

**depends-on:** none

---

### Group 6: Fix genie update

**Goal:** `genie update` actually updates the running binary version.

**Deliverables:**
1. Change version resolution in `src/lib/version.ts`
   - Instead of hardcoded `export const VERSION = '3.260310.5'`
   - Read from `package.json` at runtime: resolve `package.json` relative to `import.meta.dir` or `__dirname`
   - Fallback to hardcoded value if package.json not found (compiled dist edge case)
2. Update build script if needed
   - Ensure `package.json` is included in dist or accessible at runtime
   - OR use `bun build --define` to inject version from package.json at build time (preferred — zero runtime cost)

**Acceptance criteria:**
- `genie --version` matches `package.json` version
- After `genie update`, `genie --version` shows the new version
- `bun run build` still produces a working binary

**Validation:**
```bash
bun run build
node -e "const pkg = require('./package.json'); console.log(pkg.version)" | xargs -I{} sh -c 'dist/genie.js --version | grep -q "{}" && echo "PASS: version matches" || echo "FAIL: version mismatch"'
```

**depends-on:** none

---

### Group 7: Validation

**Goal:** Full quality gates pass with all fixes integrated.

**Deliverables:**
1. Run `bun run check` (typecheck + lint + dead-code + test)
2. Run `bun run build`
3. Verify each issue's fix with its specific test
4. Close GitHub issues #546-#555 with fix references

**Acceptance criteria:**
- `bun run check` exits 0
- `bun run build` succeeds
- All 13 success criteria above are met
- No regressions in existing test suite

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 2, Group 3, Group 4, Group 5, Group 6

---

## Dependency Graph

```
Group 1 (File Lock)    Group 4 (Spawn/Team/Parse)    Group 5 (Global Teams)    Group 6 (Update)
    │                       │                              │                        │
    ├──→ Group 2 (Concurrency)                             │                        │
    │                       │                              │                        │
    ├──→ Group 3 (Wish State)                              │                        │
    │                       │                              │                        │
    └───────────────────────┴──────────────────────────────┴────────────────────────┘
                                              │
                                     Group 7 (Validation)
```

Parallelizable: Groups 1, 4, 5, and 6 can ALL start simultaneously (no dependencies between them).
Groups 2 + 3 start once Group 1 is done.
Group 7 starts once ALL other groups are done.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Enforcing strict transitions breaks existing tests | Low | Update tests to call `startGroup` before `completeGroup`. QA tests already follow this pattern. |
| File lock extraction changes import paths | Low | Typecheck catches all consumers immediately |
| Branch name validation too strict for some users | Low | Match `git check-ref-format` rules exactly — same standard git uses |
| `resetGroup()` abused to reset done groups | None | Only works on `in_progress` — done groups cannot be reset |
| Cycle detection false positives | None | Kahn's algorithm is deterministic on DAGs |
