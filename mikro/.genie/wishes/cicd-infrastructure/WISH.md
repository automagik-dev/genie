# Wish: CI/CD Infrastructure for rlmx

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `cicd-infrastructure` |
| **Date** | 2026-03-29 |
| **Design** | N/A (pattern transfer from genie repo) |

## Summary
Set up full CI/CD infrastructure for rlmx by adapting proven patterns from the genie repo. This brings automated testing on PRs, date-based versioning (0.YYMMDD.N), automated npm publishing, rolling dev-to-main promotion PRs, conventional commit enforcement, and git hooks. Also fast-forwards main to match dev so the release pipeline has real code to ship.

## Scope
### IN
- GitHub Actions: ci.yml, release.yml, version.yml, rolling-pr.yml, commitlint.yml
- scripts/version.mjs adapted for rlmx (prefix 0, sync package.json + src/version.ts, plain ESM)
- cliff.toml for changelog generation (pointing to automagik-dev/rlmx)
- commitlint.config.ts for conventional commits
- Husky hooks: pre-push (block main), pre-commit (typecheck), commit-msg (commitlint)
- Fast-forward main branch to current dev HEAD
- Update package.json: add publishConfig, prepare script for husky, update repo URL
- Create src/version.ts with exported VERSION constant

### OUT
- Biome/knip linting (not yet configured — separate wish)
- Integration tests in CI (require live API keys — separate concern)
- Branch protection rules via GitHub API (manual setup)
- npm scope change (stays @namastex888/rlmx for now)
- Secrets setup (NPM_TOKEN, RELEASE_PLEASE_TOKEN — manual in GitHub settings)

## Decisions
| Decision | Rationale |
|----------|-----------|
| Version prefix `0` (not `3`/`4`) | rlmx is pre-1.0, `0.YYMMDD.N` signals early stage |
| `tsc` build, `node --test` runner | rlmx uses vanilla TypeScript + Node test runner, no bun |
| No biome/knip in CI yet | Not configured in rlmx — add in follow-up wish to avoid scope creep |
| Skip secrets-scan job | GitGuardian optional, not blocking — add later |
| `ubuntu-latest` runners | rlmx doesn't need blacksmith runners yet |
| Husky pre-commit: typecheck only | No linter configured — just `tsc --noEmit` for now |
| Single version sync (2 files) | Only package.json + src/version.ts — no plugin manifests |
| Plain .mjs for version script | Avoids tsx devDependency — runs with plain `node`, no extra deps in CI |
| Script named `bump-version` not `version` | npm's `version` is a lifecycle hook — custom name avoids conflict |

## Success Criteria
- [ ] CI workflow runs and passes on dev branch push (build + typecheck + test)
- [ ] CI workflow runs on PRs targeting main or dev
- [ ] Pushing to main triggers GitHub Release with git-cliff changelog
- [ ] Pushing to main triggers npm publish of @namastex888/rlmx@latest
- [ ] Dev push triggers npm publish of @namastex888/rlmx@next
- [ ] Version workflow bumps to 0.YYMMDD.N format after CI passes
- [ ] Rolling PR exists dev -> main (created hourly if missing)
- [ ] Conventional commits enforced via commitlint in CI
- [ ] Husky pre-push blocks direct push to main/master
- [ ] Husky commit-msg validates conventional commits locally
- [ ] Main branch contains all current dev code
- [ ] package.json has correct automagik-dev/rlmx repo URL and publishConfig

## Execution Strategy

### Wave 1 (parallel — foundation)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Package config + version script + src/version.ts |
| 2 | engineer | All 5 GitHub Actions workflow files |
| 3 | engineer | Husky hooks + commitlint + cliff.toml |

### Wave 2 (sequential — requires Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Fast-forward main to dev + push workflows to dev |
| review | reviewer | Review all Groups 1-4 |

## Execution Groups

