# Wish: Genie v5 Foundation — genie.db State Engine + Runtime-Independent Skills

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `v5-foundation` |
| **Date** | 2026-07-01 |
| **Author** | Felipe + Genie |
| **Appetite** | ~1.5 weeks |
| **Branch** | `v5` (bootstrapped from `dev` by this wish; groups land as PRs into `v5`) |
| **Design** | [DESIGN.md](../genie-v5-lightweight-body/DESIGN.md) |
| **Umbrella** | genie-v5-lightweight-body — seed Groups 1+2 of 8 (revised for D2: genie.db) |

## Summary

Lay the foundation of Genie v5 "lightweight body": operational state (tasks, dependencies, boards, wish-group state) in a minimal per-repo `bun:sqlite` database (`.genie/genie.db` — no daemon, no Postgres), planning documents in git, and the core skills (brainstorm/wish/work/review) rewritten free of the v4 runtime. Proves the central thesis end-to-end: the full lifecycle runs with no resident processes — dispatch via Claude Code native teams, state via genie.db and git.

## Scope

### IN
- Minimal genie.db schema (~6 tables: tasks, task_dependencies, stage_log, boards, wish_groups, meta) with `PRAGMA user_version` versioning — no migration framework.
- State module under `src/lib/v5/`: task CRUD, dependency/ready-set recompute (Kahn in JS), **atomic checkout claim** (transaction), wish-group state machine (blocked→ready→in_progress→done), worktree-aware DB resolution via `git rev-parse --git-common-dir`.
- Taxonomy spec (`src/lib/v5/TAXONOMY.md`): documents-in-git vs state-in-genie.db split, `.genie/` layout, schema reference, concurrency rules.
- Tiny CLI under the `genie v5` namespace: `genie v5 task create|list|status|done|checkout`, `genie v5 board` (first-class kanban render — daily driver, v4 readability parity), `genie v5 task export` (full state as JSON). Bare `genie task`/`genie board` stay v4-owned until demolition, when `v5` subcommands take over the bare names.
- Rewrite of `skills/brainstorm`, `skills/wish`, `skills/work`, `skills/review` SKILL.md: no v4 runtime commands (`genie agent/spawn/run/wish/dispatch`, bare `genie task`/`genie board`); state operations via `genie v5 task`/`genie v5 board`; `/work` dispatch via Claude Code native teams/subagents.
- Kept-siblings decision: documented keep/drop list for all current skills (list only, no rewrites).
- `v5` added to branch-guard's merge allowlist (with tests) so group PRs can merge into `v5`.
- End-to-end zero-daemon lifecycle validation script + QA report.

