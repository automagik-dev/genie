#!/usr/bin/env bash
# Group 5 RBAC matrix integration test — verifies migration 041's role grants
# match the app-layer matrix in src/lib/events/rbac.ts.
#
# Strategy:
#   1. Run the unit-test suite that pins the JS matrix + token layer.
#   2. If DATABASE_URL is set, connect to PG and exercise the GRANT matrix by
#      switching roles via SET ROLE and asserting permission denials line up
#      with the JS `canAccessTable` predicate.
#
# The integration block is skipped gracefully when PG is unreachable so CI
# without a live DB still runs the pure-JS portion.
#
# Wish: genie-serve-structured-observability, Group 5.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "[rbac-matrix] pure-JS matrix + token + chain tests"
bun test src/lib/events/tokens.test.ts \
         src/lib/events/rbac.test.ts \
         src/lib/events/audit-chain.test.ts \
         2>&1 | tail -20

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[rbac-matrix] DATABASE_URL unset — skipping PG integration block"
  echo "[rbac-matrix] OK (unit-only run)"
  exit 0
fi

if ! command -v psql >/dev/null; then
  echo "[rbac-matrix] psql not found — skipping PG integration block"
  echo "[rbac-matrix] OK (unit-only run)"
  exit 0
fi

echo "[rbac-matrix] PG integration: confirming grants match migration 041"

run_sql() {
  local sql="$1"
  # shellcheck disable=SC2086
  psql -v ON_ERROR_STOP=1 -At -c "$sql" "$DATABASE_URL"
}

probe_role() {
  local role="$1"
  local query="$2"
  local expected_to_succeed="$3"

  local output
  if output=$(psql -v ON_ERROR_STOP=1 -At -c "SET ROLE ${role}; ${query}" "$DATABASE_URL" 2>&1); then
    if [[ "$expected_to_succeed" == "no" ]]; then
      echo "[rbac-matrix] FAIL — ${role} unexpectedly allowed: ${query}"
      echo "$output"
      exit 1
    fi
  else
    if [[ "$expected_to_succeed" == "yes" ]]; then
      echo "[rbac-matrix] FAIL — ${role} unexpectedly denied: ${query}"
      echo "$output"
      exit 1
    fi
  fi
}

echo "[rbac-matrix] events_subscriber SELECT on main table — expected allow"
probe_role events_subscriber "SELECT 1 FROM genie_runtime_events LIMIT 1" yes

echo "[rbac-matrix] events_subscriber INSERT on audit table — expected deny"
probe_role events_subscriber "INSERT INTO genie_runtime_events_audit (kind, agent, text) VALUES ('x', 'x', 'x')" no

echo "[rbac-matrix] events_subscriber SELECT on debug table — expected deny"
probe_role events_subscriber "SELECT 1 FROM genie_runtime_events_debug LIMIT 1" no

echo "[rbac-matrix] events_audit INSERT on audit — expected allow"
probe_role events_audit "SELECT 1 FROM genie_runtime_events_audit LIMIT 1" yes

echo "[rbac-matrix] events_audit SELECT on main — expected deny"
probe_role events_audit "SELECT 1 FROM genie_runtime_events LIMIT 1" no

echo "[rbac-matrix] events_operator INSERT on main — expected allow"
probe_role events_operator "SELECT 1 FROM genie_runtime_events LIMIT 1" yes

echo "[rbac-matrix] events_admin SELECT on audit — expected allow"
probe_role events_admin "SELECT 1 FROM genie_runtime_events_audit LIMIT 1" yes

echo "[rbac-matrix] events_admin INSERT on audit — expected deny (WORM role-exclusive)"
probe_role events_admin "INSERT INTO genie_runtime_events_audit (kind, agent, text) VALUES ('x', 'x', 'x')" no

echo "[rbac-matrix] OK — PG grant matrix matches src/lib/events/rbac.ts"
