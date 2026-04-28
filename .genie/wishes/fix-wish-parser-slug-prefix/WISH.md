# Wish: Strip slug# prefix from wish depends-on parser

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-wish-parser-slug-prefix` |
| **Date** | 2026-04-28 |
| **Author** | Felipe Rosa (housekeep pass) |
| **Appetite** | small |
| **Branch** | `wish/fix-wish-parser-slug-prefix` |
| **Repos touched** | `automagik-dev/genie` |
| **Linked issue** | #1406 |
| **Design** | _No brainstorm — direct wish_ |

## Summary

`parseWishGroups` in `src/term-commands/dispatch.ts` stores group names as bare ids (`"1"`, `"2"`) but does not strip the canonical `slug#N` prefix from `**depends\-on:**` entries. As a result, `validateGroupRefs` in `src/lib/wish-state.ts` rejects every multi-group wish written in the canonical form encouraged by the wish skill (`genie wish status <slug>` throws `Group "N" depends on non-existent group "<slug>#M"`). This wish adds a single regex to the parser, locks the behavior with regression tests, and confirms the fix on a previously failing wish.

## Scope

### IN

- Add a `.replace(/^[a-z0-9-]+#/, '')` step to the depends-on normalization pipeline in `parseWishGroups` (`src/term-commands/dispatch.ts`, lines 212–220) so that `slug#N` and `slug-with-hyphens#N` collapse to the bare id `N`.
- Regression tests in `src/term-commands/dispatch.test.ts` covering: bare id (`2`), slug-prefixed (`my-wish#2`), mixed comma list (`1, my-wish#2, slug-with-hyphens#3`), and slug containing multiple hyphens.
- Smoke validation: run `genie wish status` against an affected wish that uses the canonical `slug#N` form and confirm it no longer throws.

### OUT

