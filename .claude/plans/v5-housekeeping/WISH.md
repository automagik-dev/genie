# Wish: Genie v5 Housekeeping — True Lightweight Tree + README Replan

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `v5-housekeeping` |
| **Date** | 2026-07-02 |
| **Author** | Felipe + Genie |
| **Appetite** | ~2-3 days |
| **Branch** | `v5` (rides ahead of PR #2499; commits land per group) |
| **Design** | [DESIGN.md](../genie-v5-lightweight-body/DESIGN.md) — lightweight-body follow-through |
| **Depends on** | wish `v5-demolition` (DONE, PR #2499 open) |

## Summary

The demolition removed the harness but left the shell: unreferenced root files (cliff.toml, Makefile with deleted targets, .rlmx/, tools/, test-fixtures/, assets/avatars, npm vestiges), three test directories, 3.6MB of v4 planning history in `.genie/`, and a dead metrics bot whose commits are half the git log. Delete all of it (user-confirmed: v4 history recoverable from the `v4` branch; metrics automation killed entirely), consolidate the test tree, and rewrite the README from scratch as v5's front door.

## Scope

### IN
- Root-file cleanup: delete `UPGRADING-pgserve-v3.md`, `VELOCITY.md`, `cliff.toml` (zero refs), `Makefile` (targets reference deleted build:app/tauri; bun scripts are the interface), `.npmrc` + `.npmignore` (nothing publishes to npm from v5), one redundant markdownlint config (keep whichever `docs-lint.yml` actually uses).
- Dir cleanup: delete `.rlmx/` (zero refs), `tools/` (one orphan bench script), `test-fixtures/` (zero refs), `assets/` (avatars, zero refs).
- Test-tree consolidation: single `tests/` dir — move `test/hooks/` → `tests/hooks/`; delete the then-empty `test/`; fix any path references (ci.yml, bunfig, docs).
- `.genie/` v4-history deletion (user-confirmed): `wishes/`, `brainstorms/`, `reports/`, `qa/`, `agents/` (metrics-updater), `assets/` (commits-30d.svg), `state/v3-fixes-release.json`, loose `brainstorm.md`. Runtime `genie.db*` stays (gitignored).
- Metrics automation killed (user-confirmed): the svg + agent state die in Group 2; the README METRICS block + VELOCITY link die with the Group 3 rewrite (sequencing: README is Group 3's domain); plus a repo-wide grep confirming no workflow/script regenerates any of it.
- README full replan: new v5 front door written from scratch — hero (wishes in, PRs out; lightweight body), install (curl + cosign note), quickstart (the brainstorm→wish→work→review loop in Claude Code), what-it-is (skills + git documents + one `.genie/genie.db`, zero daemons, 10 commands, 3 deps, ~0.9MB), command table, skills status (6 active, rest being ported), honest roadmap (Warp integration, omni port, Codex/Hermes, CDN distribution — all phrased as upcoming), contributing pointer, license. No metrics block, no dead-subsystem claims.
- All gates stay green after each group: `bun run check`, build, `V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh`, CI on push.

### OUT
- Version-scheme change (4.YYMMDD.N → 5.x) and `version.yml` auto-bump behavior — release/versioning is the distribution wish's domain; killing the metrics bot does NOT touch release version bumps.
- `audit-next-tag.yml`, package.json npm vestiges (`publishConfig`, `prepack`, plugin sync scripts) — already flagged for the distribution wish by the CI/CD review; not doubled here.
- `.coderabbit.yaml`, `.gitguardian.yml`, `.gitattributes`, `SECURITY.md`, `CHANGELOG.md`, `install.sh`, `.well-known/`, `templates/`, `.docs-vendor` submodule — kept (live or externally referenced).
- `docs/` public-site content overhaul — separate effort; only the README changes here.
- Anything under `src/` — no code changes in this wish (deletions are tree-level only).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | v4 planning history deleted from v5, not archived in-tree | User-confirmed. The `v4` branch + git history preserve every byte; active plans live in `.claude/plans/`; 3.6MB of dead text has no place in a lightweight clone |
| 2 | Metrics automation killed entirely (bot, VELOCITY.md, README block, svg) | User-confirmed. Its commit noise dominated the log; the new README leads with the product, not counters |
| 3 | Auto-version release bumps are NOT the metrics bot — untouched here | Version cuts are release machinery; changing the scheme to 5.x belongs to the distribution wish |
| 4 | Makefile deleted rather than trimmed | Every target either shells to a bun script (duplication) or references deleted build:app/tauri; `bun run <x>` is the single interface |
| 5 | One `tests/` tree | Three test roots (test/, tests/, test-fixtures/) for two suites is v4 residue; e2e + integration + hooks live together |
| 6 | README written from scratch, not patched | The G6 sweep made it honest; this wish makes it good — structure designed for v5 rather than v4 minus deletions |

## Success Criteria

- [ ] Root contains no unreferenced/stale files: `UPGRADING-pgserve-v3.md`, `VELOCITY.md`, `cliff.toml`, `Makefile`, `.npmrc`, `.npmignore`, `.rlmx/`, `tools/`, `test-fixtures/`, `assets/`, `test/` all gone (path asserts).
- [ ] `.genie/` tracked content is empty except runtime db files are ignored (git ls-files gate).
- [ ] Repo-wide grep finds no reference to VELOCITY, commits-30d, metrics-updater, or METRICS:START markers.
- [ ] `tests/` is the single test root; full `bun run check` + e2e green; CI green on push.
- [ ] README: markdownlint passes (docs-lint config); stale-claims grep clean (pgserve|tmux|tauri|PostgreSQL|terminal UI|knowledge brain|METRICS); quickstart commands verified to exist (`genie task`, `genie board`, skill names); roadmap items phrased as upcoming.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1, Group 2 | Disjoint paths: root/tree files (G1) vs .genie/ history (G2) |
| 2 | Group 3 | README references the post-cleanup reality (no metrics block target left) |

---

## Execution Groups

### Group 1: Root + tree cleanup
**Goal:** Delete every unreferenced root file/dir, consolidate the test tree, keep all gates green.

**Deliverables:**
1. Delete: `UPGRADING-pgserve-v3.md`, `VELOCITY.md`, `cliff.toml`, `Makefile`, `.npmrc`, `.npmignore`, `.rlmx/`, `tools/`, `test-fixtures/`, `assets/`.
2. Markdownlint config dedupe: read `.github/workflows/docs-lint.yml`, keep exactly the config it uses, delete the other (`.markdownlint.json` vs `.markdownlint-cli2.jsonc`).
3. Move `test/hooks/` → `tests/hooks/` (imports keep the same depth); delete empty `test/`; sweep references (`grep -rn 'test/hooks\|test-fixtures\|"test/"' .github/ package.json bunfig.toml knip.json biome.json docs snippets`) and fix.
4. Sweep package.json/knip/biome for entries referencing anything deleted here — known hit: `biome.json` line ~57 lists `test-fixtures/symlink-cycle/real/cycle` in its ignore array; remove it.
5. Note: README's link to VELOCITY.md dangles between this group and Group 3's rewrite — accepted same-branch transient, resolved in wave 2.

**Acceptance Criteria:**
- [ ] Path asserts for every deletion pass.
- [ ] Full `bun run check` + build + e2e green; hooks tests still discovered and passing from `tests/hooks/`.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
for p in UPGRADING-pgserve-v3.md VELOCITY.md cliff.toml Makefile .npmrc .npmignore .rlmx tools test-fixtures assets test; do
  if [ -e "$p" ]; then echo "FAIL: $p still exists"; exit 1; fi
done
test -d tests/hooks
bun run check
bun run build
V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh
```

**depends-on:** none

---

### Group 2: .genie/ v4-history + metrics-state deletion
**Goal:** Empty `.genie/` of tracked v4 content; kill every metrics artifact.

**Deliverables:**
1. Delete from git: `.genie/wishes/`, `.genie/brainstorms/`, `.genie/reports/`, `.genie/qa/`, `.genie/agents/`, `.genie/assets/`, `.genie/state/`, `.genie/brainstorm.md`.
2. Verify nothing regenerates metrics: repo-wide grep for `metrics-updater|commits-30d|VELOCITY|METRICS:START` across src/ scripts/ .github/ plugins/ skills/ — every hit must be deleted or justified in the report.
3. `.gitignore` sanity: `.genie/genie.db*` rules remain; add `.genie/` runtime-only guidance comment if helpful (no functional change).

**Acceptance Criteria:**
- [ ] `git ls-files .genie/` returns empty after the group's commit.
- [ ] Metrics grep clean repo-wide (excluding .claude/plans history and the v4 branch).
- [ ] Gates green.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
if [ -n "$(git ls-files .genie/)" ]; then echo "FAIL: tracked files remain under .genie/"; git ls-files .genie/; exit 1; fi
if grep -rnE 'metrics-updater|commits-30d|METRICS:START|VELOCITY' src/ scripts/ .github/ plugins/ skills/ 2>/dev/null; then echo "FAIL: metrics refs remain"; exit 1; fi
# README.md deliberately excluded — its METRICS block is Group 3's rewrite target (wave 2)
bun run check
```

**depends-on:** none

---

### Group 3: README replan
**Goal:** Write v5's front door from scratch — structured for what genie is now, honest about what's coming.

**Deliverables:**
1. New `README.md`: hero ("wishes in, PRs out" + lightweight body one-liner); badges (release/stars/license/discord — drop dead ones); install (curl + cosign sentence); 60-second quickstart (init expectations honest — `genie init` isn't shipped yet; `genie setup` IS real and may be named; quickstart = install → open repo in Claude Code → `/brainstorm` → `/wish` → `/work`, with `genie board`/`genie task` for state); "What's inside" (skills + git documents + one `.genie/genie.db`, zero daemons, 10 commands, 3 runtime deps, ~0.9MB binary); command reference table (the 10); skills table (6 active now, ported-next list); architecture paragraph (documents in git / state in sqlite / dispatch via Claude Code native teams); roadmap (Warp integration, omni port, Codex + Hermes targets, CDN distribution — upcoming, no dates); v4 pointer (v4 branch + final npm version for existing users); license/community links.
2. Every command/skill named in the README verified to exist in the current build (script the check in validation).
3. Markdownlint clean with the surviving config.

**Acceptance Criteria:**
- [ ] Stale-claims grep clean; no METRICS markers; no unbuilt feature phrased as present.
- [ ] Quickstart commands exist (`bun dist/genie.js <cmd> --help` exit 0 for each `genie` command named).
- [ ] Lint + check green.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
if grep -nE 'pgserve|tmux|tauri|PostgreSQL|terminal UI|[Kk]nowledge brain|METRICS:START|VELOCITY' README.md; then echo "FAIL: stale claims"; exit 1; fi
bun run build
# Verify every `genie <cmd>` the README names appears in the real --help command
# list. Do NOT probe commands directly: `--help` exits 0 for ANY token
# (commander short-circuits), and bare invocation would EXECUTE them
# (`genie update` would self-update).
HELP=$(bun dist/genie.js --help)
for c in $(grep -oE '`genie [a-z]+' README.md | sed 's/`genie //' | sort -u); do
  echo "$HELP" | grep -qE "^  $c( |$)" || { echo "FAIL: README names missing command: $c"; exit 1; }
done
bunx markdownlint-cli2 README.md
bun run check
```

**depends-on:** group-1, group-2

---

## Cross-wish dependencies

- **Follows:** `v5-demolition` (DONE).
- **Hands to distribution wish:** version-scheme 5.x, audit-next-tag.yml, package.json npm vestiges.
- **Unblocked by nothing; blocks nothing** — pure cleanup, safe to land before or after PR #2499 merges (commits ride the same v5 branch).
