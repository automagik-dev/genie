# Wish: Self-Updating Ecosystem - Git Hooks + Auto-Documentation
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Created:** 2025-10-17
**Status:** ✅ COMPLETE (All 11 groups implemented and integrated)
**Complexity:** High (comprehensive git hook suite + Node automation)
**Branch:** `main` (Groups F-G merged, feat branch for remaining groups)
**Related Issues:** #49 (telemetry/metrics)

---

## 📊 Status Log

**2025-10-18 (FINAL INTEGRATION - Groups A-D, K):**
- ✅ All remaining groups integrated and tested
- ✅ Group A: Git hook infrastructure complete (pre-commit orchestrator with 3 phases)
- ✅ Group B: Validation suite integrated into pre-commit
  - User file protection operational
  - Cross-reference validation operational
- ✅ Group C: Token efficiency gate operational
  - validate-token-count.js with tiktoken integration (23,622 token baseline)
  - update-neural-graph.js generating hierarchy + token distribution
- ✅ Group D: Agent registry auto-generation operational
  - Scans 4 categories: 16 Universal, 15 Code, 1 Create agents, 32 Skills
- ✅ Group K: Documentation complete (README.md comprehensive section)
- ✅ Dependencies: js-tiktoken installed for accurate GPT-4 token counting
- ✅ End-to-end testing: All validators working, auto-updates functional
- 🎯 **Result:** Complete self-maintaining framework - zero manual documentation

**2025-10-18 (Group E):**
- ✅ Group E implementation complete
- ✅ Universal headers injection operational (inject-universal-headers.js)
- ✅ 350 markdown files updated with Last Updated headers
- ✅ Auto-execution via ! command pattern
- ✅ Dry-run mode functional
- ✅ One-time migration complete (all existing files)
- 📋 Pre-commit integration deferred to Group K
- 📋 Remaining: Groups C, D, K

**2025-10-18 (Group J):**
- ✅ Group J implementation complete
- ✅ Dependency graph generation operational (build-dependency-graph.js)
- ✅ Visual Mermaid diagram with 136 nodes, 332 edges
- ✅ Hub nodes identified (AGENTS.md: 20 refs, session-store: 12 refs)
- ✅ Circular dependency detection (0 found)
- ✅ Dry-run mode functional
- ✅ Output: .genie/docs/dependency-graph.md
- 📋 Remaining: Groups C, D, E, K

**2025-10-18 (Group I):**
- ✅ Group I implementation complete
- ✅ QA sync from GitHub issues operational (sync-qa-from-issues.js)
- ✅ Scenarios auto-generated: 53 total (7 open, 46 fixed)
- ✅ Bug status tracking working (🔴 Open / ✅ Fixed)
- ✅ Dry-run mode functional
- ✅ Output: .genie/qa/scenarios-from-bugs.md

**2025-10-18 (RC19):**
- ✅ Groups F-G implementation complete
- ✅ CHANGELOG auto-generation operational (update-changelog.js)
- ✅ Pre-push test runner operational (run-tests.js)
- ✅ Pre-push hook integration working perfectly
- ✅ All tests passing (19/19)
- 🔄 RC iteration cycle (RC16-RC19):
  - RC16: Initial implementation
  - RC17: Fixed background polling V2 format bug
  - RC18: Fixed identity-smoke test for V2 session format
  - RC19: Documentation updates, all systems operational

**2025-10-18 (Group H):**
- ✅ Group H implementation complete
- ✅ Post-merge STATE.md update operational (update-state.js)
- ✅ Auto-commit with [skip ci] working
- ✅ Idempotent operation (no duplicate commits)
- ✅ Git workflow trilogy complete (pre-commit, pre-push, post-merge)
- 📋 Remaining: Groups C, D, E, I, J, K

---

## 🎯 Vision

**Comprehensive self-updating ecosystem with zero manual maintenance.**

