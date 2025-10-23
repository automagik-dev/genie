# Release Workflow Implementation

## Summary

Automagik Genie uses **automated RC publishing** - commits to `main` trigger automatic version bumps and npm releases.

## Architecture

```
Developer                    GitHub Actions               NPM Registry
────────                     ──────────────               ────────────

git push origin main    ──► Detects commit on main
                             Auto-bumps: rc.N → rc.N+1
                             Runs tests
                             Publishes to @next ────────► @next: 2.4.2-rc.92

pnpm bump:minor         ──► Detects version tag
(rare - new series)          Runs tests
                             Publishes to @next ────────► @next: 2.5.0-rc.1

pnpm release:stable     ──► Detects stable tag
                             Runs tests
                             Publishes to @latest ──────► @latest: 2.5.0
                             Creates GitHub release
```

## Key Files

### Scripts
- `scripts/bump.cjs` - **Rare use:** Start new version series (patch/minor/major)
- `scripts/release.cjs` - Promote RC → stable
- `scripts/status.cjs` - Show version status
- `.genie/scripts/update-changelog.cjs` - Manage CHANGELOG.md

### CI/CD
- `.github/workflows/publish.yml` - Automated publishing on main commits
- Handles RC tags, stable tags, and routine commits

### Documentation
- `RELEASE.md` - User-facing release guide
- `.genie/code/spells/automated-rc-publishing.md` - Behavioral spell (no manual RC bumps)

## Commands

### Routine Development (99% of releases)
```bash
# Make changes, commit, push to main
git commit -m "feat: add feature"
git push origin main
# GitHub Actions automatically:
# - Bumps version (rc.91 → rc.92)
# - Publishes to @next
# - Creates GitHub release
```

### Version Transitions (Rare)
```bash
# Start new patch series
pnpm bump:patch   # 2.4.2 → 2.4.3-rc.1

# Start new minor series
pnpm bump:minor   # 2.4.2 → 2.5.0-rc.1

# Start new major series
pnpm bump:major   # 2.4.2 → 3.0.0-rc.1

# After any bump:
git push origin main  # GitHub Actions handles publish
```

### Stable Release
```bash
pnpm release:stable  # 2.5.0-rc.X → 2.5.0
```

### Status Check
```bash
pnpm status  # Shows local, git, and npm versions
```

## Key Features

✅ **Automated RC bumps** - Commits to main trigger auto-increment
✅ **No manual intervention** - Push to main, automation handles rest
✅ **Co-author support** - Adds "Automagik Genie 🧞" to commits
✅ **Safety checks** - Validates clean directory, runs tests
✅ **Idempotent** - Won't duplicate publishes if re-run
✅ **Clear separation** - RC (@next) vs Stable (@latest)
✅ **GitHub integration** - Auto-creates releases
✅ **Changelog-aware** - Moves [Unreleased] to version sections

## CI Enhancements

1. **Auto-detects main commits** - Bumps RC and publishes
2. **Detects RC tags** - Publishes to `@next`
3. **Detects stable tags** - Publishes to `@latest`
4. **Skips sequence validation for RCs** - Only validates stable versions

## Design Decisions

### Why Automated?
- ✅ Zero cognitive load - just push to main
- ✅ Faster feedback loop
- ✅ Can't forget to publish
- ✅ Consistent versioning

### Why RC-first?
- ✅ Safe by default - can't accidentally push unstable to production
- ✅ Testable immediately - users can try `@next`
- ✅ Clear intent - RC tags signal "beta"

### Trade-offs Accepted
- ⚠️ Automated commits on main (version bumps from CI)
- ⚠️ Pre-push hook auto-syncs to handle CI commits
- ⚠️ Requires `gh` CLI for GitHub releases (graceful fallback)

## Amendment #6 Integration

This workflow implements Amendment #6: "Automated Publishing - PR Merge = Auto RC"

**Rule:** NEVER manually run `pnpm bump:rc` for routine releases

**Why:** GitHub Actions handles it automatically on main commits

## Rollback Plan

If something goes wrong:

```bash
# Local rollback (before push)
git reset --hard HEAD~1
git tag -d vX.Y.Z-rc.N

# Remote rollback (after push - careful!)
git push --delete origin vX.Y.Z-rc.N
npm unpublish automagik-genie@X.Y.Z-rc.N
```

## Future Enhancements

- [ ] Slack/Discord notifications on publish
- [ ] Auto-rollback on CI test failures
- [ ] Canary releases for major versions
