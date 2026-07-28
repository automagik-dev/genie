# Wish: Genie Official Roadmap — full-jar triage into the canonical board

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `genie-official-roadmap` |
| **Date** | 2026-07-28 |
| **Author** | Felipe + orchestrator (Fable 5) |
| **Appetite** | medium |
| **Branch** | `wish/genie-official-roadmap` |
| **Repos touched** | automagik-dev/genie only |
| **Design** | [DESIGN.md](../../brainstorms/genie-official-roadmap/DESIGN.md) |

## Summary

Turn the audited wish jar (36 wishes; 3-scout evidence audit 2026-07-28) into the official genie roadmap: archive the 29 DONE-verified wishes with the link rewrites the move requires, seed the canonical `roadmap` board with the closed set of 19 lifecycle cards, and rewrite INDEX.md to match reality. Publishes the roadmap through `roadmap.json` — the prerequisite for Felipe's #1 axis (public-facing polish).

## Scope

### IN

- `git mv` 29 DONE-verified wishes to `.genie/wishes/archive/<slug>/` with the full link-rewrite inventory from DESIGN Scope (17 intra-wish design links `../../`→`../../../`; genie-ui→genie-ui-dash split-endpoint link; pr-2545 repo-escaping `.claude` links).
- Cold-seed the `roadmap` board (6 lifecycle lanes) with exactly 19 cards, each create+move to its enumerated lane (Work 4 / Review 3 / Wish 1 / Brainstorm 5 / Idea 6 per DESIGN D7).
- Rewrite `.genie/INDEX.md`: new Shipped section (29 lines, archive links), lifecycle sections reconciled to the card set — including the reviewer-mandated relocations: `genie-official-roadmap` Raw→Simmering, `v4-home-residue-doctor` + `release-ops-hardening` Ready→Poured; remove duplicated khal-native-theme bullet; correct codex-plugin-update-handoff entry; stable-release facts (first stable v5.260727.5 fixed history; current stable pinned fresh at execution).
- Draft `public-roadmap-polish` brainstorm (DRAFT.md + INDEX Raw entry + Idea card).
- One-off link-resolution sweep over moved files and INDEX.md, output recorded as evidence.

### OUT

- No execution of any triaged wish (dogfood criteria, doctor checks, release hardening remain their own wishes).
- No fork (khal-os/genie-desktop) changes; fork wishes get cards only.
- No sync/board/lint machinery changes; the INDEX-link lint gap gets a one-off sweep, durable lint deferred.
- No brainstorm-dir moves or deletions.
- Done lane starts empty by design (D6); this wish's own card moves to Done only at ship, outside the seed-time criteria (reviewer LOW-B).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Inherit DESIGN D1–D7 unchanged (axes, archive dir, canonical board, work order, ritual bundle, polish brainstorm, closed 19-card set) | Felipe-ratified 2026-07-28; design review SHIP after 1 fix loop |
| 2 | Three execution groups: archive+links, board seed, INDEX+brainstorm — INDEX last | INDEX links target archive paths (needs G1) and drift lint compares sections to lanes (needs G2) |
| 3 | Link sweep is a throwaway script run in G1 and re-run in G3, evidence pasted into this wish dir | No existing lint covers INDEX.md/non-brainstorm links (reviewer HIGH-2) |

## Simplicity Case

- **Simplest complete design:** git mv + ~25 targeted link edits, 19 create + 19 move CLI calls, one INDEX rewrite, one DRAFT.md.
- **Added machinery:** none persistent — one throwaway link-resolution sweep.
- **Deferred until measured:** durable markdown-link lint; brainstorm-dir archiving; auto lane-sync.
- **Complexity removed:** no schema changes, no dependency rows, no INDEX generator.

## Dependencies

**depends-on:** none
**blocks:** none

(public-roadmap-polish is downstream but exists only as a planned brainstorm; declare the edge there when its wish is poured.)

## Success Criteria

