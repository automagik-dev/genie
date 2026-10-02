# Design: Genie launch foundation (README, v6 docs, media, org pages)

| Field | Value |
|-------|-------|
| **Slug** | `genie-launch` |
| **Date** | 2026-09-29 |

## Problem

Launch traffic lands on a README that spends most of its first screen on retirement notes. The public docs describe v4/v5 (Postgres, daemons, Orca, npm) as current, and the org and profile pages are empty or stale. Felipe will not post until every surface a visitor reaches explains v6 simply, skills first, with images and short videos.

## Scope

### IN
- **A. genie README rewrite + UPGRADING.md** (automagik-dev/genie, PR to `dev`).
  - Hero: the animated mascot loop (face as mascot + GENIE wordmark), the thesis line, a one-paste install.
  - A short You:/Genie: transcript of one `/wish`.
  - The loop: brainstorm, wish, work, review, plus council.
  - A skills catalog: every shipped skill (the 18 directories with a `SKILL.md`, the set `SHIPPED_SKILLS` in `scripts/release-docs.test.ts` pins), one plain line each; the six core skills get a card image, which group A embeds from `.github/assets/skill-<name>.svg`.
  - Every saved workflow (each `.claude/workflows/*.js` at the release tag used at execution; 12 at v6.261002.2), one line each, including `evidence-gate`, named without the `.js` suffix (owner decision 2026-10-02).
  - "When not to use it / what it costs", using only figures from the Allowed numbers list below.
  - A short comparison with Superpowers, spec-kit and GSD.
  - Links to docs and the org.
  - The link in `package.json`'s description moves from `automagik.dev/genie/release-process` (404 today) to `https://docs.automagik.dev/genie/security`.
  - The retirement, rollback, restore, MCP and Orca text moves verbatim to a new `UPGRADING.md`, keeping its headings, including `#### Restoring from a retirement backup`.
