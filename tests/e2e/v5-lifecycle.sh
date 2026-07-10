#!/usr/bin/env bash
#
# v5-lifecycle.sh — end-to-end proof of the Genie v5 foundation thesis:
# the full wish lifecycle runs on git documents + `.genie/genie.db` alone,
# with NO resident genie process and NO Postgres.
#
# The script drives the real CLI (`bun <repo>/dist/genie.js task/board ...`) against a
# throwaway git fixture, asserting at each stage that the expected documents and
# database rows exist, that nothing daemon-like was spawned, that a second
# worktree observes the same state, and that the operational DB never leaks into
# git. Every assertion prints `ASSERT <name>` and aborts non-zero with a clear
# message on failure — no `|| true` swallowing of lifecycle commands.
#
# Re-runnable: every run uses fresh mktemp dirs and cleans them up via an EXIT
# trap. Idempotent — no shared state between runs.
#
# Optional live mode (OFF by default):
#   V5_E2E_LIVE=1   additionally runs a real `claude -p` smoke (documented only;
#                   never required for the script to pass).
# Optional build:
#   V5_E2E_BUILD=1  force `bun run build` even if dist/genie.js already exists.

set -euo pipefail

# ----------------------------------------------------------------------------
# Locate the repo + the CLI bundle. Resolve from this script's own location so
# the harness can invoke it from anywhere.
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST="$REPO_ROOT/dist/genie.js"

SLUG="v5-proof"
WORKER="e2e"

# ----------------------------------------------------------------------------
# Output + failure helpers.
# ----------------------------------------------------------------------------
step() { printf '\n=== %s ===\n' "$1"; }
assert() { printf 'ASSERT %s\n' "$1"; }
die() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# ----------------------------------------------------------------------------
# Fresh scratch dirs + cleanup trap. FIXTURE holds the git repo under test;
# SCRATCH holds out-of-repo work files (export JSON, the linked worktree) so
# they never pollute the fixture's `git status`.
# ----------------------------------------------------------------------------
FIXTURE="$(mktemp -d)"
SCRATCH="$(mktemp -d)"
WT="$SCRATCH/worktree"

cleanup() {
  # Best-effort worktree detach before the recursive delete so git's admin
  # files don't dangle; the rm -rf is the real cleanup.
  if [ -d "$WT" ]; then
    git -C "$FIXTURE" worktree remove --force "$WT" >/dev/null 2>&1 || true
  fi
  rm -rf "$FIXTURE" "$SCRATCH"
}
trap cleanup EXIT

# ----------------------------------------------------------------------------
# Process snapshots. pgrep exits 1 when nothing matches — that is a valid EMPTY
# snapshot, not a failure, so the `|| true` here tolerates only the no-match
# case (it guards a diagnostic snapshot, never a lifecycle assertion).
# ----------------------------------------------------------------------------
snapshot_pg() {
  pgrep -f 'pgserve|postgres' 2>/dev/null | sort || true
}

# ----------------------------------------------------------------------------
# JSON helpers — parse CLI output with bun (zero new deps). Each reads the JSON
# document from stdin (fd 0) and writes a single scalar to stdout.
# ----------------------------------------------------------------------------
json_task_count() {
  bun -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String((Array.isArray(s)?s:s.tasks).length))'
}
json_field() {
  # Usage: <export.json | json_field <taskId> <column>
  bun -e '
    const s=JSON.parse(require("fs").readFileSync(0,"utf8"));
    const [id,col]=process.argv.slice(1);
    const t=s.tasks.find(x=>x.id===id);
    if(!t){process.stderr.write("no such task "+id+"\n");process.exit(3);}
    const v=t[col];
    process.stdout.write(v===null?"__null__":String(v));
  ' "$1" "$2"
}
json_schema_version() {
  bun -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(s.schemaVersion))'
}
json_board_count() {
  # Usage: <board.json | json_board_count <status>
  bun -e '
    const s=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.stdout.write(String(s.columns[process.argv[1]].length));
  ' "$1"
}
# Parse the `Created task <id> ...` line into just the id.
task_id_from() { printf '%s\n' "$1" | sed -E 's/^Created task ([^ ]+).*/\1/'; }

