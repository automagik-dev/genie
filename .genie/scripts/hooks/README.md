# Genie Git Hooks System

**Purpose:** Enforce quality gates, traceability, and token efficiency at commit and push time.

**Architecture:** Centralized orchestrators (pre-commit, pre-push) call modular validation scripts.

---

## 📂 Hook Files (Symlinked from `.git/hooks/`)

### 1. `pre-commit.cjs`
**Trigger:** Before every `git commit`
**Purpose:** Fast validation before commit is created
**Exit Code:** 0 (pass) | 1 (fail)

**Execution Flow:**
```
1. Fast-path check (skip if only wish files changed)
2. Worktree validation (prevent editing Forge worktrees)
3. User file validation (no personal files committed)
4. Cross-reference validation (all @ references valid)
5. Forge task linking (auto-link wishes to Forge tasks)
6. QA migration (sync scenarios from GitHub issues)
7. Token counting (non-blocking, reports usage)
8. Quality gate (non-blocking, warns on bloat)
```

**Performance:**
- Fast-path: <50ms (wish-only commits)
- Full path: ~550ms (all validations)

**Environment Variables:**
- None (runs always)

**Files Called:**
- `validate-user-files-not-committed.cjs`
- `validate-cross-references.cjs`
- `forge-task-link.cjs`
- `prevent-worktree-access.sh` (bash)
- `migrate-qa-from-bugs.cjs`
- `token-efficiency/count-tokens.cjs`
- `token-efficiency/quality-gate.cjs`

---

### 2. `pre-push.cjs`
**Trigger:** Before every `git push`
**Purpose:** Comprehensive validation before code leaves local machine
**Exit Code:** 0 (pass) | 1 (warn) | 2 (block)

**Execution Flow:**
```
1. Auto-sync with remote (rebase if behind)
2. Run full test suite (genie-cli + session-service)
3. Commit advisory (traceability check)
4. Update changelog (non-blocking)
```

**Environment Variables:**
- `GENIE_SKIP_TESTS=1` - Skip test suite
- `GENIE_ALLOW_MAIN_PUSH=1` - Allow push to main without warnings
- `GENIE_SKIP_WISH_CHECK=1` - Skip wish traceability warnings
- `GENIE_SKIP_AUTO_SYNC=1` - Skip auto-rebase

---

## 🔍 Validation Scripts (Called by Hooks)

### `commit-advisory.cjs`
**Purpose:** Validate commit traceability and conventional commit types
**Hook:** pre-push
**Blocking:** YES (on main) | WARN (on feature branches)

**EXEMPT COMMIT TYPES** (no wish/issue required):
- `docs:` - Documentation updates
- `style:` - Formatting, whitespace
- `refactor:` - Code restructuring (no behavior change)
- `perf:` - Performance improvements
- `chore:` - Maintenance, dependencies, configs
- `build:` - Build system, CI/CD
- `test:` - Test-only changes
- `ci:` - CI/CD configuration

**FEATURE COMMIT TYPES** (require wish or GitHub issue):
- `feat:` - New features
- `fix:` - Bug fixes (MUST have GitHub issue)
- Untyped commits (treated as feature work)

---

See full documentation at `.genie/scripts/hooks/HOOKS_REFERENCE.md` (to be created with complete details).
