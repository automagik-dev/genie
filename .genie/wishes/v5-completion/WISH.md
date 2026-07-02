# Wish: v5 Completion — Docs Truth, Multi-Agent Launch, Distribution

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `v5-completion` |
| **Date** | 2026-07-02 |
| **Author** | Felipe + Genie |
| **Appetite** | ~2–3 days |
| **Branch** | `wish/v5-completion` (from `dev`; PR back to `dev`) |
| **Design** | _No brainstorm — direct wish; three independent tracks bundled by request_ |
| **Depends on** | warp-integration, omni-runner-port, dispatch-inproc-default (all merged to dev) |

## Summary

Close out the v5 lightweight body with the three remaining independent tracks, bundled into one wish at the user's request: (1) rewrite `CLAUDE.md` — the instruction set every agent loads — which still documents the deleted v4 harness (`genie agent/team/exec`, pgserve, `GENIE_OTEL_*`, tmux, native-teams, "~305KB bundle"); (2) extend `genie launch` beyond Claude Code to Codex via its real non-interactive CLI (`codex exec`), with an honest Hermes integration-model decision (Hermes is API-only and does NOT fit terminal-pane launch); (3) the distribution track that `v5-housekeeping` explicitly handed here (its WISH lines 30-31): adopt a real 5.x version scheme AND **remove the npm vestiges** — v5 does NOT ship to npm (package.json says "npm distribution discontinued 2026-05-09"; `release-publish.yml` ships cosign+SLSA-signed tarballs installed via curl). The three groups are independent (no shared source files, no ordering) → all Wave 1, parallel. Note (M2): this is a mixed-concerns PR by CLAUDE.md's own discipline — land it as three separate commits so each track is independently reviewable/revertible.

## Scope

### IN
- **G1 — CLAUDE.md rewrite:** replace every stale-v4 claim with the shipped v5 surface (12 commands: board/doctor/hook/init/launch/omni/setup/shortcuts/task/uninstall/update/help; per-repo `.genie/genie.db` + global `~/.genie/genie.db`; in-process fail-closed hook dispatch; 4 runtime deps incl. nats; skills + `.genie` taxonomy; no daemons except the optional omni runner). Correct the architecture map (delete the `agent/team/exec` namespaces, the 4-scope v4 state table, OTel/pgserve env vars, the "~305KB" bundle → real 0.92MB). Keep the still-true sections (build, testing, code style, complexity budget, PR-review rules, engineering discipline). A drift-guard test/grep so the worst v4 fossils can't silently return.
- **G2 — Multi-agent launch targets:** parameterize `genie launch`'s pane command (today hardcoded at `src/term-commands/launch.ts:290` as `claude "$(cat "${promptPath}")"`) by an agent target via a single small mapper. **Codex** becomes a concrete launch target: a `--agent <claude|codex>` flag (default `claude`) whose `codex` form emits `codex exec "$(cat "${promptPath}")"` (verified: `codex` is on PATH; `codex exec` is its non-interactive subcommand — determine the exact flags via `codex exec --help`). NOTE `src/lib/codex-config.ts` is TOML-config-only (manages `~/.codex/config.toml` — paste-burst + an OTel relay); it has NO launch surface and is NOT the source of the invocation — the two are unrelated. **Hermes** gets an honest integration-model DECISION (not forced code): Hermes is an HTTP/API agent with no launchable terminal CLI, so it does not fit the pane model — this group produces `.genie/wishes/v5-completion/hermes-integration.md` (NOT under `docs/` — that is a `.docs-vendor` submodule symlink; a genie-repo decision doc must live under `.genie/`) recommending whether Hermes belongs as (a) a future `genie hermes` runner like omni, (b) an emit-to-API path, or (c) out of scope — with rationale, NOT a half-built launcher.
- **G3 — Distribution (5.x scheme + REMOVE npm vestiges; v5 ships signed tarballs, NOT npm):** this is the exact track `v5-housekeeping` handed here (its WISH lines 30-31). npm distribution was discontinued 2026-05-09 — `release-publish.yml` ships cosign+SLSA-signed tarballs to GitHub Releases, install via `curl … install.sh`. So: (a) adopt a **5.x version scheme** — reconcile `scripts/version.ts` (hardcodes `4.${datePrefix}.${n}` at line 45 + `git tag --list "v4.${datePrefix}.*"` at line 24) to 5.x and set `package.json` version to a 5.x value; `genie --version` reports it (the runtime resolver in `src/lib/version.ts` reads the package.json → real version, so no `0.0.0-unknown` risk on a set version). (b) **Remove the npm vestiges** per the housekeeping handoff: `publishConfig`, the npm-only `prepack`, any dead plugin-sync/npm scripts; correct the package.json `description` if it still steers to npm; keep the `files` allowlist honest (it governs the SIGNED TARBALL contents too). (c) Audit the release workflows (`version.yml`, `audit-next-tag.yml`, `build-tarballs.yml`, `release-publish.yml`, `sign-attest.yml`, `rolling-pr.yml`, `release-orphan-alert.yml`) for `v4.`/date-scheme assumptions — fix the ones the 5.x change breaks, explicitly DEFER-with-note any that are genuinely a separate concern. (d) Reconcile release-bot push-to-main with the now-armed branch-guard (does the bot still push to main? is it correct/exempt?). Validate the shipped-tarball contents with `npm pack --dry-run` (packs + lists files, NO registry, NO auth — proves the `files` allowlist; do NOT use `npm publish`). Capture resolutions + deferrals in `.genie/wishes/v5-completion/release-checklist.md`.

