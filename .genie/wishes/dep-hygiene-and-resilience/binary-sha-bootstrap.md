# Binary SHA-256 Pinning — Bootstrap & Maintenance

The `binarySha256` block in `package.json` pins SHA-256 values for every
binary downloaded by `scripts/postinstall-*.js`. The download path is
**pin-or-fail**: a missing or mismatching pin aborts the install.

This doc is the single source of truth for:

1. How to compute the initial set of pins (one-time, when adding a new
   downloaded binary).
2. How to bump pins when an upstream binary version changes.
3. How CI surfaces drift on every release.

Wish: [`dep-hygiene-and-resilience`](./WISH.md) Group 4.

> **NOTE:** This doc lives inside the wish directory because the worktree
> ships without the `.docs-vendor/genie` submodule initialized. Promote to
> `docs/_internal/binary-sha-bootstrap.md` (i.e. inside the docs vendor)
> as a follow-up commit on the docs submodule.

## What gets pinned

| Script | Source | Pinning policy |
|--------|--------|----------------|
| `scripts/postinstall-tmux.js` | Downloads `tmux-<ver>-<platform>.tar.gz` from `tmux/tmux-builds` GH releases | **Mandatory.** Missing key or mismatch aborts install. |
| `scripts/postinstall-hook-binary.js` | Compiles `genie-hook` locally via `bun build --compile` | **Exempt.** Logs source path so operators can verify by other means. |
| `scripts/postinstall-migrations.js` | No external fetches — invokes local `genie migrate` | **Not applicable.** |

## Computing initial pins (bootstrap)

Run on a machine with `curl` and `sha256sum` available:

```bash
TMUX_VERSION=3.6a
WORK=$(mktemp -d) && cd "$WORK"
for asset in \
  tmux-${TMUX_VERSION}-linux-x86_64.tar.gz \
  tmux-${TMUX_VERSION}-linux-arm64.tar.gz \
  tmux-${TMUX_VERSION}-macos-arm64.tar.gz \
  tmux-${TMUX_VERSION}-macos-x86_64.tar.gz; do
  curl -sL "https://github.com/tmux/tmux-builds/releases/download/v${TMUX_VERSION}/$asset" -o "$asset"
  sha256sum "$asset"
done
```

Paste the resulting `<sha256>  <asset>` lines into `package.json` under
`binarySha256` (key = asset filename, value = hex SHA-256).

## Bumping a binary version

When `TMUX_VERSION` (or any other downloaded-binary version) changes:

1. Update the version constant in the relevant `scripts/postinstall-*.js`.
2. Re-run the bootstrap snippet above against the new version.
3. Update `package.json#binarySha256` keys (rename old keys to new
   asset filenames, replace SHAs).
4. Commit. CI's drift check (next section) will validate that the pinned
   SHAs match what the upstream actually serves.

## CI drift detection

`.github/workflows/binary-sha-drift.yml` runs on every PR that touches
`package.json`, `scripts/postinstall-*.js`, or this doc. It:

1. Re-downloads each pinned asset from upstream.
2. Computes its SHA-256.
3. Compares against the pin in `package.json`.
4. Surfaces any mismatch as a deliberate diff comment so reviewers see
   the version bump as an explicit change, not a silent drift.

## Failure modes

| Scenario | Postinstall behavior |
|----------|---------------------|
| Pin matches actual SHA | Install proceeds; one-line `[genie] SHA-256 verified: …` notice. |
| Pin mismatch (tarball corrupted or attacker-modified) | `Error: <asset> SHA-256 mismatch — expected <pinned>, got <actual>. Aborting install.` Exit 1. |
| Asset key absent from `binarySha256` block | `Error: <asset> has no SHA-256 pin in package.json#binarySha256. Aborting install.` Exit 1. |
| `binarySha256` block entirely absent (running script outside published package) | Soft warning, install continues. **This path is local-dev only — published installs MUST pin.** |
