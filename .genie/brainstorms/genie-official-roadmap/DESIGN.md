# Design: Genie Official Roadmap — full-jar triage into the canonical board

| Field | Value |
|-------|-------|
| **Slug** | `genie-official-roadmap` |
| **Date** | 2026-07-28 |
| **WRS** | 100/100 |

## Problem

36 wish dirs and 24 brainstorm dirs have accumulated with statuses drifting between WISH.md headers, INDEX.md prose, and dev reality; there is no single official roadmap. This blocks Felipe's #1 axis (public-facing polish): the project cannot present what is done, in flight, or next — even though the machinery (roadmap board, lanes, canonical `roadmap.json`) now exists.

## Scope

### IN
- **Archive move:** `git mv` the 29 DONE-verified wishes to `.genie/wishes/archive/<slug>/`, WITH the link rewrites the depth change requires:
  - Intra-wish design links: `../../brainstorms/…` → `../../../brainstorms/…` (17 links across ~15 archived WISH.md files; wishes-lint walks `archive/` recursively, so these are gate-enforced).
  - Cross-wish links whose endpoints split: `genie-ui/WISH.md` → `../genie-ui-dash/WISH.md` becomes `../../genie-ui-dash/WISH.md` (target survives outside archive). Links where both endpoints move together (agent-sync↔pr-2545 ×3, routing-delivery-fix↔routing-matrix, pr-2545↔stable-release-security-gate) stay as-is.
  - Repo-escaping links in pr-2545's REVIEW-DISPOSITION.md / FINALIZATION-VERIFICATION.md: `../../../.claude/…` → `../../../../.claude/…`.
  - Verification: `bun run wishes:lint` (covers brainstorm links incl. inside archive) PLUS an explicit link-resolution sweep — every markdown relative link in moved files and in INDEX.md resolved against the filesystem (one-off script or grep+test loop); INDEX.md is NOT covered by any existing lint and must be swept manually.
- **Board seed** (cold seed — baseline recorded below): create the `roadmap` board (6 lifecycle lanes) and one lifecycle card per surviving initiative. Every card is created then explicitly `task move`d to its lane (CLI `task create` cannot set lanes, and NULL-lane cards render deceptively) — a card without a non-null lane in `genie task export` is a seeding failure. Full enumeration (19 cards):
  - **Work (4):** codex-plugin-dogfood-remediation, v4-home-residue-doctor, release-ops-hardening, proportional-validation-policy — priority order per D4, encoded in INDEX prose (DAG stays doc-only).
  - **Review (3):** genie-ui-dash (fork QA), live-dev-loop (fork QA), ritual-QA checklist (bundled: council live run, genie-mcp Warp QA, warp pane checklist, agent-sync convergence, update-handoff homolog dogfood, taxonomy PATH export).
  - **Wish (1):** khal-rebrand (approved, unexecuted, fork).
  - **Brainstorm (5):** genie-boards-ui, intent-to-wish-compiler, brainstorm-domain-map, cross-agent-delegate, genie-official-roadmap (this initiative; its card moves to Done when this wish ships).
  - **Idea (6):** control-plane-contract, skill-absorbs, always-on-genie, genie-spend, dream-replatform, public-roadmap-polish (new).
  - **Excluded:** khal-app-kit-identity + genie-remote-ssh (relocated to fork — INDEX line only, no card); khal-native-theme (same).
- **INDEX.md rewrite:** new **Shipped** section (one line per archived wish, links pointing into `archive/`); lifecycle sections (Raw/Simmering/Ready/Poured) reconciled to the card set above. Named repairs: remove the duplicated khal-native-theme RELOCATED bullet (conflict residue, lines 39+41); correct the codex-plugin-update-handoff entry ("Groups C–E not started" contradicts the wish's SHIPPED header — PR #2617 merged 2026-07-22); stable-release fact stated precisely as "first full stable v5.260727.5 (2026-07-27); current stable pinned at execution time" (v5.260728.8 as of review — verify fresh). Constraint: no lifecycle-section entry may use a `wishes/archive/…` path as its FIRST link (the drift lint's slug regex would capture `archive`); Shipped-section entries are outside the drift lint by design (documented property, not an accident).
- **Existing boardless rows:** the 29 group-task rows (incl. 6 hard-blocked khal-native-theme tombstones and 4 done genie-ui rows) stay untouched as execution history — cards and group tasks are different layers (D3).
- **New brainstorm:** `public-roadmap-polish` DRAFT + INDEX Raw entry (publish roadmap outward + docs/onboarding sweep) — drafted, not executed.
- **Publish:** pre-commit sync lands the seeded board in `roadmap.json`; criterion measured against the recorded baseline (`boards: []`, 29 boardless tasks, zero cards).