### OUT
- Cutting/tagging a public 5.x release (this wish makes it READY + tarball-proven; the human cuts the real release). Reviving npm publishing (v5 is signed-tarball + curl — vestiges are REMOVED, not settled).
- Building the Hermes integration itself (G2 decides the model; a separate wish builds it if the decision is "yes, a runner").
- Rebuilding any daemon, TUI, or v4 harness component.
- The live WhatsApp QA from omni-runner-port (still Felipe's, tracked in that wish's qa.md).
- Changing hook-dispatch, omni, or warp-launch behavior (G2 only ADDS a target dimension to launch; it must not alter the Claude path).
- Purging the OTel RELAY that `codex-config.ts` uses for Codex state detection — only the dead `GENIE_OTEL_PORT*` env-var docs are removed from CLAUDE.md, not OTel wholesale.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Three independent groups, all Wave 1 parallel | No shared files, no ordering dependency — docs, launch, and release infra don't touch each other; bundled into one wish per user request but shippable as one focused PR |
| 2 | Codex = concrete launch target via `codex exec`; Hermes = decision doc, not code | Codex has a launchable non-interactive CLI (`codex exec <prompt>`) that fits the worktree-pane model; `codex-config.ts` (TOML/OTel-relay config) is unrelated to the invocation. Hermes is API-only — forcing it into a pane launcher would be dishonest; it needs its own model (likely a runner), decided here, built later |
| 3 | 5.x version scheme; v5 does NOT ship to npm — REMOVE the vestiges | Corrects a false premise caught in plan review: npm was discontinued 2026-05-09 (package.json description + `release-publish.yml` cosign/SLSA tarballs + the `v5-housekeeping` handoff). The date-based `4.YYMMDD.N` stamps can't express "this is v5"; a real 5.x scheme + removing dead npm config is what housekeeping actually queued here |
| 4 | Make it release-READY + tarball-proven (`npm pack --dry-run`), don't publish/tag | Cutting a release is a human act (changelog + signing + announcement); the wish removes blockers and proves the tarball `files` allowlist without a registry or auth. `npm pack --dry-run` packs+lists only — NOT `npm publish` |
| 5 | G2 must not alter the Claude launch path | Warp-integration shipped and is reviewed; adding a target dimension is additive — the default `--agent claude` output stays byte-identical |
| 6 | Decision docs live under `.genie/`, never `docs/` | `docs/` is a `.docs-vendor` submodule symlink — a file written there lands in the submodule (needs the docs-PR + pointer-bump flow), NOT the genie PR. `.genie/` is in the genie repo |
| 7 | Bundled as one wish (user request) but landed as 3 commits | Three unrelated concerns = a mixed-concerns PR by CLAUDE.md discipline; separate commits keep each track independently reviewable and revertible |

