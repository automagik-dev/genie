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
- `src/lib/v5/` owns SQLite state. Per-repo `.genie/genie.db` stores task state; global `~/.genie/genie.db` stores Omni state. Never mix their path/schema modules.
- `src/hooks/` owns provider-neutral lifecycle policy plus Claude/Codex wire adapters.
- `src/term-commands/` owns `init`, `context`, MCP, Omni, task, and board commands.
- `plugins/genie/` is one shared plugin payload with sibling Claude and Codex manifests.
- `skills/` is shared runtime-neutral workflow guidance. Runtime mapping lives in `plugins/genie/references/native-surfaces.md`.
- `.genie/` contains git-tracked wishes/brainstorms/index plus gitignored operational SQLite files.

Genie v5 is zero-daemon except for the explicitly launched `genie omni serve` bridge. Do not use telemetry presence as integration health.

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
- Hook trust and workspace trust remain explicit user decisions.

### Flip conditions for the shared-workspace contract

The two-mode contract plus git-state freeze is the current answer, not a permanent one. Any of the following flips it (council 2026-07-27, adapting PR #2594):

(i) the isolation guard's ergonomics tolerate real engineering command patterns (compound commands, cwd-relative git) — the one remaining gap; probe 2026-07-27 confirmed the raw capability exists, placement is already gitignored, and shared task-state access is by-design (`genie-db.ts` common-dir resolution) → flip to isolation-by-default for parallel writers, confirming task claim/done in the pilot;
(ii) recorded corruption between disjoint-scope writers with no git-state mutation → the freeze is the wrong abstraction; go full isolation + native-placement engineering;
(iii) first orphaned-lane or wrong-order merge incident → land the full integration-worktree protocol from PR #2594;
(iv) 3+ file-scope collision incidents → the disjoint-scope mode dies.

Open investigations feeding these conditions: [#2706](https://github.com/automagik-dev/genie/issues/2706) pilots native `isolation: "worktree"` on one real `/work` group and closes (i)'s remaining gap; [#2705](https://github.com/automagik-dev/genie/issues/2705) asks whether the freeze can be enforced mechanically at dispatch — a recorded infeasibility there is itself evidence toward (i).

## Code style

Biome enforces single quotes, two-space indentation, 120-column lines, and trailing commas. Use conventional commits. A cognitive-complexity score above 25 requires architectural review; do not extract meaningless helpers only to game the score.

## Release contract

Release tarballs contain the binary, shared plugin, both plugin manifests, both marketplaces, skills, templates, and `VERSION`. Plugin and marketplace versions must match `package.json`. Stable is the default channel; dev requires explicit selection. Build and verify every supported release tarball before promotion.

## Runtime-specific notes

- Claude invokes Genie skills as slash commands and may load the `CLAUDE.md` overlay.
- Codex invokes `$skill` or natural language, discovers `.codex-plugin/plugin.json`, and requires explicit `/hooks` review plus a new task after hook changes.
- `/level-up` stays Claude-only because it evaluates Claude Code mastery.
