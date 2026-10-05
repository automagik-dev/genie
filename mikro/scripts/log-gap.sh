#!/usr/bin/env bash
set -euo pipefail

# log-gap.sh — CLI for logging dogfood gaps to gaps.jsonl
# Usage: ./scripts/log-gap.sh --id <id> --group <n> --task <task> --native-tool <tool>
#        --query <query> --answer <answer> --expected <expected> --type <type> --severity <sev>

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAPS_FILE="${REPO_ROOT}/gaps.jsonl"

# --- Parse arguments ---
ID="" GROUP="" TASK="" NATIVE_TOOL="" QUERY="" ANSWER="" EXPECTED="" TYPE="" SEVERITY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)       ID="$2"; shift 2 ;;
    --group)    GROUP="$2"; shift 2 ;;
    --task)     TASK="$2"; shift 2 ;;
    --native-tool) NATIVE_TOOL="$2"; shift 2 ;;
    --query)    QUERY="$2"; shift 2 ;;
    --answer)   ANSWER="$2"; shift 2 ;;
    --expected) EXPECTED="$2"; shift 2 ;;
    --type)     TYPE="$2"; shift 2 ;;
    --severity) SEVERITY="$2"; shift 2 ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# --- Validate required fields ---
missing=()
[[ -z "$ID" ]]          && missing+=("--id")
[[ -z "$GROUP" ]]       && missing+=("--group")
[[ -z "$TASK" ]]        && missing+=("--task")
[[ -z "$NATIVE_TOOL" ]] && missing+=("--native-tool")
[[ -z "$QUERY" ]]       && missing+=("--query")
[[ -z "$ANSWER" ]]      && missing+=("--answer")
[[ -z "$EXPECTED" ]]    && missing+=("--expected")
[[ -z "$TYPE" ]]        && missing+=("--type")
[[ -z "$SEVERITY" ]]    && missing+=("--severity")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: Missing required fields: ${missing[*]}" >&2
  echo "Usage: $0 --id <id> --group <n> --task <task> --native-tool <tool> --query <query> --answer <answer> --expected <expected> --type <type> --severity <severity>" >&2
  exit 1
fi

# --- Validate enums ---
VALID_TYPES="precision recall speed hallucination scope format"
VALID_SEVERITIES="critical high medium low"

if ! echo "$VALID_TYPES" | grep -qw "$TYPE"; then
  echo "ERROR: Invalid type '$TYPE'. Must be one of: $VALID_TYPES" >&2
  exit 1
fi

if ! echo "$VALID_SEVERITIES" | grep -qw "$SEVERITY"; then
  echo "ERROR: Invalid severity '$SEVERITY'. Must be one of: $VALID_SEVERITIES" >&2
  exit 1
fi

# --- Build JSON entry ---
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
STATUS="open"

# Use python3 for safe JSON serialization (handles special characters in strings)
JSON_LINE="$(python3 -c "
import json, sys
entry = {
    'id': sys.argv[1],
    'timestamp': sys.argv[2],
    'status': sys.argv[3],
    'v03_group': int(sys.argv[4]),
    'task': sys.argv[5],
    'native_tool': sys.argv[6],
    'mikro_query': sys.argv[7],
    'answer': sys.argv[8],
    'expected': sys.argv[9],
    'gap_type': sys.argv[10],
    'severity': sys.argv[11]
}
print(json.dumps(entry, ensure_ascii=False))
" "$ID" "$TIMESTAMP" "$STATUS" "$GROUP" "$TASK" "$NATIVE_TOOL" "$QUERY" "$ANSWER" "$EXPECTED" "$TYPE" "$SEVERITY")"

# --- Append to gaps.jsonl ---
echo "$JSON_LINE" >> "$GAPS_FILE"
echo "Logged gap '$ID' (type=$TYPE, severity=$SEVERITY) to gaps.jsonl"
exit 0
