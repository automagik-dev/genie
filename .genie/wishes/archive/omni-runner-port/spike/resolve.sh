#!/usr/bin/env bash
# The "phone": simulates a remote operator resolving a pending approval.
# Usage: resolve.sh <approved|denied> [approval_id]
set -euo pipefail
SPIKE_DIR="${SPIKE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=./store.sh
source "$SPIKE_DIR/store.sh"

decision="${1:?usage: resolve.sh <approved|denied> [id]}"
id="${2:-${SPIKE_APPROVAL_ID:-spike-approval}}"

db_init
won="$(db_resolve "$id" "$decision" "phone")"
echo "resolve: id=$id decision=$decision rows_changed=$won"
if [ "$won" = "1" ]; then
  echo "resolve: WON the row (this resolver's decision is authoritative)"
else
  echo "resolve: row was not pending (already resolved or missing) -> no-op"
fi