- [ ] 29 audited-DONE wish dirs under `.genie/wishes/archive/`; `bun run check` green (wishes-lint scans the recursive tree, 0 broken links)
- [ ] Link sweep passes: every relative markdown link in moved files AND `.genie/INDEX.md` resolves; sweep output stored at `.genie/wishes/genie-official-roadmap/qa/link-sweep.txt`
- [ ] `genie task export` shows the `roadmap` board with exactly 19 cards, each non-null lane matching DESIGN's enumeration; `genie board --board roadmap` renders them
- [ ] Ritual-QA card in Review lane enumerates all 6 items (timeline comment)
- [ ] `genie doctor` reports zero index-lane `drift` entries; no lifecycle-section INDEX entry has `wishes/archive/…` as first link
- [ ] INDEX.md: Shipped section lists all 29; duplicate khal bullet gone; update-handoff entry corrected; stable-release facts per DESIGN Risk 5
- [ ] `roadmap.json` committed; diff vs execution-start baseline (`boards: []`, 33 boardless rows, 0 cards) shows board + 19 cards; the 29 HISTORICAL boardless rows (pre-2026-07-28, excl. this wish's pointer + 3 group tasks, which legitimately transition during execution) unchanged in count/ids; `genie task sync` in-sync post-commit
- [ ] `public-roadmap-polish` DRAFT exists with INDEX Raw entry and Idea card

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 — multi-file mechanical move with exact link inventory (+1 no deterministic test for INDEX links, +1 prior rework risk from lint, +1 multi-dir) | engineer-standard / medium | Archive 29 wishes + link rewrites + sweep |
| 2 | engineer | 2 — stateful board writes via CLI (+2 stateful) | engineer-standard / medium | Seed roadmap board: 19 cards create+move, ritual card comment |

**Commit discipline:** G1 and G2 do NOT commit — the pre-commit hook syncs `roadmap.json` on every commit, so a G1 commit during G2's mid-seed would capture a partially-seeded board. The single commit is G3 deliverable 4.

### Wave 2 (after G1 AND G2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 3 — subjective prose reconciliation against two truth sources (+2 subjective acceptance, +1 no deterministic test) | engineer-standard / high | INDEX.md rewrite + public-roadmap-polish draft + final sweeps |

## Execution Groups

### Group 1: Archive move + link rewrites

**Goal:** Relocate the 29 DONE-verified wishes into `.genie/wishes/archive/` without a single dangling link.

**Deliverables:**
1. `git mv .genie/wishes/<slug> .genie/wishes/archive/<slug>` for all 29 slugs listed in DESIGN (agent-sync, agent-sync-hardening, boards-first-class, codex-plugin-update-handoff, council-workflow, dispatch-inproc-default, genie-mcp, genie-ui, genie-ui-bridge, hermes-homogeneous-integration, hermes-khaw-native-surface, hook-injection-hardening, omni-approval-ux, omni-branch-drift-sync, omni-runner-port, plugin-resource-shipping, pr-2545-ultra-release-gate, rolling-pr-auth-hardening, routing-delivery-fix, routing-matrix, skills-fable5-revamp, stable-release-security-gate, taxonomy-rehoming, v5-completion, v5-demolition, v5-foundation, v5-housekeeping, warp-integration, worktree-isolation-hardening)
2. Link rewrites per DESIGN inventory: 17 `../../brainstorms/`→`../../../brainstorms/` (15 files; routing-matrix:12 and plugin-resource-shipping:12 carry two each); `archive/genie-ui/WISH.md` link to genie-ui-dash → `../../genie-ui-dash/WISH.md`; pr-2545 REVIEW-DISPOSITION.md + FINALIZATION-VERIFICATION.md `../../../.claude/`→`../../../../.claude/`; both-endpoints-moved links untouched
3. Link-resolution sweep script output (moved + surviving wishes; INDEX.md expected to fail until G3 — record both states) at `qa/link-sweep.txt` in this wish dir

**Acceptance Criteria:**
- [ ] All 29 dirs under archive/, none remaining at top level; the 7 surviving wish dirs untouched
- [ ] `bun run wishes:lint` → 0 broken links
- [ ] Sweep: 0 unresolved links in moved and surviving wish files

**Validation:**
```bash
bun run wishes:lint && ls .genie/wishes/archive | wc -l | grep -qx 29 && ls .genie/wishes | grep -vx archive | wc -l | grep -qx 8 && mkdir -p .genie/wishes/genie-official-roadmap/qa && bun -e 'import{readFileSync,existsSync,readdirSync,statSync}from"node:fs";import{dirname,resolve}from"node:path";const files=[];const walk=d=>{for(const e of readdirSync(d)){const p=`${d}/${e}`;statSync(p).isDirectory()?walk(p):e.endsWith(".md")&&files.push(p)}};walk(".genie/wishes");let bad=0;for(const f of files){for(const m of readFileSync(f,"utf8").matchAll(/\]\(([^)#\s]+)\)/g)){const t=m[1].split("#")[0];if(!t||/^[a-z]+:/.test(t))continue;if(!existsSync(resolve(dirname(f),t))){console.log(`${f}: ${t}`);bad++}}}console.log(`unresolved: ${bad}`);process.exit(bad?1:0)' > .genie/wishes/genie-official-roadmap/qa/link-sweep.txt; rc=$?; cat .genie/wishes/genie-official-roadmap/qa/link-sweep.txt; exit $rc
```
(8 = 7 surviving wishes + this wish's own dir. The inline resolver is the concrete sweep for the classes wishes-lint does not check; G1 records wish-tree state — INDEX.md is swept in G3.)

**depends-on:** none

---

### Group 2: Board seed

**Goal:** Create the canonical `roadmap` board with exactly the 19 enumerated lifecycle cards, every card in its correct lane.

**Deliverables:**
1. `genie board create roadmap` (default 6 lifecycle lanes)
2. 19 × `genie task create --board roadmap --title …` (with `--wish <slug>` where a slug exists) followed by `genie task move <id> --to <lane>` per DESIGN enumeration — Work: codex-plugin-dogfood-remediation, v4-home-residue-doctor, release-ops-hardening, proportional-validation-policy · Review: genie-ui-dash, live-dev-loop, ritual-QA checklist · Wish: khal-rebrand · Brainstorm: genie-boards-ui, intent-to-wish-compiler, brainstorm-domain-map, cross-agent-delegate, genie-official-roadmap · Idea: control-plane-contract, skill-absorbs, always-on-genie, genie-spend, dream-replatform, public-roadmap-polish
3. `genie task comment` on the ritual-QA card enumerating all 6 rituals (council live run, genie-mcp Warp QA, warp pane checklist, agent-sync convergence, update-handoff homolog dogfood, taxonomy PATH export)
4. Create a FRESH Brainstorm-lane card for genie-official-roadmap, then `genie task block t_ms58w0yqa195fbf8 --reason "superseded by roadmap-board card"` — the boardless pointer cannot be adopted (no code path mutates `board_id` after creation; `task move` throws LaneError on boardless tasks)

**Acceptance Criteria:**
- [ ] `genie task export`: board `roadmap` exists; exactly 19 tasks with `board_id` = roadmap board; every one `lane` non-null and matching the enumeration
- [ ] Ritual card timeline contains the 6-item comment
- [ ] The 29 HISTORICAL boardless group-task rows untouched (same count/ids in export); exempt: this wish's own pointer + 3 group tasks (they transition via checkout/done/block during execution)

**Validation:**
```bash
genie board --board roadmap && genie task export | bun -e 'const s=JSON.parse(await Bun.stdin.text());const b=s.boards.find(x=>x.name==="roadmap");if(!b)process.exit(1);const c=s.tasks.filter(t=>t.board_id===b.id);if(c.length!==19||c.some(t=>!t.lane))process.exit(1)'
```

**depends-on:** none

---

### Group 3: INDEX rewrite + polish brainstorm + final gates

**Goal:** Reconcile INDEX.md with the archive and the seeded board, and draft the public-roadmap-polish brainstorm.

**Deliverables:**
1. INDEX.md rewrite: Shipped section (29 entries, `wishes/archive/<slug>/WISH.md` links); lifecycle sections matching cards incl. reviewer LOW-A relocations (genie-official-roadmap Raw→Simmering; v4-home-residue-doctor + release-ops-hardening Ready→Poured); duplicate khal bullet removed; codex-plugin-update-handoff entry corrected (PR #2617 merged 2026-07-22, A–E shipped); stable-release facts (first v5.260727.5; current pinned via `gh release list` at execution); Work-lane priority order stated in prose (D4); no lifecycle entry with archive path as first link
2. `.genie/brainstorms/public-roadmap-polish/DRAFT.md` (publish roadmap outward + docs/onboarding sweep; seeded from this wish's D6) + INDEX Raw entry
3. Re-run link sweep over INDEX.md + full tree → 0 unresolved; final `qa/link-sweep.txt`
4. Commit (pre-commit sync publishes board to roadmap.json); verify post-commit `genie task sync` in-sync

**Acceptance Criteria:**
- [ ] `genie doctor --json`: zero `drift` entries under `checks[].indexLane.entries`
- [ ] Sweep: 0 unresolved links tree-wide incl. INDEX.md
- [ ] Shipped section count = 29; grep finds no duplicate khal RELOCATED bullet
- [ ] roadmap.json diff vs baseline shows board + 19 cards; `genie task sync` → in-sync

**Validation:**
```bash
bun run check && genie doctor --json | bun -e 'const d=JSON.parse(await Bun.stdin.text());const il=(d.checks||[]).find(c=>c.indexLane);if(!il)process.exit(1);const e=il.indexLane.entries;const ok=e.filter(x=>x.state==="ok").length;const drift=e.filter(x=>x.state==="drift").length;if(ok<18||drift>0)process.exit(1)' && genie task sync
```
(Positive assertion required: `unlinked` never counts as drift, so a drift-only check passes vacuously on an unreconciled INDEX. 18 of the 19 cards carry wish slugs; each must resolve a lifecycle entry to `ok`.)

**depends-on:** group-1, group-2

---

## QA Criteria

- [ ] Fresh-clone ritual: clone, `genie task sync`, `genie board --board roadmap` shows the 19-card roadmap
- [ ] `genie board` (all tasks) still shows the 29 historical group tasks + tombstones untouched
- [ ] INDEX.md reads as the single roadmap of record (Felipe eyeball)

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Link inventory misses a class | Low | Reviewer independently swept 111 links post-move in simulation: only the named classes break; sweep re-runs as gate |
| INDEX prose drift vs lanes after seeding | Low | doctor drift lint standing; sections written from the card enumeration |
| roadmap.json divergence during execution | Low | Single writer; three-way sync refuses divergence; commit at group boundaries |
| Stable-release fact stale by execution | Low | Pinned fresh via `gh release list` in G3 |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — SHIP (2026-07-28T22:58:35Z, reviewer-subagent-fable5, 2 fix loops)

- **Loop 0 → FIX-FIRST (22:52:41Z):** 3 MEDIUM + 3 LOW. M1 unimplementable adopt-branch for boardless pointer (no `board_id` mutation path; LaneError proven); M2 stale baseline (33 boardless rows at execution start, not 29 — invariant rescoped to the 29 historical rows, this wish's 4 rows exempt); M3 drift-only gate passes vacuously on unreconciled INDEX (`unlinked` never counts as drift) → positive `ok>=18 && drift===0`, threshold independently re-derived as exactly 18; L4 sweep had no command; L5 commit discipline (G1/G2 never commit — pre-commit sync would capture a partially-seeded board); L6 null-guard.
- **Loop 1 → FIX-FIRST (22:56:26Z):** 5/6 repairs verified by execution; new MEDIUM in the L4 repair itself — `| tee` swallowed the resolver's exit code (proven), and missing `qa/` masked it fail-closed for the wrong reason.
- **Loop 2 → SHIP (22:58:35Z):** gate executed on both branches — broken simulated post-move tree: `unresolved: 20` (exactly the specified inventory: 17+1+2), chain exit 1; rewritten tree: `unresolved: 0`, chain exit 0. `mkdir -p` in-chain; evidence file self-describing. All prior verifications re-confirmed (8/8 DESIGN criteria carried, LOW-A/LOW-B honored, `task block` executable on the ready pointer, wishes-lint OK). Informational, no action: the `#`-fragment `.split` is inert under the current regex; corpus has zero fragment links.

**Execution amendment (orchestrator, post-approval):** plan approval landed before execution, so this wish's OWN card seeds in the **Wish** lane (not Brainstorm) and its INDEX entry sits in **Poured** (skill rule: plan SHIP → Poured; Poured↔Wish joins `ok`). The `ok>=18` threshold is unaffected. All other enumeration placements unchanged.

---

## Files to Create/Modify

```
.genie/wishes/<29 slugs>/**            -> .genie/wishes/archive/<slug>/**   (git mv + link edits in 17 files)
.genie/INDEX.md                        (rewrite)
.genie/brainstorms/public-roadmap-polish/DRAFT.md   (new)
.genie/wishes/genie-official-roadmap/qa/link-sweep.txt (new, evidence)
.genie/roadmap.json                    (regenerated by pre-commit sync)
.genie/genie.db                        (board + 19 cards; not tracked)
```
