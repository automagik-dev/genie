# Wish: Worktree isolation hardening — freeze git state, clean residue, pin reviews

| Field | Value |
|-------|-------|
| **Status** | EXECUTED — all 3 groups SHIP (policy loop 0 +1 MEDIUM folded; doctor-residue after 1 fix loop — tag-shadow ancestry HIGH reproduced+fixed; review-snapshot after 1 fix loop — false doctor-janitor claim corrected), final gate SHIP 2026-07-27 (617 tests, grep gate 4, mirrors byte-identical). SHIPPED on merge to dev; post-merge: #2594 closure + manual QA. Plan review SHIP 2026-07-27 (2 fix loops; H2 settled by live probe) |
| **Slug** | `worktree-isolation-hardening` |
| **Date** | 2026-07-27 |
| **Author** | Felipe + Genie (council deliberation 2026-07-27, adapting PR #2594 by lirazsiri) |
| **Appetite** | small-medium |
| **Branch** | `wish/worktree-isolation-hardening` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Adapts lirazsiri's PR #2594 per the 2026-07-27 four-lens council: the recorded context-mixing incident was a **repo-level git-state mutation** (a concurrent session switched the shared checkout), not a file-scope collision — so instead of mandating worktrees everywhere (which would serialize native `/work` dispatch today — native worktree isolation exists in the current harness but is not yet `/work`-ready; see Decision 1), we keep the two-mode contract and add the invariant that actually matches the incident. Three deliverables: a git-state freeze for shared-workspace subagents, a `genie doctor` residue check/fix for accumulated launch worktrees (no new commands), and read-only snapshot worktrees pinned to the reviewed commit on the review path. Credit to @lirazsiri for the isolation diagnosis, the reviewer-snapshot design, and the GC design; #2594 closes in favor of this wish once landed.

## Scope

### IN

- Policy amendment, single-sourced: AGENTS.md (one sentence) + `skills/work/SKILL.md` dispatch paragraph (+ plugin mirrors) — keep "parallel writers must have disjoint file ownership OR dedicated worktrees", add: shared-workspace subagents never mutate repo-level git state (no `checkout`/`switch`/`reset`/`stash`/`rebase`; only the orchestrator moves HEAD); work needing repo-level mutation gets a worktree via `genie launch` or gets sequenced. All other docs point to the single source, never paraphrase.
- Recorded flip conditions, written next to the policy: (i) the isolation guard's ergonomics tolerate real engineering command patterns (compound commands, cwd-relative git) — the ONE remaining gap; probe 2026-07-27 confirmed the raw capability exists, placement is already gitignored, and shared task-state access is by-design (`genie-db.ts` common-dir resolution) → flip to isolation-by-default for parallel writers, confirming task claim/done in the pilot; (ii) recorded corruption between disjoint-scope writers with no git-state mutation → freeze is the wrong abstraction, go full isolation + native-placement engineering; (iii) first orphaned-lane or wrong-order merge incident → land the full integration-worktree protocol from #2594; (iv) 3+ file-scope collision incidents → the disjoint-scope mode dies.
- `genie doctor` gains a **worktrees residue check**: enumerate launch-created worktrees (`<worktreesBase>/<repo>-<slug>-<group>/`, branch `wish/<slug>-<group>`), report those whose branch is fully merged into the repo's integration branch; `genie doctor --fix` removes them **fail-closed**: branch tip is an ancestor of the integration branch AND worktree tree is clean, else refuse with the reason. No new top-level command, no new noun.
- Reviewer snapshot worktrees: the review dispatch path provisions a **read-only detached worktree pinned to the exact commit under review** (no install — read-only), and tears it down after the verdict. Documented in `skills/review/SKILL.md` (+ mirror).
- Dispatch-brief scope stanza: shared-workspace parallel dispatch briefs carry the group's explicit file scope and the git-freeze rule verbatim (work skill template text).
- Credit + closure: the landing commit(s) credit lirazsiri (`Co-authored-by` where his designs are implemented); after merge, comment on and close #2594 in favor, with the council's reasoning and the recorded flip conditions.

### OUT

- The unconditional worktrees-for-everything mandate from #2594 — declined (serializes native dispatch or teaches rule-ignoring).
- The PM-owned integration worktree + merge-order protocol — deferred until a flip-condition trigger (first orphaned-lane or wrong-order-merge incident); merge ownership stays with the orchestrator in the primary checkout.
- #2594's mainline-ownership section — predates the dev-first flow; separate policy question if ever revived.
- Mechanical enforcement of the git-freeze (dispatch-level guard denying git-state commands in shared-workspace subagent shells) — recorded as a follow-up investigate item, not built here.
- Any change to `genie launch` creation mechanics, `.mcp.json`/`.warp/`/`.codex` worktree-config handling (separate product decision), or the Warp cockpit flow.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Adapt, don't adopt: add a git-state freeze instead of mandating worktrees everywhere | The founding incident was a checkout switch (repo-state mutation), which neither current policy nor #2594's file-scope framing names; the freeze kills the observed failure class in the shared-workspace mode we rely on today. **Probe evidence (2026-07-27, H2 experiment):** the harness CAN place subagents in worktrees (`isolation: "worktree"` — real linked worktree at `<repo>/.claude/worktrees/agent-<id>`, persists when changed, named branches + commits land in the shared object store), so the council's original "cannot" was wrong — but one gap keeps it short of `/work`-ready: the isolation guard's high false-positive rate (rejects compound and cwd-relative commands, forces `git -C` shapes), which materially changes engineer behavior. Two suspected gaps dissolved under scrutiny: placement is already clean (`.gitignore` ignores `.claude/worktrees/` since `225a56d60` — the repo hit and closed that hygiene problem before), and shared task-state access is resolved by design, not by accident — `src/lib/v5/genie-db.ts` resolves the DB via `git rev-parse --git-common-dir` precisely so every linked worktree shares one `genie.db` (production precedent: launch panes). Adapt remains correct on evidence, not on incapability; the flip is one gap away. |
| 2 | Residue cleanup lives in `genie doctor`, not a new command | Felipe: "I hate creating new commands without needing to"; doctor already owns the check/fix residue pattern (v4-home-residue-doctor directive). Fail-closed semantics live in code where they cannot be mis-pasted — the #2594 GC bug existed because the choreography was prose shell replicated across ~57 files. |
| 3 | Reviewer snapshots pinned to a commit, adopt-now | Unanimous council: near-zero standing cost, read-only so no per-lane install, fixes a real present hazard (reviews rendered against a moving tree). |
| 4 | Defer integration-worktree machinery behind a recorded trigger | Unpriced costs (per-worktree environment installs, PM resolving conflicts holding neither engineer's context) fail AGENTS.md's present-need evidence bar; one recorded incident lands it — cheap flip threshold, dissent recorded (dx-docs wanted it now). |
| 5 | Single-source the policy; all other docs point | #2594's ~57-file restatement is change amplification: every future revision becomes a drift event. |

## Simplicity Case

The simplest complete design is the policy sentence alone — one clause added to the existing contract, zero code. Everything beyond it must earn its place with present need:

- **policy** — pure amendment of existing prose; no new machinery.
- **doctor-residue** — present need, not hypothetical: `genie launch` mints worktrees today and nothing removes them (verified: no cleanup path exists in `src/`), so residue accumulates on every launched wish now. The fail-closed proof lives in code because the #2594 prose version demonstrably failed open.
- **review-snapshot** — present hazard: reviews today run against a moving tree; a concurrent write between read and verdict silently invalidates the review. Prose only — the exact commands, no helper; no standing service.
- **Deferred as not-yet-needed** (pointed at the flip conditions in Scope IN): the PM integration worktree, merge-order protocol, and mechanical freeze enforcement — each waits for its recorded trigger rather than shipping on speculation.

## Success Criteria

- [x] AGENTS.md and `skills/work/SKILL.md` (+ mirror) carry the amended contract with the git-freeze clause and the four flip conditions; `plugins/genie/references/dispatch-contract.md` rule 3 is amended to match (it ships the parallel-writer rule to agents and is not covered by skill mirroring)
- [x] The freeze's canonical phrase (`only the orchestrator moves HEAD`) greps to exactly the canonical statement sites: `git grep -l "only the orchestrator moves HEAD"` returns AGENTS.md, `skills/work/SKILL.md`, its plugin mirror, and `plugins/genie/references/dispatch-contract.md` — no other file states it; known adjacent paraphrase sites (`skills/dream/SKILL.md`, `skills/work/references/native-surfaces.md`, `plugins/genie/references/codex-integration-map.md`, `skills/genie-hacks/references/catalog.md`) are updated to point, not restate
- [x] `genie doctor` reports launch-worktree residue with per-worktree disposition (merged-clean → removable; unmerged or dirty → kept, reason shown); `--fix` removes only the provably safe set and refuses the rest loudly
- [x] A dirty or unmerged worktree can NOT be removed by `doctor --fix` — regression test proves the fail-closed refusal (the #2594 fail-open class is unrepresentable)
- [x] Review dispatch provisions a detached read-only worktree at the exact reviewed commit and removes it after the verdict; snapshot immutability under a concurrent primary-checkout write is verified by the manual QA criterion below (prose-only group — no code test exists by design)
- [x] Shared-workspace dispatch briefs (work skill) include the scope stanza + freeze rule; `bun run check:fast` green AND `bun scripts/sync-plugin-skills.ts --check` green (parity is NOT covered by `bun run check` — verified during plan review; every group editing `skills/` runs `--write` then `--check`)
- [x] #2594 closed in favor with credit comment (2026-07-27, post-merge of #2707); landing commits carry `Co-authored-by: Liraz Siri <liraz@liraz.org>`

## Execution Strategy

### Wave 1 (parallel — disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| policy | engineer | 2 (+1 prompt-skill change, +1 multi-surface mirrors) | opus-medium | Contract amendment + flip conditions + dispatch scope stanza, single-sourced across AGENTS.md / work skill / mirrors |
| doctor-residue | engineer | 3 (+2 stateful work: git ancestry/cleanliness proofs + destructive removal, +1 no deterministic test env for real panes — fixture worktrees instead) | opus-high | Doctor worktrees check + fail-closed `--fix` with regression tests |

### Wave 2 (after policy merges — its freeze text must carry the snapshot carve-out first)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| review-snapshot | engineer | 1 (+1 prompt-skill change) | opus-low | Skill prose: snapshot contract + exact commands (+ mirror); depends only on policy (carve-out), not doctor-residue |

## Execution Groups

### Group policy: Contract amendment + flip conditions

**Goal:** The git-state freeze and flip conditions become the single-sourced concurrency contract.

**Deliverables:**
1. AGENTS.md: amend the isolation sentence — keep the two-mode contract, add the freeze (workers never `checkout`/`switch`/`reset`/`stash`/`rebase`; only the orchestrator moves HEAD), link the flip conditions.
2. `skills/work/SKILL.md` (+ `plugins/genie/` mirror): dispatch paragraph updated; shared-workspace brief template gains the scope stanza + freeze rule verbatim.
3. Flip conditions (i)–(iv) recorded adjacent to the policy text.
4. Two follow-up investigate items filed as GitHub issues, linked from the flip-conditions text: (a) mechanical dispatch-level enforcement of the freeze; (b) pilot native `isolation: "worktree"` on one real `/work` group to close the one remaining flip-condition-(i) gap (guard ergonomics), confirming task claim/done from inside during the pilot.

**Acceptance Criteria:**
- [ ] Canonical freeze phrase greps to exactly the four canonical sites (see Success Criteria); known paraphrase sites updated to point
- [ ] `plugins/genie/references/dispatch-contract.md` rule 3 amended (the plugin ships this contract to agents; it is outside skill mirroring)
- [ ] Freeze text includes the snapshot carve-out (worktree add/remove/prune permitted as orchestrator plumbing)
- [ ] Flip conditions enumerated verbatim next to the policy
- [ ] Brief template carries scope stanza + freeze rule
- [ ] Investigate issue filed and linked from the flip-conditions text

**Validation:**
```bash
bun run check:fast && bun scripts/sync-plugin-skills.ts --check && test "$(git grep -l 'only the orchestrator moves HEAD' -- ':!.genie' | wc -l | tr -d ' ')" -eq 4
```

**depends-on:** none

---

### Group doctor-residue: Doctor worktrees check + fail-closed fix

**Goal:** Accumulated launch worktrees become visible in `genie doctor` and removable only when provably safe.

**Deliverables:**
1. New module `src/genie-commands/doctor-worktrees.ts` (+ colocated `doctor-worktrees.test.ts`) owning enumeration, classification, and fail-closed removal — `doctorCommand` is at the complexity ceiling (42/42, `scripts/complexity-budget.ts`), so its delta is exactly one spread into `results` plus one call inside the existing `if (options?.fix)` block (which must move after git-root resolution — today `--fix` runs before root is resolved).
2. Enumeration via `git worktree list --porcelain` from the repo root (authoritative; `launch.ts:477` precedent) — NOT by parsing `<repo>-<slug>-<group>` directory names (hyphenated slugs make names unparseable and two repos sharing a basename collide in the shared `<GENIE_HOME>/worktrees`). Export `resolveWorktreesBase` from `launch.ts` so doctor honors `GENIE_WORKTREES_DIR` identically. Classify: merged+clean (removable), unmerged (kept: commits not in integration branch), dirty (kept: uncommitted changes), foreign (kept: not a launch worktree of this repo).
3. Integration branch resolution rule, stated in code: `dev` if it exists, else the remote default branch; if unresolvable, the check reports and `--fix` refuses all removals (fail-closed). No config surface — none exists in `src/types/genie-config.ts` and inventing one fails AGENTS.md's present-need gate.
4. `doctor --fix`: remove only merged+clean entries — ancestry proof AND cleanliness check chained in code; any git error → refuse that entry with the reason. Update the `--fix` flag description in `src/genie.ts` (currently v4-residue-only wording).
5. Tests: fixture repo + real `git worktree add` fixtures (precedent: `doctor.test.ts:355`) covering all four classes; regression tests that a dirty tree, an unmerged branch, an unresolvable integration branch, and a git-error path each refuse removal.

**Acceptance Criteria:**
- [ ] Doctor lists residue with per-entry disposition and reclaimable size
- [ ] `--fix` removes merged+clean only; branch deleted with worktree; second run reports nothing to do (idempotent)
- [ ] Fail-closed regression tests pass (dirty / unmerged / unresolvable-integration-branch / git-error → refusal with reason in output)
- [ ] `lint:complexity-budget` stays green — `doctorCommand` does not exceed 42

**Validation:**
```bash
bun test src/genie-commands/ && bun run check:fast
```

**depends-on:** none

---

### Group review-snapshot: Pinned read-only reviewer worktrees

**Goal:** Review verdicts anchor to an immutable tree even while writers continue in the primary checkout.

**Deliverables:**
1. Prose-only, deliberately: `skills/review/SKILL.md` (+ mirror) documents the snapshot contract with the EXACT commands — provision `git worktree add --detach <worktreesBase>/<repo>-review-<shortsha>-<unique> <commit>` (unique suffix — collision resistance across concurrent reviews), teardown `git worktree remove <path>`. No helper module: a helper here would have no caller but its own test (the #2594 decoration pattern this wish condemns), and the commands are natively fail-safe — `worktree add --detach` creates without touching any branch, and `worktree remove` refuses a dirty tree by default. A crashed review's leftover snapshot is foreign to the doctor residue check (detached, never removed by `--fix`); remove it explicitly with `git worktree remove <path>`.
2. Reviewer contract in the same prose: work read-only in the snapshot path; verdicts cite the pinned commit.
3. Precondition (owned by the policy group, not re-delivered here): the freeze text's snapshot carve-out (`git worktree add/remove/prune` is orchestrator-side plumbing, permitted; `checkout/switch/reset/stash/rebase` in the shared checkout remain forbidden).

**Acceptance Criteria:**
- [ ] Skill prose carries the exact provision/teardown commands and the read-only + pinned-commit reviewer contract
- [ ] Skill docs updated; `bun scripts/sync-plugin-skills.ts --check` green

**Validation:**
```bash
bun run check:fast && bun scripts/sync-plugin-skills.ts --check
```
_(Full `bun run check` — install, lint, complete `bun test` — runs on CI and is the required merge gate; `check:fast` is the local iteration gate.)_

**depends-on:** policy

---

### Post-merge checklist (orchestrator-owned, after all groups land on dev)

- [x] Done 2026-07-27: #2594 closed in favor with the council reasoning + flip conditions; all three landing commits carry the Co-authored-by trailer (success criterion 6)

---

## Dependencies

**depends-on:** none
**blocks:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: on a repo with two finished launch worktrees (one merged+clean, one dirty), `genie doctor` shows both with correct dispositions and `--fix` removes exactly the merged one
- [ ] Integration: a `/work` wave with two disjoint-scope native subagents runs in parallel in the shared checkout; briefs visibly carry the scope stanza + freeze rule; orchestrator commits land while HEAD never moves mid-wave
- [ ] Snapshot immutability (manual, from the dropped helper test): provision a snapshot per the skill prose, commit in the primary checkout, verify the snapshot's `git rev-parse HEAD` and a file hash are unchanged; teardown; `genie doctor` reports zero snapshot leftovers
- [ ] Regression: `genie launch <slug> --dry-run` output unchanged; existing doctor checks unaffected; full `bun run check` green **on CI** (locally on macOS the pre-existing `ui-bridge` test needs Linux `ss` and fails — not a gate for this wish)

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Freeze is prose-enforced; an agent can still violate it (the founding incident violated an implicit norm) | Medium | Follow-up investigate issue: dispatch-level mechanical guard; violation caught at review via diff/state audit; flip condition (ii) fires if mixing recurs despite the freeze |
| Doctor `--fix` deletes something an operator wanted despite proofs | Medium | Ancestry checked against the integration branch tip at run time; refusal on ANY git error; tests pin every refusal path; `--fix` prints each removal with the proof it passed |
| Reviewer snapshots accumulate if a review crashes before teardown | Low | Teardown is the orchestrator's explicit job — execution review confirmed doctor classifies detached snapshots as `foreign` (never touched by `--fix`); the skill prose says so and instructs explicit `git worktree remove` for crash leftovers |
| Scope stanza adds brief ceremony with zero recorded file-collision incidents (simplifier's dissent) | Low | Stanza is template text, not a new artifact class; flip condition (iv) records when it would matter; revisit if it proves noise |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
AGENTS.md                                     # contract amendment + flip conditions
skills/work/SKILL.md                          # dispatch paragraph + brief scope stanza
plugins/genie/skills/work/SKILL.md            # mirror (sync-plugin-skills --write)
plugins/genie/references/dispatch-contract.md # rule 3 amendment (ships to agents; outside skill mirroring)
skills/review/SKILL.md                        # snapshot contract
plugins/genie/skills/review/SKILL.md          # mirror (sync-plugin-skills --write)
skills/dream/SKILL.md                         # paraphrase site → pointer
skills/work/references/native-surfaces.md     # paraphrase site → pointer
plugins/genie/references/codex-integration-map.md  # paraphrase site → pointer
skills/genie-hacks/references/catalog.md      # paraphrase site → pointer
src/genie-commands/doctor.ts                  # minimal delta: results spread + --fix call after root resolution
src/genie-commands/doctor-worktrees.ts        # NEW: enumeration/classification/fail-closed removal
src/genie-commands/doctor-worktrees.test.ts   # NEW: colocated tests (repo convention: <module>.test.ts)
src/genie.ts                                  # --fix flag description update
src/term-commands/launch.ts                   # export resolveWorktreesBase
```
