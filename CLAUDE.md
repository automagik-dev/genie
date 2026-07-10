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

## Docs

`docs/` is a symlink to `.docs-vendor/genie/` where `.docs-vendor` is a git submodule of `automagik-dev/docs` (Mintlify, public site at automagik.dev). Engineers see and edit `docs/` as if it were a regular subfolder of the genie repo — the submodule machinery is mostly invisible.

- **Operator-facing pages** (e.g., `docs/installation.mdx`, `docs/security/key-rotation.mdx`, `docs/incident-response/canisterworm.mdx`) appear on the public Mintlify site at `automagik.dev/genie/...`.
- **Engineering-internal pages** live under `docs/_internal/` (architecture deep-dives, observability internals, agent-frontmatter contracts, CLI reference dumps, spawn-flow runbooks, detector specs). These are excluded from the public Mintlify build via `**/_internal/` in `automagik-dev/docs/.mintignore` — visible inside the genie repo, hidden from public docs.

**Workflow when editing docs:**

```bash
# Make changes (the symlink follows into .docs-vendor/genie/)
$EDITOR docs/installation.mdx

# Commit + push the docs change to automagik-dev/docs
cd .docs-vendor
git checkout -b feat/<topic>
git add genie/installation.mdx
git commit -m "docs(genie): ..."
git push -u origin feat/<topic>
gh pr create --base main

# After the docs PR merges, bump the genie superproject pointer
cd ..   # back to genie repo root
git submodule update --remote .docs-vendor
git add .docs-vendor
git commit -m "chore: bump .docs-vendor to docs main"
```

CI in `automagik-dev/genie` runs `actions/checkout@v4` with `submodules: recursive` for any workflow that needs docs content (`docs-lint.yml`, `runbook-test.yml`); the rest of CI ignores the submodule.

## Architecture

```
src/genie.ts                    CLI entry point (commander)
src/lib/                        Core modules (transcript, codex/claude logs, paths, config)
src/lib/transcript.ts           Provider-agnostic transcript abstraction (Claude + Codex)
src/lib/codex-logs.ts           Codex JSONL parsing + SQLite discovery
src/lib/codex-config.ts         Codex config.toml + OTel relay wiring (state detection)
src/lib/claude-logs.ts          Claude log parsing + transcript adapter
src/lib/v5/                     v5 state engine — SQLite, zero-daemon ("lightweight body")
  genie-db.ts                   Per-repo .genie/genie.db open/init (worktree-aware, WAL)
  global-db.ts                  Global ~/.genie/genie.db — omni approval queue + inbox
  sqlite-open.ts                Shared bun:sqlite open primitive (WAL, busy_timeout, typed errors)
  task-state.ts                 Task / dependency / ready-set state machine
  omni-queue.ts                 Approval-queue + inbox persistence for the Omni runner
  warp-launch.ts                Warp cockpit planner — one worktree per ready group
  TAXONOMY.md                   The docs-in-git / state-in-SQLite contract
src/hooks/                      In-process Claude Code hook dispatch (fail-closed)
  index.ts                      Handler chain + fail-closed envelope (buildFailClosedResponse)
  dispatch-command.ts           CLI entry: genie hook dispatch
  handlers/                     branch-guard, freshness, identity-inject, omni-approval, orchestration-guard, audit-context
src/term-commands/              CLI command handlers (board, init, launch, omni, shortcuts, task, ...)
skills/                         Skill prompt files (brainstorm, wish, work, review, etc.)
.genie/                         Per-repo state: git-tracked wishes/brainstorms/INDEX.md + genie.db (gitignored)
```

## CLI Commands

Fourteen top-level commands (run `genie <command> --help` for detail):

| Command | Purpose |
|---------|---------|
| `board` | Kanban view derived by query (no stored view state); `--board`, `--wish`, `--json` |
| `doctor` | Diagnostic checks on the genie installation |
| `hook` | Hook middleware for Claude Code (`genie hook dispatch` runs in-process) |
| `init` | Scaffold per-repo state — `.genie/INDEX.md` + `.gitignore` rules (idempotent) |
| `install` | Post-install finisher — v4 legacy cleanup (`--skip-v4-cleanup`) |
| `launch <slug>` | Open a Warp cockpit for a wish: one pane per ready group, each in its own worktree |
| `mcp` | Read-only stdio MCP server exposing genie.db task/board state |
| `omni` | Omni integration — `serve`, `status`, `inbox`, `handshake` |
| `setup` | Configure genie settings |
| `shortcuts` | Manage tmux keyboard shortcuts |
| `task` | Task state (SQLite, zero-daemon) |
| `uninstall` | Remove Genie CLI and clean up hooks |
| `update` | Update Genie CLI to the latest GitHub Release |
| `help` | `genie help [command]` |

