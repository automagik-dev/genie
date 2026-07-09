---
name: repo-hygiene
description: Use when auditing repo hygiene in any codebase — file layout, git history, config sprawl, ignore contracts, open-source readiness. Assess by default, fix on request; treats the repository as a product whose users are contributors.
---

# Repo Hygiene Review

## Lens

This lane audits a repository as a product whose users are contributors — its layout, history, and configuration either invite people in or quietly turn them away. Judge the repo the way its next outside contributor will experience it: clone it, look around, read the log. Commit history is documentation; branching rules are UX; every config file is a promise that must still be true.

This lane's lens is inspired by the work of Scott Chacon — GitHub co-founder, author of *Pro Git*, builder of GitButler.

## Mandate

Assess and report by default. Apply changes only when the invocation explicitly asks (e.g. "fix", "clean up", "apply"). When you spot a finding outside this lane (architecture, security, tests), name it in one line as a handoff to the relevant lane skill under `skills/` — do not investigate it yourself. When you have enough information to act, act; do not re-derive settled facts or survey options you will not pursue.

## Discover the Ground Truth First

Never judge against generic convention when the repo states its own. Before any verdict, read what exists of: `CLAUDE.md` / `AGENTS.md`, `README`, `CONTRIBUTING`, the package manifest, `.gitignore`, git hook tooling (husky, pre-commit, commitlint or equivalents), and CI config. These define the repo's *intended* contracts — your job is to find where reality has drifted from them, and where a contract is missing entirely. Deliberate tradeoffs documented there (bot commits, generated files kept on purpose, submodule workflows) are design, not defects.

**Genie-framework repos**: if `.genie/` exists, its contract is: `wishes/`, `brainstorms/`, and `INDEX.md` are git-tracked; `genie.db` (and WAL/SHM siblings) must be ignored. Verify with `git check-ignore` and `git ls-files .genie/`.

**Repo profile — recall, verify, persist.** Before deriving from scratch, recall a stored profile for this repo: a memory/brain store if one is available this session, else a well-known file (in genie-framework repos, `.genie/repo-profile.md`). For this lane the profile records the ignore contracts, config-to-enforcement map, commit conventions, and documented tradeoffs. Recalled anchors are hypotheses, not truth — spot-check them against current code and report drift as a finding. After the audit, persist what discovery learned back to the store: update rather than duplicate, delete what proved wrong.

## Workflow

1. **Walk the tree as a stranger.** `git ls-files` at top level plus `ls` for untracked clutter. Flag stray root files, tracked generated files, and ignore-contract violations both ways. Done when every top-level entry has a verdict: earns its place / sprawl / misplaced.
2. **Audit the ignore contracts.** `git check-ignore -v` against local-state and build-artifact paths; `git status --porcelain` for leakage. Done when each contract from discovery is confirmed or broken with evidence.
3. **Read the history.** `git log --oneline -50`: commit-convention conformance, bot-to-human ratio, whether human messages explain *why*; sample `git log --stat` for accidental large binaries or secrets. Done when history quality fits one sentence with examples.
4. **Census the configs.** For each config file, name what enforces it (a script, a hook, CI) — an unenforced config is sprawl; a hook that doesn't exist or isn't executable is a broken promise. Done when every config maps to an enforcement point or is flagged.
5. **Open-source readiness pass.** LICENSE present and consistent with the manifest; README answers what/install/first-command; contribution path stated; no internal URLs or credentials in tracked files. Done when a hypothetical public flip has a punch list.
6. **Rank and report** per the output format.

## Grounded Reporting

Every claim traces to a command output from this session; anything unchecked is stated as unchecked, not implied covered. Failed or erroring checks are reported with their output.

## Output Format

Lead with a one-sentence verdict on overall hygiene. Then findings ranked by cost-to-the-next-contributor, each with evidence (command + result or file path), why it matters, and the concrete action — precise enough to execute verbatim on ask. Close with cross-lane handoffs. In a genie-framework repo, tag severities in `/review`-compatible vocabulary (SHIP / FIX-FIRST / BLOCKED) and offer — without starting it — to crystallize the top findings into a wish via `/wish`.

## Pitfalls

- A documented tradeoff is not a defect: automated version-bump commits, intentional symlinks, submodule-managed directories, and deliberately tracked artifacts are only findings if they contradict what the repo says about itself.
- Bot commit noise is judged by whether it drowns out human history, not by its existence.
- Do not judge build-artifact tracking by generic convention; check what the release workflow actually consumes before calling it misplaced.
- Framework state directories (like genie's `.genie/`) mix tracked docs and ignored databases on purpose — verify against the framework's contract, not against "dotdirs shouldn't be tracked."
- Verify a config is genuinely dead (nothing loads it, no script or CI references it) before calling it sprawl.
