# Wish: Genie launch foundation

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `genie-launch` |
| **Date** | 2026-10-02 |
| **Author** | Felipe Rosa |
| **Appetite** | large |
| **Branch** | `wish/genie-launch` |
| **Repos touched** | automagik-dev/genie, automagik-dev/docs, automagik-dev/.github, the automagik-dev and namastex888 GitHub profiles |
| **Design** | [DESIGN.md](../../brainstorms/genie-launch/DESIGN.md) |

## Summary

This wish rebuilds every surface a launch visitor reaches:

- **README:** rewritten skills first. Its retirement prose moves verbatim to a new `UPGRADING.md`.
- **Docs:** the genie docs section shrinks from 65 nav pages to at most 15 v6 pages.
- **Media:** six SOP videos made from real captures, plus an animated mascot loop.
- **Org and profile pages:** updated, with Felipe approving each write.

The design is reviewed SHIP and was amended on 2026-10-02 for the owner's decisions of that day. The skill card images it needs already shipped through the skill-cards wish.

## Scope

### IN

- G1: track this wish and refresh its INDEX entry and the board snapshot.
- G2: real captures of `/work`, `/review`, `/council` and `/fix` in a throwaway repository, and redaction of all six SOP captures. The six include the existing `/brainstorm` capture and the V2 `/wish` capture.
- G3: the animated mascot loop with the GENIE wordmark, as a README GIF and a docs MP4. This needs a looping-lockup mode in the scratchpad rig.
- G4: six SOP videos labelled "simulated", plus the V2 `/wish` capture video for Quickstart. Each comes with a redacted capture transcript.
- G5: `UPGRADING.md` receives the retirement, rollback, restore, MCP and Orca prose verbatim, and the README tests follow it.
- G6: the README rewrite and the `package.json` description link.
- G7: the docs nav, page stubs, `docs-checks.sh`, the "RLMX" label, and the one Install link to `concepts/byoa`.
- G8, G9, G10: the docs moves and deletes, in three batches of at most 25 files each.
- G11, G12: the docs core pages, in two batches.
- G13: the docs pages for the six core skills.
- G14: the genie PR.
- G15: the docs PR, and closing docs#84.
- G16: the `.docs-vendor` bump after the docs merge.
- G17: the org and profile pages (design group D).

### OUT

- Everything on the design's OUT list:
  - the launch posts;
  - the hero videos V1/V2/V3 and the bar-chart race;
  - Reddit, HN, the essay and beta outreach;
  - NMSTX-766, 767 and 768;
  - any docs framework or site-wide theme change;
  - media in CI;
  - Omni in the genie README and in the `genie/` docs.
- Fixing or replacing the Mintlify deployment. Putting B live belongs to Felipe's coming migration off Mintlify (design Decision 10).
- Any change to `src/`, `skills/`, the release workflows, or `package.json` beyond the one description link.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | The design is taken as amended and re-stamped on 2026-10-02. This plan adds only sequencing and the rulings below | The design is reviewed. Reopening it belongs in `brainstorm` |
| 2 | Counts and the CLI paste are read at the newest stable tag at the moment G6, G11 and G12 write copy, and that tag is named on the page. Today it is v6.261002.2: 18 skills, 12 workflows, 16 commands | Design Decision 9 |
| 3 | The README move (G5) and the README rewrite (G6) are separate groups on the same file, run in that order. SC2 is proven at G5's commit | G5 is mechanical and proven by a verbatim diff. G6 is new copy. One diff would hide a lost paragraph |
| 4 | The new README keeps every string the release-docs tests pin outside the moved text: "16 CLI commands" (read at the tag); a `\| \`genie <cmd>\`` table of all 16 commands, `orca` and `help` included; "design review", "plan review" and "implementation review"; "Genie ships exactly two surfaces"; the channel-authority line; `npx skills add automagik-dev/genie`; `skills-install.json`; `~/.agents/skills`; and `skills: skipped (consent: none)`, whose README:39 sentence stays. T2, T3 and T6 read README and UPGRADING concatenated, so their negative checks still cover README. The restore test reads `UPGRADING.md` | "Retargeted, not narrowed" (design) |
| 5 | A capture transcript is the redacted plain text of the real run's final screen and scrollback, the command and its output, at most 150 lines. Every cut in a longer run is marked inline as `[… N lines elided …]`. It ships in the docs repo at `captures/genie/<skill>.capture.txt`, outside `genie/`, so real program output such as `council.js` stays verbatim (the CI retired-terminology grep scans only `genie/`); session IDs printed by the program stay visible (owner decisions 2026-10-02). | "A saved capture file next to its source", at a reviewable size. The raw ANSI frame archives stay in the scratchpad |
| 6 | Real captures are recorded the way V2 was: an interactive session in tmux, with `capture-pane -e` frames to disk, in a throwaway repository cut from a small fixture | The method is proven, and it never touches real work |
| 7 | The docs moves follow one rule. Pages with engineering value move to `genie/_internal/`, including `concepts/byoa` and `release-process`. v4-only pages and the retired skills' pages (brain, learn, pm, trace, wizard) are deleted. `genie/hacks` and `genie/security/key-rotation` stay at their paths outside the nav, count as public pages, and are brought up to v6 | Design B, as amended |
| 8 | Forge's 28 open issues and 6 open PRs are each closed with one approved comment pointing to genie. Forge is archived after that | Design D, as amended. PRs were included by owner decision on 2026-10-02 |
| 9 | Felipe does these steps himself, from exact instructions: the org description (it needs an org owner with `admin:org`; automagik-genie is a member with `repo` scope); the 4 org pins and the namastex888 pins (GitHub has no API for pins); and every namastex888 write (bio, profile README, archives). The agent never switches the `gh` account to namastex888 | The token here is automagik-genie |
| 10 | G14 (genie) and G15 (docs) have no order between them. G17 starts only after G14's merge has been promoted to `main` and G15 has merged. G16 starts only after G15 has merged | Design Approach, as amended. Each validation checks the merge it waits on |
| 11 | All docs work happens in one dedicated worktree, `scratchpad/wishrun/wt-docs`: a genie worktree detached at `origin/dev` whose `.docs-vendor` checks out `feat/genie-v6-launch`. Nothing is ever committed in that worktree's superproject. The docs groups run in sequence on that one branch | One docs branch, no `.docs-vendor` gitlink near the genie PR, and genie's docs lints run against the branch |
| 12 | Numbers. Verbatim program output (captures, videos, the pasted CLI) and text moved verbatim into `UPGRADING.md` are exempt from the Allowed numbers list. All new copy follows the list. No figure on the not-allowed list appears anywhere, exempt output included, so no capture or paste of `genie wish report --summary` ships | Owner decision on 2026-10-02, recorded in the design |
| 13 | The launch waits for the `/wish` gate to work in any repository, which the sibling wish `wish-gate-any-repo` delivers. Its stable becomes the launch tag. G12 and G13 continue against v6.261002.2. G18 then moves every tag-bound line (Decision 2) to the new tag, and rewrites the Quickstart gate prerequisite and the README "Weak checks" line to match the shipped gate. G14 and G15 wait for G18 | Owner decision on 2026-10-02 (fix before the launch; docs continue), after the G11 review found the gate hardcodes `bun run check` and the husky pre-push hook |
| 14 | The README follows model A, demo first (G6b): a small mascot, the thesis verbatim, a looping GIF of the real `/wish` run (`.github/assets/wish-run.gif`, 1.85 MB, labelled as one sample, linking to the Quickstart video), the `/wish` sentence and the install. Reference blocks fold into `<details>`. G14's file set gains `.github/assets/wish-run.gif` | Owner decisions on 2026-10-02 and 2026-10-03: an analysis of 16 viral READMEs (`scratchpad/readme-viral/ANALYSIS.md`), then model A picked over the recommended C, the GIF hero chosen, and the final render approved |

## Simplicity Case

- **Simplest complete design:** the design's own. Static markdown, MDX, images and videos, with no runtime code.
- **Added machinery:** none in any repository. These throwaway scratchpad tools are never committed:
  - the capture recorder;
  - `redact.py`;
  - the rig's looping-lockup mode;
  - the SOP renderer;
  - `upgrading-diff.py`, `readme-checks.sh` and `docs-checks.sh`.

  One test path constant changes.
- **Deferred until measured:** the design's own list: a CLI-reference generator, a genie-only docs theme and PT docs. Going live waits for the Mintlify migration.
- **Complexity removed:**
  - 54 stale public pages;
  - the README's retirement first screen;
  - the duplicate headings, which survive only as verbatim history in `UPGRADING.md`.

## Dependencies

**depends-on:** skill-cards
**blocks:** none

## Success Criteria

These are the design's criteria as amended, each with its proof.

- [ ] **SC1:** the README first screen, up to the first `##` after the hero, holds the mascot, the one-paste install and the `/wish` transcript. It contains none of "retire", "rollback", "MCP", "Orca" or "npm". **Proof:** `readme-checks.sh`.
- [ ] **SC2:** `UPGRADING.md` exists, and every paragraph removed from README appears in it, `#### Restoring from a retirement backup` included. **Proof:** `upgrading-diff.py --base <merge-base> --head <G5 commit>` exits 0, with its output in the PR body.
- [ ] **SC3:** every skill in `SHIPPED_SKILLS` appears in the README catalog and on `genie/skills/index.mdx`. Every `.claude/workflows/*.js` name, without `.js` and `evidence-gate` included, appears in the README and on `genie/workflows.mdx`. **Proof:** `readme-checks.sh` and `docs-checks.sh workflows`.
- [ ] **SC4:** `bun run check` exits 0 on the genie PR, and the PR body lists any removed README assertion with its reason. **Proof:** the gate line and the test diff.
- [ ] **SC5:** the genie docs nav has at most 15 pages. Every `Docs Lint` job and `bun run lint:docs-links` pass on the bump PR. **Proof:** `docs-checks.sh nav` and the bump PR's checks.
- [ ] **SC6:** a grep over the public genie pages (the 15 plus the two reachable ones) finds none of Postgres, pgserve, daemon, Orca, npm, `genie spawn`, `genie team` or `genie sec` presented as current, and no `council.js`. **Proof:** `docs-checks.sh current`, with the exception file defined in G7.
- [ ] **SC7:** the CLI reference page names the release tag its `--help` came from. **Proof:** `docs-checks.sh tag`.
- [ ] **SC8:** each of the six core skills has a card image and an SOP video labelled "simulated", each with its capture file. The GIF is at most 3 MB, and each MP4 at most 8 MB. **Proof:** `docs-checks.sh media` and `ffprobe`.
- [ ] **SC9:** every figure in newly written copy is on the Allowed numbers list. No figure on the not-allowed list appears anywhere, exempt output and moved text included. **Proof:** the number listings from `readme-checks.sh` and `docs-checks.sh`, a not-allowed grep over everything shipped, and the reviewer's audit.
- [ ] **SC10:** newly written copy passes a grep for `—`, `–`, spaced hyphens used as punctuation, hashtags and "não é/não era" rebuttals. Fenced code, pasted CLI output and verbatim `UPGRADING.md` blocks are excluded. **Proof:** the voice mode of both check scripts.
- [ ] **SC11:** the org shows a description and 4 pins. Forge is archived with its open issues and pull requests closed, each with a pointer to genie. The namastex888 profile shows the new bio, pins and README. Felipe approved each write. **Proof:** G17's read-only validation, and the approvals recorded in this wish.
- [ ] **SC12:** no shipped capture file, and no frame data a video renders from, matches the scrub pattern once SGR escapes are stripped. Each video rendered from a capture shows its two-edit note. **Proof:** `redact.py --check` and `docs-checks.sh media`.
- [ ] **SC13:** the README embeds the six `.github/assets/skill-<name>.svg` cards, and the docs Skills catalog embeds all 18 `/genie/images/skills/<name>.svg`. This was carried over from the skill-cards G5 review. **Proof:** the cards mode of both check scripts.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | orchestrator | Low: one tracking commit | inherit | Track the wish, the INDEX entry and the board |

