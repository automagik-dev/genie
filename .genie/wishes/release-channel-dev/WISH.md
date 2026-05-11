# Wish: Rename `--next` to `--dev` and wire the producer-side dev channel

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `release-channel-dev` |
| **Date** | 2026-05-11 |
| **Author** | felipe |
| **Appetite** | small |
| **Branch** | `wish/release-channel-dev` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

`genie update --next` is half-built: the consumer side (`update.ts`, `install.sh`) resolves the `next` channel and fetches `.well-known/next.json`, but no producer ever writes that file — `release-publish.yml` hard-gates the `.well-known` writer to `channel == 'stable'`, and `install.sh` hardcodes the URL to `latest.json`. Rename the channel from `next` to `dev`, wire the publish pipeline to write `.well-known/dev.json` on dev-branch tag pushes (prerelease GitHub Releases), parameterize the install-script URL, and make the existing channel-stickiness honor the `dev` value so a one-time `genie update --dev` flip keeps you on the dev channel forever.

## Scope

### IN

- Rename `ReleaseChannel` member `next` → `dev` in `src/genie-commands/update.ts`; rename CLI flag `--next` → `--dev` in `src/genie.ts`; rename manifest filename `next.json` → `dev.json` in `manifestUrlForChannel`. Keep `--next` as a deprecated alias that maps to `--dev` and prints a single-line stderr deprecation notice; remove the alias in the next major release.
- Migrate `genieConfig.updateChannel` enum from `'latest' | 'next'` to `'latest' | 'dev'` while accepting `'next'` as a backward-compat alias during read (zod `.transform`). New writes always emit `'dev'`.
- Parameterize `install.sh` so `GENIE_CHANNEL=dev curl -fsSL https://get.automagik.dev/genie | bash` resolves `.well-known/dev.json` instead of always reading `latest.json`. Keep `stable` as the default.
- Plumb `channel` through the release pipeline: `version.yml` passes `channel=dev` to `release.yml` when triggered from the `dev` branch; `release.yml` propagates to `release-publish.yml` via `workflow_call.with`. Default remains `stable`.
- Generalize `release-publish.yml`'s `.well-known` writer to emit `<channel>.json` (drop the `channel == 'stable'` gate; keep the `!inputs.draft` gate). For non-stable channels, mark the GitHub Release as `prerelease: true`.
- Persist the channel on every successful `genie update` so a one-time `--dev` flip sticks for subsequent bare `genie update` invocations. (Today `persistChannel` only fires when `--next`/`--stable` is explicitly passed — keep that explicit path AND also persist on the implicit path so users who flip via `--dev` stay on dev without re-passing the flag.)

### OUT

- A `beta` channel publisher (the type is defined but no producer exists; out of scope here).
- Cross-channel rollback (`genie update --rollback` already restores the previous local binary regardless of channel; channel-aware downgrade — "give me the previous dev tag" — is a separate wish).
- Automatic promotion of a dev tag to stable (i.e. `genie release promote vX.Y.Z`). Manual promotion via `workflow_dispatch` on `release-publish.yml` with `channel=stable` continues to work; UX sugar for that is out of scope.
- Touching the `canary` channel — it remains a defined-but-unused enum value, same as today.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Hard-rename `next` → `dev` in code and on disk, with `--next` aliased to `--dev` for one release cycle (stderr deprecation notice). | The user asked for a rename. `next` is npm-speak; `dev` matches the branch name (`dev`) and the mental model. One-cycle alias keeps anyone on the old flag working while we cut their warning. |
| 2 | The `.well-known` filename also changes (`next.json` → `dev.json`). No backward-compat fetch of `next.json` from older CLI binaries. | The next.json file was never published, so no old CLI in the wild is reading it. Adding a fallback fetch is dead complexity. |
| 3 | `genie-config.updateChannel` accepts `'next'` as a read-time alias for `'dev'` (zod transform) but always WRITES `'dev'`. | Users who manually set `updateChannel: next` in `~/.genie/config.json` (or had it auto-persisted by an older binary that was never released because next was broken — unlikely but cheap to defend) don't lose their preference. Writes converge fast. |
| 4 | Every successful `genie update` persists the resolved channel, not just explicit `--dev`/`--stable` flips. | Matches the user's mental model ("`--dev` should switch and stick forever"). Today's narrow `if (options.next || options.stable)` gate means a user who flips via `--dev`, then runs bare `genie update`, would silently fall back to stable on next run if config wasn't already set. Persisting on every run makes the sticky behavior bulletproof. |
| 5 | Non-stable GitHub Releases get `prerelease: true`. | Standard convention — surfaces in the GitHub UI's "Latest release" pin (stable-only) and excludes the dev tag from `gh release view --latest`. Matches what the existing release-publish.yml manual-dispatch path already does (`PRERELEASE_FLAG="--prerelease"` when channel != stable). |
| 6 | `dev`-branch CI must succeed before `version.yml` dispatches `release.yml` with `channel=dev`. No publishing from a failing dev tip. | Quality bar. The current pipeline already gates `version.yml` on `workflow_run.conclusion == 'success'` — we inherit it. |

