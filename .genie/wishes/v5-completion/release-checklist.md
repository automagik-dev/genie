# v5-completion — Group 3: Distribution 5.x + npm vestiges (VG3)

Task: `t_mr44jc4wfa5b4654`. Branch `wish/v5-completion` (in-tree, not committed).

## 1. Version scheme → 5.x

**Chosen scheme: `5.YYMMDD.N`** (daily-counter preserved from v4; only the leading
major moved `4.`→`5.`).

Why: minimal, reversible change. The daily counter mechanism and git-tag counting
that the whole release pipeline already depends on are untouched — the first v5
build of a day is `.N=1` because the counter now counts `v5.<date>.*` tags (of
which there are none), so it resets cleanly across the major boundary without any
special-casing. Switching to plain semver (5.0.0) would have required rewriting the
generator, the CI derive-version step, and `getTodayPublishCount`, plus a story for
subsequent bumps — more surface, more risk, no benefit for a date-stamped dev cadence.

Changes:
- `scripts/version.ts` (local generator): `4.`→`5.` in `generateVersion()`, tag glob
  `v4.<date>.*`→`v5.<date>.*` in `getTodayPublishCount()`, and header/comment docstrings.
- `.github/workflows/version.yml` (**the actual production generator** — CI derives the
  version here, not from `scripts/version.ts`): `echo "prefix=4"` → `prefix=5` (line ~102).
  This is the load-bearing change; the CI derive step at line ~134 already uses
  `git tag --list "v${PREFIX}.${TODAY}.*"`, so flipping the prefix flips both the version
  string and the tag glob together.
- `package.json`: `version` `4.260702.10` → `5.260702.1`.
- `genie --version` reads root `package.json` at runtime (`src/lib/version.ts` resolver) →
  reports `5.260702.1`. Verified after `bun run build`.

**Dead stamp step removed:** `scripts/version.ts` previously read `src/lib/version.ts`
and ran `.replace(/export const VERSION = '[^']+';/, ...)`. The runtime resolver no
longer contains that literal (it exports `VERSION = readVersionFromPackageJson()`), so
the regex matched nothing and the step rewrote the file unchanged — a dead no-op.
Removed. `src/lib/version.ts` itself is otherwise untouched (the resolver already
handles v5 transparently; version is data, not code).

Note (deferred, cosmetic, non-breaking): `version.yml`'s commit step still does
`git add -A '*.json' 'src/lib/version.ts'`. Since the generator no longer writes
`src/lib/version.ts`, that path now stages nothing. Harmless; left as-is to keep the
workflow diff minimal.

## 2. npm vestiges removed

- **`publishConfig` `{ "access": "public" }`** — pure npm-registry publish config.
  Removed. npm distribution discontinued 2026-05-09; nothing publishes to the registry.
- **`prepack` (`bun run build`)** — npm lifecycle hook that only fires on `npm pack` /
  `npm publish`. **Verification:** the signed-tarball build (`build-tarballs.yml`) builds
  via `bun install --frozen-lockfile` + `bash scripts/build-binary.sh` (`bun build --compile`)
  and never invokes `npm pack`/`prepack`; `release-publish.yml` and `sign-attest.yml` only
  operate on the tarballs `build-tarballs.yml` produces. So `prepack` was a dead npm-only
  hook. Removed. (The validation's `npm pack --dry-run` runs `bun run build` beforehand, so
  `dist/` exists without the hook.)
- **`description`** — kept the "npm distribution discontinued 2026-05-09 … install via
  curl" truth intact.
- **`files` allowlist** — already honest for the signed tarball:
  `["dist/", "skills/", "plugins/genie/", "templates/", "README.md", "LICENSE"]`.
  All targets exist; matches exactly what the tarball needs. Left unchanged.

**Kept (NOT npm-publish vestiges):** `build:plugin` / `sync` / `build-and-sync` and the
plugin-JSON sync in `scripts/version.ts` serve the **live Claude Code plugin/marketplace
channel** (`plugins/genie/`, `marketplace.json`), not npm. Removing them risks
smart-install (explicit constraint). Left in place. `sync.js` is self-deprecated in favor
of `term sync` but is a separate cleanup, not an npm vestige.

