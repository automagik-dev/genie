---
name: quick
description: "Ship tiny low-risk changes to dev within one hour."
---

# quick — One-hour delivery

**Runtime syntax:** invoke the plugin copy through the active runtime's owner-qualified skill selector; use a bare selector only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active runtime.

Deliver one tiny, already-decided change through implementation, CI, merge, deployment and read-back in `dev`. The contract is **request → deployed-dev read-back within 60 minutes**; code or a PR without live read-back is not success.

## When to Use

Use only when all are true:

- one existing behavior, repository, card and payout;
- low-impact, reversible change with an objective focused check;
- target is `dev`, never homolog or production;
- CI, deployment and read-back conservatively fit inside 60 minutes;
- existing merge authority already covers the repository and eligible `dev` merge;
- no unresolved product or architecture decision.

Do not use for migrations; auth, permissions, secrets or tenant boundaries; billing or money; destructive/data-loss behavior; public API/protocol compatibility; irreversible/shared infrastructure; production mutation; multiple repos or independent payouts; or incidents with an unknown cause.

## Admission — minute 0–5

1. Record the start and hard deadline with `terminal`; the deadline never moves.
2. Inspect the live card, repository, branch, CI, dev target and deployment path.
3. Verify an existing task-scoped merge grant or bounded Autopilot grant authorizes this repository and eligible `dev` merge. Do not request or manufacture authority inside Quick.
4. Write a one-screen execution contract in the response or worker brief:
   - **core:** independently satisfies the request;
   - **flex:** explicitly cuttable;
   - **oracle:** focused check and visible dev read-back;
   - **target:** exact repository, base branch and dev environment;
   - **stop triggers:** any condition that rejects or ends Quick.
5. Refuse before implementation if any eligibility fact is missing. Return the inspected evidence and route the demand to the normal lifecycle; do not start that lifecycle silently.

Admission is complete only when every eligibility fact and the existing merge authority are proven.

## Execute — minute 5–35

1. Start exactly one executor through the active runtime's native delegation surface, inheriting the active runtime model and configuration.
2. Use one isolated worktree from the current target base. No fan-out, board/group ceremony, independent reviewer or model-selection machinery.
3. Implement only the core and a focused regression test where practical. Follow repository-local TDD and validation rules.
4. Cut flex immediately when evidence threatens the deadline.

**No new surface enters after minute 35.** At minute 35 the branch must contain a complete candidate core or Quick stops as `quick-missed`.

## Integrate — minute 35–50

1. Run the focused test and every affected repository check.
2. Perform one self-review of the exact diff for correctness, scope, secrets and target identity.
3. Apply at most one bounded correction while time remains.
4. Open the PR to `dev` and wait for every required CI check. Never bypass or weaken checks.

**No new code change starts after minute 50.** If required CI is not green or the candidate is not merge-ready, stop as `quick-missed`.

## Deliver — minute 50–60

1. Re-read the exact PR head, required CI and existing merge authority.
2. Merge to `dev` only inside that authority.
3. Verify the designated dev deployment serves the expected revision.
4. Exercise the changed behavior in dev and read back its observable result.
5. Report success only when deployment and behavior read-back both pass before the deadline.

Quick never merges to homolog or production. A separate human-controlled promotion may consume the already-proven dev result later.

## Timeout and Failure

At or before minute 60, when any success condition is absent:

- stop automatically;
- preserve the branch, commits, PR and evidence;
- emit `quick-missed` with elapsed time, exact completed state and blocker;
- return the demand to normal sizing/workflow;
- do not continue, retry, discard work or claim partial delivery.

A failed focused check, failed CI, wrong target, missing authority, deployment mismatch or failed read-back is a miss—not permission to lower the gate.

## Output

### Success

```text
quick-shipped
Core: <observable behavior>
PR: <url and exact head>
CI: <required checks>
Dev: <target revision and read-back>
Elapsed: <request to verified dev>
Flex cut: <items or none>
```

### Refusal

```text
quick-refused
Reason: <eligibility or authority failure>
Evidence: <live fact>
Route: <normal lifecycle entry point>
Effects: none
```

### Miss

```text
quick-missed
Elapsed: <time>
Preserved: <branch/PR/commit>
Completed: <verified state>
Blocker: <exact unmet gate>
Next route: normal sizing/workflow
```

## Pitfalls

- Counting PR creation or merge as delivery without dev deployment/read-back.
- Starting while CI or deployment is already too slow to fit the remaining hour.
- Treating file count as eligibility; consequence, reversibility and oracle quality decide.
- Asking for merge permission after implementation; missing authority is an admission refusal.
- Continuing after 60 minutes because the task feels almost complete.
- Opening parallel workers to recover time; concurrency changes the risk class and exits Quick.

## Verification

Before `quick-shipped`, verify all of the following:

- one executor and one repository/worktree;
- focused tests and affected checks passed;
- required PR CI passed on the exact merged head;
- existing merge authority covered the exact merge;
- dev serves the intended revision;
- changed behavior was exercised and read back;
- total elapsed time is at most 60 minutes;
- no homolog or production mutation occurred.
