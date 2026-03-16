# Genie CLI

## Commands

```bash
bun run check        # Full gate: typecheck + lint + dead-code + test
bun run build        # Bundle to dist/genie.js (bun target, minified, single file)
bun run typecheck    # tsc --noEmit
bun run lint         # biome check .
bun run dead-code    # bunx knip (has pre-existing false positives for biome/commitlint/husky)
bun test             # All tests
bun test src/lib/wish-state.test.ts  # Single file
```

## Architecture

```
src/genie.ts              CLI entry point (commander)
src/lib/                  Core modules (state, registry, locking, messaging, providers)
src/term-commands/        CLI command handlers (agents, team, dispatch, msg, state, dir)
src/hooks/                Git hook system (branch-guard, auto-spawn, identity-inject)
src/genie-commands/       Setup/utility commands (setup, doctor, update, session)
src/types/                Shared types (genie-config Zod schema)
skills/                   Skill prompt files (brainstorm, wish, work, review, etc.)
```

## State File Locations (CRITICAL — fragmented across 4 scopes)

| State | Location | Scope | Format |
|-------|----------|-------|--------|
| Wish state | `<repo>/.genie/state/<slug>.json` | Per-repo CWD, shared across worktrees | JSON |
| Worker registry | `~/.genie/workers.json` | Global | JSON |
| Team configs | `~/.genie/teams/<name>.json` | Global | JSON |
| Mailbox | `<repo>/.genie/mailbox/<worker>.json` | Per-repo | JSON |
| Team chat | `<repo>/.genie/chat/<team>.jsonl` | Per-repo worktree | JSONL |
| Session store | `~/.genie/sessions.json` | Global | JSON |
| Native teams | `~/.claude/teams/<team>/` | Global (Claude Code) | JSON |

Worktrees share the main repo's `.genie/` via `git rev-parse --git-common-dir`. Worker registry is global, not per-worktree.

## Environment Variables

| Var | Effect |
|-----|--------|
| `GENIE_HOME` | Relocates ALL global state from `~/.genie` |
| `GENIE_AGENT_NAME` | Agent identity for hook dispatch. MUST be set for auto-spawn to work. |
| `GENIE_TEAM` | Default team when `--team` not provided |
| `CLAUDECODE=1` | Enables Claude Code features (set in team-lead command) |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | Enables native teammate UI |
| `GENIE_IDLE_TIMEOUT_MS` | Auto-suspend idle workers after N ms |

`GENIE_AGENT_NAME` and the 5 native team CLI flags must stay in sync — if any are missing, Claude Code won't recognize the agent as a team member.

## Build

Single-file bundle: `bun build` inlines all dependencies into `dist/genie.js` (~305KB minified). No runtime deps to co-locate. The shebang `#!/usr/bin/env bun` makes it executable. `chmod +x` is applied after build.

## Testing

- Framework: `bun:test` (import from `'bun:test'`)
- Pattern: colocated `*.test.ts` next to source
- Fixtures: tmpdir with cleanup in afterEach
- Git tests: real git repos in `/tmp`, not mocks
- Concurrency tests: `Promise.allSettled()` pattern
- Isolation: set `process.env.GENIE_HOME` to tmpdir to isolate global state

## Code Style

- Biome: single quotes, 2-space indent, 120 line width, trailing commas
- Conventional commits (commitlint)
- No `console.log` in source (biome rule, relaxed in tests)

## Gotchas

- **File lock timeout force-removes are intentional** — prevents permanent deadlocks from crashed processes. The `open('wx')` after unlink is still atomic, so only one process wins.
- **Hook dispatch has a 15s hard timeout** — handlers that take longer silently timeout, blocking the tool use. No retry.
- **tmux is required for agent spawn** — no fallback. `hasBinary()` checks PATH before launch.
- **System prompt injection can fail silently** — `buildTeamLeadCommand()` writes to `~/.genie/prompts/<team>.md`. If write fails, the command still generates but Claude Code dies on startup trying to read the missing file.
- **Mailbox delivery is best-effort** — message is persisted to disk (durable), but tmux pane injection is not retried. Dead pane = message stays `deliveredAt: null` forever.
- **`bun run dead-code`** (knip) has pre-existing false positives for biome/commitlint/husky devDeps — not regressions.

## PR Review Rules

When reviewing comments from automated bots (CodeRabbit, Gemini, Codex):

1. **Read the actual code** before accepting any finding — bots often misread control flow
2. **Check if behavior is pre-existing** — extracted/moved code inherits existing tradeoffs, not new bugs
3. **Trace fallback chains** — bots flag the first code path without checking if later candidates handle the edge case
4. **Distinguish theoretical from practical** — "could happen if X" is not a bug if X never occurs in real usage
5. **Never blindly accept severity ratings** — a bot labeling something CRITICAL doesn't make it critical. Verify actual impact
6. **Check idempotency** — many "collision" or "race" concerns are mitigated by idempotent operations the bot didn't trace
