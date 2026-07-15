#!/usr/bin/env bash

set -euo pipefail

: "${VERSION:?VERSION is required}"
: "${CHANNEL:?CHANNEL is required}"
RELEASE_REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
: "${RELEASE_REPOSITORY:?RELEASE_REPOSITORY or GITHUB_REPOSITORY is required}"
RELEASED_AT="${RELEASED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
[[ "$VERSION" =~ $VERSION_RE ]] || {
  echo "invalid release manifest version: ${VERSION}" >&2
  exit 2
}
[[ "$RELEASE_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "invalid release repository: ${RELEASE_REPOSITORY}" >&2
  exit 2
}
if ! jq -en --arg released_at "$RELEASED_AT" '
  ($released_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
  (($released_at | fromdateiso8601) | type == "number")
' >/dev/null; then
  echo "invalid release timestamp: ${RELEASED_AT}" >&2
  exit 2
fi

# Print 1 when left is newer, 0 when equal, and -1 when older. Components are
# compared as normalized decimal strings, avoiding host integer-width limits.
compare_numeric_versions() {
  local left="$1" right="$2" index left_component right_component
  local -a left_parts right_parts
  [[ "$left" =~ $VERSION_RE && "$right" =~ $VERSION_RE ]] || return 2
  IFS='.' read -r -a left_parts <<<"$left"
  IFS='.' read -r -a right_parts <<<"$right"
  for index in 0 1 2; do
    left_component="${left_parts[$index]}"
    right_component="${right_parts[$index]}"
    while [[ ${#left_component} -gt 1 && "$left_component" == 0* ]]; do left_component="${left_component#0}"; done
    while [[ ${#right_component} -gt 1 && "$right_component" == 0* ]]; do right_component="${right_component#0}"; done
    if [[ ${#left_component} -gt ${#right_component} ]]; then printf '1\n'; return 0; fi
    if [[ ${#left_component} -lt ${#right_component} ]]; then printf '%s\n' '-1'; return 0; fi
    if [[ "$left_component" > "$right_component" ]]; then printf '1\n'; return 0; fi
    if [[ "$left_component" < "$right_component" ]]; then printf '%s\n' '-1'; return 0; fi
  done
  printf '0\n'
}

case "$CHANNEL" in
  stable) TARGETS=('stable:latest.json' 'homolog:homolog.json' 'dev:dev.json') ;;
  homolog) TARGETS=('homolog:homolog.json' 'dev:dev.json') ;;
  dev) TARGETS=('dev:dev.json') ;;
  *) echo "unknown channel: ${CHANNEL} (valid: stable, homolog, dev)" >&2; exit 2 ;;
esac

if [[ -e .well-known || -L .well-known ]]; then
  [[ -d .well-known && ! -L .well-known ]] || {
    echo '.well-known must be a physical directory' >&2
    exit 3
  }
else
  mkdir .well-known
fi

for target in "${TARGETS[@]}"; do
  manifest_channel="${target%%:*}"
  file="${target#*:}"
  path=".well-known/${file}"
  advance=true

  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] || {
      echo "manifest path must be a physical regular file: ${path}" >&2
      exit 3
    }
    current_version="$(jq -er '.version | strings' "$path")" || {
      echo "manifest has no valid version: ${path}" >&2
      exit 3
    }
    [[ "$current_version" =~ $VERSION_RE ]] || {
      echo "manifest has an unsupported version in ${path}: ${current_version}" >&2
      exit 3
    }
    expected_tarball_base="https://github.com/${RELEASE_REPOSITORY}/releases/download/v${current_version}"
    if ! jq -e \
      --arg channel "$manifest_channel" \
      --arg version "$current_version" \
      --arg tarball_base "$expected_tarball_base" \
      '
        type == "object" and
        (keys == ["channel", "platforms", "released_at", "schema_version", "tarball_base", "version"]) and
        .schema_version == 1 and
        .channel == $channel and
        .version == $version and
        .tarball_base == $tarball_base and
        .platforms == ["linux-x64-glibc", "linux-x64-musl", "linux-arm64", "darwin-arm64"] and
        (.released_at | type == "string") and
        (.released_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
        ([.released_at | fromdateiso8601] | length == 1)
      ' "$path" >/dev/null; then
      echo "manifest schema is invalid or does not match its repository/channel/version: ${path}" >&2
      exit 3
    fi
    comparison="$(LC_ALL=C compare_numeric_versions "$VERSION" "$current_version")" || {
      echo "manifest has an unsupported version in ${path}: ${current_version}" >&2
      exit 3
    }
    case "$comparison" in
      1) ;;
      0)
        advance=false
        echo "::notice ::release-manifest.equal ${manifest_channel} already points to v${VERSION}; preserving timestamp"
        ;;
      -1)
        advance=false
        echo "::notice ::release-manifest.newer ${manifest_channel} stays at newer v${current_version}; refusing downgrade to v${VERSION}"
        ;;
      *) echo "internal version comparison error" >&2; exit 3 ;;
    esac
  fi

  if [[ "$advance" == true ]]; then
    temporary="$(mktemp ".well-known/.${file}.XXXXXX")"
    if ! jq -n \
      --arg channel "$manifest_channel" \
      --arg version "$VERSION" \
      --arg released_at "$RELEASED_AT" \
      --arg tarball_base "https://github.com/${RELEASE_REPOSITORY}/releases/download/v${VERSION}" \
      '{
        schema_version: 1,
        channel: $channel,
        version: $version,
        released_at: $released_at,
        tarball_base: $tarball_base,
        platforms: ["linux-x64-glibc", "linux-x64-musl", "linux-arm64", "darwin-arm64"]
      }' >"$temporary"; then
      rm -f "$temporary"
      exit 3
    fi
    mv "$temporary" "$path"
    echo "advanced ${manifest_channel} manifest to v${VERSION}"
  fi
done
