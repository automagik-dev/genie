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
src/lib/                        Core modules (install/update lifecycle, paths, config, Omni, Orca adapter)
src/lib/codex-config.ts         Backup-first removal of the obsolete Genie loopback OTel exporter
src/lib/genie-home.ts           GENIE_HOME resolution and the per-agent home paths built on it
src/lib/orca-orchestration-adapter.ts  The closed public `orca orchestration ... --json` boundary
src/lib/v5/                     v5 state engine — SQLite, zero-daemon ("lightweight body")
  genie-db.ts                   Per-repo .genie/genie.db open/init (worktree-aware, WAL)
  global-db.ts                  Global ~/.genie/genie.db — omni approval queue + inbox
  sqlite-open.ts                Shared bun:sqlite open primitive (WAL, busy_timeout, typed errors)
  task-state.ts                 Task / dependency / ready-set state machine
  omni-queue.ts                 Approval-queue + inbox persistence for the Omni runner
  base-state.ts                 Integration-branch resolution + recorded wish-base state (context verb)
  TAXONOMY.md                   The docs-in-git / state-in-SQLite contract
src/lib/skills-installer.ts     The skills.sh channel — pinned CLI, local delivered source, install record
src/lib/legacy-integration-retirement.ts  Marker-owned, backup-first retirement of plugin-era host assets
src/term-commands/              CLI command handlers (board, context, init, omni, shortcuts, task, ...)
skills/                         Skill prompt files (brainstorm, wish, work, review, etc.)
.genie/                         Per-repo state: git-tracked wishes/brainstorms/INDEX.md + genie.db (gitignored)
```

## CLI Commands

Fifteen top-level commands (run `genie <command> --help` for detail):

| Command | Purpose |
|---------|---------|
| `board` | Kanban view derived by query (no stored view state); `--board`, `--wish`, `--json` |
| `idea <text...>` | Capture an idea into the roadmap board Idea lane (creates the board if absent) |
| `doctor` | Diagnostic checks on the genie installation |
| `init` | Scaffold per-repo state and retire proven Genie-owned project MCP registrations: the marker-owned `.codex/config.toml` route, and in `.mcp.json` only a `genie` server whose command is a genie binary with args exactly `["mcp"]` (backed up first; every other server and key preserved byte-for-byte; a symlinked file is skipped) |
| `install` | Post-install finisher — authenticated delivery, v4 cleanup (`--skip-v4-cleanup`), and non-Codex convergence |
| `context` | Resolve spawn context: wish/group branch + base SHA, or the integration branch (versioned JSON); `--plan` previews |
| `mcp` | Retired — prints the stable non-zero MCP-retirement diagnostic (use `genie task` / `genie board`) |
| `omni` | Omni integration — `serve`, `status`, `inbox`, `handshake` |
| `setup` | Configure Genie; `setup --orchestration-mode <standalone\|orca>` selects the lifecycle authority |
| `shortcuts` | Manage tmux keyboard shortcuts |
| `task` | Task state (SQLite, zero-daemon) |
| `ui-bridge` | Retired — prints the stable non-zero UI-bridge-retirement diagnostic (the Orca integration is the supported UI surface) |
| `uninstall` | Remove the Genie CLI, the recorded skills-channel install, and plugin-era leftovers the legacy collectors prove are Genie-owned |
| `update` | Update Genie CLI to the latest GitHub Release |
| `help` | `genie help [command]` |

### Task subcommands

```bash
genie task create --title 'x' [--agent <name> --why <reason>]  # Create a task; --agent/--why declare routing (pair required)
genie task list                       # List tasks (with filters)
genie task checkout <id> --worker w   # Atomically claim a ready task for a worker
genie task status <id>                # Task detail, dependencies, stage log (shows the declared assignment)
genie task set-wish <id> --wish w     # Attach/re-point wish identity on an existing card (--clear removes)
genie task assign <id> --agent <name> --why <reason>  # Declare/reassign which roster agent works a card (--clear removes)
genie task delete <id>                # Hard-delete a card (refused while other cards depend on it)
genie task done <id>                  # Orchestrator only: mark reviewed work done + recompute ready set
genie task export                     # Emit the complete DB state as JSON
genie task export --write             # Write .genie/roadmap.json (diverged-sync resolution: keep local board)
genie task import [--replace]         # Restore genie.db from .genie/roadmap.json (resolution: take snapshot)
genie task sync                       # Three-way reconcile genie.db <-> roadmap.json (run by git hooks on pull/commit)
```

`--agent` names a roster agent (`claude|codex|pi|hermes|prime`) and requires `--why`;
`--why` alone is rejected too. Assignment is declaration-only (no checkout gate)
and serializes on the lane path only — non-lane/laneless readers do not see it,
by design.

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
| Board snapshot (CANONICAL roadmap) | `<repo>/.genie/roadmap.json` | Per-repo, git-tracked | JSON — genie.db materializes from it via three-way `task sync` (git hooks: post-merge/post-rewrite/pre-commit; baseline in gitignored `.genie/roadmap-sync`; excludes machine-local `hire_roster`) |

Worktrees share the main repo's `.genie/genie.db` via `git rev-parse --git-common-dir`. The two `genie.db` files are wholly separate databases: different paths, different schemas, independent `PRAGMA user_version` — `global-db.ts` deliberately imports NONE of `genie-db.ts`'s path constants; the only shared code is the open primitive in `sqlite-open.ts`. Both use WAL. Documents live in git; operational state lives in SQLite.

## Environment Variables

| Var | Effect |
|-----|--------|
| `GENIE_HOME` | Relocates ALL global state from `~/.genie` (the global `genie.db` and `worktrees/`) |
| `GENIE_AGENT_NAME` | Worker identity for task claims and stage-log entries (`resolveWorkerIdentity`; the default for `task checkout --worker`) |
| `GENIE_AGENT_ID` | Fallback worker identity when `GENIE_AGENT_NAME` is unset; both floor at `cli` |
| `GENIE_TEAM` | Default team when `--team` not provided |
| `GENIE_WORKTREES_DIR` | Override the worktrees base the doctor launch-residue check and review snapshots use (default `<GENIE_HOME>/worktrees`) |
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

- **skills.sh is the one skills channel** — `genie install` / `genie update` run the pinned CLI over the **local delivered tree**, never a GitHub ref: `npx -y skills@1.5.23 add <GENIE_HOME>/skills --all --copy -g` (`buildSkillsAddArgv`, `src/lib/skills-installer.ts`). There is **no** `automagik-dev/genie@v<ver>` argument — `skills@1.5.23` ignores an `@<ref>` suffix and always serves the repository's default branch, so the signed tarball's own `$GENIE_HOME/skills/` is the only genuinely pinned source — and **no second `-y` after `--copy`**: `--all` already expands to `--skill '*' --agent '*' -y` inside the CLI, and the one `-y` is npx's. The public, binary-free path is `npx skills add automagik-dev/genie`, which tracks the repository's default branch and is therefore not pinned to any release. After a zero exit genie writes `$GENIE_HOME/skills-install.json`: `{ref, source?, cliVersion, inventory[], agentDirs[], dirDigests?, collisions?, installedAt}`. `ref` is the running binary's release tag, `source` is `local:<absolute skills root>`, and `agentDirs` is a **bounded post-install `$HOME` discovery scan unioned with the `KNOWN_AGENT_SKILL_HOMES` floor** — never that four-row table alone, which recorded 4 homes where the CLI had written 57 on the dogfood host. `source`, `dirDigests` and `collisions` are optional on purpose: a required new field would invalidate every record 5.260830.x wrote and silently turn `genie uninstall` into a no-op. `genie doctor` is a read-only observer that never repairs, not even under `--fix`: it compares the record's `inventory` and `ref` against disk **per `KNOWN_AGENT_SKILL_HOMES` entry** — `skills: <agent> <present>/<total> @ <ref>`, `not detected` for an absent home, `(stale, binary is <tag>)` when the record's ref no longer matches this binary, `(unrecorded)` with no record at all. The recorded `agentDirs` is `genie uninstall`'s removal authority, not doctor's comparison set.
- **`--all` writes every supported home, and `~/.agents/skills` IS the Codex home** — the accepted consent widening: any `--integrations` selection other than `none` installs to every detected agent, because skills.sh already installs per-agent. `KNOWN_AGENT_SKILL_HOMES` is `claude`, `agents`, `goose`, `windsurf`; `.codex/skills` and `.cursor/skills` are deliberately absent because skills.sh 1.5.23 never creates either, and listing `.codex/skills` made doctor report a permanent false `skills: codex 0/n` on every Codex host.
- **Integration consent `none` skips the skills channel entirely** — `runSkillsChannelConvergence` emits `skills: skipped (consent: none)`, writes no record, and retires nothing on that host. A failed install is never fatal either: the remedy command is printed, `process.exitCode` is set to 1, and the already-promoted binary is never rolled back, so the run stays committed and retryable.
- **The legacy-integration retirement is marker-owned, backup-first and one-shot** — `src/lib/legacy-integration-retirement.ts` classifies every plugin-era asset a host still carries as `managed-clean`, `managed-modified`, `unmanaged` or `absent`, removes **only** `managed-clean`, copies each removed object under `<GENIE_HOME>/state-backups/integration-retirement-<timestamp>/` first, and is idempotent by construction (a retired surface classifies `absent`), which is what lets `genie update` run it unconditionally. The documented compat window is assets written by releases `>= 5.260711.6`; older hosts follow the documented manual steps. The module is deleted two stable releases after the `skills-everywhere-b` wish ships.
- **The product MCP server and its launchers are retired** — `genie mcp` is a stub that writes a stable diagnostic to stderr and exits 1; no plugin ships an MCP declaration or launcher, and `genie init` only retires proven Genie-owned historical routes (in `.mcp.json` it retires only the dead `genie mcp` entry — a genie binary with args exactly `["mcp"]` — backing the file up first and preserving every other server byte-for-byte; `genie doctor` warns while that entry is still present). The UI-owned `genie ui-bridge` is retired too — there is no Genie UI any more, the Orca integration is the only UI surface — so it is the same shape of stub (stable stderr diagnostic, exit 1), and its private transport (`mcp-server.ts`), tool registry (`mcp-tools.ts`), and change watcher (`bridge-watcher.ts`) are deleted.
- **The Orca plugin ships as a tree-only subtree ref, never from the repo root** — Orca installs a plugin from a git URL+ref (or a local folder) whose ROOT holds `orca-plugin.json`, and its loader rejects any tree containing a symlink ("unsafe file path or symlink") and caps an install at 2000 files / 50 MB. The genie root can therefore never be the install tree (`docs -> .docs-vendor/genie`; ~14k files in a dev checkout), and a re-rooted root `orca-plugin.json` does NOT fix that — do not reintroduce one, and do not add it to `scripts/version.ts`, the `version.yml` JSON_FILES list (still three version files — `package.json`, `plugins/genie/package.json`, `plugins/genie/orca-plugin.json`; read them without bumping via `bun scripts/version.ts --check`), or `release-guard.sh`. `plugins/genie` alone is symlink-free, ~132 files, ~1.3 MB, and holds the manifest at its root, so `.github/workflows/orca-plugin-ref.yml` force-pushes `git commit-tree HEAD:plugins/genie` (a parentless, history-free commit) to `refs/heads/orca-plugin` from main and `refs/heads/orca-plugin-dev` from dev, skipping when the tree hash already matches. Those refs are never merged back. The only repo-root Orca file is `orca-marketplace.json` — a source-only, versionless index pointing `automagik.genie` at ref `orca-plugin`, copied into no tarball. `scripts/orca-manifest-parity.test.ts` is the drift guard and also asserts `plugins/genie` stays symlink-free and inside the file cap. `genie setup --orchestration-mode orca` selects authority only; it never registers the plugin with Orca.
- **Lifecycle authority is an explicit mode, never inferred** — `standalone` is the default (including when `orchestration.mode` is absent); installing or opening Orca changes nothing. `genie setup --orchestration-mode orca` probes the shipped plugin payload and a compatible Orca runtime before atomically switching, after which Genie refuses local `genie.db` lifecycle reads/writes and roadmap writes/syncs/exports. Switching back with `--orchestration-mode standalone` imports no Orca state. There is no fallback database in either direction.
- **Two `genie.db` files, never cross-import** — per-repo `.genie/genie.db` (`genie-db.ts`, task/board/wish) and global `~/.genie/genie.db` (`global-db.ts`, omni queue + inbox) are independent databases with their own schemas and `user_version`. `global-db.ts` shares only `sqlite-open.ts` with the per-repo one — do not reach across for path constants.
- **Codex integration health is native state, not OTel** — the old Genie exporter at `127.0.0.1:14318` has no relay and is removed by `migrateDeadGenieOtel` in `src/lib/codex-config.ts`: an exact-match, backup-first migration that runs on the same `genie update` path as `legacy-integration-retirement.ts` and is deliberately out of that module's scope. Preserve unrelated OTel settings and `disable_paste_burst`.
- **The Omni runner (`genie omni serve`) is the only optional daemon** — a foreground NATS bridge that drains the global approval queue. Everything else is fork-and-exit; no resident processes.
- **`bun run dead-code`** (knip) has pre-existing false positives for biome/commitlint/husky devDeps — not regressions.
- **Post-delivery convergence is an argv-only handoff, never an environment-only re-exec** — the 2026-07-11 downgrade incident proved that an old target can ignore an environment-only sync contract and perform a second full update. Today `genie update` invokes the freshly installed binary as `update --post-delivery-converge`: an explicit argv protocol that pre-contract binaries reject at commander parse time, with the mode resolved before any mutation and the lifecycle lease borrowed under an exact-owner record (the parent stays the sole lease owner). Never replace this with an environment-variable-only convergence signal. The post-convergence half of the old two-hop upgrade is gone: the freshly installed binary converges the skills channel itself, so there is no second activation command to run afterwards.
- **Wish state is persisted by the orchestrator, never the reviewer** — reviewer verdicts are SHIP/FIX-FIRST/BLOCKED evidence; durable WISH statuses are `DRAFT`, `FIX-FIRST`, `APPROVED`, `IN_PROGRESS`, `BLOCKED`, and `SHIPPED`. SessionStart, `genie`, `dream`, and resume routing consume that vocabulary. A chat verdict does not advance state until the invoking orchestrator appends review evidence and updates WISH.md.
- **`tasks.wish` is a lifecycle slug, valid from brainstorm-dir creation — the roadmap board is the one tracker** — `tasks.wish` is no longer "the WISH.md slug post-pour"; it is the single stable slug a card carries from `.genie/brainstorms/<slug>/` creation onward, threading Idea → Brainstorm → Wish → Work → Review → Done (a card can hold a slug while still in an early lane; the slug is identity, not proof a wish exists). Hand-written `.genie/INDEX.md` prose stays authored by humans, but the `jar: index-lane drift` doctor check lint-checks it against placement truth: for each INDEX entry it takes the first `brainstorms/<slug>/` or `wishes/<slug>/` link, joins the roadmap card `WHERE tasks.wish = slug`, and verifies the card's lane against the section (Raw→Idea, Simmering→Brainstorm, Ready→Brainstorm/Wish, Poured→Wish/Work/Review/Done). It is warning-level and never flips doctor `ok:false`; linkless/cardless/laneless entries report `unlinked` (never `drift`), a link whose target is missing on disk — or resolves outside `.genie/`, which is rejected without a stat so `../` traversal is never a path-existence oracle — reports `broken` (decided before the lane comparison, so it outranks `drift`; `#anchor` suffixes are stripped and a bare `wishes/<slug>/` link resolves against the directory), and the per-entry states ride `--json` under `checks[].indexLane.entries`. The check line warns when `drift > 0` **or** `broken > 0`; human output names every `broken` entry and at most five `unlinked` ones, then counts the remainder. `evaluateIndexLaneDrift` stays pure — the caller injects both `laneForSlug` and the target-existence resolver.

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