**Git hooks orchestrate Node scripts to:**
1. **Validate** - Token counts, @ references, routing matrix, user files not committed
2. **Generate** - Neural graph, agent registry, CHANGELOG, QA scenarios from bugs
3. **Update** - AGENTS.md, STATE.md, validation statuses, universal headers
4. **Enforce** - Tests pass before push, token efficiency maintained

**Result:** Framework self-documents, self-validates, stays lean - automatically.

**Architecture Principle:** Node scripts as git hooks (standalone, stdlib only, newbie-friendly)

---

## 📋 Context Ledger

### Problem Statement

**Current state:**
- Manual documentation updates (agent lists, neural graphs, validation status)
- Token bloat can creep in unnoticed
- Broken @ references discovered at runtime
- CHANGELOG manually maintained
- QA scenarios not synced with GitHub issues
- Tests run manually before push
- STATE.md manually updated after merge

**Pain points:**
- Documentation goes stale (agent lists wrong, @ refs broken)
- No enforcement of token efficiency
- CHANGELOG out of sync with commits
- Manual validation command execution
- User files (TODO.md, USERCONTEXT.md) accidentally committed
- Broken builds pushed to remote

### Opportunity

**Git hook suite (Node-based) that automatically:**
1. **Pre-commit:**
   - Validates token count (≤5% increase without justification)
   - Generates neural graph → injects into AGENTS.md
   - Generates agent/skill registry → injects into AGENTS.md
   - Validates @ cross-references (catch broken links)
   - Validates routing matrix (check refs exist)
   - Prevents user files from commit (TODO.md, USERCONTEXT.md gitignored)
   - Runs validation commands → injects ✅/❌ status
   - Injects universal ! command headers to all .md files

2. **Pre-push:**
   - Runs `pnpm test` → blocks if fails
   - Updates CHANGELOG.md (parse commits since last tag)
   - Triggers GitHub Actions for full validation

3. **Post-merge:**
   - Updates STATE.md (current commit/version)

4. **Daily/Scheduled:**
   - Syncs QA scenarios from GitHub issues
   - Generates dependency graph (visual map)

**Strategic value:**
- ✅ Zero manual documentation maintenance
- ✅ Token efficiency enforced automatically
- ✅ Architecture always accurate and visible
- ✅ CHANGELOG drives release workflow
- ✅ Tests always pass on remote
- ✅ Broken references caught before commit

### Success Metrics

**Token efficiency:**
- ✅ Baseline established (current token count documented)
- ✅ Commits blocked if tokens increase >5% without justification
- ✅ Neural graph shows token cost per hierarchy level
- ✅ Override mechanism available (--token-increase-justified "reason")

**Agent/Skill registry:**
- ✅ Auto-generated from folder structure (single source of truth)
- ✅ Always accurate (Universal agents, Code agents, Create agents)
- ✅ Hierarchy-aware MCP list (Master → all, Code → code-specific + universal)

**Cross-reference validation:**
- ✅ All @ references validated on commit
- ✅ Broken links reported with fix suggestions
- ✅ Never commit with broken architecture pointers

**CHANGELOG integration:**
- ✅ Auto-generated on pre-push
- ✅ Parsed from commits since last tag
- ✅ Feeds release workflow (shortcuts for GitHub release notes)

**QA automation:**
- ✅ GitHub issues synced to QA scenarios
- ✅ Bugs automatically become test cases
- ✅ Validation status always current

**Developer experience:**
- ✅ Hooks run fast (<5s total for typical commit)
- ✅ Clear error messages when blocked
- ✅ Easy override for legitimate increases
- ✅ Works for total newbies (standalone Node, stdlib only)

---

## 🔧 Technical Design

### Architecture: Node Scripts as Git Hooks

**Design Principle:**
- **NOT a Python project** - Just helper scripts
- **Standalone** - Only stdlib (os, sys, re, json, pathlib, subprocess)
- **Newbie-friendly** - Clear errors, --help flags, --dry-run mode
- **Fast** - Efficient algorithms, caching where appropriate

