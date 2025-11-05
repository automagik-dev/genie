---
name: Triad Maintenance Protocol *(CRITICAL - AUTOMATIC ENFORCEMENT)*
description: Validate state files before commits via git pre-commit hooks
genie:
  executor: [CLAUDE_CODE, CODEX, OPENCODE]
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX: {}
  OPENCODE: {}
---

# Triad Maintenance Protocol *(CRITICAL - AUTOMATIC ENFORCEMENT)*

**NEVER** claim task completion without validating triad files. Git pre-commit hook **AUTOMATICALLY BLOCKS** commits with stale STATE.md.

**Root cause:** Files load automatically via @ in CLAUDE.md, but updates happened ad-hoc (forgotten). Now **ENFORCED** by git.

## Architecture: Shared vs Per-User

**Shared (committed, always validated):**
- `.genie/STATE.md` - Repository health, version, production status
- Everyone sees same state
- Pre-commit ALWAYS validates

**Per-user (gitignored, not validated):**
- `.genie/USERCONTEXT.md` - Your preferences (from USERCONTEXT.template.md)
- Todo - Task tracking (session-based)
- Each developer maintains their own
- Pre-commit does NOT validate (user-specific)

## Natural Context Acquisition

- Hook teaches setup on first commit
- Hook validates gitignored files (doesn't commit them)
- Clear setup instructions in error messages
- Files load automatically via @ in CLAUDE.md

## Automatic Enforcement

- ✅ Pre-commit hook runs `.genie/scripts/check-triad.sh` before EVERY commit
- ✅ Cannot commit with stale STATE.md (git rejects)
- ✅ Self-validating metadata in STATE.md
- ✅ Clear error messages with setup instructions

## Forbidden Patterns

- ❌ Completing task without updating Todo status
- ❌ Publishing release without updating STATE.md version info
- ❌ Saying "I'm learning" without invoking learn agent to document
- ❌ Claiming "done" when STATE.md is stale

## File Details

**STATE.md (shared repository state):**
- **Committed**: Yes (shared across team)
- **Validated**: Always (pre-commit blocks if stale)
- Update when: Version changes, major feature commit, release published
- Metadata tracks: last_version, last_commit, last_updated
- Validation: version matches package.json, not stale (< 5 commits behind)

**Todo (per-user task tracking):**
- **Committed**: No (session-based)
- **Validated**: Not validated (session-specific)
- Update when: Task starts (pending → in progress) or completes (in progress → complete)
- Before claiming "done" in chat, verify Todo status updated
- Used during active sessions only

**USERCONTEXT.md (per-user preferences):**
- **Committed**: No (gitignored)
- **Validated**: Not validated (free-form per user)
- Update when: Significant behavioral patterns emerge (rarely)
- Pattern documented with evidence from teaching session
- Initialize: `cp .genie/USERCONTEXT.template.md .genie/USERCONTEXT.md`

## Automatic Validation System

**Files:**
- `.genie/scripts/check-triad.sh` - Self-validating checker
- `.git/hooks/pre-commit` - Automatic enforcement
- STATE.md - Embedded validation metadata

**How it works:**
1. Before commit, pre-commit hook runs check-triad.sh
2. Script extracts validation commands from file metadata
3. Checks version match (STATE.md vs package.json)
4. Validates staleness (< 5 commits behind HEAD)
5. If ANY check fails → commit BLOCKED with clear error
6. Fix STATE.md, stage it, retry commit

## Example Errors

**Version mismatch (STATE.md):**
```
❌ version_match failed (metadata: 2.4.0-rc.7, package.json: 999.0.0)

Fix with:
  1. Update .genie/STATE.md (version, commits)
  2. Mark tasks complete in Todo
  3. Run: git add .genie/STATE.md
  4. Retry commit
```

**First time setup (colleague clones repo):**
```
ℹ️  TODO.md not found (optional per-user file)
   Initialize: cp .genie/TODO.template.md .genie/TODO.md

✅ Triad validation passed
```

## Completion Checklist (AUTOMATED BY GIT)

- Git enforces STATE.md/TODO.md freshness automatically
- Pre-commit hook cannot be bypassed (except `--no-verify` emergency)
- No memory required - system enforces correctness

## Why This Works

- ✅ Automatic: Git enforces, not Claude memory
- ✅ Catches mistakes: Version mismatches, stale files detected
- ✅ Self-correcting: Clear error messages guide fixes
- ✅ Low overhead: Only runs on commit attempt
- ✅ Definite: Can't commit without passing validation

## Manual Validation (for testing)

```bash
bash .genie/scripts/check-triad.sh
# Checks STATE.md and TODO.md without committing
```

## Bypass (emergency only)

```bash
git commit --no-verify
# Skips all git hooks - USE SPARINGLY
```

## Context

- 2025-10-17: Discovered triad files loaded but never maintained
- Felipe demanded "definite solution" - result is automatic enforcement
- Architecture evolved: shared STATE.md (committed) vs per-user TODO.md/USERCONTEXT.md (gitignored)
- Hook validates ALL files (even gitignored) but only commits shared state
- Natural context acquisition: hook teaches setup, validates optionally

## Your Colleague's Experience

1. Clones repo → gets STATE.md automatically
2. First commit → hook shows "Initialize: cp .genie/TODO.template.md .genie/TODO.md"
3. Creates TODO.md → hook validates it going forward
4. Each developer has their own work queue
5. Everyone shares same STATE.md