### Group 1: Package Config & Version Script
**Goal:** Update package.json for the new org, create version automation script and version.ts.
**Deliverables:**
1. Update `package.json`:
   - Add `"publishConfig": { "access": "public" }`
   - Add `"prepare": "husky"` script
   - Add `"bump-version": "node scripts/version.mjs"` script (NOT `"version"` — conflicts with npm lifecycle)
   - Add `"check": "tsc --noEmit"` script
   - Update `repository.url` to `git+https://github.com/automagik-dev/rlmx.git`
   - Add `husky` as devDependency
   - Add `@commitlint/cli` as devDependency
   - Add `@commitlint/config-conventional` as devDependency
2. Create `scripts/version.mjs` (plain ESM JS — no tsx dependency needed):
   - Date-based version: `0.YYMMDD.N` (same pattern as genie)
   - Count existing `v0.YYMMDD.*` tags for daily counter
   - Sync `package.json` version
   - Sync `src/version.ts` VERSION export
3. Create `src/version.ts`:
   - `export const VERSION = '0.4.0';` (initial value)

**Acceptance Criteria:**
- [ ] `package.json` has publishConfig, prepare, bump-version, check scripts + commitlint deps
- [ ] `scripts/version.mjs` generates correct `0.YYMMDD.N` format
- [ ] `src/version.ts` exports VERSION constant
- [ ] `repository.url` points to automagik-dev/rlmx

**Validation:**
```bash
grep -q "automagik-dev/rlmx" package.json && grep -q "publishConfig" package.json && grep -q "bump-version" package.json && test -f scripts/version.mjs && test -f src/version.ts
```

**depends-on:** none

---

### Group 2: GitHub Actions Workflows
**Goal:** Create all 5 CI/CD workflow files adapted from genie patterns.
**Deliverables:**
1. `.github/workflows/ci.yml`:
   - Triggers: push/PR on main, dev
   - Jobs: quality-gate (build via tsc, typecheck via tsc --noEmit, test via node --test), publish-next (on dev push)
   - Uses `actions/setup-node@v4` + npm (not bun)
   - Concurrency: cancel-in-progress per ref
2. `.github/workflows/release.yml`:
   - Triggers: push to main, workflow_dispatch
   - Resolves version from package.json, detects hotfix
   - Generates changelog via git-cliff-action@v4
   - Creates GitHub Release
   - Builds and publishes to npm @latest
3. `.github/workflows/version.yml`:
   - Triggers: on CI workflow completion (main/dev)
   - Derives version 0.YYMMDD.N
   - Runs `npm run bump-version` to sync files
   - Commits `[skip ci]`, tags, pushes
   - Publishes to npm with appropriate tag
4. `.github/workflows/rolling-pr.yml`:
   - Hourly schedule + workflow_dispatch
   - Creates/maintains dev->main PR
   - Uses RELEASE_PLEASE_TOKEN
5. `.github/workflows/commitlint.yml`:
   - Triggers: push to dev, PR to main/dev
   - Uses wagoid/commitlint-github-action@v6

**Acceptance Criteria:**
- [ ] All 5 workflow files exist with valid YAML
- [ ] ci.yml uses Node.js setup (not bun)
- [ ] version.yml uses prefix `0` and calls `npm run bump-version`
- [ ] rolling-pr.yml creates PR from dev to main

**Validation:**
```bash
ls .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/version.yml .github/workflows/rolling-pr.yml .github/workflows/commitlint.yml
```

**depends-on:** none

---

### Group 3: Git Hooks & Config Files
**Goal:** Set up local development guardrails via husky + commitlint + changelog config.
**Deliverables:**
1. `.husky/pre-push`:
   - Block push to main/master with clear error message
   - Run `npm run check` (tsc --noEmit)
