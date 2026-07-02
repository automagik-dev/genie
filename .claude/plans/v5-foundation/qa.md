# QA Report — v5-foundation Group 4: zero-daemon lifecycle E2E

**Artifact under test:** `tests/e2e/v5-lifecycle.sh`
**Thesis proven:** the full wish lifecycle runs on git documents + `.genie/genie.db`
alone — no resident genie process, no Postgres, no per-tree state duplication.

The script drives the **real** CLI bundle (`bun <repo>/dist/genie.js v5 ...`)
against a throwaway `git init` fixture, asserting documents + DB rows at each
stage. Every check prints `ASSERT <name>` and aborts non-zero via `die` with a
clear message; there is no `|| true` on any lifecycle command (the single
`|| true` uses are on `pgrep`/`jobs` snapshots, which legitimately exit non-zero
when nothing matches — they guard diagnostics, never an assertion).

## How to run

```bash
cd <repo>
bash tests/e2e/v5-lifecycle.sh          # default: uses prebuilt dist, no live agent
V5_E2E_BUILD=1 bash tests/e2e/...        # force `bun run build` first
V5_E2E_LIVE=1  bash tests/e2e/...        # + document-only `claude -p` smoke (never gates pass)
```

Re-runnable and idempotent: each run allocates fresh `mktemp -d` dirs (fixture +
scratch) and removes them (and the linked worktree) via an `EXIT` trap. Verified
by two consecutive passing runs leaving zero leftover temp dirs and only
`tests/e2e/` new in the real repo's `git status`.

## Assertions — what each one proves

| ASSERT name | Proves |
|---|---|
| `gitignore-has-three-genie-db-lines` | Setup mirrors what `genie init` will do: the three `.genie/genie.db{,-wal,-shm}` ignore lines are copied verbatim from the repo's own `.gitignore` into the fixture. |
| `wish-documents-exist` | The skills' file artifacts (`WISH.md` rendered from `templates/wish-template.md` + a brainstorm `DESIGN.md`) are created under `.genie/wishes/<slug>/`. |
| `wish-documents-committed-to-git` | Wish documents live in **git**, not the DB — `git ls-files` tracks `WISH.md`. |
| `task-ids-parsed` | The CLI's `Created task <id> ...` output is machine-parseable (skills depend on this to chain create→checkout→done). |
| `genie-db-materialized` | The **first** CLI write creates `.genie/genie.db` on demand — no bootstrap daemon, no `genie serve`. |
| `three-tasks-in-db-all-ready` | One task per execution group is persisted; with no deps each starts `ready` (matches `createTask` semantics). Verified via `task list --json` count and `--status ready` count. |
| `board-shows-three-ready` | `board --wish --json` is a pure query over live rows (no stored view state): ready column = 3. |
| `t1-done`, `t2-in-progress` | `task checkout` → `in_progress` (claim) and `task done` → `done` transitions take effect and are queryable by `--status`. |
| `board-columns-reflect-lifecycle` | After driving T1→done, T2→in_progress, T3 untouched, the re-rendered board reports done=1, in_progress=1, ready=1, blocked=0 — the view recomputes from state with nothing persisted. |
| `export-schema-version-1` | `task export` stamps `schemaVersion: 1` (matches `CURRENT_SCHEMA_VERSION`). |
| `export-task-count-3` | Export is a complete snapshot: all 3 tasks present. |
| `export-statuses-match-driven-state` | Export status of each task equals the driven lifecycle exactly (done / in_progress / ready). |
| `export-claim-fields-match` | `claimed_by` = worker for the two claimed tasks, `null` for the untouched one. |
| `export-wish-and-group-fields-match` | Every task carries the correct `wish` slug and `group_name` (1/2/3) — the wish→group→task linkage survives round-trip. |
| `worktree-sees-same-three-tasks` | A second `git worktree` runs `v5 task list` and sees the identical 3 tasks — worktrees share **one** genie.db via `git rev-parse --git-common-dir`. |
| `worktree-does-not-create-second-db` | The linked worktree does **not** spawn its own `.genie/genie.db`; state is not per-tree. |
| `genie-db-never-in-git-status` | `git status --porcelain` never lists `genie.db`/`-wal`/`-shm` — the ignore rules are effective (paired with `genie-db-files-exist-on-disk` so the absence is due to ignore, not a missing DB). |
| `genie-db-files-exist-on-disk` | The DB really exists on disk, so the git-clean result above is meaningful. |
| `no-new-pgserve-or-postgres` | Baseline `pgrep -f 'pgserve|postgres'` captured before the run is compared (`comm -13`) to after — **zero** new matching processes. Pre-existing unrelated system processes are tolerated because only the set difference is inspected. |
| `no-new-shell-background-jobs` | `jobs -p` before == after — the run leaves zero background jobs of its own shell. |

## Failure-mode behavior (verified)

The script's named-assertion / non-zero-exit contract is not theoretical: during
development an off-by-one in a JSON helper produced exactly the intended output —

