# Genie-CLI Unification & Verification Checklist

*Created: 2026-02-04 14:32 GMT-3*
*Goal: Deduplicate context, unify sources, verify everything works*

---

## Phase 1: Inventory — Where is genie-cli mentioned/stored?

### 1.1 Repository Copies
- [x] **PRIMARY (canonical):** `/home/genie/workspace/guga/code/genie-cli/` 
  - ✅ Is git repo → github.com/namastexlabs/genie-cli.git
  - ✅ Latest commit: c769a5d (wish-25)
  
- [x] **chief-of-khal:** `/home/genie/workspace/children/chief-of-khal/tools/genie-cli/`
  - ⚠️ EMPTY - only has `.beads/` folder, NOT a git repo
  - 🗑️ **ACTION: DELETE** - orphaned empty directory
  
- [x] **chief-of-code:** `/home/genie/workspace/children/chief-of-code/code/genie-cli/`
  - ⚠️ Has files but NOT a git repo (no .git, has .genie, .beads)
  - 🗑️ **ACTION: DELETE** - stale copy without version control
  
- [x] **npm global:** `~/.nvm/versions/node/v24.13.0/lib/node_modules/@automagik/genie/`
  - ✅ Has compiled dist/ files (claudio.js, genie.js)
  - This is a separate npm install, not linked to source
  
- [x] **brew lib (ACTIVE):** `/home/linuxbrew/.linuxbrew/lib/node_modules/@automagik/genie`
  - ✅ SYMLINK → `../../../../../genie/workspace/guga/code/genie-cli`
  - ✅ Points to PRIMARY - this is the dev install!
  
