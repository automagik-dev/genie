# Exact-path commit from a shared checkout

Use this when reviewed work must become a real commit while the checkout still holds unrelated staged, modified or
untracked files — another worker's, or your own from a different group. A dedicated worktree is cheaper whenever one
is available; reach for this only when it is not.

Two rules hold through every step: commit the exact reviewed pathset and never a sweep of the whole tree, and never
discard, revert or set aside uncommitted work you did not write. Preservation is provable here, so prove it rather
than asserting it.

## Before anything moves

1. Hold explicit authorization to commit. Permission to edit, or to review, is not permission to commit.
2. Only the coordinator moves `HEAD` in a shared checkout; workers leave their edits uncommitted.
3. Record the current `HEAD`, the branch, the exact target paths with their content hashes, and the review evidence
   that governs them. Every gate below is checked against that record.
4. Confirm the target paths are disjoint from every concurrent writer. If they are not, stop and ask for isolation.

## Commit first, review the SHA

Review an addressable commit rather than a live tree: the SHA pins exactly what was judged, and a tree that keeps
moving underneath a reviewer makes the verdict unattributable. Run the required checks while the candidate is still
uncommitted, commit the governed pathset, then hand every reviewer that SHA. FIX-FIRST produces a new commit and a
review of the new SHA; the reviewer never advances the snapshot itself.

## The alternate index

The real index is shared state, so assemble the commit in a second one and leave the real one untouched.

```bash
# 1. Record the real index so preservation can be proved afterwards.
git ls-files -s > "$before"

# 2. Build a private index from HEAD and stage only the named targets.
rm -f "$alt"                       # an empty file is not a valid index
GIT_INDEX_FILE="$alt" git read-tree HEAD
GIT_INDEX_FILE="$alt" git add -- "${targets[@]}"

# 3. Read the staged pathset back and compare it with the expected set.
GIT_INDEX_FILE="$alt" git diff --cached --name-only

# 4. Commit through it: the branch advances, the real index does not.
GIT_INDEX_FILE="$alt" git commit -m "<subject>" -m "<body paragraph>"

# 5. Point the real index's target entries at the new commit, those only.
git reset HEAD -- "${targets[@]}"
```

Step 3 fails closed: one missing or one extra path and nothing is committed. Skipping step 5 leaves the old index
describing the committed files as staged deletions. Pass the subject and each body paragraph as its own `-m`, because
an escaped newline inside a quoted string stays literal text and a trailer written that way is never parsed as one.

## Gates before the commit counts

- The pathset read back from the commit equals the target set exactly.
- The target files are clean afterwards and their hashes still match the pinned record.
- Every non-target index entry matches the `$before` snapshot, and unrelated working-tree files are unchanged.
- The required checks ran against this SHA, and the stored commit message reads back as intended.
- The temporary index file is gone.
- A commit authorizes nothing further: push, pull request and merge each need their own authorization.
