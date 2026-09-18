---
name: verify
description: "Prove a completion claim with fresh evidence before making it — the gate's exit code, the real diff, the remote's checks, the reviewer's verdict."
category: verification
mutates: none
---

# Verify

Evidence before claims, always. This skill runs commands and reads their output; it changes nothing, so a failure it finds routes to fix, never to a quiet repair here. Reading a write back is still reading: the write belonged to whoever was authorized to make it, and this skill never originates one.

## The rule

A claim you have not verified in this turn is not a claim, it is a hope. If the command that would prove it has not run since the last change, the honest report is the actual state plus what is still unproven.

Violating the letter of the rule violates its spirit: a paraphrase, an implication, or an expression of satisfaction is a completion claim too.

## The gate function

Before any statement that work is done, correct, or passing:

1. **Identify** the one command whose output proves this exact claim.
2. **Run** it fresh and in full. A narrowed re-run proves only the narrowed scope.
3. **Read** the whole output and the exit code, and count the failures rather than scanning for the word "pass".
4. **Decide.** If the output confirms the claim, state the claim with the evidence beside it. If it does not, state the actual status with the same evidence.

Skipping a step is not a faster verification, it is a different activity.

## What proves what

| Claim | Proof | Not proof |
|-------|-------|-----------|
| The repository is green | the repository's own aggregate gate, its current stage chain read from the manifest rather than recalled, run whole and exiting zero in this turn | a previous run, a passing subset, "should pass" |
| Types are clean | the typecheck stage inside that gate | the linter passing |
| A test suite passes | the suite's own output with a failure count of zero | one file re-run, a cached result |
| A bug is fixed | the original symptom re-exercised and now passing | the code changed and the reasoning looks right |
| A mutation landed | the stored state read back afterwards through a different path than the write took | the writing call's own success return, or a response that echoes what was sent |
| Text sent through a CLI arrived intact | the stored body read back from the system that received it and compared against the source text | the exit code, or a receipt that counts bytes accepted |
| A regression test works | it fails with the fix reverted and passes with it restored | it passes once |
| A worker did the work | `git status` and `git diff` over the owned scope | the worker's success report |
| A branch is mergeable | the remote's checks read back from the pull request | a local gate alone |
| A group is shippable | a reviewer's returned verdict of SHIP | FIX-FIRST treated as "close enough", or your own read of your own work |
| Requirements are met | each wish criterion walked one by one against evidence | the gate being green |

## Before a check counts

A check nobody has watched fail is machinery, not evidence. Look for the record of it failing — the implementor's red run from before the change, or a run against a throwaway copy with the guarded condition broken, never the candidate itself — and confirm the failure message names that condition rather than a typo, an unresolved import, or a selection that matched nothing. With no such record, the check is cited as unproven. Ask the same question of every check you cite: what would it say against a target that never existed, or one it could not reach? A check that passes when the thing it guards is absent or unreachable is fail-open — an empty read-back treated as clean, a suite that skipped, a probe that reads "not found" as success — and it proves nothing about the claim it was offered for.

On a gate that was already failing before the change, a raw failure count decides nothing. Take the failing set on the base you started from, take the failing set now, and claim only what the comparison supports: which failures are new and yours, and which were already there and are still there. The claim of no regression needs an empty new-failure set, stated beside the pre-existing ones by name.

## Delegated work

A report from another agent is a pointer to evidence, not the evidence. Read the diff it claims to have produced and re-run the gate on the merged result. An agent that reports success having written nothing is the failure this row exists to catch.

Review verdicts are the same shape. SHIP is the only verdict that permits a completion claim. FIX-FIRST names gaps that must close and be re-reviewed; BLOCKED means the route changed and the claim is not available at all. Relay the verdict you received, never a softened version of it.

## Red flags

Reach for this skill the moment you notice "should", "probably", or "seems to"; satisfaction arriving before output; a commit, push, or pull request forming without a fresh gate; exhaustion arguing that the remaining check is a formality. Each of those is the same event: the claim is running ahead of the proof.

## Report

State the command, its exit status, and the claim it supports, in that order. Where expected evidence could not be captured, say which and why rather than leaving the gap silent.

<!-- adapted from https://github.com/obra/superpowers/tree/main/skills/verification-before-completion (MIT, commit b36e0829c6d0140e93cfef2ca599b1b07d4a7797 via dennisrongo/dsh-plugins vendor snapshot) -->