cli() { bun "$DIST" "$@"; }

# ============================================================================
# 0. Build (or accept a prebuilt dist) and record baselines.
# ============================================================================
step "build / dist check"
if [ ! -f "$DIST" ] || [ "${V5_E2E_BUILD:-0}" = "1" ]; then
  ( cd "$REPO_ROOT" && bun run build )
fi
[ -f "$DIST" ] || die "CLI bundle not found at $DIST (build failed?)"
printf 'Using CLI bundle: %s\n' "$DIST"

PG_BASELINE="$(snapshot_pg)"
JOBS_BASELINE="$(jobs -p || true)"
printf 'pgserve/postgres baseline pids: [%s]\n' "$(printf '%s' "$PG_BASELINE" | tr '\n' ' ')"

# ============================================================================
# 1. Create the fixture git repo (real git init) and scaffold it with the real
#    `genie init` command — the same idempotent bootstrap an operator runs. init
#    writes `.genie/INDEX.md` and the three genie.db ignore rules into
#    `.gitignore`; we assert both landed, then commit the scaffold so the tree
#    stays clean for the git-cleanliness audit later.
# ============================================================================
step "fixture repo setup (genie init)"
git -C "$FIXTURE" init -q
git -C "$FIXTURE" config user.email "e2e@genie.test"
git -C "$FIXTURE" config user.name "genie-e2e"

# Run as a condition so `set -e` doesn't abort before we assert the exit code.
if ( cd "$FIXTURE" && bun "$DIST" init ); then INIT_RC=0; else INIT_RC=$?; fi
assert genie-init-exit-0
[ "$INIT_RC" -eq 0 ] || die "genie init exited $INIT_RC"

assert genie-init-created-index
[ -f "$FIXTURE/.genie/INDEX.md" ] || die "genie init did not create .genie/INDEX.md"

assert gitignore-has-three-genie-db-lines
[ -f "$FIXTURE/.gitignore" ] || die "genie init did not create .gitignore"
[ "$(grep -c '^\.genie/genie\.db' "$FIXTURE/.gitignore")" -eq 3 ] || die "genie init did not write all 3 genie.db ignore rules"

git -C "$FIXTURE" add .gitignore .genie/INDEX.md
git -C "$FIXTURE" commit -q -m "chore: genie init scaffold"

# ============================================================================
# 2. Author the lifecycle documents as the skills would — brainstorm + wish
#    documents live in git under .genie/wishes/<slug>/.
# ============================================================================
step "author wish documents"
WISH_DIR="$FIXTURE/.genie/wishes/$SLUG"
mkdir -p "$WISH_DIR"
# Render a WISH.md from the repo template (skills copy this template verbatim).
sed "s/{{slug}}/$SLUG/g; s/{{date}}/$(date +%F)/g" "$REPO_ROOT/skills/wish/templates/wish-template.md" > "$WISH_DIR/WISH.md"
# A brainstorm design note (the skills' upstream artifact).
printf '# Design: %s\n\nZero-daemon lifecycle proof.\n' "$SLUG" > "$WISH_DIR/DESIGN.md"
git -C "$FIXTURE" add ".genie/wishes/$SLUG/WISH.md" ".genie/wishes/$SLUG/DESIGN.md"
git -C "$FIXTURE" commit -q -m "docs: add $SLUG brainstorm + wish"

assert wish-documents-exist
[ -f "$WISH_DIR/WISH.md" ] || die "WISH.md was not created"
[ -f "$WISH_DIR/DESIGN.md" ] || die "DESIGN.md was not created"
grep -q "$SLUG" "$WISH_DIR/WISH.md" || die "WISH.md slug substitution did not apply"

assert wish-documents-committed-to-git
git -C "$FIXTURE" ls-files --error-unmatch ".genie/wishes/$SLUG/WISH.md" >/dev/null 2>&1 \
  || die "WISH.md is not tracked in git"