### Task subcommands
```bash
genie task create --title 'x'         # Create a task
genie task list                       # List tasks (with filters)
genie task checkout <id> --worker w   # Atomically claim a ready task for a worker
genie task status <id>                # Task detail, dependencies, stage log
genie task done <id>                  # Mark done + recompute the ready set
genie task export                     # Emit the complete DB state as JSON
```

### Omni subcommands
```bash
genie omni handshake                  # Register this host with the omni server (ed25519, idempotent)
genie omni serve                      # Resident runner: NATS bridge → approval queue (foreground)
genie omni status                     # Approval-queue counts + config sanity (no network)
genie omni inbox                      # List stored inbound Omni messages (no network)
```

## State File Locations (SQLite + git-tracked docs)

| State | Location | Scope | Format |
|-------|----------|-------|--------|
| Task / board / wish state | `<repo>/.genie/genie.db` | Per-repo, shared across worktrees | SQLite (bun:sqlite) |
| Omni approvals + inbox | `~/.genie/genie.db` | Global (machine-wide) | SQLite (bun:sqlite) |
| Wishes / brainstorms / INDEX | `<repo>/.genie/{wishes,brainstorms,INDEX.md}` | Per-repo, git-tracked | Markdown |

Worktrees share the main repo's `.genie/genie.db` via `git rev-parse --git-common-dir`. The two `genie.db` files are wholly separate databases: different paths, different schemas, independent `PRAGMA user_version` — `global-db.ts` deliberately imports NONE of `genie-db.ts`'s path constants; the only shared code is the open primitive in `sqlite-open.ts`. Both use WAL. Documents live in git; operational state lives in SQLite.

## Environment Variables

| Var | Effect |
|-----|--------|
| `GENIE_HOME` | Relocates ALL global state from `~/.genie` (the global `genie.db` and `worktrees/`) |
| `GENIE_AGENT_NAME` | Agent identity for hook dispatch |
| `GENIE_AGENT_ID` | Agent id used by hook identity injection |
| `GENIE_TEAM` | Default team when `--team` not provided |
| `GENIE_WORKTREES_DIR` | Override where `launch` creates per-group worktrees (default `<GENIE_HOME>/worktrees`) |
| `GENIE_CONFIG_FILE` | Override the resolved genie config path |
| `OMNI_*` | Omni runner config — `OMNI_APPROVALS_ENABLED`, `OMNI_API_URL`, `OMNI_API_KEY`, `OMNI_NATS_URL`, `OMNI_APPROVAL_CHAT`, `OMNI_INSTANCE`, `OMNI_APPROVE_TOKENS`/`OMNI_DENY_TOKENS` |

## Build

Single-file bundle: `bun build src/genie.ts --outdir dist --target bun --minify-syntax --minify-whitespace --external bun` inlines all four runtime deps (`commander`, `@inquirer/prompts`, `nats`, `zod`) into `dist/genie.js` (~1.3MB). Only the `bun` builtin is external. The shebang `#!/usr/bin/env bun` makes it executable; `chmod +x` is applied after build.

## Testing

- Framework: `bun:test` (import from `'bun:test'`)
- Pattern: colocated `*.test.ts` next to source
- Fixtures: tmpdir with cleanup in afterEach
- Git tests: real git repos in `/tmp`, not mocks
- Concurrency tests: `Promise.allSettled()` pattern
- Isolation: set `process.env.GENIE_HOME` to tmpdir to isolate global state (both `genie.db` files resolve under it)
- SQLite tests: `sqlite-open.ts` uses WAL + `busy_timeout`, so concurrent-writer tests surface clean claim-conflicts, not `SQLITE_BUSY` flake

## Code Style

- Biome: single quotes, 2-space indent, 120 line width, trailing commas
- Conventional commits (commitlint)
- No `console.log` in source (biome rule, relaxed in tests)

## Cognitive-complexity budget

Biome's `noExcessiveCognitiveComplexity` is set to `maxAllowedComplexity: 25` (warn-level) for `src/**` and `packages/**`. Treat 25 as a ceiling for **linear** workflows, not a target.

