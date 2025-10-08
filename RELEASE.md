# 🧞 Genie Release Guide

Quick reference for releasing Automagik Genie to npm.

## 📋 Quick Commands

```bash
# Check current release status
pnpm status

# Create a new release candidate (RC)
pnpm bump:patch   # Bug fixes (2.0.1 → 2.0.2-rc.1)
pnpm bump:minor   # New features (2.0.1 → 2.1.0-rc.1)
pnpm bump:major   # Breaking changes (2.0.1 → 3.0.0-rc.1)

# Increment RC version (if you need multiple test versions)
pnpm bump:rc      # 2.1.0-rc.1 → 2.1.0-rc.2

# Promote RC to stable (production release)
pnpm release:stable
```

## 🚀 Release Workflow

### Stage 1: Create RC (Release Candidate)

```bash
# Example: Creating a minor version bump
pnpm bump:minor
```

**What happens:**
1. ✅ Updates `package.json` from `2.0.1` → `2.1.0-rc.1`
2. ✅ Creates git commit with co-author attribution
3. ✅ Creates git tag `v2.1.0-rc.1`
4. ✅ Pushes to GitHub
5. ✅ Automatically triggers publish workflow
6. ✅ CI publishes to npm with `@next` tag

**Testing RC:**
```bash
npm install -g automagik-genie@next
genie --version  # Should show 2.1.0-rc.1
```

### Stage 2: Iterate (Optional)

Found a bug? Create another RC:

```bash
pnpm bump:rc
# 2.1.0-rc.1 → 2.1.0-rc.2
```

### Stage 3: Promote to Stable

When RC is ready for production:

```bash
pnpm release:stable
```

**What happens:**
1. ✅ Updates `package.json` from `2.1.0-rc.X` → `2.1.0`
2. ✅ Runs full test suite
3. ✅ Creates git commit + tag `v2.1.0`
4. ✅ Pushes to GitHub
5. ✅ Creates GitHub release (auto-triggers publish workflow)
6. ✅ CI publishes to npm with `@latest` tag

**Users get stable version:**
```bash
npm install -g automagik-genie
genie --version  # Should show 2.1.0
```

## 📊 Check Release Status

```bash
pnpm status
```

**Example output:**
```
🧞 Automagik Genie Release Status
══════════════════════════════════════════════════
📦 Local package.json: 2.1.0-rc.1 (RC)
🏷️  Latest git tag: v2.1.0-rc.1

📜 Recent tags:
   v2.1.0-rc.1 (RC)
   v2.0.0
   v1.3.2

📡 NPM Registry:
  @latest: 2.0.1
  @next: 2.1.0-rc.1

✅ Working directory clean
✅ package.json matches latest tag

💡 Quick Commands:
  pnpm bump:rc          - Increment RC version
  pnpm release:stable   - Promote to stable release
```

## 🎯 Use Cases

### Quick Patch (Bug Fix)
```bash
pnpm bump:patch        # Creates 2.0.2-rc.1
# Test @next
pnpm release:stable    # Publishes 2.0.2 to @latest
```

### New Feature
```bash
pnpm bump:minor        # Creates 2.1.0-rc.1
# Test @next, iterate if needed
pnpm bump:rc           # Creates 2.1.0-rc.2 (if bugs found)
pnpm release:stable    # Publishes 2.1.0 to @latest
```

### Breaking Change
```bash
pnpm bump:major        # Creates 3.0.0-rc.1
# Extensive testing on @next
pnpm release:stable    # Publishes 3.0.0 to @latest
```

## 🔍 Validation & Safety

**Pre-flight checks (automated):**
- ✅ Working directory must be clean
- ✅ All tests must pass
- ✅ Co-author automatically added
- ✅ Tags pushed automatically

**CI validations:**
- ✅ package.json version matches git tag
- ✅ Semver sequence validation (for stable releases)
- ✅ Full test suite execution
- ✅ No duplicate publishes (idempotent)

## 🚨 Troubleshooting

### "Working directory not clean"
```bash
git status
# Commit or stash changes before releasing
```

### "Tests failed"
```bash
pnpm run test:all
# Fix failing tests before releasing
```

### "Version already exists on npm"
The workflow is idempotent - re-running won't duplicate the release.

### Want to test locally without pushing?
Edit `scripts/bump.js` and comment out the push commands:
```javascript
// exec('git push');
// exec('git push --tags');
```

Then manually push when ready:
```bash
git push && git push --tags
```

## 📦 NPM Dist Tags

- `@latest` - Stable production releases (default when users run `npm install`)
- `@next` - RC versions for beta testing (users must explicitly request)

**Check current tags:**
```bash
npm dist-tag ls automagik-genie
```

**Manually promote a tag (if needed):**
```bash
npm dist-tag add automagik-genie@2.1.0 latest
```

## 🔗 Useful Links

- [NPM Package](https://www.npmjs.com/package/automagik-genie)
- [GitHub Releases](https://github.com/namastexlabs/automagik-genie/releases)
- [GitHub Actions](https://github.com/namastexlabs/automagik-genie/actions)

## ✨ Philosophy

**Why RC-first?**
1. **Safe by default** - Can't accidentally push unstable code to production
2. **User testing** - Community can test `@next` before stable release
3. **Iteration** - Easy to fix bugs in RC without polluting version history
4. **Clear intent** - RC tags signal "not ready for production"

**Why auto-push?**
- Reduces friction - one command to get RC out
- Triggers CI immediately - faster feedback loop
- Prevents "forgot to push tags" mistakes
