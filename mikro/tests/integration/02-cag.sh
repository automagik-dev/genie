#!/usr/bin/env bash
# mikro Integration Tests — Group 2: CAG Verification (Tests 10-14)
#
# Prerequisites:
#   - GEMINI_API_KEY environment variable set
#   - Node.js >= 18, Python 3.10+ installed
#   - Project built (npm run build)
#
# Usage: cd /path/to/mikro && bash tests/integration/02-cag.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

CLI="node $PROJECT_DIR/dist/src/cli.js"
PASSED=0
FAILED=0
TOTAL=5

# Load API key from tools/.env if not already set
if [ -z "${GEMINI_API_KEY:-}" ]; then
  if [ -f /home/genie/tools/.env ]; then
    while IFS='=' read -r key value; do
      [[ -z "$key" || "$key" =~ ^# ]] && continue
      export "$key=$value"
    done < /home/genie/tools/.env
  fi
fi

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "FATAL: GEMINI_API_KEY not set"
  exit 1
fi

TMPDIR="/tmp/mikro-cag-$$"
mkdir -p "$TMPDIR"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

pass() { PASSED=$((PASSED + 1)); echo "  PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1 — $2"; }

echo "=== mikro Integration Tests — Group 2: CAG ==="
echo ""

# ─── Test 10: --cache increases input token count ────────────────────
echo "[10/14] --cache puts full context in system prompt"
# Run without cache
NO_CACHE=$(printf "What is 2+2?" | timeout 90 $CLI \
  --stats --output json --max-iterations 2 2>/dev/null) || true
NC_TOKENS=$(echo "$NO_CACHE" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['usage']['inputTokens'])" 2>/dev/null) || true

# Run with cache + context
WITH_CACHE=$(printf "What is 2+2?" | timeout 90 $CLI \
  --cache --context ./src/ --ext .ts --stats --output json --max-iterations 2 2>/dev/null) || true
WC_TOKENS=$(echo "$WITH_CACHE" | python3 -c \
  "import sys,json; print(json.load(sys.stdin)['usage']['inputTokens'])" 2>/dev/null) || true

if [ -n "$NC_TOKENS" ] && [ -n "$WC_TOKENS" ]; then
  if python3 -c "
nc = int($NC_TOKENS)
wc = int($WC_TOKENS)
assert wc > nc * 2, f'cached tokens ({wc}) should be much higher than non-cached ({nc})'
" 2>/dev/null; then
    pass "cached=${WC_TOKENS} >> non-cached=${NC_TOKENS}"
  else
    fail "token comparison" "cached=${WC_TOKENS}, non-cached=${NC_TOKENS}"
  fi
else
  fail "token comparison" "could not parse token counts"
fi

# ─── Test 11: second --cache query shows cache hit ───────────────────
echo "[11/14] second --cache query shows cache hit in stats"
# Run 1 — prime the cache
RUN1=$(printf "What is 2+2?" | timeout 90 $CLI \
  --cache --context ./src/ --ext .ts --stats --output json --max-iterations 2 2>/dev/null) || true
R1_HIT=$(echo "$RUN1" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('stats',{}).get('cache',{}).get('hit',False))" 2>/dev/null) || true

# Run 2 — should hit the cache
RUN2=$(printf "What is 3+3?" | timeout 90 $CLI \
  --cache --context ./src/ --ext .ts --stats --output json --max-iterations 2 2>/dev/null) || true
R2_HIT=$(echo "$RUN2" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('stats',{}).get('cache',{}).get('hit',False))" 2>/dev/null) || true
R2_READ=$(echo "$RUN2" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('stats',{}).get('cache',{}).get('tokens_read',0))" 2>/dev/null) || true

if [ "$R2_HIT" = "True" ] && [ "${R2_READ:-0}" -gt 0 ]; then
  pass "run2 cache_hit=True, tokens_read=${R2_READ}"
else
  fail "cache hit" "run1_hit=${R1_HIT:-?}, run2_hit=${R2_HIT:-?}, read=${R2_READ:-0}"
fi

# ─── Test 12: batch processing ───────────────────────────────────────
echo "[12/14] batch processes multiple questions"
printf "What is 2+2?\nWhat is 3+3?" > "$TMPDIR/qs.txt"
timeout 120 $CLI batch "$TMPDIR/qs.txt" --cache --max-iterations 1 \
  > "$TMPDIR/batch-out.jsonl" 2>/dev/null || true

if [ -f "$TMPDIR/batch-out.jsonl" ] && [ -s "$TMPDIR/batch-out.jsonl" ]; then
  BATCH_OK=$(python3 -c "
import json
lines = []
with open('$TMPDIR/batch-out.jsonl') as f:
    for line in f:
        lines.append(json.loads(line.strip()))
questions = [l for l in lines if 'question' in l]
aggregates = [l for l in lines if l.get('type') == 'aggregate']
ok = len(questions) == 2 and len(aggregates) == 1 and aggregates[0]['completed'] == 2
print('True' if ok else 'False')
" 2>/dev/null) || true

  LINE_COUNT=$(wc -l < "$TMPDIR/batch-out.jsonl")
  if [ "$BATCH_OK" = "True" ]; then
    pass "batch: ${LINE_COUNT} JSONL lines (2 answers + 1 aggregate)"
  else
    fail "batch" "unexpected format (${LINE_COUNT} lines)"
  fi
else
  fail "batch" "no output"
fi

# ─── Test 13: cache --estimate ───────────────────────────────────────
echo "[13/14] cache --estimate shows token count"
ESTIMATE=$($CLI cache --context ./src/ --estimate --ext .ts 2>/dev/null) || true
EST_TOKENS=$(echo "$ESTIMATE" | grep "estimated tokens" | grep -o '[0-9,]*' | tr -d ',') || true
if [ "${EST_TOKENS:-0}" -gt 0 ]; then
  pass "estimated ${EST_TOKENS} tokens"
else
  fail "estimate" "no token count found"
fi

# ─── Test 14: cache TTL in mikro.yaml ────────────────────────────────
echo "[14/14] cache TTL config parsed without error"
TTL_DIR="$TMPDIR/ttl-test"
mkdir -p "$TTL_DIR"
cat > "$TTL_DIR/mikro.yaml" << 'YAML'
model:
  provider: google
  model: gemini-3.1-flash-lite-preview
cache:
  enabled: true
  retention: long
  ttl: 7200
  session-prefix: integration-test
system: |
  You are a helpful assistant.
criteria: |
  Be concise.
YAML
echo "test context" > "$TTL_DIR/ctx.md"

TTL_OUT=$(cd "$TTL_DIR" && printf "What is 1+1?" | timeout 60 node "$PROJECT_DIR/dist/src/cli.js" \
  --cache --context ./ctx.md --output json --max-iterations 1 2>/dev/null) || true

TTL_OK=$(echo "$TTL_OUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('True' if d.get('answer') and d.get('model') else 'False')
" 2>/dev/null) || true

# Also verify config parsing directly
CFG_OK=$(node -e "
import('$PROJECT_DIR/dist/src/config.js').then(m => m.loadConfig('$TTL_DIR').then(c => {
  console.log(c.cache.ttl === 7200 && c.cache.sessionPrefix === 'integration-test' ? 'True' : 'False');
})).catch(() => console.log('False'));
" 2>/dev/null) || true

if [ "$TTL_OK" = "True" ] && [ "$CFG_OK" = "True" ]; then
  pass "TTL=7200, session-prefix parsed OK"
else
  fail "ttl" "query_ok=${TTL_OK:-?}, config_ok=${CFG_OK:-?}"
fi

# ─── Summary ─────────────────────────────────────────────────────────
echo ""
echo "=== Results: ${PASSED}/${TOTAL} passed, ${FAILED}/${TOTAL} failed ==="
if [ "$FAILED" -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