## Success Criteria

- [ ] G1: `CLAUDE.md` has zero references to the retired v4 surface (`genie agent`/`genie team`/`genie exec` namespaces, pgserve/PostgreSQL, `GENIE_OTEL_PORT`, tmux orchestration, native-teams/`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`/`workers.json`/`GENIE_IDLE_TIMEOUT_MS`/mailbox, "~305KB" bundle); it documents the real 12 commands + genie.db + in-process hooks; a drift-guard grep gate fails if any fossil returns; the still-true sections are preserved; `bun run check` green.
- [ ] G2: `genie launch <slug> --agent codex --dry-run` emits a pane command of the form `codex exec "$(cat …)"` against the worktree prompt (asserted in the YAML); `--agent claude` (default) output is byte-identical to today; an invalid `--agent` value → typed error; the Hermes decision doc exists under `.genie/` with a clear recommendation; launch tests green.
- [ ] G3: `package.json` version is 5.x; `genie --version` reports it (not `0.0.0-unknown`); `scripts/version.ts` generates 5.x (no `4.`/`v4.` hardcodes); the npm vestiges (`publishConfig`, npm-only `prepack`, dead plugin-sync/npm scripts) are REMOVED; `npm pack --dry-run` succeeds and the tarball contains exactly the intended files (no stale/vestigial entries); the release workflows are audited (each v4-assumption fixed or deferred-with-note in `.genie/wishes/v5-completion/release-checklist.md`); nothing published/tagged.
- [ ] Full `bun run check` + build + e2e green; CI green on the PR.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1, Group 2, Group 3 | Fully independent — parallel. Each is one focused, independently-reviewable change within the shared PR. |

---

## Execution Group 1: CLAUDE.md-for-v5 rewrite

**Goal:** The instruction set every agent loads describes v5 reality, not the deleted v4 harness.

**Deliverables:**
1. Rewrite `CLAUDE.md`: fix the Architecture map (drop `agent/team/exec` namespaces + their command tables; describe `src/lib/v5/`, `src/hooks/` in-process dispatch, `src/term-commands/` for the real 12 commands, `skills/`, `.genie/`); replace the "State File Locations (4 scopes)" v4 table with the v5 truth (per-repo `.genie/genie.db`, global `~/.genie/genie.db`, git-tracked `.genie/wishes|brainstorms|INDEX.md`); remove the dead `GENIE_OTEL_PORT*` env-var rows, pgserve, the v4 namespace command blocks, and the native-teams surface (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `~/.claude/teams`, `workers.json`, `GENIE_IDLE_TIMEOUT_MS`, mailbox, `buildTeamLeadCommand`); fix "Build" (~0.92MB, 4 runtime deps incl. nats); update Gotchas to v5 (the in-process fail-closed dispatch from dispatch-inproc-default — keep coherent). CAVEAT: do NOT blanket-purge the word "OTel" — `codex-config.ts` uses an OTel relay for Codex state detection; only the dead `GENIE_OTEL_PORT*` env vars go. KEEP the still-accurate sections verbatim (Commands, Docs submodule, Testing, Code Style, Cognitive-complexity budget, PR Review Rules, Engineering/QA/Release Discipline).
2. Drift-guard: a test or e2e grep gate asserting `CLAUDE.md` contains none of the retired-fossil tokens.

**Acceptance Criteria:**
- [ ] Zero stale-v4 fossils (grep gate incl. the native-teams tokens); real 12-command surface + genie.db + in-process hooks documented; still-true sections preserved; OTel relay reference (if any) untouched.
- [ ] Drift-guard gate fails hard if a fossil returns.
- [ ] `bun run check` green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
for t in 'pgserve' 'PostgreSQL' 'GENIE_OTEL' 'genie agent spawn' 'genie team ' 'genie exec ' '305KB' 'tmux is required' 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' 'workers.json' 'GENIE_IDLE_TIMEOUT_MS' 'buildTeamLeadCommand'; do
  if grep -qF "$t" CLAUDE.md; then echo "FAIL: stale v4 fossil in CLAUDE.md: $t"; exit 1; fi
