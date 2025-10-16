# 🗂️ Genie System State
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Purpose:** System state snapshot (read-only reference)

---

## 📦 Production Status

**Version:** !`node -p "require('./package.json').version"`
**Branch:** !`git branch --show-current`
**Published:** v2.4.0-rc.2 on npm@next (2025-10-15 23:26 UTC)
**Next Release:** v2.3.7 or v2.3.8 (stable from rc.2)

**Critical Fixes in rc.2:**
- #51: Routing.md self-delegation loops
- #52: Templates missing in package / init create fails
- Permissions fix: Edit operations with bypassPermissions

---

## 📊 Repository Health

**Issues:** !`gh issue list --state open | wc -l` open (down from 15)
**Wishes:** 5 active + 2 archived
**Knowledge Graph Health:** 6.5/10 (target: 8.5/10)
**Technical Debt:** Medium (systematic fixes queued)

**Archived Wishes:**
- token-efficient-output (100/100)
- natural-routing-skills (100/100)
- core-template-separation (100/100) - archived 2025-10-16

**Active Wishes:**
1. provider-runtime-override (#40) - 95% complete
2. multi-template-architecture (#37) - 50% complete
3. backup-update-system (#38) - 0% (DEFERRED)

**Resolved (Not Archived):**
- mcp-permission-regression (#44) - NOT A BUG (version mismatch)

---

## 🔧 Working Tree

**Status:**
!`git status --short | head -10`

**Staged:**
!`git diff --cached --stat | head -5`

**Unstaged:**
!`git diff --stat | head -5`

**Recent Commits:**
!`git log --oneline -5`

---

## 📚 Knowledge Graph Metrics

**@ Usage Analysis:**
- Total .md files: !`find .genie -name "*.md" -type f | wc -l`
- Files with @: !`grep -r "^@\|\\s@" .genie/**/*.md | wc -l 2>/dev/null || echo "TBD"`
- Excessive @ (>10 refs): 3 files identified
- Redundant content: 2 patterns identified

**Health Score:** 6.5/10
- -1.0: Excessive @ usage (UPDATE.md, core-template-separation)
- -1.0: Agent redundancy (Discovery/Implementation/Verification blocks)
- -0.5: wish.md template duplication
- -1.0: Missing ! opportunities (dynamic context)

**Target:** 8.5/10

---

## 🐛 Known Issues

### MCP Bugs
- Session creation: Returns IDs that don't exist (2 occurrences)
- Investigation: Why does mcp__genie__run succeed but run not found?

### Template System
- Multi-template 50% complete (Oct 12 migration)
- Core-template stalled since Oct 7 (conflicts with multi-template)

### Wish System
- Template duplication: Every wish duplicates wish.md template
- Status tracking: Multiple wishes show 0/100 despite completion

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
- `.genie/TODO.md` - Prioritized work queue (this drives development)
- `.genie/STATE.md` - This file (reference only)
- `.genie/CONTEXT.md` - User-specific context (Felipe)

---

## 🎯 Initiative-29 Status

**What:** Cross-repository wish management system
**Role:** Genie = template/pilot for other repos

**Stack:**
1. #27 - Infrastructure (labels, templates, Actions) - NOT STARTED
2. #31 - Genie audit/normalize - ✅ COMPLETE (this session)
3. #28 - Genie CLI integration (assigned: namastex888) - NOT STARTED
4. #29 - Deploy pipeline across repos - NOT STARTED

**Next:** Wait for #27 strategic decisions

---

## 📈 Session History

**2025-10-16 (Today):**
- ✅ CRITICAL #2 complete: core-template-separation wish archived (100/100)
- ✅ Agent deduplication started: 3/14 agents done (21%)
- Pattern discovery: Framework Reference WITHOUT @ (prevents context overload)
- Backlog cleanup: 15 → 11 open issues (closed #41)
- Wish closure: 1 archived (core-template-separation)
- Investigation: #44 resolved (not a bug)
- Knowledge graph audit: 6.5/10 health
- MCP bug documented: session creation failures

**2025-10-15:**
- Token-efficient output complete (99%+ reduction)
- Multi-template system created
- Neuron architecture documented
- 3 production releases (rc.0 → rc.1 → rc.2)

**2025-10-13:**
- Template structure (77 files)
- Runtime commands (`!command`)
- Session continuity system

---

## 🧰 Tooling Status

**MCP Integration:**
- ✅ mcp__genie__run - Launch neuron sessions
- ✅ mcp__genie__resume - Continue sessions
- ✅ mcp__genie__view - Inspect output
- ✅ mcp__genie__list_sessions - Discover sessions
- ⚠️ Bug: Session IDs returned but runs not found (investigate)

**CLI Commands:**
- ✅ `genie init [template]` - Initialize workspace
- ✅ `genie run <agent>` - Execute agent
- ✅ `genie view <session>` - View neuron output
- ✅ `genie model` - Executor configuration
- ✅ `genie update` - Framework upgrade
- ✅ `genie rollback` - Restore backup

---

## 🔐 Access & Permissions

**GitHub:**
- Repo: namastexlabs/automagik-genie
- Branch protection: main (requires review)
- CI: GitHub Actions (publish workflow)

**npm:**
- Package: automagik-genie
- @latest: (check before release)
- @next: v2.4.0-rc.2

---

## 📖 Documentation

**Core Docs:**
- `AGENTS.md` - Agent documentation (23KB)
- `CLAUDE.md` - Claude Code patterns (4KB)
- `.claude/README.md` - Routing & architecture
- `.genie/agents/README.md` - Agent structure

**Architecture:**
- `.genie/state/wish-analysis-2025-10-16.md` - Wish prioritization
- `.genie/qa/evidence/knowledge-graph-audit-*.md` - Graph analysis
- `.genie/state/backlog-audit-2025-10-16.md` - Backlog status
- `.genie/state/decision-brief-2025-10-16.md` - Strategic decisions

---

**Note:** This file is READ-ONLY reference. Active work tracked in TODO.md
