#!/usr/bin/env bash
set -euo pipefail

BASE="${JUICE_BASE:-https://juice.namastex.io}"
BASE="${BASE%/}"
V1_BASE="$BASE"
if [[ "$BASE" != */v1 ]]; then V1_BASE="$BASE/v1"; fi

KEY="${JUICE_API_KEY:-}"
AUTH_MODE="${JUICE_AUTH_MODE:-bearer}"  # bearer|x-api-key|both|none
MODEL="${JUICE_MODEL:-}"
TIMEOUT="${JUICE_TIMEOUT:-20}"
VERBOSE="${JUICE_VERBOSE:-0}"

if [[ -z "$KEY" && "$AUTH_MODE" != "none" ]]; then
  echo "ERROR: JUICE_API_KEY is not set. Export JUICE_API_KEY or set JUICE_AUTH_MODE=none for unauth probes." >&2
  exit 2
fi

mk_headers() {
  local -a H
  H+=("Content-Type: application/json")
  case "$AUTH_MODE" in
    bearer)   H+=("Authorization: Bearer ${KEY}") ;;
    x-api-key) H+=("x-api-key: ${KEY}") ;;
    both)     H+=("Authorization: Bearer ${KEY}" "x-api-key: ${KEY}") ;;
    none)     : ;;
    *) echo "ERROR: JUICE_AUTH_MODE must be bearer|x-api-key|both|none (got: $AUTH_MODE)" >&2; exit 2 ;;
  esac
  printf '%s\n' "${H[@]}"
}

curl_status() {
  local method="$1" url="$2" data="${3:-}"
  local -a args
  args+=("--silent" "--show-error" "--location" "--max-time" "$TIMEOUT" "--request" "$method" "$url")
  while IFS= read -r h; do args+=("--header" "$h"); done < <(mk_headers)
  if [[ -n "$data" ]]; then args+=("--data" "$data"); fi
  curl "${args[@]}" --output /tmp/juice-probe-body.$$ --write-out "%{http_code}" || echo "000"
}

print_check() {
  local label="$1" method="$2" url="$3" data="${4:-}"
  local code
  code="$(curl_status "$method" "$url" "$data")"
  if [[ "$code" =~ ^2 ]]; then
    echo "PASS  $label  ($code)  $url"
    if [[ "$VERBOSE" == "1" ]]; then
      echo "---- body ----"
      cat /tmp/juice-probe-body.$$ || true
      echo
      echo "------------"
    fi
    return 0
  else
    echo "FAIL  $label  ($code)  $url"
    echo "---- body (first 800 bytes) ----"
    head -c 800 /tmp/juice-probe-body.$$ 2>/dev/null || true
    echo
    echo "--------------------------------"
    return 1
  fi
}

maybe_pick_model_from_body() {
  [[ -n "$MODEL" ]] && return 0
  if command -v jq >/dev/null 2>&1; then
    MODEL="$(jq -r '.data[0].id // empty' /tmp/juice-probe-body.$$ 2>/dev/null || true)"
  else
    MODEL="$(grep -o '"id"\s*:\s*"[^"]\+"' /tmp/juice-probe-body.$$ | head -n1 | sed -E 's/.*"id"\s*:\s*"([^"]+)".*/\1/' || true)"
  fi
}

cat <<EOF
# Juice probe
BASE=$BASE
V1_BASE=$V1_BASE
AUTH_MODE=$AUTH_MODE
MODEL=${MODEL:-"(auto)"}
EOF

# 1) OpenAI-style model listing
if print_check "openai GET /v1/models" GET "$V1_BASE/models"; then
  if command -v jq >/dev/null 2>&1 && [[ "$VERBOSE" != "1" ]]; then
    echo "  models(count): $(jq -r '(.data // []) | length' /tmp/juice-probe-body.$$ 2>/dev/null || true)"
    echo "  models(sample): $(jq -r '(.data // []) | map(.id) | .[0:10] | join(", ")' /tmp/juice-probe-body.$$ 2>/dev/null || true)"
  fi
  maybe_pick_model_from_body
fi

# Fallback if we still don't have a model
MODEL="${MODEL:-claude-3-5-sonnet-20241022}"
echo "Using MODEL=$MODEL"

# 2) OpenAI Chat Completions
print_check "openai POST /v1/chat/completions" POST "$V1_BASE/chat/completions" \
  "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":16}" || true

# 3) OpenAI Responses (new)
print_check "openai POST /v1/responses" POST "$V1_BASE/responses" \
  "{\"model\":\"$MODEL\",\"input\":\"ping\",\"max_output_tokens\":16}" || true

# 4) Legacy OpenAI completions
print_check "openai POST /v1/completions" POST "$V1_BASE/completions" \
  "{\"model\":\"$MODEL\",\"prompt\":\"ping\",\"max_tokens\":16}" || true

# 5) Anthropic Messages (try both common base URLs)
#    Note: many Anthropic-compatible proxies require x-api-key + anthropic-version.
#    You can run with: JUICE_AUTH_MODE=x-api-key ./scripts/juice-probe.sh
anthropic_headers() {
  mk_headers
  echo "anthropic-version: 2023-06-01"
}

curl_status_anthropic() {
  local method="$1" url="$2" data="${3:-}"
  local -a args
  args+=("--silent" "--show-error" "--location" "--max-time" "$TIMEOUT" "--request" "$method" "$url")
  while IFS= read -r h; do args+=("--header" "$h"); done < <(anthropic_headers)
  if [[ -n "$data" ]]; then args+=("--data" "$data"); fi
  curl "${args[@]}" --output /tmp/juice-probe-body.$$ --write-out "%{http_code}" || echo "000"
}

print_check_anthropic() {
  local label="$1" method="$2" url="$3" data="${4:-}"
  local code
  code="$(curl_status_anthropic "$method" "$url" "$data")"
  if [[ "$code" =~ ^2 ]]; then
    echo "PASS  $label  ($code)  $url"
    if [[ "$VERBOSE" == "1" ]]; then
      echo "---- body ----"
      cat /tmp/juice-probe-body.$$ || true
      echo
      echo "------------"
    fi
    return 0
  else
    echo "FAIL  $label  ($code)  $url"
    echo "---- body (first 800 bytes) ----"
    head -c 800 /tmp/juice-probe-body.$$ 2>/dev/null || true
    echo
    echo "--------------------------------"
    return 1
  fi
}

print_check_anthropic "anthropic POST /v1/messages" POST "$V1_BASE/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" || true

# Some proxies mount Anthropic at /messages (no /v1)
print_check_anthropic "anthropic POST /messages" POST "$BASE/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" || true

echo
cat <<EOF
# Interpretation / what to use in OpenClaw
# - If /v1/responses PASSes -> prefer api=openai-responses.
# - Else if /v1/chat/completions PASSes -> use api=openai-completions.
# - Else if /v1/messages PASSes -> use api=anthropic-messages.
# - On FAIL, the script prints the first 800 bytes of the response body (error details).
EOF

rm -f /tmp/juice-probe-body.$$ 2>/dev/null || true
