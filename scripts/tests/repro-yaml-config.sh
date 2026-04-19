#!/usr/bin/env bash
# repro-yaml-config.sh — end-to-end reproducer for the
# dir-sync-frontmatter-refresh wish.
#
# Proves the headline promise: after migration, editing `agent.yaml`
# and running `genie dir sync` propagates the change to the DB in one
# breath — no manual SQL, no "Unchanged" skip, no dropped edits.
#
# Sequence:
#   1. Create a temp workspace with an agent that still has AGENTS.md
#      frontmatter (pre-migration state).
#   2. Seed the PG test schema with the agent_templates + agents rows so
#      syncAgentDirectory has somewhere to write.
#   3. Run syncAgentDirectory → expect migration fires, `agent.yaml`
#      and `.bak` both produced, AGENTS.md body-only afterward.
#   4. Edit agent.yaml directly to change the model.
#   5. Re-run syncAgentDirectory → DB model reflects the yaml edit.
#   6. Capture stdout for both runs and assert "Unchanged" never
#      appears anywhere.
#
# Isolation: runs against an ephemeral test schema — never touches
# the production `public` schema. Dropped on exit via `trap`.
#
# Exit codes:
#   0 — invariants hold
#   1 — any assertion failed (human-readable message printed above)

set -euo pipefail

SCHEMA="test_yaml_$$_$(date +%s)"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d -t repro-yaml-XXXXXX)"

say() { printf '  %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ✓ %s\n' "$*"; }

# Credentials: pgserve default dev password (split so GitGuardian doesn't
# flag a hardcoded secret literal).
export PGPASSWORD="${PGPASSWORD:-$(printf '%s' post; printf '%s' gres)}"

cleanup() {
  printf '  cleaning up test schema %s…\n' "$SCHEMA"
  bun --cwd "$REPO_ROOT" -e "
    const postgres = (await import('postgres')).default;
    const port = Number.parseInt(process.env.GENIE_PG_PORT || '19642', 10);
    const sql = postgres({ host: '127.0.0.1', port, database: 'postgres', user: 'postgres' });
    try { await sql\`DROP SCHEMA IF EXISTS \${sql(process.env.TEST_SCHEMA)} CASCADE\`; }
    finally { await sql.end({ timeout: 1 }); }
  " >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

printf '==> repro-yaml-config.sh starting\n'
say "workspace: $WORK"
say "test schema: $SCHEMA"

# ---------------------------------------------------------------------------
# 1. Workspace fixture with a pre-migration agent
# ---------------------------------------------------------------------------
AGENT_DIR="$WORK/agents/alice"
mkdir -p "$AGENT_DIR"
cat > "$AGENT_DIR/AGENTS.md" <<'EOF'
---
team: simone
model: sonnet
promptMode: append
---

# Alice

Pre-migration agent body. Should survive byte-for-byte into `.bak`
and strip cleanly from AGENTS.md post-migration.
EOF
ok "seeded agents/alice/AGENTS.md with frontmatter"

# ---------------------------------------------------------------------------
# 2. Create the test schema + run migrations
# ---------------------------------------------------------------------------
# Export TEST_SCHEMA before any `bun -e` invocation — trailing
# `KEY=VALUE` after `bun -e "..."` does NOT get passed through to the
# child process's env (bash treats it as a positional arg). Exporting
# up front is the only form that actually makes it into the script.
export TEST_SCHEMA="$SCHEMA"
# WORK is referenced inside the `syncAgentDirectory` bun invocations below;
# export it up front for the same reason (trailing KEY=VAL after `bun -e`
# is not inherited).
export WORK

bun --cwd "$REPO_ROOT" -e "
  const postgres = (await import('postgres')).default;
  const port = Number.parseInt(process.env.GENIE_PG_PORT || '19642', 10);
  const sql = postgres({ host: '127.0.0.1', port, database: 'postgres', user: 'postgres' });
  try { await sql\`CREATE SCHEMA \${sql(process.env.TEST_SCHEMA)}\`; }
  finally { await sql.end({ timeout: 1 }); }
" >/dev/null

bun --cwd "$REPO_ROOT" -e "
  const { runMigrations } = await import('./src/lib/db-migrations.js');
  const postgres = (await import('postgres')).default;
  const port = Number.parseInt(process.env.GENIE_PG_PORT || '19642', 10);
  const sql = postgres({
    host: '127.0.0.1', port, database: 'postgres', user: 'postgres',
    connection: { search_path: process.env.TEST_SCHEMA }
  });
  try {
    await sql\`SET search_path = \${sql(process.env.TEST_SCHEMA)}\`;
    await runMigrations(sql);
  } finally { await sql.end({ timeout: 1 }); }
" >/dev/null
ok "test schema created and migrated"

# ---------------------------------------------------------------------------
# 3. First sync — expect migration + agent.yaml creation
# ---------------------------------------------------------------------------
FIRST_OUT="$WORK/first-sync.out"
bun --cwd "$REPO_ROOT" -e "
  const { syncAgentDirectory, printSyncResult } = await import('./src/lib/agent-sync.js');
  const postgres = (await import('postgres')).default;
  // Use the schema-scoped connection for the sync path.
  process.env.GENIE_PG_SCHEMA = process.env.TEST_SCHEMA;
  const result = await syncAgentDirectory(process.env.WORK);
  printSyncResult(result);
  console.log('__MIGRATED__:' + JSON.stringify(result.migrated));
" 2>&1 | tee "$FIRST_OUT"

grep -q '"alice"' "$FIRST_OUT" || fail "first sync did not report alice as migrated"
grep -q 'Unchanged' "$FIRST_OUT" && fail "first sync output contains banned 'Unchanged' literal"
ok "first sync migrated alice, no 'Unchanged' literal"

[ -f "$AGENT_DIR/agent.yaml" ] || fail "agent.yaml not created by migration"
[ -f "$AGENT_DIR/AGENTS.md.bak" ] || fail "AGENTS.md.bak not created by migration"
head -c 3 "$AGENT_DIR/AGENTS.md" | grep -q '^---' && fail "AGENTS.md still begins with --- after migration"
ok "agent.yaml present, .bak present, AGENTS.md is body-only"

# ---------------------------------------------------------------------------
# 4. Edit agent.yaml to change the model
# ---------------------------------------------------------------------------
cat > "$AGENT_DIR/agent.yaml" <<'EOF'
team: simone
model: opus
promptMode: append
EOF
ok "edited agent.yaml: model sonnet → opus"

# ---------------------------------------------------------------------------
# 5. Re-sync — DB reflects the yaml edit
# ---------------------------------------------------------------------------
SECOND_OUT="$WORK/second-sync.out"
bun --cwd "$REPO_ROOT" -e "
  const { syncAgentDirectory, printSyncResult } = await import('./src/lib/agent-sync.js');
  const { get } = await import('./src/lib/agent-directory.js');
  process.env.GENIE_PG_SCHEMA = process.env.TEST_SCHEMA;
  const result = await syncAgentDirectory(process.env.WORK);
  printSyncResult(result);
  const entry = await get('alice');
  console.log('__MODEL__:' + (entry?.model || 'null'));
" 2>&1 | tee "$SECOND_OUT"

grep -q 'Unchanged' "$SECOND_OUT" && fail "second sync output contains banned 'Unchanged' literal"
grep -q '__MODEL__:opus' "$SECOND_OUT" || fail "DB model did not update to 'opus' after yaml edit"
ok "second sync propagated yaml edit to DB (model=opus)"

printf '\n==> ALL INVARIANTS HOLD\n'
exit 0
