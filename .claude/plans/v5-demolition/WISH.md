# Wish: Genie v5 Demolition — Harness Deletion + Bare-Name Cutover + dev Mainline

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `v5-demolition` |
| **Date** | 2026-07-02 |
| **Author** | Felipe + Genie |
| **Appetite** | ~1.5 weeks |
| **Branch** | `v5` (continues from v5-foundation; final group opens the PR to `dev`) |
| **Design** | [DESIGN.md](../genie-v5-lightweight-body/DESIGN.md) — umbrella Group 6, pulled forward per D8 |
| **Depends on** | wish `v5-foundation` (DONE) |

## Summary

Delete the v4 harness from the `v5` branch — pgserve/Postgres, tmux orchestration, registries, mailbox, OTel/emit, TUI, desktop app, brain, sec-scan — and transfer the bare command names (`genie task`, `genie board`) to the sqlite implementations, dropping the `v5` namespace. Survivors that are v4-entangled (`doctor`, `update`, hook dispatch) are explicitly rewritten first so every deletion group leaves the build green. Cut a `v4` maintenance branch from `dev`, then open the massive deletion PR from `v5` to `dev`, making `dev` v5's mainline. Omni's v4 code is deleted with the rest (PG-broken on this line anyway); its genie.db port is the immediately following wish, rebuilt from git history.

## Scope

