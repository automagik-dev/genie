# Brainstorm: Ledger re-baseline (2026-07-21)

**WRS: ██████████ 100/100** — Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅ — both scout verifications landed 2026-07-21; ledger corrections applied. Remaining: Felipe's live QA ritual (decision 2) + final commit.

## Problem

The `.genie` ledger (INDEX.md + wish/brainstorm statuses) drifted from reality: dev moved 234
commits while the local branch sat on a 07-11 base, and at least one wish executed elsewhere
landed on dev under different commits, so statuses now contradict each other and git history.

## Scope

**IN:** disposition for every non-DONE wish, every Raw/Simmering brainstorm (07-09 umbrella
vintage), and 3 undecided files (`repo-profile.md`, `HANDOFF-20260711.md`, the
execution-optimization-dashboard INBOUND note). Output = corrected INDEX.md + wish status
headers + jar, all committed.
**OUT:** any code changes; executing the open QA rituals themselves (user-gated).

## Reality snapshot (verified against origin/dev, 2026-07-21)

| Item | Ledger says | Reality |
|------|-------------|---------|
| routing-delivery-fix | CODE COMPLETE, PR pending | Code IS on dev (`2315671a`/`3ffc3300` + 6 hardening commits). Only Group C day-3 QA open |
| routing-matrix | QA OPEN | Same single gate: live ritual, fingerprints 0/7 only because Claude was logged out on 07-14 |
| codex-plugin-update-handoff | WISH: IN_PROGRESS 0/71; INDEX: BLOCKED 2/2 | **VERIFIED 2026-07-21 (scout + 3-lens ledger verify): NOT superseded.** Dev shipped only the delivery-adjacent plugin-only layer (B1 `3b4faa3b`, B2 `6f423869`) — and dev's path still cache-advances without permits, so the core hazard is open there. On the wish branch (tip `ac264911`) Groups A+B are execution-SHIP-reviewed (scout's initial "~60%/~40%" figure was ungrounded and rejected by the verify pass); C–E not started; B-handback forbids merging A–B before C. INDEX "BLOCKED 2/2" was wrong — plan gate was SHIP at loop 1/2. All ledger surfaces corrected |
| stable-release-security-gate | G1 dispatched, G2 Felipe-owned | Blocks stable promotion (F16–F18/F31); unverified this session |
| pr-2545-ultra-release-gate | pending successor-PR CI + approval + F44 | Unverified this session |
| plugin-resource-shipping | QA pending live scaffold | Merged #2540; only live QA open |
| v4-home-residue-doctor | DRAFT, absent from INDEX | Never started |
| agent-sync-hardening | superseded criterion-by-criterion | External/final gates still listed open |
| 07-09 umbrella brainstorms | Raw/Simmering | **SWEPT 2026-07-21 (scout): none dead.** LIVE as drafted: genie-spend, dream-replatform, intent-to-wish-compiler, brainstorm-domain-map. STALE-BUT-LIVE (scope narrowed, INDEX one-liners refreshed): control-plane-contract (agent-sync solved convergence), skill-absorbs (council delivered via workflow), always-on-genie (SessionStart enumerator shipped, identity/isolation open), cross-agent-delegate (Codex plumbing solved by agent-sync) |

## Decisions (RATIFIED by Felipe, 2026-07-21)

1. **codex-plugin-update-handoff → verify-then-supersede.** Scout maps all 71 criteria to dev
   commits (B1 `3b4faa3b`, B2 `6f423869`, evidence/retirement chain); close what landed,
   keep only real residue as a small follow-up. Same pattern as agent-sync-hardening.
2. **Day-3 QA gate → run the live ritual THIS SESSION.** Felipe is logged in; record evidence
   under `wishes/routing-matrix/qa/`, close both routing wishes on PASS.
3. **Umbrella brainstorms → re-baseline sweep.** Each of the 8 drafts gets a verdict
   (SUPERSEDED / STALE-BUT-LIVE / LIVE) with citations; jar gets refreshed one-liners.
4. **Files:** `repo-profile.md` committed (shared repo knowledge, 7 skills read it);
   `HANDOFF-20260711.md` + dashboard INBOUND note deleted (superseded). — APPLIED.

## Risks

- Closing a wish as "superseded" without diffing its criteria vs dev commits may drop real residue
  (the exact failure mode agent-sync-hardening's criterion-by-criterion note exists to prevent).
- Two QA gates share one precondition (Claude logged in); parking them again risks indefinite drift.

## Criteria

- INDEX.md contains no status that contradicts origin/dev history.
- Every non-DONE entry names one concrete next action and its owner (Felipe vs agent).
- Superseded wishes carry a criterion-level mapping to the dev commits that closed them.
