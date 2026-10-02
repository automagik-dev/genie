# Wish: Skill card images

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `skill-cards` |
| **Date** | 2026-10-02 |
| **Author** | Felipe Rosa |
| **Appetite** | medium |
| **Branch** | `wish/skill-cards` |
| **Repos touched** | automagik-dev/genie, automagik-dev/docs |
| **Design** | [DESIGN.md](../../brainstorms/skill-cards/DESIGN.md) |

## Summary

A tracked generator, `scripts/skill-card-images.ts`, builds one SVG card per skill from `skills/<name>/agents/openai.yaml` in the design B neon look. It commits the six core cards for the README in genie and the 18 shipped-skill cards in automagik-dev/docs, and a text test keeps the six true when a skill's text changes. The work also tracks the approved `genie-launch` design, amends it where this work replaces its throwaway card step, and re-stamps it. The design is reviewed SHIP (digest `17648661…`). Delivery is three ordered PRs: genie, then docs, then a genie pointer bump after the docs PR merges.

## Scope

### IN

- G1: the PR's first commit tracks `.genie/brainstorms/genie-launch/DESIGN.md` byte for byte as stamped (design IN #8, first half). A second commit tracks this design, this wish and their `.genie/INDEX.md` entries.
- G2: the generator, its tracked fonts, OFL license and logo, and its test over temporary roots (design IN #1, #2, #3, and #5 without the real-tree block).
- G3: the `<img>` render check of the `brainstorm` card on GitHub and in a Mintlify preview, through throwaway branches (design Approach, Decision 18).
- G4: the six README card SVGs and the test's real-tree block (design IN #4, and the rest of #5).
- G5: the `genie-launch` amendment, then its fresh independent design review and re-stamp (design IN #7, and IN #8 second half).
- G6: publish the genie PR to `dev` and read it back.
- G7: the automagik-dev/docs PR with exactly the 18 SVGs under `genie/images/skills/` (design IN #6, first half).
- G8: after the docs PR merges, the genie `.docs-vendor` pointer bump PR, and deletion of the throwaway branches (design IN #6, second half).

### OUT

- Editing `README.md` or placing the cards in it; group A of `genie-launch` owns that (design OUT, R3-4, R4-3).
- Writing the docs "4. Skills catalog" page or any per-skill docs page; group B of `genie-launch` owns that (R4-2).
- Rendering images in genie's runtime, release workflows or CI (R1-1, R2-2).
- A test over the docs cards (R3-3).
- PNG or raster cards, a headless browser in the generator, text converted to outlines (R2-1). A headless browser is used only in G3 to screenshot the render check, never to produce a card.
- A new palette or visual language beyond the design B tokens (R2-1).
- Any new entry in `dependencies` or image tooling in `devDependencies` (R1-1).
- Fixing the brainstorm ledger bug found while settling this design (issue #3090); it is its own task.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | The design's 20 decisions are taken as they stand; this plan adds only the sequencing decisions below | The design is reviewed SHIP; reopening it belongs in `brainstorm` |
| 2 | Before G3, no card is committed anywhere. G3 writes only the `brainstorm` card, through `renderSkillCard`, onto the two throwaway branches. G4 generates the six | The design requires the `brainstorm` card to be viewed before the others are generated (Decision 18, criterion 8). Committing no card before G3 keeps that order checkable from git history |
| 3 | The test file is written in two steps. G2 owns every test that runs over a temporary root. G4 adds the block that reads the six committed cards | G2's tests stay green with no card in the tree, and the real-tree block lands in the same commit as the cards it checks |
| 4 | The render-check screenshots are committed under `.genie/wishes/skill-cards/evidence/`, and the genie PR body embeds them by absolute URLs pinned to the evidence commit (`https://raw.githubusercontent.com/automagik-dev/genie/<sha>/.genie/wishes/skill-cards/evidence/<file>.png`), since a relative path does not render in a PR body | The `gh` CLI cannot attach images to a PR body, and the design asks for a record that outlives the deleted branches. The wish folder already travels with the PR |
| 5 | G3 runs with the owner present, and its outcome is an owner checkpoint | It pushes two throwaway branches and may open a draft docs PR, which are outward writes. Its pass or stop rule is the owner's R5-1 decision applied to evidence the owner looks at |
| 6 | The docs PR (G7) opens only after the genie PR's review is SHIP | The 18 docs cards must come from the final generator. A repair to the generator after the docs PR opened would make the two PRs disagree |
| 7 | The `genie-launch` re-review (G5) uses the same design-review contract and stamp tool as any brainstorm. The repair budget is `genie config get budgets.maxEscalationsPerGroup`, and past it the work goes back to the owner | The amended design is a reviewed design like any other. The stamp is the reviewer's digest, never a locally recomputed one |
| 8 | G1, G3, G6, G7 and G8 are orchestrator steps. G2, G4 and G5 are worker groups with independent review | Tracking commits, outward pushes and PRs belong to the orchestrator. The workers edit only their declared files |

## Simplicity Case

- **Simplest complete design:** the design's own case. One script concatenates SVG text from two YAML fields and the skill name. It has three tracked binary inputs (two fonts, one logo), six committed SVGs in genie, 18 in the docs, and one text test.
- **Added machinery:** none beyond the design. The plan adds only ordering (render check before generation, docs PR after the genie review) and one evidence folder for the screenshots (Decision 4).
- **Deferred until measured:** the design's list, which is per-card font subsetting, glyph measurement, a docs-card test and any render fallback beyond system fonts, each with its trigger. The brainstorm ledger fix (#3090) stays deferred to its own task.
- **Complexity removed:** no browser in the generator, no rasterizer, no network fetch, no runtime, release or CI change, no new dependency, no README or docs-page edit.

## Dependencies

**depends-on:** none
**blocks:** none

The `genie-launch` design has no wish yet. When it gets one, that wish must not run until G5's re-stamp verifies (design IN #8).

## Success Criteria

The design's 17 success criteria are this wish's criteria, numbered here in the design's order, each with the design's proof:

- [ ] SC1: six SVGs at `.github/assets/skill-<name>.svg` for brainstorm, wish, work, review, council and fix, each `viewBox="0 0 800 400"`. **Proof:** `scripts/skill-card-images.test.ts`.
- [ ] SC2: each card's `<text>` nodes equal the skill's `display_name`, its `short_description` (wrapped lines joined), `/name` and `$name`. **Proof:** `scripts/skill-card-images.test.ts`.
- [ ] SC3: `--check` exits 0 on the clean tree, and exits 1 without writing after a `short_description` or `display_name` change in a temporary copy. **Proof:** `scripts/skill-card-images.test.ts`.
- [ ] SC4: two generations produce identical bytes. **Proof:** `bun scripts/skill-card-images.ts && git diff --exit-code .github/assets`, and the test.
- [ ] SC5: no card holds an `@import`, every `href` is a `data:` URI, and no `http` URL appears apart from the SVG `xmlns` namespace. **Proof:** the test.
- [ ] SC6: a `short_description` over 68 characters or needing three lines, and a `display_name` over 24 characters, exit 1 with nothing written. A value holding `&`, `<`, `>`, `"` or `'` is XML-escaped. **Proof:** the test.
- [ ] SC7: `--docs` with no resolvable `docs/` exits 1 and creates nothing, tested against a temporary root whose `docs` symlink dangles. **Proof:** the test.
- [ ] SC8: the `brainstorm` card is viewed through `<img>` on both platforms before the others are generated. Logo and glow render on both. Fonts render, or the platform shows the system stacks and the PR names the R5-1 fallback. **Proof:** the genie PR body links both views, embeds both screenshots from `.genie/wishes/skill-cards/evidence/`, and states fonts, logo and glow per platform. `gh pr view --json files` on both PRs lists no `render-check.md` or `render-check.mdx`. `git log --diff-filter=A -- .github/assets/skill-*.svg` on the wish branch shows every card added in G4's commit, after G3's evidence commit.
- [ ] SC9: every `<text>` node's `font-family` begins with Geist (title, line) or JetBrains Mono (commands) and ends in `sans-serif` or `monospace`. **Proof:** the test.
- [ ] SC10: the fonts, `OFL.txt` and the logo are tracked beside the generator and byte-equal to their main-checkout sources, and `OFL.txt` carries both copyright lines. **Proof:** `git ls-files scripts/skill-card-images/`, `sha256sum` against the three values in Global constraints, and `grep -Eq '^Copyright.*(Geist|Vercel)'` plus `grep -Eq '^Copyright.*JetBrains'` on `scripts/skill-card-images/fonts/OFL.txt`.
- [ ] SC11: `package.json` `dependencies` and `README.md` are unchanged. **Proof:** `git diff origin/dev...HEAD -- package.json README.md`.
- [ ] SC12: the genie PR's first commit adds only `.genie/brainstorms/genie-launch/DESIGN.md`, whose digest is `fbcc99318690e12b9f38dc1abca2f792f07ca366ce952092634726c026dd6273`. **Proof:** `git show --stat` of that commit and `design-review-evidence.mjs digest` on its version.
- [ ] SC13: the amendment changes only the lines the design names (line 19 within its limit, line 29, lines 39 to 44, the OUT list, the Approach, the Simplicity Case and the evidence block). **Proof:** `git diff <G1 first commit>..HEAD -- .genie/brainstorms/genie-launch/DESIGN.md`.
- [ ] SC14: the amended `genie-launch` design carries a fresh independent SHIP stamp. **Proof:** `design-review-evidence.mjs verify` exits 0 and `bun run check` is green.
- [ ] SC15: the test passes on both required CI legs and the full gate is green. **Proof:** `bun run check` locally, and the `unit` and `unit-darwin` checks on the genie PR.
- [ ] SC16: the docs PR adds exactly the 18 files `genie/images/skills/*.svg`, and `--docs --check` exits 0 against it. **Proof:** `gh pr view --json files` on the docs PR, and the check on its branch.
- [ ] SC17: the `.docs-vendor` bump lands only after the docs PR merges, at a commit on docs `main`. **Proof:** `git -C .docs-vendor merge-base --is-ancestor HEAD origin/main` in the bump PR, created after the docs merge.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | orchestrator | Low: two tracking commits, no code | inherit | Track `genie-launch` DESIGN as stamped, then this design, wish and INDEX |

### Wave 2 (parallel, disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | Medium: new standalone script and its tests, ~250-350 lines plus ~250 test lines and three binary inputs; no coupling to existing code | inherit | Generator, fonts, OFL, logo, temp-root tests |
| 5 | engineer | Medium: prose amendment to an approved design under exact line limits, then an independent review loop | inherit | `genie-launch` amendment, re-review and re-stamp |

### Wave 3 (sequential, owner present)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | orchestrator | Medium: outward pushes to two repos and an owner checkpoint; the outcome can stop the wish | inherit | Render check of the `brainstorm` card on GitHub and Mintlify |

### Wave 4 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | Low: runs the generator and adds one test block, ~60-100 lines | inherit | Six README cards and the real-tree test block |

### Wave 5 (sequential, orchestrator)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 6 | orchestrator | Low: push, PR, read-back | inherit | Publish the genie PR to `dev` |
| 7 | orchestrator | Low: one generator run in the submodule, one PR | inherit | automagik-dev/docs PR with the 18 SVGs |
| 8 | orchestrator | Low: waits on the owner's docs merge; one pointer commit | inherit | `.docs-vendor` bump PR and throwaway-branch cleanup |

**Global constraints:**
- No new entry in `dependencies` and no image tooling in `devDependencies` (R1-1). YAML is parsed with `Bun.YAML.parse`, as `scripts/release-docs.test.ts` does.
- Fonts and logo are copied byte for byte from the main checkout, never downloaded or re-exported. Source `/home/genie/workspace/repos/genie/.orca/drops/launch/render-src/fonts/gyByhwUxId8gMEwcGFU.woff2` → `scripts/skill-card-images/fonts/geist-latin.woff2`, sha256 `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1`. Source `/home/genie/workspace/repos/genie/.orca/drops/launch/render-src/fonts/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2` → `scripts/skill-card-images/fonts/jetbrains-mono-latin.woff2`, sha256 `83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be`. Source `/home/genie/workspace/repos/genie/.genie/brainstorms/genie-launch/genie-logo.png` → `scripts/skill-card-images/genie-logo.png`, sha256 `5aa731cfe324401368bb5c8bd79efeec52fb880eb7116fe543f3a26f20106507`.
- Design B tokens as constants, citing `GENIE-DESIGN-TOKENS.md`: surface `#0B0B12`, border `#2A2438`, text `#E8E6F0`, magenta `#FF3FF5`, cyan `#5EF2FF`. Glow (`feGaussianBlur`) on the accents only.
- Font stacks verbatim: `Geist, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif` (title, line) and `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (commands).
- Canvas `viewBox="0 0 800 400"`. Line wrap at most two lines of 34 characters, at the space that minimizes the longer line (a tie goes to the earlier space). Refuse a `short_description` over 68 characters or needing three lines, and a `display_name` over 24 characters, with exit 1 and nothing written.
- Core skills constant, in this order: `brainstorm`, `wish`, `work`, `review`, `council`, `fix`.
- No test writes into the real tree or the docs submodule: the write path takes the repository root as a parameter.
- `README.md`, any docs page and the `.docs-vendor` pointer stay untouched in the first genie PR. The pointer is bumped only after the docs PR merges (CLAUDE.md, Docs).
- Stable targets Linux and macOS (`unit` and `unit-darwin`). No platform literal in a test without checking both legs.
- Host umask is 0077: run `umask 022` in every shell of a fresh worktree and normalize file modes before committing.
- Biome: single quotes, 2-space indent, 120 width, trailing commas. `scripts/**` allows `console`. `tsc` covers only `src/**` and Bun strips types without checking them, so nothing type-checks the script; keep its types simple and let the tests carry correctness.
- Conventional commits (commitlint). A pre-commit "CI is red" block is bypassed with `SKIP_CI_CHECK=1` only for ledger commits.

## Execution Groups

### Group 1: Track the designs

**Goal:** the genie PR's first commit adds the stamped `genie-launch` design and nothing else, and a second commit tracks this design, this wish and their INDEX entries.

**Deliverables:**
1. Commit 1 on `wish/skill-cards` (cut from `origin/dev`): `.genie/brainstorms/genie-launch/DESIGN.md`, copied byte for byte from the main checkout, mode 100644. Message `docs(genie-launch): track the stamped launch design`. Both G1 commits are made from a linked worktree of the clone (`git worktree add`; the clone's main worktree is detached first with `git switch --detach`, so the branch is free to check out there), where `.husky/pre-commit` skips its board sync, so the hook cannot add `.genie/roadmap.json`. Before committing, `git diff --cached --name-only` must print exactly that one path. Any board change (task rows for the groups) is committed with commit 2 or later.
2. Commit 2: `.genie/brainstorms/skill-cards/DESIGN.md` (as stamped), `.genie/wishes/skill-cards/WISH.md` (APPROVED, with its plan-review evidence), and `.genie/INDEX.md` entries. `genie-launch` goes under Ready (design SHIP, its wish waits for G5) and `skill-cards` under Poured (APPROVED).

**Interfaces:**
- Consumes: none.
- Produces: the commit sha of commit 1 (`<G1-first>`), which SC12 and SC13 name.

**Acceptance Criteria:**
- [ ] SC12.
- [ ] `design-review-evidence.mjs verify` exits 0 for both designs at commit 2.
- [ ] `genie wish lint` exits 0.

**Validation:**
```bash
FIRST=$(git rev-list --reverse origin/dev..HEAD | head -1) && test "$(git show --name-only --format= "$FIRST")" = ".genie/brainstorms/genie-launch/DESIGN.md" && T=$(mktemp) && git show "$FIRST":.genie/brainstorms/genie-launch/DESIGN.md > "$T" && test "$(node skills/brainstorm/references/design-review-evidence.mjs digest "$T")" = fbcc99318690e12b9f38dc1abca2f792f07ca366ce952092634726c026dd6273 && node skills/brainstorm/references/design-review-evidence.mjs verify .genie/brainstorms/genie-launch/DESIGN.md && node skills/brainstorm/references/design-review-evidence.mjs verify .genie/brainstorms/skill-cards/DESIGN.md && genie wish lint
```

**depends-on:** none

---

### Group 2: Generator, inputs and temp-root tests

**Goal:** a byte-stable generator that turns a skill's `agents/openai.yaml` into its card SVG, with every refusal and property proven over temporary roots.

**Deliverables:**
1. `scripts/skill-card-images.ts` (design Approach, IN #1). No-flag mode writes the six README cards. `--docs` writes the 18 docs cards through `docs/images/skills/`. `--check` compares in memory without writing.
2. `scripts/skill-card-images/fonts/geist-latin.woff2`, `scripts/skill-card-images/fonts/jetbrains-mono-latin.woff2`, `scripts/skill-card-images/fonts/OFL.txt` (both upstream copyright lines above one SIL OFL 1.1 text), and `scripts/skill-card-images/genie-logo.png`, all per Global constraints.
3. `scripts/skill-card-images.test.ts` with every test over a temporary root: wrap balance and tie, both length refusals and the three-line refusal (nothing written), XML escape, byte stability, no `@import` or `http` beyond `xmlns`, `data:` hrefs only, font stacks (SC9 over a rendered card), `--check` 0 then 1 after a YAML change with no write (SC3), `--docs` refusal on a dangling `docs` symlink (SC7), and CLI exit codes (0, 1, 2 on an unknown flag).
4. No `.svg` file is written anywhere in the repository by this group (Decision 2).

**Interfaces:**
- Consumes: none.
- Produces, all exported from `scripts/skill-card-images.ts`:
  - `export const CORE_SKILLS: readonly ['brainstorm', 'wish', 'work', 'review', 'council', 'fix']`
  - `export class SkillCardError extends Error {}`, the refusal type (CLI exit 1).
  - `export interface SkillCardText { name: string; title: string; lines: string[]; slash: string; dollar: string }`
  - `export function wrapLine(text: string): string[]` returns one or two lines of at most 34 characters, and throws `SkillCardError` past 68 characters or when it would need three lines.
  - `export function readSkillCardText(root: string, name: string): SkillCardText` reads `<root>/skills/<name>/agents/openai.yaml` and throws `SkillCardError` on a title over 24 characters or a line that does not wrap.
  - `export function renderSkillCard(root: string, name: string): string` returns the full SVG text. It is pure and byte-stable, and reads the fonts and logo from `<root>/scripts/skill-card-images/`.
  - `export function readmeCardPath(root: string, name: string): string` returns `<root>/.github/assets/skill-<name>.svg`.
  - `export function docsCardPath(root: string, name: string): string` returns `<root>/docs/images/skills/<name>.svg`.
  - `export function docsSkillNames(root: string): string[]` returns every `skills/*/` holding a `SKILL.md`, sorted.
  - `export function writeSkillCards(root: string, opts?: { docs?: boolean }): string[]` renders every card first and writes only when all rendered, returning the written paths. With `docs`, it throws `SkillCardError` and creates nothing when `<root>/docs` does not resolve to a directory.
  - `export function checkSkillCards(root: string, opts?: { docs?: boolean }): { ok: boolean; differing: string[] }` writes nothing. With `docs`, it throws `SkillCardError` (exit 1) when `<root>/docs` does not resolve to a directory (design Risk 5).
  - `export async function main(argv: string[], root: string = resolve(import.meta.dir, '..')): Promise<number>` returns 0 ok, 1 refusal or difference, 2 usage. The command line passes the real root through the default; every test passes a temporary root. The entry guard is `if (import.meta.main) process.exit(await main(process.argv.slice(2)))`.

**Acceptance Criteria:**
- [ ] SC3, SC5, SC6, SC7, SC9 and SC10 hold, over temporary roots.
- [ ] Rendering the same root twice returns identical strings (SC4's in-memory half).
- [ ] `git status --porcelain` after the test run shows no file outside this group's declared set.

**Validation:**
```bash
# run in G2's worktree at G2's head, right after its commit; later groups add cards by design, so this holds at G2 completion only
umask 022 && bun test scripts/skill-card-images.test.ts && bunx biome check scripts/skill-card-images.ts scripts/skill-card-images.test.ts && printf '%s  %s\n' 19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1 scripts/skill-card-images/fonts/geist-latin.woff2 83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be scripts/skill-card-images/fonts/jetbrains-mono-latin.woff2 5aa731cfe324401368bb5c8bd79efeec52fb880eb7116fe543f3a26f20106507 scripts/skill-card-images/genie-logo.png | sha256sum -c - && grep -Eq '^Copyright.*(Geist|Vercel)' scripts/skill-card-images/fonts/OFL.txt && grep -Eq '^Copyright.*JetBrains' scripts/skill-card-images/fonts/OFL.txt && test -z "$(git status --porcelain)" && test -z "$(git ls-files '.github/assets/skill-*.svg')"
```

**depends-on:** 1

---

### Group 3: Render check

**Goal:** confirm through `<img>` on GitHub and in a Mintlify preview that the `brainstorm` card's embedded fonts, logo and glow render, and decide by R5-1 whether the work continues.

**Deliverables:**
1. A throwaway genie branch `render-check/skill-cards`, cut from `origin/dev`, holding `.github/assets/skill-brainstorm.svg` (written with `renderSkillCard(root, 'brainstorm')` from G2's head) and a scratch `render-check.md` at the root with `<img src=".github/assets/skill-brainstorm.svg" width="400">`. It is pushed, and viewed at `https://github.com/automagik-dev/genie/blob/render-check/skill-cards/render-check.md`.
2. A throwaway automagik-dev/docs branch `render-check/skill-cards`, cut from docs `main`, holding `genie/images/skills/brainstorm.svg` (the same bytes) and a temporary `genie/render-check.mdx` with `<img src="/genie/images/skills/brainstorm.svg" />`. It is pushed, with a draft PR when the preview needs one, and that PR is closed unmerged after the check.
3. A screenshot of each view, taken with the host's Playwright Chromium at desktop width, committed on `wish/skill-cards` as `.genie/wishes/skill-cards/evidence/render-github.png` and `.genie/wishes/skill-cards/evidence/render-mintlify.png`. A `## Render check` block in this WISH.md records the two URLs and, per platform, whether fonts, logo and glow rendered.
4. The owner checkpoint: the screenshots and the per-platform table go to the owner through the question harness. The outcome follows R5-1. When everything renders, or only the fonts fail on a platform, the work continues to G4, and a font-only failure is named as the R5-1 fallback. When the logo or the glow fails on either platform, the wish stops here as BLOCKED and goes back to the owner.

**Interfaces:**
- Consumes: `renderSkillCard(root, 'brainstorm')` from G2.
- Produces: the render-check outcome (`continue` or `continue-with-system-fonts:<platform>` or `stop`), the two URLs and the two screenshot paths, all consumed by G6's PR body.

**Acceptance Criteria:**
- [ ] SC8, except its PR-body clause, which G6 completes.
- [ ] Neither `render-check.md` nor `render-check.mdx` exists on `wish/skill-cards` or on any branch that becomes a PR head.
- [ ] No `.github/assets/skill-*.svg` is committed on `wish/skill-cards` before the evidence commit.

**Validation:**
```bash
git ls-files --error-unmatch .genie/wishes/skill-cards/evidence/render-github.png .genie/wishes/skill-cards/evidence/render-mintlify.png >/dev/null && grep -q '^## Render check' .genie/wishes/skill-cards/WISH.md && test -z "$(git ls-files 'render-check.md' 'render-check.mdx')" && E=$(git log -1 --format=%H --diff-filter=A -- .genie/wishes/skill-cards/evidence/render-github.png) && for C in $(git log --format=%H --diff-filter=A origin/dev..HEAD -- '.github/assets/skill-*.svg'); do test "$C" != "$E" && git merge-base --is-ancestor "$E" "$C" || exit 1; done
```

**depends-on:** 2

---

### Group 4: The six README cards

**Goal:** generate and commit the six README cards, and prove them against each skill's YAML in `bun test`.

**Deliverables:**
1. `.github/assets/skill-brainstorm.svg`, `skill-wish.svg`, `skill-work.svg`, `skill-review.svg`, `skill-council.svg` and `skill-fix.svg`, written by `bun scripts/skill-card-images.ts`.
2. A real-tree block appended to `scripts/skill-card-images.test.ts`. For each of `CORE_SKILLS` it checks that the file exists with `viewBox="0 0 800 400"` (SC1), that the text nodes equal the YAML (SC2), the font stacks (SC9), `data:` hrefs and no `http` beyond `xmlns` (SC5), and that `checkSkillCards(realRoot)` returns `ok: true` (SC3's clean-tree half). It only reads.

**Interfaces:**
- Consumes: `CORE_SKILLS`, `readmeCardPath`, `readSkillCardText`, `checkSkillCards` from G2, and the G3 outcome `continue` or `continue-with-system-fonts:<platform>`.
- Produces: the six committed SVGs that G6 publishes and the README section of `genie-launch` group A will embed.

**Acceptance Criteria:**
- [ ] SC1, SC2, SC4 and SC11.
- [ ] The cards' adding commit comes after G3's evidence commit (SC8's ordering clause).

**Validation:**
```bash
# run after G4's commit, so the regeneration is compared with committed bytes
umask 022 && test "$(git ls-files '.github/assets/skill-*.svg' | wc -l)" = 6 && bun scripts/skill-card-images.ts && git diff --exit-code .github/assets && bun scripts/skill-card-images.ts --check && bun test scripts/skill-card-images.test.ts && git diff --exit-code origin/dev...HEAD -- README.md package.json bun.lock && E=$(git log -1 --format=%H --diff-filter=A -- .genie/wishes/skill-cards/evidence/render-github.png) && for C in $(git log --format=%H --diff-filter=A origin/dev..HEAD -- '.github/assets/skill-*.svg'); do test "$C" != "$E" && git merge-base --is-ancestor "$E" "$C" || exit 1; done && bun run check
```

**depends-on:** 3

---

### Group 5: Amend, re-review and re-stamp `genie-launch`

**Goal:** the `genie-launch` design says what this work changed, and it carries a fresh independent SHIP stamp over the amended content.

**Deliverables:**
1. One commit amending `.genie/brainstorms/genie-launch/DESIGN.md` with exactly the edits of design IN #7. Group C's card step (R1-4). The OUT line "adding CI for media" becomes "a bun test checks the six README cards; CI renders nothing" (R2-2). Group B's item 4 (line 29) and group C's docs-assets line (line 41) name the 18 cards from `genie/images/skills/<name>.svg`. Group A's line 19 keeps the six core cards and gains at most the `.github/assets/skill-<name>.svg` path and group A as placement owner. The placement owners are named. The Approach and Simplicity Case lines say the card images land ahead of their pages, and the "Added machinery" line names `scripts/skill-card-images.ts` plus one bun test, with the SOP videos still on the scratchpad pipeline.
2. An independent design review of the amended file under `skills/review/SKILL.md`, by an agent that did not write the amendment and is read-only. Its verdict is stamped as returned with `node skills/brainstorm/references/design-review-evidence.mjs stamp`, using the reviewer's digest unchanged. A FIX-FIRST gets up to `genie config get budgets.maxEscalationsPerGroup` repairs, each re-reviewed and re-stamped. Past the budget, or on BLOCKED, the group stops and goes to the owner.
3. G5 works in its own worktree. Its commits (the amendment, then each stamp and repair) merge into `wish/skill-cards` only once a SHIP stamp verifies, so the integration branch never carries a stale evidence block.

**Interfaces:**
- Consumes: `<G1-first>` from G1, the stamped file in that commit.
- Produces: the re-stamped `genie-launch` design (SHIP, new digest), which unblocks any future `genie-launch` wish.

**Acceptance Criteria:**
- [ ] SC13 and SC14.
- [ ] The amendment commit touches only `.genie/brainstorms/genie-launch/DESIGN.md`.

**Validation:**
```bash
node skills/brainstorm/references/design-review-evidence.mjs verify .genie/brainstorms/genie-launch/DESIGN.md && grep -q 'skill-card-images.ts' .genie/brainstorms/genie-launch/DESIGN.md && genie wish lint
```

**depends-on:** 1

---

### Group 6: Publish the genie PR

**Goal:** a merge-ready genie PR to `dev` carrying G1 through G5, with the render evidence in its body.

**Deliverables:**
1. Push `wish/skill-cards` and open a PR to `dev`. The body covers the design and wish links, the render-check table, both URLs, both screenshots embedded from `.genie/wishes/skill-cards/evidence/`, the R5-1 fallback when one applies, the `bun run check` exit code and every review verdict.
2. `bun run check` on the final head (G4 and G5 merged), then read-back of the remote head against the local head, the PR's base and head, its file set (no `render-check.*`, no `README.md`, no `.docs-vendor`), and the two `Unit (…)` checks. `dev` has no required checks configured, so the read-back names the two checks instead of `gh pr checks --required`.
3. An independent PR review scoring the exact head sha against these success criteria. The merge stays with the operator.

**Interfaces:**
- Consumes: every earlier group's commits and G3's outcome and evidence.
- Produces: the PR number and its SHIP verdict, which G7 waits for.

**Acceptance Criteria:**
- [ ] SC8 (PR-body clause), SC11, SC12 and SC15, with the screenshots embedded by sha-pinned absolute URLs (Decision 4).

**Validation:**
```bash
# PR is the number of the genie PR opened by this group
set -o pipefail; bun run check && test "$(git rev-parse HEAD)" = "$(gh pr view "$PR" --json headRefOid --jq .headRefOid)" && test "$(gh pr view "$PR" --json baseRefName --jq .baseRefName)" = dev && FILES=$(gh pr view "$PR" --json files --jq '.files[].path') && test -n "$FILES" && ! printf '%s\n' "$FILES" | grep -Eq '(^README\.md$|render-check|^\.docs-vendor$)' && gh pr checks "$PR" --json name,bucket --jq '[.[]|select(.name|startswith("Unit ("))|.bucket]|(length==2 and all(.=="pass"))' | grep -qx true
```

**depends-on:** 4, 5

---

### Group 7: The docs PR

**Goal:** automagik-dev/docs gets exactly the 18 skill card SVGs from the final generator.

**Deliverables:**
1. In the clone's `.docs-vendor`, a branch `feat/genie-skill-card-images` from `origin/main`. Run `bun scripts/skill-card-images.ts --docs` from the genie root at the head G6's review passed, stage only `genie/images/skills/*.svg`, commit `docs(genie): add skill card images`, push, and open a PR to `main`. The genie superproject's `.docs-vendor` change stays unstaged.
2. `bun scripts/skill-card-images.ts --docs --check` exits 0 on that branch.

**Interfaces:**
- Consumes: `writeSkillCards(root, { docs: true })` and `checkSkillCards(root, { docs: true })` at the reviewed head.
- Produces: the docs PR number. The owner merges it, since docs `main` is the base.

**Acceptance Criteria:**
- [ ] SC16.
- [ ] `git -C .docs-vendor diff --name-only origin/main...HEAD` lists exactly 18 paths, all `genie/images/skills/*.svg`.

**Validation:**
```bash
test "$(git -C .docs-vendor diff --name-only origin/main...HEAD | grep -c '^genie/images/skills/[a-z-]*\.svg$')" = 18 && test "$(git -C .docs-vendor diff --name-only origin/main...HEAD | wc -l)" = 18 && bun scripts/skill-card-images.ts --docs --check
```

**depends-on:** 6

---

### Group 8: Pointer bump and cleanup

**Goal:** after the owner merges the docs PR, genie points at a docs `main` that holds the 18 cards, and the throwaway branches are gone.

**Deliverables:**
1. A branch `chore/bump-docs-skill-cards` from `origin/dev`. Run `git submodule update --remote .docs-vendor`, check that `git -C .docs-vendor merge-base --is-ancestor HEAD origin/main` holds and that `.docs-vendor/genie/images/skills/` has 18 SVGs, commit `chore: bump .docs-vendor to docs main`, and open a PR to `dev`.
2. After the genie PR from G6 merges, delete `render-check/skill-cards` on both repositories and close the draft docs render-check PR if one was opened.
3. Gate the bump PR: `bun run check` on its head, then read back its two `Unit (…)` checks and every job of the `Docs Lint` workflow, which `.docs-vendor` changes trigger (on #3071: `markdownlint-cli2`, `markdown-link-check`, `Retired terminology (docs/)`).
4. Persist the wish status: SHIPPED once both genie PRs and the docs PR are merged.

**Interfaces:**
- Consumes: the docs PR merge (owner) and the G6 PR merge (operator).
- Produces: none.

**Acceptance Criteria:**
- [ ] SC17.
- [ ] `git ls-remote --heads` on both repositories lists no `render-check/skill-cards`.
- [ ] Any docs PR from `render-check/skill-cards` is closed and unmerged.
- [ ] The bump PR's two `Unit (…)` checks and every `Docs Lint` job pass.

**Validation:**
```bash
# BUMP is the number of the bump PR
set -o pipefail; git -C .docs-vendor merge-base --is-ancestor HEAD origin/main && test "$(ls .docs-vendor/genie/images/skills/*.svg | wc -l)" = 18 && bun run check && gh pr checks "$BUMP" --json name,workflow,bucket --jq '([.[]|select(.name|startswith("Unit ("))]|length==2 and all(.bucket=="pass")) and ([.[]|select(.workflow=="Docs Lint")]|length>=1 and all(.bucket=="pass"))' | grep -qx true && test -z "$(git ls-remote --heads https://github.com/automagik-dev/genie render-check/skill-cards)" && test -z "$(git ls-remote --heads https://github.com/automagik-dev/docs render-check/skill-cards)" && gh pr list --repo automagik-dev/docs --head render-check/skill-cards --state all --json state,mergedAt --jq 'all(.state=="CLOSED" and .mergedAt==null)' | grep -qx true
```

**depends-on:** 7

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] On `dev` after the genie PR merges, `bun scripts/skill-card-images.ts --check` exits 0, and the six cards open in a browser through `<img>` with title, line, `/name` and `$name` readable.
- [ ] Changing one core skill's `short_description` on a scratch branch makes `bun test scripts/skill-card-images.test.ts` fail and names that card. Rerunning the generator makes it pass.
- [ ] After the bump PR merges, `docs/images/skills/` in a fresh clone with `git submodule update --init` holds 18 SVGs, and `--docs --check` exits 0.
- [ ] `bun run check` on `dev` stays green on both CI legs, and no existing test changed.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Mintlify Deployment showed `skipping` on the last two automagik-dev/docs PRs (#85, #86), so a preview for the render-check branch may not appear | Medium | G3 opens the draft PR and waits for the Mintlify check. If it skips, G3 stops and asks the owner whether to enable previews or accept a local `mint dev` view as the Mintlify evidence. It is never substituted silently |
| The logo or glow fails to render on one platform | Medium | R5-1: the wish stops after G3 as BLOCKED and goes back to the owner. Nothing past G3 has been built |
| A GitHub or Mintlify view needs a login the headless browser lacks | Low | Both repositories are public. If a view still needs a login, the owner takes that screenshot during the G3 checkpoint |
| A generator repair after the docs PR opened would make the docs cards differ | Low | G7 starts only after G6's review is SHIP (Decision 6), and `--docs --check` runs on the docs branch |
| The `genie-launch` re-review keeps returning FIX-FIRST | Medium | Bounded by `budgets.maxEscalationsPerGroup`, then the owner decides. G5 runs in parallel with G2, so it does not delay the card work |
| The design's sources (fonts, logo, `genie-launch` DESIGN) live only in the main checkout, which has been reset before | Medium | The sha256 values are pinned in Global constraints. A worker that finds a mismatch stops; it never downloads a substitute |
| Card weight, about 130 KB each | Low | Accepted by the design. Per-card subsetting is deferred to its trigger |

---

## Render check

G3, 2026-10-02. The `brainstorm` card, rendered with `renderSkillCard(root, 'brainstorm')` at `f5247ca5e` (127,284 bytes), was viewed through `<img>` in each placement context. Outcome: **continue**. Fonts, logo and glow render on both platforms, so no R5-1 fallback applies.

| Platform | Context | Fonts | Logo | Glow | Evidence |
|---|---|---|---|---|---|
| GitHub | `render-check.md` on throwaway branch `render-check/skill-cards` (`9a21a6ae0`), `<img src=".github/assets/skill-brainstorm.svg" width="400">`, served from `github.com/.../raw/...` | rendered (Geist, JetBrains Mono) | rendered | rendered | [render-github.png](evidence/render-github.png); https://github.com/automagik-dev/genie/blob/render-check/skill-cards/render-check.md |
| Mintlify | `genie/render-check.mdx` on throwaway docs branch `render-check/skill-cards`, `<img src="/genie/images/skills/brainstorm.svg" />`, rendered by `mint dev` 4.2.970 | rendered (Geist, JetBrains Mono) | rendered | rendered | [render-mintlify.png](evidence/render-mintlify.png) |

- Font proof: each platform's `<img>` capture was compared with two local Chromium renders of the same card, one as shipped and one with its `@font-face` block removed (which falls back to DejaVu). GitHub differs 1.98% from the as-shipped render and 4.56% from the fallback; Mintlify 1.82% and 4.29%. The glyph shapes match Geist and JetBrains Mono.
- Mintlify substitute, approved by the owner: the draft docs PR [automagik-dev/docs#87](https://github.com/automagik-dev/docs/pull/87) got no preview ("Mintlify Deployment: Skipping deployment — No eligible deployments found for changes"). Per this plan's risk row the check stopped and asked; Felipe chose "Render local com mint dev". The local renderer draws the same `<img>` in the same browser engine; what it does not exercise is the hosted CDN's response headers. #87 is closed unmerged.
- Owner checkpoint: Felipe approved the card visually ("Aprovado") and the Mintlify substitute on 2026-10-02.
- Neither `render-check.md` nor `render-check.mdx` exists on `wish/skill-cards` or on any PR head; both throwaway branches are deleted in G8.

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review 1 — 2026-10-02T02:01:28Z — FIX-FIRST

- Reviewer: claude-opus-5-5, independent read-only plan reviewer. Plan sha256 `6ce4c355a02804c01e6394f9c803847ae1662c8f21402619aea682f1c36e6a18`.
- HIGH-1: G6 used `gh pr checks --required`, which exits 1 on every `dev` PR because `dev` has no required checks, and its file-set pipeline passed when `gh` failed. Repaired: G6 runs `bun run check` on the final head and reads back head, base, file set and the two `Unit (…)` checks by name, with `pipefail`.
- MEDIUM-1: `main` had no root parameter. Repaired: `main(argv, root = resolve(import.meta.dir, '..'))`, tests pass a temporary root, and `checkSkillCards` with `docs` refuses when `docs/` does not resolve.
- MEDIUM-2: the OFL copyright check passed on the bare license. Repaired: two anchored greps, one per font.
- MEDIUM-3: the pre-commit board sync could add `.genie/roadmap.json` to commit 1. Repaired: G1 commits from a linked worktree, where the hook skips the sync, and asserts the staged set first.
- LOW-1 to LOW-6 repaired: the type-check claim reworded; G1 compares the reviewed digest; G3 and G4 check card ordering through history; G4 runs after its commit and also diffs `package.json` and `bun.lock`; PR-body images use sha-pinned absolute URLs; G8 checks the render-check docs PR is closed unmerged and gates the bump PR (`bun run check`, two `Unit (…)` checks and every `Docs Lint` job, a query verified on #3071).

### Plan review 2 — 2026-10-02T02:06:32Z — SHIP → APPROVED

- Reviewer: claude-opus-5-5, independent read-only plan reviewer (same reviewer as review 1, re-checking its own findings under the frozen criteria). Plan sha256 `1210fb84c1bf39cb754d719f97faf07f8771513b5d0c568ffb78df291090bcc7`.
- All seven blocking findings of review 1 verified fixed, with the G6/G8 queries run on #3089 and #3071 and the G3/G4 ordering loop exercised in scratch repos.
- Three non-blocking LOWs, applied after the verdict and changing nothing else: LOW-1 G1 detaches the clone's main worktree before adding the linked one; LOW-2 G2's validation is marked as holding at G2's head only; LOW-3 G4 and SC11 diff against `origin/dev...HEAD` (merge base), not a moving `origin/dev`.
- Owner approval: Felipe, 2026-10-02, "aprovado, pode executar quando o review sair SHIP". Status persisted as APPROVED by the orchestrator.

---

### Group 1 — 2026-10-02T02:09Z — orchestrator, validated

- Commits `9ff079539` (the stamped `genie-launch` DESIGN.md alone, digest `fbcc9931…`) and `2b36ebd7a` (this design, this wish, INDEX entries, the eight group cards in `roadmap.json`), both from the linked worktree. The G1 validation block exits 0.
- Ruling: no separate reviewer for G1, since it changes no code and its criteria are mechanical; the G6 PR review re-scores SC12.

### Group 5 review — 2026-10-02T02:16:09Z — SHIP

- Amendment `836356766` by g5-engineer; independent design review by claude-opus-5-5 (read-only), reviewed digest `d7aa88ec09652a459815e9c63b5ca664d99a780354c37279d836d1b70c1f1a87`, stamped as returned in `55651b5b5`; merged `--no-ff` as `a66b6d081`. The G5 validation block exits 0.
- Criteria: IN #7 edits all made and nothing extra; every hunk inside the SC13 regions with the evidence block untouched; internally consistent (six README cards, 18 docs cards, CI wording, placement owners); consistent with R1-4, R2-2, R2-3, R3-4, R4-2; untouched content still holds. All four worker rulings accepted.
- Carried to the future `genie-launch` wish, non-blocking: LOW-1, group C still lists the card images as its assets, so its plan must not schedule a card task (the skill-cards wish delivers them); LOW-2, no `genie-launch` success criterion checks that groups A and B place the cards, so that plan adds one placement check per group.

### Group 2 review — 2026-10-02T02:44:28Z — FIX-FIRST → repair 1 → repair 2 → SHIP

- g2-engineer commits `ed469f4c9` (generator, fonts, OFL, logo, 25 temp-root tests), `371f03c9b` (repair 1), `4a0d821c5` (repair 2); merged `--no-ff` into `wish/skill-cards`. 32 tests in about 0.6 s; the Group 2 validation block and `bun run check:fast` exit 0; exports unchanged across both repairs; no `.svg` tracked.
- Criteria review (claude-opus-5-5, read-only): SHIP on `ed469f4` (C1-C18 pass) and SHIP again on `371f03c`.
- Quality pass (claude-opus-5-5, read-only, separate): FIX-FIRST on `ed469f4`, MEDIUM-1 writes followed symlinks (a committed symlinked card file, `.github/assets`, `docs` or `docs/images` pointing outside got overwritten, exit 0). Repair 1 guards every existing path component with `lstat` before the first write and requires `realpath(docs)` inside `.docs-vendor`; it also refuses non-XML, C1 and bidi code points, wraps write errors, and names the asset remedy. The re-review found one residual path, a symlinked `.docs-vendor` itself, closed by repair 2 (budget 2 of 2). Final verify SHIP on `4a0d821`.
- Rulings recorded for the owner:
  - The criteria reviewer accepted a symlinked `.docs-vendor` as a legitimate developer setup; the orchestrator ruled to refuse it, matching the repo's pattern for symlinked config roots (`mikro init`, `genie init`). Cost if wrong: a developer with a separate docs clone gets a clear refusal and uses the submodule.
  - The worker's ten rulings were accepted by the criteria review, notably: a skill name at most 12 characters matching `^[a-z0-9][a-z0-9-]*$` (one-row command layout; longest today 11), `--docs --check` compares exactly the 18 it writes, `--help` exits 0.
- Deferred, non-blocking: orphan detection in `--docs --check`; per-run caching of the asset data URIs; symlink-following on the read side; no `O_NOFOLLOW` on the final write (a race needs a concurrent writer in the checkout).
- Process note: in a worktree without `node_modules`, `bunx biome` resolves to an unrelated npm package named `biome` (0.3.3) that checks nothing and exits 0. Every validation in this wish runs `./node_modules/.bin/biome` after `bun install --frozen-lockfile`.
- The worker rendered all 18 cards into a scratchpad directory to eyeball layout in local Chromium; nothing was committed, and the criteria review judged it breaks no criterion. It is not SC8 evidence; G3 is.

---

## Files to Create/Modify

```
# automagik-dev/genie — PR 1 (wish/skill-cards → dev)
.genie/brainstorms/genie-launch/DESIGN.md          (G1 track as stamped; G5 amend + re-stamp)
.genie/brainstorms/skill-cards/DESIGN.md           (G1 track)
.genie/wishes/skill-cards/WISH.md                  (G1 track; G3 render-check block; status updates)
.genie/wishes/skill-cards/evidence/render-github.png    (G3)
.genie/wishes/skill-cards/evidence/render-mintlify.png  (G3)
.genie/INDEX.md                                    (G1 entries)
scripts/skill-card-images.ts                       (G2)
scripts/skill-card-images.test.ts                  (G2; G4 appends the real-tree block)
scripts/skill-card-images/fonts/geist-latin.woff2  (G2)
scripts/skill-card-images/fonts/jetbrains-mono-latin.woff2 (G2)
scripts/skill-card-images/fonts/OFL.txt            (G2)
scripts/skill-card-images/genie-logo.png           (G2)
.github/assets/skill-{brainstorm,wish,work,review,council,fix}.svg (G4)

# automagik-dev/docs — PR 2 (feat/genie-skill-card-images → main)
genie/images/skills/<name>.svg × 18                (G7)

# automagik-dev/genie — PR 3 (chore/bump-docs-skill-cards → dev)
.docs-vendor                                       (G8 pointer)

# throwaway, never merged: render-check/skill-cards on both repositories (G3, deleted in G8)
```
