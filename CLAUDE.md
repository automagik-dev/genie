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
src/genie.ts                    CLI entry point (commander)
src/lib/                        Core modules (state, registry, locking, messaging, providers)
src/lib/transcript.ts           Provider-agnostic transcript abstraction (Claude + Codex)
src/lib/codex-logs.ts           Codex JSONL parsing + SQLite discovery
src/lib/claude-logs.ts          Claude log parsing + transcript adapter
src/term-commands/              CLI command handlers
  agent/                        genie agent — spawn, stop, resume, kill, list, show, log, send, answer, register, directory, inbox, brief
  task/                         genie task — extends core CRUD with status, reset, board, project, releases, type
  team/                         genie team — create, hire, fire, list, disband
  exec/                         genie exec — list, show, terminate (debug)
src/hooks/                      Git hook system (branch-guard, auto-spawn, identity-inject)
src/genie-commands/             Setup/utility commands (setup, doctor, update, session)
src/types/                      Shared types (genie-config Zod schema)
skills/                         Skill prompt files (brainstorm, wish, work, review, etc.)
```

## CLI Namespaces

Top-level aliases (`genie spawn`, `genie kill`, etc.) are shortcuts for the `genie agent` namespace. Both forms work identically.

### Agent Commands
```bash
# Top-level aliases (shortcuts)
genie spawn <name>                    # Alias for: genie agent spawn <name>
genie kill <name>                     # Alias for: genie agent kill <name>
genie stop <name>                     # Alias for: genie agent stop <name>
genie resume [name]                   # Alias for: genie agent resume [name]
genie ls                              # Alias for: genie agent list
genie log [agent]                     # Alias for: genie agent log [agent]
genie read <name>                     # Read terminal output from agent pane
genie history <name>                  # Show compressed session history
genie answer <name> <choice>          # Alias for: genie agent answer <name> <choice>

# Full namespace commands
genie agent spawn <name>              # Spawn agent (resolves from directory or built-ins)
genie agent list                      # List agents with runtime status
genie agent log <name>                # Unified log (default)
genie agent log <name> --raw          # Pane capture
genie agent log <name> --transcript   # Compressed transcript
genie agent send '<msg>' --to <name>  # Direct message (hierarchy-enforced)
genie agent send '<msg>' --broadcast  # Team broadcast
genie agent inbox                     # View inbox
genie agent brief --team <name>       # Cold-start summary
genie agent answer <name> <choice>    # Answer prompt
genie agent show <name>               # Agent + executor detail
genie agent stop/kill/resume <name>   # Lifecycle management
genie agent register <name>           # Register agent locally + Omni
genie agent directory [name]          # List/show directory entries
```

### Task Commands
```bash
genie task create --title 'x'         # Create task
genie task list                       # List tasks
genie task status <slug>              # Wish group status
genie task done <ref>                 # Mark group done
genie task board/project/releases/type  # Planning hierarchy
```

### Team Commands
```bash
genie team create/hire/fire/list/disband  # Team lifecycle
```

### Other
```bash
genie exec list/show/terminate           # Executor debug
genie run <spec>                         # Wish/spec runner (top-level)
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
- macOS RAM-disk (opt-in): `GENIE_TEST_MAC_RAM=1 bun test` mounts a 1 GiB
  hdiutil-backed volume at `/Volumes/genie-test-ram` and points pgserve at
  `/Volumes/genie-test-ram/pgserve`. Matches Linux `/dev/shm` throughput for
  the pgserve test harness. Unset = ephemeral temp dir (no change). The volume
  is detached on daemon reap; a manual `hdiutil detach /Volumes/genie-test-ram`
  is safe — the next run recreates it.

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

## Engineering Discipline

- Type boundaries first — input shapes, output shapes, error variants. Implementation follows naturally.
- APIs before implementations — the surface is the contract, the code is the detail.
- Plugin architecture is not optional; every capability is a pluggable unit with a defined interface.
- Test alongside implementation, not after — tests are a spec, not a safety net.
- If something is hard to test, the abstraction is wrong.
- DX is first-class — the framework must be obvious to a new contributor in under 30 minutes.
- Keep PRs focused on a single abstraction change; mixed concerns belong in separate branches.
- Deprecate loudly, remove decisively — never let dead code haunt the codebase.
- Elegance means fewer moving parts, not fewer lines.

## QA Discipline

- Assume code is broken until a failing test proves it can be fixed, and a passing test proves it stays fixed.
- Edge cases are the real interface — test the boundaries of every command, flag, and plugin contract.
- CLI correctness includes exit codes, stderr output, and error message format — not just happy-path stdout.
- Plugin contracts are sacred — any deviation between declaration and consumption is a defect, not a difference.
- Watch it fail for the right reason before marking it pass.
- Build a failure inventory first: what are the ten most likely ways this could break?
- Regression log: if something broke once, a test permanently owns that scenario.
- Test CLI commands as a user would invoke them, not just as unit tests exercise them.
- Report blockers immediately — a workaround is a hidden defect.

## Release Discipline

- Shipping cadence is a promise — missed releases erode trust faster than bugs do.
- DX friction is a product bug, not a support ticket. Top-5 DX issues tracked at all times.
- Scope freeze 3 days before release — no scope additions in the final window.
- Breaking changes require a deprecation story before landing.
- Every contributor PR makes an advocate — celebrate contributions specifically, not generically.
- Triage incoming issues within 24 hours: label, assign, prioritize.
- Sprint summary is one page: shipped, blocked, next.
