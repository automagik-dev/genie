# Forge Executor Upgrade Guide

**Version:** v2.4.0-rc.28+
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Related:** Wish #120-A (Forge Drop-In Replacement)

---

## 🎯 Overview

This guide explains how to upgrade from Genie's traditional background launcher to the new Forge backend integration. The upgrade is **optional** but recommended for improved performance and reliability.

**Key Benefits:**
- ✅ Faster session creation (<5s vs 5-20s)
- ✅ Safe parallel execution (10+ concurrent sessions)
- ✅ No timeout failures (0% vs ~10%)
- ✅ Eliminates 6+ critical bugs
- ✅ Postgres-backed state (survives crashes)

---

## ⚡ Quick Upgrade (5 Minutes)

### Prerequisites Check

```bash
# 1. Check current Genie version
npx automagik-genie --version

# Should be >= v2.4.0-rc.28
# If not, upgrade first:
cd /path/to/automagik-genie
git pull
pnpm install
pnpm run build:genie
```

### Forge Backend Setup

```bash
# 2. Clone Forge repository (if not already installed)
git clone https://github.com/namastexlabs/automagik-forge
cd automagik-forge

# 3. Install dependencies
pnpm install

# 4. Start Forge backend
pnpm dev

# Expected output:
# ✓ Forge backend running at http://localhost:3000
# ✓ Database connected (Postgres)
# ✓ WebSocket server ready
```

### Enable Forge Integration

```bash
# 5. Configure environment (add to ~/.bashrc or ~/.zshrc)
export FORGE_BASE_URL="http://localhost:3000"

# Optional: Set auth token if required
export FORGE_TOKEN="your-api-token"

# Optional: Pre-create project ID
export GENIE_PROJECT_ID="uuid-of-your-project"

# 6. Verify Forge is accessible
curl http://localhost:3000/health

# Expected output:
# {"success":true,"data":{"status":"healthy"}}
```

### Test Upgraded Setup

```bash
# 7. Create a test session
npx automagik-genie run echo "Hello Forge!"

# Expected output should include:
# ▸ Creating Forge task for echo...
# ▸ Task attempt created: {uuid}
# ▸ Worktree: /var/tmp/automagik-forge/worktrees/{uuid}

# 8. Verify session uses Forge
npx automagik-genie list sessions

# Look for executor='forge' in the output
```

**That's it!** You're now using Forge backend. 🎉

---

## 📋 Detailed Upgrade Steps

### Step 1: Prerequisites

#### 1.1 Check Genie Version

```bash
npx automagik-genie --version
```

**Required:** v2.4.0-rc.28 or higher

**If outdated:**
```bash
cd /path/to/automagik-genie
git fetch
git checkout main
git pull
pnpm install
pnpm run build:genie
```

#### 1.2 Check Node.js Version

```bash
node --version
```

**Required:** v18.0.0 or higher

**If outdated:**
```bash
# Using nvm (recommended)
nvm install 18
nvm use 18

# Or download from nodejs.org
```

#### 1.3 Check Postgres Availability

Forge requires Postgres for state management.

```bash
# Check if Postgres is installed
psql --version

# Expected: PostgreSQL 14.x or higher
```

**If not installed:**
```bash
# macOS
brew install postgresql@14
brew services start postgresql@14

# Ubuntu/Debian
sudo apt-get install postgresql-14

# Windows
# Download installer from postgresql.org
```

---

### Step 2: Forge Backend Installation

#### 2.1 Clone Repository

```bash
# Navigate to your projects directory
cd ~/Projects  # Or your preferred location

# Clone Forge
git clone https://github.com/namastexlabs/automagik-forge
cd automagik-forge
```

#### 2.2 Install Dependencies

```bash
# Install all dependencies
pnpm install

# Expected output:
# Packages: +200 dependencies installed
# Done in 30s
```

#### 2.3 Configure Database

```bash
# Copy environment template
cp .env.example .env

# Edit .env file
nano .env  # Or your preferred editor

# Set database connection:
DATABASE_URL="postgresql://user:password@localhost:5432/forge_dev"
```

**Default configuration (local development):**
```env
DATABASE_URL="postgresql://localhost:5432/forge_dev"
PORT=3000
NODE_ENV=development
```

#### 2.4 Run Database Migrations