done
HELP=$(bun dist/genie.js --help 2>/dev/null || { bun run build >/dev/null 2>&1; bun dist/genie.js --help; })
for c in board doctor hook init launch omni setup shortcuts task uninstall update; do
  grep -qE "genie $c\b|^\| .*$c" CLAUDE.md || { echo "FAIL: CLAUDE.md missing v5 command: $c"; exit 1; }
done
bun run check
```

**depends-on:** none

---

## Execution Group 2: Codex launch target + Hermes integration decision

**Goal:** `genie launch` can drive Codex in a worktree pane; the Hermes model is decided, not half-built.

**Deliverables:**
1. Parameterize the launch pane command by agent target. Today `src/term-commands/launch.ts:290` builds `claude "$(cat "${promptPath}")"`. Add an `--agent <claude|codex>` flag (default `claude`) that selects the invocation via one small mapper: `claude` stays EXACTLY as-is; `codex` emits `codex exec "$(cat "${promptPath}")"` (run `codex exec --help` to pin the exact non-interactive flags; the prompt-file + worktree + Warp-pane machinery is unchanged). `src/lib/codex-config.ts` is NOT involved — it configures `~/.codex/config.toml`, not the launch invocation. Keep the mapper a data table so a third target is an entry, not a rewrite.
2. `--agent claude` output MUST be byte-identical to current `genie launch` — regression-assert against the existing `launch.test.ts:109` dry-run YAML string.
3. Tests: `launch <slug> --agent codex --dry-run` → YAML pane command is `codex exec "$(cat …)"` against the worktree prompt; default/`--agent claude` unchanged (byte-identical); an invalid `--agent` value → typed error.
4. Hermes integration-model decision: `.genie/wishes/v5-completion/hermes-integration.md` (under `.genie/`, NOT `docs/` — that is a submodule symlink) — state that Hermes is an HTTP/API agent (per hermes-agent.nousresearch.com developer guide) with no launchable terminal CLI, so it does not fit the worktree-pane launch model; recommend the integration shape (runner like omni / emit-to-API / defer) with rationale and a rough sketch. NO Hermes launcher code in this group.

**Acceptance Criteria:**
- [x] `--agent codex --dry-run` emits `codex exec "$(cat …)"` (asserted); `--agent claude` byte-identical to today; bad `--agent` → typed error.
- [x] Agent-command mapping is a single extensible seam (a third target = a data entry, not a rewrite).
- [x] Hermes decision doc exists under `.genie/` with a clear recommendation; no half-built Hermes launcher.
- [x] launch tests + typecheck + build green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/term-commands/launch.test.ts
bun run typecheck
bun run build
test -f .genie/wishes/v5-completion/hermes-integration.md
grep -qiE 'recommend|decision' .genie/wishes/v5-completion/hermes-integration.md || { echo "FAIL: Hermes doc has no recommendation"; exit 1; }
```

**depends-on:** none

---

## Execution Group 3: Distribution — 5.x scheme, remove npm vestiges, signed-tarball hygiene

**Goal:** v5 carries a real 5.x version, the dead npm surface is gone, and the signed-tarball/curl release path is coherent — READY, tarball-proven, nothing published.