**Plugin version JSONs left at 4.260702.10** (`plugins/genie/.claude-plugin/plugin.json`,
`plugins/genie/package.json`, `.claude-plugin/marketplace.json`): the "touch ONLY" scope
excludes them and the constraint forbids bumping plugin sync. The version generator
(`bun run version` in CI) resyncs all four to the same `5.x` value on the next real
release, so the transient mismatch self-heals. Root `package.json` (the one
`genie --version` reads) is 5.x.

## 3. Release-workflow audit (v4/date-scheme assumptions)

| Workflow | Finding | Action |
|---|---|---|
| `version.yml` | `prefix=4` hardcode drove the whole scheme | **FIXED → `prefix=5`** |
| `release.yml` | `tags: ['v*']` glob is scheme-agnostic; dispatch input example said `4.260510.6` | Glob OK; **updated example → `5.260702.1`** (cosmetic clarity) |
| `build-tarballs.yml` | version from `inputs.version` / `GITHUB_REF_NAME#v` / `package.json` — scheme-agnostic; builds via bun-compile, no npm pack | No change |
| `release-publish.yml` | parses version from artifact name via `sed 's/^genie-(.+)-<platform>.tar.gz$/\1/'` — `.+` capture, scheme-agnostic | No change (historical `v4.260511.5` refs are comment anchors) |
| `sign-attest.yml` | same `(.+)` sed capture from tarball filename; `cosign-release: v2.4.1` is cosign's own version | No change |
| `rolling-pr.yml` | no version logic (dev→main PR maintenance only) | No change |
| `release-orphan-alert.yml` | `git tag --list 'v*'` — scheme-agnostic | No change |
| `audit-next-tag.yml` | **npm-registry vestige** — audits `npm view @automagik/genie@next`. Scheme-agnostic (does NOT parse version format), so 5.x does NOT break it. But npm is discontinued, so it's non-functional (its script exits 0 on "npm registry unreachable / no @next advertised"). | **DEFER-with-note:** orthogonal to the version scheme. Decommissioning this scheduled workflow + `scripts/audit-next-tag-pinning.sh` + the npm OIDC trusted-publisher entry (noted in `version.yml` lines ~276-287) is a dedicated npm-decommission cleanup, out of scope for a surgical version-scheme change. Not touched. |

## 4. Release-bot vs branch-guard

**Finding: no conflict.** The release automation does NOT push to `main`.

- `version.yml` bumps + tags only on the **dev** path (`should_bump=true`) and pushes
  `HEAD:refs/heads/${BRANCH}` where `BRANCH` is `dev`/`homolog` — never `main`. On `main`
  and `homolog` merges it runs `should_bump=false` (no version push); a separate
  "promoted tag" dispatch only tags the already-merged commit.
- `main` advances exclusively through the **human-merged** rolling PR that `rolling-pr.yml`
  creates (dev→main; "Human approval required for merge to production"). The bot creates
  the PR; it does not merge or push to main.
- Even where the bot pushes (to dev) or tags, it runs **remotely in GitHub Actions using
  `GITHUB_TOKEN`/`RELEASE_PLEASE_TOKEN`**. The genie `branch-guard` hook
  (`src/hooks/handlers/branch-guard.ts`) is a **local Claude Code PreToolUse hook** — it
  only intercepts git operations initiated through a local CC agent session. GitHub Actions
  runners never load that hook, so branch-guard's "deny agent pushes to main" policy is
  neither triggered by nor in conflict with the release bots. The two live in different
  planes (local agent tooling vs. remote CI identity).

Conclusion: branch-guard's default-dispatch denial of agent pushes to main is correct and
does not need a CI exemption — CI never hits it, and the one path to main is a human merge.

## 5. Validation

Run at end of task — see final agent message for captured output. Acceptance:
- package.json 5.x ✓ / `scripts/version.ts` no `4.`/`v4.` hardcodes ✓ / `genie --version` 5.x ✓
- `publishConfig` gone ✓ / `prepack` gone (proven dead) ✓ / `files` honest ✓
- `npm pack --dry-run` succeeds, tarball contains `dist/genie.js` ✓
- workflows audited (fixed vs deferred above) ✓ / release-bot finding above ✓
- `bun run check` + build green ✓ / nothing published or tagged ✓
