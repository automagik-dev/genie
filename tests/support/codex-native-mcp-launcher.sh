#!/bin/sh
set -eu

if [ "$#" -lt 3 ]; then
  echo "usage: codex-native-mcp-launcher.sh RECORD ADAPTER_OR_DASH CANDIDATE [ARG ...]" >&2
  exit 64
fi

record_file=$1
adapter=$2
candidate=$3
shift 3

effective_cwd=$(pwd -P)
if cwd_identity=$(stat -f '%d:%i' . 2>/dev/null); then
  :
elif cwd_identity=$(stat -c '%d:%i' . 2>/dev/null); then
  :
else
  echo "codex-native-mcp-launcher: cannot stat effective cwd" >&2
  exit 70
fi

record_tmp="${record_file}.tmp.$$"
umask 077
{
  printf '%s\0' 'codex-native-mcp-launcher-v1'
  printf '%s\0' "$$"
  printf '%s\0' "$effective_cwd"
  printf '%s\0' "$cwd_identity"
  printf '%s\0' "$adapter"
  printf '%s\0' "$candidate"
  for argument in "$@"; do
    printf '%s\0' "$argument"
  done
} >"$record_tmp"
mv "$record_tmp" "$record_file"

if [ "$adapter" = '-' ]; then
  exec "$candidate" "$@"
fi
exec "$adapter" "$candidate" "$@"
