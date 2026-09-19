#!/usr/bin/env bash
# The "phone", realistic ordering: wait until a pending approval row appears
# (i.e. the hook has enqueued and is holding the request), then resolve it.
# This mirrors the real flow — the operator only replies AFTER the approval
# request notification arrives.
# Usage: wait-resolve.sh <approved|denied> <id> [max_wait_s] [delay_after_appear_s]
set -euo pipefail
SPIKE_DIR="${SPIKE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=./store.sh
source "$SPIKE_DIR/store.sh"

decision="${1:?usage: wait-resolve.sh <approved|denied> <id> [max_wait_s] [delay_s]}"
id="${2:?need approval id}"
max_wait="${3:-60}"
delay="${4:-1}"

db_init
deadline=$(( $(date +%s) + max_wait ))
while :; do
  st="$(db_status "$id" 2>/dev/null || echo '')"
  [ "$st" = "pending" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "wait-resolve: TIMED OUT waiting for pending row id=$id (never appeared)"
    exit 1
  fi
  sleep 0.2
done
echo "wait-resolve: saw pending row id=$id; simulating operator think-time ${delay}s then '$decision'"
sleep "$delay"
won="$(db_resolve "$id" "$decision" "phone")"
echo "wait-resolve: id=$id decision=$decision rows_changed=$won ($([ "$won" = 1 ] && echo WON || echo no-op))"
