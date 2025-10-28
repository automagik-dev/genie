<!--
Triad Validation Metadata
last_updated: !`date -u +"%Y-%m-%dT%H:%M:%SZ"`
last_commit: !`git log -1 --format=%h`
last_version: 2.5.5-rc.76
validation_commands:
  version_exists: test -f package.json && jq -e .version package.json >/dev/null
  state_updated_recently: test $(git log --oneline .genie/STATE.md..HEAD 2>/dev/null | wc -l) -lt 5
  has_version_line: grep -q "Version:" .genie/STATE.md
-->

# 🗂️ Genie System State
**Purpose:** System state snapshot (read-only reference)

---

## 📊 Current Session

**Date:** 2025-10-28
**Focus:** Genie CLI stability fixes + Auto-sync automation
**Branch:** dev

**Active Work (Today):**
- ✅ Fixed genie auto-exit bug (4 PRs: #344, #346, #348, #349)
  - PR #344: Removed rl.close() to keep stdin open
  - PR #346: Fixed dashboard exit handler killing parent
  - PR #348: Added MCP port conflict detection
  - PR #349: Added takeover prompt for port conflicts
- ✅ Published RC70-RC76 (6 versions in one session!)
- ✅ Added auto-sync workflow (dev syncs with main after releases)
- ✅ Context unification (Amendment #12 + CLAUDE.md optimization)
  - Created Amendment #12: Context File Maintenance protocol
  - Reduced CLAUDE.md from 2,029 tokens → 5 tokens (99.75% reduction)
  - Clarified STATE.md/USERCONTEXT.md/TODO.md maintenance rules
  - Token savings: 2,024 tokens saved per session startup
- 📦 RC76 stable and ready for testing

**Recent Completed Work (Oct 26-27):**
- ✅ MCP bug fixes (transport issues, error handling, voice mode consolidation)
- ✅ Genie routing optimization analysis (GitHub #260)
- ✅ Version tracking unification (single version.json)
- ✅ Backup system consolidation (unified backupGenieDirectory)

---

## 📦 Production Status

**Version:** 2.5.5-rc.76
**Published:** v2.5.5-rc.76 on npm@next (2025-10-28)
**Status:** 🎉 RC76 released – genie CLI stability fixes complete

**RC76 Status:**
- ✅ Four critical CLI bugs fixed (#344)
- ✅ Takeover prompt implemented (matches Forge UX)
- ✅ Auto-sync workflow active (dev ← main after releases)
- ✅ All tests passing (19/19 session service, CLI tests)
- 📦 Ready for user testing: \`npm install -g automagik-genie@next\`

**Recent RC History:**
- RC70-73: MCP bug fixes + version unification
- RC74-75: Port conflict detection + workflow fixes
- RC76: Takeover prompt + auto-sync automation

---

## 📊 Repository Health

**Branch Strategy:** dev → main (auto-synced after releases)

**Active Issues:**
- #344: Genie auto-exit bug (RESOLVED via PRs #344-349)
- #260: Routing optimization (analysis complete)

**CI/CD Status:**
- ✅ Unified Release workflow active
- ✅ Auto-sync workflow active (new!)
- ✅ Validate Package workflow active
- ✅ Pre-commit hooks (secrets, worktree, user files, cross-refs, tokens)
- ✅ Pre-push hooks (tests, commit advisory)

---

## 📁 Key File Locations

**Configuration:**
- .genie/cli/config.yaml - Framework config
- .genie/state/provider.json - Runtime provider selection
- .genie/state/version.json - Framework version (unified)
- package.json - npm package metadata

**Context Files:**
- .genie/STATE.md - This file (system state snapshot)
- .genie/USERCONTEXT.md - User preferences and patterns
- .genie/.session - Live Forge state (gitignored, auto-generated)

**Workflows:**
- .github/workflows/release.yml - Unified Release (RC bumps)
- .github/workflows/sync-dev-after-release.yml - Auto-sync dev ← main
- .github/workflows/validate.yml - Package validation

---

## 🧰 Tooling Status

**MCP Integration:**
- ✅ mcp__genie__run - Launch agent sessions
- ✅ mcp__genie__list_sessions - Discover sessions
- ✅ mcp__genie__view - Inspect output
- ✅ mcp__genie__list_agents - Discover agents (43+)
- ✅ mcp__genie__read_spell - Load spells dynamically
- ✅ mcp__genie__get_workspace_info - Load product docs

**CLI Commands:**
- ✅ genie - Start Genie (Forge + MCP)
- ✅ genie init - Initialize workspace
- ✅ genie update - Framework upgrade
- ✅ genie rollback - Restore backup
- ✅ genie talk <agent> - Interactive browser session
- ✅ genie run <agent> <prompt> - Headless JSON execution
- ✅ genie dashboard --live - Engagement dashboard
- ✅ genie mcp-cleanup - Cleanup stale MCP processes

---

## 🔄 Dev Sync Status

**Auto-Sync:** ✅ Active (workflow deployed)
**Last Manual Sync:** 2025-10-28 13:52 UTC
**Next Sync:** Automatic after RC77 release

**How It Works:**
1. Release workflow publishes RC to npm
2. Version bump committed to main
3. Auto-sync workflow triggers
4. Dev branch merges from main
5. All version files synchronized

---

**Note:** This file is READ-ONLY reference. Updated manually after significant changes.
**Last Updated:** 2025-10-28 (RC76 release + auto-sync deployment)
