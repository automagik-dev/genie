#!/usr/bin/env bash
set -euo pipefail

# Probe router-for.me CLIProxyAPI Management API.
# Docs: https://help.router-for.me/management/api.html
#
# IMPORTANT: Remote IPs can be temporarily banned after ~5 consecutive auth failures.
# This script is designed to STOP EARLY on auth errors to avoid triggering that ban.

MGMT_BASE="${JUICE_MGMT_BASE:-https://juice.namastex.io/v0/management}"
KEY="${JUICE_MGMT_KEY:-}"
AUTH_MODE="${JUICE_MGMT_AUTH_MODE:-bearer}"   # bearer|x-management-key|both
TIMEOUT="${JUICE_TIMEOUT:-20}"
VERBOSE="${JUICE_VERBOSE:-0}"

if [[ -z "$KEY" ]]; then
  echo "ERROR: JUICE_MGMT_KEY is not set. Refusing to probe to avoid remote ban." >&2
  exit 2
fi

mgmt_headers() {
  local -a H
  H+=("Accept: application/json")
  case "$AUTH_MODE" in
    bearer) H+=("Authorization: Bearer ${KEY}") ;;
    x-management-key) H+=("X-Management-Key: ${KEY}") ;;
    both) H+=("Authorization: Bearer ${KEY}" "X-Management-Key: ${KEY}") ;;
    *) echo "ERROR: JUICE_MGMT_AUTH_MODE must be bearer|x-management-key|both (got: $AUTH_MODE)" >&2; exit 2 ;;
  esac
  printf '%s\n' "${H[@]}"
}

curl_status() {
  local method="$1" url="$2" data="${3:-}" content_type="${4:-application/json}"
  local -a args
  args+=("--silent" "--show-error" "--location" "--max-time" "$TIMEOUT" "--request" "$method" "$url")
  while IFS= read -r h; do args+=("--header" "$h"); done < <(mgmt_headers)
  if [[ -n "$data" ]]; then
    args+=("--header" "Content-Type: ${content_type}" "--data" "$data")
  fi
  curl "${args[@]}" --output /tmp/juice-mgmt-probe-body.$$ --write-out "%{http_code}" || echo "000"
}

should_stop_on_auth_error() {
  local code="$1"
  [[ "$code" != "401" && "$code" != "403" ]] && return 1
  local body
  body="$(head -c 4000 /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true)"
  if echo "$body" | grep -qiE 'missing management key|invalid management key|IP banned'; then
    return 0
  fi
  return 1
}

print_check() {
  local label="$1" method="$2" url="$3" data="${4:-}" ct="${5:-application/json}"
  local code
  code="$(curl_status "$method" "$url" "$data" "$ct")"
  if [[ "$code" =~ ^2 ]]; then
    echo "PASS  $label  ($code)"
    if [[ "$VERBOSE" == "1" ]]; then
      echo "---- body ----"
      cat /tmp/juice-mgmt-probe-body.$$ || true
      echo
      echo "------------"
    fi
  else
    echo "FAIL  $label  ($code)"
    echo "---- body (first 1200 bytes) ----"
    head -c 1200 /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true
    echo
    echo "---------------------------------"
  fi

  if should_stop_on_auth_error "$code"; then
    echo "STOP  (auth error detected — stopping early to avoid triggering remote ban)"
    return 99
  fi

  return 0
}

cat <<EOF
# Juice management probe
MGMT_BASE=$MGMT_BASE
AUTH_MODE=$AUTH_MODE
EOF

echo

run() {
  local label="$1" method="$2" url="$3" data="${4:-}" ct="${5:-application/json}"
  print_check "$label" "$method" "$url" "$data" "$ct"
  local rc=$?
  if [[ $rc -eq 99 ]]; then
    exit 3
  fi
}

# Read-only endpoints (safe, if authorized)
run "GET /latest-version" GET "$MGMT_BASE/latest-version"
run "GET /debug" GET "$MGMT_BASE/debug"
run "GET /usage-statistics-enabled" GET "$MGMT_BASE/usage-statistics-enabled"

run "GET /usage" GET "$MGMT_BASE/usage"
if command -v jq >/dev/null 2>&1 && [[ "$VERBOSE" != "1" ]]; then
  echo "  summary: $(jq -r '"total_requests=" + ((.usage.total_requests // 0)|tostring) + ", failures=" + ((.usage.failure_count // 0)|tostring) + ", tokens=" + ((.usage.total_tokens // 0)|tostring)' /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true)"
fi

run "GET /config" GET "$MGMT_BASE/config"
if command -v jq >/dev/null 2>&1 && [[ "$VERBOSE" != "1" ]]; then
  echo "  providers(openai-compat): $(jq -r '(."openai-compatibility" // []) | map(.name) | join(", ") | if .=="" then "(none)" else . end' /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true)"
  echo "  keys: claude=$(jq -r '(."claude-api-key" // [])|length' /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true), codex=$(jq -r '(."codex-api-key" // [])|length' /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true), gemini=$(jq -r '(."gemini-api-key" // [])|length' /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true)"
  echo "  flags: request-log=$(jq -r '."request-log" // "?"' /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true), ws-auth=$(jq -r '."ws-auth" // "?"' /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true)"
fi

run "GET /request-log" GET "$MGMT_BASE/request-log"
run "GET /request-retry" GET "$MGMT_BASE/request-retry"
run "GET /max-retry-interval" GET "$MGMT_BASE/max-retry-interval"
run "GET /ws-auth" GET "$MGMT_BASE/ws-auth"
run "GET /logging-to-file" GET "$MGMT_BASE/logging-to-file"
run "GET /openai-compatibility" GET "$MGMT_BASE/openai-compatibility"
run "GET /claude-api-key" GET "$MGMT_BASE/claude-api-key"
run "GET /codex-api-key" GET "$MGMT_BASE/codex-api-key"
run "GET /gemini-api-key" GET "$MGMT_BASE/gemini-api-key"
run "GET /oauth-excluded-models" GET "$MGMT_BASE/oauth-excluded-models"
run "GET /auth-files" GET "$MGMT_BASE/auth-files"

# Logs are only available if logging-to-file is enabled.
run "GET /logs" GET "$MGMT_BASE/logs"

echo
cat <<'EOF'
# Notes
# - This script refuses to run without a management key.
# - It stops early on auth errors to avoid triggering the remote-IP ban.
# - Use JUICE_VERBOSE=1 to print full JSON bodies.
EOF

rm -f /tmp/juice-mgmt-probe-body.$$ 2>/dev/null || true
