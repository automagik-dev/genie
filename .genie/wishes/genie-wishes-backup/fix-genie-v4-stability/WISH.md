# Fix Genie v4 Stability — Pre-Release Bugs

## Summary
Five surgical bug fixes blocking Genie v4 stable release. All have clear root causes identified via trace. Fixes target first-run experience, agent name resolution, team-lead reliability, agent spawn latency, and tmux session layout.

## Scope

### IN
- #717: Fix first-run experience — auto-scaffold AGENTS.md or create `/onboarding` skill
- #700: Short agent name resolution in `genie read`/`genie answer`
- #708: Team-lead infinite polling loop (remaining issues after PR #711/#715)
- #712: Agent spawn join delay — reduce gap between spawn and ready
- #687: tmux master window reservation at window 0

### OUT
- No new features
- No schema migrations
- No changes to wish/brainstorm/review skills
- No changes to council agents
- #574 (inbox-driven session management) — future feature, not a bug

## GitHub Issues
- https://github.com/automagik-dev/genie/issues/717
- https://github.com/automagik-dev/genie/issues/700
- https://github.com/automagik-dev/genie/issues/708
- https://github.com/automagik-dev/genie/issues/712
- https://github.com/automagik-dev/genie/issues/687

## Success Criteria
- [ ] `genie` in a clean directory (no AGENTS.md) auto-scaffolds or guides user deterministically
- [ ] `genie read <short-name>` resolves agent from `genie ls` output
- [ ] `genie team create` → team-lead dispatches work without entering polling loop
- [ ] Agent spawn → ready time < 15 seconds (currently ~60s)
- [ ] tmux master window is always at index 0

## Execution Strategy