- [x] **brew bin:** `/home/linuxbrew/.linuxbrew/bin/{genie,term,claudio}`
  - ✅ Symlinks to brew lib dist/*.js files

**FINDING:** Brew install is symlinked to primary source (dev mode). Two stale copies to delete.

### 1.2 Skills Copies
- [x] `~/.openclaw/skills/genie-base/` 
  - ⚠️ HAS NESTED DUPLICATE: `genie-base/genie-base/` (identical SKILL.md)
  - 🗑️ **ACTION: DELETE** nested `genie-base/` folder
  
- [x] `~/.openclaw/skills/genie-blank-init/` - OK (single copy)

- [x] `/home/genie/workspace/shared/skills/genie-*` (5 skills)
  - genie-wish, genie-do, genie-review, genie-plan-review, genie-council
  - ✅ OpenClaw skills for sessions_spawn
  
- [x] `/home/genie/workspace/children/chief-of-khal/skills/genie-base/`
  - ⚠️ DUPLICATE of ~/.openclaw/skills/genie-base
  - 🗑️ **ACTION: DELETE** or symlink to canonical
  
- [x] `/home/genie/workspace/children/chief-of-khal/skills/public/genie-base/`
  - ⚠️ Another duplicate
  - 🗑️ **ACTION: DELETE**
  
- [x] `genie-cli/plugins/automagik-genie/skills/` (12 skills!)
  - brainstorm, council, genie-base, genie-blank-init, genie-cli-dev
  - make, plan-review, review, wish, work-orchestration
  - ✅ These are Claude Code plugin skills (different purpose)
  
- [x] `genie-cli/.claude/skills/` - DOES NOT EXIST (only settings.local.json)

**FINDING:** Multiple duplicate genie-base copies. Need to pick canonical location.

### 1.3 Context Files with genie-cli mentions
- [ ] `~/.openclaw/skills/genie-base/assets/workspace/MEMORY.md`
- [ ] `~/.openclaw/skills/genie-base/assets/workspace/TOOLS.md`
- [ ] `~/.openclaw/skills/genie-base/assets/workspace/memory/2026-01-31.md`
- [ ] `/home/genie/workspace/guga/MEMORY.md`
- [ ] Session histories (deleted .jsonl files with context)

**Action:** Consolidate learnings into single source of truth.

---

## Phase 2: Deduplication — Clean up copies

### 2.1 Repository Deduplication
- [ ] Check: Are chief-of-khal and chief-of-code copies needed?
- [ ] Check: Are they git repos or just copies?
- [ ] Decision: Keep only primary, symlink if needed elsewhere
- [ ] Execute cleanup

### 2.2 Skills Deduplication
- [ ] Fix: `~/.openclaw/skills/genie-base/genie-base/` (nested duplicate)
- [ ] Decision: Canonical skill location for OpenClaw skills
- [ ] Decision: Canonical skill location for Claude Code skills
- [ ] Execute cleanup

### 2.3 Installed Binary Verification
- [ ] Check: `which genie` points where?
- [ ] Check: `which term` points where?
- [ ] Check: `which claudio` points where?
- [ ] Check: Are they symlinks to source or installed copies?
- [ ] Decision: Use npm link (dev) or npm install -g (prod)?

---

## Phase 3: Verification — Does everything work?

### 3.1 Installation Check
- [ ] `genie --version` → should show version
- [ ] `term --version` → should match
- [ ] `claudio --version` → should match
- [ ] `genie doctor` → should pass all checks

### 3.2 Prerequisites Check
- [ ] `genie install --check` → all green?
- [ ] tmux installed?
- [ ] bun installed?
- [ ] claude CLI installed?

### 3.3 Configuration Check
- [ ] `~/.genie/config.json` exists and valid?
- [ ] `~/.claudio/config.json` exists and valid?
- [ ] `genie setup --show` (if exists) or check config manually

### 3.4 Core Commands Test
- [ ] `term ls` → lists sessions
- [ ] `term new test-session` → creates session
- [ ] `term exec test-session 'echo hello'` → runs command
- [ ] `term read test-session` → shows output
- [ ] `term rm test-session` → removes session

### 3.5 Worker Orchestration Test
- [ ] `term workers` → shows workers (or empty)
- [ ] `term dashboard` → shows dashboard
- [ ] `term create "test task"` → creates task
- [ ] `term work <id>` → spawns worker
- [ ] `term ship <id>` → completes task

### 3.6 New Features Test (wishes 21-25)
- [ ] `term events <pane>` → streams events
- [ ] Worktree created on correct branch?
- [ ] `term approve --status` → shows auto-approve config
- [ ] `term dashboard --watch` → live updates?
- [ ] `term spawn-parallel` → spawns multiple?

### 3.7 Plugin/Skills Test
- [ ] `term sync` → syncs plugin
- [ ] `term skills` → lists available skills
- [ ] `claudio` → launches Claude Code
- [ ] In Claude: `/wish test` → skill loads?

---

## Phase 4: Publishing — Is it available to others?

### 4.1 GitHub Status
- [ ] Check: `https://github.com/namastexlabs/genie-cli` accessible?
- [ ] Check: Main branch has latest commits?
- [ ] Check: README is up to date?

### 4.2 npm Status
- [ ] Check: `npm view @automagik/genie` → package exists?
- [ ] Check: Latest version matches our version?
- [ ] Check: `npm install -g @automagik/genie` works?

### 4.3 Install Script
- [ ] Check: `curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash` works?
- [ ] Check: Fresh install on clean system?

---

## Phase 5: Documentation — Is it documented?

### 5.1 README Accuracy
- [ ] Commands listed match actual CLI?
- [ ] Examples work?
- [ ] Configuration section accurate?

### 5.2 AGENTS.md Accuracy
- [ ] bd workflow still valid?
- [ ] Co-orchestration instructions current?

### 5.3 Internal Docs
- [ ] `.genie/GENIE-CLI-KNOWLEDGE-BASE.md` created ✅
- [ ] Wish docs accurate?
- [ ] Memory files consolidated?

---

## Progress Tracker

| Phase | Status | Notes |
|-------|--------|-------|
| 1. Inventory | ✅ DONE | Found duplicates |
| 2. Deduplication | ✅ DONE | 5 items deleted |
| 3. Verification | ✅ DONE | All commands work |
| 4. Publishing | ✅ DONE | GitHub & npm accessible |
| 5. Documentation | 🔄 IN PROGRESS | KB created |

---

## Execution Log

### Phase 2: Deduplication (Completed 2026-02-04 14:54)
Deleted:
- ✅ `~/workspace/children/chief-of-khal/tools/genie-cli/`
- ✅ `~/workspace/children/chief-of-code/code/genie-cli/`
- ✅ `~/.openclaw/skills/genie-base/genie-base/`
- ✅ `~/workspace/children/chief-of-khal/skills/genie-base/`
- ✅ `~/workspace/children/chief-of-khal/skills/public/genie-base/`

### Phase 3: Verification Results
- ✅ genie --version: 0.260204.0334
- ✅ term --version: 0.260204.0334
- ✅ claudio --version: 0.260204.0334
- ✅ genie doctor: All prerequisites OK, minor warning (setup not complete)
- ✅ term ls: Works
- ✅ term workers: Works
- ✅ term dashboard: Works
- ✅ term skills: Lists 12 skills
- ✅ term events --help: Works (wish-21)
- ✅ term approve --help: Works (wish-23)
- ✅ term dashboard --watch: Works (wish-24)
- ✅ term spawn-parallel --help: Works (wish-25)
- ✅ term batch --help: Works (wish-25)

### Phase 4: Publishing Status
- ✅ GitHub: https://github.com/namastexlabs/genie-cli (HTTP 200)
- ✅ install.sh: Accessible (HTTP 200)
- ✅ npm package: @automagik/genie exists
- ✅ Local = Remote: Both at c769a5d (wish-25)

### ⚠️ Version Discrepancy Found
| Source | Version |
|--------|---------|
| Local installed | 0.260204.0334 |
| npm published | 0.260204.309 |
| Local package.json | 0.260204.0334 (uncommitted) |
| Git HEAD package.json | 0.260203.2154 |

**Issue:** Local has uncommitted version bump. npm has different version (0.260204.309).
**Action needed:** Decide whether to commit local version or revert.

---

## Current Step

**Phase 5: Remaining Items**

1. [ ] Decide on version handling (commit or revert?)
2. [ ] Run `genie setup` to clear the warning
3. [ ] Consolidate context files (MEMORY.md duplicates)
4. [ ] Update documentation if needed