- Adding a `title` field to `GroupDefinition` (tracked separately as wish #1300).
- Migrating the dispatch path to the richer `wish-parser.ts` integration (separate wish — broader refactor).
- Changing the canonical depends-on syntax itself or the wish skill's authoring guidance.
- **Manual version bump.** The `version.yml` workflow auto-bumps the package version on dev push and tags it. No explicit version-bump deliverable is required in this wish; the merge to dev is sufficient.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Strip the `slug#` prefix in the parser rather than store qualified names in `groupNames` | Minimal diff; preserves the existing bare-id contract that downstream code (state file, dependency edges, wave parser) already assumes. The opposite direction would touch many call sites. |
| 2 | Match `^[a-z0-9-]+#` (lowercase, no `i` flag) — strict slug shape | Slugs in the wish skill are always lowercase letters, digits, and hyphens (per `genie wish new` validation). A case-insensitive match would silently accept `MyWish#1`, which the rest of the system rejects. Strict matching keeps the parser aligned with the rest of the slug grammar. |
| 3 | Apply the strip after the existing `groups?` strip, not before | Order is irrelevant for current inputs but the existing `groups?` strip already runs first — appending preserves diff size and reviewer cognitive load. |

## Success Criteria

- [ ] `parseWishGroups` returns `dependsOn: ["1"]` for a group whose markdown reads `**depends\-on:** my-wish#1`.
- [ ] `validateGroupRefs` returns without throwing when given a wish whose groups are `["1", "2"]` and a child group's `dependsOn` is `["1"]` parsed from `<slug>#1`. (This is the integration assertion — confirms parser output is accepted by the validator, not just shaped correctly.)
- [ ] `parseWishGroups` returns `dependsOn: ["1", "2", "3"]` for `**depends\-on:** 1, my-wish#2, slug-with-hyphens#3`.
- [ ] All four regression tests in `dispatch.test.ts` pass.
- [ ] Existing `parseWishGroups` tests (the eight already in the file) continue to pass — no regressions on the bare-id, `Group N`, parenthetical, or `none` paths.
- [ ] `bun run check` is green.
- [ ] Running `genie wish status <affected-slug>` against a wish that previously threw `depends on non-existent group "<slug>#N"` now returns a status without error.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add the regex strip + regression tests + smoke check on an affected wish |

## Execution Groups

### Group 1: Strip slug# prefix and lock with regression tests

**Goal:** Make `parseWishGroups` accept the canonical `slug#N` depends-on form and prove it stays accepted.

**Deliverables:**
1. One-line edit in `src/term-commands/dispatch.ts` adding `.replace(/^[a-z0-9-]+#/, '')` to the depends-on normalization chain (between the existing `groups?` strip and the final `.trim()`).
2. Four new test cases in the existing `describe('parseWishGroups()', ...)` block in `src/term-commands/dispatch.test.ts`:
   - `should strip slug# prefix from depends-on (canonical form)` — `**depends\-on:** my-wish#1` → `["1"]`.
   - `should handle mixed bare and slug-prefixed dependencies` — `**depends\-on:** 1, my-wish#2` → `["1", "2"]`.
   - `should strip slug# prefix when slug contains hyphens` — `**depends\-on:** slug-with-hyphens#3` → `["3"]`.
   - `should handle three-way mix of bare, slug, and hyphenated-slug deps` — `**depends\-on:** 1, my-wish#2, release-system-genie-pattern#3` → `["1", "2", "3"]`.
3. Smoke check via synthesized fixture in sidecar script: `bash .genie/wishes/fix-wish-parser-slug-prefix/scripts/smoke-1406.sh`. Pre-fix throws `non-existent group <slug>#1`; post-fix exits 0. (The fixture lives in a sidecar so the literal markdown declarations inside its heredoc don't trip parseWishGroups when scanning this WISH.md.)

**Acceptance Criteria:**
- [ ] `bun test src/term-commands/dispatch.test.ts` passes including all four new cases.
- [ ] `bun run check` is green (typecheck + lint + dead-code + full test suite).
- [ ] Smoke fixture exits 0 post-fix.
- [ ] Reverting the regex addition (locally, with the smoke fixture still present) makes `genie wish status $SMOKE_SLUG` throw `non-existent group "$SMOKE_SLUG#1"`. This proves the smoke detects regressions.
- [ ] Round-trip: parse a WISH.md with `**depends\-on:** <slug>#1` → call `validateGroupRefs` on the resulting `groups` array → assert no throw.
- [ ] Diff size: one line added in `dispatch.ts`, ~30 lines added in `dispatch.test.ts`. No other files modified.

**Validation:**
```bash
bun test src/term-commands/dispatch.test.ts
bun run check

# Smoke fixture (pre-fix throws; post-fix exits 0)
bash .genie/wishes/fix-wish-parser-slug-prefix/scripts/smoke-1406.sh
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: `genie wish status` on a wish authored with canonical `slug#N` depends-on returns a structured status, not a parser error.
- [ ] Integration: the wish state machine (`src/lib/wish-state.ts` `validateGroupRefs`) sees only bare ids and continues to detect real dangling deps (e.g., `**depends\-on:** 99` on a wish with two groups still throws).
- [ ] Regression: existing wish files using bare-id (`1`, `2`) and `Group N` depends-on syntax continue to parse identically — no behavior change for the historical forms.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The regex `^[a-z0-9-]+#` accidentally strips a legitimate dep that begins with a hyphen-only token | Low | Group ids are alphanumeric (`[A-Za-z0-9]+` per the parser regex on line 193); a leading-hyphen dep is impossible in current grammar. Test coverage locks this. |
| A future canonical form uses a different separator (e.g., `slug:N`) | Low | Out of scope; that future change can update this regex in tandem. |
| Smoke wish fixture leaks into the repo if synthesis path is taken | Low | Use `git status`/cleanup checklist before commit; place fixture under a clearly-temporary slug name and remove before staging. |

---

## Review Results

### Codex Review - 2026-04-28 (Plan)

**Verdict:** SHIP

**Evidence:**
- `genie wish parse fix-wish-parser-slug-prefix` passed and parsed the single execution group, deliverables, acceptance criteria, validation block, and `depends-on: none`.
- `genie wish lint fix-wish-parser-slug-prefix` passed with no structural violations.
- `gh issue view 1406` confirmed the issue is open and aligned with the wish root cause, proposed regex fix, and regression-test direction.

**Non-blocking gaps:**
- MEDIUM: The smoke command currently uses `genie wish status fix-wish-parser-slug-prefix`, but this wish has `depends-on: none`, so it does not prove the `slug#N` failure is fixed. Replace it with a known affected slug or spell out temp-fixture create/run/remove commands that fail before the fix and pass after.
- LOW: Issue #1406 suggests a version bump, but the wish neither includes it nor scopes it out. Add a version-bump deliverable/criterion or explicitly add versioning to Scope OUT with rationale.

**Next:** Proceed to `/work`; tighten the smoke-validation target before final QA.

---

### Claude Code Review - 2026-04-28 (Plan)

**Verdict:** FIX-FIRST (escalating Codex's MEDIUM smoke gap to blocker), with two refinements.

**Agreement with Codex:** Yes on both gaps. The smoke command is meaningfully wrong — it doesn't validate the fix. The version bump can go either way but should be explicitly resolved.

**Reasoning to escalate the smoke gap:**

Group 1's validation block is the only end-to-end check that the fix actually unblocks operator usage. As written, the smoke command runs `genie wish status fix-wish-parser-slug-prefix` against a wish with `depends-on: none` — the parser never sees a `slug#` prefix, so the command would succeed even on `main` (pre-fix). That's a false-positive validation. Group 1's only acceptance check therefore can't distinguish a working fix from no fix. That's not a "tighten before QA" issue — that's "this wish would ship without proving the bug is fixed."

**Recommended resolution for the smoke gap:**

Use **Option B: synthesize a temp fixture in the validation block.** The wish's Group 1 deliverable 3 already mentions this fallback. Promote it to the primary smoke path (since `release-system-genie-pattern` may not be present in every developer's local checkout):

```bash
# Synthesize a fixture wish that uses canonical slug# depends-on
SMOKE_SLUG="smoke-slug-prefix-$$"
genie wish new "$SMOKE_SLUG"
# Inject two groups with a slug-prefixed depends-on:
# (Replace the scaffold's single Group 1 with two groups; Group 2 depends-on $SMOKE_SLUG#1)
# … (concrete sed/awk commands or Python snippet)
genie wish status "$SMOKE_SLUG"  # MUST exit 0 post-fix; throws on main pre-fix
rm -rf ".genie/wishes/$SMOKE_SLUG"
```

Add to Group 1 acceptance: *"Smoke fixture exits 0 post-fix; reverting the regex makes it throw `non-existent group "<slug>#1"`."* That's the AC that actually proves the fix.

**Additional refinements:**

- **MEDIUM — Decision #2 vs regex flag inconsistency.** Decision #2 says "Match `^[a-z0-9-]+#` (case-insensitive) instead of a stricter slug pattern" + "Matches the slug shape the wish skill emits (lowercase letters, digits, hyphens)". The `i` flag adds uppercase matching, which the rationale explicitly rules out. Either drop the `i` flag (slugs are always lowercase per skill convention) or update Decision #2 to say "case-insensitive defensive measure for tolerance". Pick one — the rationale and the regex shouldn't disagree.
- **LOW — version bump scope.** Resolve Codex's LOW gap by adding to Scope OUT: *"Manual version bump — `version.yml` workflow auto-bumps on dev push; no explicit bump deliverable in this wish."*
- **LOW — missing AC for end-to-end validation.** AC #1 checks `parseWishGroups` output. There's no AC asserting `validateGroupRefs` accepts the parsed output without throwing. Add: *"`validateGroupRefs` returns without throwing when given a wish whose groups are `1, 2` and a depends-on of `["1"]` parsed from `my-wish#1`."*

**Next:** /fix the smoke validation block (Option B above) and the regex-vs-Decision-#2 inconsistency, then SHIP. Without those, the wish ships a fix it cannot prove works.

---

## Files to Create/Modify

```
src/term-commands/dispatch.ts        # +1 line: extra .replace() in parseWishGroups
src/term-commands/dispatch.test.ts   # +~30 lines: four new test cases in parseWishGroups describe block
```
