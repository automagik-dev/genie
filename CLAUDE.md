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
bun test src/lib/v5/task-state.test.ts  # Single file
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

**Never bump the pointer before the docs PR merges.** `git submodule update --remote .docs-vendor` moves `.docs-vendor` to the docs **default branch**, so a bump taken while the docs change is still on a feature branch either picks up an unrelated `main` or — if you stage the submodule while it sits on your own branch — records a commit that `main` does not contain, and every fresh clone then fails `git submodule update --init` with `reference is not a tree`. A genie PR that depends on unmerged docs states the exact bump commands in its body and leaves the pointer alone; `git status` showing `.docs-vendor` as modified is expected in that window and is not staged.

**Stable is declared for Linux and macOS.** `.github/workflows/ci.yml` runs a `unit-darwin` leg on `macos-latest` as a required check alongside the linux one, so a change that breaks either platform does not ship. Windows is not a target; do not add a platform literal to a test without checking it against both legs.

## Architecture

```
src/genie.ts                    CLI entry point (commander)
src/lib/                        Core modules (install/update lifecycle, paths, config)
src/lib/codex-config.ts         Backup-first removal of the obsolete Genie loopback OTel exporter
src/lib/genie-home.ts           GENIE_HOME resolution and the per-agent home paths built on it
src/lib/v5/                     v5 state engine — SQLite, zero-daemon ("lightweight body")
  genie-db.ts                   Per-repo .genie/genie.db open/init (worktree-aware, WAL)
  sqlite-open.ts                Shared bun:sqlite open primitive (WAL, busy_timeout, typed errors)
  task-state.ts                 Task / dependency / ready-set state machine
  base-state.ts                 Integration-branch resolution + recorded wish-base state (context verb)
  TAXONOMY.md                   The docs-in-git / state-in-SQLite contract
src/lib/skills-installer.ts     The skills.sh channel — pinned CLI, local delivered source, install record
src/term-commands/              CLI command handlers (board, context, init, mikro, orca, shortcuts, task, ...)
src/term-commands/orca.ts       `genie orca` — a one-release retirement stub (notice on stderr, exit 2)
src/term-commands/mikro.ts      `genie mikro call|bench|coach|fixtures|init` — registration over scripts/mikro/*, imported in place
scripts/mikro/                  The mikro microagent runtime (call/bench/coach/facts/boundary); NOT relocated under src/
skills/                         Skill prompt files (brainstorm, wish, work, review, etc.)
.genie/                         Per-repo state: git-tracked wishes/INDEX.md/brainstorms/*/DESIGN.md; brainstorm notes + genie.db gitignored
```

## CLI Commands

Sixteen top-level commands (run `genie <command> --help` for detail):

