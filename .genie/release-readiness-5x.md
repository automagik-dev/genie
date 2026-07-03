# v5 Release-Readiness Audit — genie 5.260702.1

**Date:** 2026-07-02 · **Branch:** dev · **Auditor pass:** read/verify + local artifact build
**Distribution model:** cosign/SLSA-signed tarballs → GitHub Releases, installed via `curl … install.sh` (NOT npm).

## Verdict

**DO NOT TAG AS-IS.** The signed-tarball build/sign/publish chain and `install.sh`
download+verify path are coherent and were exercised locally end-to-end, but **the
installer's final handoff calls a command that no longer exists in v5**, so a fresh
`curl | bash` install ends in an error and exit 1 (BLOCKER 1). A second install path
(Claude Code plugin marketplace) still auto-installs genie from the discontinued npm
channel (BLOCKER 2). Both are one-line-ish fixes. Version drift (SHOULD 3) auto-heals
if the release goes through the normal dev-bump pipeline but ships a wrong plugin
version if tagged directly from this commit.

---

## What I exercised (evidence)

### Multi-platform build — ALL 4 built locally ✅
Ran `bash scripts/build-binary.sh --platform <p>` for each entry in the PLATFORMS list.
`bun --compile --target=…` cross-compiles cleanly on this darwin-arm64 host:

| Platform | Built here? | Tarball | Size |
|---|---|---|---|
| darwin-arm64 | ✅ native | genie-5.260702.1-darwin-arm64.tar.gz | 21.6 MB |
| linux-x64-glibc | ✅ cross | genie-5.260702.1-linux-x64-glibc.tar.gz | 37.6 MB |
| linux-x64-musl | ✅ cross | genie-5.260702.1-linux-x64-musl.tar.gz | 35.3 MB |
| linux-arm64 | ✅ cross | genie-5.260702.1-linux-arm64.tar.gz | 37.1 MB |

All well under the 80 MB budget. Cross-compiled linux binaries embed the local bun
runtime (1.3.9); I could not execute them on macOS but the darwin binary ran correctly
(below). CI builds these on native runners with bun 1.3.11 (build-tarballs.yml matrix).

**Contents per tarball (verified on darwin-arm64):** `genie` (Mach-O arm64, +x),
`VERSION`=`5.260702.1`, `plugins/`, `skills/` (18), `templates/` (2). Extracted
`./genie --version` → **`5.260702.1`** (NOT `0.0.0-unknown`). The version.ts VERSION-file
stamp path (execDir/VERSION) works for compiled binaries. ✅

### Shipped-surface smoke (compiled darwin binary) ✅
- `genie --help` → 12 commands: board, doctor, help, hook, init, launch, omni, setup,
  shortcuts, task, uninstall, update. Exit 0.
- `genie doctor` → all checks pass, correctly reports version 5.260702.1; only warning is
  "genie on PATH — not found" (expected, ran from /tmp). Exit 0.
- `genie init` in a fresh `/tmp` git repo → scaffolds `.genie/INDEX.md` + `.gitignore`;
  idempotent on second run (exit 0). `genie task list` and `genie board` both work. ✅

### Release-workflow chain — coherent ✅
`version.yml` (derives `5.YYMMDD.N`, `bun run version` syncs all 4 JSONs, commits + pushes
tag `v<version>`) → tag `v*` fires `release.yml` orchestrator → `build-tarballs.yml`
(matrix, native runners) → `sign-attest.yml` (cosign keyless + SLSA L3) →
`release-publish.yml` (gh release + 12 assets + `.well-known/*.json`). Single run via
`workflow_call`; no `workflow_run` recursion. Tag glob `v5.*` matches the version scheme.

**Naming contract is consistent end-to-end:**
`genie-<v>-<platform>.tar.gz` (build) → `+.bundle` `+.intoto.jsonl` (sign) → upload
`dist/*` = 12 assets (publish) → `install.sh` downloads `genie-<v>-<platform>.tar.gz` +
`.bundle` and runs `cosign verify-blob` / `gh attestation verify` with cert-identity
pinned to `^https://github.com/automagik-dev/genie/.github/workflows/sign-attest.yml@`
+ github OIDC issuer — matches the workflow that physically holds the cosign step.

**Manifest chain consistent:** publish writes `.well-known/{latest,homolog,dev}.json`
with `version` + `tarball_base=…/releases/download/v<version>`; install.sh reads
`latest.json` (stable) → `version` + `tarball_base`, then fetches the platform tarball
from it. Platform detection in install.sh (linux-x64-{glibc,musl}, linux-arm64,
darwin-arm64; Intel-Mac rejected) matches the 4 built platforms exactly. Channel taxonomy
(stable/homolog/dev) is consistent across install.sh, release.yml, release-publish.yml.

---

## Blockers (prioritized)

