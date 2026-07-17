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
- `src/term-commands/` owns `init`, `launch`, MCP, Omni, task, and board commands.
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
- Treat each concurrently active execution group as an isolated delivery lane with its own branch and worktree; never
  run parallel writers in one checkout, even when their expected file scopes are disjoint. The PM owns the wish
  integration worktree, merge order, and conflict resolution. After a reviewed group is merged and validated, the PM
  removes its clean worktree and merged branch so active worktrees and branches represent active work.
- Mainline ownership follows repository topology. When `main` has an authoritative GitHub upstream, local `main` is a
  clean fast-forward mirror of that remote's `main`: wishes reach it through reviewed GitHub PRs, never a local feature
  merge. With no configured remotes, the PM may integrate a finished wish through a validated temporary candidate,
  archive that exact integrated closure as `archive/wish/<slug>`, remove its clean active lanes, and then fast-forward
  unchanged local `main` to the archived commit. A non-GitHub or ambiguous remote requires an explicit user-selected
  integration policy.
- Reviewer and engineer are different roles. Never accept self-review as independent evidence.
- Codex agents inherit the active model; do not hardcode unstable model identifiers.
- Hook trust and workspace trust remain explicit user decisions.

## Code style

Biome enforces single quotes, two-space indentation, 120-column lines, and trailing commas. Use conventional commits. A cognitive-complexity score above 25 requires architectural review; do not extract meaningless helpers only to game the score.

## Release contract

Release tarballs contain the binary, shared plugin, both plugin manifests, both marketplaces, skills, templates, and `VERSION`. Plugin and marketplace versions must match `package.json`. Stable is the default channel; dev and homolog require explicit selection. Build and verify every supported release tarball before promotion.

## Runtime-specific notes

- Claude invokes Genie skills as slash commands and may load the `CLAUDE.md` overlay.
- Codex invokes `$skill` or natural language, discovers `.codex-plugin/plugin.json`, and requires explicit `/hooks` review plus a new task after hook changes.
- `/level-up` stays Claude-only because it evaluates Claude Code mastery.