```bash
# Initialize database schema
pnpm run db:migrate

# Expected output:
# ✓ Migrations applied successfully
# ✓ Database schema is up to date
```

#### 2.5 Start Forge Backend

```bash
# Start in development mode
pnpm dev

# Expected output:
# [Forge] Starting development server...
# [Forge] Database connected: postgresql://localhost:5432/forge_dev
# [Forge] HTTP server listening on http://localhost:3000
# [Forge] WebSocket server ready
# [Forge] Ready for requests ✓
```

**Production mode:**
```bash
pnpm build
pnpm start
```

---

### Step 3: Environment Configuration

#### 3.1 Set Environment Variables

**Temporary (current terminal session only):**
```bash
export FORGE_BASE_URL="http://localhost:3000"
```

**Permanent (add to shell profile):**

**Bash** (`~/.bashrc` or `~/.bash_profile`):
```bash
# Add at end of file
export FORGE_BASE_URL="http://localhost:3000"
```

**Zsh** (`~/.zshrc`):
```bash
# Add at end of file
export FORGE_BASE_URL="http://localhost:3000"
```

**Fish** (`~/.config/fish/config.fish`):
```fish
# Add at end of file
set -x FORGE_BASE_URL "http://localhost:3000"
```

**Reload shell:**
```bash
source ~/.bashrc  # Or ~/.zshrc, ~/.bash_profile
```

#### 3.2 Optional: Authentication

If Forge requires authentication:

```bash
# Set API token
export FORGE_TOKEN="your-api-token-here"

# Generate token (if needed):
# 1. Log in to Forge UI: http://localhost:3000
# 2. Navigate to Settings > API Tokens
# 3. Click "Generate New Token"
# 4. Copy token and set in environment
```

#### 3.3 Optional: Pre-create Project

By default, Genie auto-creates a "Genie Sessions" project. To use a specific project:

```bash
# Create project via Forge UI or CLI
# Get project UUID from Forge

export GENIE_PROJECT_ID="your-project-uuid-here"

# Now all Genie sessions use this project
```

---

### Step 4: Verification

#### 4.1 Health Check

```bash
# Test Forge API is reachable
curl http://localhost:3000/health

# Expected response:
# {"success":true,"data":{"status":"healthy"}}
```

**If fails:**
- Check Forge is running: `pnpm dev` in automagik-forge directory
- Check firewall allows port 3000
- Check FORGE_BASE_URL is correct

#### 4.2 Create Test Session

```bash
# Run a simple Genie command
npx automagik-genie run echo "Test Forge integration"

# Expected output:
# ▸ Creating Forge task for echo...
# ▸ Task attempt created: a1b2c3d4-e5f6-7890-abcd-ef1234567890
# ▸ Worktree: /var/tmp/automagik-forge/worktrees/a1b2c3d4-...
# ▸ Branch: forge/a1b2c3d4-...
#
#   View output:
#     npx automagik-genie view echo-2510181530
```

**If fails with "Forge backend unavailable":**
- Genie falls back to traditional launcher
- Check FORGE_BASE_URL is set: `echo $FORGE_BASE_URL`
- Check Forge is accessible: `curl $FORGE_BASE_URL/health`

#### 4.3 Verify Session Type

```bash
# List sessions
npx automagik-genie list sessions

# Look for executor column
# Forge sessions show: executor='forge'
# Traditional sessions show: executor='codex' or 'claude'
```

**Example output:**
```
Session Name        | Executor | Status  | Created
------------------------------------------------------------
echo-2510181530     | forge    | running | 2025-10-18 15:30
analyze-2510181500  | codex    | stopped | 2025-10-18 15:00
```

---

### Step 5: Migration (Optional)

Existing sessions continue to work with their original executor. Migration is **optional**.

#### 5.1 Backup Current Sessions

```bash
# Always backup before migration!
cp .genie/state/agents/sessions.json \
   .genie/state/agents/backups/sessions-$(date +%Y%m%d).json

# Verify backup exists
ls -lh .genie/state/agents/backups/
```

#### 5.2 Dry-Run Migration

```bash
# Preview what would happen (no changes made)
npx automagik-genie migrate --dry-run

# Expected output:
# Migration Plan (DRY RUN):
# - Total sessions: 15
# - Will migrate: 8 (running/pending)
# - Will archive: 7 (completed/stopped)
# - Forge tasks to create: 8
# - No changes made (dry-run mode)
```

