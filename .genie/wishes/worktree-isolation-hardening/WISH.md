# Wish: Worktree isolation hardening — freeze git state, clean residue, pin reviews

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `worktree-isolation-hardening` |
| **Date** | 2026-07-27 |
| **Author** | Felipe + Genie (council deliberation 2026-07-27, adapting PR #2594 by lirazsiri) |
| **Appetite** | small-medium |
| **Branch** | `wish/worktree-isolation-hardening` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Adapts lirazsiri's PR #2594 per the 2026-07-27 four-lens council: the recorded context-mixing incident was a **repo-level git-state mutation** (a concurrent session switched the shared checkout), not a file-scope collision — so instead of mandating worktrees everywhere (which would serialize native `/work` dispatch, since the Agent tool cannot place subagents in worktrees), we keep the two-mode contract and add the invariant that actually matches the incident. Three deliverables: a git-state freeze for shared-workspace subagents, a `genie doctor` residue check/fix for accumulated launch worktrees (no new commands), and read-only snapshot worktrees pinned to the reviewed commit on the review path. Credit to @lirazsiri for the isolation diagnosis, the reviewer-snapshot design, and the GC design; #2594 closes in favor of this wish once landed.

## Scope

### IN

- Policy amendment, single-sourced: AGENTS.md (one sentence) + `skills/work/SKILL.md` dispatch paragraph (+ plugin mirrors) — keep "parallel writers must have disjoint file ownership OR dedicated worktrees", add: shared-workspace subagents never mutate repo-level git state (no `checkout`/`switch`/`reset`/`stash`/`rebase`; only the orchestrator moves HEAD); work needing repo-level mutation gets a worktree via `genie launch` or gets sequenced. All other docs point to the single source, never paraphrase.
- Recorded flip conditions, written next to the policy: (i) Agent tool gains per-dispatch worktree placement → flip to unconditional isolation; (ii) recorded corruption between disjoint-scope writers with no git-state mutation → freeze is the wrong abstraction, go full isolation + native-placement engineering; (iii) first orphaned-lane or wrong-order merge incident → land the full integration-worktree protocol from #2594; (iv) 3+ file-scope collision incidents → the disjoint-scope mode dies.
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
| 1 | Adapt, don't adopt: add a git-state freeze instead of mandating worktrees everywhere | The founding incident was a checkout switch (repo-state mutation), which neither current policy nor #2594's file-scope framing names; the freeze kills the observed failure class while preserving native parallel dispatch, which the mandate cannot (Agent tool runs in the session directory). Council consensus, all four lenses. |
| 2 | Residue cleanup lives in `genie doctor`, not a new command | Felipe: "I hate creating new commands without needing to"; doctor already owns the check/fix residue pattern (v4-home-residue-doctor directive). Fail-closed semantics live in code where they cannot be mis-pasted — the #2594 GC bug existed because the choreography was prose shell replicated across ~57 files. |
| 3 | Reviewer snapshots pinned to a commit, adopt-now | Unanimous council: near-zero standing cost, read-only so no per-lane install, fixes a real present hazard (reviews rendered against a moving tree). |
| 4 | Defer integration-worktree machinery behind a recorded trigger | Unpriced costs (per-worktree environment installs, PM resolving conflicts holding neither engineer's context) fail AGENTS.md's present-need evidence bar; one recorded incident lands it — cheap flip threshold, dissent recorded (dx-docs wanted it now). |
| 5 | Single-source the policy; all other docs point | #2594's ~57-file restatement is change amplification: every future revision becomes a drift event. |

## Success Criteria

- [ ] AGENTS.md and `skills/work/SKILL.md` (+ mirrors) carry the amended contract with the git-freeze clause and the four flip conditions; `git grep` finds the freeze stated in exactly those two places (other files may link, none paraphrase)
- [ ] `genie doctor` reports launch-worktree residue with per-worktree disposition (merged-clean → removable; unmerged or dirty → kept, reason shown); `--fix` removes only the provably safe set and refuses the rest loudly
- [ ] A dirty or unmerged worktree can NOT be removed by `doctor --fix` — regression test proves the fail-closed refusal (the #2594 fail-open class is unrepresentable)
- [ ] Review dispatch provisions a detached read-only worktree at the exact reviewed commit and removes it after the verdict; a concurrent write to the primary checkout during review provably does not alter the reviewed tree (test)
- [ ] Shared-workspace dispatch briefs (work skill) include the scope stanza + freeze rule; `bun run check` green (skills lint, plugin parity, wishes lint)
- [ ] #2594 closed in favor with credit comment; landing commits carry `Co-authored-by: Liraz Siri <liraz@liraz.org>` where his designs are implemented

## Execution Strategy

### Wave 1 (parallel — disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| policy | engineer | 2 (+1 prompt-skill change, +1 multi-surface mirrors) | opus-medium | Contract amendment + flip conditions + dispatch scope stanza, single-sourced across AGENTS.md / work skill / mirrors |
| doctor-residue | engineer | 3 (+2 stateful work: git ancestry/cleanliness proofs + destructive removal, +1 no deterministic test env for real panes — fixture worktrees instead) | opus-high | Doctor worktrees check + fail-closed `--fix` with regression tests |

### Wave 2 (after Wave 1 merges — touches review skill + reuses doctor removal core)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| review-snapshot | engineer | 3 (+2 orchestration/agent-lifecycle: review dispatch path, +1 prompt-skill change) | opus-high | Pinned read-only reviewer worktrees on the review path + teardown + docs |

## Execution Groups

### Group policy: Contract amendment + flip conditions

**Goal:** The git-state freeze and flip conditions become the single-sourced concurrency contract.

**Deliverables:**
1. AGENTS.md: amend the isolation sentence — keep the two-mode contract, add the freeze (workers never `checkout`/`switch`/`reset`/`stash`/`rebase`; only the orchestrator moves HEAD), link the flip conditions.
2. `skills/work/SKILL.md` (+ `plugins/genie/` mirror): dispatch paragraph updated; shared-workspace brief template gains the scope stanza + freeze rule verbatim.
3. Flip conditions (i)–(iv) recorded adjacent to the policy text.
4. Follow-up investigate item filed as a GitHub issue: mechanical dispatch-level enforcement of the freeze.

**Acceptance Criteria:**
- [ ] Freeze stated in exactly AGENTS.md + work skill (+ mirrors byte-identical); no other file paraphrases it
- [ ] Flip conditions enumerated verbatim next to the policy
- [ ] Brief template carries scope stanza + freeze rule
- [ ] Investigate issue filed and linked from the flip-conditions text

**Validation:**
```bash
bun run check:fast
```

**depends-on:** none

---

### Group doctor-residue: Doctor worktrees check + fail-closed fix

**Goal:** Accumulated launch worktrees become visible in `genie doctor` and removable only when provably safe.

**Deliverables:**
1. Doctor check: enumerate `<worktreesBase>` entries matching launch's `<repo>-<slug>-<group>` naming (source of truth: `src/term-commands/launch.ts` worktree/branch scheme), classify each: merged+clean (removable), unmerged (kept: commits not in integration branch), dirty (kept: uncommitted changes), foreign (kept: not a worktree of this repo).
2. `doctor --fix`: remove only merged+clean entries — ancestry proof AND cleanliness check chained in code; any git error → refuse that entry with the reason (fail-closed).
3. Tests: fixture repo + worktrees covering all four classes; regression tests that a dirty tree, an unmerged branch, and a git-error path each refuse removal.

**Acceptance Criteria:**
- [ ] Doctor lists residue with per-entry disposition and reclaimable size
- [ ] `--fix` removes merged+clean only; branch deleted with worktree; second run reports nothing to do (idempotent)
- [ ] Fail-closed regression tests pass (dirty / unmerged / git-error → refusal with reason in output)

**Validation:**
```bash
bun test src/genie-commands/ && bun run check:fast
```

**depends-on:** none

---

### Group review-snapshot: Pinned read-only reviewer worktrees

**Goal:** Review verdicts anchor to an immutable tree even while writers continue in the primary checkout.

**Deliverables:**
1. Review dispatch path provisions `git worktree add --detach <path> <commit>` at the exact commit under review; reviewer brief points at that path read-only.
2. Teardown after verdict (reuses the doctor-residue removal core — snapshots are always clean+detached, so removal is trivially safe; a crashed review's leftover snapshot is picked up by the doctor residue check).
3. `skills/review/SKILL.md` (+ mirror) documents the snapshot contract.

**Acceptance Criteria:**
- [ ] Reviewer works in a detached worktree at the reviewed commit; test proves a concurrent commit in the primary checkout does not change the snapshot tree
- [ ] Snapshot removed after verdict; a review cycle leaves zero snapshot leftovers (doctor residue check reports none)
- [ ] Skill docs updated, mirrors in parity

**Validation:**
```bash
bun test src/term-commands/ && bun run check:fast
```

**depends-on:** policy, doctor-residue

---

## Dependencies

**depends-on:** none
**blocks:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: on a repo with two finished launch worktrees (one merged+clean, one dirty), `genie doctor` shows both with correct dispositions and `--fix` removes exactly the merged one
- [ ] Integration: a `/work` wave with two disjoint-scope native subagents runs in parallel in the shared checkout; briefs visibly carry the scope stanza + freeze rule; orchestrator commits land while HEAD never moves mid-wave
- [ ] Regression: `genie launch <slug> --dry-run` output unchanged; existing doctor checks unaffected; full `bun run check` green

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Freeze is prose-enforced; an agent can still violate it (the founding incident violated an implicit norm) | Medium | Follow-up investigate issue: dispatch-level mechanical guard; violation caught at review via diff/state audit; flip condition (ii) fires if mixing recurs despite the freeze |
| Doctor `--fix` deletes something an operator wanted despite proofs | Medium | Ancestry checked against the integration branch tip at run time; refusal on ANY git error; tests pin every refusal path; `--fix` prints each removal with the proof it passed |
| Reviewer snapshots accumulate if a review crashes before teardown | Low | Snapshots are detached+clean by construction → doctor residue check classifies and removes them on the next `--fix` |
| Scope stanza adds brief ceremony with zero recorded file-collision incidents (simplifier's dissent) | Low | Stanza is template text, not a new artifact class; flip condition (iv) records when it would matter; revisit if it proves noise |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
AGENTS.md                                    # contract amendment + flip conditions
skills/work/SKILL.md                         # dispatch paragraph + brief scope stanza
plugins/genie/skills/work/SKILL.md           # mirror
skills/review/SKILL.md                       # snapshot contract
plugins/genie/skills/review/SKILL.md         # mirror
src/genie-commands/doctor.ts                 # worktrees residue check + --fix
src/genie-commands/doctor.worktrees.test.ts  # fixtures + fail-closed regression tests (name per repo convention)
src/term-commands/launch.ts                  # read-only naming-scheme reference; export shared helper if needed
```