### OUT
- Warp launch-config emission and `genie init` (umbrella Group 3).
- Multi-target skill emit for Codex/Hermes (umbrella Group 4).
- Omni runner port and the global `~/.genie/genie.db` queue (umbrella Group 5) — this wish ships only the per-repo state DB.
- Harness demolition and dependency purge (umbrella Group 6); v4 code stays untouched on `v5` branch — v5 modules land additively.
- v4 exporter / exit ramp (umbrella Group 7) and distribution (Group 8).
- Rewrites of non-core skills (dream, pm, council, etc.) — only the kept-siblings *list* is decided here.
- Any push/notify mechanism (v4's pg_notify) — board and status are read-on-demand; reactivity, if ever needed, is a later concern.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Operational state in per-repo `.genie/genie.db` (bun:sqlite, WAL); planning documents stay markdown in git | Design D2 (revised, user-confirmed 2026-07-01): atomic checkout across parallel agent processes wants transactions; v4 gitignored `.genie/state/` anyway so file-state was never git-versioned; bun:sqlite = zero deps, zero daemon |
| 2 | Schema is minimal (~6 tables) and versioned by a single `PRAGMA user_version`; new tables require written justification in review | Prevents drift back toward v4's 54-table sprawl; `task export` JSON keeps data portable if the schema must reset |
| 3 | v5 modules land additively under `src/lib/v5/` + `genie v5` namespace; nothing v4 is deleted in this wish | Keeps PRs focused; demolition is umbrella Group 6 with its own gate; bare command names transfer at demolition |
| 4 | `/work` dispatch at this stage = Claude Code native teams/subagents (Agent tool), not Warp panes | Per design: Warp multi-pane is the Group 3 upgrade, not a foundation dependency |
| 5 | Skills may invoke the daemon-less `genie v5` CLI for state; they must not invoke any v4 runtime command | "Runtime-independent" means no PG/spawn/registry — not CLI-abstinence. Direct sqlite writes from prompts would be fragile; the CLI is the contract. This makes Group 3 depend on Group 2 |
| 6 | Add `v5` to branch-guard's `ALLOWED_MERGE_BASES` (Group 1 deliverable, extending the existing 23-case test suite) so agents can merge group PRs into `v5`; `main` stays human-only | Standing law §19 currently allows agent merges into `dev` only, which would block this wish's own PR flow |
| 7 | Worktree state sharing via `git rev-parse --git-common-dir` resolution of `.genie/genie.db` | Proven v4 mechanism; all worktrees of a repo share one DB with no daemon |

## Success Criteria

- [ ] Full brainstorm→wish→work→review lifecycle completes on a fixture repo with zero resident genie processes and no Postgres/pgserve (asserted by the e2e script; the only DB artifact is `.genie/genie.db`).
- [ ] `skills/{brainstorm,wish,work,review}/SKILL.md` contain no v4 runtime invocations — `genie agent`, `genie spawn`, `genie run`, `genie wish`, `genie dispatch`, or bare `genie task`/`genie board` (word-boundary grep gate exits non-zero on any hit; `genie v5 …` is allowed).
- [ ] A task created in one worktree is visible in a second worktree of the same repo (bun test using two real worktrees sharing genie.db via common-dir).
- [ ] N concurrent `checkout` attempts on one ready task yield exactly one winner (multi-process race test, `Promise.allSettled` pattern).
- [ ] `genie v5 task export` emits the complete state as JSON (round-trip covered by test).
- [ ] `bun test src/lib/v5/` and `bun run typecheck` green; `src/lib/v5/` imports nothing from db.ts/pgserve/nats/postgres.
- [ ] `bun run skills:lint` passes on the rewritten skills.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1 | genie.db schema + state module is the contract everything consumes; also unlocks v5-branch merges |
| 2 | Group 2 | CLI over the state module |
| 3 | Group 3 | Skills reference the `genie v5` CLI, so they follow it (Decision 5) |
| 4 | Group 4 | E2E proof requires CLI + skills |

---

## Execution Groups

### Group 1: genie.db state engine
**Goal:** Ship the minimal sqlite schema and typed state module — the frozen contract for the CLI, the skills, and every later umbrella group.

**Deliverables:**
1. `src/lib/v5/TAXONOMY.md` — spec: documents-in-git vs state-in-genie.db split, `.genie/` layout, full schema reference (~6 tables), ID scheme, concurrency rules (WAL, transaction-per-mutation, checkout claim semantics).
2. `src/lib/v5/genie-db.ts` — bun:sqlite open/init (WAL, `PRAGMA user_version = 1`, `PRAGMA busy_timeout` set so concurrent writers surface as clean claim-conflicts rather than SQLITE_BUSY flake), worktree-aware path resolution via git common-dir.
3. `src/lib/v5/task-state.ts` — task CRUD, dependency edges, ready-set recompute (Kahn in JS, cycle rejection), **atomic checkout claim** (conditional UPDATE in transaction, stale-claim expiry), stage log appends, wish-group state machine (blocked→ready→in_progress→done) with drift-guard signature (port of `computeGroupsSignature`).
4. Colocated tests: schema init, round-trips, cycle rejection, two-real-worktrees visibility (`/tmp` git repos), multi-process checkout race (exactly one winner via `Promise.allSettled` over spawned `bun` processes).
5. `v5` added to `ALLOWED_MERGE_BASES` in `src/hooks/handlers/branch-guard.ts`; **extend the existing** `src/hooks/__tests__/branch-guard.test.ts` (23 cases today) with allow-`v5` and deny-`main` cases — Decision 6.
6. `.gitignore` gains `.genie/genie.db`, `.genie/genie.db-wal`, `.genie/genie.db-shm` — operational state is never git-versioned (Decision 1's premise; no rule covers the DB today).

**Acceptance Criteria:**
- [ ] Schema created idempotently; `user_version` stamped; malformed DB refused with typed error.
- [ ] Ready-set recompute is idempotent and monotonic; cycles rejected at edge insertion.
- [ ] Checkout race test: N concurrent claimants, exactly one winner, losers get a typed conflict error.
- [ ] Worktree test proves shared visibility without any daemon.
- [ ] No import in `src/lib/v5/` resolves to db.ts, pgserve, nats, or postgres.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
test -d src/lib/v5
test -f src/lib/v5/TAXONOMY.md
bun test src/lib/v5/
bun run typecheck
if grep -RE "from '(\.\./)+(db|pgserve|canonical-pgserve-binary)" src/lib/v5/ --include='*.ts'; then
  echo "FAIL: forbidden PG import in src/lib/v5/"; exit 1
fi
if grep -RE "from 'nats'|from 'postgres'" src/lib/v5/ --include='*.ts'; then
  echo "FAIL: forbidden nats/postgres import in src/lib/v5/"; exit 1
fi
bun test src/hooks/
grep -q "'v5'" src/hooks/handlers/branch-guard.ts
grep -q "^\.genie/genie\.db$" .gitignore
```

**depends-on:** none

---

### Group 2: `genie v5` task/board CLI
**Goal:** Ship `genie v5 task` and `genie v5 board` as thin commands over Group 1's state module — the contract the skills and the user drive daily.

**Deliverables:**
1. `src/term-commands/v5-task.ts` — `task create --title|list|status <id>|done <id>|checkout <id>|export` over `task-state.ts`.
2. `src/term-commands/v5-board.ts` — `board` kanban render derived by query (group-by-stage, counts, ordering). **Daily-driver quality bar: readability parity with v4's `genie board`.** Takes over the bare `genie board` name at demolition.
3. Registration in `src/genie.ts` under a `v5` namespace so v4 commands stay untouched until demolition.
4. Colocated tests using tmpdir + `GENIE_HOME` isolation; exit codes and stderr asserted, not just stdout; `export` round-trip test.

**Acceptance Criteria:**
- [ ] Each subcommand exits non-zero with a clear stderr message on invalid input (missing id, no DB, claim conflict).
- [ ] `board` output reflects status changes with no stored view state.
- [ ] `export` emits complete state as JSON (all ~6 tables represented).
- [ ] No PG/NATS/registry import reachable from the new commands.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
bun test src/term-commands/v5-task.test.ts
bun test src/term-commands/v5-board.test.ts
bun run typecheck
if grep -RE "from '(\.\./)*lib/(db|pgserve|canonical-pgserve-binary|agent-registry|executor-registry)" src/term-commands/v5-task.ts src/term-commands/v5-board.ts; then
  echo "FAIL: forbidden runtime import in v5 commands"; exit 1
fi
if grep -RE "from 'nats'|from 'postgres'" src/term-commands/v5-task.ts src/term-commands/v5-board.ts; then
  echo "FAIL: forbidden nats/postgres import in v5 commands"; exit 1
fi
```

**depends-on:** group-1

---

### Group 3: Core skills portability
**Goal:** Rewrite brainstorm/wish/work/review SKILL.md files free of the v4 runtime: documents in git, state via the `genie v5` CLI, dispatch via Claude Code native teams.

**Deliverables:**
1. Rewritten `skills/brainstorm/SKILL.md`, `skills/wish/SKILL.md`, `skills/work/SKILL.md`, `skills/review/SKILL.md`: no v4 runtime commands; task/board state via `genie v5 task`/`genie v5 board`; `/work` dispatches execution groups via the Agent tool (native teams) with wish-group transitions through `genie v5 task checkout/done`; fix loops and review handoff preserved.
2. **Create** `skills/README.md` (does not exist today) with a "v5 kept siblings" section — keep/drop list covering all 17 current skill dirs with one-line rationale each (list only; rewrites are OUT).
3. `bun run skills:lint` kept green (update `scripts/skills-lint.ts` expectations only if the linter hardcodes v4 assumptions — flag such changes in the PR). Executor note: the linter shells out to the on-PATH `genie` binary, so run `bun run build` (and use the fresh dist) before validating — Group 2's `v5` namespace must exist in the binary the linter sees.

**Acceptance Criteria:**
- [ ] No rewritten skill invokes `genie agent`, `genie spawn`, `genie run`, `genie wish`, `genie dispatch`, or bare `genie task `/`genie board ` (the v4 PG-backed commands). `genie v5 task`/`genie v5 board` are the permitted state surface.
- [ ] `/work` skill instructs native-team dispatch (Agent tool) with state transitions via `genie v5 task checkout/done`.
- [ ] Kept-siblings list exists and covers every current `skills/` entry with keep/drop.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
for f in skills/brainstorm/SKILL.md skills/wish/SKILL.md skills/work/SKILL.md skills/review/SKILL.md; do
  test -f "$f"
  if grep -nE 'genie (agent|spawn|run|wish|dispatch)\b' "$f"; then echo "FAIL: $f calls v4 runtime CLI"; exit 1; fi
  if grep -nE 'genie (task|board)\b' "$f"; then echo "FAIL: $f calls bare v4 task/board (use genie v5 ...)"; exit 1; fi
done
grep -q "v5 kept siblings" skills/README.md
bun run skills:lint
```

**depends-on:** group-2

---

### Group 4: Zero-daemon lifecycle E2E
**Goal:** Prove the foundation thesis: the full lifecycle runs on git documents + genie.db alone, with no resident genie process and no Postgres.

**Deliverables:**
1. `tests/e2e/v5-lifecycle.sh` — fixture git repo in tmpdir; drives the lifecycle (brainstorm artifacts → WISH.md → tasks transitioning via `genie v5 task` → board render → review artifacts); asserts (a) expected documents/DB rows exist at each stage, (b) no `pgserve`/`postgres` process was spawned during the run, (c) task state visible from a second worktree, (d) `genie v5 task export` JSON matches the driven state, (e) run leaves zero background processes, (f) `genie.db` and its WAL/SHM sidecars never appear in `git status` of the fixture repo.
2. `.claude/plans/v5-foundation/qa.md` — QA report: assertions exercised, failure inventory, gaps (real-agent smoke run is manual/opt-in via `V5_E2E_LIVE=1` running `claude -p`).

**Acceptance Criteria:**
- [ ] Script exits non-zero with a named assertion on any failure (no `|| true` swallowing).
- [ ] Run leaves zero background processes (asserted before exit).
- [ ] QA report lists every assertion and any manual-only path.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
test -f .claude/plans/v5-foundation/qa.md
bash tests/e2e/v5-lifecycle.sh
```

**depends-on:** group-2, group-3

---

## Cross-wish dependencies

- **Enables** (umbrella): Group 3 Warp integration, Group 5 omni port (reuses the genie.db engine at global scope), Group 7 v4 exporter (targets this schema) — all consume this wish's state contract.
- **Depends on:** none.