# ============================================================================
# 3. Create one task per execution group via the CLI. No deps ⇒ each starts
#    `ready`. This is the first DB write — genie.db must materialize now.
# ============================================================================
step "create tasks per execution group"
cd "$FIXTURE"

OUT1="$(cli task create --title "Group 1: build engine" --wish "$SLUG" --group 1)"; printf '%s\n' "$OUT1"
OUT2="$(cli task create --title "Group 2: wire CLI"     --wish "$SLUG" --group 2)"; printf '%s\n' "$OUT2"
OUT3="$(cli task create --title "Group 3: rewrite skills" --wish "$SLUG" --group 3)"; printf '%s\n' "$OUT3"
T1="$(task_id_from "$OUT1")"
T2="$(task_id_from "$OUT2")"
T3="$(task_id_from "$OUT3")"
printf 'task ids: %s %s %s\n' "$T1" "$T2" "$T3"

assert task-ids-parsed
[ -n "$T1" ] && [ -n "$T2" ] && [ -n "$T3" ] || die "failed to parse one or more created task ids"

assert genie-db-materialized
[ -f "$FIXTURE/.genie/genie.db" ] || die ".genie/genie.db was not created by the first CLI write"

assert three-tasks-in-db-all-ready
CREATED_COUNT="$(cli task list --wish "$SLUG" --json | json_task_count)"
[ "$CREATED_COUNT" -eq 3 ] || die "expected 3 tasks after create, got $CREATED_COUNT"
READY_COUNT="$(cli task list --wish "$SLUG" --status ready --json | json_task_count)"
[ "$READY_COUNT" -eq 3 ] || die "expected 3 ready tasks after create, got $READY_COUNT"

# ============================================================================
# 3b. `genie launch --dry-run` — plan one Warp pane per ready group while all 3
#     are ready, touching NOTHING. Isolation: GENIE_WORKTREES_DIR points at a
#     fixture-scoped dir the command has never created; HOME is redirected into
#     the fixture so the platform Warp config dir (macOS: $HOME/.warp/...,
#     Linux: $HOME/.local/share/warp-terminal/...) also resolves under the
#     fixture and can be proven untouched — the real user Warp dir is never
#     read or written. dry-run must plan 3 panes with absolute cwds, then leave
#     the worktrees dir empty and write no launch config anywhere.
# ============================================================================
step "launch --dry-run (plan-only, no materialization)"
LAUNCH_WT="$SCRATCH/launch-worktrees"
LAUNCH_HOME="$SCRATCH/launch-home"
LAUNCH_OUT="$SCRATCH/launch-dry.out"
mkdir -p "$LAUNCH_HOME"

if HOME="$LAUNCH_HOME" GENIE_WORKTREES_DIR="$LAUNCH_WT" bun "$DIST" launch "$SLUG" --dry-run > "$LAUNCH_OUT" 2>&1; then
  LAUNCH_RC=0
else
  LAUNCH_RC=$?
fi
cat "$LAUNCH_OUT"

assert launch-dry-run-exit-0
[ "$LAUNCH_RC" -eq 0 ] || die "launch --dry-run exited $LAUNCH_RC"

assert launch-dry-run-plans-three-groups
grep -q '3 group(s)' "$LAUNCH_OUT" || die "launch --dry-run did not report 3 groups"

assert launch-dry-run-one-absolute-worktree-per-group
WT_LINES="$(grep -c "worktree: $LAUNCH_WT/" "$LAUNCH_OUT" || true)"
[ "$WT_LINES" -eq 3 ] || die "expected 3 absolute worktree paths under $LAUNCH_WT, got $WT_LINES"

assert launch-dry-run-panes-have-absolute-cwd
CWD_ABS="$(grep -oE 'cwd: /' "$LAUNCH_OUT" | wc -l | tr -d ' ')"
[ "$CWD_ABS" -eq 3 ] || die "expected 3 absolute pane cwds in the YAML, got $CWD_ABS"