### OUT
- No execution of any triaged wish (dogfood criteria, doctor checks, release hardening stay their own wishes).
- No fork (khal-os/genie-desktop) changes; its wishes are represented as cards only.
- No changes to sync/board/lint machinery (any INDEX-link lint gap closure is future work — this wish uses a one-off sweep).
- No brainstorm-dir moves or deletion; brainstorm cleanup is a later pass.
- The board's Done lane starts empty on purpose: done-ness is presented by the INDEX Shipped section this round; surfacing shipped work on the published board is scoped to `public-roadmap-polish` (D6).

## Approach

Single documentation-and-state pass over the audited inventory (3-scout evidence audit, 2026-07-28, per-wish PR/commit verification recorded in DRAFT.md). Alternatives considered: (a) INDEX-only cleanup without board seeding — rejected: leaves the roadmap unpublished, failing the #1 axis; (b) full re-review of each DONE wish before archiving — rejected: the scout audit already verified merge evidence; re-review adds cost without new information. Chosen: archive + link-rewrite + seed + rewrite in one wish, gated by wishes-lint, a full link-resolution sweep, doctor drift lint, and a lane-non-null export assertion.

## Simplicity Case

- **Simplest complete design:** git mv 29 dirs + ~25 link rewrites, 19 `task create` + 19 `task move` calls, one INDEX rewrite, one new brainstorm DRAFT.
- **Added machinery:** none persistent — one throwaway link-resolution sweep during execution (a lint gap exists; closing it durably is deferred).
- **Deferred until measured:** durable INDEX/markdown link lint; brainstorm-dir archiving; auto-lane-sync from WISH status (only if manual drift recurs).
- **Complexity removed:** no new schema, no dependency rows, no INDEX generator — prose stays human-authored per repo contract.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Priority axes = public polish · dogfood pain · stable-release track (desktop parked) | Felipe, 2026-07-28 |
| 2 | DONE wishes → `.genie/wishes/archive/<slug>/` | History preserved, active dir lean; Felipe picked over stay/delete |
| 3 | Roadmap board = canonical tracker; boardless group tasks stay the execution layer, untouched by this wish | Felipe; lanes stay non-spammy (one card per initiative) |
| 4 | Work-lane order: dogfood-remediation → v4-residue → release-ops → proportional-validation | Felipe ratified proposed order |
| 5 | 6 ritual-QA items = one bundled Review-lane card; their wishes archive now | Felipe; code evidence verified, rituals tracked without holding dirs open |
| 6 | Public-polish axis gets a NEW brainstorm (`public-roadmap-polish`), drafted not executed; it owns surfacing Done/Shipped outward | Gap: axis #1 had no wish; Done-lane emptiness this round is deliberate |
| 7 | Card enumeration is closed (the 19 listed) — anything else is an INDEX line, not a card | Reviewer finding: "no initiative missing" must be decidable |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Archive move breaks relative links | High if unmitigated | Explicit link inventory in Scope; wishes-lint gates brainstorm links (recursively, incl. archive); one-off resolution sweep covers INDEX.md and non-brainstorm links, which NO existing lint checks |
| 2 | Scout audit overclaims a DONE | Low | Scouts cited merged PR/commit per wish; a wrong card is reversible (git mv back + lane move) |
| 3 | INDEX↔lane drift after seeding | Low | doctor index-lane drift lint is the standing gate; archive paths forbidden as first links in lifecycle sections |
| 4 | roadmap.json churn/conflicts from seeding | Low | Cold seed against recorded baseline; single writer; three-way sync refuses divergence |
| 5 | Stable-release fact goes stale between design and execution | Low | INDEX states first-stable as fixed history; current-stable pinned by `gh release list` at execution |

## Success Criteria

- [ ] 29 audited-DONE wish dirs live under `.genie/wishes/archive/`; `bun run check` green (incl. wishes-lint over the recursive tree)
- [ ] Link-resolution sweep passes: every relative markdown link in moved files AND in `.genie/INDEX.md` resolves to an existing file (sweep output recorded as evidence)
- [ ] `roadmap` board exists; `genie task export` shows exactly 19 cards on it, each with a non-null lane matching the Scope enumeration; `genie board --board roadmap` renders them
- [ ] Ritual-QA card in Review lane enumerates all 6 items in its description/timeline
- [ ] `genie doctor` reports zero index-lane `drift` entries, and no lifecycle-section INDEX entry links `wishes/archive/…` as its first link
- [ ] `.genie/INDEX.md` Shipped section lists all 29 archived wishes; duplicated khal bullet removed; update-handoff entry corrected; stable-release facts stated per Risk 5
- [ ] `roadmap.json` committed reflecting the seeded board (diff vs recorded baseline shows the board + 19 cards); `genie task sync` reports in-sync post-commit
- [ ] `public-roadmap-polish` brainstorm DRAFT exists with an INDEX Raw entry (and its Idea card per enumeration)

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `36097b0def248af7f42aa467142b5979cb75382ff5414e3a201d4036cb955a1d`
- **Reviewer:** reviewer-subagent-fable5
- **Reviewed at:** 2026-07-28T22:45:19.000Z
<!-- genie-design-review:end -->
