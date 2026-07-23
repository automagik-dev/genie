#!/usr/bin/env bash
#
# Execute one authenticated linux-x64-musl candidate inside the same
# digest-pinned Alpine environment used by the release build smoke.
#
# Invocation:
#   scripts/run-musl-dogfood.sh /absolute/path/to/genie <argv...>
#
# The Group F harness hashes and authenticates the binary before invoking this
# adapter. This boundary additionally requires a physical absolute executable
# and passes argv positionally, never through shell interpolation.

set -euo pipefail

readonly ALPINE_IMAGE='alpine:3.19@sha256:6baf43584bcb78f2e5847d1de515f23499913ac9f12bdf834811a3145eb11ca1'

if [[ $# -lt 2 ]]; then
  echo 'run-musl-dogfood: expected an absolute candidate binary and at least one argument' >&2
  exit 64
fi

candidate_binary=$1
shift

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'run-musl-dogfood: the Alpine adapter requires a Linux x86_64 Docker host' >&2
  exit 1
fi
if [[ "$candidate_binary" != /* || ! -f "$candidate_binary" || -L "$candidate_binary" || ! -x "$candidate_binary" ]]; then
  echo "run-musl-dogfood: candidate must be an absolute physical executable: ${candidate_binary}" >&2
  exit 1
fi

candidate_dir=$(cd -- "$(dirname -- "$candidate_binary")" && pwd -P)
candidate_name=$(basename -- "$candidate_binary")
if [[ ! "$candidate_name" =~ ^[A-Za-z0-9._+-]+$ || "$candidate_dir" == *','* || "$candidate_dir" == *$'\n'* ]]; then
  echo 'run-musl-dogfood: candidate path cannot be represented safely as a Docker bind mount' >&2
  exit 1
fi
candidate_canonical="${candidate_dir}/${candidate_name}"
if [[ "$candidate_canonical" != "$candidate_binary" ]]; then
  echo 'run-musl-dogfood: candidate path must already be canonical' >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'run-musl-dogfood: Docker is unavailable' >&2
  exit 1
fi

docker_args=(run --rm --pull=always -i --security-opt no-new-privileges)
container_candidate="/candidate/${candidate_name}"

# The one-shot capability probe needs only a read-only candidate directory.
# Full release dogfood sets DOGFOOD_ROOT: preserve its isolated home/repository
# state across candidate invocations by mounting that one canonical fixture
# root at the identical absolute path. Re-bind the executable itself read-only
# so stateful commands cannot replace the authenticated candidate bytes.
if [[ -n "${DOGFOOD_ROOT:-}" ]]; then
  dogfood_root=$(cd -- "$DOGFOOD_ROOT" 2>/dev/null && pwd -P) || {
    echo 'run-musl-dogfood: DOGFOOD_ROOT must be an existing physical directory' >&2
    exit 1
  }
  host_cwd=$(pwd -P)
  if [[ "$DOGFOOD_ROOT" != /* || "$DOGFOOD_ROOT" != "$dogfood_root" ||
        "$dogfood_root" == *','* || "$dogfood_root" == *$'\n'* ||
        "$host_cwd" != "$dogfood_root" && "$host_cwd" != "$dogfood_root/"* ||
        "$candidate_binary" != "$dogfood_root/"* ]]; then
    echo 'run-musl-dogfood: stateful root, cwd, and candidate must be canonical and contained' >&2
    exit 1
  fi
  docker_args+=(
    --mount "type=bind,src=${dogfood_root},dst=${dogfood_root}"
    --mount "type=bind,src=${candidate_binary},dst=${candidate_binary},readonly"
    --workdir "$host_cwd"
  )
  container_candidate=$candidate_binary
  for key in \
    HOME GENIE_HOME CODEX_HOME CLAUDE_CONFIG_DIR HERMES_HOME GENIE_AGENTS_SKILLS_DIR \
    TMPDIR XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME \
    BUN_INSTALL_CACHE_DIR NPM_CONFIG_CACHE GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM \
    GENIE_TEST_SKIP_PGSERVE GENIE_RELEASE_DOGFOOD FAKE_CODEX_STATE FAKE_CODEX_TARGET \
    NO_COLOR TERM; do
    if [[ -n "${!key:-}" ]]; then docker_args+=(--env "$key"); fi
  done
  docker_args+=(--env "PATH=${dogfood_root}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
else
  docker_args+=(--mount "type=bind,src=${candidate_dir},dst=/candidate,readonly")
fi
if [[ -t 0 && -t 1 ]]; then docker_args+=(-t); fi

exec docker "${docker_args[@]}" \
  "$ALPINE_IMAGE" \
  sh -ec '
    apk add --no-cache bash git libstdc++ >/dev/null
    candidate=$1
    shift
    exec "$candidate" "$@"
  ' sh "$container_candidate" "$@"