assert launch-dry-run-materialized-no-worktrees
if [ -d "$LAUNCH_WT" ] && [ -n "$(ls -A "$LAUNCH_WT" 2>/dev/null)" ]; then
  die "launch --dry-run materialized worktree content under $LAUNCH_WT"
fi

assert launch-dry-run-wrote-no-config
FOUND_CFG="$(find "$LAUNCH_HOME" -name "genie-$SLUG.yaml" 2>/dev/null)"
[ -z "$FOUND_CFG" ] || die "launch --dry-run wrote a launch config under $LAUNCH_HOME: $FOUND_CFG"

# ============================================================================
# 4. Render the board (pure query, no stored view state).
# ============================================================================
step "board render (after create)"
cli board --wish "$SLUG"
assert board-shows-three-ready
BOARD_JSON="$(cli board --wish "$SLUG" --json)"
[ "$(printf '%s' "$BOARD_JSON" | json_board_count ready)" -eq 3 ] || die "board ready column != 3 after create"

# ============================================================================
# 5. Claim (checkout) + complete (done). Exercise all three terminal statuses:
#    T1 -> done, T2 -> in_progress, T3 -> ready (untouched).
# ============================================================================
step "claim + complete"
cli task checkout "$T1" --worker "$WORKER"
cli task done "$T1"
cli task checkout "$T2" --worker "$WORKER"

assert t1-done
[ "$(cli task list --wish "$SLUG" --status done --json | json_task_count)" -eq 1 ] || die "expected 1 done task"
assert t2-in-progress
[ "$(cli task list --wish "$SLUG" --status in_progress --json | json_task_count)" -eq 1 ] || die "expected 1 in_progress task"

step "board render (after lifecycle)"
cli board --wish "$SLUG"
BOARD_JSON2="$(cli board --wish "$SLUG" --json)"
assert board-columns-reflect-lifecycle
[ "$(printf '%s' "$BOARD_JSON2" | json_board_count done)" -eq 1 ] || die "board done column != 1"
[ "$(printf '%s' "$BOARD_JSON2" | json_board_count in_progress)" -eq 1 ] || die "board in_progress column != 1"
[ "$(printf '%s' "$BOARD_JSON2" | json_board_count ready)" -eq 1 ] || die "board ready column != 1"
[ "$(printf '%s' "$BOARD_JSON2" | json_board_count blocked)" -eq 0 ] || die "board blocked column != 0"

# ============================================================================
# 6. Export the full state and assert it matches the driven lifecycle exactly.
# ============================================================================
step "export + verify"
EXPORT="$SCRATCH/export.json"
cli task export > "$EXPORT"

assert export-schema-version-1
[ "$(json_schema_version < "$EXPORT")" -eq 1 ] || die "export schemaVersion != 1"

assert export-task-count-3
[ "$(json_task_count < "$EXPORT")" -eq 3 ] || die "export task count != 3"

assert export-statuses-match-driven-state
[ "$(json_field "$T1" status < "$EXPORT")" = "done" ]        || die "T1 status != done in export"
[ "$(json_field "$T2" status < "$EXPORT")" = "in_progress" ] || die "T2 status != in_progress in export"
[ "$(json_field "$T3" status < "$EXPORT")" = "ready" ]       || die "T3 status != ready in export"

assert export-claim-fields-match
[ "$(json_field "$T1" claimed_by < "$EXPORT")" = "$WORKER" ] || die "T1 claimed_by != $WORKER in export"
[ "$(json_field "$T2" claimed_by < "$EXPORT")" = "$WORKER" ] || die "T2 claimed_by != $WORKER in export"
[ "$(json_field "$T3" claimed_by < "$EXPORT")" = "__null__" ] || die "T3 claimed_by should be null in export"

assert export-wish-and-group-fields-match
for id in "$T1" "$T2" "$T3"; do
  [ "$(json_field "$id" wish < "$EXPORT")" = "$SLUG" ] || die "task $id wish != $SLUG in export"