### Wave 2 (parallel, disjoint outputs: scratchpad, genie worktree, docs worktree)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | orchestrator | High: four real interactive runs (~1 to 1.5M tokens) and redaction of six captures | inherit | Real captures and redaction |
| 3 | engineer | Medium: a new rig mode plus a render under size caps | inherit | Mascot loop |
| 5 | engineer | Medium: about 140 README lines moved verbatim, two test files retargeted plus one `CLAUDE.md` pointer | inherit | `UPGRADING.md` and the test retargets |
| 7 | engineer | Medium: `docs.json`, 3 page stubs, one Install line, `docs-checks.sh` | inherit | Docs nav, stubs and checks |

### Wave 3 (each group starts when its dependencies finish)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | High: seven renders from captures, under caps and labels | inherit | SOP and Quickstart videos |
| 6 | engineer | High: new public copy under voice, numbers and pinned-string rules | inherit | README rewrite |
| 8 | engineer | Low: 18 files (cli/*, observability) moved or deleted | inherit | Docs moves batch 1 |
| 9 | engineer | Low: 17 files (config/*, architecture/*, concepts/*) moved or deleted | inherit | Docs moves batch 2 |
| 10 | engineer | Low: 19 files (non-core skill pages, top-level pages, two security pages, two stray `.md`) moved or deleted | inherit | Docs moves batch 3 |

Groups 8, 9 and 10 run in sequence in `wt-docs`.

### Wave 4 (sequential in `wt-docs`)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 11 | engineer | High: five pages of new copy plus two videos | inherit | Docs core pages A |
| 12 | engineer | High: six pages, including the CLI paste and the two reachable pages | inherit | Docs core pages B |
| 13 | engineer | Medium: six skill pages, each with card, video and capture | inherit | Docs skill pages |

### Wave 5 (G18 first, after the `wish-gate-any-repo` stable is published; then G14 and G15)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 18 | engineer | Medium: tag-bound lines in README and docs, the CLI paste, the Quickstart gate prerequisite | inherit | Retag at the launch stable |
| 14 | orchestrator | Low: push, PR, read-back, independent review | inherit | Genie PR |
| 15 | orchestrator | Low: docs PR, close docs#84, independent review | inherit | Docs PR |

### Wave 6 (gated on merges)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 16 | orchestrator | Low: one pointer commit after the docs merge | inherit | `.docs-vendor` bump |
| 17 | orchestrator | Medium: outward writes, each approved, plus Felipe's steps as instructions | inherit | Org and profile pages |

**Global constraints:**

- **Copy voice** (design Approach and the owner's rules):
  - no hashtags, no dash punctuation (`—`, `–`, spaced hyphens), and no "não é X, é Y" rebuttals;
  - "Wishes in, PRs out" and "context framework" are never headlines;
  - every new copy file gets a deslop pass.
- **Figures:**
  - new copy uses the design's Allowed numbers list only, with the exemptions in Decision 12;
  - the not-allowed list binds everything shipped;
  - counts are read at the newest stable tag (Decision 2).
- **Brand:** the mascot's eyes never open. Neon design B: surface `#0B0B12`, text `#E8E6F0`, magenta `#FF3FF5`, cyan `#5EF2FF`, border `#2A2438`.
- **Media caps:** GIF at most 3 MB, each MP4 at most 8 MB, each `capture.txt` at most 150 lines.
- **Redaction:**
  - host paths become `~/`;
  - the agent launch line is cut;
  - the permission-mode status line stays visible;
  - scrub pattern: `sofia-agents|/scratchpad|-scratchpad-|/home/genie|khal|ghp_|sk-|Bearer|dangerously-skip-permissions`, run on SGR-stripped text;
  - a hit on `sk-` inside an ordinary word (`task-`) is reported to Felipe, never exempted silently.
- **Docs paths that stay:**
  - `genie/installation.mdx`, `genie/release-notes.mdx` and `genie/incident-response/canisterworm.mdx`;
  - the Install heading "The public command tracks `main`, not a release";
  - the reachable pages `genie/hacks.mdx` and `genie/security/key-rotation.mdx`.
- **New docs paths:** the Skills catalog is `genie/skills/index.mdx`, Workflows is `genie/workflows.mdx`, the CLI reference is `genie/cli-reference.mdx`, and Security and releases is `genie/security/index.mdx`.
- **Docs links:** links inside docs pages are root-relative (`/genie/...`). `docs.automagik.dev` appears only in the README, skills, `package.json` and the org and profile pages.
- **Retired terminology:**
  - no retired-terminology token anywhere under `.docs-vendor/genie/`, `_internal/` included: `setup --codex|agent-sync|H3/H4/H6|\.curated|LENS_ROOT|CLAUDE_PLUGIN_ROOT|genie@automagik|council\.js|hook dispatch|plugin marketplace add`;
  - workflows are named without `.js`.
- **`.docs-vendor`:** bumped only after the docs PR merges, in its own PR (CLAUDE.md, Docs). Nothing is committed in `wt-docs`'s superproject.
- **README tests:** retargeted, never narrowed. A removed assertion is listed in the PR body with its reason.
- **Worktrees and tooling:**
  - "before" in any comparison means `$(git merge-base origin/dev HEAD)`, never a moving `origin/dev`;
  - every fresh worktree runs `umask 022` and `bun install --frozen-lockfile` first;
  - lint runs through `./node_modules/.bin/biome`, never a bare `bunx biome`;
  - conventional commits.
- **Outward writes:**
  - closing docs#84, and every G17 write, goes to Felipe through the question harness first;
  - the agent never approves its own production gate, never merges into a `main`, and never switches the `gh` account.

## Execution Groups

### Group 1: Track the wish

**Goal:** this wish, its INDEX entry and the board cards are on `wish/genie-launch`, next to the amended design.

**Deliverables:**
1. `.genie/wishes/genie-launch/WISH.md` (APPROVED, with plan-review evidence).
2. The `.genie/INDEX.md` `genie-launch` entry, moved to Poured, with its digest refreshed to the current stamp.
3. A refreshed `.genie/roadmap.json`.

All three are committed from the linked worktree `wt-gl`.

**Interfaces:**
- Consumes: the design commits `2f3d1a772`, `6c4e05082`, `97aaaa162`, `eec9229fe`, `4e9b40bb1` and `fe97559e2`, and their re-stamp.
- Produces: the branch that G5, G6 and G14 build on.

**Acceptance Criteria:**
- [ ] `verify` exits 0 on the design.
- [ ] `genie wish lint` exits 0.
- [ ] INDEX names the current digest.

**Validation:**
```bash
node skills/brainstorm/references/design-review-evidence.mjs verify .genie/brainstorms/genie-launch/DESIGN.md && genie wish lint && D=$(node skills/brainstorm/references/design-review-evidence.mjs digest .genie/brainstorms/genie-launch/DESIGN.md | cut -c1-8) && grep -q "wishes/genie-launch/WISH.md" .genie/INDEX.md && grep -q "$D" .genie/INDEX.md
```

**depends-on:** none

---

### Group 2: Real captures and redaction

**Goal:** one real, redacted capture for each of the six core skills.

**Deliverables:**
1. `scratchpad/sop-fixture`: a throwaway repository with its own `.genie/`, holding a small TypeScript module and one input per skill:
   - an approved one-group wish, for `/work`;
   - a small diff, for `/review`;
   - an open decision, for `/council`;
   - a recorded FIX-FIRST gap, for `/fix`.
2. One interactive tmux run per skill. Each run writes its `capture-pane -e` frames, `frames.log` and final transcript to `scratchpad/captures/<skill>/`. Each run's token and time line is recorded in this wish as one sample.
3. `scratchpad/captures/redact.py`:
   - It strips SGR codes for matching, maps host paths to `~/`, and cuts the agent launch line.
   - It writes `<skill>/frames-redacted/*.ans` and `<skill>.capture.txt` (at most 150 lines) for all six captures, V2 `/wish` and `/brainstorm` included.
   - `--check` exits 1 on any scrub-pattern hit in the transcripts or redacted frames, and 2 if any of the six is missing.

**Interfaces:**
- Consumes: `/home/genie/workspace/repos/genie/.orca/drops/launch/captures/wish-run-v2.tgz` and `brainstorm-run-bs.tgz`.
- Produces: `scratchpad/captures/<skill>/frames-redacted/` and `scratchpad/captures/<skill>.capture.txt` for `brainstorm`, `wish`, `work`, `review`, `council` and `fix`.

**Acceptance Criteria:**
- [ ] Six transcripts exist, each from a real run, each at most 150 lines.
- [ ] SC12 holds: `redact.py --check` exits 0, and a run of `--check` on a copy with a planted host path exits 1.

**Validation:**
```bash
S=/var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/captures; for k in brainstorm wish work review council fix; do test -s "$S/$k.capture.txt" && test "$(wc -l < "$S/$k.capture.txt")" -le 150 && test -d "$S/$k/frames-redacted" && test -n "$(ls -A "$S/$k/frames-redacted")" || exit 1; done; python3 "$S/redact.py" --check
```

**depends-on:** none

---

### Group 3: Mascot loop

**Goal:** the animated mascot with the GENIE wordmark, as a README GIF and a docs MP4.

**Deliverables:**
1. A new looping-lockup mode in the scratchpad rig `scratchpad/kv-rig/rig.src.html`. Today `?lockup=1` is a still and `?loop=1` hides the wordmark; the new mode keeps the face loop and draws the wordmark laid out for the loop canvas. This is a scratchpad change only.
2. `scratchpad/media/genie-loop.gif`, about 480 px wide and at most 3 MB.
3. `scratchpad/media/genie-loop.mp4`, at most 8 MB.
4. A contact sheet of every frame, `scratchpad/media/genie-loop-sheet.png`.
5. `scratchpad/media/loop-check.py <mp4>`: extracts the first and last frames with ffmpeg and exits 1 if their mean absolute pixel difference is 2% or more.

**Interfaces:**
- Consumes: the rig inputs listed in `RIG-NOTES.md`.
- Produces: the GIF, which G6 commits to `.github/assets/`, and the MP4, which G11 commits to `genie/videos/` and embeds on the Introduction page.

**Acceptance Criteria:**
- [ ] The loop is seamless: the mean pixel difference between the first and last frames is under 2%.
- [ ] The wordmark is visible in every frame.
- [ ] The eyes are closed in every frame of the contact sheet.
- [ ] Felipe approves the contact sheet through the question harness.

**Validation:**
```bash
M=/var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/media; test "$(stat -c %s $M/genie-loop.gif)" -le 3145728 && test "$(stat -c %s $M/genie-loop.mp4)" -le 8388608 && test -s $M/genie-loop-sheet.png && python3 /var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/media/loop-check.py $M/genie-loop.mp4
```

**depends-on:** none

---

### Group 4: SOP and Quickstart videos

**Goal:** six 30 to 60 s SOP videos and one V2 `/wish` video, each replaying a redacted real capture.

**Deliverables:**
1. `scratchpad/media/sop-<skill>.mp4` for each of the six core skills. Each one:
   - shows "simulated" on screen for its full length;
   - replays the redacted capture compressed to 30 to 60 s;
   - ends on a caption that names the two edits.
2. `scratchpad/media/quickstart-wish.mp4`: the real V2 `/wish` run, redacted, showing its own `genie wish report` figures as one sample.
3. A poster `.jpg` for each video.

**Interfaces:**
- Consumes:
  - G2's redacted frames and transcripts;
  - the launch rig at `/home/genie/workspace/repos/genie/.orca/drops/launch/render-src/` (Playwright and ffmpeg), copied to the scratchpad before any edit.
- Produces: seven MP4s and seven posters, consumed by G11 and G13.

**Acceptance Criteria:**
- [ ] SC8's video half and SC12 hold.
- [ ] Each SOP runs 30 to 60 s.
- [ ] Felipe approves the wish SOP and the Quickstart video through the question harness before the other five are rendered.

**Validation:**
```bash
M=/var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/media; for f in $M/sop-brainstorm.mp4 $M/sop-wish.mp4 $M/sop-work.mp4 $M/sop-review.mp4 $M/sop-council.mp4 $M/sop-fix.mp4 $M/quickstart-wish.mp4; do test -f "$f" && test "$(stat -c %s "$f")" -le 8388608 && test -f "${f%.mp4}.jpg" || exit 1; done; for k in brainstorm wish work review council fix; do d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $M/sop-$k.mp4); awk -v d="$d" 'BEGIN{exit !(d>=30 && d<=60)}' || exit 1; done
```

**depends-on:** 2

---

### Group 5: `UPGRADING.md` and the test retargets

**Goal:** the retirement, rollback, restore, MCP and Orca prose leaves README verbatim for a new `UPGRADING.md`, and every test that read it follows.

**Deliverables:**
1. `UPGRADING.md`, holding verbatim:
   - the README tail from line 35 through line 75, except the line-39 sentence Decision 4 keeps;
   - lines 146 to 232, except the install-surface strings Decision 4 keeps;
   - lines 240 to 251 and 260 to 266, and the line-279 note;
   - the parent headings needed so that `#### Restoring from a retirement backup` keeps its level and its bash block stays the first fence after it.
2. `README.md` with those spans removed. Each removed span leaves one plain link line to `UPGRADING.md`, and no other new copy.
3. `scripts/release-docs.test.ts`: T2, T3 and T6 read README and `UPGRADING.md` concatenated, and no `expect` is deleted.
4. `scripts/skills-retirement-restore.test.ts` reads `UPGRADING.md`, with its messages updated to match.
5. `CLAUDE.md:91`'s pointer names `UPGRADING.md`.
6. `scratchpad/upgrading-diff.py --base <commit> --head <commit>`. It reads README at `<base>`, and README plus UPGRADING at `<head>`, splits each into sentences, with list items and table rows as whole lines and fenced blocks as whole blocks. It exits 1 if any sentence, line or block that left README is missing from UPGRADING. Comparing at sentence level is what lets G5 split the line 34–35 list and the line 39 paragraph.

**Interfaces:**
- Consumes: none.
- Produces: the G5 commit. G6 rewrites the README on top of it, and SC2 is bound to it.

**Acceptance Criteria:**
- [ ] SC2 holds at the G5 commit.
- [ ] The three test files pass.
- [ ] No `expect` is removed relative to the merge base.

**Validation:**
```bash
umask 022 && B=$(git merge-base origin/dev HEAD) && git diff --quiet HEAD && git cat-file -e HEAD:UPGRADING.md && ! git diff --quiet "$B" HEAD -- README.md && python3 /var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/upgrading-diff.py --base "$B" --head HEAD && bun test scripts/release-docs.test.ts scripts/skills-retirement-restore.test.ts src/__tests__/claude-md-drift.test.ts && test "$(git diff "$B" -- scripts/ | grep -c '^-.*expect(')" = 0
```

**depends-on:** 1

---

### Group 6: README rewrite

**Goal:** a skills-first README for launch visitors.

**Deliverables:**
1. `README.md`, in this order:
   - hero: the GIF from G3, the thesis line, and a one-paste install;
   - a short `You:`/`Genie:` transcript of one `/wish`;
   - the loop (brainstorm, wish, work, review, plus council), keeping "design review", "plan review" and "implementation review";
   - the skills catalog: all 18 skills, one line each, with the six core cards as `<img src=".github/assets/skill-<name>.svg" width="400">`, two per row;
   - every saved workflow at the tag, one line each, named without `.js`;
   - "When not to use it / what it costs", using Allowed numbers only;
   - a short comparison with Superpowers, spec-kit and GSD, each claim cited in the PR body to that project's README at a pinned commit;
   - links to `docs.automagik.dev/genie` and its new pages (paths per Global constraints) and to the org;
   - the strings Decision 4 keeps, and a link to `UPGRADING.md`.
2. `.github/assets/genie-loop.gif`, from G3.
3. `package.json`: the description's URL becomes `https://docs.automagik.dev/genie/security`. The rest of its text stays.
4. `scratchpad/readme-checks.sh`, which exits 1 on any failure. It checks SC1, SC3 for the README, SC13 for the README (six card embeds), Decision 4's pinned strings, and SC10 voice on README text outside code fences. It prints every number in the new README for SC9, and fails on any not-allowed figure in `README.md` or `UPGRADING.md`, using the same pattern as `docs-checks.sh numbers`.

**Interfaces:**
- Consumes: G5's commit, G3's GIF, and the six cards on `dev`.
- Produces: the final README, which G14 publishes.

**Acceptance Criteria:**
- [ ] `readme-checks.sh` exits 0.
- [ ] `bun run check` exits 0.
- [ ] Felipe reads the rendered first screen through the question harness before the PR opens.

**Validation:**
```bash
umask 022 && bash /var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/readme-checks.sh && test "$(stat -c %s .github/assets/genie-loop.gif)" -le 3145728 && test "$(git diff "$(git merge-base origin/dev HEAD)" -- package.json | grep -c '^[-+] ')" = 2 && bun run check
```

**depends-on:** 3, 5

---

### Group 7: Docs nav, stubs and checks

**Goal:** the nav skeleton holds at most 15 pages, the check script exists before any page is written, and nothing a later move needs breaks.

**Deliverables:**
1. `wt-docs` (Decision 11), with `.docs-vendor` on a new branch `feat/genie-v6-launch` cut from docs `main`.
2. `docs.json`: the genie product nav holds exactly the 15 design pages, in order and at the paths in Global constraints. `navigation.products[2].product` reads "mikro".
3. Stubs, each a title only: `genie/skills/index.mdx`, `genie/workflows.mdx` and `genie/cli-reference.mdx`.
4. `genie/installation.mdx`: only its link line to `/genie/concepts/byoa` is removed, so that G9 can move byoa.
5. `scratchpad/docs-checks.sh <mode> [files...]`, which exits 1 on failure. "Added lines" means lines added since the docs merge base, read with `git -C .docs-vendor diff -U0 $(git -C .docs-vendor merge-base origin/main HEAD)`. The modes are:
   - `nav`: at most 15 nav pages, the paths match the list, and RLMX is gone.
   - `retired`: the retired-terminology grep under `genie/`, `_internal/` included.
   - `current FILES`: the SC6 grep over the given pages, with SGR codes stripped. It subtracts `scratchpad/docs-current-exceptions.txt`, whose lines are `path<TAB>fixed string<TAB>reason`, matched by fixed string and not by line number. It fails on any remaining hit.
     - The exception file starts with the pasted CLI block, the incident page's historical lines other than its `genie sec` recommendations, and release-notes lines that name something as retired.
     - G12 adds the canisterworm `genie sec` lines it annotates.
     - Every exception added later appears in the PR body.
   - `cards FILES`: the catalog embeds all 18 `/genie/images/skills/<name>.svg`, and each given core skill page embeds its own card.
   - `workflows`: `genie/workflows.mdx` and `genie/skills/index.mdx` name every workflow at the tag, without `.js`.
   - `tag`: `genie/cli-reference.mdx` contains the exact tag recorded in `scratchpad/docs-tag.txt`. G12 writes that file when it pastes the CLI, reading `gh release view --repo automagik-dev/genie --json tagName --jq .tagName`. A stable release that lands later means re-pasting the CLI and rewriting the file.
   - `voice [FILES]`: the SC10 grep over added lines only (optionally limited to FILES), outside code fences and the pasted CLI. Text kept verbatim, such as the incident record and the old parts of the reachable pages, is never scanned.
   - `numbers [FILES]`: lists every number in added lines for the SC9 audit. It fails on any not-allowed figure in the shipped public surfaces, matched case-insensitively against `14/58|511k|22[- ]min|[0-9.]+(-[0-9.]+)?x (faster|cheaper)|[0-9]+(-[0-9]+)?% .{0,20}(cheaper|cost|reduction|saving)|[0-9][0-9,]* (commits|PRs|pull requests)|SHIP rate|merge-ready rate`. Here the shipped public surfaces are the 17 public pages and the shipped `capture.txt` files. Images and `_internal/` are excluded, because `_internal/` is not published (`.mintignore`). `README.md` and `UPGRADING.md` are checked against the same pattern by `readme-checks.sh` in `wt-gl` (G6), because `wt-docs`' superproject holds `dev`'s old README. The G15 reviewer audit covers what the patterns cannot catch.
   - `media`: each video is within its cap and has a poster, and each `capture.txt` passes the scrub pattern and is at most 150 lines.
   - `all`: nav, retired, workflows, tag, then `current`, `cards`, `voice` and `numbers` over the full public set (the 15 pages plus the two reachable ones), then media.

   Each group passes its own pages, so no group's check depends on a later group's work.

**Interfaces:**
- Consumes: none.
- Produces: the branch, the nav and stub paths, and the check script that G8 to G13 use.

**Acceptance Criteria:**
- [ ] `docs-checks.sh nav` and `docs-checks.sh retired` exit 0.
- [ ] Genie's `lint:docs-links` and `lint:docs-markdown` pass.

**Validation:**
```bash
C=/var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/docs-checks.sh; bash $C nav && bash $C retired && bun run lint:docs-links && bun run lint:docs-markdown && test -z "$(git status --porcelain --ignore-submodules=none | grep -v '^ M .docs-vendor$')"
```

**depends-on:** none

---

### Group 8: Docs moves, batch 1

**Goal:** the 17 `cli/*` pages and `observability/detectors` leave the public tree.

**Deliverables:**
1. Each of the 18 files is moved to `genie/_internal/` (engineering value) or deleted (v4-only), per Decision 7. The commit message gives one line per file with the reason.

**Interfaces:**
- Consumes: G7's branch.
- Produces: the trimmed tree.

**Acceptance Criteria:**
- [ ] No public file is left under `genie/cli/` or `genie/observability/`.
- [ ] `retired` passes.
- [ ] The lints pass.

**Validation:**
```bash
test -z "$(find .docs-vendor/genie/cli .docs-vendor/genie/observability -name '*.md*' 2>/dev/null)" && bash /var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/docs-checks.sh retired && bun run lint:docs-links && bun run lint:docs-markdown
```

**depends-on:** 7

---

### Group 9: Docs moves, batch 2

**Goal:** `config/*` (4), `architecture/*` (6) and `concepts/*` (7, byoa included) leave the public tree.

**Deliverables:**
1. The 17 files are moved or deleted per Decision 7, with the reasons in the commit message.

**Interfaces:**
- Consumes: G8's tree. G7 already removed the Install link to byoa.
- Produces: the trimmed tree.

**Acceptance Criteria:**
- [ ] No public file is left under those three directories.
- [ ] `retired` passes.
- [ ] The lints pass.

**Validation:**
```bash
test -z "$(find .docs-vendor/genie/config .docs-vendor/genie/architecture .docs-vendor/genie/concepts -name '*.md*' 2>/dev/null)" && bash /var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/docs-checks.sh retired && bun run lint:docs-links && bun run lint:docs-markdown
```

**depends-on:** 8

---

### Group 10: Docs moves, batch 3

**Goal:** everything else leaves the public tree, so only the 15 pages and the two reachable pages remain.

**Deliverables:**
1. These pages are moved or deleted per Decision 7:
   - the non-core skill pages: loop-overview, wizard, pm, trace, learn, brain, refine, report, docs, genie and genie-hacks;
   - features, onboarding, contributing and release-process;
   - security/distribution-sovereignty and security/verifying-installs;
   - the two stray `.md` files.

**Interfaces:**
- Consumes: G9's tree.
- Produces: a public tree holding exactly the 15 nav paths and the two reachable pages.

**Acceptance Criteria:**
- [ ] The public `.md*` set equals the 15 nav paths plus the two reachable pages.
- [ ] The lints pass.

**Validation:**
```bash
cd .docs-vendor && P=$(find genie -name '*.md*' -not -path '*/_internal/*' | sort) && N=$(python3 -c "import json;d=json.load(open('docs.json'));print('\n'.join(sorted([p+'.mdx' for g in d['navigation']['products'][0]['groups'] for p in g['pages']]+['genie/hacks.mdx','genie/security/key-rotation.mdx'])))") && test "$P" = "$N" && cd .. && bun run lint:docs-links && bun run lint:docs-markdown
```

**depends-on:** 9

---

### Group 11: Docs core pages, A

**Goal:** Introduction, Install, Quickstart, the Skills catalog and Workflows, written for v6 and skills first.

**Deliverables:**
1. `genie/index.mdx`, rewritten, with `genie/videos/genie-loop.mp4` from G3 embedded.
2. `genie/installation.mdx`: npm, Bun, Homebrew and tmux/Node are no longer presented as current. The pinned heading stays.
3. `genie/quickstart.mdx`: a first wish, with `genie/videos/quickstart-wish.mp4` and its poster from G4, its figures shown as one sample.
4. `genie/skills/index.mdx`: 18 skills, one line each, each with its card embedded, and every workflow named.
5. `genie/workflows.mdx`: every saved workflow at the tag, one line each.

**Interfaces:**
- Consumes: G10's tree, G3's MP4, and G4's Quickstart video.
- Produces: five pages for G15.

**Acceptance Criteria:**
- [ ] `docs-checks.sh` passes for these five pages: current, cards (catalog), workflows, voice and numbers.
- [ ] The lints pass.

**Validation:**
```bash
C=/var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/docs-checks.sh; F="genie/index.mdx genie/installation.mdx genie/quickstart.mdx genie/skills/index.mdx genie/workflows.mdx"; bash $C nav && bash $C retired && bash $C workflows && bash $C current $F && bash $C cards genie/skills/index.mdx && bash $C voice $F && bash $C numbers $F && bun run lint:docs-links && bun run lint:docs-markdown
```

**depends-on:** 3, 4, 10

---

### Group 12: Docs core pages, B

**Goal:** the CLI reference, Upgrading and retired, Security and releases, the incident note, and the two reachable pages.

**Deliverables:**
1. `genie/cli-reference.mdx`: `genie --help` pasted verbatim from the newest stable tag, with the tag named. A note says `orca` is a retired stub and `mcp`, in `init`'s description, is a removed verb.
2. `genie/release-notes.mdx`: the stale "one plugin, the Orca plugin" line is fixed.
3. `genie/security/index.mdx`, rewritten, with one factual line on leaving npm for signed releases and a link to the incident page.
4. `genie/incident-response/canisterworm.mdx`: v6 guidance added wherever it recommends the removed `genie sec`. The record is otherwise unchanged.
5. `genie/hacks.mdx` and `genie/security/key-rotation.mdx`, brought to v6 wherever they present `genie spawn`, `genie team`, `genie sec` or tmux-era setup as current. The not-allowed figures at `hacks.mdx:45` ("5x faster, 80% cheaper") and `:55` ("3-5x faster … 60-70%") are removed.

**Interfaces:**
- Consumes: G11's tree.
- Produces: six pages for G15.

**Acceptance Criteria:**
- [ ] `docs-checks.sh` passes for these six pages (current, voice, numbers), and `tag` passes (SC7).
- [ ] The lints pass.
- [ ] Each page's insertions are listed in the report.

**Validation:**
```bash
C=/var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/docs-checks.sh; F="genie/cli-reference.mdx genie/release-notes.mdx genie/security/index.mdx genie/incident-response/canisterworm.mdx genie/hacks.mdx genie/security/key-rotation.mdx"; bash $C retired && bash $C tag && bash $C current $F && bash $C voice $F && bash $C numbers $F && bun run lint:docs-links && bun run lint:docs-markdown
```

**depends-on:** 11

---

### Group 13: Docs skill pages

**Goal:** one page each for brainstorm, wish, work, review, council and fix, each with its card, SOP video and capture.

**Deliverables:**
1. `genie/skills/{brainstorm,wish,work,review,council,fix}.mdx`, rewritten. Each page has:
   - its card;
   - "what it does / when to use it";
   - the SOP video, labelled simulated, with its poster;
   - a link to its `capture.txt`;
   - `/name` and `$name`.
2. `genie/videos/sop-<skill>.mp4` and the posters, plus `captures/genie/<skill>.capture.txt` at the docs repo root (Decision 5).

**Interfaces:**
- Consumes: G12's tree, G4's videos, and G2's transcripts.
- Produces: six pages for G15.

**Acceptance Criteria:**
- [ ] `docs-checks.sh all` passes over the full public set: SC3, SC5 to SC8, SC10, SC12 and SC13.

**Validation:**
```bash
bash /var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/docs-checks.sh all && bun run lint:docs-links && bun run lint:docs-markdown
```

**depends-on:** 2, 4, 12

---

### Group 14: The genie PR

**Goal:** a merge-ready genie PR to `dev` carrying G1, G5 and G6.

**Deliverables:**
1. Run `bun run check` on the final head. Push, open the PR, and read back head, base and file set. The file set may contain only README, UPGRADING, the two test files, `CLAUDE.md`, `package.json`, `.github/assets/genie-loop.gif`, `.github/assets/wish-run.gif` and `.genie/`.
2. A PR body with:
   - SC2's output, bound to the G5 commit;
   - the comparison citations;
   - every removed README assertion, with its reason (none is planned);
   - the `package.json` description change.
3. An independent PR review of the exact head. The merge stays with Felipe, or is done by me only on his explicit ask.

**Interfaces:**
- Consumes: G1, G5 and G6.
- Produces: the PR and, once merged, its merge commit, which G17 waits for on `main`.

**Acceptance Criteria:**
- [ ] SC1, SC2, SC3 (README), SC4, SC9, SC10 and SC13 (README) hold.
- [ ] Both `Unit (…)` checks pass.

**Validation:**
```bash
# PR is the genie PR number
set -o pipefail; bun run check && test "$(git rev-parse HEAD)" = "$(gh pr view "$PR" --json headRefOid --jq .headRefOid)" && ! gh pr view "$PR" --json files --jq '.files[].path' | grep -vE '^(README\.md|UPGRADING\.md|CLAUDE\.md|package\.json|scripts/release-docs\.test\.ts|scripts/skills-retirement-restore\.test\.ts|\.github/assets/genie-loop\.gif|\.github/assets/wish-run\.gif|\.genie/.*)$' | grep -q . && gh pr checks "$PR" --json name,bucket --jq '[.[]|select(.name|startswith("Unit ("))|.bucket]|(length==2 and all(.=="pass"))' | grep -qx true
```

**depends-on:** 1, 5, 6, 18

---

### Group 15: The docs PR

**Goal:** one automagik-dev/docs PR carrying G7 to G13, merged, with docs#84 closed in its favour.

**Deliverables:**
1. Push `feat/genie-v6-launch` and open the PR to docs `main`. The body names the RLMX→mikro label change for Felipe's approval in the PR, and includes the exception file and the `docs-checks.sh` outputs.
2. With Felipe's approval through the question harness, close docs#84 with one comment pointing to the new PR. Its branch stays.
3. An independent review against SC3, SC5 to SC10, SC12 and SC13. Felipe merges.

**Interfaces:**
- Consumes: G7 to G13.
- Produces: the docs merge commit, which G16 and G17 check.

**Acceptance Criteria:**
- [ ] The review is SHIP.
- [ ] docs#84 is closed, unmerged, with the pointer.
- [ ] The docs PR is MERGED.

**Validation:**
```bash
# DOCS is the docs PR number
gh pr view 84 --repo automagik-dev/docs --json state,mergedAt --jq '.state=="CLOSED" and .mergedAt==null' | grep -qx true && gh pr view "$DOCS" --repo automagik-dev/docs --json state,baseRefName --jq '.state=="MERGED" and .baseRefName=="main"' | grep -qx true
```

**depends-on:** 18

---

### Group 16: The pointer bump

**Goal:** genie points at a docs `main` that holds B, and every docs lint passes.

**Deliverables:**
1. Branch `chore/bump-docs-genie-launch` from `origin/dev`.
2. Run `git submodule update --remote .docs-vendor`, and check that the docs merge commit is an ancestor of the submodule HEAD.
3. Run `bun run check`, then open the PR to `dev`.
4. Read back both `Unit (…)` checks and every `Docs Lint` job.

**Interfaces:**
- Consumes: G15's merge commit.
- Produces: the bump PR. Felipe merges it, or I do on his ask.

**Acceptance Criteria:**
- [ ] SC5 holds on the bump PR.

**Validation:**
```bash
# DOCS is the docs PR number, BUMP the bump PR number
set -o pipefail; M=$(gh pr view "$DOCS" --repo automagik-dev/docs --json mergeCommit --jq .mergeCommit.oid) && test -n "$M" && git -C .docs-vendor merge-base --is-ancestor "$M" HEAD && bun run check && gh pr checks "$BUMP" --json name,workflow,bucket --jq '([.[]|select(.name|startswith("Unit ("))]|length==2 and all(.bucket=="pass")) and ([.[]|select(.workflow=="Docs Lint")]|length>=1 and all(.bucket=="pass"))' | grep -qx true
```

**depends-on:** 15

---

### Group 17: Org and profile pages

**Goal:** the automagik-dev org and the namastex888 profile tell the v6 story, with every write approved by Felipe.

**Deliverables:**
1. First, run the precondition and stop if it fails: `git fetch origin main && git merge-base --is-ancestor "$(gh pr view "$PR" --json mergeCommit --jq .mergeCommit.oid)" origin/main && gh pr view "$DOCS" --repo automagik-dev/docs --json state --jq .state | grep -qx MERGED`.
2. Drafts in `scratchpad/org/`, each shown to Felipe through the question harness before any write. The files are `description.txt`, `profile-README.md`, `repos.json` (`{repo: {description, topics}}`), `forge-comment.md`, `n888-bio.txt`, `n888-README.md` and `n888-pins.txt`. The approved versions are what the validation compares against:
   - the org description;
   - the org profile README (`automagik-dev/.github`, `profile/README.md`, replacing the current one);
   - descriptions and topics for genie, workit, autopg and mikro;
   - the namastex888 bio and profile README (replacing the current ones);
   - the one forge closing comment.
3. Agent writes, each after its approval:
   - the profile README, through a PR to `automagik-dev/.github` that Felipe merges;
   - the repo descriptions and topics, through `gh api`;
   - forge's 28 issues and 6 PRs, each closed with the approved comment (their numbers written to `scratchpad/org/forge-closed.txt`), then the forge archive.
4. Felipe's own steps (Decision 9), handed over as exact instructions:
   - the org description;
   - the 4 org pins (genie, workit, autopg, mikro);
   - the namastex888 bio, 6 pins and profile README;
   - archiving `zetest`, and `smol` only if he says so.
5. A read-only verification of every item, with each approval recorded in this wish.

**Interfaces:**
- Consumes: G14's merge commit on `main`, and G15's merge.
- Produces: none.

**Acceptance Criteria:**
- [ ] SC11 holds.
- [ ] No new profile text carries a figure outside the Allowed list.

**Validation:**
```bash
O=/var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad/org; test "$(gh api orgs/automagik-dev --jq .description)" = "$(cat $O/description.txt)" && test "$(gh api repos/automagik-dev/.github/contents/profile/README.md --jq .content | base64 -d)" = "$(cat $O/profile-README.md)" && test "$(gh api users/namastex888 --jq .bio)" = "$(cat $O/n888-bio.txt)" && test "$(gh api repos/namastex888/namastex888/contents/README.md --jq .content | base64 -d)" = "$(cat $O/n888-README.md)" && for r in genie workit autopg mikro; do test "$(gh api repos/automagik-dev/$r --jq '{description,topics:(.topics|sort)}' | jq -S -c .)" = "$(jq -S -c --arg r $r '.[$r]|{description,topics:(.topics|sort)}' $O/repos.json)" || exit 1; done && test "$(gh api graphql -f query='{organization(login:"automagik-dev"){pinnedItems(first:6){nodes{... on Repository{nameWithOwner}}}}}' --jq '[.data.organization.pinnedItems.nodes[].nameWithOwner]|sort|join(",")')" = "automagik-dev/autopg,automagik-dev/genie,automagik-dev/mikro,automagik-dev/workit" && test "$(gh api graphql -f query='{user(login:"namastex888"){pinnedItems(first:6){nodes{... on Repository{nameWithOwner}}}}}' --jq '[.data.user.pinnedItems.nodes[].nameWithOwner]|sort|join(",")')" = "$(sort $O/n888-pins.txt | paste -sd,)" && test "$(gh api repos/automagik-dev/forge --jq .archived)" = true && test "$(gh api 'search/issues?q=repo:automagik-dev/forge+state:open' --jq .total_count)" = 0 && while read -r n; do test "$(gh api "repos/automagik-dev/forge/issues/$n/comments" --jq '.[-1].body')" = "$(cat $O/forge-comment.md)" || exit 1; done < $O/forge-closed.txt && test "$(wc -l < $O/forge-closed.txt)" = 34 && test "$(gh api repos/namastex888/zetest --jq .archived)" = true
```

**depends-on:** 14, 15

---

### Group 18: Retag at the launch stable

**Goal:** every tag-bound line names the stable that ships `wish-gate-any-repo`, and the gate copy matches what that stable does (Decision 13).

**Deliverables:**
1. Docs pages, on `feat/genie-v6-launch`: every `v6.261002.2` reference and every count read at the tag (Decision 2) moves to the new tag. Re-read the counts there. `genie/cli-reference.mdx` gets the new `genie --help`, pasted verbatim, and `S/docs-tag.txt` names the new tag.
2. `genie/quickstart.mdx`: the gate prerequisite is rewritten from the new tag's `wish.js`.
3. `README.md` on `wish/genie-launch`: any tag-bound line moves to the new tag. The "Weak checks" line is checked against the new gate. A changed sentence in approved copy goes to Felipe through the question harness before it is committed.

**Interfaces:**
- Consumes: G13's tree, the published `wish-gate-any-repo` stable, and the G6 README.
- Produces: the trees G14 and G15 publish.

**Acceptance Criteria:**
- [ ] No `v6.261002.2` remains in shipped copy, except in release notes that record history.
- [ ] `docs-checks.sh all` and `readme-checks.sh` pass at the new tag.
- [ ] Felipe approved every changed sentence of approved copy.

**Validation:**
```bash
S=/var/tmp/sofia-agents/claude-1001/-home-genie-workspace-repos-genie/065fdfff-9583-40b0-98b4-321e16c72e82/scratchpad; cd $S/wishrun/wt-gl && T=$(cat $S/docs-tag.txt); test "$T" != v6.261002.2 && gh release view "$T" -R automagik-dev/genie >/dev/null && bash $S/docs-checks.sh all && bash $S/readme-checks.sh && ! grep -rn 'v6\.261002\.2' $S/wishrun/wt-docs/.docs-vendor/genie --include=*.mdx | grep -v release-notes.mdx
```

**depends-on:** 13, wish-gate-any-repo (stable published)

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] On `dev` after G14 merges, GitHub renders the README:
  - the mascot loop, the install and the transcript;
  - the six cards, two per row;
  - the workflow list;
  - no retirement prose on the first screen.

  `UPGRADING.md` renders, and its restore block still runs (the test passes).
- [ ] After the bump merges, a fresh clone with `git submodule update --init` has the 15-page genie nav, the 18 cards, the seven videos and the six transcripts. A local `npx -y mint@4.2.970 dev` render of Introduction, Quickstart and one skill page plays its video.
- [ ] `bun run check` and both CI legs stay green on `dev`, and no README assertion is lost.
- [ ] The org page, forge and the namastex888 profile show the approved state.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A real run in G2 fails or produces an unusable capture | Medium | Re-run once on the same fixture. A second failure goes to Felipe, never to a made-up capture |
| G2 exceeds the token estimate (~1 to 1.5M) | Low | Each run is one sample on a tiny fixture, and the total is reported after each run |
| The README rewrite drops a pinned string | High | Decision 4 lists the strings, `readme-checks.sh` asserts them, and `bun run check` runs |
| A docs move breaks a link the lints do not check (JSX cards) | Medium | G11 and G12 rewrite the pages that hold JSX cards. The reviewer greps `href="/genie/` targets against the files |
| New docs pages 404 on `docs.automagik.dev` until the migration | Medium | Accepted by Felipe (design risk 8) |
| An outward write cannot be undone cleanly | Medium | Every write goes to Felipe first. Archive and closes come last |
| The comparison misstates Superpowers, spec-kit or GSD | Medium | Each claim is cited to that project's README at a pinned commit. A claim with no citation is dropped |
| The rig change in G3 takes longer than a render | Medium | It is scratchpad only. If it slips, the README hero waits; nothing depends on it until G6 and G11 |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review 1 — 2026-10-02T13:54:01Z — FIX-FIRST → repaired

- **Reviewer:** claude-opus-5-5, independent and read-only. Plan sha256 `eec8e7c1…`.
- **HIGH-1:** G7 touched about 58 files. It is now split into G7 (nav, stubs, checks) and G8, G9 and G10 (moves, at most 25 files each).
- **HIGH-2:** G7 could not pass its own link check. G7 now removes the Install link to byoa before G9 moves byoa.
- **HIGH-3:** `docs-checks.sh` was never created. It is now a G7 deliverable with defined modes and an explicit SC6 exception file.
- **HIGH-4:** G2's scrub gate passed vacuously. Its validation now asserts every frames directory, and `redact.py --check` carries the scrub.
- **HIGH-5:** no group checked the merges it waits on. Now G15 checks MERGED, G16 checks that the docs merge commit is an ancestor of the submodule HEAD, and G17 starts by checking `main` and the docs merge.
- **MEDIUM-1:** T2 and T3 now read README and UPGRADING concatenated.
- **MEDIUM-2:** comparisons use the merge base, and SC2 is bound to the G5 commit.
- **MEDIUM-3:** the waves follow depends-on, with one dedicated docs worktree (Decision 11).
- **MEDIUM-4:** the org description is now Felipe's step (Decision 9). G17's validation reads the pins, the profile README and the topics.
- **MEDIUM-5:** owner decision "Isentar saída e texto movido" (2026-10-02), recorded in the design and as Decision 12. A follow-up design review made the not-allowed list absolute, covering exempt output too.
- **MEDIUM-6:** a card-placement check was added (SC13, in both check scripts).
- **MEDIUM-7:** G3 now states the rig change.
- **MEDIUM-8:** the new docs paths are fixed in Global constraints.
- **LOW-1 to LOW-9:**
  - the `render-src` path;
  - the file list;
  - the forge PRs (owner decision "Fechar os PRs também", recorded in the design);
  - the 400-line transcript cap and the G11/G12 split;
  - `npx mint` in QA;
  - the identity rule;
  - the line-39 exception;
  - SGR stripping and the `sk-` note;
  - the INDEX digest in G1.

### Plan review 2 — 2026-10-02T14:11:47Z — FIX-FIRST → repaired

- Same reviewer, plan sha256 `40f2ba0c…`. All round-1 repairs confirmed, except the validation half of MEDIUM-4, which is repaired below. New findings:
  - HIGH-1: G11 and G12 could not pass `core`, because `current` and `voice` scanned pages that later groups rewrite, and `voice` scanned text kept verbatim. Repair:
    - `docs-checks.sh` modes take a file list, and each group checks its own pages;
    - `voice` and the number listing read added lines only;
    - exceptions are keyed by fixed string;
    - G12 adds the canisterworm lines it annotates;
    - the full set runs as `all` in G13 and G15.
  - MEDIUM-1: `upgrading-diff.py` now compares at sentence, line and block granularity, and the G5 validation asserts a clean tree, a committed `UPGRADING.md` and a README diff before it runs.
  - MEDIUM-2: transcripts are capped at 150 lines. G13 is then about 24 files and under 1,500 insertions.
  - MEDIUM-3: G17's validation compares every item with its approved draft in `scratchpad/org/`, including the decoded READMEs, the bio, each repo's description and topics, and the two pin sets.
  - LOW-1: G17's precondition is an exact command.
  - LOW-2: `loop-check.py` measures the seamless loop.
  - LOW-3: `docs-checks.sh tag` greps the exact stable tag.
  - LOW-4: "two test files".

### Plan review 3 — 2026-10-02T14:16:47Z — FIX-FIRST → repaired

- Same reviewer, plan sha256 `008f7c2f…`. All round-2 repairs are confirmed, and criteria (a) to (g) pass.
- MEDIUM-1: the public `hacks.mdx` carries cost multiples (lines 45 and 55), and the `numbers` mode had no patterns. G12 now removes those figures, and `numbers` has an explicit case-insensitive pattern list.
- LOW-1: the `tag` mode compares against the tag G12 records at paste time.
- LOW-2: cuts in a transcript are marked `[… N lines elided …]`.
- LOW-3: G17 checks each closed forge item's pointer comment, and the `zetest` archive.
- LOW-4: the wave table now says two test files.

### Plan review 4 — 2026-10-02T14:18:41Z — FIX-FIRST → repaired

- Same reviewer, plan sha256 `10d9be8c…`. The round-3 repairs are confirmed, and criteria (a) to (g) pass.
- MEDIUM-1: the `[0-9,]+` class matched a bare comma, as in "plans, code, PRs" (the review skill's own line). It is now `[0-9][0-9,]*`. The scope of `numbers` is defined as the 17 public pages, README, UPGRADING and the shipped transcripts. `_internal/`, which is unpublished, and images are excluded.

### Plan review 5 — 2026-10-02T14:19:57Z — SHIP

- Same reviewer (claude-opus-5-5, independent, read-only), plan sha256 `c1e11eb3…`. All criteria (a) to (h) pass over 17 groups. Five rounds were scored against one frozen criteria set.
- LOW-1, applied after the verdict, with nothing else changed: the not-allowed check for README and UPGRADING runs in `readme-checks.sh` in `wt-gl`, and `docs-checks.sh numbers` covers only the docs files and transcripts.

### Owner approval — 2026-10-02

- Felipe chose "Aprovado, executa" through the question harness after plan review 5 returned SHIP. The orchestrator persisted APPROVED and set IN_PROGRESS at the start of execution.

### Group 5 review — 2026-10-02T14:43Z — SHIP

- g5-engineer `9d9a15f8f`, plus LOW follow-up `7ae9c9d13`, merged `--no-ff` as `fcfb15f66`. The G5 validation block exits 0 (95 pass). `upgrading-diff.py` reports 99 units left README, 0 missing.
- Criteria review (claude-opus-5-5, read-only): SHIP, K1–K13 pass. Ten planted defects each make the diff script fail. Worker rulings 1–6 accepted (the line-35 npx figures move verbatim under Decision 12).
- Quality pass (claude-opus-5-5, read-only): SHIP. Mutations prove T2, T3, T6 and the restore test fail for the right reason, and anchors resolve.
- Shared LOW applied in `7ae9c9d13`: T6 also pins the five Decision-4 strings to README alone. `UPGRADING.md` opens with base lines 32–34, so item 2 is no longer orphaned.
- Carried to G6: two kept README sentences lost their antecedents (`--integrations`, "instead"). G6 restores the flag name, and `readme-checks.sh` requires `--integrations`.

### Group 3 — 2026-10-02 — owner checkpoint passed

- g3-engineer added the looping-lockup mode `?loop=1&lockup=1` to the scratchpad rig.
  - `genie-loop.gif`: 2,689,607 B, 480 px, 60 frames at 15 fps, 4.000 s.
  - `genie-loop.mp4`: 1,250,535 B, 1080 px, 30 fps.
  - `loop-check.py` measures the first-to-last frame difference at 0.588%.
- Eyes closed in all 120 frames (worker zoom check, and the orchestrator viewed the sheet). Wordmark in every frame.
- Felipe approved the contact sheet through the question harness ("Aprovado").
- Ruling: no separate code reviewer. The rig change is scratchpad only, and the deliverable is media gated by the owner's visual approval plus the G3 validation (exit 0).

### Group 2 — captures recorded

- Recorded with the redact pipeline:
  - work: 328 frames, 2m 4s, about 151k tokens.
  - review: second take, 37s, about 57k tokens.
  - council: workflow `wf_5d33c2e6-dd3`, 1.1 min, 257,881 tokens, 6 agents; about 326k with the session.
  - fix: 54s, about 101k tokens.
  - These are single samples, approximate except council, about 0.7M in total.
  - wish (V2) and brainstorm were redacted from the existing captures.
- `redact.py --check`: 6689 files, 0 hits. A planted path exits 1, a missing capture exits 2. The G2 validation exits 0.

### Owner copy decision — 2026-10-02

- README hero thesis line, chosen through the harness: "Code is a commodity. Harnesses get replaced. Context stays." (the English form of the approved video close).

### Group 7 review — 2026-10-02T15:03Z — SHIP

- g7-engineer docs commit `411a75aad` (nav cut to the 15 design pages, RLMX → mikro, three stubs, Install's byoa link removed), plus the scratchpad `docs-checks.sh` and the exceptions file. Branch `feat/genie-v6-launch` pushed early as a backup.
- Criteria review (claude-opus-5-5): SHIP, C1–C12 pass, rulings 1–11 upheld.
- Quality pass: FIX-FIRST (M1 the added-line parser failed open on path spellings and git diff config; M2 `cards` skipped typos) → repair → SHIP. LOW follow-up: the workflow section is heading- and fence-aware, the exception FLAG counts lines instead of positions, binary pages are refused, and JSX comments are stripped only outside fences. Plant suite 64/64. The G7 validation block exits 0.
- Carried to G11: `genie-loop.mp4` needs a poster (`genie-loop.jpg`).

### Owner decisions — 2026-10-02 (during G2 review)

- The session ID in the V2 `genie wish report` output stays visible ("Manter visível"). It is real program output.
- The capture transcripts ship outside `genie/` in the docs repo ("Transcrições fora de genie/"), so `council.js` in real output stays verbatim. Decision 5 is updated, and `docs-checks.sh media` and `numbers` read `captures/genie/`.

### Group 6 — owner checkpoint

- Felipe approved the rendered README first screen ("Aprovada") on 2026-10-02: mascote, thesis, the one-paragraph description, install, and the condensed real `/wish`. The G6 commit is `2504cfc4d`, and `bun run check` passed (3016 pass). `readme-checks.sh` passes, with 19 planted defects caught.

### Groups 8–10 review — 2026-10-02T15:28Z — SHIP

- Docs commits `54a91d2` (G8: 14 moved, 4 deleted), `90f043c` (G9: 13 moved, 4 deleted) and `ffc8e28` (G10: 14 moved, 5 deleted). The public tree is exactly the 15 nav pages plus `hacks` and `security/key-rotation`, and every group's validation exits 0.
- One independent review covered all three batches, under both the criteria lens and the quality lens (orchestrator ruling: mechanical renames and deletes).
  - All 41 renames are byte-identical, and all 13 deletes are v4 infrastructure or retired skills.
  - There are no retired-terminology tokens.
  - 15 dead links remain in pages that G11 and G12 rewrite:
    - index:141,144,147
    - installation:225,228,234
    - quickstart:52,247,250,253
    - security/index:52,55
    - hacks:183
- Notes:
  - The `cli/infrastructure` delete reason undersells it: it also described the then-current verbs setup, doctor, update, uninstall and shortcuts in their v4 form.
  - The moved `_internal/` pages are pre-v6 history.
  - Release-workflow comments still point at `docs/release-process.mdx` (follow-up, out of scope).

### Group 2 review — 2026-10-02T15:31Z — FIX-FIRST → SHIP

- Review 1 found the encoded `~/.claude/projects` path, a session-UUID path tail, the `council.js` placement against docs lint, and missing run samples. The repair re-ran `redact.py` (brainstorm 31 frames, council 24), made `--check` case-insensitive with a wider pattern, and wrote NOTES.md. Owner rulings: the report's session id stays, and transcripts move to `captures/genie/`. Re-review SHIP: 6689 files, 0 hits; the only UUID left is the ruled one.
- LOW for Felipe: `brainstorm.capture.txt:56` names the Linear project "gtm - opensource".
- Condition for G4: render from `frames-redacted/` only.

Run samples (from captures/NOTES.md, one sample each):
## Token and time per run (one sample each, not averages)

- **Tokens:** for each agent in the run (the main session plus every subagent), I took the context size at its last model turn (input, cache read, cache creation and output tokens) from its session file, then summed them. That is the measure the per-agent token column of `genie wish report` matches.
- **Council exact figure:** council's workflow figure is exact. It comes from its run record, read after the run with `genie wish report wf_5d33c2e6-dd3`, without `--append` or `--summary`, so nothing was written to the ledger.

| Run | Time | Tokens |
|-----|------|--------|
| `/work add-clamp` | 2m 4s | ≈151k (coordinator ≈64k, engineer ≈45k, reviewer ≈42k) |
| `/review` (take 2, shipped) | 37s | ≈57k (one session) |
| `/review` (take 1, discarded) | 48s | ≈60k (one session) |
| `/council` | 2m 0s | workflow `wf_5d33c2e6-dd3`: 1.1 min, 257,881 tokens, 6 agents (exact); ≈326k with the main session (≈68k) |
| `/fix` | 54s | ≈101k (main session ≈60k, re-reviewer ≈42k) |

### Group 4 — owner checkpoint (2026-10-02)

- Felipe approved `sop-wish` (42 s) and `quickstart-wish` (50 s) as the style for the rest, and ruled on three points:
  - **Plan and quota:** the status-bar account plan and quota are hidden. This counts as part of the host-data edit. The caption now reads "Edited in two places: host details hidden (paths shown as ~/, account plan and quota), and the agent launch line removed."
  - **Badges:** both badges say replay. The SOPs read "simulated · replays a real run", and the Quickstart reads "time-lapsed replay of a real run".
  - **Brainstorm capture:** used as it ran, in Portuguese, naming the Linear project "gtm - opensource".

### Group 6 review — 2026-10-02T16:13Z — FIX-FIRST → SHIP

- g6-engineer `2504cfc4d` and the repair `a1318bec9` were merged with `--no-ff` into `wish/genie-launch`. `readme-checks.sh` passes. `bun run check` gave 3016 pass on the re-run; the first run had one unidentified failure, which the reviewer reads as a likely flaky cold-start `--help` timeout, not something this change caused.
- Review 1 was the combined criteria + voice/accuracy review (orchestrator ruling: a docs-only change, so one reviewer covers both lenses).
  - It returned FIX-FIRST on M1: README:7 said "every … verdict stays in your repository", which is false for `/wish`.
  - It also raised LOWs: the uninstall row, the skill homes, the review roles, Intel Mac support, where the CLI keeps plans, the Superpowers claim, the jargon line, the transcript wording, the per-agent clause, the orphan PNG, and gaps in the checker.
- Felipe approved the new line 7 and the transcript restored to the V2 wording. Re-review on `a1318bec9`: SHIP.
- Kept as noted: `.github/assets/genie-header.png` is now unreferenced (left for later cleanup). `NOT_ALLOWED_RE` is shared by `readme-checks.sh` and `docs-checks.sh`.

### Group 4 review 1 — 2026-10-02 — FIX-FIRST (repair 1/2)

- The validation block exits 0. `redact.py --check` reports 6689 files and 0 hits.
- All seven videos are 1920x1080, H.264, 30 fps, under 8 MB. The SOPs run 42.53 s and the Quickstart 50.43 s.
- Every frame shows its badge, and every video ends on the exact caption. Paths show as `~/`, and the plan and the 5h/7d counters are blanked.
- MEDIUM: `sop-review` shows the entitlement counter "3 free /ultrareview" from 0 to 1.53 s, because the ACCOUNT patterns only match "N free X left".
- LOW: the source of the Quickstart's "0 questions asked" (`sop.html:63`) needs to be recorded. The `build_sop.py` END comment is wrong for fix.
- The four worker rulings were judged right or acceptable.
- Owner approval of sop-wish and the Quickstart before the other five were rendered: see "Group 4 — owner checkpoint" above.

### Group 4 re-review — 2026-10-02 — SHIP

- After repair 1, `redact.py` blanks any "N free …" entitlement counter at the same width, and `--check` and the `build_sop.py` scrub both fail on it. A planted copy exits 1 (proved by the reviewer).
- Only review frames 000016 to 000018 changed. `sop-review.mp4` was re-rendered: 2,333,916 B, 42.53 s. The other six videos are byte-unchanged.
- A scan of the render data across all seven data sets found 0 hits. `redact.py --check` reports 6689 files and 0 hits. The Group 4 validation exits 0, both from the reviewer and re-run by the orchestrator.
- Orchestrator ruling: one review covered both the criteria lens and the quality lens. The group ships media only (no code, nothing in a repo), and its quality risk is leakage, which the review's scans covered.
- Repair counter: 1 of 2.

### Group 11 review 1 — 2026-10-02 — FIX-FIRST (repair 1/2)

- Commit `14b5075`. The validation exits 0. Accuracy was checked against the tag: 12 workflows, 18 skills, flags and paths. The doctor excerpt matches live output. There are no leaks and no stale claims. The poster's eyes are closed. Every link is root-relative, and `mint broken-links` reports nothing in these five pages.
- MEDIUM: `quickstart.mdx:14` sets the wrong expectation for the gate. At v6.261002.2, `wish.js:149-150` hardcodes `bun run check` and `bun install --frozen-lockfile`, and the gate runs that check whenever a hook system exists (`wish.js:757,764`). Verified by the orchestrator. The approved README:109 has the same gloss, so it goes to the owner.
- LOW:
  - old em dashes in `installation.mdx` (112, 117, 163);
  - the trust-boundary list in `quickstart.mdx:98`;
  - "nothing runs in the background" at `index.mdx:50`, against `quickstart.mdx:45`;
  - the skills-home wording at `index.mdx:72`.
- Notes: README and docs agree on the install command (`-g` with `--agent`, never `--all`). The `docs.json` product description still says "Agent orchestration CLI", which is out of scope for G11. G15 should run `mint broken-links`.

### Owner decisions: the /wish gate in any repository (2026-10-02)

- Fix before the launch: chosen over documenting the limit. The trigger is the G11 review's MEDIUM finding: at v6.261002.2, `wish.js` hardcodes `bun run check` and `bun install --frozen-lockfile`, and asserts `.husky/_/pre-push` for every hook system.
- Where the commands come from: the scout discovers the check and install commands from repository evidence, and the judge freezes them in the contract next to `validationCommand`. The caller can override them with `check`/`install` args. In genie they still resolve to `bun run check` and `bun install --frozen-lockfile`.
- Hook liveness, generalized: with any hook system, the gate requires a live `pre-push` or `pre-commit` (not `.sample`) in the resolved hooks directory, inside the worktree. `.husky/_/pre-push` applies only to husky.
- Hooks present but no discoverable check: the gate falls back to the frozen validation command, says so in the report and the PR body, and treats CI as the authority.
- Delivery: a separate genie wish, planned by hand because `wish.js` is a trust boundary. It goes through work, a PR to dev, owner promotion, and a new stable approved by another maintainer.
- Effect on the launch: it moves to the new tag. G12 and G13 continue now, and a final retag pass replaces v6.261002.2 with the new tag.

### Group 11 re-review — 2026-10-02 — SHIP

- Docs commits `14b5075` and `8f2b6a2` were pushed to `feat/genie-v6-launch`.
- All five fixes were checked against the tag source. Line 14 is exactly true at v6.261002.2, and G18 rewrites it for the new tag.
- The validation block exits 0, and a full-text dash scan of the five pages finds 0 hits. The repair diff touches only the five repaired spots.
- Optional nit, not taken: the trust-boundary list leaves out the genie-specific `delivery-evidence-verify.ts`.
- One review covered both lenses: criteria, plus quality (accuracy against the tag, voice, leaks, links). Repair counter: 1 of 2.

### Plan amendment — 2026-10-02

- Decision 13 and Group 18 (retag at the launch stable) were added. G14 now depends on 1, 5, 6 and 18; G15 depends on 18. This follows the owner's choice "Wish no genie + docs seguem".
- The wish-level `depends-on: wish-gate-any-repo` stays out until that wish's WISH.md exists on this branch, because the lint rejects a slug it cannot resolve. The dependency is recorded in Decision 13 and in G18's depends-on.

### wish-gate-any-repo: plan review 1 (FIX-FIRST) and owner answers (2026-10-02)

- The review covers every site in `wish.js`. It raised four major findings:
  - the refusal sees only the command string;
  - the blind judge can author a command;
  - the evidence comes from model text;
  - husky 6 to 8 repositories are blocked.
- It also raised two minor findings: discovery edge cases, and the darwin scope wording.
- Owner answers:
  - husky 6 to 8 is covered by the general predicate, and `.husky/_/pre-push` applies only to husky 9;
  - "inside the worktree or the repository's git directory" is ratified;
  - the end-to-end runs are approved with both belts: `git-safety.sh` through `--settings`, and an assert that `GH_REPO` and `GH_HOST` are empty.
- Plan repair 1 has been dispatched to the planner.

### Group 12 review 1 — 2026-10-02 — FIX-FIRST (repair 1/2)

- Docs commit `894cc69`. The validation exits 0, and `mint broken-links` finds 0 hits in `genie/`.
- Verified:
  - the CLI paste is byte-identical to the tag;
  - the security claims hold at the tag: pinned identity, `sign-attest.yml`, `verify-release.sh`, reporting route;
  - the key-rotation drill is safe and correct;
  - the canisterworm diff contains only notes;
  - the hacks rebuild is in scope and every command exists;
  - all 57 exceptions are legitimate;
  - voice, numbers, links and leaks are clean.
- HIGH: `security/index:38-46` names two pin channels that do not exist (`automagik.dev/.well-known/security.txt` returns 404, and no pinned `SIGNING_CERT_IDENTITY` issue exists). The error is inherited from `SECURITY.md`. Owner ruling: list only the channels that exist. Issue automagik-dev/genie#3096 tracks `SECURITY.md` (filing it was owner-approved).
- MEDIUM:
  - canisterworm says v6 removed `genie sec`; it actually left in v4.260702.1;
  - the plugin retirement version in `release-notes:22` should be v5.260830.20.
- LOW:
  - the attestation fallback wording in `security/index:22`;
  - the "failure stops update" wording at `:23`;
  - hacks is missing 2 catalog entries;
  - key-rotation leaves out the second identity.

### Group 12 re-review — 2026-10-02 — SHIP

- Docs commits `894cc69`, `8c6514b` and `1fb1e54` are pushed to `feat/genie-v6-launch`.
- Fixed: all seven findings, plus three extra corrections of the same kind from the author (the Omni removal version, the sign-attest copy list, the `security.txt` bullet).
- Key-rotation's channel claims follow the owner ruling "list only channels that exist".
- Verified against the tag and live state:
  - the raw `security.txt` answers 200;
  - `check-fingerprint-pinning.sh` covers exactly the six witnesses;
  - the retirement ranges are right (`git tag --contains`);
  - the attestation wording matches `install.sh` and `classifyAttestationCrossCheck`.
- All 122 exceptions match whole lines, and none is unused.
- The validation exits 0. `mint broken-links` finds 0 in `genie/`, and the dash scan is clean.
- Carried to G18 (optional nit): `release-notes.mdx:58` "v6 writes nothing to `~/.genie/genie.db`" should read "nothing writes to it during normal use", because `doctor --fix-global-db` writes when asked.
- One review covered both lenses: criteria, and quality (accuracy, security correctness, voice, leaks). Repair counter: 1 of 2.

### Group 13 review 1 — 2026-10-02 — FIX-FIRST (repair 1/2)

- Docs commit `0840a4d`. The validation exits 0 and `mint broken-links` finds 0 in `genie/`.
- Media and transcripts match their sources by sha256. `redact.py --check` exits 0, and the reviewer's own leak grep is clean. Transcripts run 83 to 146 lines. MP4s are at most 6.25 MB.
- All six pages have their parts. The `$name` ruling holds against `skills/README.md:8-10` and the approved README. Accuracy, voice, numbers and links are clean. SC8 holds.
- HIGH: `wish.mdx:32` leaves husky out of the gate at the tag; the tag checks `.husky/_/pre-push` for every hook system. Must match `quickstart.mdx:14`.
- MEDIUM: `work.mdx:28` says the list of card posts is complete, but it misses `reclaim` and `blocked`.
- LOW:
  - `wish.mdx:16` says every run goes through the same stages, but a refused run stops at Admit;
  - the brainstorm transcript shows "Fable 5.1" (verbatim output, exempt) and internal planning lines 53-72 (owner ruled "Usar como está").

### Group 13 re-review — 2026-10-02 — SHIP

- Docs commits `0840a4d` and `d7e4b15` are pushed to `feat/genie-v6-launch`.
- The gate section in `wish.mdx` is exactly true at v6.261002.2 and consistent with the Quickstart. G18 retags it.
- `work.mdx` now lists every card post the tag's `skills/work/SKILL.md` names. `wish.mdx` says "every admitted run".
- The validation exits 0, `mint broken-links` finds 0 in `genie/`, and the dash scan is clean.
- One review covered both lenses: criteria, plus quality (accuracy, voice, leaks, media integrity). Repair counter: 1 of 2.

### Owner decisions: the viral README (2026-10-02, late)

- Felipe asked for a README model that is concise, dynamic and built to spread. It comes from analyzing the README form of recently viral repos (superpowers and others), and it extends the earlier distribution research.
- Wait for the viral README: nothing goes to dev until it is approved. The current G6 README, `UPGRADING.md` and the test retargets go out together with it in one PR.
- Format: an analysis plus three rendered first-screen variants, each taking a different stance, with a skeleton of the rest of the page. Felipe picks one, and then the full README is written.
- Running alongside: the gate fix is merged to dev (#3097, `53f2186`), and dev release v6.261002.6 is published with 20 assets. Promotion PR #3094 (dev→main) is waiting for Felipe.

### Owner decisions: README model A (2026-10-03)

- Analysis: 16 READMEs pinned and measured (`scratchpad/readme-viral/ANALYSIS.md`). Three first-screen variants were rendered: A demo-first, B thesis plus loop, C problem-first.
- Felipe picked **A, demo first** over the recommended C. The first screen he approved from the preview:
  - a small mascot;
  - the thesis, verbatim;
  - the `/wish` run as the hero, labelled as one sample;
  - a new sentence on what `/wish` does;
  - the install.
- Hero form: **a short looping GIF** (about 15 to 20 s, at most 5 MB, autoplaying on GitHub, no manual step). Clicking it opens the full video on the docs Quickstart page.
- The rewrite replaces the G6 README on `wish/genie-launch` and goes to dev in one PR with `UPGRADING.md` and the test retargets.

### G6b review — 2026-10-03 — SHIP

- Commit `1f5fc9ecb` (README 174 lines plus `.github/assets/wish-run.gif`, 1.85 MB, 19.75 s).
- Checks:
  - `readme-checks.sh` reports 61 PASS. The checker edit only changes the owner-approved mascot width and adds two GIF checks; nothing was weakened.
  - `release-docs` passes 45 tests. The card and skills tests pass 132.
  - `bun run check` exits 0, with 3016 tests passing.
- The first screen matches the approved model A apart from the caption (rewritten to carry the two-edit disclosure and the video link) and the switch from poster to GIF. No unlisted change touches approved copy.
- Every claim is accurate against origin/dev and v6.261003.1. Voice and numbers are clean.
- The GIF's badge is pixel-identical on all 237 frames, and no frame leaks. Links return 200, except Workflows and CLI reference, which arrive with G15.
- Rendered length is 4281 px, down from 6394 (−33%). About 101 lines show with the `<details>` blocks folded.
- LOW notes:
  - the Quickstart video and the Workflows and CLI pages arrive with G15; say so in the PR body;
  - the tag-bound lines are true at v6.261003.1, and G18 retags;
  - four new `<summary>` labels;
  - program-output figures inside the GIF come from the owner-approved video.

### G6b owner approval — 2026-10-03

- Felipe approved README model A ("Aprovado") with these changes to approved copy, each listed for him first:
  - the caption was rewritten;
  - the loop line and the dogfood sentence were added;
  - a new "untrusted repositories / no integration branch" bullet;
  - the plain-language examples were removed;
  - four new `<details>` labels.
- Stable v6.261003.1 is published (it carries #3097), with notes applied. The host is updated and verified: the installed `wish.js` equals the tag, and doctor reports workflows 12/12 and skills 18/18 at v6.261003.1.

### Group 18 review — 2026-10-03 — SHIP

- Docs commit `6f8ac57`, README commit `8c48f91`, and the orchestrator's low fixes in docs `f74218a`.
- Every check holds at v6.261003.1:
  - every tag swap is in place, and the counts are 18, 12 and 16;
  - the CLI paste is byte-identical to the tag and to the host binary;
  - the doctor excerpt matches the host;
  - every claim in the gate copy is verified against `wish.js` at the tag;
  - the `release-notes:58` wording is accurate;
  - the README diff touches only the tag strings.
- The validation exits 0 when run from wt-gl. LOW-4 fixed this in the plan with a `cd`.
- LOW fixes applied:
  - the override sentence now says "the workflow's `check` and `install` args replace them";
  - "that" now reads "the gate".
- LOW-2 was noted and left as is: README:10 "runs your repository's own check" is a simplification of approved copy, true whenever the repository has hooks and a discoverable check.
- One review covered both lenses.

---

## Files to Create/Modify

```
# automagik-dev/genie (wish/genie-launch → dev)
.genie/brainstorms/genie-launch/DESIGN.md          (amended + re-stamped, before G1)
.genie/wishes/genie-launch/WISH.md, .genie/INDEX.md, .genie/roadmap.json   (G1)
UPGRADING.md (new), README.md                      (G5, G6)
scripts/release-docs.test.ts, scripts/skills-retirement-restore.test.ts   (G5)
CLAUDE.md                                          (G5: one pointer line)
package.json                                       (G6: description URL only)
.github/assets/genie-loop.gif                      (G6, from G3)

# automagik-dev/docs (feat/genie-v6-launch → main), worked in wt-docs/.docs-vendor
docs.json, genie/skills/index.mdx, genie/workflows.mdx, genie/cli-reference.mdx (stubs), genie/installation.mdx (one line)   (G7)
genie/cli/**, genie/observability/**                                  (G8: moved or deleted)
genie/config/**, genie/architecture/**, genie/concepts/**             (G9: moved or deleted)
genie/skills/{non-core}.mdx, features, onboarding, contributing, release-process, security/{distribution-sovereignty,verifying-installs}, 2 stray .md   (G10)
genie/index.mdx, installation.mdx, quickstart.mdx, skills/index.mdx, workflows.mdx, videos/genie-loop.mp4, videos/quickstart-wish.mp4 + poster   (G11)
genie/cli-reference.mdx, release-notes.mdx, security/index.mdx, incident-response/canisterworm.mdx, hacks.mdx, security/key-rotation.mdx   (G12)
genie/skills/{brainstorm,wish,work,review,council,fix}.mdx, videos/sop-*.mp4 + posters; captures/genie/*.capture.txt (docs repo root)   (G13)

# automagik-dev/genie (chore/bump-docs-genie-launch → dev)
.docs-vendor                                       (G16)

# outward, approved one by one (G17)
automagik-dev/.github profile/README.md (PR), repo descriptions and topics, forge issues/PRs closed and archive
Felipe's own steps: org description, org pins, namastex888 bio, pins, profile README, archives

# scratchpad only (never committed)
sop-fixture/, captures/ (+ redact.py), media/, org/, kv-rig looping-lockup mode, upgrading-diff.py, readme-checks.sh, docs-checks.sh, docs-current-exceptions.txt
```
