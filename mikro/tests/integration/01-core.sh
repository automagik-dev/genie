#!/usr/bin/env bash
# mikro Integration Tests — Group 1: Core Verification (Tests 1-9)
#
# Prerequisites:
#   - GEMINI_API_KEY environment variable set
#   - Node.js >= 18, Python 3.10+ installed
#
# Usage: cd /path/to/mikro && bash tests/integration/01-core.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_DIR"

CLI="node $PROJECT_DIR/dist/src/cli.js"
PASSED=0
FAILED=0
TOTAL=9

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

TMPDIR="/tmp/mikro-integration-$$"
mkdir -p "$TMPDIR"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

pass() { PASSED=$((PASSED + 1)); echo "  PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL: $1 — $2"; }

echo "=== mikro Integration Tests — Group 1: Core ==="
echo ""

# ─── Test 1: npm run build ───────────────────────────────────────────
echo "[1/9] npm run build"
if npm run build > /dev/null 2>&1; then
  pass "build succeeds"
else
  fail "build" "tsc compilation failed"
fi

# ─── Test 2: mikro init ──────────────────────────────────────────────
echo "[2/9] mikro init --dir"
INIT_DIR="$TMPDIR/init-test"
if $CLI init --dir "$INIT_DIR" > /dev/null 2>&1 && [ -f "$INIT_DIR/mikro.yaml" ]; then
  pass "init creates mikro.yaml"
else
  fail "init" "mikro.yaml not created"
fi

# ─── Test 3: basic query → JSON answer ──────────────────────────────
echo "[3/9] basic query returns JSON answer"
OUT3=$($CLI "What is 2+2? Reply ONLY the number." --thinking high --max-iterations 2 --output json 2>/dev/null) || true
ANSWER3=$(echo "$OUT3" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('answer',''))" 2>/dev/null) || true
if echo "$ANSWER3" | grep -q "4"; then
  pass "query returns answer containing '4'"
else
  fail "query" "answer='${ANSWER3:0:80}'"
fi

# ─── Test 4: context loading ────────────────────────────────────────
echo "[4/9] context loading with --tools standard"
OUT4=$(timeout 120 $CLI "How many files are in the context? Just count them." \
  --context "$PROJECT_DIR/src/" --tools standard --thinking high \
  --max-iterations 3 --output json --ext .ts 2>/dev/null) || true
ITERS4=$(echo "$OUT4" | python3 -c "import sys,json; print(json.load(sys.stdin).get('iterations',0))" 2>/dev/null) || true
FILE_COUNT=$(ls "$PROJECT_DIR/src/"*.ts 2>/dev/null | wc -l)
if [ "${ITERS4:-0}" -gt 0 ] && [ "$FILE_COUNT" -ge 17 ]; then
  pass "loaded ${FILE_COUNT} .ts files, ran ${ITERS4} iterations"
else
  fail "context" "iterations=${ITERS4:-0}, files=${FILE_COUNT}"
fi