## Success Criteria

- [ ] `genie update --dev` on a stable install resolves `.well-known/dev.json`, downloads the dev tarball, verifies attestation, and atomically swaps the binary.
- [ ] After a `genie update --dev` run, a subsequent bare `genie update` resolves the `dev` channel (no flag needed) and stays on dev.
- [ ] `genie update --next` still works but prints a one-line stderr deprecation notice pointing at `--dev`.
- [ ] `GENIE_CHANNEL=dev curl -fsSL https://get.automagik.dev/genie | bash` installs the dev-channel binary on a clean machine.
- [ ] A merge into `dev` (via PR) results in a new GitHub Release marked `prerelease: true` AND `.well-known/dev.json` updated on `main` pointing at the new version; `.well-known/latest.json` is **unchanged**.
- [ ] A merge into `main` (via dev → main PR) results in `.well-known/latest.json` updated AND the GitHub Release flipped from `prerelease: true` → stable (or a fresh release published, depending on whether the tag already exists).
- [ ] `bun run check` passes (typecheck + lint + dead-code + test).
- [ ] `genie wish lint release-channel-dev` passes with no errors.

## Execution Strategy

Single wave, sequential because each group's validation depends on the previous group's wire being in place. Could parallelize CLI rename and YAML changes, but the smoke test in Group 4 needs all three landed.

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | CLI + config rename (`--next` → `--dev`, channel enum, sticky persistence) |
| 2 | engineer | install.sh channel-aware URL parameterization |
| 3 | engineer | Release pipeline — plumb `channel` through version.yml → release.yml → release-publish.yml; write `.well-known/<channel>.json`; prerelease flag for non-stable |
| 4 | qa | End-to-end smoke: merge a no-op PR to `dev`, observe dev.json + prerelease release; run `genie update --dev` from a stable install; verify stickiness |

## Execution Groups

### Group 1: CLI + config rename

**Goal:** Rename the consumer-side surface from `next` to `dev` everywhere — CLI flag, channel enum, manifest filename, genie-config enum — with a one-cycle `--next` alias and read-time backward compat on `updateChannel`.

