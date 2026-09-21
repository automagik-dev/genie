---
name: merge
description: "Resolve an in-progress merge or rebase by the intent of both sides, re-run the full gate on the merged tree, and finish the operation."
category: delivery
mutates: repo
---

# Merge

A conflict is two intents meeting, not two texts disagreeing. Resolve it by understanding what each side was for. Always resolve; abandoning the operation returns the same conflict to the next person with less context than you have now.

## See the state

Establish what is actually in progress before touching a file:

```bash
git status
git log --oneline --left-right --boundary HEAD...MERGE_HEAD
mapfile -t conflicted < <(git diff --name-only --diff-filter=U)
printf '%s\n' "${conflicted[@]}"
```

Record that list while the paths are still conflicted: once the markers are gone the same query returns nothing, and this is the list you stage at the end.

A rebase and a merge present the sides in opposite orders, so confirm which operation you are in before reading any hunk. During a rebase the side labelled as yours is the upstream branch, and the side labelled as theirs is the commit being replayed.

## Find the intent

For each conflicting file, find the primary source of both changes:

```bash
git log -p --follow -- <path>
```

Read the commit messages, and where a commit points at a pull request or an issue, read that too. The wish that owns the work is the strongest source available in this repository: the criteria and the execution strategy say what the change was for in the author's own words. Keep reading until you can state each side's intent in one sentence.

## Resolve each hunk

- Preserve both intents where they compose. Most conflicts are two independent edits that a mechanical tool could not interleave.
- Where they genuinely cannot compose, keep the one matching the stated goal of this merge and note the trade-off in your report.
- Never resolve by taking one side wholesale. Choosing a side without reading the hunk discards the other intent silently, which is exactly the failure a conflict exists to prevent.
- Never invent behaviour neither side asked for. A conflict is not an opportunity to refactor.
- Delete every conflict marker, then read the merged region as though it arrived as a fresh diff. It has to make sense on its own.

## Re-run the gate

The merged tree is code neither side ever compiled. Run the repository's full gate on it:

```bash
bun run check
```

That is typecheck, lint, dead-code, and tests in one command, and it is the only proof the merge is sound. A green gate on either parent proves nothing about the merge. Fix what the merge broke, and re-run until it exits zero; a partial re-run proves only the part you re-ran.

## Finish

Stage the paths you recorded as conflicted, nothing else, and complete the operation:

```bash
git add -- "${conflicted[@]}"
git commit -m 'chore: merge <source> into <target>'
git rebase --continue   # when rebasing, until every commit is replayed
```

The subject uses a conventional-commit type. There is no merge type in the accepted set, so a subject beginning with that word alone is rejected by the commit hook; `chore` is the type that carries an integration commit.

A rebase surfaces its conflicts one commit at a time, so run the gate again after the last commit replays, not only after the first resolution.

## Report

Name each conflicting file, the intent you preserved on each side, every trade-off you took where the two could not compose, and the gate result on the merged tree with its exit status.

<!-- adapted from https://github.com/mattpocock/skills/tree/main/skills/resolving-merge-conflicts (MIT, commit cddededbbb2ed38f0e0b26b46be8455c59d78ab1 via gongyijie85/mattpocock-skills-dsh) -->
