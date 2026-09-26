# Genie repository contract

This is the runtime-neutral contributor contract for Claude Code, Codex, and human contributors. Client-specific overlays may add syntax, but they must not contradict this file.

## Validate changes

```bash
bun install --frozen-lockfile
bun run check
bun test path/to/file.test.ts
```

The full gate runs type checking, Biome, dead-code analysis, skill/wish/council linting, and tests. Tests use `bun:test`; fixtures belong under a temporary directory and must isolate `GENIE_HOME` when touching global state.

## Architecture

- `src/genie.ts` is the Commander CLI entry point.
- `src/lib/v5/` owns SQLite state. The per-repo `.genie/genie.db` stores task state and is the only database genie writes; the machine-scope `~/.genie/genie.db` path carries no genie state in v6, and the per-repo opener refuses it so the two can never merge.
- `src/term-commands/` owns `init`, `context`, MCP, task, and board commands.
- `plugins/genie/` is retired with the Orca integration: the source tree carries none, and release tarballs keep an empty `plugins/genie/` compat directory only because earlier binaries' update path requires it. `genie orca` is a one-release stub that prints a retirement notice and exits 2.
- `skills/` is shared runtime-neutral workflow guidance, delivered to every agent home by the skills channel. `genie install`/`genie update` run the pinned skills.sh CLI over the local delivered tree and record the result in `<GENIE_HOME>/skills-install.json`; without the Genie binary the same skills install with `npx skills add automagik-dev/genie`, which serves the repository's default branch rather than a release.
- `.genie/` contains git-tracked wishes, reviewed designs (`brainstorms/*/DESIGN.md`) and the index, plus gitignored brainstorm working notes and operational SQLite files.

Genie is zero-daemon: every command is fork-and-exit and there is no resident process, optional or otherwise. Do not use telemetry presence as integration health.

## Engineering rules

