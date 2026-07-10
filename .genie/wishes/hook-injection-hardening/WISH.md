# Wish: Hook shell-injection hardening (the BLOCKED-clearing safety edit)

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — [PR #2536](https://github.com/automagik-dev/genie/pull/2536) (commit `f61aaf13`, branch `wish/hook-injection-hardening` → main). G1+G2 + whole-wish reviews SHIP; 729 pass/0 fail; full `bun run check` green on the PR base (verified by the pre-push hook) |
| **Slug** | `hook-injection-hardening` |
| **Date** | 2026-07-09 |
| **Author** | namastex888 |
| **Appetite** | 1 afternoon (~4h) |
| **Branch** | `wish/hook-injection-hardening` |
| **Design** | _No brainstorm — direct wish (evidence: `.genie/repo-profile.md` + seven-lane panel synthesis)_ |

## Summary

The three PreToolUse file-path hooks interpolate the tool's `file_path` into a shell command string (`execSync(\`git … -- ${JSON.stringify(filePath)}\`)`), and since `JSON.stringify` escapes quotes and backslashes but not `$` or backticks, a `file_path` of `$(cmd)` runs `cmd` under `sh -c` with the user's privileges — a live RCE in any checkout whose `.claude/settings.json` routes `"*"` to dispatch, as this repo's does. This wish removes the shell at all three sites via `execFileSync('git', [...argv, '--', filePath])`, pins it with hostile-filename regression tests exercising each handler's reachable path, and — bundled per the panel — deletes the sibling `core.bare` startup probe that forks git on every invocation. Landing it flips the panel verdict **BLOCKED → FIX-FIRST**.

## Scope

### IN
- Replace the shell-interpolating `execSync` git call in `getRecentGitHistory` (`src/hooks/handlers/audit-context.ts`) with `execFileSync('git', [...argv, '--', filePath])`.
- Replace both shell-interpolating `execSync` git calls in `src/hooks/handlers/freshness.ts` (`getLastCommitInfo` and `checkUncommittedChanges`) the same way, dropping the now-meaningless shell double-quotes around the `--format` value.
- Hostile-filename regression tests that prove neither handler executes an embedded command, exercising each handler's *reachable* path.
- A functional regression proving `freshness` still emits a stale-read warning after the de-shell (guards the `--format` parse trap).
- Remove the top-level `core.bare` probe from `src/genie.ts` so it no longer forks git on the universal invocation path (finding 6).

### OUT
- Narrowing the repo's `.claude/settings.json` `"*"` PreToolUse matcher — a separate policy change; this wish removes the vulnerability at the source so matcher width stops mattering.
- Findings 2/3/5 (dependency-aware `launch`, enforced completion authority, the phantom DAG) — those are the separate **execution-truth** wish, which carries a product decision.
- Any change to the shipped plugin's hook routing (already safe — it routes only `SendMessage`).
- Broader subprocess-hardening sweeps outside these three sites and the `core.bare` probe.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Fix via `execFileSync('git', [...argv, '--', filePath])`, not shell-escaping | Removing the shell entirely is the only robust fix; escaping `$`/backticks is a denylist that rots. The `--` pathspec separator also stops a filename beginning with `-` from being parsed as a git flag. |
| 2 | `freshness.ts` `--format` argv element is `--format=%at\|%an\|%s` with **no** surrounding quotes | The `"…"` in the current string are shell quoting that `sh` strips before git sees them. Carried into an argv array they become literal, corrupting the `%at` field so `Number.parseInt` yields `NaN` and freshness silently stops warning. |
| 3 | Regression tests exercise each handler's *reachable* path, not a generic call | `audit-context` has no existence gate (primary vector) — pass the hostile `file_path` directly. `freshness` is `statSync`-gated — the test must create a real on-disk file *literally named* with the payload so `statSync` succeeds and the injectable git call is reached; freshness has **two** such sites (`getLastCommitInfo` for committed files, `checkUncommittedChanges` for uncommitted), so its tests cover both. The static `execSync(` grep gate backstops both regardless of test reachability. |
| 4 | Bundle the `core.bare` probe removal (finding 6) as Group 2 | Panel + performance lane both flag it; both are one-line footgun removals on the same subprocess-hygiene surface, shipping in the same afternoon. Kept a separate group/commit so it reverts independently of the security fix. |
| 5 | Delete the `core.bare` probe rather than relocate it | Its own comment says it "should no longer trigger" (the v4 worktree-corruption path is gone; v5 uses `git clone --shared`), and it can flip a legitimately-bare repo's `core.bare` to false. Relocating a guarded check into `launch` is an acceptable alternative — the Group 2 gate only asserts the probe is gone from `genie.ts`, so it passes either way. |

## Success Criteria

- [x] A hostile `file_path` containing `$(…)` executes **no** embedded command through `auditContext` — regression test creates a temp git repo, invokes the handler with `file_path: '$(touch PWNED)'`, and asserts no `PWNED` file exists afterward.
- [x] A hostile on-disk filename containing `$(…)` executes **no** embedded command through `freshness` — regression test creates a fresh-mtime file literally named `$(touch PWNED)`, invokes the handler, and asserts no `PWNED` file exists afterward.
- [x] `freshness` still emits a stale-read warning for a genuinely recent file authored by another agent (proves the `--format` parse survived the de-shell).
- [x] No `execSync(` call remains in `audit-context.ts` or `freshness.ts`; both import and use `execFileSync`.
- [x] The `core.bare` startup probe no longer appears anywhere in `src/genie.ts`.
- [ ] `bun run check` fully green — **all gates PASS for this wish**: typecheck, biome lint, knip dead-code, skills:lint, wishes:lint (this wish conforms), and `bun test` = 729 pass / 1 skip / 0 fail. Box left unchecked because `bun run check` overall still exits 1 for ONE out-of-scope reason: a concurrently-created file, `.genie/wishes/council-workflow/WISH.md`, is missing the same Complexity/Model columns. Not a regression from these changes; owned by another session.
- [x] `bun run build` succeeds and `dist/genie.js --version` works from a non-git directory.

## Execution Strategy

### Wave 1 (parallel — both zero-dependency, disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|-----------|-------|-------------|
| 1 | engineer | 4 (security fix + reachable-path regression tests) | opus·xhigh | De-shell the three file-path hook git calls (`execFileSync`) + hostile-filename injection tests. The BLOCKED-clearing gate. |
| 2 | engineer | 2 (mechanical deletion + build smoke) | opus·high | Remove the `core.bare` startup probe from `src/genie.ts`. Bundled footgun removal. |

Both groups touch disjoint files (hook handlers vs. the entry module), so they run fully in parallel with no shared edits. Group 1 is the BLOCKED-clearing gate; Group 2 is the bundled footgun removal.

---

## Execution Groups

### Group 1: De-shell the file-path hook git calls (+ regression tests)
**Goal:** No PreToolUse hook can execute a command embedded in a `file_path`, and tests permanently own that guarantee.

**Deliverables:**
1. `src/hooks/handlers/audit-context.ts` — `getRecentGitHistory` uses `execFileSync('git', ['log', '--oneline', '-n', String(MAX_COMMITS), '--', filePath], opts)`; import switches from `execSync` to `execFileSync`.
2. `src/hooks/handlers/freshness.ts` — `getLastCommitInfo` uses `execFileSync('git', ['log', '-1', '--format=%at|%an|%s', '--', filePath], opts)` (no quotes around the format); `checkUncommittedChanges` uses `execFileSync('git', ['status', '--porcelain', '--', filePath], opts)`; import switches to `execFileSync`.
3. `src/hooks/handlers/__tests__/audit-context.test.ts` — **extend the existing file** (this dir uses a `__tests__/` subdir, not colocated tests) with an injection-named test asserting `file_path: '$(touch PWNED)'` creates no `PWNED` file (reuse the existing temp-git-repo fixture).
4. `src/hooks/handlers/__tests__/freshness.test.ts` — **extend the existing file** with injection-named tests covering **both** reachable git sites: (a) a *committed* fresh-mtime file literally named `$(touch PWNED)` — reaches `getLastCommitInfo` (freshness.ts:24); and (b) an *uncommitted* fresh-mtime file literally named `$(touch PWNED2)` with `GENIE_AGENT_NAME` set — reaches `checkUncommittedChanges` (freshness.ts:72); each asserting the sentinel is never created. **Plus** a functional test asserting `freshness` still returns a stale-read warning for a real recent commit by another author (guards the `--format` parse).

**Acceptance Criteria:**
- [x] `grep -nE '\bexecSync\('` finds nothing in either handler; `grep -q execFileSync` finds it in both.
- [x] Both handler test files (under `__tests__/`) contain injection-named tests and pass under `bun test`; the freshness tests cover both the committed (`getLastCommitInfo`) and uncommitted (`checkUncommittedChanges`) injectable sites. The static `execSync(` grep gate backstops both sites regardless of per-test reachability.
- [x] The freshness functional test proves the `--format` parse still yields a valid timestamp (warning is emitted).
- [x] `bun run typecheck` is clean.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
set -euo pipefail

# 1. No shell-interpolating execSync remains (execFileSync is allowed and expected).
if grep -nE '\bexecSync\(' src/hooks/handlers/audit-context.ts src/hooks/handlers/freshness.ts; then
  echo "FAIL: shell-interpolating execSync( still present in a hook handler"; exit 1
fi

# 2. Both handlers now call git via execFileSync argv (no shell).
grep -q "execFileSync('git'" src/hooks/handlers/audit-context.ts
grep -q "execFileSync('git'" src/hooks/handlers/freshness.ts

# 3. Injection regression tests exist (in __tests__/), are named for the threat, and pass.
grep -qi 'inject' src/hooks/handlers/__tests__/audit-context.test.ts
grep -qi 'inject' src/hooks/handlers/__tests__/freshness.test.ts
bun test src/hooks/handlers/__tests__/audit-context.test.ts src/hooks/handlers/__tests__/freshness.test.ts

# 4. Type gate clean.
bun run typecheck
```

**depends-on:** none

---

### Group 2: Remove the `core.bare` startup probe from the universal path
**Goal:** `genie` stops forking git on every `--version`, `--help`, and hook fork, and stops being able to clobber a legitimately-bare repo's `core.bare`.

**Deliverables:**
1. `src/genie.ts` — delete the top-level `core.bare` guard **including its preceding explanatory comment** (the whole block spans lines ~34-46; note the comment at line 36 contains the literal string `core.bare`, so leaving the comment would trip the Group 2 gate) and its module-scope `require('node:child_process')`.
2. If corruption recovery is still wanted, a guarded equivalent may be relocated into a worktree-creating command (`launch`) only — optional per Decision 5; not required for the gate.

**Acceptance Criteria:**
- [x] `core.bare` appears nowhere in `src/genie.ts`.
- [x] No module-scope `require('node:child_process')` remains in `src/genie.ts`.
- [x] `bun run build` succeeds and `dist/genie.js --version` runs cleanly from a non-git directory.
- [x] `bun run typecheck` is clean.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
set -euo pipefail

# 1. The core.bare probe is gone from the entry module.
if grep -n 'core.bare' src/genie.ts; then
  echo "FAIL: core.bare probe still present in src/genie.ts"; exit 1
fi

# 2. No module-scope child_process require remains in the entry module.
if grep -nE "require\('node:child_process'\)" src/genie.ts; then
  echo "FAIL: module-scope child_process require still in src/genie.ts"; exit 1
fi

# 3. Build + version smoke from a NON-git dir (startup must not hard-depend on git).
bun run build
tmp="$(mktemp -d)"
( cd "$tmp" && bun "$(git rev-parse --show-toplevel)/dist/genie.js" --version )

# 4. Type gate clean.
bun run typecheck
```

**depends-on:** none