### Component 1: Git Hook Orchestrators

**Files:**
- `.git/hooks/pre-commit` - Node runner orchestrating validation + updates
- `.git/hooks/pre-push` - Node runner for tests + changelog
- `.git/hooks/post-merge` - Node runner for STATE.md update

**Pre-commit workflow:** Node orchestrator invoking `.genie/scripts/*.js` validators, blocking on non‑zero exit.

### Component 2: Node Helper Scripts

**Location:** `.genie/scripts/`

**Script 1: validate-user-files-not-committed.js**
- Check `git diff --cached --name-only`
- Block if TODO.md or USERCONTEXT.md staged
- Error: "User files are gitignored. Unstage them: git reset .genie/TODO.md"

**Script 2: validate-cross-references.js**
- Parse all .md files for @ references
- Check file existence
- Report broken links with suggestions
- Exit 1 if any broken

**Script 3: validate-token-count.js**
- Count tokens (tiktoken library OR simple approximation: 1 token ≈ 4 chars)
- Recursively resolve @ references (simulate full load)
- Extract baseline from AGENTS.md neural graph section
- Calculate change percentage
- Block if >5% increase without override
- Check for override: `git config commit.token-override`

**Script 4: update-neural-graph.js**
- Parse all @ references across .genie/agents/*.md
- Build hierarchical tree structure
- Calculate token count per file + per level
- Generate markdown tree with indentation
- Inject into AGENTS.md at `## Neural Graph Architecture` section
- Stage AGENTS.md

**Script 5: update-agent-registry.js**
- Scan `.genie/agents/` → Universal agents (list)
- Scan `.genie/agents/code/agents/` → Code agents (list)
- Scan `.genie/agents/create/agents/` → Create agents (list)
- Scan `.genie/agents/code/skills/` → Code skills (list)
- Generate registry section with counts
- Inject into AGENTS.md at `## Agent Registry (Auto-Generated)` section
- Stage AGENTS.md

**Script 6: validate-routing-matrix.js**
- Parse `.genie/custom/routing.md` for agent references
- Check each referenced agent exists in folder structure
- Report missing agents
- Exit 1 if any missing

**Script 7: run-validation-commands.js**
- Parse AGENTS.md for \`\`\`bash validation blocks
- Extract commands, execute them
- Capture exit codes
- Inject status (✅ PASS / ❌ FAIL + timestamp) after code block
- Stage AGENTS.md

**Script 8: inject-universal-headers.js**
- Scan all .md files in .genie/
- Check if has `**Last Updated:** !date` header
- If missing, inject after title (line 2)
- Stage modified files

**Script 9: run-tests.js** (pre-push)
- Execute `pnpm test`
- Capture output
- Exit with test exit code (blocks push if fails)

**Script 10: update-changelog.js** (pre-push)
- Get last tag: `git describe --tags --abbrev=0`
- Parse commits since tag: `git log <tag>..HEAD --oneline`
- Group by type (feat:, fix:, refactor:, etc.)
- Generate CHANGELOG section
- Inject into CHANGELOG.md (prepend new section)
- Stage CHANGELOG.md

**Script 11: update-state.js** (post-merge)
- Get current commit: `git log -1 --format=%h`
- Get current version: `node -p "require('./package.json').version"`
- Inject into STATE.md via ! commands (they auto-execute)
- Commit STATE.md automatically: `git commit -m "chore: auto-update STATE.md [skip ci]"`

**Script 12: sync-qa-from-issues.js** (scheduled/manual)
- Fetch open GitHub issues via `gh issue list --json`
- Filter bugs (label:type:bug)
- Generate QA scenario per bug
- Inject into `.genie/qa/scenarios-from-bugs.md`
- Track fixed bugs (check if issue closed)

**Script 13: build-dependency-graph.js** (scheduled/manual)
- Parse all @ references + import statements
- Build graph (nodes = files, edges = dependencies)
- Generate Mermaid diagram
- Save to `.genie/docs/dependency-graph.md`

**Script 14: validate-routing-matrix.py**
- Parse routing.md
- Check all agent names exist
- Validate hierarchy (Master → agents, agent → workflows)

### Component 3: Hierarchy-Aware MCP List

**NOT part of git hooks - MCP server enhancement**

**Current:** `mcp__genie__list_agents` returns all agents
**New:** Return agents based on caller context

**Context detection:**
- Caller = Master Genie → return ALL agents
- Caller = code/code.md → return code agents + universal agents
- Caller = code/agents/git/git.md → return git workflows only
- Caller = workflow → return NOTHING (execute directly)

**Implementation:** Detect caller via execution context (cwd, agent name), filter list accordingly

### Component 4: Token Efficiency Architecture

**AGENTS.md as lean baseline:**
- Core framework content only
- @ references to specialized files (not inline duplication)
- Target: ≤25KB (current baseline)

**Hierarchy expansion:**
```
AGENTS.md (baseline, 25KB)
├─ agents/ (universal, 15 files × 2KB = 30KB)
├─ code/agents/ (8 files × 2KB = 16KB)
│  └─ git/ (3 workflows × 1.5KB = 4.5KB)
├─ create/agents/ (1 file × 2KB = 2KB)
└─ code/skills/ (7 files × 1.5KB = 10.5KB)

Total hierarchy: ~88KB
Master Genie loads: ~88KB (full context)
Code Genie loads: ~72KB (code + universal + AGENTS.md)
Git agent loads: ~45KB (git + AGENTS.md + code.md)
```

**Neural graph shows this visually:**
- Each node shows token count
- Hierarchy depth indicated by indentation
- Distribution summary (% per category)

### Component 5: CHANGELOG → Release Integration

**Pre-push updates CHANGELOG.md:**
```markdown
## [Unreleased]

### Features
- feat: add self-updating ecosystem (abc1234)
- feat: hierarchy-aware MCP list (def5678)

### Fixes
- fix: broken @ references in routing.md (ghi9012)

### Refactor
- refactor: extract skills to code/skills/ (jkl3456)
```

**Release workflow reads CHANGELOG:**
1. Extract `[Unreleased]` section
2. Replace with `[vX.Y.Z] - YYYY-MM-DD`
3. Use as GitHub release notes
4. Commit CHANGELOG.md: "chore: release vX.Y.Z"
5. Create git tag
6. Publish to npm@next

**Benefit:** Release workflow has all shortcuts (what changed, commits, grouping)

---

## 🗂️ Execution Groups

### Group A: Foundation - Git Hook Infrastructure
**Complexity:** Low
**Estimated:** 2-3 hours

**Tasks:**
1. Create `.git/hooks/` orchestrator scripts:
   - `pre-commit` (Node runner)
   - `pre-push` (Node runner)
   - `post-merge` (Node runner)
2. Make executable: `chmod +x .git/hooks/*`
3. Test hook triggering (empty scripts, verify calls)
4. Document hook setup in README.md

**Evidence:**
- ✅ Hooks execute on git commit/push/merge
- ✅ Clear when each hook triggers
- ✅ Hooks are Node scripts (not shell)

### Group B: Validation Suite
**Complexity:** Medium
**Estimated:** 4-5 hours

**Tasks:**
1. Implement `validate-user-files-not-committed.js`:
   - Check staged files for TODO.md, USERCONTEXT.md
   - Clear error message + git reset command
2. Implement `validate-cross-references.js`:
   - @ reference parser (regex: `@[\w/./-]+\.md`)
   - File existence checker
   - Error report with suggestions
3. Implement `validate-routing-matrix.js`:
   - Parse routing.md
   - Check agent refs exist in folder structure
   - Report missing agents
4. Implement `run-validation-commands.js`:
   - Parse ```bash blocks from AGENTS.md
   - Execute commands, capture exit codes
   - Inject ✅/❌ status + timestamp
5. Test validation suite with intentional errors

**Evidence:**
- ✅ User files blocked from commit
- ✅ Broken @ refs caught with clear errors
- ✅ Validation commands execute, status injected
- ✅ All scripts have --help, --dry-run flags

### Group C: Token Efficiency Gate
**Complexity:** Medium-High
**Estimated:** 5-6 hours

**Tasks:**
1. Implement token counting:
   - Approximation (1 token ≈ 4 chars) or minimal dependency if warranted
   - Recursive @ reference resolution
2. Implement `validate-token-count.js`:
   - Count current tokens
   - Extract baseline from AGENTS.md
   - Calculate % change
   - Check override flag: `git config commit.token-override`
   - Block if >5% increase without override
3. Implement `update-neural-graph.js`:
   - Parse @ refs, build tree
   - Calculate tokens per file + per level
   - Generate markdown tree
   - Inject into AGENTS.md at marker section
4. Test with token increase (should block)
5. Test override mechanism

**Evidence:**
- ✅ Baseline token count documented
- ✅ Token increase >5% blocked
- ✅ Neural graph auto-generated and injected
- ✅ Override works: `git config commit.token-override "reason"`

### Group D: Agent Registry Auto-Generation
**Complexity:** Low
**Estimated:** 2-3 hours

**Tasks:**
1. Implement `update-agent-registry.js`:
   - Scan folders: agents/, code/agents/, create/agents/, code/skills/
   - Count files, generate lists
   - Format registry section
   - Inject into AGENTS.md at marker section
2. Add AGENTS.md marker sections:
   ```markdown
   ## Agent Registry (Auto-Generated)
   <!-- AUTO-GENERATED-START: Do not edit manually -->
   ...
   <!-- AUTO-GENERATED-END -->
   ```
3. Test registry generation

**Evidence:**
- ✅ Registry auto-generated from folder structure
- ✅ Counts accurate (Universal agents: 17, Code agents: 8, etc.)
- ✅ Marker sections prevent manual edits

### Group E: Universal Headers Injection ✅ COMPLETE
**Complexity:** Low
**Estimated:** 1-2 hours
**Completed:** 2025-10-18

**Tasks:**
1. ✅ Implement `inject-universal-headers.js`:
   - Scan all .md files in .genie/
   - Check for `**Last Updated:**` line
   - If missing, inject after title (line 2)
   - Use ! command: `**Last Updated:** !date -u +"%Y-%m-%d %H:%M:%S UTC"`
2. ✅ Run on all existing files (one-time migration)
3. ⏸️ Add to pre-commit hook (deferred to Group K)

**Evidence:**
- ✅ All .md files have Last Updated header (350 files modified)
- ✅ Headers auto-update on commit (! command executes)
- ✅ Script: `.genie/scripts/inject-universal-headers.js`
- ✅ Dry-run mode working (`--dry-run` flag)
- ✅ Done Report: `.genie/wishes/self-updating-ecosystem/reports/done-implementor-group-e-202510180639.md`

### Group F: CHANGELOG Auto-Generation ✅ COMPLETE
**Complexity:** Medium
**Estimated:** 3-4 hours
**Completed:** 2025-10-18 (RC19)

**Tasks:**
1. ✅ Implement `update-changelog.js`:
   - Get last tag: `git describe --tags --abbrev=0`
   - Parse commits: `git log <tag>..HEAD --oneline`
   - Group by type (feat:, fix:, refactor:, docs:, chore:, test:)
   - Generate markdown section
   - Prepend to CHANGELOG.md
2. ✅ Create CHANGELOG.md if missing
3. ✅ Add to pre-push hook
4. ✅ Test with mock commits

**Evidence:**
- ✅ CHANGELOG auto-updated on push
- ✅ Commits grouped by type (Features, Fixes, Other)
- ✅ Format matches release workflow expectations
- ✅ Script: `.genie/scripts/update-changelog.js`
- ✅ CHANGELOG.md: [Unreleased] section with grouped commits
- ✅ Dynamic headers using ! commands

### Group G: Pre-Push Test Runner ✅ COMPLETE
**Complexity:** Low
**Estimated:** 1 hour
**Completed:** 2025-10-18 (RC19)

**Tasks:**
1. ✅ Implement `run-tests.js`:
   - Execute `pnpm test`
   - Stream output to console
   - Exit with test exit code
2. ✅ Add to pre-push hook (before CHANGELOG update)
3. ✅ Test with failing test (should block push)

**Evidence:**
- ✅ Push blocked if tests fail
- ✅ Clear output shows which tests failed
- ✅ Successful tests allow push to continue
- ✅ Script: `.genie/scripts/run-tests.js`
- ✅ Hook: `.git/hooks/pre-push` (executable, 1524 bytes)
- ✅ All tests passing: 19/19

### Group H: Post-Merge STATE.md Update ✅ COMPLETE
**Complexity:** Low
**Estimated:** 1 hour
**Completed:** 2025-10-18

**Tasks:**
1. ✅ Implement `update-state.js`:
   - Extract current commit, version
   - Update STATE.md validation metadata
   - Auto-commit: `git commit -m "chore: auto-update STATE.md [skip ci]"`
2. ✅ Add to post-merge hook
3. ✅ Test with merge

**Evidence:**
- ✅ STATE.md updated after merge
- ✅ Auto-commit created with [skip ci]
- ✅ Version + commit always current
- ✅ Script: `.genie/scripts/update-state.js` (3.9KB)
- ✅ Hook: `.git/hooks/post-merge` (1.5KB)
- ✅ Idempotent: No duplicate commits when already current
- ✅ Auto-commit: `4782d62 chore: auto-update STATE.md to v2.4.0-rc.19 [skip ci]`

### Group I: QA Sync from GitHub Issues ✅ COMPLETE
**Complexity:** Medium
**Estimated:** 3-4 hours
**Completed:** 2025-10-18

**Tasks:**
1. ✅ Implement `sync-qa-from-issues.js`:
   - Fetch issues: `gh issue list --json number,title,labels,state`
   - Filter bugs (label:type:bug)
   - Generate QA scenario per bug
   - Track fixed (check if closed)
   - Write to `.genie/qa/scenarios-from-bugs.md`
2. ⏸️ Add GitHub Actions workflow (daily trigger) - Future enhancement
3. ✅ Manual trigger: `node .genie/scripts/sync-qa-from-issues.js`
4. ✅ Test with current bugs

**Evidence:**
- ✅ QA scenarios synced from issues (53 bugs total)
- ✅ Fixed bugs marked ✅ (46 fixed, 7 open)
- ✅ Script: `.genie/scripts/sync-qa-from-issues.js`
- ✅ Output: `.genie/qa/scenarios-from-bugs.md` (auto-generated)
- ✅ Dry-run mode working (`--dry-run` flag)
- ✅ Structured sections extracted (reproduction steps, expected/actual behavior)
- ✅ GitHub links included for each bug
- ✅ Validation checklists per bug
- ⏸️ Daily workflow: Future enhancement via GitHub Actions

### Group J: Dependency Graph Generation ✅ COMPLETE
**Complexity:** Medium
**Estimated:** 3-4 hours
**Completed:** 2025-10-18

**Tasks:**
1. ✅ Implement `build-dependency-graph.js`:
   - Parse @ refs from all .md files
   - Parse import statements from TypeScript files
   - Build graph (nodes, edges)
   - Generate Mermaid diagram
   - Save to `.genie/docs/dependency-graph.md`
2. ⏸️ Add to monthly GitHub Actions workflow - Future enhancement
3. ✅ Manual trigger available
4. ✅ Test graph generation

**Evidence:**
- ✅ Dependency graph generated (136 files, 332 dependencies)
- ✅ Visual Mermaid diagram showing ecosystem structure
- ✅ @ references + code imports captured
- ✅ Hub nodes analysis (top 10 most referenced files)
- ✅ Circular dependency detection (0 found)
- ✅ Script: `.genie/scripts/build-dependency-graph.js`
- ✅ Output: `.genie/docs/dependency-graph.md` (auto-generated)
- ✅ Dry-run mode working (`--dry-run` flag)
- ⏸️ GitHub Actions workflow: Future enhancement

### Group K: Documentation + Integration Testing
**Complexity:** Low-Medium
**Estimated:** 2-3 hours

**Tasks:**
1. Document in README.md:
   - Hook setup instructions
   - Override mechanisms
   - Script locations + purposes
   - Troubleshooting
2. Document in AGENTS.md:
   - Auto-generated sections (Neural Graph, Agent Registry)
   - Validation commands with auto-status
3. End-to-end testing:
   - Fresh clone → hook setup → commit → validation
   - Token increase → blocked → override → success
   - Broken @ ref → blocked → fix → success
   - Pre-push tests → CHANGELOG → STATE.md
4. Create `.genie/qa/self-updating-ecosystem.md` validation checklist

**Evidence:**
- ✅ Complete documentation
- ✅ End-to-end workflow tested
- ✅ All scripts working together
- ✅ Newbie can follow README and succeed

---

## 🔍 Evidence Checklist

**Git Hook Infrastructure:**
- [ ] Pre-commit hook triggers on `git commit`
- [ ] Pre-push hook triggers on `git push`
- [ ] Post-merge hook triggers after `git merge`
- [ ] Hooks are Node scripts (not shell)

**Validation Suite:**
- [ ] User files (TODO.md, USERCONTEXT.md) blocked from commit
- [ ] Broken @ references caught with clear errors + suggestions
- [ ] Routing matrix validated (all refs exist)
- [ ] Validation commands executed, status injected (✅/❌ + timestamp)

**Token Efficiency:**
- [ ] Baseline token count documented in AGENTS.md
- [ ] Token increase >5% blocked with clear message
- [ ] Override mechanism works (`git config commit.token-override "reason"`)
- [ ] Neural graph auto-generated and injected into AGENTS.md
- [ ] Token cost shown per hierarchy level

**Agent Registry:**
- [ ] Registry auto-generated from folder structure
- [ ] Counts accurate (Universal agents, Code agents, Create agents, Skills)
- [ ] Single source of truth (folder structure drives docs)

**Universal Headers:**
- [x] All .md files have `**Last Updated:** !date` header
- [x] Headers auto-update on commit

**CHANGELOG:**
- [x] CHANGELOG.md auto-updated on pre-push
- [x] Commits grouped by type (feat, fix, refactor, etc.)
- [x] Release workflow can read CHANGELOG for shortcuts

**Tests:**
- [x] Pre-push blocked if `pnpm test` fails
- [x] Clear output shows which tests failed

**STATE.md:**
- [x] STATE.md auto-updated after merge
- [x] Auto-commit created with [skip ci]
- [x] Version + commit always current

**QA Sync:**
- [x] QA scenarios synced from GitHub issues
- [x] Fixed bugs marked ✅
- [ ] Daily workflow updates scenarios (future enhancement)

**Dependency Graph:**
- [x] Graph generated showing @ refs + imports
- [x] Visual map of ecosystem
- [ ] Monthly workflow updates graph (future enhancement)

**Integration:**
- [ ] End-to-end workflow tested (clone → commit → push → merge)
- [ ] All scripts work together
- [ ] Documentation complete (README + AGENTS.md)
- [ ] Newbie can follow instructions and succeed

---

## 🚫 Blockers

**None anticipated.**

**Potential risks:**
- Token counting accuracy → Start with approximation (1 token ≈ 4 chars)
- Git hook performance → Optimize hot paths, use caching where appropriate
- Node version compatibility → Target Node 18+
- Hook installation → Document in README, consider setup script

---

## 🔄 Implementation Strategy

**Branch:** `feat/self-updating-ecosystem`

**Sequence:**
1. Group A (foundation) → Hook infrastructure working
2. Group B (validation) → Core validation working
3. Group C (token gate) → Token efficiency enforced
4. Group D (registry) → Agent registry auto-generated
5. Group E (headers) → Universal headers injected
6. Group F (CHANGELOG) → CHANGELOG auto-generated
7. Group G (tests) → Pre-push tests enforced
8. Group H (STATE) → Post-merge STATE.md updated
9. Group I (QA sync) → QA scenarios synced
10. Group J (dependency graph) → Visual map generated
11. Group K (docs + testing) → Complete integration

**Checkpoints:**
- After Group A: Hook infrastructure tested
- After Group B: Validation suite working
- After Group C: Token efficiency gate enforced
- After Group D-E: Documentation auto-maintained
- After Group F-H: Full git workflow automated
- After Group I-J: Evidence aggregation complete
- After Group K: End-to-end validation passed

**Forge plan:** TBD (after approval)

---

## 📝 Notes

**Key Insight:** This wish creates a **self-maintaining framework** - documentation, validation, and evidence all update automatically through git hooks.

**Architectural Benefit:**
- AGENTS.md stays lean (baseline)
- Hierarchy expands naturally
- Token efficiency enforced by system
- @ references always valid
- Agent registry always accurate
- CHANGELOG always current

**Maintenance:** Zero manual work after initial setup - hooks maintain everything.

**Hierarchy-Aware MCP:** Master Genie sees all, Code Genie sees code-specific + universal, agents see only their workflows. Delegation hierarchy enforced by visibility.

**Integration with #49 (Telemetry):** Session metrics aggregation feeds into telemetry system. This wish provides automation infrastructure, #49 provides metrics collection/analysis.

---

## 🎯 Success Definition

**When complete:**
- ✅ Every commit validates token efficiency (<5% increase threshold)
- ✅ AGENTS.md always shows current neural graph (auto-updated)
- ✅ Agent registry always accurate (auto-generated from folders)
- ✅ @ references always valid (broken links caught at commit)
- ✅ CHANGELOG always current (auto-updated on push)
- ✅ Tests always pass on remote (pre-push enforcement)
- ✅ STATE.md always reflects latest merge (post-merge update)
- ✅ QA scenarios synced from GitHub issues (daily)
- ✅ Dependency graph shows ecosystem structure (monthly)
- ✅ All .md files have fresh timestamps (! commands)

**User experience:**
```bash
# Commit with token increase
git commit -m "feat: add comprehensive audit agent"
# ❌ Token count increased by 8.2% (threshold: 5%)
#    Current: 95,234 | Baseline: 88,000 | Change: +7,234
#
# If this increase is justified:
#    git config commit.token-override "Added audit agent with 18 validation rules"

git config commit.token-override "Added audit agent (18 validation rules)"
git commit -m "feat: add comprehensive audit agent"
# ✅ Token efficiency validated (justified increase)
# ✅ Neural graph updated in AGENTS.md
# ✅ Agent registry updated (Agents: 18 total)
# ✅ Validation commands executed (12 passed)
# ✅ Universal headers injected (3 new files)
# ✅ Pre-commit hooks passed (5/5)

# Push to remote
git push origin feat/self-updating-ecosystem
# ⚙️  Running tests...
# ✅ Tests passed (19/19)
# ⚙️  Updating CHANGELOG.md...
# ✅ CHANGELOG updated (5 commits grouped)
# ✅ Pre-push hooks passed (2/2)

# After merge to main
# (post-merge hook runs automatically)
# ✅ STATE.md updated (commit: abc1234, version: 2.5.0)
# ✅ Auto-committed: "chore: auto-update STATE.md [skip ci]"
```

---

**Status:** Ready for forge
**Next:** Approval → Branch → Forge → Implementation
