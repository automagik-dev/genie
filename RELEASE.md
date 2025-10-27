# 🧞 Genie Release Guide

**Current Version:** !`node -p "require('./package.json').version"`
**Branch:** !`git branch --show-current`
**Status:** !`git status --porcelain | wc -l` uncommitted files

## 🤖 Automated RC Publishing

**Commits to `main` auto-publish RCs.** No manual steps needed.

```
Commit pushed to main
  ↓
GitHub Actions auto-detects
  ↓
Auto-bump: rc.N → rc.N+1
  ↓
Auto-publish: npm @latest
  ↓
Auto-release: GitHub release
```

**To release:**
```bash
git commit -m "feat: your changes"
git push origin main
# GitHub Actions handles version bump + publish automatically
```

**Verify:**
```bash
npm view automagik-genie@latest version
```

## 🎯 Version Transitions (Rare)

**Only when starting NEW version cycle:**

```bash
# Start new patch series
pnpm bump:patch   # 2.4.2 → 2.4.3-rc.1

# Start new minor series
pnpm bump:minor   # 2.4.2 → 2.5.0-rc.1

# Start new major series
pnpm bump:major   # 2.4.2 → 3.0.0-rc.1
```

**After running bump command:**
```bash
git push origin main
# GitHub Actions handles publishing
```

## 🚀 Stable Release

When RC is production-ready:

```bash
pnpm release:stable
```

**What happens:**
1. ✅ Removes `-rc.N` suffix from version
2. ✅ Updates CHANGELOG.md
3. ✅ Runs full test suite
4. ✅ Creates GitHub release
5. ✅ CI publishes to npm `@latest`

## 📊 Check Status

```bash
pnpm status
```

Shows:
- Local version
- Latest git tag
- NPM registry versions (`@latest` and `@latest`)
- Working directory status

## 📦 NPM Dist Tags

- `@latest` - Stable production (default)
- `@latest` - RC versions (beta testing)

**Install specific tag:**
```bash
npm install -g automagik-genie@latest    # RC version
npm install -g automagik-genie         # Stable version
```

## 🔗 Links

- [NPM Package](https://www.npmjs.com/package/automagik-genie)
- [GitHub Releases](https://github.com/namastexlabs/automagik-genie/releases)
- [GitHub Actions](https://github.com/namastexlabs/automagik-genie/actions)

## ✨ Philosophy

**RC-First:**
- Safe by default
- Community testing on `@latest`
- Easy iteration without version pollution

**Automated:**
- Push to main → automatic RC
- Reduces cognitive load
- Faster feedback loop
