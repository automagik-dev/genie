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
#    writes `.genie/INDEX.md` and every machine-local `.genie/` ignore rule into
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

assert gitignore-has-every-machine-local-genie-rule
[ -f "$FIXTURE/.gitignore" ] || die "genie init did not create .gitignore"
for rule in '.genie/genie.db' '.genie/genie.db-wal' '.genie/genie.db-shm' '.genie/genie.db-recovery-lock' '.genie/roadmap-sync' '.genie/launch/'; do
  grep -qxF "$rule" "$FIXTURE/.gitignore" || die "genie init did not write the $rule ignore rule"
done

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
# 3b. `genie context --wish <slug> --plan` — the spawn-context preview (composed
#     branch + base SHA + ready tasks) while all 3 groups are ready, touching
#     NOTHING. The plan payload is what a spawn consumes, so it must be ONE
#     line of versioned JSON carrying a full 40-hex base SHA and all three
#     task ids. Read-only is proven by byte-identical genie.db plus an
#     unchanged .genie/ file set around the call. (This replaces the retired
#     `launch --dry-run` section — the preview survives as the context verb.)
#     The fixture gets a local `dev` branch so the config-free integration
#     policy (local dev wins) resolves without a remote.
# ============================================================================
step "context --plan (spawn preview, touches nothing)"
git -C "$FIXTURE" branch dev

CTX_OUT="$SCRATCH/context-plan.out"
db_fingerprint() {
  bun -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
}
# The genie.db-wal/-shm pair is SQLite-VFS-owned: the documented --plan
# carve-out on builds that reject the immutable URI form may recreate those
# two sidecars without genie writing through them, so the file-set comparison
# excludes the pair (mirroring context.test.ts's cross-platform bound) while
# the main-file hash proves no genie write reached the database.
genie_listing() {
  ls -A "$FIXTURE/.genie" | grep -vE '^genie\.db(-wal|-shm)?$' | sort
}
DB_BEFORE="$(db_fingerprint "$FIXTURE/.genie/genie.db")"
GENIE_LISTING_BEFORE="$(genie_listing)"

if ( cd "$FIXTURE" && bun "$DIST" context --wish "$SLUG" --plan ) > "$CTX_OUT" 2>&1; then
  CTX_RC=0
else
  CTX_RC=$?
fi
cat "$CTX_OUT"

assert context-plan-exit-0
[ "$CTX_RC" -eq 0 ] || die "context --plan exited $CTX_RC"

assert context-plan-is-one-line-of-versioned-json
[ "$(wc -l < "$CTX_OUT" | tr -d ' ')" -eq 1 ] || die "context --plan must emit exactly one line"
grep -q '"version":1' "$CTX_OUT" || die "context --plan did not emit a version 1 payload"

assert context-plan-names-wish-branch-and-base
grep -q "\"wish\":\"$SLUG\"" "$CTX_OUT" || die "context --plan payload does not name the wish"
grep -q "\"branch\":\"wish/$SLUG\"" "$CTX_OUT" || die "context --plan payload does not carry the composed wish branch"
grep -qE '"base":"[0-9a-f]{40}"' "$CTX_OUT" || die "context --plan base is not a full 40-hex SHA"

assert context-plan-carries-three-ready-tasks
[ "$(grep -o '"id"' "$CTX_OUT" | wc -l | tr -d ' ')" -eq 3 ] || die "expected 3 task ids in the context payload"

assert context-plan-touches-nothing
DB_AFTER="$(db_fingerprint "$FIXTURE/.genie/genie.db")"
[ "$DB_BEFORE" = "$DB_AFTER" ] || die "context --plan rewrote .genie/genie.db"
GENIE_LISTING_AFTER="$(genie_listing)"
NEW_FILES="$(comm -13 <(printf '%s\n' "$GENIE_LISTING_BEFORE") <(printf '%s\n' "$GENIE_LISTING_AFTER") || true)"
GONE_FILES="$(comm -23 <(printf '%s\n' "$GENIE_LISTING_BEFORE") <(printf '%s\n' "$GENIE_LISTING_AFTER") || true)"
[ -z "$NEW_FILES$GONE_FILES" ] || die "context --plan changed the .genie/ file set (+:$NEW_FILES -:$GONE_FILES)"