| Command | Purpose |
|---------|---------|
| `board` | Kanban view derived by query (no stored view state); `--board`, `--wish`, `--json` |
| `idea <text...>` | Capture an idea into the roadmap board Idea lane (creates the board if absent) |
| `doctor` | Diagnostic checks on the genie installation; `--fix-global-db` is the one repair verb it owns (backs up `<GENIE_HOME>/genie.db`, drops only the per-repo tables that do not belong in it, leaves everything else in the file byte-for-byte) |
| `init` | Scaffold per-repo state and retire proven Genie-owned project MCP registrations: the marker-owned `.codex/config.toml` route, and in `.mcp.json` only a `genie` server whose command is a genie binary with args exactly `["mcp"]` (backed up first; every other server and key preserved byte-for-byte; a symlinked file is skipped) |
| `install` | Post-install finisher — authenticated delivery, v4 cleanup (`--skip-v4-cleanup`), and non-Codex convergence |
| `config` | Read the resolved global config: `config get <dotted.key>` prints one schema key's value (`budgets.maxEscalationsPerGroup` is the per-group repair budget the shipped `fix` skill reads); `--json` adds `{key, value, source}` |
| `context` | Resolve spawn context: wish/group branch + base SHA, or the integration branch (versioned JSON); `--plan` previews |
| `mikro` | The mikro microagent runtime, on PATH — `mikro call <agent>` hands its tail to `scripts/mikro/call.ts` as typed (genie's global options excepted); `init`, `fixtures --from-commits`, `bench` and `coach` are the per-repository growth loop |
| `setup` | Configure Genie. `--orchestration-mode` is a hidden one-release retirement stub: `standalone` exits 0 and `orca` exits 2, each with a notice that Orca mode is retired and a stale `orchestration.mode` key in `config.json` is harmless |
| `orca` | Retired with the Orca integration: a visible one-release stub that accepts any arguments (`genie orca mirror …` included), prints a retirement notice on stderr, writes nothing and exits 2. Removed in the next release |
| `shortcuts` | Manage tmux keyboard shortcuts |
| `task` | Task state (SQLite, zero-daemon) |
| `uninstall` | Remove the Genie CLI and the recorded skills-channel install (plus the pre-record genie skill dirs `legacy-skills.ts` proves are genie's). It no longer removes plugin-era host assets — the marker-owned retirement module was deleted in v6, so `~/.claude/plugins/`, `~/.codex/agents/genie-*.toml` and the rest are the operator's to remove (README: *Removing plugin-era leftovers by hand*) |
| `update` | Update Genie CLI to the latest GitHub Release |
| `wish` | Wish-document verbs for any repository — `wish lint [--dir <repo>]` runs the structural lint over `<repo>/.genie/wishes` (0 clean / 1 findings), writes nothing, and never trips the workspace gate |
| `help` | `genie help [command]` |

### Task subcommands

```bash
genie task create --title 'x' [--agent <name> --why <reason>]  # Create a task; --agent/--why declare routing (pair required)
genie task list                       # List tasks (with filters)
genie task checkout <id> --worker w   # Atomically claim a ready task for a worker
genie task move <id> --to <lane>      # Move a card to a lane defined by its board (--to, never --lane)
genie task heartbeat <id>             # Record a liveness heartbeat for a claimed card (takes NO --worker)
genie task status <id>                # Task detail, dependencies, stage log (shows the declared assignment)
genie task set-wish <id> --wish w     # Attach/re-point wish identity on an existing card (--clear removes)
genie task assign <id> --agent <name> --why <reason>  # Declare/reassign which roster agent works a card (--clear removes)
genie task adopt <id> --board <ref> --lane <name>  # One-time placement of a laneless (pre-board) card onto a board lane
genie task report <id> --worker <name> -- '<text>'  # Engineer's one handoff message per claim (outcome; what/where; validation)
genie task comment <id> --worker <name> -- '<text>' # Orchestrator gate pointer (review verdict, done, blocked); bounded to 4000 bytes, no control chars
genie task delete <id>                # Hard-delete a card (refused while other cards depend on it)
genie task done <id>                  # Orchestrator only: mark reviewed work done + recompute ready set
genie task export                     # Emit the complete DB state as JSON
genie task export --write             # Write .genie/roadmap.json (diverged-sync resolution: keep local board)
genie task import [--replace]         # Restore genie.db from .genie/roadmap.json (resolution: take snapshot)
genie task sync                       # Three-way reconcile genie.db <-> roadmap.json (run by git hooks on pull/commit); when both sides moved but only card timelines differ, events are unioned by identity and republished (`merged`) — the card conversation is global state
```

`--agent` names a roster agent (`claude|codex|pi|hermes|prime`) and requires `--why`;
`--why` alone is rejected too. Assignment is declaration-only (no checkout gate)
and serializes on the lane path only — non-lane/laneless readers do not see it,
by design.

### Mikro subcommands

```bash
genie mikro call <agent> --prompt '<text>' [--dir repo] [--agents-dir dir] [--agents-ref ref] [--facts auto] [--boundary none|bwrap] [--raw]
genie mikro init [--dir repo]                        # seed the shipped wish-context + review-prep into a repository
genie mikro fixtures --from-commits <range> --agent <wish-context|review-prep> [--dir repo] [--out path] [--max n] [--force]
genie mikro bench <agent> [--dir repo] [--fixtures path] [--agents-dir dir] [--reps n] [--only a,b] [--tag round=N] [--write-evidence]
genie mikro coach <agent> [--dir repo] [--reps 2] [--null-control] [--band file.json] [--proposal file.json]
```

`call` declares no options of its own: the tail after the agent name reaches
`runCallCli` in `scripts/mikro/call.ts` as typed, so a flag added to the runtime
needs no second edit in `src/term-commands/mikro.ts`. ONE exception — genie's own
global options (`-V`/`--version`, `-h`/`--help`, `--no-interactive`) are consumed
by the program wherever they appear, so `mikro call wish-context --prompt -V`
prints the version and runs nothing, and a trailing `--help` prints Commander's
help; shell quoting does not change the argv token, so prefix the value with a
space (`--prompt " -V"`) or use `--prompt-file`. `enablePositionalOptions()` sits on
the `mikro` group, never on the program, because the program-wide form would
change how every other command parses. Exit codes: 0 ok; 1 not ok, which also
covers `mikro call` with NO agent (Commander's missing-argument path through
genie's global error handler); 2 for the runtime's own usage refusals — an
unregistered agent NAME (the registry in `schemas.ts` owns the name and the
answer schema), a registered one with no prompt, a bad `--boundary`. The group is
exempt from the v4 workspace gate.

`bench`, `coach`, `fixtures` and `init` follow the same registration shape over
`runBenchCli` / `runCoachCli` / `runFixturesCli` / `runInitCli`, so each verb and its
`bun scripts/mikro/<file>.ts` spelling are one code path. They add one exit code to the
vocabulary: **2 is a refusal that cost nothing** — a fixture set or an agent that is not
on disk, a range that could be an option, an existing fixture file without `--force`.
`scripts/mikro/README.md` §"Growing agents in another repository" is the operator
sequence, and `genie mikro init` prints it, because an installed host has no README.

## State File Locations (SQLite + git-tracked docs)

| State | Location | Scope | Format |
|-------|----------|-------|--------|
| Task / board / wish state | `<repo>/.genie/genie.db` | Per-repo, shared across worktrees | SQLite (bun:sqlite) |
| Wishes / reviewed designs / INDEX | `<repo>/.genie/{wishes,brainstorms/*/DESIGN.md,INDEX.md}` | Per-repo, git-tracked (other brainstorm notes are gitignored, machine-local) | Markdown |
| Board snapshot (CANONICAL roadmap) | `<repo>/.genie/roadmap.json` | Per-repo, git-tracked | JSON — genie.db materializes from it via three-way `task sync` (git hooks: post-merge/post-rewrite/pre-commit; baseline in gitignored `.genie/roadmap-sync`; excludes machine-local `hire_roster`) |

Worktrees share the main repo's `.genie/genie.db` via `git rev-parse --git-common-dir`. There is exactly ONE database — the per-repo one — and it uses WAL; the machine-scope `~/.genie/genie.db` left with the Omni runner and v6 writes nothing to that path (see the one-`genie.db` gotcha). Documents live in git; operational state lives in SQLite.

## Environment Variables

| Var | Effect |
|-----|--------|
| `GENIE_HOME` | Relocates ALL global state from `~/.genie` (`config.json`, `skills-install.json`, `state-backups/`, `templates/`, `worktrees/`) |
| `GENIE_AGENT_NAME` | Worker identity for task claims and stage-log entries (`resolveWorkerIdentity`; the default for `task checkout --worker`) |
| `GENIE_AGENT_ID` | Fallback worker identity when `GENIE_AGENT_NAME` is unset; both floor at `cli` |
| `GENIE_WORKTREES_DIR` | Override the worktrees base the doctor launch-residue check and review snapshots use (default `<GENIE_HOME>/worktrees`) |

## Build

Single-file bundle: `bun build src/genie.ts --outdir dist --target bun --minify-syntax --minify-whitespace --external bun` inlines all six runtime deps (`commander`, `@inquirer/prompts`, `zod`, `@sigstore/bundle`, `@sigstore/protobuf-specs`, `@sigstore/verify`) into `dist/genie.js` (~2MB). Only the `bun` builtin is external. The shebang `#!/usr/bin/env bun` makes it executable; `chmod +x` is applied after build.

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

Two delivery paths (issue #2967): this floor is injected into every session and every subagent; the subsystem deep-dives live in path-scoped `.claude/rules/*.md` that Claude Code loads only when it reads a file matching the rule's `paths:` glob — a grep-only or plan-without-read session loads none of them, which is exactly why the rules below stay below.

Placement criterion (enforced by `src/__tests__/claude-rules-drift.test.ts`): a gotcha moves into `.claude/rules/<topic>.md` only when (a) its subject is derivable from a path glob covering the code it constrains, and (b) an owner decision has scoped it out of the floor — #2967 moved the skills-installer and release families. A gotcha with no derivable glob, a must-never-forget incident rule that must survive a grep-only session, and anything not yet scoped stays in this floor. Non-Claude runtimes get the load-bearing invariants in AGENTS.md (`## Skills channel and release gotchas`) and read the rules files as plain files.

Rules index — every `.claude/rules/*.md` file and its `paths:` globs, one bullet each:

- `.claude/rules/skills-installer.md` (paths: `src/lib/skills-installer*.ts`, `src/lib/skills-agents*.ts`, `src/lib/legacy-skills*.ts`, `scripts/legacy-skills-catalog*.ts`) — the one skills channel: pinned CLI over the local delivered tree, pre-spawn retirement, legacy leftovers proven by description, collision snapshots, detected agents, the one install record.
- `.claude/rules/workflows-channel.md` (paths: `src/lib/workflows-installer*.ts`, `.claude/workflows/**`, `scripts/workflow-front-door-parity*.ts`, `skills/**`) — the `.claude/workflows` delivery: one optional field on the same record, backup-first replacement, invocation by explicit script path.
- `.claude/rules/dsh-skills-source.md` (paths: `plugins/dsh-genie-board/**`) — `~/.agents/skills` is the DSH body's skill source; never add a `ctx.skills` provider for genie's library.
- `.claude/rules/release-pipeline.md` (paths: `src/genie-commands/update*.ts`, `src/lib/delivery-evidence-verify*.ts`, `.github/workflows/version.yml`, `.github/workflows/release.yml`, `.github/workflows/release-publish.yml`, `.github/workflows/sign-attest.yml`) — offline-first release verification, the orphaned dev tag, argv-only post-delivery convergence.

- **The product MCP server, the UI bridge, and BOTH their retirement stubs are gone** — v5 kept `genie mcp` and `genie ui-bridge` as stubs that wrote a stable diagnostic to stderr and exited 1; v6 removed the verbs themselves, so neither parses any more and Commander answers `unknown command`. A retired verb that still parses is a promise, and a major is the one release allowed to break it. What stays is the HOST-STATE observation, which was never about the verb: `genie init` still retires proven Genie-owned historical routes (in `.mcp.json` only the dead `genie mcp` entry — a genie binary with args exactly `["mcp"]` — backing the file up first and preserving every other server byte-for-byte; plus the marker-owned `.codex/config.toml` route), and `genie doctor` still warns while such an entry is present — `src/lib/codex-project-mcp.ts` is live code, not a fossil. No plugin ships an MCP declaration or launcher, and the bridge's private transport (`mcp-server.ts`), tool registry (`mcp-tools.ts`), and change watcher (`bridge-watcher.ts`) were deleted earlier.
- **Genie has one lifecycle authority — its own board — and Orca mode is retired** — `orchestration.mode` left the config schema, which is a non-strict `z.object`, so an old config holding `{"orchestration":{"mode":"orca"}}` (or any garbage value) still parses whole, keeps every other key, and drops the stale one on the next config write; `src/lib/genie-config.test.ts` and the stale-mode blocks in the `v5-task`, `v5-board` and `context` tests pin that `task create`, `task sync`, `board` and `context` work under it. Nothing gates a lifecycle verb on configuration any more: no preAction refusal in `src/genie.ts`, no `task sync` / `context --plan` carve-outs, no guard in `openDb` or the roadmap writers. `genie setup --orchestration-mode` survives one release as a hidden stub (`standalone` exit 0, `orca` exit 2, both printing the retirement notice on stderr and writing nothing) and is removed in the release after; do not grow it back into a switch.
- **The Orca integration is retired, but the payload keeps an EMPTY `plugins/genie/`** — the plugin, the adapter, the card mirror and their publishing are deleted, and the source tree carries no `plugins/genie`. `scripts/build-binary.sh` still recreates `${STAGE}/plugins/genie` empty beside the `.agents`/`.claude-plugin` compat members: every earlier binary's update path requires that physical directory (`scanPhysicalTree`) and the top-level member set is frozen at the 8 `INSTALL_PAYLOAD_MEMBERS`, so dropping it breaks `genie update` on every older host. `genie orca` stays one release as a visible stub (any arguments, notice on stderr, exit 2, nothing written), which is why `'orca'` stays in `WORKSPACE_EXEMPT` and the top-level count stays sixteen; remove the stub, its exemption and its row together.
- **One `genie.db`, and a machine-scope path that must stay empty** — v6 writes exactly one database, the per-repo `.genie/genie.db` (`genie-db.ts`, task/board/wish). The machine-scope `~/.genie/genie.db` held the Omni approval queue and inbox and left with the runner; `global-db.ts` is deleted and `resolveGlobalDbPath` moved to `src/lib/genie-home.ts` beside every other `GENIE_HOME` path. The per-repo opener still REFUSES that path (`GlobalDbPathError`) because an older host still carries the file and both stamped `user_version = 1`, and `genie doctor --fix-global-db` is the one repair for a host contaminated before the refusal landed.
- **Codex integration health is native state, not OTel** — the old Genie exporter at `127.0.0.1:14318` has no relay and is removed by `migrateDeadGenieOtel` in `src/lib/codex-config.ts`: an exact-match, backup-first migration on the `genie update` path. It was deliberately kept out of the plugin-era `legacy-integration-retirement.ts` (deleted in v6, its compat window closed) and is unaffected by that module's removal. Preserve unrelated OTel settings and `disable_paste_burst`.
- **Genie is zero-daemon, with no optional daemon either** — the Omni runner (`genie omni serve`) was the last one and was removed in v6 along with its NATS transport, its approval queue, its config section, its `OMNI_*` env vars and its skill. Every command is fork-and-exit; no resident processes. The legacy-retirement paths that clean omni-era host assets (`config.json.bak-pre-omni` in `legacy-v4.ts`, the omni skill's descriptions in `legacy-skills-catalog.ts`) stay, because that is how an old host gets cleaned.
- **`genie mikro call` is the mikro runtime IMPORTED IN PLACE, and it never resolves an agent through `import.meta.url`** — `src/term-commands/mikro.ts` imports `scripts/mikro/call.ts`; the files are NOT relocated under `src/`, because under the `src/**` Biome rules they score 29/55/33 against a ratcheted `maxScore: 42` and a move is a decomposition project, not a delivery step (`scripts/**` has the complexity rule off, `tsc` follows the import, knip reports only `src/**`). The `import.meta.main` block is an exported `runCallCli(argv): Promise<number>` and the guard calls it, so a bundled or compiled binary runs no foreign entry block (`src/term-commands/mikro.test.ts` proves it against the built bundle) and the module carries no top-level `await`. Agent files resolve `--agents-dir` → the INVOKING checkout's `.mikro/agents/<agent>/` **at the trusted ref** (git toplevel of cwd, never `--dir`, which is the tree under review, and never that checkout's working tree either) → `<GENIE_HOME>/templates/mikro/agents`; the old `import.meta.url`-relative default cannot work inside a compiled binary, where it resolves under `/$bunfs` and holds no agent at all. The answer names the winner in `agentSource` (`flag`, `repo@<ref>`, `shipped`) and the why in `agentSourceReason`. The trusted ref is `--agents-ref` or the base branch `origin/HEAD` names, taken as the LOCAL branch when `origin/<base>` is an ancestor of it; the agent is materialized with `git archive` into a 0700 temp dir that is proven byte-equal to `git show <ref>:<path>` and disposed on every exit path, and without the flag every file the mikro runtime loads from `--dir` is compared against that ref for EVERY `--dir` — the invoking checkout included, exemption removed — so an uncommitted edit to one of them refuses the run and names `--agents-dir` as the escape (`scripts/mikro/trusted-source.ts`). The compared list is ONE constant MIRRORING mikro's own `loadConfig` (1.260909.1, `~/.mikro/mikro/src/config.ts:814-857`) — `.mikro/{mikro.yaml,TOOLS.md,SYSTEM.md,CRITERIA.md}` **and the pre-rename `.rlmx/{rlmx.yaml,TOOLS.md,SYSTEM.md,CRITERIA.md}`, which is the branch that fires on every repository without a `.mikro/mikro.yaml`** (`VALIDATE.md` is excluded because a microagent's own one overrides it unconditionally at `mcp/server.ts:585`); re-derive it whenever the mikro version floor moves. A compared path that is not a regular file (a directory or a symlink under one of those names) is refused without being read. When the invoking checkout is a git repository that resolves NO trusted ref — no `origin/HEAD`, a stale one after a branch rename, or an `--agents-ref` naming no commit — the configuration fails CLOSED: the agent degrades to the shipped default (genie's own payload), but any compared file present in `--dir` refuses the run at zero cost naming all three remedies. Only Decision 8's non-git carve-out still falls back to the directory comparison, and that carve-out must be PROVEN: `probeCheckout` is three-valued (`toplevel` / `not-a-repository` / `unanswered`), and only git's own clean "not a git repository" WITH no `.git` entry found walking up from the cwd reaches it. A git that could not answer — a `safe.directory` refusal (exit 128 under Docker/CI/sudo/a shared checkout), an unreadable index, a `.git` FILE whose gitlink points nowhere, or no `git` on PATH — is treated as in-repo with no trusted ref and fails closed; collapsing those into "no checkout" handed a real checkout's own PR configuration the same-directory exemption. `bench` and `coach` deliberately take that escape and measure the working tree, so they may only be pointed at a tree the operator trusts. The tail after the agent name reaches the runtime AS TYPED, with exactly one exception: genie's own global options (`-V`/`--version`, `-h`/`--help`, `--no-interactive`) are consumed by the program wherever they appear, so `mikro call wish-context --prompt -V` prints the version and runs nothing — `enablePositionalOptions()` is on the `mikro` GROUP and shields the tail from the group's options, not from the program's, and putting it on the program would change how every other command parses. `mikro call` with NO agent exits 1 (Commander's missing-argument path through genie's global error handler); 2 is the runtime's own usage refusal. The trusted root is the invoking checkout for every source that is not the flag — never `<GENIE_HOME>/templates` — and with the flag it stays two levels above the agents dir, which is the operator's authoring path. `MIKRO_AGENTS_DIR` is only WRITTEN into the child environment, never read as an input. The run ledger goes to `<root>/.mikro/runs` only when the repository tracks a `.mikro/` directory (or is no git checkout at all); otherwise to `<GENIE_HOME>/mikro/runs/<basename>-<sha256(root)[:8]>`, so a repository that never opted into mikro grows no untracked files. A `mikro` missing from PATH is classified by the spawn error's CODE (`ENOENT`/`EACCES`), never by its wording — Node says `spawn mikro ENOENT`, Bun says `Executable not found in $PATH` — and answers one `unavailable:` error with `ok: false` and exit 1, with no second attempt. The two default agents ship INSIDE `templates/` (`scripts/build-binary.sh` stages `.mikro/agents/{wish-context,review-prep}/{agent.yaml,SYSTEM.md}` into `${STAGE}/templates/mikro/agents/`): the tarball's top-level member set is frozen at the 8 `INSTALL_PAYLOAD_MEMBERS`, and `templates/` already converges to `<GENIE_HOME>/templates` on both install and update, executed by old and new binaries alike. There is deliberately no second tracked copy of those files in the repository.
- **Another repository grows its own agents with the installed genie alone — `init` seeds, `fixtures` derives truth from COMMITS, `bench`/`coach` measure the WORKING TREE** — the motivating case commits straight to its base branch and has no PRs to derive fixtures from. `genie mikro init [--dir <repo>]` copies the shipped `wish-context` and `review-prep` into `<repo>/.mikro/agents/` (`seedAgents`, `scripts/mikro/init.ts`), adds `.mikro/runs/` to `.gitignore` once, writes nothing outside `<repo>`, REFUSES an agent directory that already exists rather than overwriting a specialized prompt, and refuses a symlinked `.mikro`/`agents` rather than following it out of the tree. It then prints the sequence — commit, push, fixtures, bench, coach — plus the host prerequisites genie does not ship (`mikro` >= 1.260909.1 on PATH, a `deepseek-api` provider with `deepseek-flash` in `~/.mikro/settings.json`, `DEEPSEEK_API_KEY`), because an installed host has no README; whether the PUSH is needed is PROBED with `resolveTrustedRef` for that repository rather than asserted, since Decision 8's local-base rule makes a committed-but-unpushed agent the trusted one exactly when `origin/<base>` is an ancestor of the local `<base>`. `mikro-coach` ships (`SHIPPED_AGENTS` in `scripts/build-binary.sh` is the two workers PLUS the coach) but is never SEEDED: it is the tool a coaching round runs, so it must resolve from the shipped set on a host whose repository never carried it — `scripts/release-docs.test.ts` pins the shipped list against `SEEDED_AGENTS`. `genie mikro fixtures --from-commits <range> --agent <wish-context|review-prep>` is mechanical and re-runnable by hand: files = `git show --name-only` (a rename contributes the NEW path), prompt = `Intent: <subject>` or the parent comparison, id = the first 12 characters of the sha (never `--short`, whose length follows `core.abbrev`), merge commits / root commits for review-prep / empty commits / any commit naming a path HEAD no longer carries SKIPPED with the reason — the verifier scores the TREE, not the commit — and the output byte-stable across runs of the same argv so a rebuild is a real diff. Fixtures resolve `--fixtures` -> `<dir>/.mikro/fixtures/<agent>.json` -> `<dir>/scripts/mikro/fixtures/<agent>.json` (Decision 12; the last is genie's own legacy location and genie has no `.mikro/fixtures`, so its rounds are unchanged), and `bench`/`coach` FAIL UPFRONT at zero cost when the resolved fixture set or `<agent>/agent.yaml` is not on disk, naming `genie mikro init` / `genie mikro fixtures --from-commits` instead of handing `runAgent` a path that holds nothing. A coaching round in another repository has no `scripts/mikro/bench.ts` to spawn: `benchCommand` resolves that local file first, then a sibling of `Bun.main`, then the bundled entry, then the compiled binary's own `mikro bench`. An EMBEDDED `Bun.main` (`/$bunfs/root/...`, `B:\~BUN\...` on Windows) is recognized by its PATH and never by `existsSync`, which answers TRUE for it inside the running binary: the fixture that said otherwise made the round hand `genie /$bunfs/root/genie mikro bench` to another process, which exits 1 on `unknown command` and leaves no bench record to find. A compiled probe binary is the proof, and one test compiles it. An agent with no `EVIDENCE.md` (a freshly seeded one) is not a crash: the coach prompt says the file does not exist and asks for `null`, because a cited path the tree lacks fails the citation gate. The no-flag bench RECORD is still byte-identical to every round before any of this.
- **`bun run dead-code`** (knip) has pre-existing false positives for biome/commitlint/husky devDeps — not regressions.
- **`genie doctor` prints ONE `mode drift` line, never one per drifted entry** — `checkWorktreeModes` (`src/genie-commands/doctor-modes.ts`) returns a single aggregated result naming at most five entries in the fixed order `refused → mixed → wider → stricter` plus a `+<n> more` remainder, and the full list rides `--json` under `checks[].modeDrift.entries`. The per-entry `describeEntry` form printed ~10k lines over an uncapped worktree scan on the dogfood host, which is how a real `refused` row — a probe error or a planted symlink, the one disposition `--fix` will never touch — became indistinguishable from noise. The ordering is the point: `refused` and `mixed` are unfixable and escalate the headline to warn, `wider` is what `--fix` tightens, and `stricter` alone stays an informational pass, so naming five in that order always surfaces the rows an operator must decide about first — EXCEPT the one stricter sub-case that carries a manual remedy, a 755-indexed file that lost its `+x` bit, which is named FIRST inside the `stricter` bucket and rides `--json` with its own `suggestion` (`chmod 755 <path>`); restoring an executable bit is a WIDENING, so it is the operator's decision and `--fix` will never take it.
- **`budgets.maxEscalationsPerGroup` is the repair budget, read from the config and never restated in prose** — the fix skill resolves it with `genie config get budgets.maxEscalationsPerGroup` rather than naming the constant, so the skill and `<GENIE_HOME>/config.json` cannot drift. Every `budgets.*` key is a conservative default with a schema `.max()` ceiling (escalations 5, Fable calls 10): configuration may only TIGHTEN a gate, and a hand-edited value past the ceiling fails the whole parse, so `loadGenieConfig` returns defaults and `genie config get` reports `source: default` — never the out-of-range number. `genie doctor` echoes the resolved value as one read-only `budgets: maxEscalationsPerGroup=<n> (<default|file>)` line and never writes a config file.
- **Wish state is persisted by the orchestrator, never the reviewer** — reviewer verdicts are SHIP/FIX-FIRST/BLOCKED evidence; durable WISH statuses are `DRAFT`, `FIX-FIRST`, `APPROVED`, `IN_PROGRESS`, `BLOCKED`, `SHIPPED`, and `SUPERSEDED` (a terminal record of work that shipped, or was approved, and was later removed or replaced — it names what replaced it). SessionStart, `genie`, and resume routing consume that vocabulary. A chat verdict does not advance state until the invoking orchestrator appends review evidence and updates WISH.md.
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
