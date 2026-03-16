# Brainstorm: Genie v2 QA Fixes — Bug-for-Bug Spec Alignment

**Slug:** `v2-qa-fixes`
**Date:** 2026-03-14
**Origin:** QA exploration of WISH `genie-v2-framework-redesign`

## Problem

QA testing found 10 issues (#546-#555) in the v2 implementation. Each fix must be scoped precisely to avoid changing the v2 plan — only fix what's broken, don't redesign.

## Decisions

| # | Issue | Decision | Risk to Plan |
|---|-------|----------|-------------|
| #546 | Spawn CWD ignores worktree | **Fix** — spec explicitly requires team worktree CWD | NONE |
| #547 | Mailbox loses messages (no lock) | **Fix** — add file lock using shared utility | NONE |
| #548 | No cycle detection in deps | **Fix** — add validation in createState() | LOW |
| #549 | ready->done skips in_progress | **Fix** — enforce strict `in_progress` before `done` | NONE |
| #550 | File lock duplicated 3x | **Fix** — extract shared `file-lock.ts` | LOW |
| #551 | Team name not validated | **Fix** — validate against git branch rules | NONE |
| #552 | No failed state | **Replace with `genie reset`** — moves `in_progress` back to `ready` for reassignment. No new state. Leader recovery: detect stuck → kill worker → reset → redeploy | NONE |
| #553 | getState() no lock (TOCTOU) | **Document** — reads are eventually consistent, low impact | NONE |
| #554 | parseWishGroups case-sensitive | **Fix** — make regex case-insensitive | NONE |
| #555 | team-chat JSONL no lock | **Fix** — add file lock from shared utility | NONE |

## Fix Scope Summary

### Must change (bugs):
1. `src/term-commands/agents.ts` — CWD resolution adds team worktree lookup (#546)
2. `src/lib/file-lock.ts` — NEW: extract shared lock utility (#550)
3. `src/lib/mailbox.ts` — add file lock to send/markDelivered (#547)
4. `src/lib/team-chat.ts` — add file lock to postMessage (#555)
5. `src/lib/wish-state.ts` — cycle detection in createState, enforce in_progress before done, add resetGroup() (#548, #549, #552)
6. `src/lib/team-manager.ts` — validate team name against git rules (#551)
7. `src/term-commands/dispatch.ts` — case-insensitive regex (#554)
8. `src/term-commands/state.ts` — add `genie reset slug#group` CLI command (#552)
9. `src/lib/agent-directory.ts` — update to use shared file-lock (#550)
10. `src/lib/agent-registry.ts` — update to use shared file-lock (#550)

### Document only:
11. `src/lib/wish-state.ts` — add comment that getState() is lockless by design (#553)

---

## NEW FINDINGS FROM REAL-WORLD USAGE (2026-03-14)

### Issue #NEW-1 — `genie team hire/ls/fire` fail when CWD ≠ repo path (CRITICAL)

**What happened:**
```bash
# From PM agent CWD: /home/genie/agents/namastexlabs/totvs/totvs-pm
genie team create gh30-consolidate-uv --repo /path/to/totvs-poc --branch dev  # ✅ works
genie team hire implementor --team gh30-consolidate-uv  # ❌ "Team not found"
genie team ls  # ❌ "No teams found"
```

**Root cause:**
- `createTeam()` saves config at `<repo>/.genie/teams/<name>.json` (uses `--repo` flag)
- `team hire` (line 48): `repoPath = process.cwd()` → looks in `$CWD/.genie/teams/` → wrong directory
- `team ls` (line 109): same `process.cwd()` → empty
- ALL team commands except `create` use `process.cwd()` instead of resolving the repo

**Spec says (Group 3):**
> Team name = branch name. Worktree path: `<worktreeBase>/<name>`

The spec doesn't address cross-CWD team resolution because it assumes agents work from within the team worktree. But the PM/leader runs from a different directory.

**Fix:** Move team configs from `<repo>/.genie/teams/` to `~/.genie/teams/` (global). Each config already stores `repo`. All commands resolve repo from config, zero CWD dependency.

- `createTeam()` writes to `~/.genie/teams/<safeName>.json`
- `getTeam()` reads from `~/.genie/teams/<safeName>.json`
- `listTeams()` reads all from `~/.genie/teams/` — global, always
- `hire/fire/disband` get repo from `config.repo`
- `teamsDir()` changes from `join(repoPath, '.genie', 'teams')` to `join(GENIE_HOME, 'teams')`
- Migration: move any existing per-repo configs to global on first run (or just let old teams be recreated)

### Issue #NEW-2 — `genie update` doesn't actually update the binary (MEDIUM)

**What happened:**
```bash
genie update  # reports "Updated to 3.260314.2"
genie --version  # still shows 3.260310.5
bun remove -g @automagik/genie && bun add -g @automagik/genie@latest  # same result
```

**Root cause:**
The npm package's `dist/genie.js` contains a hardcoded version string baked at build time. If the npm publish process didn't rebuild, the dist bundle is stale. Or bun's module cache serves the old compiled binary despite the new package.json version.

**Spec says:** Out of scope for v2 redesign (install.sh listed in OUT scope). But this is a broken user-facing command.

**Fix options:**
- A) Read version from `package.json` at runtime instead of hardcoding in dist
- B) Add cache-busting to `genie update` (clear bun cache, reinstall)
- C) Defer — install.sh is out of scope

## WRS Status

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

