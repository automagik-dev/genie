#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SOURCE="$TMP/source"
INSTALL_DIR="$TMP/install"
BIN_DIR="$TMP/bin"

copy_worktree() {
  mkdir -p "$SOURCE"
  tar \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.DS_Store' \
    -C "$ROOT" \
    -cf - . | tar -C "$SOURCE" -xf -
}

commit_source() {
  git -C "$SOURCE" add -A
  git -C "$SOURCE" commit -m "$1" >/dev/null
}

copy_worktree

git init -b main "$SOURCE" >/dev/null
git -C "$SOURCE" config user.name "mikro-ci"
git -C "$SOURCE" config user.email "mikro-ci@example.invalid"
commit_source "test: seed install smoke source"
INITIAL_HEAD="$(git -C "$SOURCE" rev-parse HEAD)"

echo "==> Smoke install from local main checkout"
MIKRO_REPO_URL="$SOURCE" \
MIKRO_BRANCH=main \
MIKRO_INSTALL_DIR="$INSTALL_DIR" \
MIKRO_BIN_DIR="$BIN_DIR" \
  bash "$ROOT/scripts/install.sh"

INSTALLED_HEAD="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
if [ "$INSTALLED_HEAD" != "$INITIAL_HEAD" ]; then
  echo "::error::install head mismatch: installed=$INSTALLED_HEAD source=$INITIAL_HEAD" >&2
  exit 1
fi

"$BIN_DIR/mikro" --version || {
  echo "::error::installed mikro binary failed" >&2
  exit 1
}

echo "==> Smoke update dirty-check refusal"
printf '\n# dirty smoke\n' >> "$INSTALL_DIR/docs/release-contract.md"
printf 'untracked smoke\n' > "$INSTALL_DIR/untracked-smoke.txt"
if "$BIN_DIR/mikro" update >"$TMP/dirty.out" 2>"$TMP/dirty.err"; then
  echo "::error::mikro update succeeded despite dirty checkout" >&2
  cat "$TMP/dirty.out" >&2
  cat "$TMP/dirty.err" >&2
  exit 1
fi
if ! grep -q 'Refusing to update with local changes' "$TMP/dirty.err"; then
  echo "::error::dirty-check error message missing" >&2
  cat "$TMP/dirty.err" >&2
  exit 1
fi

echo "==> Smoke update --force happy path from advanced main"
printf '\nupdate-smoke=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" >> "$SOURCE/.mikro-update-smoke"
commit_source "test: advance main for update smoke"
TARGET_HEAD="$(git -C "$SOURCE" rev-parse HEAD)"

"$BIN_DIR/mikro" update --force
UPDATED_HEAD="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
if [ "$UPDATED_HEAD" != "$TARGET_HEAD" ]; then
  echo "::error::update head mismatch: installed=$UPDATED_HEAD source=$TARGET_HEAD" >&2
  exit 1
fi
if [ -e "$INSTALL_DIR/untracked-smoke.txt" ]; then
  echo "::error::mikro update --force did not clean untracked files" >&2
  exit 1
fi

echo "==> Install/update smoke passed"
echo "initial: $INITIAL_HEAD"
echo "target:  $TARGET_HEAD"
