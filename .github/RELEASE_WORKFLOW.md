# Release Workflow Implementation

## Summary

Implemented RC-first release workflow for Automagik Genie with automatic publishing to npm.

## Architecture

```
Developer                    GitHub CI                    NPM Registry
────────                     ─────────                    ────────────

pnpm bump:minor
├─ Updates package.json
├─ Creates commit + tag
├─ Auto-pushes
                          ──► Detects RC tag
                              Runs tests
                              Publishes to @next ────────► @next: 2.1.0-rc.1

pnpm release:stable
├─ Updates package.json
├─ Creates commit + tag
├─ Auto-pushes
                          ──► Detects stable tag
                              Runs tests
                              Publishes to @latest ──────► @latest: 2.1.0
                              Creates GitHub release
```

## Files Changed

### New Scripts
- `scripts/bump.js` - Creates RC versions, auto-pushes to trigger CI
- `scripts/release.js` - Promotes RC → stable, creates GitHub releases
- `scripts/status.js` - Shows version status across local/git/npm

### Modified
- `package.json` - Added 6 new scripts
- `.github/workflows/publish.yml` - Handles RC tags, publishes to appropriate dist-tag

### Documentation
- `RELEASE.md` - Complete release guide for developers

## Commands

```bash
# Version bumping (creates RC)
pnpm bump:patch   # 2.0.1 → 2.0.2-rc.1
pnpm bump:minor   # 2.0.1 → 2.1.0-rc.1
pnpm bump:major   # 2.0.1 → 3.0.0-rc.1
pnpm bump:rc      # 2.1.0-rc.1 → 2.1.0-rc.2

# Promotion
pnpm release:stable  # 2.1.0-rc.X → 2.1.0

# Status
pnpm status
```

## Key Features

✅ **RC-first approach** - All bumps create RC versions published to `@next`
✅ **Auto-push** - Automatically pushes tags to trigger CI
✅ **Co-author support** - Adds "Automagik Genie 🧞 <genie@namastex.ai>" to commits
✅ **Safety checks** - Validates clean working directory, runs tests
✅ **Idempotent** - Won't duplicate publishes if re-run
✅ **Clear separation** - RC (@next) vs Stable (@latest)
✅ **GitHub integration** - Auto-creates releases on stable promotion

## CI Enhancements

1. **Detects RC tags** - Publishes to `@next` instead of `@latest`
2. **Skips sequence validation for RCs** - Only validates stable versions
3. **Ignores RC tags in sequence** - Compares stable → stable only

## Design Decisions

### Why RC-first?
**Critique addressed:** "As soon as we have a bump we should already pre-release"
- ✅ Lower friction - One command to get beta out
- ✅ Safe by default - Can't accidentally push unstable to production
- ✅ Testable immediately - Users can try `@next` right away
- ✅ Clear intent - RC tags signal "not ready yet"

### Why auto-push?
**Critique addressed:** "Less hassle for users"
- ✅ Triggers CI immediately
- ✅ Prevents "forgot to push" mistakes
- ✅ Reduces cognitive load - devs don't think about git operations

### Trade-offs Accepted
- ⚠️ Two commits per release (RC commit + stable commit)
- ⚠️ Requires `gh` CLI for GitHub release creation (graceful fallback)

## Testing

Before first use, test with a dry run:

```bash
# Create test branch
git checkout -b test-release

# Test bump script
pnpm bump:patch
# Should update package.json, create commit+tag

# Check git log
git log --oneline -2
git tag -l | tail -1

# Revert if needed
git reset --hard HEAD~1
git tag -d v2.0.2-rc.1
```

## Rollback Plan

If something goes wrong:

```bash
# Local rollback (before push)
git reset --hard HEAD~1
git tag -d vX.Y.Z-rc.N

# Remote rollback (after push, careful!)
git push --delete origin vX.Y.Z-rc.N
npm unpublish automagik-genie`@X.Y.Z-rc.N`
```

## Future Enhancements

- [ ] Add `--dry-run` flag to scripts
- [ ] Interactive mode for release.js (already has confirmation)
- [ ] Changelog generation integration
- [ ] Slack/Discord notifications
- [ ] Auto-rollback on CI failure
