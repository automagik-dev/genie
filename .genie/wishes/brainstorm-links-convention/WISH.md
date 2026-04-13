# Wish: Brainstorm Links Convention — Closed-Loop Enforcement

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `brainstorm-links-convention` |
| **Date** | 2026-04-13 |
| **Design** | [DESIGN.md](../../brainstorms/brainstorm-links-convention/DESIGN.md) |
| **Closes** | #1132 |

## Summary

Every wish on dev carries a `[DESIGN.md](../../brainstorms/<slug>/DESIGN.md)` link in its header table, but `.gitignore` excludes the brainstorms directory. 36+ broken links today, 27+ bot comments on PR #1130, and no enforcement stops the next one. This wish replaces the one-shot gitignore fix with a **closed-loop enforcement system**: three defense layers backed by one infrastructure prerequisite. Write-side (`/brainstorm` auto-commits), create-side (`/wish` pre-flights), and read-side (`wishes-lint` fails CI) are the three layers; the `.gitignore` narrow is the prerequisite that makes write-side actually work. After this ships, broken brainstorm links become impossible to create and impossible to ship.

## Scope

### IN

- **`/brainstorm` skill** (`skills/brainstorm/SKILL.md`) — crystallize step calls `git add` on `DESIGN.md` + `DRAFT.md` so the files are staged the moment they exist
- **`/wish` skill** (`skills/wish/SKILL.md`) — pre-flight check verifies `.genie/brainstorms/<slug>/DESIGN.md` exists before emitting the template's Design link; fallback to `_No brainstorm — direct wish_` stub when absent
- **`.gitignore`** — narrow `.genie/brainstorms/` to allow `DESIGN.md` + `DRAFT.md` through while keeping WIP files private
- **`scripts/wishes-lint.ts`** (NEW) — linter modeled on `scripts/skills-lint.ts`; walks every `.genie/wishes/**/*.md`, extracts markdown link syntax, resolves relative-path targets, fails non-zero if any `brainstorms/*` link points to a missing file
- **`package.json`** — wire `wishes-lint` into `bun run check` alongside the existing `skills:lint`
- **Convention doc** — new `.genie/brainstorms/README.md`, one paragraph: "crystallized outputs are committed, WIP is private, wishes link here"
- **Backfill triage** — run the new linter once, produce a report of all broken links, replace Category B (unrecoverable) entries with a stub note using `sed`
- **Legitimize 3 already-force-added brainstorms** (`velocity-dashboard/DESIGN.md`, `velocity-dashboard/DRAFT.md`, `workflow-engine-runtime/DESIGN.md`) under the new rule — they stop being in a grey zone

### OUT

