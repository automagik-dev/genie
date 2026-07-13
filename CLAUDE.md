# Genie CLI

Claude Code overlay: read and follow the canonical shared repository contract in `AGENTS.md` first. This file adds Claude-specific command and operational detail; shared rules belong in `AGENTS.md`.

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
src/lib/codex-config.ts         Backup-first removal of the obsolete Genie loopback OTel exporter
src/lib/claude-logs.ts          Claude log parsing + transcript adapter
src/lib/v5/                     v5 state engine — SQLite, zero-daemon ("lightweight body")
  genie-db.ts                   Per-repo .genie/genie.db open/init (worktree-aware, WAL)
  global-db.ts                  Global ~/.genie/genie.db — omni approval queue + inbox
  sqlite-open.ts                Shared bun:sqlite open primitive (WAL, busy_timeout, typed errors)
  task-state.ts                 Task / dependency / ready-set state machine
  omni-queue.ts                 Approval-queue + inbox persistence for the Omni runner
  warp-launch.ts                Warp cockpit planner — one worktree per ready group
  TAXONOMY.md                   The docs-in-git / state-in-SQLite contract
src/hooks/                      Provider-neutral Claude/Codex hook dispatch and wire adapters
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
| `init` | Scaffold per-repo state and reconcile `.mcp.json`, `.warp/.mcp.json`, plus marker-owned `.codex/config.toml` fallback when no installed, enabled, usable plugin route is proven |
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
genie task done <id>                  # Orchestrator only: mark reviewed work done + recompute ready set
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
- Score >25 is review-triggering architecture debt, not a hard error. The budget command names every current hotspot; record intentional follow-up work in a dedicated refactor wish rather than opportunistic edits.
- Drift is enforced by `bun run lint:complexity-budget` in `check`, `check:fast`, pre-push, and CI. Raising any budget ceiling requires updating `scripts/complexity-budget.ts` with a written justification.

## Gotchas

- **Codex ships exactly H3/H4/H6, and all remain untrusted after an edit** — H3 is bounded read-only SessionStart context; H4 is deterministic local PreToolUse guarding; H6 is matcher-scoped PermissionRequest approval and is the only retained hook that may write approval-queue state. No Codex lifecycle hook installs, updates, synchronizes, or scaffolds. Run `genie setup --codex` or `genie update` explicitly, inspect changed hashes with `/hooks`, and start a new task. Codex hook commands run outside the model sandbox, so hard controls still belong in sandbox permissions and server-side branch protection.
- **Hook dispatch is provider-aware and fail-closed** — the plugin-local Codex launcher selects only the canonical `$GENIE_HOME/bin/genie`, preserves stdin/stdout/signals, bounds child time/output, validates event-specific JSON, and converts launch/timeout/schema failures into a reasoned deny. Claude dispatch remains a short-lived in-process `genie hook dispatch` fork. Neither path is a daemon.
- **`AskUserQuestion` is the one PreToolUse carve-out** — it is in `NON_INTERCEPTABLE_PRE_TOOL_USE_TOOLS` and MUST get an EMPTY response, not the neutral `{ decision: 'block' }` block form. Empirically CC consumes any additionalContext as the synthesized answer, so a fail-closed block would corrupt the inline picker. The fail-closed envelope special-cases this tool.
- **Two `genie.db` files, never cross-import** — per-repo `.genie/genie.db` (`genie-db.ts`, task/board/wish) and global `~/.genie/genie.db` (`global-db.ts`, omni queue + inbox) are independent databases with their own schemas and `user_version`. `global-db.ts` shares only `sqlite-open.ts` with the per-repo one — do not reach across for path constants.
- **Codex integration health is native state, not OTel** — the old Genie exporter at `127.0.0.1:14318` has no relay and is removed by an exact-match, backup-first migration. Preserve unrelated OTel settings and `disable_paste_burst`.
- **The Omni runner (`genie omni serve`) is the only optional daemon** — a foreground NATS bridge that drains the global approval queue. Everything else is fork-and-exit; no resident processes.
- **`bun run dead-code`** (knip) has pre-existing false positives for biome/commitlint/husky devDeps — not regressions.
- **agent-sync runs only on selected explicit install/update paths, and Codex writes no product fallbacks** — `genie install` and `genie update` converge only the client tiers selected by `--integrations`; `none` mutates no client home. The installed Codex plugin is the sole Genie-managed skill provider: no supported command writes Genie product skills into `~/.agents/skills`. A fresh Codex install seeds zero user-tier skills. An upgrade from a fallback-seeding release retires only provably clean, digest-owned copies into the hidden `~/.agents/skills/.genie-codex-fallback-retirement/` quarantine transaction, and only after one post-convergence plugin health proof; same-name unmanaged, malformed-marker, symlinked, or modified user assets are preserved in place and reported as user-owned collisions. Codex plugin skills are a separate physical 23-skill in-root payload, and the optional seven role-agent TOMLs are staged under `plugins/genie/codex-agents/` for CLI install into `~/.codex/agents/`. Role-agent install is gated by plugin convergence, not by the health proof: on the deliberately-disabled-plugin path, `convergeCodexPluginOnly` installs the TOMLs and returns before `proveCodexPluginHealth` ever runs (R3 — a disabled plugin skips health + retirement and is never enabled), so those TOMLs land with no health proof at all. Only the enabled-plugin path installs role agents after one post-convergence health proof.
- **`.codex/skills/.curated` is a legacy uninstall-only lane, never resurrected in sync** — the retired hidden `.curated` path is no longer written or read by any install/update/setup/sync convergence path. `genie uninstall` still *collects* it (classifier-only removal of a legacy directory a very old Genie may have left behind) so uninstall leaves nothing stale, but Codex sync must never recreate that lane. Do not reintroduce `.curated` cleanup inside codex sync.
- **Do not re-exec a freshly installed older binary for convergence** — the 2026-07-11 downgrade incident proved that an old target can ignore an environment-only sync contract and perform a second full update. Current manual update convergence stays inside the already-reviewed parent process, then refreshes runtime integration state. When crossing from a release older than `5.260711.6` to `5.260711.6` or later, run one explicit second `genie update` after the first command returns; no hook supplies that compatibility hop.
- **Generated SessionStart parity is a release gate** — edit `plugins/genie/scripts/src/session-context.ts`, regenerate with `bun scripts/hook-bundle-parity.ts --write`, and commit the executable `session-context.cjs`. `bun run check`, the plugin build, and tarball build all reject byte or mode drift.
- **Wish state is persisted by the orchestrator, never the reviewer** — reviewer verdicts are SHIP/FIX-FIRST/BLOCKED evidence; durable WISH statuses are `DRAFT`, `FIX-FIRST`, `APPROVED`, `IN_PROGRESS`, `BLOCKED`, and `SHIPPED`. SessionStart, `genie`, `dream`, `wizard`, and resume routing consume that vocabulary. A chat verdict does not advance state until the invoking orchestrator appends review evidence and updates WISH.md.
- **One stamp root, never CLAUDE_PLUGIN_ROOT-primary** — explicit install/update council stamping resolves `LENS_ROOT` from the stable `~/.genie/plugins/genie` root and only falls back to `CLAUDE_PLUGIN_ROOT` when the stable template is absent. No lifecycle hook stamps or synchronizes it. Do not reintroduce marketplace-root-primary stamping: marketplace roots change with plugin versions and can revive stale-cache downgrade behavior.

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