**Deliverables:**
1. Version scheme: reconcile `scripts/version.ts` to 5.x — it hardcodes `4.${datePrefix}.${n}` (line ~45) and `git tag --list "v4.${datePrefix}.*"` (line ~24); choose and document a 5.x scheme (e.g. `5.YYMMDD.N` to preserve the daily-counter mechanism, OR plain semver — decide + document in the release-checklist). Set `package.json` version to a matching 5.x value. `genie --version` must report it — the runtime resolver in `src/lib/version.ts` reads the package.json, so a set version reports correctly (the `0.0.0-unknown` fallback is only for an unreachable package; confirm not hit). If `scripts/version.ts` has a dead `src/lib/version.ts` stamp step (regex no longer matches the runtime resolver), remove it.
2. Remove the npm vestiges (the `v5-housekeeping` handoff, its WISH lines 30-31): delete `publishConfig`, the npm-only `prepack` (unless the signed-tarball build reuses it — verify against `build-tarballs.yml`), and any dead plugin-sync/npm scripts; ensure the package.json `description` doesn't steer to a revived npm path (it currently correctly says "npm distribution discontinued" — keep that truth). Keep the `files` allowlist honest — it governs the SIGNED TARBALL contents (`build-tarballs.yml` / `release-publish.yml`), so it must ship exactly what the tarball needs.
3. Audit the release workflows for `v4.`/date-scheme assumptions that the 5.x change breaks — `version.yml`, `audit-next-tag.yml`, `build-tarballs.yml`, `release-publish.yml`, `sign-attest.yml`, `rolling-pr.yml`, `release-orphan-alert.yml`. Fix the ones 5.x breaks; explicitly DEFER-with-note any genuinely separable concern.
4. Reconcile release-bot push-to-main with the now-armed branch-guard: does the release bot still push to main, and is that correct/exempt given branch-guard now denies agent pushes to main on the default dispatch path? Document the finding.
5. Capture every resolution + deferral + the chosen version scheme in `.genie/wishes/v5-completion/release-checklist.md`.
6. Do NOT publish, do NOT tag, do NOT revive npm.

**Acceptance Criteria:**
- [ ] `package.json` version is 5.x; `scripts/version.ts` generates 5.x (no `4.`/`v4.` hardcodes); `genie --version` reports the 5.x version (not `0.0.0-unknown`).
- [ ] npm vestiges removed (`publishConfig`, dead `prepack`/plugin-sync/npm scripts); `files` allowlist honest for the signed tarball.
- [ ] `npm pack --dry-run` succeeds (packs+lists only, no registry/auth); tarball contains exactly the intended files, no stale entries.
- [ ] Release workflows audited; each v4-assumption fixed or deferred-with-note; release-bot/branch-guard interaction documented — all in `.genie/wishes/v5-completion/release-checklist.md`.
- [ ] `bun run check` + build green; nothing published/tagged.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
VER=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
case "$VER" in 5.*) : ;; *) echo "FAIL: version not 5.x: $VER"; exit 1 ;; esac
if grep -qE "['\"\`]v?4\.\\\$\{|['\"\`]4\.\\\$\{|list \"v4\." scripts/version.ts; then echo "FAIL: scripts/version.ts still hardcodes 4.x"; exit 1; fi
if python3 -c "import json,sys; sys.exit(0 if 'publishConfig' in json.load(open('package.json')) else 1)"; then echo "FAIL: publishConfig npm vestige still present"; exit 1; fi
bun run build
REPORTED=$(bun dist/genie.js --version 2>/dev/null | tr -d '[:space:]')
echo "$REPORTED" | grep -q "0.0.0-unknown" && { echo "FAIL: --version reports 0.0.0-unknown"; exit 1; }
echo "$REPORTED" | grep -q "5\." || { echo "FAIL: --version not 5.x: $REPORTED"; exit 1; }
npm pack --dry-run >/tmp/genie-pack.txt 2>&1 || { echo "FAIL: npm pack --dry-run errored"; cat /tmp/genie-pack.txt; exit 1; }
grep -qE 'dist/genie\.js' /tmp/genie-pack.txt || { echo "FAIL: tarball missing dist/genie.js"; exit 1; }
test -f .genie/wishes/v5-completion/release-checklist.md
bun run check
```

**depends-on:** none

---

## Cross-wish dependencies

- **Completes** the v5 lightweight-body umbrella (foundation → demolition → housekeeping → taxonomy → warp → omni → dispatch-fix → this).
- **Enables** (does not perform): a public 5.x signed-tarball (curl) release (G3 makes it ready — NOT npm); a Hermes runner wish (G2 decides its model).
- **Coordinates with** the still-open omni live-WhatsApp QA (separate, Felipe's).
