# MIKRO Release Contract

MIKRO follows the Hermes/Genie install/update shape:

- `scripts/install.sh` is the canonical installer.
- `mikro update` updates an installed checkout by fetching the latest public `main` commits.
- mikro is not published to npm. There is no registry channel of any kind.
- The canonical release boundary is a PR merge into `main`.

## Versioning

mikro uses **calendar versioning**, not semantic versioning: `1.YYMMDD.N`, where
`YYMMDD` is the **UTC** date of the build and `N` is one past the highest
existing `v1.YYMMDD.*` tag. (The fixed major was bumped `0` → `1` on
2026-08-17; `v0.*` tags remain in history and every `1.*` orders above them.) `scripts/version.mjs` computes it and syncs every
committed version location: `package.json`, `package-lock.json`,
`src/version.ts`, and the committed build output `dist/src/version.js` and
`dist/src/version.d.ts`.

The bump is produced at **merge time** by the `Release Metadata` workflow, not
by hand, so `YYMMDD` is the UTC date the release was actually cut and `N` is the
per-UTC-day release counter for `main`.

A version number records *when* a build was cut. It carries no compatibility
promise, so consumers must read `CHANGELOG.md` — not the version delta — to
learn about breaking changes.

## Channels

### CLI / application channel

The CLI is git-installed:

1. `install.sh` clones or refreshes the public repository.
2. It checks out `main`.
3. It validates npm-only checkout authority before dependency recovery or installation, then installs from the committed v3 `package-lock.json`.
4. It builds local `dist/`.
5. It links the `mikro` executable into the user's bin directory.

After install, `mikro update` performs the same update path in-place against `origin/main`.

### No npm channel

mikro is not published to npm. The SDK ships inside the same git checkout
(`dist/` is committed) and is consumed as a git dependency
(`npm install github:automagik-dev/mikro`). There is no publish workflow, no
dist-tag, and no registry artifact to keep coherent with `main`.

Git-dependency consumers use their own npm manifest and lock; that consumer
installation is outside the Mikro-checkout guard-before-mutation guarantee.
For local checkout dependencies use `npm run deps:ci`. CI, the canonical
installer, updater and launcher repair validate the same authority before
dependency mutation. Raw `npm ci` or `npm install` bypasses this protection;
such bypasses are not covered by the guarantee.

- `mikro --version` reports the package/runtime version embedded in the checkout.
  Every release commit on `main` carries a released, tagged version, so this is a
  reliable release identifier — but the git commit on `main` remains the
  authority on CLI freshness.

## Main release boundary

`main` is the canonical release branch and the expected branch for long-lived production checkouts (for example `~/prod/mikro`).

Use short-lived topic branches for focused source changes, then return the production checkout to `main` after merge/dogfood. The current conventions are:

- `wish/<slug>` — work executing a `.genie/wishes/<slug>` plan.
- `fix/<topic>` — targeted corrections and QA follow-ups.
- `feat/<topic>`, `chore/<topic>` — features and maintenance.

Topic branches merge **directly into `main`** by PR. There is no `dev`
integration branch. (Legacy `drogo/<topic>` branches predate this convention
and are not part of it; they should not be used or treated as an
install/update authority.)

A release happens when a topic-branch PR merges into `main`:

1. CI passes on the PR.
2. The merge lands on `main`.
3. `Release Metadata` runs. If `main`'s `package.json` version is already
   released, it bumps the calendar version, commits that bump to `main`, and
   tags the bump commit. Otherwise it releases the version the merge already
   carries (so a reviewed bump inside the PR is honoured, never double-bumped).
4. `main`'s HEAD is that release's commit, and it becomes the install/update
   target.
5. `install.sh` and `mikro update` fetch that commit.
6. A GitHub release exists for it. **Every merge into `main` is covered by a
   release**, so release metadata always tracks `main` and never trails it. It is
   still not the install authority — the git commit on `main` is.

Runs are serialized on a `release-metadata` concurrency group, so two merges
cannot compute the same `N` or race the push to `main`. If merges land faster
than a run finishes, GitHub retains only the newest queued run, so a burst can
yield one release spanning several merges. Every commit still ships inside a
release; only the release count can be lower than the merge count.

The trailing bump commit is metadata-only: it changes version literals and
nothing else. It receives no CI run of its own, because a push made with
`GITHUB_TOKEN` does not trigger workflow runs; the tested content comes from its
parent, the merge commit that CI passed on in step 1. Its message carries
`[auto-version]`, which `Release Metadata` skips in order to break the
push -> release -> push loop. It deliberately does *not* use `[skip ci]`: that
marker is honoured by every workflow, so it would permanently exempt `main`'s
HEAD from CI even if the push were later moved to a PAT.

## Coherence invariants

- Public git tags and GitHub Releases must not lie about package contents.
- If a tag is named `vX`, the target commit's `package.json`,
  `package-lock.json`, `src/version.ts`, `dist/src/version.js`, and
  `dist/src/version.d.ts` must all be `X`. `dist/` is committed, so a git-URL
  consumer of the tag reads its `VERSION` from there.
- A tag must never be derived without committing the matching version files.
  `Release Metadata` therefore tags the bump commit and never the merge commit
  (whose version files still hold the previous version), and it asserts the
  target commit's `package.json` and `src/version.ts` against the tag name before
  publishing, failing the run rather than cutting an incoherent tag.
- `mikro update` must never use npm to update the CLI application.
- No step may publish mikro to a package registry.
- Deployment-specific private policy must stay outside public MIKRO.

## Update semantics

`mikro update`:

- Runs from the installed repository root.
- Fetches `origin main --tags`.
- Refuses to overwrite local changes unless explicitly forced.
- Resets the checkout to `origin/main` for managed installs.
- Runs dependency install and build.
- Reports old commit, new commit, and version.

This mirrors the practical Hermes model: the installer owns the app checkout; the app update command refreshes that checkout.

## Workflow implementation

The release system follows this contract:

- `CI` builds, typechecks, tests, and runs an install/update smoke against a temporary git `main` remote.
- No workflow publishes to a package registry.
- `Release Metadata` runs on every push to `main` and guarantees a GitHub release
  for it: it computes the calendar version, commits the bump to `main` when the
  current version is already released, and tags the bump commit. Releases always
  track `main`, and only ever as coherent metadata.
- Topic-branch PRs into `main` state that merging is the application release boundary.

## Verifying a release

Because npm does not ship a `bin`, `npx mikro` cannot work and is not a valid
post-release check. Verify a release through the git channel instead:

```bash
bash scripts/install.sh          # canonical install path
mikro update                      # in-place refresh against origin/main
mikro --version                   # must equal the tag and src/version.ts
node scripts/smoke-acp.mjs       # ACP handshake + prompt round-trip
```
