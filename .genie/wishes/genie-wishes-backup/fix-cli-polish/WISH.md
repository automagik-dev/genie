# Wish: CLI polish — parser, wish resolution, update, auto-copy

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `fix-cli-polish` |
| **Date** | 2026-03-24 |
| **Issues** | #750, #752, #753, #754 |

## Summary

Four CLI issues discovered during the genie-day sprint: (1) depends-on parser chokes on parenthetical descriptions like `Group 1 (GlassCard, StatusDot)`, (2) `genie status` only resolves wishes from cwd, not from the repo's `.genie/wishes/`, (3) `genie team create --wish` requires wishes pre-copied to the repo instead of auto-copying from cwd, (4) `genie update` only updates one install method when both npm-global and bun-global coexist.

## Scope

### IN
- Fix depends-on parser to strip parentheticals before splitting on commas (#752)
- Fix `genie status` to search repo `.genie/wishes/` via git-common-dir (#753)
- Fix `genie team create --wish` to auto-copy wish from cwd to repo worktree (#754)
- Fix `genie update` to detect and update all install methods (#750)

### OUT
- No changes to wish format or template
- No changes to PG state schema
- No new CLI flags
- No changes to team-lead prompt

## Decisions

| Decision | Rationale |
|----------|-----------|
| Use depsNormalized for split, not raw depsStr (#752) | Line 166 already strips parentheticals — just use it for the split instead of raw string |
| Resolve wish path via git-common-dir (#753) | Same pattern as #743 fix — normalize to main repo path for wish lookup |
| Copy wish dir on team create, not symlink (#754) | Worktrees need their own copy. Symlinks break if source moves. |
| Detect install methods via `which` (#750) | Check both `npm list -g` and `bun pm ls -g` to find all installed copies |

## Success Criteria

- [ ] `depends-on: Group 1 (description)` parses correctly as dependency on group `1`
- [ ] `genie status <slug>` works from any directory if wish exists in repo
- [ ] `genie team create --wish <slug>` auto-copies wish from cwd `.genie/wishes/` to repo
- [ ] `genie update` updates both npm-global and bun-global when both exist
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (parallel — all different files)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix depends-on parser (#752) |
| 2 | engineer | Fix wish path resolution in status + team create (#753, #754) |
| 3 | engineer | Fix genie update dual-install (#750) |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | reviewer | Review all fixes |

## Execution Groups

### Group 1: Fix depends-on parser (#752)

**Goal:** Parenthetical comments in depends-on lines don't break parsing.

**Deliverables:**
1. In `src/term-commands/dispatch.ts` line 168:
   - Change `dependsOn = depsStr.split(',')` to `dependsOn = depsNormalized.split(',')`
   - The `depsNormalized` variable (line 166) already strips `\s*\([^)]*\)` — just use it for splitting
   - Keep the per-item `.replace(/^group\s*/i, '')` cleanup but remove the now-redundant `.replace(/\s*\(.*\)\s*$/, '')` on line 174
2. Add test in `src/term-commands/dispatch.test.ts`:
   - Test: `depends-on: Group 1 (GlassCard, StatusDot, ProgressBar)` → `["1"]`
   - Test: `depends-on: Group 1, Group 2 (after review)` → `["1", "2"]`
   - Test: `depends-on: none` → `[]`

**Acceptance Criteria:**
- [ ] Parenthetical descriptions with commas don't produce false dependencies
- [ ] Multi-group depends-on with parentheticals parse correctly
- [ ] `none` still produces empty array

**Validation:**
```bash
bun test src/term-commands/dispatch.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 2: Fix wish resolution + auto-copy (#753, #754)

**Goal:** `genie status` and `genie team create --wish` find wishes regardless of cwd.

**Deliverables:**
1. **#753 — status wish resolution** in `src/term-commands/state.ts`:
   - In the wish path resolution (line 81, 242), after checking `cwd/.genie/wishes/`, also check the repo root via `resolveRepoPath()` (from wish-state.ts, which now uses git-common-dir)
   - Search order: `cwd/.genie/wishes/` → `repoRoot/.genie/wishes/`
   - Import `resolveRepoPath` or duplicate the git-common-dir logic

2. **#754 — auto-copy wish on team create** in `src/term-commands/team.ts`:
   - At line 180-184, when `--wish` is provided and wish is NOT in the target repo:
     - Search for wish in `process.cwd()/.genie/wishes/<slug>/`
     - If found: copy entire wish directory to `<repo>/.genie/wishes/<slug>/`
     - Log: `Wish: copied <slug>/WISH.md to repo`
     - If not found in cwd either: fail with current error message
   - This is exactly what we did manually today (copying wishes from worktree to main repo)

3. Tests:
   - Test wish resolution searches repo root as fallback
   - Test team create auto-copies wish from cwd to repo

**Acceptance Criteria:**
- [ ] `genie status <slug>` resolves wish from repo root when not in cwd
- [ ] `genie team create --wish <slug>` copies wish from cwd to repo if not already there
- [ ] Existing behavior preserved when wish is already in the repo

**Validation:**
```bash
bun test src/term-commands/state.test.ts && bun test src/term-commands/team.test.ts && bun run typecheck
```

**depends-on:** none

---

### Group 3: Fix genie update dual-install (#750)

**Goal:** `genie update` updates all installed copies, not just the configured one.

**Deliverables:**
1. In `src/genie-commands/update.ts`:
   - After determining the primary install method, also check for secondary installs:
     - Run `npm list -g @automagik/genie 2>/dev/null` — if found, npm-global exists
     - Run `bun pm ls -g 2>/dev/null | grep @automagik/genie` — if found, bun-global exists
   - If both exist, update both:
     - Primary: update via configured method (existing behavior)
     - Secondary: update via the other method, log `Also updating <method> install...`
   - If only one exists, update just that one (existing behavior)
2. Add test:
   - Mock both npm and bun global detection
   - Verify both update methods are called when both exist

**Acceptance Criteria:**
- [ ] `genie update` updates both npm-global and bun-global when both are installed
- [ ] Single-install scenarios still work (no regression)
- [ ] Secondary update failure doesn't block primary (log warning, continue)

**Validation:**
```bash
bun run typecheck
```

**depends-on:** none

---

### Group 4: Review

**Goal:** Review all three fixes.

**Deliverables:**
1. Verify parser fix handles edge cases (nested parens, no parens, multiple groups)
2. Verify wish resolution doesn't break existing cwd-first behavior
3. Verify auto-copy preserves wish directory structure
4. Verify update doesn't break when only one install method exists

**Acceptance Criteria:**
- [ ] All fixes reviewed
- [ ] `bun run check` passes

**Validation:**
```bash
bun run check
```

**depends-on:** Group 1, Group 2, Group 3

---

## QA Criteria

- [ ] `depends-on: Group 1 (description)` parses as `["1"]`
- [ ] `genie status <slug>` works from PM directory when wish is in repo
- [ ] `genie team create --wish <slug>` auto-copies wish from PM to repo
- [ ] `genie update --next` updates both installs when both exist
- [ ] All tests pass

## Files to Create/Modify

```
src/term-commands/dispatch.ts       — fix depends-on parser (#752)
src/term-commands/dispatch.test.ts  — parser edge case tests
src/term-commands/state.ts          — wish path resolution fallback (#753)
src/term-commands/state.test.ts     — resolution tests
src/term-commands/team.ts           — auto-copy wish on team create (#754)
src/term-commands/team.test.ts      — auto-copy tests
src/genie-commands/update.ts        — dual-install detection + update (#750)
```
