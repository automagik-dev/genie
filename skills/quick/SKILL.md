---
name: quick
description: "Ship tiny low-risk changes to dev within one hour."
category: delivery
mutates: repo
---

# Quick

Deliver one tiny, already-decided change through implementation, review, CI, merge, deployment and read-back in `dev`. The contract is **request → deployed-dev read-back within 60 minutes**; code or a PR without live read-back is not success.

## Eligibility

Use only when all hold: one existing behavior in one repository; a low-impact, reversible change with an objective focused check; target `dev`, never homolog or production; CI, deployment and read-back conservatively fit inside 60 minutes; **existing merge authority** already covers this repository and the `dev` merge; no unresolved product or architecture decision.

Never for migrations; auth, permissions, secrets or tenant boundaries; billing or money; destructive or data-loss behavior; public API or protocol compatibility; irreversible or shared infrastructure; production mutation; multiple repositories; incidents with an unknown cause. File count is not the test; consequence, reversibility and oracle quality are.

## Admission (minute 0–5)

1. Record the start time and the fixed deadline in the execution contract; the deadline never moves.
2. Inspect the live repository, branch, CI, dev target and deployment path.
3. Confirm the existing merge grant covers this exact repository and merge. Quick never requests or manufactures authority.
4. Write a one-screen execution contract: **core** (satisfies the request on its own), **flex** (explicitly cuttable), **oracle** (focused check plus visible dev read-back), **target** (repository, base branch, dev environment), **stop triggers**. Size flex at admission, not under pressure: an item is flex only if dropping it still leaves the core satisfying the request and the oracle meaningful, and core plus the repository's observed check and deployment times must fit the 35-minute mark with slack. If nothing is genuinely cuttable, the change is not Quick-sized.
5. If any eligibility fact is missing, refuse before implementing: return the inspected evidence and route the request to the normal lifecycle without starting it.

## Execute (minute 5–35)

One executor through the runtime's native delegation surface, inheriting the runtime's model and configuration, in one isolated worktree cut from the target base. No fan-out and no group ceremony; concurrency changes the risk class and exits Quick. Implement only the core plus a focused regression test where practical, following repository-local test and validation rules. Stage only task-owned paths; never stage the whole worktree. Mixed task and unrelated hunks are staged selectively, and scope that cannot be separated reliably stops the run before anything is published. Cut flex the moment evidence threatens the deadline. At minute 35 the branch holds a complete candidate core or Quick stops as `quick-missed`.

## Integrate (minute 35–50)

1. Run the focused test and every affected repository check.
2. Obtain the repository's required independent review of the exact diff for correctness, scope, secrets and target identity, from an agent other than the executor. Self-review is not independent evidence. Quick adds no Genie plan or execution gates beyond what the repository requires.
3. Apply at most one bounded correction while time remains.
4. Push, then read the remote back before trusting it: the remote branch head is the commit just pushed, and nothing else moved. Open the PR to `dev`, re-read it, and check base, head and the changed-file set against the execution contract's core. A published state that differs from intent is reported, never declared.
5. Wait for every required check. Never bypass or weaken checks. At minute 50, if required CI is not green or the candidate is not merge-ready, stop as `quick-missed`.

## Deliver (minute 50–60)

Re-read the exact PR head, required CI and merge authority; merge to `dev` only inside that authority; verify the dev deployment serves the expected revision by comparing the deployed revision against the merged head and the deployed changed-file set against the contract's core; then exercise the changed behavior and read back its observable result. Success only when deployment and read-back both pass before the deadline. A separate human-controlled promotion may consume the proven dev result later.

## Miss

At or before minute 60 with any success condition absent: stop; preserve branch, commits, PR and evidence; emit `quick-missed`; return the request to normal sizing. Do not continue, retry, discard work or claim partial delivery. A failed check, failed CI, wrong target, missing authority, deployment mismatch or failed read-back is a miss, not permission to lower the gate.

## Output

```text
quick-shipped
Core: <observable behavior>
PR: <url and exact head>
CI: <required checks>
Review: <reviewer and verdict>
Dev: <target revision and read-back>
Elapsed: <request to verified dev>
Flex cut: <items or none>
```

```text
quick-refused
Reason: <eligibility or authority failure>
Evidence: <live fact>
Route: <normal lifecycle entry point>
Effects: none
```

```text
quick-missed
Elapsed: <time>
Preserved: <branch/PR/commit>
Completed: <verified state>
Blocker: <exact unmet gate>
Next route: normal sizing/workflow
```
