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
| 5 | A capture transcript is the redacted plain text of the real run's final screen and scrollback, the command and its output, at most 150 lines. Every cut in a longer run is marked inline as `[… N lines elided …]`. It sits next to its video at docs `genie/videos/<skill>.capture.txt` | "A saved capture file next to its source", at a reviewable size. The raw ANSI frame archives stay in the scratchpad |
| 6 | Real captures are recorded the way V2 was: an interactive session in tmux, with `capture-pane -e` frames to disk, in a throwaway repository cut from a small fixture | The method is proven, and it never touches real work |
| 7 | The docs moves follow one rule. Pages with engineering value move to `genie/_internal/`, including `concepts/byoa` and `release-process`. v4-only pages and the retired skills' pages (brain, learn, pm, trace, wizard) are deleted. `genie/hacks` and `genie/security/key-rotation` stay at their paths outside the nav, count as public pages, and are brought up to v6 | Design B, as amended |
| 8 | Forge's 28 open issues and 6 open PRs are each closed with one approved comment pointing to genie. Forge is archived after that | Design D, as amended. PRs were included by owner decision on 2026-10-02 |
| 9 | Felipe does these steps himself, from exact instructions: the org description (it needs an org owner with `admin:org`; automagik-genie is a member with `repo` scope); the 4 org pins and the namastex888 pins (GitHub has no API for pins); and every namastex888 write (bio, profile README, archives). The agent never switches the `gh` account to namastex888 | The token here is automagik-genie |
| 10 | G14 (genie) and G15 (docs) have no order between them. G17 starts only after G14's merge has been promoted to `main` and G15 has merged. G16 starts only after G15 has merged | Design Approach, as amended. Each validation checks the merge it waits on |
| 11 | All docs work happens in one dedicated worktree, `scratchpad/wishrun/wt-docs`: a genie worktree detached at `origin/dev` whose `.docs-vendor` checks out `feat/genie-v6-launch`. Nothing is ever committed in that worktree's superproject. The docs groups run in sequence on that one branch | One docs branch, no `.docs-vendor` gitlink near the genie PR, and genie's docs lints run against the branch |
| 12 | Numbers. Verbatim program output (captures, videos, the pasted CLI) and text moved verbatim into `UPGRADING.md` are exempt from the Allowed numbers list. All new copy follows the list. No figure on the not-allowed list appears anywhere, exempt output included, so no capture or paste of `genie wish report --summary` ships | Owner decision on 2026-10-02, recorded in the design |

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

### Wave 5

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
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
2. `genie/videos/sop-<skill>.mp4`, the posters, and `genie/videos/<skill>.capture.txt`.

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
1. Run `bun run check` on the final head. Push, open the PR, and read back head, base and file set. The file set may contain only README, UPGRADING, the two test files, `CLAUDE.md`, `package.json`, `.github/assets/genie-loop.gif` and `.genie/`.
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
set -o pipefail; bun run check && test "$(git rev-parse HEAD)" = "$(gh pr view "$PR" --json headRefOid --jq .headRefOid)" && ! gh pr view "$PR" --json files --jq '.files[].path' | grep -vE '^(README\.md|UPGRADING\.md|CLAUDE\.md|package\.json|scripts/release-docs\.test\.ts|scripts/skills-retirement-restore\.test\.ts|\.github/assets/genie-loop\.gif|\.genie/.*)$' | grep -q . && gh pr checks "$PR" --json name,bucket --jq '[.[]|select(.name|startswith("Unit ("))|.bucket]|(length==2 and all(.=="pass"))' | grep -qx true
```

**depends-on:** 1, 5, 6

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

**depends-on:** 13

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
genie/skills/{brainstorm,wish,work,review,council,fix}.mdx, videos/sop-*.mp4 + posters, videos/*.capture.txt   (G13)

# automagik-dev/genie (chore/bump-docs-genie-launch → dev)
.docs-vendor                                       (G16)

# outward, approved one by one (G17)
automagik-dev/.github profile/README.md (PR), repo descriptions and topics, forge issues/PRs closed and archive
Felipe's own steps: org description, org pins, namastex888 bio, pins, profile README, archives

# scratchpad only (never committed)
sop-fixture/, captures/ (+ redact.py), media/, org/, kv-rig looping-lockup mode, upgrading-diff.py, readme-checks.sh, docs-checks.sh, docs-current-exceptions.txt
```