- KISS is a release gate, not a preference. Start with the simplest complete design that satisfies current user stories. Caches, deltas, sharding, background coordination, configurable policy, and other stateful machinery require a present contractual need or measured threshold; hypothetical future scale is not evidence. Prefer bounding data and separating history from current state before adding synchronization protocols.
- Define type and error boundaries before implementation.
- Preserve user-owned config and unrelated dirty-worktree changes.
- Config migrations are narrow, backup-first, idempotent, and covered by fixtures.
- Every new CLI surface tests success, error exit code, stderr, and idempotency.
- Shared skills use roles and native delegation language, never a hardcoded client tool name.
- Subagents share a workspace unless the client explicitly guarantees otherwise. Parallel writers must have disjoint file ownership or dedicated worktrees; otherwise sequence them. Shared-workspace subagents never mutate repo-level git state (no `checkout`/`switch`/`reset`/`stash`/`rebase`) — **only the orchestrator moves HEAD**; work needing repo-level mutation gets an isolated worktree arranged by the orchestrator (client-provided worktrees or explicit `git worktree add` plumbing) or gets sequenced. `git worktree add/remove/prune` on snapshot/lane paths is orchestrator-side plumbing and permitted. Genie task claims own shared-workspace scope; the orchestrator arranges worktree isolation.
- Reviewer and engineer are different roles. Never accept self-review as independent evidence.
- Codex agents inherit the active model; do not hardcode unstable model identifiers.
- Workspace trust remains an explicit user decision. Genie installs no lifecycle hooks into any runtime.
- The shared-workspace git-state freeze is operator policy carried in briefs and in this file, enforced by nothing client-side; that half of [#2705](https://github.com/automagik-dev/genie/issues/2705) stands. Merging is now guarded, but only as a guardrail: since 2026-09-17 `.claude/hooks/git-safety.sh` refuses the ordinary spellings of an API merge or protected-ref move and of a push aimed at `main`/`master`, and since 2026-09-19 it refuses `gh pr merge` by the PR's BASE rather than by the verb: the guard reads the base from the remote and refuses a merge into a protected branch — the operator's space-separated `GIT_SAFETY_PROTECTED_BRANCHES`, default `main master` — so an agent that reaches for a promotion is stopped and reports merge-ready, while a merge into `dev` that the operator asked for goes through. Only a top-level `gh [-R owner/repo] pr merge <number|url|branch>` whose every word the guard can decompose is judged that way, and the base is asked for from the directory the command will run in (the hook payload's `cwd`) or from the `--repo` it names; a merge inside a wrapper, one with no selector, a quoted or computed selector, a `#` (bash would drop the rest as a comment), a flag spelling the parser does not know (`-R=x`, `-Rx`, a short cluster such as `-db`), a `cd`/`GH_REPO` beside it, or a base that could not be read is refused. The hook decides what a merge may TARGET, never whether to merge: that stays the operator's call, and the wish workflow still stops at merge-ready. It matches text, so it is not a boundary: an alias, a token list handed to another interpreter, or a name split across quotes gets past it. The enforcement remains what it was — server-side protection on `main`, and the repository's own pre-push hook, which receives the refs a push updates rather than parsing a command line and refuses `main`/`master` for every `git push` spelling, once `bun install` has materialised it. The hook's most load-bearing rules are therefore the ones that keep those git hooks alive (`--no-verify`, `HUSKY=`, `core.hooksPath`). Two exceptions to the delegation, both verified: `git send-pack` is refused outright, because it pushes without the pre-push hook ever seeing the refs, and a direct write to `.git/config` is refused because that is where `core.hooksPath` lives. Ordinary pushes to `dev` are deliberately not guarded. One known asymmetry in the guard: a forbidden form quoted inside a message, body or title is prose and passes, but the same text inside a `sed` or `perl` script argument is judged, because a script argument is a program the tool runs, not prose — so rewriting these very sentences through a shell is refused, and the editor is the path.

### Flip conditions for the shared-workspace contract

The two-mode contract plus git-state freeze is the current answer, not a permanent one. Any of the following flips it (council 2026-07-27, adapting PR #2594):

(i) the isolation guard's ergonomics tolerate real engineering command patterns (compound commands, cwd-relative git) — the one remaining gap; probe 2026-07-27 confirmed the raw capability exists, placement is already gitignored, and shared task-state access is by-design (`genie-db.ts` common-dir resolution) → flip to isolation-by-default for parallel writers, confirming task claim/done in the pilot;
(ii) recorded corruption between disjoint-scope writers with no git-state mutation → the freeze is the wrong abstraction; go full isolation + native-placement engineering;
(iii) first orphaned-lane or wrong-order merge incident → land the full integration-worktree protocol from PR #2594;
(iv) 3+ file-scope collision incidents → the disjoint-scope mode dies.

Open investigations feeding these conditions: [#2706](https://github.com/automagik-dev/genie/issues/2706) pilots native `isolation: "worktree"` on one real `/work` group and closes (i)'s remaining gap; [#2705](https://github.com/automagik-dev/genie/issues/2705) asks whether the freeze can be enforced mechanically at dispatch — a recorded infeasibility there is itself evidence toward (i).

## Code style

Biome enforces single quotes, two-space indentation, 120-column lines, and trailing commas. Use conventional commits. A cognitive-complexity score above 25 requires architectural review; do not extract meaningless helpers only to game the score.

## Skills channel and release gotchas

The full incident narratives are path-scoped for Claude Code in `.claude/rules/*.md` (loaded when a matching file is read); the always-on floor and the rules index live in CLAUDE.md `## Gotchas`. For every other runtime they are plain in-repo files — read the one that names the path you are about to touch. The invariants that bind every runtime:

- The one skills channel: `genie install` / `genie update` run the pinned skills.sh CLI over the local delivered tree, never a GitHub ref, and retire what a release drops BEFORE the install pass, backup-first (`.claude/rules/skills-installer.md`).
- `skills-install.json` is the one record and `genie uninstall`'s removal authority; an unreadable record fails closed, and a vanished recorded agent dir is kept in the record, never dropped.
- Pre-record genie leftovers are proven by retired skill descriptions (`legacy-skills-catalog.ts`), never by name alone. `~/.agents/skills` is also the DSH body's skill source, so no DSH-side skills provider is ever added (`.claude/rules/dsh-skills-source.md`).
- A `state-backups/` root is an archive: nothing genie writes there is removed by a later run.
- `genie update` verifies a public release from its signed delivery evidence with NO GitHub credential (`gh attestation verify` is advisory only); a dev release that failed after its tag was pushed is republished only by the next merge to dev; post-delivery convergence is an argv-only handoff (`update --post-delivery-converge`), never an environment variable (`.claude/rules/release-pipeline.md`).

## Release contract

Release tarballs contain the binary, the `plugins/dsh-genie-board` and `plugins/dsh-workflow-loader` DSH payloads, an empty `plugins/genie/` compat directory, `skills/`, `templates/`, and `VERSION`. Staging stamps the immutable candidate into `VERSION`, every plugin package, and the DSH package compatibility floor; the DSH Host bundle is built with the same candidate. Source/linked Host builds use the checkout root version. Stable is the default channel; dev requires explicit selection. Build and verify every supported release tarball before promotion.

## Runtime-specific notes

- Claude invokes Genie skills as slash commands and may load the `CLAUDE.md` overlay.
- Codex invokes `$skill` or natural language and discovers skills from the shared global skills home (`~/.agents/skills`) that the skills channel writes. Genie ships no Codex plugin and no hooks, so there is no plugin manifest to discover and no hook-review step.
- `/level-up` stays Claude-only because it evaluates Claude Code mastery.