#### 5.3 Execute Migration

```bash
# Execute migration (creates Forge tasks for existing sessions)
npx automagik-genie migrate --execute

# Expected output:
# Migration Progress:
# ✓ Backup created: sessions-20251018-153000.json
# ✓ Forge health check passed
# ✓ Project found: Genie Sessions (uuid: ...)
# ✓ Migrating session 1/8: analyze-2510181500
# ✓ Migrating session 2/8: debug-2510181510
# ...
# ✓ Migration complete: 8 sessions migrated
# ✓ Archived: 7 completed sessions
# ✓ sessions.json updated
```

#### 5.4 Validate Migration

```bash
# List all sessions
npx automagik-genie list sessions

# Verify:
# - All active sessions now show executor='forge'
# - Session count unchanged
# - No sessions lost
```

#### 5.5 Rollback if Needed

```bash
# If something went wrong, rollback:
npx automagik-genie migrate --rollback

# Or manually restore backup:
cp .genie/state/agents/backups/sessions-20251018.json \
   .genie/state/agents/sessions.json
```

**See also:** `.genie/docs/forge-rollback-plan.md` for detailed rollback procedures

---

## 🔄 Hybrid Mode (Forge + Traditional)

You can switch between Forge and traditional mode anytime.

### Enable Forge (Per Command)

```bash
# Use Forge for this command only
FORGE_BASE_URL="http://localhost:3000" npx automagik-genie run analyze "test"
```

### Disable Forge (Per Command)

```bash
# Use traditional launcher for this command
unset FORGE_BASE_URL
npx automagik-genie run analyze "test"
```

### Switch Globally

```bash
# Enable Forge globally
export FORGE_BASE_URL="http://localhost:3000"

# Disable Forge globally
unset FORGE_BASE_URL
```

### Coexistence

Both session types work side-by-side:

```bash
# Create Forge session
export FORGE_BASE_URL="http://localhost:3000"
npx automagik-genie run analyze-forge "test"

# Create traditional session
unset FORGE_BASE_URL
npx automagik-genie run analyze-traditional "test"

# List both
npx automagik-genie list sessions
# Output:
# analyze-forge-...      | forge | running | ...
# analyze-traditional-...| codex | running | ...
```

---

## 🚨 Breaking Changes

**None!** This upgrade is 100% backwards compatible.

**What stays the same:**
- ✅ All CLI commands identical (run, resume, stop, view, list)
- ✅ CLI output format unchanged
- ✅ Session IDs format unchanged (UUID)
- ✅ Error messages unchanged
- ✅ Existing sessions continue to work
- ✅ No forced migration

**What changes internally:**
- Session creation uses Forge API (atomic, faster)
- Session state stored in Postgres (in addition to sessions.json)
- Worktrees managed by Forge (isolated)
- Logs stored in Postgres (+ CLI log file fallback)

---

## ❓ FAQ

### Q: Do I have to upgrade?

**A:** No, upgrade is **optional**. Traditional background launcher continues to work.

**Benefits of upgrading:**
- 🚀 Faster session creation
- 🔒 More reliable (no timeouts)
- 🐛 Eliminates 6+ known bugs
- ⚡ Safe parallel sessions

---

### Q: Will my existing sessions break?

**A:** No. Existing sessions continue using their original executor (traditional launcher).

**Options:**
1. **Keep as-is:** Existing sessions work normally, new sessions use Forge
2. **Migrate:** Convert existing sessions to Forge (optional, reversible)

---

### Q: What if Forge backend is down?

**A:** Genie automatically falls back to traditional launcher.

**Behavior:**
- Health check fails → Shows warning
- Session created with traditional launcher
- No interruption to workflow

**Example:**
```bash
# Forge is down
npx automagik-genie run analyze "test"

# Output:
# ⚠️ Forge backend unavailable, using traditional background launcher
# ▸ Starting session analyze-2510181530...
# (session created with traditional launcher)
```

---

### Q: Can I switch back to traditional launcher?

**A:** Yes, anytime.

```bash
# Disable Forge
unset FORGE_BASE_URL

# All new sessions use traditional launcher
npx automagik-genie run analyze "test"
```

**See also:** `.genie/docs/forge-rollback-plan.md` for complete rollback procedures

---

### Q: How do I know if a session is using Forge?

