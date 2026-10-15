# EVIDENCE — why `agent-coach` exists

Created **2026-08-16**, active from birth by explicit user directive (the
colony `/goal`: "self improving microagents that commit their state"). Not
scanner-selected — the transcript scanner has no prompt-auditing family and
never will; this agent exists because the colony needs a feedback organ, not
because a burn table ranked it.

## The mechanism it serves

The colony loop (`.mikro/loop/README.md`) commits every agent's report as
state. agent-coach closes the improvement circuit: report → audit → PATCH
proposals → host review → applied prompt → next cycle's report. Its design
descends from a measured result in this workspace: the verification-block
convention it audits for is the one `docs/parity-explore.md:685` credits with
the collapse in fabricated citations, and the no-worked-example rule guards
the exact turn-one fabrication `git-historian.proposed/EVIDENCE.md` §4
recorded.

## What is not claimed

- **No quality evidence.** Unrun at creation. Its first real audit is its
  first data point, and early cycles should treat its PATCH proposals with
  suspicion proportional to that.
- **Patches are proposals.** Nothing here implies its patches are safe to
  auto-apply; the loop's boundary (host reviews, host applies, host commits)
  exists precisely because a self-improving prompt with no reviewer is a
  self-degrading prompt with extra steps.
- **No savings claim.** Nothing was measured to justify this agent in tokens.

## Withdraw

```bash
mv .mikro/agents/agent-coach .mikro/agents/agent-coach.proposed
```