2. `.husky/pre-commit`:
   - Check if CI is red on current branch (via gh run list)
   - Run full `tsc --noEmit` typecheck (tsc doesn't support staged-only)
3. `.husky/commit-msg`:
   - Run `npx commitlint --edit "$1"`
4. `commitlint.config.ts`:
   - Extends @commitlint/config-conventional
   - Ignores [skip ci], merge commits, squash-merge PR commits
5. `cliff.toml`:
   - Conventional commit parsing with emoji groups
   - Commit links to automagik-dev/rlmx
   - Contributor list (Genie, Felipe, Cezar)
   - Skip version bump commits and merges

**Acceptance Criteria:**
- [ ] All 3 husky hooks are executable
- [ ] commitlint.config.ts extends conventional config
- [ ] cliff.toml has correct repo URL (automagik-dev/rlmx) for commit links

**Validation:**
```bash
test -x .husky/pre-push && test -x .husky/pre-commit && test -x .husky/commit-msg && test -f commitlint.config.ts && test -f cliff.toml
```

**depends-on:** none

---

### Group 4: Branch Sync & Initial Push
**Goal:** Fast-forward main to dev HEAD and push all CI/CD infrastructure to dev.
**Deliverables:**
1. Commit all new files on a `chore/cicd-infrastructure` branch (from dev)
2. Push branch and create PR targeting dev
3. **One-time bootstrap** (human-approved): fast-forward main to dev
   - Main currently has 1 init commit, dev has all real code — ff-only is safe
   - `git checkout main && git merge --ff-only dev && git push origin main`
   - This is a bootstrap exception — after this, only rolling PR merges touch main

**Acceptance Criteria:**
- [ ] PR created targeting dev with all CI/CD files
- [ ] Main branch tip matches dev after fast-forward
- [ ] CI workflow triggers on the push to dev

**Validation:**
```bash
git log --oneline main..dev | wc -l  # should be 0 after sync
```

**depends-on:** Group 1, Group 2, Group 3

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] `npm run build` succeeds (tsc compiles cleanly)
- [ ] `npm run check` succeeds (tsc --noEmit)
- [ ] `npm run test` passes all 142 tests
- [ ] CI workflow triggers and passes on dev push
- [ ] Commitlint rejects a bad commit message locally (husky)
- [ ] Pre-push hook blocks `git push origin main`
- [ ] Rolling PR is created dev->main within 1 hour

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| NPM_TOKEN not configured in GitHub | High | Document in PR — must be set manually before first publish |
| RELEASE_PLEASE_TOKEN not configured | Medium | Rolling PR creation will fail silently — set up PAT |
| Main fast-forward may conflict | Low | Main has 1 commit, dev has all work — ff-only is safe (verified) |
| Commitlint blocks existing non-conventional commits | Low | Only enforced on new pushes, not retroactive |

---

## Review Results

**Plan Review — 2026-03-29**
- **Verdict:** SHIP (after fixes applied inline)
- **Gaps found:** 6 (0 CRITICAL, 0 HIGH, 2 MEDIUM, 4 LOW) — all resolved
- **Fixes applied:**
  1. Renamed `version` script to `bump-version` (npm lifecycle conflict)
  2. Changed `scripts/version.ts` → `scripts/version.mjs` (eliminates tsx dep)
  3. Moved cliff.toml criterion from Group 2 to Group 3
  4. Clarified pre-commit runs full typecheck (not staged-only)
  5. Added @commitlint/cli + @commitlint/config-conventional to devDeps in Group 1
  6. Marked main ff-only as one-time bootstrap exception with human approval

---

## Files to Create/Modify

```
# Modified
package.json                          — publishConfig, scripts, repo URL, devDeps

# Created
src/version.ts                        — VERSION export constant
scripts/version.mjs                   — date-based version automation (plain ESM, no tsx)
.github/workflows/ci.yml             — CI pipeline
.github/workflows/release.yml        — release + npm publish
.github/workflows/version.yml        — auto version bump
.github/workflows/rolling-pr.yml     — dev->main promotion PR
.github/workflows/commitlint.yml     — commit message validation
.husky/pre-push                       — block main push + quality check
.husky/pre-commit                     — CI check + typecheck
.husky/commit-msg                     — commitlint hook
commitlint.config.ts                  — commitlint rules
cliff.toml                            — changelog generation config
```