### 🔴 BLOCKER 1 — install.sh execs a command that doesn't exist in v5
`install.sh:311-315` `handoff_to_subcommand()` runs `exec "$LOCAL_BIN/genie" install`
as the final step. **v5 has no top-level `install` command.** The only `install` is
`shortcuts install` (src/genie.ts:110, a subcommand of `shortcuts`). Verified on the
compiled binary:
```
$ genie install
Error (genie): error: unknown command 'install' (Did you mean uninstall?)
$ echo $?  → 1
```
Impact: `curl … install.sh | bash` extracts + symlinks the binary successfully (that
happens before the handoff), then dies with `unknown command 'install'` and **exit 1**.
The "shell-rc + completions wiring" that `genie install` was supposed to do never runs —
so on any box where `~/.local/bin` is not already on PATH (common fresh macOS/Linux), a
new shell can't find `genie` and the install *looks* failed.
**Fix:** repoint the handoff at a command that exists (e.g. `genie setup --quick`, which
does shell-rc/shortcut wiring) or reintroduce a top-level `genie install`; and/or make the
handoff non-fatal (`exec … || true` won't work with exec — guard it) so a missing setup
step never fails the whole install.

### 🔴 BLOCKER 2 — Claude Code plugin path still auto-installs genie from discontinued npm
`plugins/genie/scripts/smart-install.js:428` (wired as a **SessionStart** hook in
`plugins/genie/hooks/hooks.json:10`) runs `bun add -g @automagik/genie@latest` whenever
`genieCliNeedsInstall()` is true (no genie binary present). npm distribution was
**discontinued 2026-05-09** (per package.json description). A fresh user who installs the
`genie` plugin via the Claude Code marketplace therefore gets a stale last-published npm
build (≤4.x) or a hard failure — never v5, and never the signed-tarball path.
**Fix:** rewrite `installGenieCli()` to bootstrap via `install.sh` / GitHub Releases, or
drop the auto-install and print the `curl … install.sh` one-liner. Decide whether the
plugin marketplace is a supported v5 install path at all; if not, deprecate it loudly.

---

## Should-fix

### 🟡 SHOULD 3 — plugin/marketplace version files stranded at 4.x
Root `package.json`=**5.260702.1**, but:
- `plugins/genie/package.json` = `4.260702.10`
- `plugins/genie/.claude-plugin/plugin.json` = `4.260702.10`
- `.claude-plugin/marketplace.json` plugins[0].version = `4.260702.10`

The **shipped tarball** carries `plugins/genie/.claude-plugin/plugin.json` = 4.260702.10
inside it (verified in the extracted darwin tarball). Cause: commit `e92ad2f1`
("chore(v5)!: 5.x version scheme…") hand-set the root version without running
`bun run version` — `scripts/version.ts` is the thing that syncs all four files (lines
80-101) and it wasn't run.
Severity depends on the release route:
- **Normal dev-bump route (auto-heals):** a real release is derived on a dev CI push
  where `version.yml` runs `bun run version` → all 4 files rewritten to `5.YYMMDD.N`,
  committed, tagged. The drift disappears. Cosmetic.
- **Direct tag from this commit (real mismatch):** the release ships a plugin advertising
  4.260702.10 while the CLI reports 5.260702.1 — marketplace listing + in-tarball
  plugin.json disagree with the binary. Confusing on a fresh plugin install.
`smart-install.js` compares its own plugin `package.json` version against a marker for
dep-reinstall (not against the CLI), so it won't hard-fail on the drift — but the
user-visible version in the marketplace is wrong.
**Fix:** run `bun run version` (or manually bump the 3 plugin JSONs to 5.260702.1) before
tagging, OR guarantee the release goes through the dev-bump pipeline rather than a manual
tag of e92ad2f1.

---

## Notes (fine / low-priority)

- **NOTE 4 — dead build define.** `scripts/build-binary.sh:61` passes
  `--define GENIE_BUILD_VERSION='<v>'`, but nothing in `src/` reads `GENIE_BUILD_VERSION`
  (version resolves from the `VERSION` file stamp, which works). Harmless no-op; remove
  for clarity.
- **NOTE 5 — CI smoke test no longer asserts anything.** `build-tarballs.yml` smoke steps
  run `genie /work --help` (lines 125/148/167). `/work` is a Claude Code slash command,
  not a genie CLI subcommand in v5; genie prints top-level help and **exits 0**, so the
  step passes but verifies nothing. Not fatal. Swap for `genie doctor` or `genie --help`
  to make the smoke test meaningful again.
- **NOTE 6 — local bun below engine floor.** This host has bun 1.3.9; `package.json`
  engines requires `>=1.3.10` and CI uses 1.3.11 (build) / 1.3.10 (version). Local builds
  still succeeded and produced correct binaries — no release impact, CI is source of truth.

---

## Bottom line for tagging
Fix **BLOCKER 1** (install.sh handoff) before cutting — it breaks the primary
`curl | bash` install on the most common first-run environment. Resolve **BLOCKER 2**
(or explicitly deprecate the plugin-marketplace install) so the two install paths don't
diverge to different major versions. Ensure the release is cut via the **dev-bump
pipeline** (not a manual tag of the current commit) so **SHOULD 3** auto-heals, or bump
the plugin JSONs by hand first. The signing/attestation/publish/verify machinery and the
tarball artifacts themselves are sound.
