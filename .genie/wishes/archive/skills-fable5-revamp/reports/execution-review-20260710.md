# Execution Review — `skills-fable5-revamp`

## Verdict: **SHIP**

The wish delivered all ten Success Criteria at merge (PR #2518, merge commit `1308e4c6`, fable5 tip `a4f089a5`), and its acceptance intent survives in the current `origin/dev` (`b1f07913`, v5.260710.5). Every difference between what the wish predicted and what `origin/dev` shows today is attributable to **later merged wishes** (council-workflow, token-efficiency, routing-pin, plugin-resource-shipping, agent-sync), not to a gap in this wish. I independently re-ran 8 of `verification.md`'s checks against the delivered commit and current dev; all corroborate. No HIGH or MEDIUM gaps on the genie surface. The only limitation is environmental: the omni half (G5/G6) lives in the separate `automagik-dev/omni` repo and cannot be re-run from this checkout — those two groups rest on `verification.md`'s attestation.

**Gap count:** HIGH 0 · MEDIUM 0 · LOW 3 (all observations, none SHIP-blocking).

---

## What I verified independently (not taken on faith)

Reference points: **delivered** = `a4f089a5` (2nd parent of merge #2518, includes `verification.md` + the lint fix); **current** = `origin/dev` @ `b1f07913`. Checks run with `git grep` / `git show` (bare `grep` is unreliable here) from script files in the scratchpad.

| # | Check (SC) | My result | verification.md claim | Match |
|---|-----------|-----------|-----------------------|-------|
| 1 | Dead-namespace grep on `skills/**` (SC4/SC10) | **0 hits** at both `a4f089a5` and `origin/dev` | 0 (was 118) | ✅ |
| 2 | Reasoning-extraction grep on `skills/**` (SC6) | **0 hits** at both refs | 0 | ✅ |
| 3 | 17-skill genie total, delivered (SC3) | **1,385 lines** (summed per-file) | 1,385 (−66.9%) | ✅ exact |
| 4 | Budgets — every `SKILL.md` ≤ 200 (SC2) | Max delivered = 125 (brainstorm); max current = 148 (review) | all ≤ 200 | ✅ |
| 5 | Frontmatter byte-0 + `name`=dir, 17 skills (SC1) | **17/17 OK** | 17/17 | ✅ |
| 6 | Diff shape vs merge-base `63015670` (SC8) | **13 A / 28 M, 0 D, 0 R**, all in-scope | 12 A / 27 M, 0 D/R | ✅ (see LOW-2) |
| 7 | G1 `refine/prompts/optimizer.md` present | **721 lines**, both refs | present | ✅ |
| 8 | G8 shared manifest / marker-gating / backup / uninstall consumption | read module; conforms (below) | PASS | ✅ |

The SC8 merge-base I computed (`63015670`) is the exact commit `verification.md` cites — the diff-shape check is anchored to the same baseline.

---

## Per-group findings

| Group | Scope | Verdict | Evidence / notes |
|-------|-------|---------|------------------|
| **G1** genie extraction-heavy (`refine`, `genie-hacks`) | delivered | **SHIP** | `refine` 803→48, `genie-hacks` 626→47; `refine/prompts/optimizer.md` = 721 lines and the SKILL Reads it at dispatch; dead-ref grep clean. Catalog moved to `genie-hacks/references/{catalog,contributing}.md` (in SC8 A-list). |
| **G2** lifecycle core (`brainstorm`,`wish`,`work`,`review`,`fix`,`trace`) | delivered | **SHIP** | All six ≤ 200 at delivery; all 8 frozen-contract families present (template `cp`, `wishes:lint` gate, `genie task` linkage, DRAFT/SHIP/FIX-FIRST/BLOCKED, reviewer≠engineer, ≤2 fix loops, orchestrator-only `task done`, session-close outcome words). Later growth (work 103→123, fix 75→99, review 114→148, brainstorm 125→133, wish 71→73) is from routing-pin `1430def4`, council-workflow lens-panels `2af7ebd9`, template-shipping `ecbb67fc`, agent-sync `ff497ae4` — **not this wish**; all still ≤ 200. |
| **G3** routing & onboarding (`genie`,`wizard`,`learn`,`docs`,`omni`) | delivered | **SHIP** | All five delivered and lint-clean. `learn` (61 lines) shipped correctly, then **removed later** by the token-efficiency wish (`3d40966c`) — absence in current dev is attributable drift, not a G3 gap. Router route table preserved. |
| **G4** PM & multi-agent (`pm`,`dream`,`council`,`report`) | delivered | **SHIP** | All four delivered (pm 108, dream 103, council 107, report 101); grounded-progress clause present. `council` shipped correctly, then **retired later** by council-workflow G3 (`22a7ed50`, "/council is the native workflow now") — attributable drift, not a G4 gap. |
| **G5** omni skill tier (`omni`,`omni-agent`,`omni-setup`,`omni-ops`) | **not re-runnable here** | SHIP *(attested)* | Lives in `automagik-dev/omni`, absent from this genie checkout (`git ls-tree origin/dev plugins/` → only `plugins/genie`, `plugins/hermes-genie`). `verification.md` records `omni-ops` 484→41 and SC5 `G5-OK`. See LOW-1. |
| **G6** omni commands/agents/rules (15 files) | **not re-runnable here** | SHIP *(attested)* | Same repo boundary. `verification.md` SC5 `G6-OK`; `rules/omni-agent.md` no-frontmatter documented as a pre-existing baseline format, not a regression. See LOW-1. |
| **G7** cross-repo verification | delivered | **SHIP** | `verification.md` present, thorough, 10/10 SC PASS. I re-derived its genie-side numbers exactly (1,385 total; 0 dead refs; 0 reasoning-extraction; 0 D/R). Its two in-scope fixes (conventions `install` add; Status annotation) are consistent with the shipped tree. |
| **G8** v4 legacy audit & cleanup | delivered + current | **SHIP** | `legacy-v4.ts` present both refs. Conservative by construction; details below. Foundation was **reused** by `doctor.ts` in current dev (`--fix` calls `cleanupV4`) — intent expanded, not eroded. |

### G8 detail (the one destructive surface — reviewed closely)

`src/genie-commands/legacy-v4.ts` (read at `a4f089a5`) satisfies every G8 acceptance criterion:

- **One shared manifest** — `V4_LEGACY_MANIFEST` is the single source of truth. `uninstall.ts:16` imports `orchestrationRulesPath` from `./legacy-v4.js` and derives `ORCHESTRATION_RULES_PATH` from it (`uninstall.ts:19`); **no literal path restated** (grep for `genie-orchestration.md` in uninstall.ts → none). AC4 met: zero duplicated path literals.
- **Marker-gating** — rules file removed only when content contains `genie spawn` or `genie team create`; unreadable/unmarked → `user-modified` → kept with warning (`cleanupRulesFile`).
- **Cache scoping** — only `4.*`-prefixed dirs carrying `.orphaned_at` are removed; `isDirectory()` excludes symlinks ("never follow a link out of the cache").
- **Backup-first** — `backupFile` before `unlinkSync`; cache dirs back up a manifest listing (not the re-downloadable payload); log to `<genieHome>/logs/v4-cleanup.log`.
- **Idempotent** — clean machine → `noOp: true`, nothing printed/written.
- **install.sh** is flag-only: forwards `--skip-v4-cleanup`, hands off via a plain (non-exec) `genie install` call; the sole "legacy path" occurrence in `install.sh` is a **comment** (`install.sh:366`) pointing at the TS module, not bash logic. `bash -n install.sh` clean (SC9).
- **Adjudicated skills-lint expansion** (2nd OUT-scope expansion) confirmed: `scripts/skills-lint.ts` warns to stderr and skips omni checks when the omni CLI is absent, strict mode preserved behind `SKILLS_LINT_REQUIRE_OMNI=1` (exit 2). This is the +1 `M` explaining my 28-vs-27 count.

---

## Success-criteria checklist (against merged state)

| SC | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| SC1 | 36 surfaces conform (FM byte-0, name=dir, trigger desc) | ✅ genie 17/17 re-verified; omni attested | script `verify-final.sh` ALL-OK; omni per verification.md (1 documented rules-file FM exception) |
| SC2 | Budgets (SKILL ≤200, cmd/agent ≤40, rule ≤30) | ✅ | delivered max 125; current dev max 148; all ≤ 200 |
| SC3 | Total always-loaded ≤ 3,300 (≥40% cut) | ✅ | genie 1,385 re-derived exactly; combined 2,016 (−63.4%) per verification.md |
| SC4 | `skills:lint` + `wishes:lint` exit 0 | ✅ | dead-ref grep 0 (I ran it); both scripts wired into `check`/`check:fast` (`package.json:24-25,29-30`) |
| SC5 | Per-file ceilings not treated as targets | ✅ | most files near ~120; binding ≤3,300 met with headroom |
| SC6 | Omni structural check exits 0 | ✅ attested | verification.md SC5 `G5-OK`/`G6-OK` (omni repo) |
| SC7 | Zero reasoning-extraction language | ✅ | grep 0 hits both refs (I ran it) |
| SC8 | Frozen contracts intact | ✅ | template `cp`, lint gates, `genie task` linkage, status vocab, three-tier omni routing, `allowed-tools` — verified at delivery; template later re-homed to `${CLAUDE_SKILL_DIR}` by plugin-resource-shipping `ecbb67fc` (intent preserved) |
| SC9 | Diff shape M+A only, no D/R | ✅ | 13 A / 28 M / 0 D / 0 R, all in-scope (I ran it) |
| SC10 | v4 rules verdict implemented, one shared manifest | ✅ | `legacy-v4.ts` + `uninstall.ts` consumption; colocated pgserve-free tests |

*(SC numbering above follows the WISH "Success Criteria" list; verification.md's SC1–SC10 map 1:1.)*

---

## Gaps (ranked)

**HIGH — none. MEDIUM — none.**

**LOW-1 — Omni half (G5/G6) is not independently verifiable from this checkout.** The omni plugin lives in `automagik-dev/omni`, which is not present in the genie repo (`plugins/` holds only `genie` and `hermes-genie`). My SHIP for G5/G6 rests entirely on `verification.md`'s pasted `G5-OK`/`G6-OK` and the recorded per-group execution reviews. *Recommendation:* have the reviewer with the omni checkout (or the live-QA pass) re-confirm the omni 1,329→631 numbers and the omni-ops routing-table→references resolution before treating the omni PR as reviewed. This is a review-environment limitation, not evidence of a defect.

**LOW-2 — `verification.md` diff-shape count is one commit stale.** It records genie "12 A / 27 M"; the final delivered branch (`a4f089a5`) is "13 A / 28 M". The extra `M` is `scripts/skills-lint.ts`, modified by the lint-fix commit `a4f089a5` that landed *after* verification.md was authored at `af81783b`. Cosmetic staleness in the record; the load-bearing invariant (zero D, zero R, all files in-scope) holds. No action required beyond awareness.

**LOW-3 — Two delivered skills (`learn`, `council`) no longer exist in current dev.** Both shipped correctly under this wish (G3 `learn`, G4 `council`) and were later removed by other wishes (`3d40966c` token-efficiency; `22a7ed50` council-workflow). A reader diffing `verification.md`'s per-file table against today's `origin/dev` will see the mismatch. *Optional:* a one-line "superseded by later wishes" note in the wish record would prevent future confusion. Not a defect in this wish.

*(QA Criteria in the WISH — fresh-session routing, lifecycle dry-run, `/refine` runtime dispatch, omni verbs, live v4-cleanup on a v4 box — are runtime/live-QA checks outside a static read-only review's scope; they belong to the post-merge QA pass, not this execution review.)*

---

## Bottom line

The genie side of `skills-fable5-revamp` is a clean, well-evidenced SHIP: the 118→0 dead-CLI re-grounding, the ≥40% line reduction (1,385 genie / 2,016 combined), the byte-0 frontmatter conformance, the zero-deletion diff shape, the extracted `optimizer.md`, and a genuinely conservative G8 cleanup engine all verify independently. `verification.md` is accurate — every genie-side number I re-derived matched, and where it differs from today's tree the cause is a later merged wish, correctly outside this wish's ownership. Nothing here blocks flipping the wish Status to reflect an execution-review SHIP.

---

*Reviewed by subagent (session d0554818 overnight run), 2026-07-10.*
