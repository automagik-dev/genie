#!/usr/bin/env bash
# Approval-capture spike hook: the "genie side" of a remote approval.
# Wired to a Claude Code hook event (PermissionRequest or PreToolUse).
#
# Flow: read hook JSON on stdin -> enqueue a pending approval row ->
#       POLL the scratch store until resolved or the poll budget expires ->
#       emit the decision envelope on stdout.
#
# THROWAWAY prototype. Emits its own trace to stderr (visible in CC hook logs
# / --debug) and to a scratch log file so the live experiment is auditable.
set -euo pipefail

SPIKE_DIR="${SPIKE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=./store.sh
source "$SPIKE_DIR/store.sh"

# --- poll budget: MUST stay under the CC per-hook `timeout` (settings.json). ---
# CC default hook timeout is 600000ms (600s). We set timeout=30 (seconds) in
# settings.json for the live runs, so the poll budget below stays well under it.
POLL_BUDGET_SECONDS="${SPIKE_POLL_BUDGET:-20}"   # how long we hold the request
POLL_INTERVAL_MS="${SPIKE_POLL_INTERVAL_MS:-250}" # sqlite has no NOTIFY -> poll

LOG="$SPIKE_DIR/scratch-hook.log"
log() { printf '[hook %s] %s\n' "$(date +%H:%M:%S)" "$*" >>"$LOG"; echo "[spike-hook] $*" >&2; }

db_init

payload="$(cat)"
event="$(printf '%s' "$payload" | jq -r '.hook_event_name // "unknown"')"
tool="$(printf '%s' "$payload" | jq -r '.tool_name // "unknown"')"
tool_input="$(printf '%s' "$payload" | jq -c '.tool_input // {}')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // ""')"
sid="$(printf '%s' "$payload" | jq -r '.session_id // ""')"

# Deterministic id so an external resolver can target the row without guessing.
id="${SPIKE_APPROVAL_ID:-spike-approval}"

log "event=$event tool=$tool id=$id cwd=$cwd"
log "tool_input=$tool_input"
db_enqueue "$id" "$tool" "$tool_input" "$cwd" "$sid"
log "enqueued pending row id=$id; polling every ${POLL_INTERVAL_MS}ms for up to ${POLL_BUDGET_SECONDS}s"

# --- poll loop ---
deadline=$(( $(date +%s) + POLL_BUDGET_SECONDS ))
sleep_frac=$(awk "BEGIN{print $POLL_INTERVAL_MS/1000}")
status="pending"
while :; do
  status="$(db_status "$id" || echo pending)"
  [ "$status" != "pending" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    status="timeout"
    break
  fi
  sleep "$sleep_frac"
done
log "poll finished: status=$status"

# --- emit the decision envelope per the event's contract ---
emit_permissionrequest() {
  case "$1" in
    approved)
      printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
      log "emitted PermissionRequest decision.behavior=allow" ;;
    denied)
      printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied via remote approval (spike)"}}}\n'
      log "emitted PermissionRequest decision.behavior=deny" ;;
    *)  # timeout -> emit NOTHING: no decision means fall through to normal flow (ask)
      log "timeout/passthrough: emitting no decision (falls through to normal permission flow / ask)" ;;
  esac
}

emit_pretooluse() {
  case "$1" in
    approved)
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n'
      log "emitted PreToolUse permissionDecision=allow" ;;
    denied)
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Denied via remote approval (spike)"}}\n'
      log "emitted PreToolUse permissionDecision=deny" ;;
    *)  # timeout -> ask forces the normal interactive prompt
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}\n'
      log "emitted PreToolUse permissionDecision=ask (timeout fallback)" ;;
  esac
}

case "$event" in
  PermissionRequest) emit_permissionrequest "$status" ;;
  PreToolUse)        emit_pretooluse "$status" ;;
  *)                 log "unknown event $event; emitting nothing" ;;
esac
exit 0