# ─── Test 5: --stats output ─────────────────────────────────────────
echo "[5/9] --stats emits JSON stats"
# 5a: --output json --stats includes stats in stdout JSON
OUT5A=$(printf "test" | timeout 90 $CLI --stats --output json --max-iterations 2 2>/dev/null) || true
HAS_STATS=$(echo "$OUT5A" | python3 -c "import sys,json; d=json.load(sys.stdin); print('stats' in d and d['stats']['total_tokens']>0)" 2>/dev/null) || true
# 5b: text mode --stats emits stats JSON on stderr
printf "test" | timeout 90 $CLI --stats --max-iterations 2 > /dev/null 2>"$TMPDIR/stats-stderr.txt" || true
STDERR_OK=$(python3 -c "
import json
with open('$TMPDIR/stats-stderr.txt') as f:
    for line in f:
        try:
            d = json.loads(line.strip())
            if 'total_tokens' in d: print('True'); break
        except: pass
    else: print('False')
" 2>/dev/null) || true
if [ "$HAS_STATS" = "True" ] && [ "$STDERR_OK" = "True" ]; then
  pass "stats in JSON output and on stderr"
else
  fail "stats" "json_has_stats=${HAS_STATS:-?}, stderr_ok=${STDERR_OK:-?}"
fi

# ─── Test 6: JSONL log ──────────────────────────────────────────────
echo "[6/9] --log writes valid JSONL"
LOG_FILE="$TMPDIR/run.jsonl"
printf "test" | timeout 90 $CLI --log "$LOG_FILE" --max-iterations 2 > /dev/null 2>/dev/null || true
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
  JSONL_OK=$(python3 -c "
import json
events = []
with open('$LOG_FILE') as f:
    for line in f:
        d = json.loads(line.strip())
        events.append(d.get('event',''))
print('True' if 'run_start' in events and 'run_end' in events else 'False')
" 2>/dev/null) || true
  if [ "$JSONL_OK" = "True" ]; then
    pass "JSONL log with run_start + run_end"
  else
    fail "log" "missing expected events"
  fi
else
  fail "log" "file not created"
fi

# ─── Test 7: budget --max-cost ───────────────────────────────────────
echo "[7/9] --max-cost stops run"
OUT7=$(printf "Write a detailed essay about AI" | timeout 90 $CLI --max-cost 0.0001 --output json --max-iterations 10 2>/dev/null) || true
BUDGET_HIT=$(echo "$OUT7" | python3 -c "import sys,json; print(json.load(sys.stdin).get('budgetHit',''))" 2>/dev/null) || true
ITERS7=$(echo "$OUT7" | python3 -c "import sys,json; print(json.load(sys.stdin).get('iterations',0))" 2>/dev/null) || true
if [ "$BUDGET_HIT" = "max-cost" ] && [ "${ITERS7:-10}" -lt 10 ]; then
  pass "budget stopped run (budgetHit=max-cost, iterations=${ITERS7})"
else
  fail "budget" "budgetHit=${BUDGET_HIT:-none}, iterations=${ITERS7:-?}"
fi

# ─── Test 8: Python version check ───────────────────────────────────
echo "[8/9] Python version detection"
PY_CHECK=$(node -e "
import('./dist/src/detect.js').then(m => m.checkPythonVersion().then(v => console.log(JSON.stringify(v))));
" 2>/dev/null) || true
PY_VALID=$(echo "$PY_CHECK" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['valid'] and int(d['version'].split('.')[1])>=10)" 2>/dev/null) || true
PY_ERR=$(node -e "
import('./dist/src/detect.js').then(async m => {
  try { await m.checkPythonVersion('/nonexistent/python3'); console.log('no-error'); }
  catch(e) { console.log(e.message.includes('Python not found') ? 'graceful' : 'unexpected'); }
});
" 2>/dev/null) || true
if [ "$PY_VALID" = "True" ] && [ "$PY_ERR" = "graceful" ]; then
  pass "Python detected, graceful error on missing"
else
  fail "python" "valid=${PY_VALID:-?}, error=${PY_ERR:-?}"
fi

# ─── Test 9: REPL crash recovery ────────────────────────────────────
echo "[9/9] REPL crash recovery"
REPL_RESULT=$(node -e "
import('./dist/src/repl.js').then(async ({REPL}) => {
  const repl = new REPL();
  await repl.start();
  const r1 = await repl.execute('x = 42; print(x)');
  if (r1.stdout.trim() !== '42') { console.log('FAIL:exec1'); await repl.stop(); return; }
  const pid = repl['process']?.pid;
  if (pid) process.kill(pid, 'SIGKILL');
  await new Promise(r => setTimeout(r, 500));
  try {
    const r2 = await repl.execute('y = 99; print(y)');
    console.log(r2.stdout.trim() === '99' ? 'PASS' : 'FAIL:recovery_output');
  } catch(e) { console.log('FAIL:recovery_error'); }
  await repl.stop();
}).catch(e => console.log('FAIL:' + e.message));
" 2>/dev/null) || true
if [ "$REPL_RESULT" = "PASS" ]; then
  pass "crash recovery (kill + restart + re-execute)"
else
  fail "repl" "${REPL_RESULT:-no output}"
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