**Deliverables:**
1. `src/genie-commands/update.ts`: `ReleaseChannel` member `next` → `dev`; `manifestUrlForChannel` returns `dev.json` for `dev`; `resolveChannel` returns `'dev'` for `options.next || options.dev` (alias path) with deprecation notice when `--next` is observed.
2. `src/genie.ts`: add `--dev` option; keep `--next` as alias with description `(deprecated, use --dev)`.
3. `src/types/genie-config.ts`: `updateChannel: z.enum(['latest', 'next', 'dev']).transform(v => v === 'next' ? 'dev' : v).default('latest')` (or equivalent — accept-read / write-canonical).
4. `update.ts`: drop the `if (options.next || options.stable)` gate around `persistChannel` — call it unconditionally after a successful resolve, so every run persists the channel that was actually used.
5. Tests: extend `src/genie-commands/__tests__/update.test.ts` with cases for (a) `--dev` resolves to channel `dev`, (b) `--next` resolves to channel `dev` AND prints deprecation, (c) bare `genie update` after a `--dev` persist stays on `dev`, (d) `updateChannel: 'next'` in config is read as `dev` and rewritten to `dev` on next persist.

**Acceptance Criteria:**
- [ ] `genie update --dev --no-restart --no-verify` (dry-run-ish path with a stubbed manifest fetcher) resolves channel = `dev`.
- [ ] `genie update --next` prints `--next is deprecated; use --dev` to stderr exactly once, then proceeds as `--dev`.
- [ ] After `persistChannel('dev')`, `~/.genie/config.json` (or wherever `loadGenieConfig` writes) contains `updateChannel: "dev"`.
- [ ] A config file with `updateChannel: "next"` loads cleanly and `resolveChannel({})` returns `'dev'`.
- [ ] No `'next'` literals remain in the channel-resolution path outside the backward-compat alias.

**Validation:**
```bash
bun test src/genie-commands/__tests__/update.test.ts src/genie-commands/__tests__/install.test.ts && bun run typecheck && bun run lint
```

**depends-on:** none

---

### Group 2: install.sh channel-aware URL

**Goal:** Parameterize `install.sh` so the manifest URL is derived from `GENIE_CHANNEL` instead of hardcoded to `latest.json`. Keep `stable` as the default, accept `dev` (and forward-compat `beta`/`canary`).

**Deliverables:**
1. `install.sh`: derive `MANIFEST_FILE` from the resolved channel — `stable → latest.json`, others → `${channel}.json`. Rebuild `LATEST_URL` from the per-channel filename. The existing `fetch_latest` channel-match assertion (line 65) still applies — it'll just compare against the channel field in dev.json now.
2. Surface the resolved manifest URL in the install banner (`==> manifest=.well-known/<file>`) so a 404 is obvious in the operator's log.
3. Reject unknown channels with a clean error before the fetch (`stable|beta|canary|dev` allow-list; everything else dies with a one-line hint).

**Acceptance Criteria:**
- [ ] `GENIE_CHANNEL=stable bash install.sh` resolves `latest.json` (unchanged behavior).
- [ ] `GENIE_CHANNEL=dev bash install.sh` resolves `dev.json` and dies with a clear message if dev.json hasn't been published yet.
- [ ] `GENIE_CHANNEL=banana bash install.sh` dies before any network call with `unknown channel: banana (valid: stable|beta|canary|dev)`.
- [ ] `shellcheck install.sh` clean (or no new findings vs main).

**Validation:**
```bash
bash -n install.sh && shellcheck install.sh
# Behavioral smoke: stub LATEST_URL via env override, assert the right file is fetched.
GENIE_CHANNEL=dev DRY_RUN=1 bash install.sh 2>&1 | grep -q 'manifest=.well-known/dev.json'
```

**depends-on:** none

---

### Group 3: Release pipeline — plumb `channel` through and write `<channel>.json`

**Goal:** Wire the producer side so dev-branch tag pushes publish to the `dev` channel (prerelease GitHub Release + `.well-known/dev.json`) and main-branch tag pushes continue to publish to `stable`.

