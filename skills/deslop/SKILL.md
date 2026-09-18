---
name: deslop
description: "Clean up the prose or code already in scope — protect its meaning, voice and behaviour, remove what only adds reading work, and return findings instead of edits when a review was asked for."
category: lifecycle
mutates: repo
---

# Deslop

Reduce the work of reading, maintaining and safely changing what is in front of you, without losing what it guarantees. Lines, sentences, files, wrappers, dependencies and tests have no target count, and a pass that changes nothing is a valid result.

## Bound the scope

The subject is what the request already names: this draft, this document, this diff, the code just touched and the callers it reaches. A repository-wide sweep is separate work with its own request. Ordinary drafting and ordinary implementation include checking what you touch; neither authorizes unrelated cleanup, and neither reopens a decision the caller already made.

Name the mode in one line before the first change, and take the narrowest mode the request supports:

| Mode | You return | Done when |
|---|---|---|
| Draft or implement | The artifact | The requested scope is covered and its own checks pass |
| Cleanup | The edited artifact and what changed | Every change names a benefit, and every protected invariant still holds |
| Review | Findings, nothing edited | Every finding carries a location, the burden it imposes, and the smallest useful fix |

A request to look at something is a review. Rewriting on a review request destroys the evidence the caller asked for.

## Protect before you remove

List what must survive before proposing a single removal, and keep the list where the caller can read it.

In prose, protect names, quantities, claims, citations, requirements and causal links, along with the author's stance and degree of certainty. In code, protect the requested behaviour, the existing contracts, and whatever an apparently redundant construct is there to defend.

Removing something whose purpose you cannot state is a guess wearing a diff. When the reason for a construct stays unclear after you have looked for it, the honest output is a low-confidence finding, not a deletion.

## Tells are clues, never quotas

The references below name what tends to signal avoidable work. Each one is a reason to look, never a verdict. A contrast may explain a real distinction, passive voice may focus on the right subject, an adverb may qualify a claim, and an extra layer may hold a boundary. Judge the instance in front of you.

No deletion quota, no detector score, no punctuation ban, no compulsory stylistic change. Swapping one stock phrase for another, or chopping prose and flattening call graphs so the work looks done, fails the same way the original did.

## The two halves

Load only the half the request needs:

- `references/writing.md` — prose: messages, documents, reports, copy, pull request bodies.
- `references/code.md` — code: the touched implementation, its callers and its tests.

Prose judged against the live product belongs to the docs skill, a prompt to refine, a skill to authoring. A blocking review gap is repair work for the fix skill, not for this one.

## Before you stop

Read the result once against the original. In prose, check numbers, named entities, degree of certainty and who said what. In code, run the checks that actually cover the changed behaviour and quote their exit codes.

Report what changed, the benefit each change bought, the checks you ran, and what you deliberately left alone and why. Never argue a change from the size of the diff: a shorter diff is not evidence of performance, correctness, or saved effort. Stop when the artifact serves its purpose instead of polishing it into a different voice or a different architecture.