done
[ "$(json_field "$T1" group_name < "$EXPORT")" = "1" ] || die "T1 group_name != 1"
[ "$(json_field "$T2" group_name < "$EXPORT")" = "2" ] || die "T2 group_name != 2"
[ "$(json_field "$T3" group_name < "$EXPORT")" = "3" ] || die "T3 group_name != 3"

# ============================================================================
# 7. Second worktree observes the same state (worktrees share one genie.db via
#    git-common-dir). Proves the DB is the shared medium, not a per-tree file.
# ============================================================================
step "second-worktree visibility"
git -C "$FIXTURE" worktree add -q "$WT" -b e2e-worktree
assert worktree-sees-same-three-tasks
WT_COUNT="$(cd "$WT" && bun "$DIST" task list --wish "$SLUG" --json | json_task_count)"
[ "$WT_COUNT" -eq 3 ] || die "second worktree saw $WT_COUNT tasks, expected 3"

assert worktree-does-not-create-second-db
[ ! -f "$WT/.genie/genie.db" ] || die "second worktree created its own genie.db (should share the main one)"

# ============================================================================
# 8. genie.db + WAL/SHM must NEVER appear in git status (ignore rules effective).
# ============================================================================
step "git cleanliness"
PORCELAIN="$(git -C "$FIXTURE" status --porcelain)"
printf 'git status --porcelain:\n%s\n' "${PORCELAIN:-<clean>}"
assert genie-db-never-in-git-status
if printf '%s\n' "$PORCELAIN" | grep -E 'genie\.db(-wal|-shm)?' >/dev/null 2>&1; then
  die "genie.db / -wal / -shm leaked into git status --porcelain"
fi
# Sanity: the DB files really do exist on disk (so the absence above is due to
# ignore rules, not a missing DB).
assert genie-db-files-exist-on-disk
[ -f "$FIXTURE/.genie/genie.db" ] || die "genie.db missing on disk"

# ============================================================================
# 9. Zero-daemon / zero-new-background-process proof.
# ============================================================================
step "daemon + background-process audit"
PG_AFTER="$(snapshot_pg)"
NEW_PG="$(comm -13 <(printf '%s\n' "$PG_BASELINE" | sed '/^$/d') <(printf '%s\n' "$PG_AFTER" | sed '/^$/d') || true)"
assert no-new-pgserve-or-postgres
if [ -n "$(printf '%s' "$NEW_PG" | tr -d '[:space:]')" ]; then
  die "new pgserve/postgres process(es) appeared during the run: $NEW_PG"
fi

assert no-new-shell-background-jobs
JOBS_AFTER="$(jobs -p || true)"
[ "$JOBS_BASELINE" = "$JOBS_AFTER" ] || die "shell background jobs changed: before=[$JOBS_BASELINE] after=[$JOBS_AFTER]"

# ============================================================================
# 9b. Zero-omni guard — the omni runner is the ONLY code path that touches the
#     NATS transport. Prove the everyday commands (`--help`, `task`, `board`)
#     work with NO omni config present and never initialize the transport.
#
#     Two complementary proofs:
#       (a) Black-box: run each command under a fresh, empty GENIE_HOME (so no
#           ~/.genie/config.json omni section and no OMNI_* state can leak in)
#           and assert exit 0. `omni status --json` is included as a read-only
#           omni-namespace command that opens the global DB but must report
#           disabled and stay transport-free.
#       (b) White-box marker: the runner exports natsConnectionCount(), a
#           process-lifetime counter incremented ONLY inside the real NATS
#           factory (i.e. only when `omni serve` runs). We can't read the
#           dist CLI's in-process counter across a process boundary from bash,
#           so we import the source module directly and assert the marker is 0
#           after loading it — proving that merely loading/using the runner
#           never opens a connection; only `runOmniServe` does. A static grep
#           backs this up: `nats` is a *dynamic* import inside the factory, not
#           a top-level import.
# ============================================================================
step "zero-omni guard (no omni config, transport never initialized)"
NO_OMNI_HOME="$SCRATCH/no-omni-home"
mkdir -p "$NO_OMNI_HOME"

