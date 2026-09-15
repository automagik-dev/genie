# Repository hygiene lens

A repository is a product whose users are contributors. Its layout, history, and configuration either invite people in or quietly turn them away. Commit history is documentation, branching rules are UX, and every config file is a promise that must still be true.

## Evidence to collect

- The repo's own contracts before generic convention: agent instructions, README, CONTRIBUTING, manifest, `.gitignore`, hook tooling (husky, pre-commit, commitlint), CI config. Documented tradeoffs (bot commits, generated files kept on purpose, submodule workflows) are design.
- The tree as a stranger sees it: tracked files at the top level plus untracked clutter; each entry earns its place, is sprawl, or is misplaced.
- Ignore contracts both ways: `git check-ignore -v` on local-state and build paths, `git status --porcelain` for leakage. In Genie repos, `.genie/wishes`, `brainstorms` and `INDEX.md` are tracked while `genie.db` and its WAL/SHM siblings are ignored.
- History: convention conformance, bot-to-human ratio, whether human messages explain why; `git log --stat` samples for accidental binaries or secrets.
- For every config file, what enforces it (script, hook, CI); unenforced config is sprawl, a missing or non-executable hook is a broken promise.
- Open-source readiness: LICENSE matches the manifest, README answers what/install/first command, no internal URLs or credentials tracked.

## Traps

- Reporting a documented tradeoff (auto version-bump commits, intentional symlinks, tracked artifacts the release workflow consumes) as a defect.
- Judging bot noise by its existence rather than whether it drowns human history.
- Treating a framework state directory that mixes tracked docs and ignored databases as "dotdirs shouldn't be tracked".
- Calling a config dead before confirming nothing loads or references it.

Rank by cost to the next contributor, each finding with the command and result, and an action precise enough to execute verbatim.
