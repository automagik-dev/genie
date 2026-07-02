#!/usr/bin/env bash
# Shared scratch-store helpers for the approval-capture spike.
# THROWAWAY: uses a scratch sqlite file, NOT the real genie.db.
# Mirrors the eventual bun:sqlite `approvals` queue shape at a tiny scale.
#
# INVARIANT: these helpers never write to stdout except db_status (the status
# string) and db_resolve (the rows-changed count). The hook depends on a clean
# stdout so the ONLY thing CC reads is the decision envelope.
set -euo pipefail

SPIKE_DIR="${SPIKE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
DB="${SPIKE_DB:-$SPIKE_DIR/scratch-approvals.db}"

db_init() {
  # PRAGMA journal_mode echoes "wal"; redirect all of it to /dev/null so it
  # never pollutes the hook's stdout envelope.
  sqlite3 "$DB" >/dev/null <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  tool_name    TEXT NOT NULL,
  tool_input   TEXT,
  cwd          TEXT,
  session_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|denied|expired
  reason       TEXT,
  requested_at INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolved_by  TEXT
);
SQL
}

_sql_escape() { printf '%s' "$1" | sed "s/'/''/g"; }

# enqueue <id> <tool_name> <tool_input_json> <cwd> <session_id>
db_enqueue() {
  local id="$1" tool="$2" input="$3" cwd="$4" sid="$5" now
  now="$(date +%s)"
  sqlite3 "$DB" >/dev/null "INSERT OR IGNORE INTO approvals
     (id, tool_name, tool_input, cwd, session_id, status, requested_at)
     VALUES ('$(_sql_escape "$id")', '$(_sql_escape "$tool")', '$(_sql_escape "$input")',
             '$(_sql_escape "$cwd")', '$(_sql_escape "$sid")', 'pending', $now);"
}

# status <id>  -> prints current status
db_status() {
  sqlite3 "$DB" "SELECT status FROM approvals WHERE id='$(_sql_escape "$1")';"
}

# resolve <id> <approved|denied> <resolved_by> -> prints rows changed (1 = this
# caller won the pending->resolved transition; 0 = already resolved / missing).
# UPDATE and changes() run in ONE connection so the count is accurate.
db_resolve() {
  local id="$1" decision="$2" by="${3:-resolver}" now
  now="$(date +%s)"
  sqlite3 "$DB" "UPDATE approvals SET status='$(_sql_escape "$decision")', resolved_at=$now,
                   resolved_by='$(_sql_escape "$by")'
                 WHERE id='$(_sql_escape "$id")' AND status='pending';
                 SELECT changes();"
}