# (a) Black-box: everyday commands succeed with a clean, omni-free GENIE_HOME.
#     Unset any inherited OMNI_* env so the guard reflects a truly empty config.
run_no_omni() { env -u OMNI_API_URL -u OMNI_API_KEY -u OMNI_INSTANCE -u OMNI_APPROVAL_CHAT \
  -u OMNI_APPROVALS_ENABLED -u OMNI_NATS_URL GENIE_HOME="$NO_OMNI_HOME" bun "$DIST" "$@"; }

assert help-works-without-omni-config
run_no_omni --help >/dev/null 2>&1 || die "genie --help failed with no omni config"

assert help-lists-omni-task-board
NO_OMNI_HELP="$(run_no_omni --help 2>&1)"
for c in omni task board; do
  printf '%s\n' "$NO_OMNI_HELP" | grep -qE "^  $c( |\$)" || die "genie --help missing '$c' with no omni config"
done

assert task-list-works-without-omni-config
( cd "$FIXTURE" && run_no_omni task list --wish "$SLUG" --json >/dev/null 2>&1 ) \
  || die "genie task list failed with no omni config"

assert board-works-without-omni-config
( cd "$FIXTURE" && run_no_omni board --wish "$SLUG" --json >/dev/null 2>&1 ) \
  || die "genie board failed with no omni config"

# `omni status` is a read-only omni-namespace command: it opens the global DB
# but must NOT touch NATS. With no config it reports disabled — a transport-free
# proof that even entering the omni namespace doesn't initialize the runner.
assert omni-status-disabled-without-config
OMNI_STATUS_JSON="$( cd "$FIXTURE" && run_no_omni omni status --json 2>&1 )" \
  || die "genie omni status failed with no omni config"
printf '%s' "$OMNI_STATUS_JSON" \
  | bun -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(s.enabled===false?0:1)' \
  || die "omni status reported enabled with no config (expected disabled)"

# (b) White-box marker: loading the runner module never opens a connection.
assert nats-connection-count-zero-on-load
RUNNER_SRC="$REPO_ROOT/src/lib/omni-runner.ts"
[ -f "$RUNNER_SRC" ] || die "omni-runner source not found at $RUNNER_SRC"
bun -e '
  const m = await import(process.argv[1]);
  const n = m.natsConnectionCount();
  if (n !== 0) { process.stderr.write("natsConnectionCount()="+n+" after import\n"); process.exit(1); }
' "$RUNNER_SRC" || die "natsConnectionCount() was non-zero just from loading the runner module"

# Static backstop: `nats` is dynamically imported inside the factory only — never
# a top-level static import — so the module has zero transport cost until serve.
assert nats-import-is-dynamic-only
grep -qE "await import\('nats'\)" "$RUNNER_SRC" || die "expected a dynamic import('nats') in the runner"
if grep -nE "^import[^\n]*['\"]nats['\"]" "$RUNNER_SRC"; then
  die "runner has a top-level static 'nats' import — transport would load eagerly"
fi

# ============================================================================
# 10. Optional live-agent smoke — documented, never required.
# ============================================================================
if [ "${V5_E2E_LIVE:-0}" = "1" ]; then
  step "live claude -p smoke (V5_E2E_LIVE=1)"
  if command -v claude >/dev/null 2>&1; then
    # Document-only: a failure here does NOT fail the script.
    if claude -p "Reply with exactly: OK" 2>&1 | tee "$SCRATCH/claude.out" | grep -qi "OK"; then
      printf 'live smoke: claude -p responded (see %s)\n' "$SCRATCH/claude.out"
    else
      printf 'live smoke: claude -p did not return OK (non-fatal)\n'
    fi
  else
    printf 'live smoke: `claude` not on PATH — skipped (non-fatal)\n'
  fi
fi

step "PASS"
printf 'All assertions passed. v5 lifecycle ran on git documents + .genie/genie.db with zero daemons.\n'
