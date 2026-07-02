# Wish: Taxonomy Re-homing — Plans Back in .genie/, Skills Speak Genie

| Field | Value |
|-------|-------|
| **Status** | DONE — both groups SHIP-reviewed (2026-07-02); one user action pending: PATH line in ~/.zshrc |
| **Slug** | `taxonomy-rehoming` |
| **Date** | 2026-07-02 |
| **Author** | Felipe + Genie |
| **Appetite** | ~1 day |
| **Branch** | `v5` (rides into the housekeeping PR #2500 or a follow-up) |
| **Design** | follows [genie-v5-lightweight-body] decisions; resolves PR #2500 Codex P2 + Gemini MEDIUMs |
| **Depends on** | wish `v5-housekeeping` (DONE, PR #2500 open) |

## Summary

Genie's planning documents belong in genie's own taxonomy: `.genie/wishes/` and `.genie/brainstorms/`, tracked in git — not `.claude/plans/`. Migrate the v5-era plans there, make every doc/skill/test path claim coherent (resolves the Codex P2 on PR #2500), fix the hardcoded absolute paths the Gemini review flagged, and update Felipe's user-level `~/.claude/skills/` to speak genie (`.genie/` artifacts + `genie task`/`genie board` state) now that the v5 CLI is real. Sanitization pass: our own tooling uses our own product.

## Scope

### IN
- Migrate `.claude/plans/<slug>/` → genie taxonomy on the repo: WISH.md files → `.genie/wishes/<slug>/WISH.md`; DESIGN.md/DRAFT.md → `.genie/brainstorms/<slug>/`; `INDEX.md` → `.genie/INDEX.md`. Git-tracked (this partially reverses housekeeping's ".genie is runtime-only" stance — the runtime-only rule now applies to state, not documents).
- Coherence sweep after the move: `.gitignore` comment updated (genie.db* stays ignored; wishes/brainstorms tracked); `src/lib/v5/TAXONOMY.md` re-reconciled (planning docs live in `.genie/wishes|brainstorms`, state in genie.db); README's plan-path mentions corrected (Codex P2); `skills/README.md` if it names `.claude/plans`; repo `skills/*/SKILL.md` already use `.genie/` paths — verify, don't churn.
- Gemini MEDIUMs: in every migrated WISH.md, replace the hardcoded absolute repo-path `cd` lines with `cd "$(git rev-parse --show-toplevel)"` in validation blocks (sweep all migrated docs, not just the three flagged lines), and fix internal cross-references between migrated docs (e.g. v5-foundation WISH's qa.md path assertions).
- User-level skills update (environment work, NOT repo content): rewrite `~/.claude/skills/{brainstorm,wish,work,review}/SKILL.md` to (a) home artifacts at `.genie/brainstorms/<slug>/` + `.genie/wishes/<slug>/WISH.md` + `.genie/INDEX.md`, (b) track execution-group state via `genie task create --title <t> --wish <slug> --group <n>` / `checkout` / `done` + `genie board` when a genie-capable environment is detected (probe: `genie task --help` lists `export` — the v5-only discriminator; a stale v4 binary also answers `--help` and lists checkout), falling back to native task tracking otherwise, (c) keep Agent-tool dispatch, reviewer≠engineer, fix loops, WRS — the methodology is unchanged, only homes and state surface move.
- Global binary refresh: the on-PATH `genie` is stale npm 4.260509.7 — after the bare-name cutover, its `genie task` is v4 PG code. Install the fresh v5 build to `~/.genie/bin/genie` (the home `genie update` manages) with `~/.genie/bin` first on PATH, and remove/neutralize the stale bun-global shim; verify `genie task --help` lists `export` (the v5-only discriminator). Document the step taken.

### OUT
- Rewrites of the 13 deferred repo skills (unchanged, still lint-ignored).
- Any change to the four core REPO skills beyond path verification — they already use `.genie/` + `genie task`.
- CI/workflow changes; `docs/` submodule; PR #2500 merge (Felipe's).
- Building `genie init` or any new CLI surface.
- Migrating this taxonomy convention into other repos.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Planning documents live tracked in `.genie/wishes|brainstorms`; `.claude/plans/` retires | Genie's product taxonomy is the source of truth (Codex P2: shipped skills + e2e already read `.genie/`); dogfooding our own layout |
| 2 | "Runtime-only" narrows to state: genie.db* ignored, documents tracked | Housekeeping's blanket claim overshot; the real rule is documents-in-git / state-in-sqlite (design D2) |
| 3 | User-level skills prefer genie state when available, degrade to native tasks | Felipe's skills run in non-genie repos too; hard-requiring genie would break them there |
| 4 | Validation blocks use `git rev-parse --show-toplevel`, never absolute paths | Gemini review; portability for CI and other machines |
| 5 | Global genie binary refreshed into `~/.genie/bin` (the update-managed home), stale bun shim removed | A stale v4 binary answering `genie task` is a live hazard; overwriting the bun shim would break future `genie update`, which only swaps binaries under `~/.genie/bin` |

## Success Criteria

- [x] `.claude/plans/` no longer exists in the repo; every slug's docs live under `.genie/wishes/<slug>/` or `.genie/brainstorms/<slug>/`; `git ls-files .genie/` shows them tracked.
- [x] No doc/skill/test in the repo references `.claude/plans` (grep gate, excluding git history).
- [x] No migrated WISH.md contains a hardcoded `/Users/` path in a validation block (grep gate).
- [x] TAXONOMY.md (lines ~11/31), .gitignore comment, README (line ~46, the Codex P2 ref) all state the same layout; skills/README.md checked and corrected only if it references plan paths.
- [x] `~/.claude/skills/{brainstorm,wish,work,review}` reference `.genie/` homes and the genie task/board state surface with a native fallback (grep each file).
- [~] `genie task --help` shows the v5 sqlite shape — TRUE for the installed ~/.genie/bin/genie; bare-PATH resolution pending Felipe adding `export PATH="$HOME/.genie/bin:$PATH"` to ~/.zshrc (rc edits deliberately not automated).
- [x] Full `bun run check` + e2e green; CI green on push.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1 | Repo migration + coherence + Gemini fixes (single PR-able unit) |
| 2 | Group 2 | User-level skills + global binary (environment work; depends on the final repo layout for path references) |

---

## Execution Groups

### Group 1: Repo migration + coherence + portability fixes
**Goal:** Plans live in `.genie/`, every path claim in the repo agrees, validation blocks are portable.

**Deliverables:**
1. `git mv` each `.claude/plans/<slug>/` doc set: WISH.md AND qa.md (and any other per-wish evidence docs) → `.genie/wishes/<slug>/`; DESIGN.md + DRAFT.md → `.genie/brainstorms/<slug>/` (NEVER route non-DESIGN/DRAFT/COUNCIL files to brainstorms — the gitignore allowlist silently drops them); INDEX.md → `.genie/INDEX.md` with links fixed; remove the emptied `.claude/plans/`.
2. In every migrated WISH.md: hardcoded absolute repo-path `cd` lines → `cd "$(git rev-parse --show-toplevel)"`; sweep any other machine-specific absolute path in doc bodies (validation blocks AND prose); fix internal cross-references between migrated docs.
3. Coherence: `.gitignore` comment (state-only ignore, documents tracked); `src/lib/v5/TAXONOMY.md` (re-home planning docs to `.genie/`); README plan-path mentions (Codex P2 — quickstart/how-it-works must say `.genie/wishes`); `skills/README.md` if it names `.claude/plans`; verify the four core repo skills already point at `.genie/` (no churn if correct).
4. Cross-reference sweep: `grep -rn '\.claude/plans' src/ skills/ tests/ README.md .github/` → zero hits after the move.

**Acceptance Criteria:**
- [x] Path/grep gates below pass; history preserved as renames where git detects them.
- [x] Full check + e2e green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
test ! -d .claude/plans
test -f .genie/wishes/taxonomy-rehoming/WISH.md
test -f .genie/wishes/v5-foundation/qa.md
test -f .genie/INDEX.md
git ls-files --error-unmatch .genie/wishes/v5-foundation/qa.md >/dev/null
if grep -rn '\.claude/plans' src/ skills/ tests/ README.md .github/ 2>/dev/null; then echo "FAIL: .claude/plans refs remain"; exit 1; fi
# .genie/ deliberately excluded: migrated docs narrate the old path in prose/history
if grep -rn '/Users/' .genie/wishes/ .genie/brainstorms/ --exclude-dir=taxonomy-rehoming 2>/dev/null; then echo "FAIL: absolute paths remain"; exit 1; fi
# taxonomy-rehoming excluded: this wish documents the pattern being removed
grep -q '\.genie/wishes' src/lib/v5/TAXONOMY.md
bun run check
V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh
```

**depends-on:** none

---

### Group 2: User-level skills + global binary (environment)
**Goal:** Felipe's `~/.claude/skills` speak genie; the on-PATH genie is the v5 build.

**Deliverables:**
1. Rewrite `~/.claude/skills/brainstorm/SKILL.md`: artifacts at `.genie/brainstorms/<slug>/{DRAFT,DESIGN}.md`, jar at `.genie/INDEX.md`; methodology (WRS, one-question, review gate) unchanged.
2. Rewrite `~/.claude/skills/wish/SKILL.md`: output `.genie/wishes/<slug>/WISH.md`; template/lint checklist unchanged; validation-command rule gains "never hardcode absolute paths — use git rev-parse --show-toplevel".
3. Rewrite `~/.claude/skills/work/SKILL.md`: wish path `.genie/wishes/<slug>/WISH.md`; per-group state via `genie task create --title <group-title> --wish <slug> --group <n>` / `checkout` / `done` + `genie board --wish <slug>` when genie-capable (probe: `genie task --help` lists `export`), else native tasks; Agent-tool dispatch and review loops unchanged.
4. Rewrite `~/.claude/skills/review/SKILL.md`: artifact paths `.genie/...`; verdict flow unchanged.
5. Global binary refresh: install the fresh v5 `dist/genie.js` to `~/.genie/bin/genie` (the home `genie update` manages — it refuses to swap binaries elsewhere) and ensure `~/.genie/bin` precedes `~/.bun/bin` on PATH; remove or neutralize the stale bun-global shim (4.260509.7). Do NOT overwrite the bun shim in place (breaks future `genie update`) or `bun link` (couples PATH to the working tree). Verify from an unrelated cwd; record exactly what was done.

**Acceptance Criteria:**
- [x] Each of the four skill files greps for `.genie/wishes` or `.genie/brainstorms` and NOT `.claude/plans`.
- [x] work skill names `genie task` + `genie board` with the fallback clause.
- [x] `genie task --help` (on PATH, from any dir) shows create/list/status/done/checkout/export.

**Validation:**
```bash
set -euo pipefail
for f in ~/.claude/skills/brainstorm/SKILL.md ~/.claude/skills/wish/SKILL.md ~/.claude/skills/work/SKILL.md ~/.claude/skills/review/SKILL.md; do
  grep -qE '\.genie/(wishes|brainstorms)' "$f" || { echo "FAIL: $f not re-homed"; exit 1; }
  if grep -n '\.claude/plans' "$f"; then echo "FAIL: $f still references .claude/plans"; exit 1; fi
done
grep -q 'genie task' ~/.claude/skills/work/SKILL.md
grep -q 'genie board' ~/.claude/skills/work/SKILL.md
genie task --help | grep -qw export  # v5-only discriminator: stale v4 help also lists checkout
```

**depends-on:** group-1

---

## Cross-wish dependencies

- **Follows:** `v5-housekeeping` (DONE). Resolves PR #2500 review comments (Codex P2, Gemini MEDIUMs).
- **Note:** active session artifacts move mid-flight — the plans INDEX and this wish itself live at the new home from birth.