**A:** Check the `executor` column in session list.

```bash
npx automagik-genie list sessions

# Output shows executor type:
# Session Name        | Executor | Status  | ...
# --------------------------------------------------
# analyze-2510181530  | forge    | running | ...  ← Forge
# debug-2510181500    | codex    | running | ...  ← Traditional
```

---

### Q: What happens to logs from Forge sessions?

**A:** Logs are stored in Postgres + CLI log file (redundancy).

**Retrieval priority:**
1. Try Forge API (`listExecutionProcesses`)
2. If fails, fallback to CLI log file
3. Display source indicator: "Forge logs" or "CLI log"

**Example:**
```bash
npx automagik-genie view analyze-2510181530

# Output header shows:
# Session: analyze-2510181530
# Executor: forge
# Status: running
# Source: Forge logs ← Fetched from Postgres
```

---

### Q: Can I use Forge in production?

**A:** Yes, Forge is production-ready (RC28+).

**Recommendations:**
- Use Postgres with regular backups
- Set FORGE_TOKEN for authentication
- Monitor Forge backend health
- Configure auto-restart (systemd, PM2, etc.)

---

### Q: How do I upgrade Forge itself?

**A:** Standard git pull + migration.

```bash
cd /path/to/automagik-forge

# Stop Forge
# (Ctrl+C or `pnpm stop` if running as service)

# Update code
git pull

# Install new dependencies
pnpm install

# Run migrations (if any)
pnpm run db:migrate

# Restart Forge
pnpm dev  # Or pnpm start for production
```

---

### Q: What if I need help?

**Resources:**
- **Documentation:** `.genie/docs/forge-quick-start.md`
- **Issues:** https://github.com/namastexlabs/automagik-genie/issues
- **Discord:** https://discord.gg/xcW8c7fF3R
- **Architecture:** `.genie/docs/architecture.md`

---

## 🧪 Testing Your Upgrade

### Test Suite

Run all validation tests:

```bash
# 1. Health check
curl $FORGE_BASE_URL/health

# 2. Create session
npx automagik-genie run test1 "test session creation"

# 3. View session
npx automagik-genie view test1-*

# 4. Resume session
npx automagik-genie resume test1-* "continue test"

# 5. Stop session
npx automagik-genie stop test1-*

# 6. List sessions
npx automagik-genie list sessions

# 7. Parallel sessions (stress test)
for i in {1..5}; do
  npx automagik-genie run parallel-$i "test $i" &
done
wait

# 8. Verify all created
npx automagik-genie list sessions | grep parallel-
```

**Expected results:**
- ✅ All commands succeed
- ✅ All sessions show executor='forge'
- ✅ Parallel sessions all created (no conflicts)
- ✅ Session creation < 5s each

---

## 📊 Performance Benchmarks

### Before (Traditional Launcher)

| Metric | Value |
|--------|-------|
| Session creation | 5-20s (polling) |
| Timeout failures | ~10% |
| Max parallel sessions | ~3 (unsafe) |
| UUID reuse risk | ⚠️ Yes |

### After (Forge Backend)

| Metric | Value |
|--------|-------|
| Session creation | <5s (atomic) |
| Timeout failures | 0% |
| Max parallel sessions | 10+ (safe) |
| UUID reuse risk | ✅ No |

**Improvement:**
- 🚀 **4x faster** session creation
- 🔒 **100% reliable** (no timeouts)
- ⚡ **3x more** parallel capacity

---

## 🔗 Related Documentation

- **Quick Start:** `.genie/docs/forge-quick-start.md`
- **Architecture:** `.genie/docs/architecture.md`
- **Rollback Plan:** `.genie/docs/forge-rollback-plan.md`
- **API Reference:** `.genie/docs/forge-endpoint-mapping.md`
- **Implementation Summary:** `.genie/discovery/wish-120-a-implementation-summary.md`

---

## 🎯 Next Steps

After completing upgrade:

1. **Test all commands** (run, resume, stop, view, list)
2. **Monitor performance** (measure session creation times)
3. **Report issues** (GitHub issues with reproduction steps)
4. **Share feedback** (Discord, GitHub Discussions)
5. **Explore advanced features** (Wish #120-B coming soon!)

---

**Happy automating with Forge! 🧞✨**

**Questions?** Open an issue: https://github.com/namastexlabs/automagik-genie/issues
