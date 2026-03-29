# Dream Session — 2026-03-29 (Genie)

## Wishes (4)

| merge_order | slug | branch | wish_path | depends_on | GH Issue |
|-------------|------|--------|-----------|------------|----------|
| 1 | task-external-linking | feat/task-external-linking | .genie/wishes/task-external-linking/WISH.md | — | #796 |
| 1 | task-auto-close-on-merge | feat/task-auto-close-on-merge | .genie/wishes/task-auto-close-on-merge/WISH.md | — | #797 |
| 1 | genie-hacks-community-docs | feat/genie-hacks-community-docs | .genie/wishes/genie-hacks-community-docs/WISH.md | — | — |
| 1 | worktree-out-of-repo | feat/worktree-out-of-repo | .genie/wishes/worktree-out-of-repo/WISH.md | — | — |

All 4 wishes are independent — Layer 1, full parallel execution.

## Execution Plan
1. Dispatch all 4 workers in parallel (Layer 1)
2. Review each PR as workers complete
3. Merge to dev in any order (no dependencies)
4. QA on dev after all merges