- Prefer linear code when a function reads as one workflow (CLI command body, orchestration step, request handler). Helpers extracted purely to reduce a score under 25 usually add indirection without clarity.
- Split when there is a real boundary: a distinct policy decision, an IO concern, a state-machine transition, a presentation/data divide, or reused logic with at least two callers.
- Only suppress with `biome-ignore lint/complexity/noExcessiveCognitiveComplexity:` when extraction would obscure a linear flow or break a tested invariant. The comment must explain the reason — never just "complexity".
- Score >25 is review-triggering architecture debt, not a hard error. Track it in `.genie/wishes/complexity-budget-simplification/hotspots.md` and address via a separate refactor wish, not opportunistic edits.
- Drift is enforced by `bun run lint:complexity-budget` (script in `scripts/complexity-budget.ts`). Raising any of the budget ceilings requires updating the script with a written justification.

## Gotchas

- **Hook dispatch is in-process, fail-closed, and bounded by Claude Code's per-hook `timeout`** — each hook event is a short-lived `genie hook dispatch` fork that runs the handler chain in-process and exits (no daemon, no socket, no DB). There is no genie-managed dispatch timeout; the ceiling is the `timeout` field on the hook's entry in Claude Code's `settings.json` (CC default if unset). A dispatch that can't parse its payload or throws emits a NON-empty deny/block envelope instead of empty stdout, because CC reads empty PreToolUse stdout as allow-by-default — see `buildFailClosedResponse` in `src/hooks/index.ts`. The fail-closed default is locked by `src/hooks/__tests__/dispatch-fail-closed-regression.test.ts`, which drives the shipped `dist/genie.js`.
- **`AskUserQuestion` is the one PreToolUse carve-out** — it is in `NON_INTERCEPTABLE_PRE_TOOL_USE_TOOLS` and MUST get an EMPTY response, not the neutral `{ decision: 'block' }` block form. Empirically CC consumes any additionalContext as the synthesized answer, so a fail-closed block would corrupt the inline picker. The fail-closed envelope special-cases this tool.
- **Two `genie.db` files, never cross-import** — per-repo `.genie/genie.db` (`genie-db.ts`, task/board/wish) and global `~/.genie/genie.db` (`global-db.ts`, omni queue + inbox) are independent databases with their own schemas and `user_version`. `global-db.ts` shares only `sqlite-open.ts` with the per-repo one — do not reach across for path constants.
- **Codex OTel relay is real v5, not the deleted receiver** — `src/lib/codex-config.ts` wires Codex's `config.toml` to a fixed OTel relay on `127.0.0.1:14318` (`OTEL_RELAY_PORT`) for state detection. This is live; only the v4 receiver-probing env vars are gone. Do not blanket-purge "OTel" from docs — this relay is load-bearing.
- **The Omni runner (`genie omni serve`) is the only optional daemon** — a foreground NATS bridge that drains the global approval queue. Everything else is fork-and-exit; no resident processes.
- **`bun run dead-code`** (knip) has pre-existing false positives for biome/commitlint/husky devDeps — not regressions.
- **agent-sync converges every detected coding agent** — `genie update` and `genie install` fan the canonical source `~/.genie/plugins/genie` into every DETECTED agent (Claude Code skills + `~/.claude/workflows/council.js`; Codex `~/.codex/skills/.curated/`; the Hermes `~/.hermes/plugins/genie` symlink) via `src/lib/agent-sync.ts`. There is NO new command or flag — the internal env `GENIE_UPDATE_SYNC_ONLY=1` is the ONLY re-entry contract (the post-swap exec and the SessionStart-hook trigger both set it). Managed skill dirs carry `.genie-sync.json` (`managedBy: genie-agent-sync`); every replacement or removal is backed up first under `~/.genie/state-backups/`, so `genie doctor`/`genie uninstall` only ever touch what genie provably shipped.
- **One stamp root, never CLAUDE_PLUGIN_ROOT-primary** — council.js stamping (both the `genie update` CLI and the hook's CLI-less fallback) resolves its `LENS_ROOT` via `resolveStampInputs`, which PREFERS the stable `~/.genie/plugins/genie` root — that path never changes across versions — and only falls back to `CLAUDE_PLUGIN_ROOT` when the stable template is absent. Do not reintroduce CLAUDE_PLUGIN_ROOT-primary stamping: the marketplace root changes on every plugin update, which is what caused the stale-cache downgrade ping-pong the stable root exists to kill.

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
