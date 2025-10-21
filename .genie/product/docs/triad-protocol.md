# Triad Protocol (Automatic Enforcement)
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**CRITICAL:** Git pre-commit hook AUTOMATICALLY BLOCKS commits with stale STATE.md.

**Root cause:** Files load automatically via @ in CLAUDE.md, but updates happened ad-hoc (forgotten). Now **ENFORCED** by git.

## Architecture: Shared vs Per-User

### Shared (committed, always validated)

**STATE.md:**
- Repository health, version, production status
- Everyone sees same state
- Pre-commit ALWAYS validates

### Per-User (gitignored, validated if exists)

**TODO.md:**
- Your work queue (from TODO.template.md)
- Each developer maintains their own
- Pre-commit validates IF EXISTS

**USERCONTEXT.md:**
- Your preferences (from USERCONTEXT.template.md)
- Each developer maintains their own
- Pre-commit validates IF EXISTS

## Natural Context Acquisition

- Hook teaches setup on first commit
- Hook validates gitignored files (doesn't commit them)
- Clear setup instructions in error messages
- Files load automatically via @ in CLAUDE.md

## Automatic Enforcement

- ✅ Pre-commit hook runs `.genie/scripts/check-triad.sh` before EVERY commit
- ✅ Cannot commit with stale STATE.md (git rejects)
- ✅ Validates per-user files if present (optional)
- ✅ Self-validating metadata in all files
- ✅ Clear error messages with setup instructions

## File Details

### STATE.md (shared repository state)

- **Committed:** Yes (shared across team)
- **Validated:** Always (pre-commit blocks if stale)
- **Update when:** Version changes, major feature commit, release published
- **Metadata tracks:** last_version, last_commit, last_updated
- **Validation:** version matches package.json, not stale (< 5 commits behind)

### TODO.md (per-user work queue)

- **Committed:** No (gitignored)
- **Validated:** If exists (optional per developer)
- **Update when:** Task starts (pending → in progress) or completes (in progress → complete)
- Before claiming "done" in chat, verify TODO.md updated
- **Metadata tracks:** active_tasks, completed_tasks
- **Validation:** completed count, priority sections exist
- **Initialize:** `cp .genie/TODO.template.md .genie/TODO.md`

### USERCONTEXT.md (per-user preferences)

- **Committed:** No (gitignored)
- **Validated:** Not validated (free-form per user)
- **Update when:** Significant behavioral patterns emerge (rarely)
- Pattern documented with evidence from teaching session
- **Initialize:** `cp .genie/USERCONTEXT.template.md .genie/USERCONTEXT.md`

## Automatic Validation System

### Files

- `.genie/scripts/check-triad.sh` - Self-validating checker
- `.git/hooks/pre-commit` - Automatic enforcement
- STATE.md/TODO.md - Embedded validation metadata

### How It Works

1. Before commit, pre-commit hook runs check-triad.sh
2. Script extracts validation commands from file metadata
3. Checks version match (STATE.md vs package.json)
4. Validates task counts, priority sections, staleness
5. If ANY check fails → commit BLOCKED with clear error
6. Fix files, stage them, retry commit

## Example Errors

### Version Mismatch (STATE.md)

```
❌ version_match failed (metadata: 2.4.0-rc.7, package.json: 999.0.0)

Fix with:
  1. Update .genie/STATE.md (version, commits)
  2. Update .genie/TODO.md (mark tasks COMPLETE) [if you have one]
  3. Run: git add .genie/STATE.md
  4. Retry commit
```

### First Time Setup (colleague clones repo)

```
ℹ️  TODO.md not found (optional per-user file)
   Initialize: cp .genie/TODO.template.md .genie/TODO.md

✅ Triad validation passed
```

## Forbidden Patterns

- ❌ Completing TODO task without marking complete in TODO.md
- ❌ Publishing release without updating STATE.md version info
- ❌ Saying "I'm learning" without invoking learn agent to document
- ❌ Claiming "done" when STATE.md is stale

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

## Your Colleague's Experience

1. Clones repo → gets STATE.md automatically
2. First commit → hook shows "Initialize: cp .genie/TODO.template.md .genie/TODO.md"
3. Creates TODO.md → hook validates it going forward
4. Each developer has their own work queue
5. Everyone shares same STATE.md

## Context

- **Date:** 2025-10-17
- **Discovery:** Triad files loaded but never maintained
- **Solution:** Automatic enforcement via git hooks
- **Architecture:** Shared STATE.md (committed) vs per-user TODO.md/USERCONTEXT.md (gitignored)
- **Result:** Hook validates ALL files (even gitignored) but only commits shared state
- **Benefit:** Natural context acquisition - hook teaches setup, validates optionally