```
ASSERT board-shows-three-ready
FAIL: board ready column != 3 after create   (exit 1)
```

i.e. the `ASSERT <name>` line prints, then `die` writes `FAIL: <message>` to
stderr and the script exits non-zero, with `set -euo pipefail` guaranteeing no
subsequent step runs.

## Failure inventory — 10 most likely ways this could break

1. **Stale global `genie`** — a stale global binary lacks `v5`. Mitigated: the
   script always invokes `bun <repo>/dist/genie.js`, never a PATH `genie`.
2. **Missing/old dist** — `dist/genie.js` absent or built before Group 2. Mitigated:
   the script builds when the bundle is missing or `V5_E2E_BUILD=1`; a passing run
   requires the v5 command surface to be present.
3. **`bun -e` argv indexing** — the first arg to `bun -e 'code' arg` lands at
   `argv[1]` (not `[2]`). This actually bit us once and is now fixed + covered by
   the export/board assertions; a regression here fails those asserts loudly.
4. **`pgrep` exits 1 on no-match** — under `set -e` an unguarded `pgrep` aborts the
   script. Mitigated by the `|| true` snapshot wrapper (diagnostic only) and a
   comment explaining it tolerates only the empty-match case.
5. **Worktree can't share the DB** — if `git rev-parse --git-common-dir`
   resolution regressed, the second worktree would see 0 tasks or spawn its own
   DB. Directly asserted (`worktree-sees-same-three-tasks`,
   `worktree-does-not-create-second-db`).
6. **`.gitignore` not effective** — DB leaking into `git status` would fail
   `genie-db-never-in-git-status`. Guard-paired with `genie-db-files-exist-on-disk`
   so an empty status from a missing DB can't produce a false pass.
7. **Leftover state between runs** — a non-fresh tmpdir or unremoved worktree would
   corrupt the next run. Mitigated: fresh `mktemp -d` per run + `EXIT` trap that
   `git worktree remove --force`s then `rm -rf`s both dirs. Verified by two runs.
8. **DB write path assumes cwd** — genie.db is created relative to the git root of
   `cwd`; the script `cd`s into the fixture before any CLI write and asserts the DB
   lands in `$FIXTURE/.genie/`.
9. **Task-status seed drift** — if `createTask`'s "no deps ⇒ ready" default
   changed, `three-tasks-in-db-all-ready` catches it.
10. **Export shape drift** — renamed columns (`group_name`, `claimed_by`) or a
    schema-version bump would fail the export asserts; the script pins
    `schemaVersion == 1` and the exact raw column names.

## Manual-only / out-of-scope paths (honest gaps)

- **Live Claude agent** — the skills are prompt files executed by a Claude
  session; this E2E drives the **CLI surface the skills reference**, not an actual
  model turn. The optional `V5_E2E_LIVE=1` mode runs a `claude -p "Reply … OK"`
  smoke, but it is **document-only**: a missing `claude` binary or a non-OK reply
  is non-fatal and never gates the pass. A genuine skill-driven run (Claude reading
  `skills/wish.md` and issuing these CLI calls itself) remains a manual verification.
- **pgserve preload skip in sandbox** — the "zero daemon" assertion is a
  before/after `pgrep` diff on this host. In a sandbox where pgserve preload is
  already skipped, the baseline is naturally empty; the assertion still holds
  (no *new* process) but does not independently prove pgserve *would* have been
  skipped under a v4 code path — it proves the v5 CLI never starts one.
- **Cross-process claim contention** — the script exercises the happy-path
  claim/done transitions single-threaded. Concurrent `checkout` races (the
  busy_timeout / atomic-claim behavior) are covered by unit tests in
  `src/lib/v5/task-state.test.ts`, not re-driven here.
- **`board`/`list` ANSI rendering** — assertions read `--json`, not the colored
  human tables, so terminal formatting is proven to *run* (the human board is
  printed for the proof log) but not asserted character-for-character.

## Acceptance criteria

- [x] Script exits non-zero with a named assertion on any failure (no `|| true`
  swallowing of lifecycle commands) — demonstrated by the fixed off-by-one failure.
- [x] Run leaves zero background processes (`no-new-pgserve-or-postgres`,
  `no-new-shell-background-jobs`) asserted before exit.
- [x] This QA report lists every assertion and every manual-only path.

## Post-review notes (from Group 4 independent review, 2026-07-02)

- **CI hardening (MEDIUM):** CI/runbooks should run the e2e with `V5_E2E_BUILD=1` (or an src-newer-than-dist mtime check) — on a stale local dist the script silently tests old bundled behavior; the fresh-clone path auto-builds and is safe.
- **JSON helper semantics (LOW):** `bun -e` helpers exit 0 on malformed JSON; failures surface via the downstream shell `[ ]` guard, not bun's exit code. Keep the `__null__` sentinel pattern for any future null/emptiness comparison.
- **TODO (LOW):** drive the fixture's ignore rules via `genie init` once it lands (umbrella Group 3) instead of copying the three lines from the repo .gitignore.