**Deliverables:**
1. `.github/workflows/release.yml`: add a `channel` input on `workflow_dispatch` (default `stable`, choices `stable|beta|canary|dev`). On `push: tags: ['v*']`, derive channel from the tag's prerelease suffix OR (simpler) from the `head_commit.message` heuristic — actually, use the env: tag's containing-branch is unknowable, so we read it from `version.yml`'s upstream dispatch. Update the `uses: ./.github/workflows/release-publish.yml` block to pass `channel: ${{ inputs.channel || 'stable' }}`.
2. `.github/workflows/version.yml`: when triggered for `head_branch == 'dev'`, dispatch `release.yml` with `--field channel=dev` (currently no `channel` field is passed, so default `stable` applies — that's the bug).
3. `.github/workflows/release-publish.yml`: drop the `channel == 'stable'` half of the `if:` guard on the "Update .well-known/latest.json" step. Rename the step to "Update .well-known/<channel>.json"; change the file path to `.well-known/${{ steps.meta.outputs.channel }}.json`; change the `channel` field in the emitted JSON to match. Keep the `!inputs.draft` half of the guard. Set `--prerelease` on `gh release create` when `channel != stable` (already happens — verify).
4. Commit message: `chore(release): update <channel>.json → v${VERSION}` (already mostly correct, just templatize the filename).

**Acceptance Criteria:**
- [ ] Inspecting `release.yml` shows `channel` plumbed through to `release-publish.yml` via `with:`.
- [ ] Inspecting `version.yml` shows the dev-branch dispatch passes `--field channel=dev`.
- [ ] Inspecting `release-publish.yml`'s `.well-known` step shows the filename comes from `${{ steps.meta.outputs.channel }}.json`.
- [ ] `gh release view <dev-tag>` on a dev-channel tag shows `isPrerelease: true`.
- [ ] After a dev-channel publish, `https://raw.githubusercontent.com/automagik-dev/genie/main/.well-known/dev.json` returns a manifest with `"channel": "dev"`.
- [ ] After a stable publish, `.well-known/latest.json` updates and `.well-known/dev.json` is **unchanged** (no cross-channel writes).

**Validation:**
```bash
# YAML lint
yamllint .github/workflows/release.yml .github/workflows/release-publish.yml .github/workflows/version.yml
# Workflow syntax sanity via gh act dry-run (optional, requires act)
# Manual: trigger workflow_dispatch on release-publish.yml with channel=dev, draft=true, and verify dev.json appears in the commit diff but the release stays draft.
```

**depends-on:** group-1

---

### Group 4: End-to-end smoke + docs

**Goal:** Prove the round-trip works on a real merge to `dev`, then to `main`; update operator-facing docs.

**Deliverables:**
1. After Groups 1-3 land on `dev` and the auto-version pipeline fires, capture the run IDs of the dev publish; verify dev.json on `raw.githubusercontent.com` and the prerelease flag on the GH Release.
2. On a fresh machine (or fresh `$HOME`), run `GENIE_CHANNEL=dev curl -fsSL https://get.automagik.dev/genie | bash`; verify `genie --version` reports the dev tag's version and `~/.genie/config.json` carries `updateChannel: "dev"`.
3. On a stable install, run `genie update --dev`; verify channel flip + binary swap + sticky persistence.
4. Docs: update `docs/installation.mdx` (under `.docs-vendor`) to document `GENIE_CHANNEL` and the dev channel; update `docs/release-process.mdx` to describe the dev → main promotion flow. Open the docs PR against `automagik-dev/docs` and bump the `.docs-vendor` submodule pointer in this wish's branch.
5. Update `CLAUDE.md` if it mentions `--next` anywhere.

**Acceptance Criteria:**
- [ ] dev.json exists at the canonical raw.githubusercontent.com URL with the expected schema and `channel: "dev"`.
- [ ] The dev-channel GH Release shows `prerelease: true` in the GitHub UI.
- [ ] `genie update --dev` from a stable v4.260511.3 install succeeds end-to-end (download → verify → swap → restart probe).
- [ ] After the above, a bare `genie update` on the same host re-resolves the dev channel and is a no-op (already current).
- [ ] `docs/installation.mdx` documents `GENIE_CHANNEL` and the four valid values.
- [ ] No remaining references to `--next` in operator-facing docs (excluding migration notes that explicitly call out the rename).

**Validation:**
```bash
# Smoke (requires the previous groups to have landed and a fresh dev publish)
curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/.well-known/dev.json | jq -e '.channel == "dev"'
# Local docs lint
bun run docs:lint   # if available; otherwise visual diff review
```

**depends-on:** group-2, group-3

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Channel switch is one-shot:** a single `genie update --dev` flip persists; subsequent bare `genie update` invocations stay on dev until the user passes `--stable`.
- [ ] **Deprecation alias works:** `genie update --next` still resolves channel `dev` and emits a deprecation notice (single-line, to stderr, once per invocation).
- [ ] **Producer round-trip:** a no-op PR merged to `dev` triggers the version + release pipeline and ends with (a) a new prerelease GH Release tagged `vX.Y.Z`, (b) `.well-known/dev.json` updated, (c) `.well-known/latest.json` **unchanged**.
- [ ] **Cross-channel install:** `GENIE_CHANNEL=dev curl ... | bash` on a fresh machine pulls the dev tag, not the stable one.
- [ ] **Config back-compat:** an existing `~/.genie/config.json` with `updateChannel: "next"` is honored (reads as `dev`) and silently rewritten to `dev` on next persist.
- [ ] **No regressions on stable:** a bare `genie update` on a stable install with no genie-config file installs from `latest.json` and stays on stable.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Existing operators have `~/.genie/config.json` with `updateChannel: "next"` and the new binary refuses to parse it (zod schema rejection). | Medium | Decision #3 — accept `'next'` as a read-time alias via zod `.transform`. Tested in Group 1 acceptance #4. |
| Dropping the `channel == 'stable'` gate on the `.well-known` writer accidentally publishes `latest.json` from a beta or canary run, breaking stable users. | High | Channel name comes from the workflow input chain, not derived inside the writer; we control it at `version.yml` dispatch time. Verify in Group 3 acceptance — a non-stable run must NOT write `latest.json`. |
| `--next` deprecation alias forgotten and never removed, accumulating dead code. | Low | File a follow-up issue at the time of merge: "remove `--next` alias after one minor release"; cite the date in the deprecation notice. |
| Operators running `bash install.sh` from a cached/old install.sh hit the new dev.json path but the file isn't published yet. | Low | The 404 path already dies with a clean message (`could not fetch $LATEST_URL`); Group 2 surfaces the URL in the banner so the failure is self-diagnosing. |
| `version.yml`'s dev-branch workflow_run trigger has not fired automatically in 2+ weeks (per investigation in PR #2415 thread) — this wish doesn't fix that root cause. | Medium | Out of scope here; flagged as a separate issue. Once a maintainer triggers `version.yml` via `workflow_dispatch` on `dev`, the new channel plumbing exercised by this wish works. A follow-up wish on the workflow_run trigger reliability is the right place for the auto-fire fix. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/genie-commands/update.ts                                  # rename next→dev, deprecation alias, unconditional persistChannel
src/genie-commands/__tests__/update.test.ts                   # new cases: --dev resolve, --next alias, sticky, config back-compat
src/genie.ts                                                  # --dev option + deprecated --next alias
src/types/genie-config.ts                                     # updateChannel enum: accept 'next' as alias for 'dev'
install.sh                                                    # channel-aware MANIFEST_FILE, allow-list, banner surfacing
.github/workflows/version.yml                                 # pass --field channel=dev on dev-branch dispatch
.github/workflows/release.yml                                 # channel input + propagation to release-publish via with:
.github/workflows/release-publish.yml                         # generalize .well-known writer, drop stable-only gate
docs/installation.mdx                                         # document GENIE_CHANNEL + --dev (via .docs-vendor PR)
docs/release-process.mdx                                      # dev → main promotion flow (via .docs-vendor PR)
.docs-vendor                                                  # submodule pointer bump after docs PR merges
CLAUDE.md                                                     # if it references --next, update
```
