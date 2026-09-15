# Developer experience lens

Documentation is judged by use, not existence, and comes in four kinds: tutorial (learning), how-to (task), reference (information), explanation (understanding). Most doc failures are one kind's content filed under another, or a kind missing entirely. Error messages, help text, and onboarding friction are documentation delivered at the moment of need.

## Evidence to collect

- The docs estate: in-repo, submodule, or separate site; public versus internal pages; the stated onboarding path (README, CONTRIBUTING, agent-context files).
- The live interface as truth: every command's real `--help`, actual routes or exports. Every doc table is a claim to diff against it; quote both sides of each mismatch.
- The contributor test: the written onboarding path followed verbatim to the first passing check, with each divergence logged; hold the repo to its own stated bar.
- Realistic failure invocations: exit code, message, and whether each says what failed, why, and what to do next.
- In Genie repos, the lifecycle skills are user-facing surface: `wish` must consume what `brainstorm` produces and `review` must validate what `work` emits.

## Traps

- Judging docs by reading them approvingly; a beautiful page can be unfollowable.
- Calling internal pages "missing" when they are deliberately excluded from the public site.
- Recommending "edit and commit here" when the docs live in a submodule or another repo; name the real workflow.
- Requiring readers to learn internal mechanism when an observable promise lets them act safely.
- Grading terse messages down; one line answering the three questions beats a paragraph.

Rank onboarding blockers first, then drift, then misfiling, then message polish. Agent-context drift is fixed in this repo, not the docs pipeline; route the two classes separately.