- Migrating brainstorm content INTO wish bodies (option 3 from #1132, rejected)
- Separate `.genie/design/` tree (option 4, rejected)
- Stripping links entirely (option 1, rejected)
- Retroactively recovering lost brainstorms via forensic git spelunking — accept historical data loss for Category B
- Changing the markdown link format in wish headers (`[DESIGN.md](../../brainstorms/<slug>/DESIGN.md)` stays as-is)
- Adding a new CI workflow — piggyback on the existing Quality Gate job via `bun run check`
- Retroactive enforcement of DRAFT.md for archived wishes (only DESIGN.md matters for reader value)

## Decisions

| Decision | Rationale |
|----------|-----------|
| **Three defense layers + one prerequisite, not one fix** | Write-side (`/brainstorm` auto-commits), create-side (`/wish` pre-flights), and read-side (`wishes-lint` fails CI) are three independent failure modes. The `.gitignore` narrow is not a defense layer — it's the prerequisite that makes write-side auto-commit actually work (otherwise force-add is required). Single-layer fixes get bypassed; multi-layer systems don't. |
| **Linter modeled on `skills-lint.ts`** | Precedent exists, pattern proven, already integrated into `bun run check`. Copying the shape costs ~100 lines vs. designing a new validator pattern. |
| **Wire into `bun run check`, not a new CI workflow** | Matches PR #1136's principle of failing fast in the existing Quality Gate job. Zero new CI minutes. |
| **Pre-flight fallback is a stub note, not an error** | If an author deliberately writes a wish without a brainstorm (trivial fix, hotfix, etc.), the skill shouldn't block them. The stub `_No brainstorm — direct wish_` is self-documenting and passes the linter. |
| **Backfill Category B via mass `sed`, not per-file forensics** | Time-bounded. Most archived designs are genuinely unrecoverable (authored in other workspaces). Stub-and-ship is cheaper than archaeology. |
| **Convention doc is one paragraph, not a wiki page** | YAGNI. The rule is "crystallized is public, WIP is private." That's one sentence. The rest is already in the skill docs. |
| **Keep `[DESIGN.md](../../brainstorms/<slug>/DESIGN.md)` markdown format unchanged** | Existing wishes already use it, tooling understands it, refactor would cascade through every template and backfill. Don't fix what isn't broken. |
| **Skill changes touch `skills/*/SKILL.md`, not generated plugin output** | `skills/` is the authoritative source; the plugin cache (`~/.claude/plugins/...`) is regenerated on install. Single source of truth. |

## Success Criteria

- [ ] `bun run check` fails when any wish contains a broken `brainstorms/*` link (verifiable by temporarily breaking one and re-running)
- [ ] `bun run check` passes on dev after this wish lands (zero unresolved brainstorm links)
- [ ] Running `/brainstorm` on a new topic produces a staged `DESIGN.md` + `DRAFT.md` — verifiable via `git status` after crystallize
- [ ] Running `/wish` with an existing crystallized brainstorm produces a wish whose Design link resolves to a real file
- [ ] Running `/wish` **without** a prior brainstorm produces a wish whose Design field says `_No brainstorm — direct wish_` (no broken link)
- [ ] `.gitignore` change: `git check-ignore -v .genie/brainstorms/foo/DESIGN.md` returns the negation rule (not excluded); `git check-ignore -v .genie/brainstorms/foo/scratch.md` returns the exclusion rule (still ignored)
- [ ] `scripts/wishes-lint.ts` reports the current 36 broken links on dev, then zero after backfill/stub pass
- [ ] 3 already-force-added brainstorms (`velocity-dashboard/DESIGN.md`, `velocity-dashboard/DRAFT.md`, `workflow-engine-runtime/DESIGN.md`) appear in `git ls-files` under the new rule and are no longer in a grey zone
- [ ] `.genie/brainstorms/README.md` exists with a single-paragraph convention statement
- [ ] No regression: `skills-lint.ts` still passes; `/brainstorm` → `/wish` → `/review` → `/work` flow produces the same artifacts it did before

## Execution Strategy

### Wave 1 (parallel — two independent leaf changes)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | **`scripts/wishes-lint.ts`** (standalone, NOT yet wired into `check`) — new linter + `wishes:lint` npm script |
| 2 | engineer | **`.gitignore` narrow + convention doc** — negation rule + `.genie/brainstorms/README.md` |

### Wave 2 (parallel — two independent skill edits)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | **`/brainstorm` skill update** — crystallize step stages `DESIGN.md` + `DRAFT.md` via `git add` |
| 4 | engineer | **`/wish` skill update + backfill pass** — pre-flight verify, stub fallback, manual triage of broken links, backfill Category A, stub Category B |

### Wave 3 (sequential — final wiring)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | **Wire `wishes:lint` into `bun run check`** — only safe after G4 backfill makes the linter pass |

After Group 5, a reviewer agent reviews all 5 groups against success criteria.

**Why G1 does not wire into `check` immediately:** if the linter runs as part of `bun run check` before G4's backfill resolves the existing broken links, every subsequent step in the same PR (including G3/G4 implementation commits and their own local pre-push hooks) would fail. Split enforces safe ordering: linter exists → backfill resolves existing breakage → wiring turns on enforcement.

## Execution Groups

### Group 1: `scripts/wishes-lint.ts` — standalone linter (NOT yet wired into `check`)

**Goal:** A linter that walks every wish markdown file, resolves every markdown-style link, and exits non-zero if any `brainstorms/*` link target doesn't exist. **Does not touch `bun run check` — that wiring happens in G5 after G4's backfill.**

**Deliverables:**

1. `scripts/wishes-lint.ts` — new TypeScript file, modeled on `scripts/skills-lint.ts`:
   - Walks `.genie/wishes/**/*.md` recursively
   - Extracts markdown links via regex `\[([^\]]+)\]\(([^)]+)\)`
   - For each link whose target contains `brainstorms/`, resolves the relative path from the wish's directory
   - Skips targets matching the literal stub text `_No brainstorm — direct wish_` and `_Design not recovered…_`
   - Reports unresolved targets to stderr with `<wish-file>:<line>: <link text> → <target>` format
   - Exits non-zero on any unresolved link
   - Honors `<!-- wishes-lint:ignore -->` marker for opt-out
2. `package.json` script entry (ONLY the standalone script — no `check` wiring yet):
   ```json
   "wishes:lint": "bun run scripts/wishes-lint.ts"
   ```
3. Baseline report — running `bun run wishes:lint` on current dev reports whatever set of broken links the linter finds (exact count becomes input to G4 triage; **do not pin to a specific number**)

**Acceptance Criteria:**

- [ ] `bun run wishes:lint` exits non-zero on current dev and prints every broken link found
- [ ] Temporarily deleting a committed `DESIGN.md` causes the linter to fail with a message pointing at every wish that links to it
- [ ] Restoring the file makes the corresponding error go away
- [ ] `<!-- wishes-lint:ignore -->` marker in a file causes it to be skipped
- [ ] Literal stub text (`_No brainstorm — direct wish_`, `_Design not recovered — this wish pre-dates…_`) does not trip the linter
- [ ] No false positives on Category C content references (prose mentions of `.genie/brainstorms/` that aren't markdown links)
- [ ] `package.json` does NOT yet reference `wishes:lint` inside the `check` script (that is G5's job)

**Validation:**
```bash
bun run wishes:lint 2>&1 | tee /tmp/wishes-lint-baseline.log
# Expect non-zero exit on current dev with broken link list
# This establishes the "before" state that Group 4 resolves
```

**depends-on:** none

---

### Group 2: `.gitignore` narrow + convention doc

**Goal:** Allow `DESIGN.md` and `DRAFT.md` under `.genie/brainstorms/*/` while keeping everything else private; document the convention.

**Deliverables:**

1. `.gitignore` change (4 lines):
   ```diff
   - .genie/brainstorms/
   + .genie/brainstorms/**
   + !.genie/brainstorms/*/
   + !.genie/brainstorms/*/DESIGN.md
   + !.genie/brainstorms/*/DRAFT.md
   ```
2. `.genie/brainstorms/README.md` — new file, one paragraph:
   > Brainstorms are the reasoning layer behind wishes. Each brainstorm lives under `.genie/brainstorms/<slug>/` and contains session notes, transcripts, AI scratchpads, and the two crystallized outputs: `DRAFT.md` (progressive refinement) and `DESIGN.md` (architecture and decisions). **Only `DRAFT.md` and `DESIGN.md` are committed — everything else is workspace-local** (see `.gitignore`). Wishes link to `DESIGN.md` as their design reference; readers follow the link to see the rationale behind the plan. The `/brainstorm` skill auto-stages both files on crystallize; the `scripts/wishes-lint.ts` linter fails CI on any broken brainstorm link.

**Acceptance Criteria:**

- [ ] `git check-ignore -v .genie/brainstorms/test-slug/DESIGN.md` returns the negation rule (file is NOT ignored)
- [ ] `git check-ignore -v .genie/brainstorms/test-slug/DRAFT.md` returns the negation rule
- [ ] `git check-ignore -v .genie/brainstorms/test-slug/session-notes.md` returns the exclusion rule (file IS ignored)
- [ ] `git check-ignore -v .genie/brainstorms/test-slug/transcript.jsonl` returns the exclusion rule
- [ ] 3 already-force-added brainstorms are still tracked (no regression): `git ls-files .genie/brainstorms/ | wc -l` >= 3
- [ ] `.genie/brainstorms/README.md` exists and is tracked
- [ ] `.genie/brainstorms/README.md` is itself allowed by the gitignore (`git check-ignore -v` returns the negation rule or no rule — i.e., not excluded)

**Validation:**
```bash
# Pattern tests
mkdir -p /tmp/ignore-test/.genie/brainstorms/test-slug
cd /tmp/ignore-test
git init -q
cp $OLDPWD/.gitignore .
touch .genie/brainstorms/test-slug/DESIGN.md
touch .genie/brainstorms/test-slug/DRAFT.md
touch .genie/brainstorms/test-slug/scratch.md
git check-ignore -v .genie/brainstorms/test-slug/DESIGN.md && echo "FAIL: DESIGN.md should NOT be ignored" && exit 1
git check-ignore -v .genie/brainstorms/test-slug/scratch.md > /dev/null || (echo "FAIL: scratch.md should be ignored" && exit 1)
echo "Group 2 gitignore test: PASS"

# Doc exists
test -f .genie/brainstorms/README.md || (echo "FAIL: README.md missing" && exit 1)
grep -q 'crystallized outputs' .genie/brainstorms/README.md || (echo "FAIL: convention not documented" && exit 1)
echo "Group 2 doc test: PASS"
```

**depends-on:** none

---

### Group 3: `/brainstorm` skill — auto-commit on crystallize

**Goal:** The crystallize step of `/brainstorm` stages `DESIGN.md` and `DRAFT.md` via `git add` so authors never forget to track them.

**Deliverables:**

1. Edit `skills/brainstorm/SKILL.md` — extend the Crystallize section (currently at lines ~108-118) to explicitly instruct the skill to run `git add` on both files after writing them. Reference the new `.gitignore` rule so the skill knows force-add is not needed.
2. Updated Crystallize flow:
   ```markdown
   ## Crystallize
   Triggered automatically when WRS = 100.
   
   1. Write `.genie/brainstorms/<slug>/DESIGN.md` from `DRAFT.md` using the Design Template.
   2. Spec self-review (existing 4-point checklist).
   3. **Stage both files for commit:**
      ```bash
      git add .genie/brainstorms/<slug>/DESIGN.md .genie/brainstorms/<slug>/DRAFT.md
      ```
      Per `.gitignore`, only `DESIGN.md` and `DRAFT.md` are trackable under `.genie/brainstorms/*/` — no force-add needed. Other brainstorm artifacts (session notes, transcripts, scratchpads) remain workspace-local.
   4. Update `.genie/brainstorm.md` — move item to Poured with wish link.
   5. Auto-invoke `/review` (plan review) on the `DESIGN.md`.
   ```
3. Update the Rules section to add: "Always `git add` both `DESIGN.md` and `DRAFT.md` on crystallize — the linter will fail CI on any wish that links to an uncommitted brainstorm."

**Acceptance Criteria:**

- [ ] `skills/brainstorm/SKILL.md` Crystallize section includes an explicit `git add` step
- [ ] Rules section mentions the linter enforcement
- [ ] The edit is additive — existing language about DESIGN.md / DRAFT.md naming is preserved
- [ ] `skills-lint.ts` still passes after the edit (no broken bash fence references)

**Validation:**
```bash
grep -q 'git add .genie/brainstorms' skills/brainstorm/SKILL.md || (echo "FAIL: git add step missing" && exit 1)
grep -q 'wishes-lint\|linter will fail\|CI on any wish' skills/brainstorm/SKILL.md || (echo "FAIL: linter enforcement not mentioned" && exit 1)
bun run skills:lint 2>&1 | tail -5
```

**depends-on:** Group 2 (needs the `.gitignore` rule to exist so `git add` works without force)

---

### Group 4: `/wish` skill pre-flight + backfill pass

**Goal:** `/wish` skill verifies its linked brainstorm target exists before emitting the link; run the linter and resolve/stub every broken link on dev.

**Deliverables:**

1. Edit `skills/wish/SKILL.md` template section (currently at line 59) — add a pre-flight instruction so the skill checks `.genie/brainstorms/<slug>/DESIGN.md` at wish-creation time:
   ```markdown
   ## Pre-flight check
   
   Before writing the wish, verify the Design file exists:
   ```bash
   test -f .genie/brainstorms/<slug>/DESIGN.md
   ```
   - **If present:** emit `| **Design** | [DESIGN.md](../../brainstorms/<slug>/DESIGN.md) |` as normal.
   - **If absent:** emit `| **Design** | _No brainstorm — direct wish_ |` (no link). This is valid for hotfixes, trivial changes, or cases where the plan is obvious enough that a brainstorm adds no value.
   
   The linter (`scripts/wishes-lint.ts`) treats the literal stub text as valid and skips it.
   ```
2. Update the wish Rules section: "Pre-flight the Design link — never emit a bracket-link to a non-existent brainstorm file. Fall back to the stub text."
3. **Backfill pass** — run `bun run wishes:lint` on dev, capture the broken-link list, and for each:
   - **Category A** (brainstorm recoverable from agent workspace or git history): copy the DESIGN.md into `.genie/brainstorms/<slug>/` and commit
   - **Category B** (unrecoverable): replace the broken link in the wish with the stub text `_Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._` via `sed`
   - **Category C** (prose mention, not a link): add a `<!-- wishes-lint:ignore -->` marker or refine the regex so prose mentions don't trip the linter
4. After backfill, `bun run wishes:lint` exits zero on dev.
5. The `wishes-lint.ts` linter recognizes the stub text as valid and does not flag it.

**Acceptance Criteria:**

- [ ] `skills/wish/SKILL.md` contains a pre-flight check instruction for the Design link
- [ ] `skills/wish/SKILL.md` Rules section mentions the pre-flight + stub fallback
- [ ] **`bun run wishes:lint` exits zero on post-backfill dev** — every broken link is either backfilled (Category A), stubbed (Category B), or explicitly ignored via `<!-- wishes-lint:ignore -->` marker (Category C)
- [ ] The three already-force-added brainstorms remain valid targets for their respective wishes
- [ ] `skills-lint.ts` still passes after the edit
- [ ] Manual triage step explicitly called out: for each broken link, run `git log --all -- .genie/brainstorms/<slug>/DESIGN.md` to check if the file ever existed in any branch. If yes → Category A (restore + commit); if no → Category B (sed-replace with stub). Automation handles the post-triage mass edits, not the decision itself.

**Validation:**
```bash
# Pre-flight instruction present
grep -q 'test -f .genie/brainstorms' skills/wish/SKILL.md || (echo "FAIL: pre-flight missing" && exit 1)
grep -q 'No brainstorm — direct wish\|_No brainstorm' skills/wish/SKILL.md || (echo "FAIL: stub fallback missing" && exit 1)

# Linter passes on dev after backfill
bun run wishes:lint || (echo "FAIL: broken links remain after backfill" && exit 1)

# skills-lint still green
bun run skills:lint || (echo "FAIL: skills-lint regressed" && exit 1)

echo "Group 4 validation: PASS"
```

**depends-on:** Group 1, Group 2

(Note: NOT dependent on Group 3 — G3 and G4 are independent skill edits and can run in parallel in Wave 2.)

---

### Group 5: Wire `wishes:lint` into `bun run check`

**Goal:** Turn on CI enforcement now that G4's backfill has resolved every existing broken link.

**Deliverables:**

1. Edit `package.json` `check` script to add `&& bun run wishes:lint` after the existing `skills:lint`:
   ```diff
   - "check": "bun run typecheck && bun run lint && bun run dead-code && bun run skills:lint && bun test"
   + "check": "bun run typecheck && bun run lint && bun run dead-code && bun run skills:lint && bun run wishes:lint && bun test"
   ```
2. Verify the full `bun run check` pipeline passes on the post-backfill dev state
3. Verify `.husky/pre-push` (which runs `bun run check`) will now catch any broken brainstorm link before it leaves a contributor's machine

**Acceptance Criteria:**

- [ ] `package.json` `check` script includes `bun run wishes:lint`
- [ ] `bun run check` exits zero on the current branch
- [ ] Negative test: temporarily breaking one brainstorm link makes `bun run check` fail with the exact `wishes-lint` error message
- [ ] Pre-push hook catches the same failure before reaching CI

**Validation:**
```bash
# Positive: full check passes
bun run check || (echo "FAIL: check failed with clean state" && exit 1)

# Negative: breaking a link fails the check
mv .genie/brainstorms/brainstorm-links-convention/DESIGN.md{,.bak}
bun run check && (echo "FAIL: check should have failed with broken link" && exit 1)
mv .genie/brainstorms/brainstorm-links-convention/DESIGN.md{.bak,}
echo "Group 5 validation: PASS"
```

**depends-on:** Group 4 (needs backfill complete so the linter passes on dev)

---

## QA Criteria

- [ ] **End-to-end dry run:** run `/brainstorm` on a throwaway topic, let it crystallize, run `/wish` for the same slug, `git status` shows staged DESIGN.md + DRAFT.md + the new wish, `bun run check` passes
- [ ] **Negative test:** delete a committed DESIGN.md, `bun run check` fails with the exact broken-link message from `wishes-lint.ts`
- [ ] **Stub test:** run `/wish` for a slug that has no brainstorm, the emitted wish has the stub text and `bun run check` passes
- [ ] **Regression:** `bun run check` passes on a fresh clone of dev post-merge (no environment drift)
- [ ] **Bot noise gone:** open a follow-up PR touching any archived wish — verify no "broken brainstorm link" comments from Gemini or CodeRabbit
- [ ] **Pre-push hook:** local `bun run check` (which `.husky/pre-push` runs) catches broken links before they reach CI — verifiable by temporarily breaking one link and attempting a commit

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `wishes-lint.ts` regex has false positives on markdown-ish text that isn't a real link (`[brainstorms/foo]` in a code block) | Medium | Mirror `skills-lint.ts`'s approach of only parsing markdown link syntax `[text](target)`, not raw brackets. Add a code-fence-aware walker if needed. |
| Some Category B brainstorms might actually be recoverable from the main repo's git history (prior force-adds that were later reverted) | Low | Do a quick `git log --all --oneline -- .genie/brainstorms/` pass before stubbing; recover what's there, stub the rest |
| Authors manually write a wish without running `/wish` and forget the pre-flight | Medium | The linter catches it. Defense in depth. |
| Third brainstorm output filename emerges later (e.g. `COUNCIL.md`) and needs its own negation rule | Low | Add to `.gitignore` when it happens; document in convention README |
| `bun run check` time budget — adding another linter slows CI | Low | `wishes-lint.ts` is filesystem-only, no network, no PG. Expected runtime <200ms on this repo. |
| Pre-flight check in `/wish` breaks when the skill runs in a worktree that has a brainstorm locally but not in git | Low | Check for file existence on disk, not git tracking state. Either way the link resolves. |
| Linter runs on in-flight WIP wishes that haven't crystallized yet | Low | The `wishes-lint:ignore` marker or per-file opt-out handles this; most WIP wishes shouldn't have brainstorm links yet anyway |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
# Create
scripts/wishes-lint.ts                              (new linter, ~120 lines)
.genie/brainstorms/README.md                        (convention doc, 1 paragraph)
.genie/brainstorms/brainstorm-links-convention/DESIGN.md  (this wish's own design — already written)

# Modify
.gitignore                                          (line 60: 1 line → 4 lines)
package.json                                        (add wishes:lint script + wire into check)
skills/wish/SKILL.md                                (pre-flight check section + rule update)
skills/brainstorm/SKILL.md                          (git add in crystallize step + rule update)

# Backfill (Category A, recoverable)
.genie/brainstorms/<various>/DESIGN.md              (TBD from linter output — expect 3-10 recoverable)

# Edit for stub notes (Category B, unrecoverable)
.genie/wishes/_archive/<various>/WISH.md            (replace dead link with `_Design not recovered…_` stub)

# No changes (explicit — this is the one-source-of-truth file; plugin cache regenerates on install)
~/.claude/plugins/cache/automagik/genie/*/skills/   (not touched, regenerated)
```

## Closes

- Issue #1132 — brainstorm: wish→brainstorm linking convention (gitignored brainstorms produce dead links)