### IN
- `v4` maintenance branch cut from `dev` and pushed BEFORE the v5→dev PR (home of goodbye banner, exporter, final npm release).
- Bare-name cutover: `genie task` and `genie board` become the sqlite-backed implementations; the `genie v5` namespace is removed; `genie v5` references in the four core skills AND `skills/README.md` become bare names; `tests/e2e/v5-lifecycle.sh` updated to drive bare names.
- Survivor rewrites (own group, before deletion): `doctor` rewritten minimal (binary/git/genie.db checks — its current 1656 lines are PG/tmux/bridge-entangled), `update` reworked off legacy-cleanup/pm2/pgserve imports (2038 lines; self-update from GitHub releases retained), hook dispatch rewired off the emit spine (branch-guard + registry kept), `skills-lint:ignore` markers added to the 12 deferred skills whose fences reference doomed namespaces (pm, trace, council + council/members/config.md, wizard, genie + genie/reference/lifecycle.md, docs, fix, report, dream, genie-hacks).
- Deletion of the v4 runtime from `v5`: db.ts/pgserve layer + all `src/db/migrations/`, agent/executor registries, provider executors, tmux orchestration + `scripts/tmux/`, mailbox/team-chat/runtime-events, OTel receiver + emit spine + audit events, scheduler-daemon, derived-signals detectors, session-capture/filewatch/backfill, transcript providers, team-manager/native-teams, omni v4 modules, TUI (`@opentui` hosts), `packages/genie-app`, `packages/genie-tokens`, `packages/watchdog`, brain integration, sec-scan suite, orphaned v4 task/board sources (`src/term-commands/task/`, `task.test.ts`, old board sources), and every CLI namespace whose backend dies (agent, team, exec, db, serve, qa, sec, wish, dir, session, recover-orphans, observability/perf, legacy-cleanup, migrate).
- Dependency + config purge: remove `postgres`, `nats`, `react`, `react-dom`, `@opentui/*`, `@tauri-apps/api` (+ cli devDep), `@xterm/headless`, `@khal-os/brain` refs, `@anthropic-ai/claude-agent-sdk`, `systeminformation`, `chokidar` (if only session-filewatch used it), orphaned devDeps; update `knip.json`, `biome.json`, `tsconfig`, package.json `files`/`scripts`, postinstall scripts.
- Gates green after each group: typecheck, lint, bun test, skills:lint, build, `V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh`; final: full `bun run check`, top-level command count ≤ 10 (with lower-bound + task/board presence asserts), knip clean.
- The v5→dev PR opened (agent opens; merging a deletion this size is Felipe's call).
- README stale-claim sweep: all references to deleted subsystems (PostgreSQL/LISTEN-NOTIFY, terminal UI, knowledge brain, Postgres-backed, genie-tokens/desktop) replaced by an honest v5 section.

### OUT
- Omni runner port on genie.db — immediately following wish (umbrella Group 5); this wish only deletes the v4 omni code.
- Warp integration + `genie init` (Group 3), Codex/Hermes emit (Group 4), v4 exit ramp (Group 7, on the `v4` branch), CDN distribution (Group 8).
- Rewrites/ports of the 12 deferred skills — they keep stale content behind `skills-lint:ignore` until their port wishes.
- Deep `update` overhaul (channel strategy, CDN) — distribution wish; this wish only severs its dead imports.
- Any new features; `docs/` submodule edits; deleting anything on the `v4` branch; merging the PR.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Demolish before omni port; omni temporarily dead on the v5 line | User-confirmed (D8). v4 omni is PG-dependent and already broken once pgserve dies; git history preserves the reference code for the port wish |
| 2 | Cut `v4` branch from `dev` before the PR; `dev` becomes v5 mainline after merge | User-confirmed (D8). Exit ramp + final npm release ship from `v4`; branch policy (agents merge to dev/v5, main human-only) unchanged |
| 3 | Bare names transfer in the same wish as the deletion, before it | `genie board` must "work as before, sqlite now" the moment the harness dies; proving survivors before deletion keeps the wish bisectable |
| 4 | Survivor rewrites are their own group between cutover and deletion | Review finding: doctor (1656 lines) and update (2038 lines) import doomed modules at ~10 call sites — "slim" was really "rewrite"; doing it first keeps every deletion group's typecheck-green acceptance honest |
| 5 | Deferred skills get `skills-lint:ignore`, not deletion or rewrite | skills-lint fail-closes on first-tokens absent from `--help`; 12 skills reference namespaces this wish deletes; ignore markers (pattern already used by skills/omni) keep `bun run check` meaningful without expanding scope into skill ports |
| 6 | Keep minimal hook dispatch + branch-guard; delete PG-dependent handlers and the emit-spine wiring in hooks/index.ts | branch-guard imports only node builtins (verified); it is the standing merge law |
| 7 | Deletion in staged groups, each leaving the build green | A mega-commit that breaks mid-review is unbisectable |

## Success Criteria

- [ ] Bare `genie task` and `genie board` are the sqlite implementations; `genie v5` namespace gone; core skills, skills/README.md, and the e2e drive bare names (grep gate: no `genie v5` under skills/).
- [ ] `V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh` passes driving bare names.
- [ ] Top-level CLI command count ≥ 2 and ≤ 10, with `task` and `board` present (asserted from `--help`).
- [ ] `package.json` contains none of: postgres, nats, react, react-dom, @opentui/*, @tauri-apps/*, @xterm/headless, @khal-os/brain, @anthropic-ai/claude-agent-sdk, systeminformation.
- [ ] `src/db/`, `packages/genie-app/`, `packages/genie-tokens/`, `packages/watchdog/`, `scripts/tmux/`, `scripts/sec-*.cjs` no longer exist.
- [ ] Full `bun run check` green on the final tree (skills:lint passing via ignore markers on deferred skills); knip clean against updated config.
- [ ] `v4` branch exists on origin, cut from pre-merge `dev`.
- [ ] PR from `v5` to `dev` open with deletion-dominated diffstat, omni-dark note, and links to this WISH + DESIGN.
- [ ] README carries no claims about deleted subsystems (PostgreSQL/LISTEN-NOTIFY, terminal UI, knowledge brain, Postgres-backed, genie-tokens/desktop).

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1 | Bare-name cutover — proves the sqlite survivors while v4 still stands |
| 2 | Group 2 | Survivor rewrites (doctor/update/hooks/lint-ignores) — severs every import into doomed code |
| 3 | Group 3 | src runtime deletion (surviving v4 src imports packages/genie-tokens, so src must go first) |
| 4 | Group 4 | packages/scripts/tests deletion — sequential after G3: not disjoint (tag.ts/task-service.ts/board-service.ts import ../../packages/genie-tokens until G3 deletes them) |
| 5 | Group 5 | Dependency + config purge, full gate battery |
| 6 | Group 6 | `v4` branch cut, README sweep, open the PR |

---

## Execution Groups

### Group 1: Bare-name cutover
**Goal:** `genie task`/`genie board` become the sqlite commands; the `v5` prefix disappears from CLI, skills, and e2e — with v4 code still present.

**Deliverables:**
1. `src/genie.ts`: bare `task`/`board` route to the sqlite implementations; v4 task/board registrations and the `v5` namespace removed. (The now-orphaned v4 sources — `src/term-commands/task/`, `task.test.ts`, old board files — stay on disk until Group 3 deletes them.)
2. `src/term-commands/v5-task.ts`/`v5-board.ts` renamed to the bare-name modules with tests following.
3. `genie v5 …` → `genie …` in the four core SKILL.md AND `skills/README.md` (which references `genie v5` ~8 times).
4. `tests/e2e/v5-lifecycle.sh` drives bare names.

**Acceptance Criteria:**
- [ ] `bun dist/genie.js task list` and `bun dist/genie.js board` are sqlite-backed (fresh build).
- [ ] No `genie v5` reference remains under skills/.
- [ ] E2E passes with bare names.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
bun run build
if grep -rn 'genie v5' skills/; then echo "FAIL: genie v5 references remain in skills/"; exit 1; fi
V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh
bun run typecheck
bun run skills:lint
```

**depends-on:** none

---

### Group 2: Survivor rewrites
**Goal:** Rewrite/rewire everything that survives demolition but currently imports doomed code, so the deletion groups can hold "typecheck green."

**Deliverables:**
1. `doctor` REWRITTEN minimal (honest sizing: current doctor.ts is 1656 lines importing lib/db, ensure-tmux, bridge-status, respawn, role-cutover, installer-resolution, observability-health): new checks limited to binary/PATH, git, `.genie/genie.db` open+schema, skills presence. Old file deleted here.
2. `update` REWORKED (2038 lines): sever imports of legacy-cleanup.js, install.js pm2 helpers, pgserve-status.js (call sites ~993, 1023, 1266, 1299, 1887, 1895-1897, 1971); GitHub-releases self-update behavior retained; deep overhaul stays deferred.
3. `src/hooks/index.ts` rewired off the emit spine (emit/observability-flag/trace-context/runtime-emit imports removed); registry + branch-guard kept; PG-dependent handlers (auto-spawn, codex-inbox-deliver, session-sync, brain-inject, runtime-emit-*) deregistered here (files die in Group 3).
4. `skills-lint:ignore` markers added to the 12 deferred skills (pm, trace, council + council/members/config.md, wizard, genie + genie/reference/lifecycle.md, docs, fix, report, dream, genie-hacks), using the existing skills/omni pattern.
5. `setup`/`install` reduced to what still exists (pm2/pgserve supervision severed).

**Acceptance Criteria:**
- [ ] No surviving module imports any file slated for Group 3/4 deletion (verified by deleting nothing yet but grepping the import graph of survivors).
- [ ] `genie doctor` runs green on a healthy v5 checkout; `genie update --help` works.
- [ ] skills:lint green with ignore markers (and still fails on a genuinely bogus top-level command — spot-check).

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
bun run typecheck
GENIE_TEST_SKIP_PGSERVE=1 bun test src/hooks/
bun run build
bun dist/genie.js doctor
bun run skills:lint
```

**depends-on:** group-1

---

### Group 3: src runtime deletion
**Goal:** Delete the v4 runtime from `src/`, leaving the survivor set compiling and tested.

**Deliverables:**
1. Delete: `src/lib/db.ts` + PG modules, `src/db/`, `src/tui/` (tsconfig-excluded, so typecheck won't notice — asserted explicitly in validation), registries, executor providers, tmux/orchestrator, mailbox/team-chat/runtime-events, otel-receiver/emit/audit + events/, scheduler-daemon, derived-signals, session-capture/filewatch/backfill, transcript+claude-logs+codex-logs, team-manager/claude-native-teams, omni-* modules, workspace/brain refs — and their tests.
2. Delete dead CLI namespaces from `src/term-commands/` + `src/genie-commands/` (agent, team, exec, db, serve, qa, sec, wish, dir, session, recover-orphans, observability-health, perf-check, legacy-cleanup, migrate) and their registrations, plus the orphaned v4 task/board sources from Group 1.
3. Delete PG-dependent hook handler files (deregistered in Group 2).
4. `src/genie.ts` preAction/postAction audit+span wiring removed.

**Acceptance Criteria:**
- [ ] typecheck + full bun test green on the surviving tree.
- [ ] branch-guard suite still green.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
test ! -d src/db
test ! -d src/term-commands/task
test ! -d src/tui
bun run typecheck
GENIE_TEST_SKIP_PGSERVE=1 bun test
bun run build
V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh
```

**depends-on:** group-2

---

### Group 4: packages, scripts, assets deletion
**Goal:** Delete the non-src harness.

**Deliverables:**
1. Delete `packages/genie-app/`, `packages/genie-tokens/`, `packages/watchdog/`.
2. Delete `scripts/tmux/`, `scripts/sec-scan.cjs`, `scripts/sec-remediate.cjs`, `scripts/sec-fix.cjs`, `scripts/postinstall-tmux.js`, `scripts/postinstall-hook-binary.js`, `scripts/postinstall-migrations.js`, `scripts/build-app.ts`, dead test-parallel/perf harness pieces.
3. Delete dead top-level test suites (`test/visual/`, `test/perf/observability/`, others tied to deleted systems) and their fixtures.
4. Prune `plugins/genie/` of references to deleted commands (keep skills symlink + branch-guard hooks.json).

**Acceptance Criteria:**
- [ ] Deleted paths gone; no dangling source references to the deleted packages.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
test ! -d packages/genie-app && test ! -d packages/genie-tokens && test ! -d packages/watchdog
test ! -d scripts/tmux
if ls scripts/sec-*.cjs 2>/dev/null; then echo "FAIL: sec scripts remain"; exit 1; fi
if grep -rn --include='*.ts' -E 'genie-app|genie-tokens|@genie/watchdog' src/ scripts/; then echo "FAIL: dangling refs"; exit 1; fi
bun run typecheck
```

**depends-on:** group-3

---

### Group 5: dependency + config purge, final gates
**Goal:** Purge package.json and tool configs; enforce the measurable demolition gates.

**Deliverables:**
1. package.json: remove dead deps/devDeps, dead `scripts` entries, prune `files`/`binarySha256`/`pgserve` fields; `check` kept meaningful.
2. `knip.json`, `biome.json`, `tsconfig.json`, `.npmignore`, commitlint/husky config updated.
3. Fresh-clone sanity documented: `bun install && bun run check && bun run build && V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh`.

**Acceptance Criteria:**
- [ ] Forbidden deps absent; `bun run check` green end-to-end; knip clean.
- [ ] Command count within bounds with task/board present.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
if grep -nE '"(postgres|nats|react|react-dom|@opentui/|@tauri-apps/|@xterm/|@khal-os/|@anthropic-ai/claude-agent-sdk|systeminformation)"' package.json; then echo "FAIL: dead dep remains"; exit 1; fi
bun install
bun run check
bun run build
HELP=$(bun dist/genie.js --help)
echo "$HELP" | grep -qE '^  task' || { echo "FAIL: task missing from help"; exit 1; }
echo "$HELP" | grep -qE '^  board' || { echo "FAIL: board missing from help"; exit 1; }
COUNT=$(echo "$HELP" | grep -cE '^  [a-z]')
echo "top-level commands: $COUNT"
[ "$COUNT" -ge 2 ] && [ "$COUNT" -le 10 ]
V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh
```

**depends-on:** group-3, group-4

---

### Group 6: v4 branch + PR to dev
**Goal:** Preserve v4's maintenance line, then open the deletion PR making dev the v5 mainline.

**Deliverables:**
1. `v4` branch cut from current `origin/dev` and pushed.
2. README stale-claim sweep: v4 pitch of deleted subsystems replaced with an honest v5 section (covers ALL stale claims — PostgreSQL/LISTEN-NOTIFY table row, terminal UI, knowledge brain / Persistent memory, Postgres-backed, genie-tokens/design section).
3. PR `v5` → `dev`: title `feat!: genie v5 — lightweight body (harness demolition)`, body links WISH + DESIGN, diffstat, survivor command list, omni-dark note naming the follow-up wish. Merge left to Felipe.

**Acceptance Criteria:**
- [ ] `origin/v4` exists and matches pre-merge dev.
- [ ] PR open, base `dev`, deletion-dominated diffstat.
- [ ] README stale-claim grep clean.

**Validation:**
```bash
set -euo pipefail
cd /Users/feliperosa/workspace/genie
git ls-remote --exit-code origin refs/heads/v4
gh pr view --json state,baseRefName -q '.baseRefName' | grep -qx dev
if grep -nE 'PostgreSQL \+ LISTEN/NOTIFY|terminal UI|cockpit|[Kk]nowledge brain|Postgres-backed|genie-tokens' README.md; then echo "FAIL: stale v4 claims"; exit 1; fi
```

**depends-on:** group-5

---

## Cross-wish dependencies

- **Follows:** `v5-foundation` (DONE).
- **Immediately followed by:** omni runner port on genie.db (umbrella Group 5 — rebuild from git history; approval-capture spike first).
- **Unblocks:** Warp integration (Group 3), multi-target emit (Group 4) on a clean tree; exit-ramp work (Group 7) proceeds on the `v4` branch independently.