assert context-plan-materialized-no-worktrees
[ "$(git -C "$FIXTURE" worktree list --porcelain | grep -c '^worktree')" -eq 1 ] || die "context --plan materialized extra worktrees"

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
# `done` is the orchestrator's verb: completion needs no claimant identity.
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

# v6 drops `hire_roster` behind a forward-only user_version 1 -> 2 ladder, so a
# freshly created database stamps — and exports — schema 2.
assert export-schema-version-2
[ "$(json_schema_version < "$EXPORT")" -eq 2 ] || die "export schemaVersion != 2"

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
# 9b. Zero-transport guard — the omni runner was the ONLY code path that ever
#     touched a NATS transport, and v6 removed it. Prove two things:
#       (a) Black-box: the everyday commands (`--help`, `task`, `board`) work
#           under a fresh, empty GENIE_HOME, with every legacy OMNI_* variable
#           unset so no host leftover can change the answer, and `omni` is gone
#           from `--help`.
#       (b) Static: nothing in the shipped tree declares or imports a NATS
#           transport any more — not package.json, not src/. This is the
#           regression the old white-box natsConnectionCount() marker owned.
# ============================================================================
step "zero-transport guard (no omni command, no NATS anywhere)"
CLEAN_HOME="$SCRATCH/clean-home"
mkdir -p "$CLEAN_HOME"

# (a) Black-box: everyday commands succeed with a clean GENIE_HOME. Unset any
#     inherited OMNI_* env so a host leftover cannot mask a regression.
run_clean() { env -u OMNI_API_URL -u OMNI_API_KEY -u OMNI_INSTANCE -u OMNI_APPROVAL_CHAT \
  -u OMNI_APPROVALS_ENABLED -u OMNI_NATS_URL GENIE_HOME="$CLEAN_HOME" bun "$DIST" "$@"; }

assert help-works-on-a-clean-home
run_clean --help >/dev/null 2>&1 || die "genie --help failed on a clean GENIE_HOME"

assert help-lists-task-board-and-no-omni
CLEAN_HELP="$(run_clean --help 2>&1)"
for c in task board; do
  printf '%s\n' "$CLEAN_HELP" | grep -qE "^  $c( |\$)" || die "genie --help missing '$c' on a clean GENIE_HOME"
done
if printf '%s\n' "$CLEAN_HELP" | grep -qE "^  omni( |\$)"; then
  die "genie --help still lists the retired 'omni' command"
fi

assert omni-command-is-gone
if ( cd "$FIXTURE" && run_clean omni status --json >/dev/null 2>&1 ); then
  die "genie omni still runs — the command was supposed to be removed"
fi

assert task-list-works-on-a-clean-home
( cd "$FIXTURE" && run_clean task list --wish "$SLUG" --json >/dev/null 2>&1 ) \
  || die "genie task list failed on a clean GENIE_HOME"

assert board-works-on-a-clean-home
( cd "$FIXTURE" && run_clean board --wish "$SLUG" --json >/dev/null 2>&1 ) \
  || die "genie board failed on a clean GENIE_HOME"

# (b) Static: no NATS dependency and no NATS import survive anywhere.
assert no-nats-dependency-declared
if grep -qE '"(@nats-io/[a-z-]+|nats)"\s*:' "$REPO_ROOT/package.json"; then
  die "package.json still declares a NATS dependency"
fi

assert no-nats-import-in-src
if grep -rnE "from '(@nats-io/[a-z-]+|nats)'|import\('(@nats-io/[a-z-]+|nats)'\)" "$REPO_ROOT/src"; then
  die "src/ still imports a NATS transport"
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