### Wave 1 (parallel — independent fixes)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix first-run experience (#717) |
| 2 | engineer | Fix short agent name resolution (#700) |
| 3 | engineer | Fix tmux master window at index 0 (#687) |

### Wave 2 (parallel — depends on understanding wave 1 patterns)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Fix team-lead polling loop (#708) |
| 5 | engineer | Reduce agent spawn join delay (#712) |

### Wave 3
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all 5 fixes |

## Execution Groups

### Group 1: fix-first-run-experience
**Issue:** #717
**Priority:** HIGH — blocks new user onboarding (workshop feedback)
**Files:**
- `plugins/genie/scripts/first-run-check.cjs` (and source: `plugins/genie/scripts/src/` if TS source exists)
- `plugins/genie/scripts/smart-install.js`
- No new skill needed — auto-scaffold directly in first-run-check

**Task:**
Two sub-problems:

A) `smart-install.js` fails with "Critical installation failed: spawnSync /bin/sh ENOENT" in some environments and continues silently, corrupting session state. Fix: ensure graceful degradation — if install fails, session should still start cleanly with a clear message.

B) `first-run-check.cjs` suggests "Run /onboarding" but `/onboarding` doesn't exist as a skill. Fix either:
- Option 1: Create a minimal `/onboarding` skill that auto-scaffolds AGENTS.md from template
- Option 2: Make `first-run-check.cjs` auto-scaffold a minimal AGENTS.md directly (simpler)

Prefer Option 2 — fewer moving parts. Auto-create a minimal AGENTS.md with project name and basic agent config. Show message: "Created AGENTS.md — you're ready to go!"

**Acceptance Criteria:**
- [ ] Running genie in clean dir creates AGENTS.md automatically
- [ ] `smart-install.js` failure doesn't corrupt session state
- [ ] Behavior is deterministic — same result every run

**Validation:**
```bash
rm -rf /tmp/genie-firstrun-test && mkdir /tmp/genie-firstrun-test && cd /tmp/genie-firstrun-test && CLAUDE_CWD=/tmp/genie-firstrun-test node scripts/first-run-check.cjs && test -f AGENTS.md && echo "PASS" || echo "FAIL"
```

---

### Group 2: fix-short-name-resolution
**Issue:** #700
**Priority:** MEDIUM — DX annoyance, workaround exists (use full ID)
**Files:**
- `src/lib/target-resolver.ts` (L272-287, `resolveByPartialId` function)
- `src/lib/target-resolver.test.ts` (add test cases)

**Task:**
`genie ls` shows short names like `engineer-4` but `genie read engineer-4` fails. A resolver already exists in `target-resolver.ts` with a full resolution chain: exact ID → role → customName → partialId → role global.

**Root cause:** `resolveByPartialId()` at L272 uses `id.endsWith(target)`. Worker IDs have format `sofia-t1re-engineer-4-ec331228`. When user passes `engineer-4`, `endsWith("engineer-4")` = FALSE because the ID ends with `-ec331228` (a hash suffix).

**Fix:** In `resolveByPartialId()`, change the filter from `id.endsWith(target)` to `id.includes(target)` — or better, add a new resolution step `resolveByDisplayName` that matches against the short display name shown by `genie ls`. Keep `endsWith` as-is (it works for suffix matches) and add `includes` as a fallback before the global role match.

The resolution chain in `resolveBareName()` (L382-386) becomes:
```typescript
resolveByRole(target, workers, currentTeam) ??
resolveByCustomName(target, workers, currentTeam) ??
resolveByPartialId(target, workers, currentTeam) ??    // endsWith (existing)
resolveBySubstring(target, workers, currentTeam) ??    // includes (NEW)
resolveByRoleGlobal(target, workers);
```

**Acceptance Criteria:**
- [ ] `genie read engineer-4` resolves when `engineer-4` appears in worker ID
- [ ] `genie answer engineer-4` resolves the same way
- [ ] Ambiguous substring matches show helpful error with candidates
- [ ] Existing exact/role/customName/endsWith resolution unchanged

**Validation:**
```bash
bun test src/lib/target-resolver.test.ts
```

---

### Group 3: fix-tmux-master-window
**Issue:** #687
**Priority:** LOW — cosmetic but affects session management
**Files:**
- `src/lib/tmux.ts` (or equivalent tmux session management)

**Task:**
When creating a tmux session for an agent, ensure the master window is always at index 0. Currently, if sessions are spawned from outside tmux, the master window gets created at a random index.

Fix: On session creation, check if window 0 exists. If not, create it as master. If window 0 is already a spawned session, swap it with master.

**Acceptance Criteria:**
- [ ] Master window is always at index 0 in new sessions
- [ ] Existing spawned windows are not disrupted

**Validation:**
```bash
bun test -- --grep "tmux\|master.*window" 2>/dev/null || echo "run full suite" && bun test
```

---

### Group 4: fix-team-lead-polling-loop
**Issue:** #708
**Priority:** HIGH — blocks autonomous team execution
**Files:**
- `plugins/genie/agents/team-lead/AGENTS.md` (team-lead behavioral prompt)
- `src/term-commands/orchestrate.ts` (the `genie work` command handler)
- `src/lib/orchestrator/index.ts` (re-exports)
- `src/lib/orchestrator/patterns.ts` (orchestration patterns — wave parsing, dispatch)
- `src/lib/orchestrator/state-detector.ts` (state detection logic)
- `src/lib/wish-state.ts` (state file read/write)
- `plugins/genie/scripts/worker-service.cjs` (worker service runtime)

**Task:**
PR #711 added actionable guidance to `genie status` and PR #715 added dead worker cleanup. The team-lead AGENTS.md now instructs: "Run `genie work <slug>` — this handles everything."

The `genie work` command (in `src/term-commands/orchestrate.ts`) is the auto-orchestrator. Investigate:
1. Does `genie work <slug>` create the state file if missing? Check `wish-state.ts`.
2. Does `orchestrator/patterns.ts` correctly parse waves from WISH.md and dispatch?
3. Does the team-lead actually call `genie work` or does it fall back to manual `genie status` polling?

If `genie work` fails when no state file exists, fix `wish-state.ts` to auto-initialize state from WISH.md groups. The orchestrator should be the entry point that bootstraps everything — never require a pre-existing state file.

**Acceptance Criteria:**
- [ ] `genie team create ... --wish <slug>` → team-lead dispatches work within 30 seconds
- [ ] `genie work <slug>` creates state file from WISH.md if missing
- [ ] No infinite polling loops — orchestrator either dispatches or reports BLOCKED
- [ ] State transitions: ready → in_progress → done (per group)

**Validation:**
```bash
bun test src/lib/wish-state.test.ts && bun test src/lib/orchestrator/
```

---

### Group 5: reduce-agent-spawn-delay
**Issue:** #712
**Priority:** MEDIUM — UX issue, 60s delay feels broken
**Files:**
- `src/lib/spawn-command.ts` (builds claude launch command)
- `src/lib/team-lead-command.ts` (builds team-lead command with env vars)
- `src/lib/team-auto-spawn.ts` (auto-spawn logic)
- `plugins/genie/scripts/smart-install.js` (SessionStart hook — potential bottleneck)
- `plugins/genie/scripts/first-run-check.cjs` (SessionStart hook)
- `plugins/genie/scripts/session-context.cjs` (SessionStart hook)
- `plugins/genie/hooks/hooks.json` (hook configuration)

**Task:**
~60 second gap between `genie spawn` returning and agent actually being ready for messages. Investigate where the delay comes from:
1. Claude Code session startup time?
2. **SessionStart hooks** — `smart-install.js` (timeout: 60s!), `first-run-check.cjs` (timeout: 5s), `session-context.cjs` (timeout: 10s) all run sequentially on EVERY agent spawn
3. Plugin loading?
4. Message delivery timing?

**Likely root cause:** `smart-install.js` has a 60s timeout and runs on every SessionStart. Team workers don't need dependency installation — they work in worktrees where deps are already installed. If Group 1 fixes `smart-install.js` to fast-exit when deps are already present, spawn delay should drop significantly.

**Additional fix:** Consider adding a `GENIE_WORKER=1` env var (set by spawn-command) that makes SessionStart hooks skip non-essential checks. In `hooks.json`, the matcher could check for this env var.

**NOTE:** This may be partially resolved by Group 1's fix to `smart-install.js`. Validate after Group 1 ships — if spawn time drops below 15s, this group may become unnecessary.

**Acceptance Criteria:**
- [ ] Agent spawn → ready for messages in < 15 seconds
- [ ] Messages sent during spawn gap are queued and delivered on ready
- [ ] Worker agents skip non-essential SessionStart hooks

**Validation:**
```bash
bun test src/lib/spawn-command.test.ts && bun test src/lib/team-auto-spawn.test.ts
```

---

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| smart-install.js changes break existing installs | Medium | Test on clean env + existing env |
| tmux window swap disrupts running sessions | Low | Only apply on new session creation |
| Spawn delay is Claude Code startup, not genie | Medium | If CC startup is slow, document and optimize hooks instead |
