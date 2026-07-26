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

# The image reference is digest-pinned, so pull-if-missing already guarantees
# exact bytes; `--pull=always` would re-resolve the manifest on EVERY run and
# write pull progress to stderr, which the harness's stderr-strict capability
# probe treats as failure. The dogfood workflow pre-pulls the digest.
docker_args=(run --rm -i --security-opt no-new-privileges)

# The candidate must run AS THE HOST USER, not container root. The fixture tree
# is bind-mounted and shared with host-side stages: git refuses a repository
# whose on-disk owner differs from the effective uid ("dubious ownership", so
# `genie init` reports "not a git repository"), genie's own fail-closed
# ownership checks demand stat.uid == process uid, and any root-owned file the
# container creates would poison every later host-side stage. Root is needed
# only for the apk bootstrap; su-exec then drops to this exact identity.
docker_args+=(--env "DOGFOOD_HOST_UID=$(id -u)" --env "DOGFOOD_HOST_GID=$(id -g)")
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
    # Bootstrap noise must never reach stderr: the probe fails on any stderr
    # byte, and only the candidate binary output is meaningful to it. apk
    # failures still abort through set -e.
    apk add --no-cache bash git libstdc++ su-exec >/dev/null 2>&1
    candidate=$1
    shift
    # Drop from bootstrap root to the exact host identity that owns the
    # bind-mounted fixture tree (see DOGFOOD_HOST_UID rationale above).
    exec su-exec "${DOGFOOD_HOST_UID}:${DOGFOOD_HOST_GID}" "$candidate" "$@"
  ' sh "$container_candidate" "$@"
