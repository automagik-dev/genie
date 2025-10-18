<!--
Triad Validation Metadata
last_updated: !`date -u +"%Y-%m-%dT%H:%M:%SZ"`
last_commit: !`git log -1 --format=%h`
last_version: 2.4.0-rc.20
validation_commands:
  version_exists: test -f package.json && jq -e .version package.json >/dev/null
  state_updated_recently: test $(git log --oneline .genie/STATE.md..HEAD 2>/dev/null | wc -l) -lt 5
  has_version_line: grep -q "Version:" .genie/STATE.md
-->

# 🗂️ Genie System State
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Purpose:** System state snapshot (read-only reference)

---

## 📊 Current Session

**Date:** 2025-10-18
**Focus:** RC21 Hotfix Cycle – Session lifecycle + background polling
**Branch:** !`git branch --show-current`

**Completed Work:**
- ✅ RC20 published (v2.4.0-rc.20) - Bug #4 UUID keys + name field fix
- ✅ RC20 comprehensive QA testing initiated
- 🚨 CRITICAL BUG FOUND: Bug #102 regression (duplicate sessions)
- ✅ Root cause identified: background-launcher.ts V1/V2 format mismatch
- ✅ QA failure report documented: .genie/reports/rc20-qa-failure-20251018.md
- ⏸️ RC20 deployment halted pending fix

---

## 📦 Production Status

**Version:** !`node -p "require('./package.json').version"`
**Published:** v2.4.0-rc.21 on npm@next (2025-10-18)
**Status:** 🎉 RC21 released – publish complete

**Latest Commit:** !`git log --oneline -1`

**RC20/RC21 Status:**
- ✅ Bug #4 fix implemented (UUID keys + name field)
- ❌ RC20 regression: Duplicate sessions + background polling timeout
- 🔎 Root cause: background-launcher.ts V1/V2 mismatch (agents vs sessions)
- 🔧 Fixes applied for RC21:
  - background-launcher.ts: poll sessions[entry.sessionId]
  - background-manager.ts: add INTERNAL_SESSION_ID_ENV
  - commands/run.ts + cli-core/handlers/run.ts: reuse propagated sessionId (no duplicates)
  - background-launcher.ts: CLI hints use `npx automagik-genie` (no ./genie)
- 🧪 Local + MCP validation: 1 session per run, fast session ID discovery (~0.5s), no timeout
  - Evidence: `.genie/wishes/rc21-session-lifecycle-fix/qa/group-b/`
  - Report: `.genie/wishes/rc21-session-lifecycle-fix/reports/done-group-b-20251018.md`
  - Tag: v2.4.0-rc.21 (pushed)
- 📊 Report: .genie/reports/rc20-qa-failure-20251018.md

**Previous RC Fixes:**
- RC19: Post-merge STATE.md auto-update hook
- RC16-18: Session collision + fragmentation fixes
- RC15: 305 broken @ references fixed
- RC9-13: MCP bugs + full transcript fix

---

## 🔧 Working Tree

**Status:**
!`git status --short | head -10`

**Recent Commits:**
!`git log --oneline -5`

---

## 📊 Repository Health

**Issues:** !`gh issue list --state open | wc -l` open
**Wishes:** 5 active + 2 archived
**Technical Debt:** Medium (systematic fixes queued)

**Archived Wishes:**
- token-efficient-output (100/100)
- natural-routing-skills (100/100)
- core-template-separation (100/100)

**Active Wishes:**
1. triad-redesign (0/100) - in progress
2. provider-runtime-override (#40) - 95% complete
3. multi-template-architecture (#37) - 50% complete
4. backup-update-system (#38) - 0% (DEFERRED)

---

## 📁 Key File Locations

**Configuration:**
- `.genie/cli/config.yaml` - Framework config
- `.genie/state/provider.json` - Runtime provider selection
- `.genie/state/version.json` - Framework version
- `package.json` - npm package metadata

**Evidence:**
- `.genie/qa/evidence/` - Knowledge graph audit data
- `.genie/state/` - Analysis reports, audit findings
- `.genie/wishes/*/qa/` - Per-wish validation data
- `.genie/wishes/*/reports/` - Per-wish done reports

**Active Work:**
- `.genie/TODO.md` - Prioritized work queue (drives development)
- `.genie/STATE.md` - This file (current session snapshot)
- `.genie/USERCONTEXT.md` - User-specific preferences

---

## 🧰 Tooling Status

**MCP Integration:**
- ✅ mcp__genie__run - Launch neuron sessions
- ✅ mcp__genie__resume - Continue sessions
- ✅ mcp__genie__view - Inspect output
- ✅ mcp__genie__list_sessions - Discover sessions

**CLI Commands:**
- ✅ `npx automagik-genie init [template]` - Initialize workspace
- ✅ `npx automagik-genie update` - Framework upgrade
- ✅ `npx automagik-genie rollback` - Restore backup
- ✅ `npx automagik-genie model` - Executor configuration

---

## 📖 Documentation

**Core Docs:**
- `AGENTS.md` - Agent documentation (23KB)
- `CLAUDE.md` - Claude Code patterns (4KB)
- `` - Routing & architecture
- `.genie/agents/README.md` - Agent structure

---

**Note:** This file is READ-ONLY reference. Active work tracked in TODO.md