- **B. v6 docs refactor** (automagik-dev/docs, `genie/` section, PR to its `main`; the `.docs-vendor` pointer is bumped in a separate genie PR only after that docs PR merges). At most 15 nav pages:
  1. Introduction
  2. Install (stays at `genie/installation.mdx`)
  3. Quickstart (first wish)
  4. Skills catalog, with one skill card image per shipped skill, all 18, which group B embeds from `genie/images/skills/<name>.svg` (skill-cards R2-3)
  5–10. One page each for brainstorm, wish, work, review, council, fix
  11. Workflows
  12. CLI reference (pasted from `genie --help` of release tag v6.260929.2, or the newest stable tag at execution time, named on the page). The paste is verbatim: while the retired `orca` stub and the `mcp` wording in `init` still ship, a note on the page names `orca` as a retired stub and `mcp` as a removed verb (owner decision 2026-10-02)
  13. Upgrading and retired (stays at `genie/release-notes.mdx`)
  14. Security and releases, with one factual line on leaving npm for signed releases
  15. The incident write-up (stays public at `genie/incident-response/canisterworm.mdx` as the Security page's link target). B adds v6 guidance where it recommends the removed `genie sec`; the incident record is otherwise unchanged
  - Everything else, except the reachable pages below, moves to `genie/_internal/` or is deleted.
  - Orphan pages are unpublished, except the two pages shipped code or a pinned page links to: `genie/hacks` (from the shipped `genie-hacks` skill) and `genie/security/key-rotation` (from the incident page). They stay reachable at their paths, outside the nav, so no shipped link breaks. They count as public pages for the grep criterion, and B brings each up to v6 where it presents v4 as current. `concepts/byoa` moves to `_internal/` and B's Install drops its link; `release-process` moves to `_internal/` and A retargets the link in `package.json`'s description to the Security and releases page (`https://docs.automagik.dev/genie/security`).
  - Links inside docs pages stay root-relative (`/genie/...`); the `docs.automagik.dev` domain applies to links from the README, skills, `package.json` and the org and profile pages.
  - Open docs PR automagik-dev/docs#84 (`feat/genie-v6`) is superseded: B is written fresh on docs `main`, and #84 is closed with a pointer to B's PR (owner decision 2026-10-02).
  - The docs host: the Mintlify deployment has not tracked docs `main` since before 2026-09-01, and Felipe will migrate off Mintlify soon (2026-10-02). B delivers the content in automagik-dev/docs; putting it live belongs to that migration, not to this wish. Links keep `docs.automagik.dev`, accepting 404s on new pages until the migration (owner decision 2026-10-02).
  - The docs.json nav label "RLMX" becomes "mikro". This is a label-only change to the shared nav and needs Felipe's approval in the docs PR.
- **C. Media**, committed as static assets. The skill card images come from a tracked generator; everything else is produced in the scratchpad.
  - README assets live in the genie repo under `.github/assets/`: the mascot loop GIF and the six core skill cards.
  - Docs assets live in the docs repo under `genie/images/` and `genie/videos/`: the 18 skill card images, one per shipped skill at `genie/images/skills/<name>.svg`, and the SOP videos (skill-cards R2-3).
  - Assets:
    - the animated mascot (loop MP4 and GIF, from the code rig);
    - the skill card images in design B, one per core skill for the README and all 18 for the docs, from the tracked generator `scripts/skill-card-images.ts` (skill-cards R1-4, R2-3);
    - one SOP video per core skill, 30 to 60 seconds, with a simulated terminal labelled "simulated" on screen;
    - the real `/wish` capture (V2) embedded in Quickstart.
  - Each SOP video ships with a saved capture file (the real command and output it replays) next to its source; the shipped capture file is the redacted copy. The `/wish` (V2) and `/brainstorm` captures exist; work, review, council and fix get real runs recorded in a throwaway repository (owner decision 2026-10-02). Before any render, captures are redacted: host paths become `~/`, and the line that launches the agent with `--dangerously-skip-permissions` is cut; the video says it is edited at those two points (owner decision 2026-10-02). Claude Code's permission-mode status line ("bypass permissions on") stays visible, because it shows how the run really ran (owner decision 2026-10-02).
- **D. Org and profile pages.** These are outward-facing GitHub writes, each done only with Felipe present and approving it.
  - **automagik-dev:** org description, 4 pins (genie, workit, autopg, mikro), a new profile README, per-repo descriptions and topics, and the Forge archive after closing its open issues with a pointer to genie. Filming the archive belongs to the launch video work, not to this wish.
  - **namastex888:** bio, 6 pins, a new profile README, and archiving empty originals.

### OUT
- The launch posts and the hero videos V1/V2/V3 and the bar-chart race (produced separately; not repo work).
- Reddit, HN, the long essay, beta outreach.
- The Socratic council type (NMSTX-766) and the test cleanups (NMSTX-767/768): separate wishes.
- Changing the docs framework, adding a website, or a site-wide docs theme change.
- Media in CI: a bun test checks the six README cards; CI renders nothing (skill-cards R2-2).
- Omni in the genie README and in `genie/` docs pages. The Omni product docs elsewhere on the site are untouched.

## Allowed numbers (the permission list; sources are citations only)

The source files are gitignored brainstorm notes. This list is the tracked authority. Any figure not on it does not ship.
- 182,960 lines deleted across 739 files in one commit (3d5d16596, 2026-07-02); its tests passed (430/430); bundle 5.8 MB to 0.9 MB.
- Source files 943 to 209 at that commit, while the 201 context docs under `.genie` stayed at 201.
- Subsystem lifetimes: pgserve 104 days, Tauri desktop app 95 days, TUI 96 days, Orca plugin 35 days.
- Six versions (v1 to v6) over 14 months, each built with the Claude generation of its time, never "because of" it.
- Plan size vs merge, n=50 wishes, observational: merged within 8h 100% (n=9), 95% (n=19), 67% (n=12), 30% (n=10).
- The reviewer is also fallible: #3045 passed a wrong gate command; #2935 met 68 of 86 blind criteria with 3 HIGH gaps.
- The filmed V2 run's own figures (wall-clock time, tokens, questions asked), as printed by `genie wish report <runId>` for that run, labelled as one sample.
- The counts of shipped skills, saved workflows and top-level commands, read from the repo at the release tag used at execution (at v6.261002.2: 18, 12 and 16).
- Not allowed anywhere in A–D: commit or PR totals, 14/58 or any merge-ready rate, the 511k-token or 22-minute averages, SHIP rates, human/agent splits, lines of code of PRs, cost multiples.

## Approach

One wish with four groups. A and B are independent. C supplies assets to A and B. Each asset lands in the same PR as the page that uses it, but the skill card images land ahead of their pages: group A embeds the six from `.github/assets/` in the README skills catalog, and group B embeds the 18 from `genie/images/skills/` in the "4. Skills catalog" page (skill-cards R3-4, R4-2). D runs after A is visible on the default branch. That requires the dev to main promotion, which only Felipe merges. It also requires B's docs PR to be merged; it does not wait for the docs site to be live (owner decision 2026-10-02, Mintlify migration pending).

Copy follows Felipe's voice rules and gets a deslop pass: no hashtags, no dash punctuation, no "não é X, é Y" rebuttals. "Wishes in, PRs out" and "context framework" are not used as headlines.

Alternatives considered:
- A new marketing site: rejected, a second surface to keep true.
- Showing real footage in every SOP: rejected for speed. Each SOP replays a recorded real run in a terminal labelled simulated; only the V2 `/wish` run is shown as real footage.
- A site-wide neon docs theme: out, because it restyles the other products sharing docs.json.

## Simplicity Case

- **Simplest complete design:** static markdown/MDX pages plus static images and video files, committed in the PR of the page that uses them; the skill card images land ahead of their pages (skill-cards R3-4, R4-2).
- **Added machinery:** the card pipeline is the tracked `scripts/skill-card-images.ts` plus one bun test (skill-cards R1-4, R2-2). The SOP videos stay on one throwaway local render pipeline (HTML frames, Chromium, ffmpeg), kept in the scratchpad. Nothing new ships in genie's runtime, and CI renders nothing.
- **Deferred until measured:** a CLI-reference generator in CI, when the reference drifts twice. A genie-only docs theme, when Mintlify supports per-product theming or Felipe approves a site-wide change. PT docs, when PT traffic shows up.
- **Complexity removed:** the genie public nav drops from 65 pages to 15 or fewer, and the retirement prose leaves the README's first screen. No test is dropped: README assertions about text that moves are retargeted to `UPGRADING.md`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Launch waits for A–D | Owner: everything ready to receive people; unanimous council condition. |
| 2 | Docs are skills-first | Owner: simple, focused on the skills and what they do. |
| 3 | SOP videos use a simulated terminal, labelled, each backed by a saved real capture | Speed with honesty; nothing is invented. |
| 4 | Neon (design B) for genie media and pages; site theme unchanged | Owner chose neon; docs.json is shared. |
| 5 | Face as mascot + GENIE wordmark | Owner decision. |
| 6 | README tests are retargeted, not narrowed | `release-docs.test.ts` pins real README contracts (release channel authority, review names, MCP ownership, command table, `/wish` invocation forms). `skills-retirement-restore.test.ts` executes the restore block. Assertions follow the moved text into `UPGRADING.md`. |
| 7 | Keep `installation.mdx`, `release-notes.mdx` and `incident-response/canisterworm.mdx` at their paths | genie's `lint:docs-links`, `lint:docs-markdown` and `.github/workflows/docs-lint.yml` pin them; moving them fails the pointer bump. |
| 8 | Outward GitHub writes (D) only with Felipe approving each | Hard to reverse and public. |
| 9 | Counts come from the repo at the release tag used at execution, and the CLI page pastes `--help` verbatim with a retired-stubs note | Owner decision 2026-10-02: the catalog grew to 12 workflows after the design, and the `orca` stub and the `mcp` wording in `init` ship until a later release. |
| 10 | B is content in the docs repo; the site going live waits for the Mintlify migration, D does not | Owner decision 2026-10-02. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | README rewrite breaks `scripts/release-docs.test.ts` and `scripts/skills-retirement-restore.test.ts` | High | Retarget assertions to `UPGRADING.md` or README plus UPGRADING. Delete no README assertion unless the PR body lists it with a reason. Run `bun run check`. |
| 2 | Docs refactor breaks genie's docs-lint on the pointer-bump PR | High | Keep the three pinned paths. Workflows are named without `.js` because docs-lint greps for `council\.js`. Run docs-lint locally on the bump PR. |
| 3 | A simulated terminal is read as fake | Medium | On-screen "simulated" label; each SOP replays a saved real capture; the real V2 run is shown in Quickstart. |
| 4 | Media bloats the repos | Medium | GIF ≤ 3 MB, each MP4 ≤ 8 MB. |
| 5 | Docs pointer bumped before the docs PR merges | High | Follow the CLAUDE.md docs rule: bump only after merge, in its own PR. |
| 6 | A figure outside the Allowed numbers list ships | Medium | The reviewer checks every figure in A–D against the list. |
| 7 | D is done before visitors can see A | Medium | D starts only after the dev to main promotion Felipe merges and after B's docs PR merges. |
| 8 | New docs pages 404 on `docs.automagik.dev` until the Mintlify migration | Medium | Accepted by the owner (2026-10-02); links keep the domain, and the content is ready in the docs repo for the new host. |
| 9 | A capture shows host paths or the permission-skip flag | Medium | Redact host paths to `~/` and cut the agent launch line before any render; the video states the two edits. |

## Success Criteria

- [ ] README first screen (to the first `##` after the hero) holds the mascot, the one-paste install and the /wish transcript, and contains none of: "retire", "rollback", "MCP", "Orca", "npm".
- [ ] `UPGRADING.md` exists; a diff script confirms every paragraph removed from README appears in it, including `#### Restoring from a retirement backup`.
- [ ] Every skill in `SHIPPED_SKILLS` (directories with a `SKILL.md`) appears in the README catalog and the docs Skills page, and every `.claude/workflows/*.js` name appears on both, including `evidence-gate`. A comparison script exits 0.
- [ ] `bun run check` exits 0 on the genie PR, and the PR body lists any removed README assertion with a reason.
- [ ] The docs `genie/` public nav has ≤ 15 pages; `.github/workflows/docs-lint.yml` and `bun run lint:docs-links` pass on the pointer-bump PR.
- [ ] A grep over public genie pages finds no Postgres, pgserve, daemon, Orca, npm, `genie spawn`, `genie team` or `genie sec` presented as current, and no `council.js`; the pasted CLI output under its retired-stubs note is excepted.
- [ ] The CLI reference page names the release tag its `--help` output came from.
- [ ] The six core skills each have a card image and an SOP video labelled "simulated", each with its saved capture file; GIF ≤ 3 MB, each MP4 ≤ 8 MB.
- [ ] Every figure in A–D is on the Allowed numbers list.
- [ ] Every shipped capture file, and the frame data each video renders from, matches none of `sofia-agents|/scratchpad|-scratchpad-|/home/genie|khal|ghp_|sk-|Bearer|dangerously-skip-permissions`, and each video rendered from a capture shows its two-edit note.
- [ ] Newly written copy (excluding verbatim `UPGRADING.md` blocks, fenced code and pasted CLI output) passes a grep for `—`, `–`, spaced hyphens used as punctuation, hashtags and "não é/não era" rebuttals.
- [ ] The org shows a description and 4 pins; forge is archived with its issues closed; the namastex888 profile shows the new bio, pins and README; each write was approved by Felipe.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `3d2ed3afcabb4fbe60aaffbf6c11e0a9a582cc2ffc5210749f27a63a99ef7a85`
- **Reviewer:** claude-opus-5-5, independent read-only design reviewer
- **Reviewed at:** 2026-10-02T13:39:22.000Z
<!-- genie-design-review:end -->
