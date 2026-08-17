# Sourced helper: bounded, fail-closed retry for GitHub CLI calls in the
# release pipeline. Never executed directly; callers `source` it after their
# own input validation. It installs no EXIT trap — every caller owns its own —
# and cleans its temp files explicitly.
#
# Classification contract (2026-08-17 outage postmortem, run 31969294922):
# only failures that are provably transient are retried. Permission and
# validation failures surface immediately, and anything unclassifiable —
# including an empty stderr — is passed through untouched so a mutation is
# never blindly replayed against ambiguous state and existing exit-code
# passthrough semantics survive.

GH_RETRY_ATTEMPTS="${GH_RETRY_ATTEMPTS:-5}"
GH_RETRY_SLEEPS="${GH_RETRY_SLEEPS:-5 10 20 40}"

# gh_retry [--not-found-transient] <command> [args...]
# Runs the command up to GH_RETRY_ATTEMPTS times, buffering stdout and stderr
# per attempt so a failed attempt's partial output never leaks into a caller's
# $(...) capture or `> file` redirect. On success the final attempt's stdout
# and stderr are replayed verbatim; on failure the last exit code and stderr
# pass through unchanged.
# --not-found-transient: treat 404/"release not found" as retryable. Only pass
# this when the caller has separately established that the target exists
# (e.g. a release published moments earlier), where a 404 is replication lag.
gh_retry() {
  local not_found_transient=false
  if [[ "${1:-}" == "--not-found-transient" ]]; then
    not_found_transient=true
    shift
  fi
  local out err rc=0 attempt idx
  local -a sleeps
  read -r -a sleeps <<<"${GH_RETRY_SLEEPS}"
  [[ ${#sleeps[@]} -gt 0 ]] || sleeps=(1)
  out="$(mktemp)" || return 3
  err="$(mktemp)" || { rm -f "$out"; return 3; }
  for ((attempt = 1; attempt <= GH_RETRY_ATTEMPTS; attempt++)); do
    rc=0
    "$@" >"$out" 2>"$err" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      cat "$out"
      cat "$err" >&2
      rm -f "$out" "$err"
      return 0
    fi
    # Permission/validation failures are never retried, and are checked first
    # so a 403 whose message also suggests retrying is still surfaced at once.
    if grep -qiE 'HTTP 40[13]|forbidden|permission|not authorized|bad credentials|HTTP 422|validation failed|already_exists' "$err"; then
      break
    fi
    if grep -qiE 'release not found|HTTP 404|not found' "$err"; then
      # Retryable only under the caller's explicit existence proof.
      [[ "$not_found_transient" == true ]] || break
    elif ! grep -qiE 'timed? ?out|connection re(set|fused)|could not resolve|TLS|unexpected EOF|HTTP 5[0-9][0-9]|HTTP 429|rate limit|service unavailable|bad gateway|gateway time-?out|internal server error' "$err"; then
      # Unclassifiable (including empty stderr): fail closed immediately.
      break
    fi
    if ((attempt < GH_RETRY_ATTEMPTS)); then
      echo "::warning ::gh-retry.attempt ${attempt}/${GH_RETRY_ATTEMPTS} failed (exit ${rc}); retrying: $1" >&2
      idx=$((attempt - 1))
      ((idx < ${#sleeps[@]})) || idx=$((${#sleeps[@]} - 1))
      sleep "${sleeps[$idx]}"
    fi
  done
  cat "$out"
  cat "$err" >&2
  rm -f "$out" "$err"
  return "$rc"
}

# gh_release_lookup [--expect-exists] <owner/repo> <tag>
# Status-aware existence probe. Prints the release's REST JSON on stdout when
# it exists (published or draft) and returns:
#   0 — release exists (JSON printed)
#   4 — definitively absent (tag ref 404 AND the draft listing has no match)
#   3 — unknown or ambiguous; the CALLER MUST FAIL CLOSED. Unknown never
#       degrades to "not found": creating a release on a flake is how a
#       duplicate draft is born.
#   2 — invalid arguments
# Drafts carry no tag ref, so a definitive 404 on releases/tags/<tag> falls
# back to the paginated release listing filtered to drafts, and a single match
# is re-confirmed by numeric id before being trusted.
# --expect-exists: the caller knows the release must exist (it was created or
# published moments earlier), so a definitively-absent result is re-probed to
# ride out listing read-after-write lag before being returned.
gh_release_lookup() {
  local expect_exists=false
  if [[ "${1:-}" == "--expect-exists" ]]; then
    expect_exists=true
    shift
  fi
  local repo="${1:-}" tag="${2:-}"
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "gh_release_lookup: invalid repository: ${repo}" >&2; return 2; }
  [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "gh_release_lookup: invalid tag: ${tag}" >&2; return 2; }
  local rounds=1 round rc
  [[ "$expect_exists" == true ]] && rounds=3
  for ((round = 1; round <= rounds; round++)); do
    rc=0
    gh_release_lookup_once "$repo" "$tag" || rc=$?
    [[ "$rc" -eq 4 ]] || return "$rc"
    if ((round < rounds)); then
      echo "::warning ::gh-retry.lookup ${tag} not visible yet (round ${round}/${rounds}); waiting for listing consistency" >&2
      sleep "${GH_RETRY_LOOKUP_LAG_SLEEP:-5}"
    fi
  done
  return 4
}

gh_release_lookup_once() {
  local repo="$1" tag="$2" out err rc=0
  out="$(mktemp)" || return 3
  err="$(mktemp)" || { rm -f "$out"; return 3; }
  gh_retry gh api "repos/${repo}/releases/tags/${tag}" >"$out" 2>"$err" || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    cat "$out"
    cat "$err" >&2
    rm -f "$out" "$err"
    return 0
  fi
  if ! grep -qiE 'HTTP 404|not found' "$err"; then
    cat "$err" >&2
    rm -f "$out" "$err"
    echo "could not determine whether release ${tag} exists in ${repo}" >&2
    return 3
  fi
  rm -f "$out" "$err"
  local ids
  ids="$(gh_retry gh api --paginate "repos/${repo}/releases?per_page=100" --jq ".[] | select(.draft and .tag_name == \"${tag}\") | .id")" || {
    echo "could not enumerate draft releases for ${repo} while resolving ${tag}" >&2
    return 3
  }
  [[ -n "$ids" ]] || return 4
  if [[ "$(wc -l <<<"$ids" | tr -d ' ')" -ne 1 ]]; then
    echo "multiple draft releases carry tag ${tag} in ${repo}; refusing to pick one" >&2
    return 3
  fi
  local id="$ids" json
  [[ "$id" =~ ^[0-9]+$ ]] || { echo "draft listing returned a non-numeric release id for ${tag}" >&2; return 3; }
  json="$(gh_retry gh api "repos/${repo}/releases/${id}")" || {
    echo "could not confirm draft release ${id} for ${tag}" >&2
    return 3
  }
  [[ "$(jq -r '.tag_name' <<<"$json")" == "$tag" ]] || {
    echo "draft release ${id} does not carry tag ${tag}; refusing" >&2
    return 3
  }
  printf '%s\n' "$json"
  return 0
}

# gh_download_release_asset <owner/repo> <asset_id> <dest_file>
# Downloads one release asset by numeric id (works for drafts and published
# releases alike; no by-tag listing resolution involved).
gh_download_release_asset() {
  local repo="$1" asset_id="$2" dest="$3"
  [[ "$asset_id" =~ ^[0-9]+$ ]] || { echo "gh_download_release_asset: invalid asset id: ${asset_id}" >&2; return 2; }
  gh_retry gh api -H "Accept: application/octet-stream" "repos/${repo}/releases/assets/${asset_id}" >"$dest"
}

# gh_upload_release_asset <owner/repo> <release_id> <file>
# Uploads one asset by numeric release id via uploads.github.com. Returns 6
# when the asset name already exists on the release so the caller can decide
# (the release pipeline skips and lets its post-upload byte-compare adjudicate
# — assets are never clobbered or deleted).
gh_upload_release_asset() {
  local repo="$1" release_id="$2" file="$3" name err rc=0
  [[ "$release_id" =~ ^[0-9]+$ ]] || { echo "gh_upload_release_asset: invalid release id: ${release_id}" >&2; return 2; }
  name="$(basename "$file")"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "gh_upload_release_asset: refusing unsafe asset name: ${name}" >&2; return 2; }
  err="$(mktemp)" || return 3
  gh_retry gh api --method POST \
    -H "Content-Type: application/octet-stream" \
    "https://uploads.github.com/repos/${repo}/releases/${release_id}/assets?name=${name}" \
    --input "$file" >/dev/null 2>"$err" || rc=$?
  if [[ "$rc" -ne 0 ]] && grep -qi 'already_exists' "$err"; then
    cat "$err" >&2
    rm -f "$err"
    return 6
  fi
  cat "$err" >&2
  rm -f "$err"
  return "$rc"
}
