# Plan: agent-sync — `genie update` converges every detected coding agent

## Context

Felipe's requirement (verbatim intent): **no new command** — `genie update` is the single canonical updater; the Claude Code plugin auto-update is merely a *trigger* that converges into it; and one update must refresh genie skills **in every detected coding agent: Claude Code, Codex, Hermes**.

Today `genie update` refreshes only `~/.genie/{plugins,skills,templates}` and no agent ever sees the result: the CC marketplace plugin is disabled+stale on the reference machine (no genie SessionStart hook runs, `~/.claude/skills` are hand-frozen copies), `~/.hermes/plugins` is empty (hermes-genie sits staged in `~/.genie/plugins/hermes-genie`, unbridged), and `~/.codex/skills` has only OpenAI built-ins (the historical genie→Codex skill-installer rule in `~/.codex/rules/default.rules` points at a dead repo slug). The council workflow stamp lives only in a hook that never fires there. Outcome wanted: **merge → release → `genie update` → everything testable in all three agents.**

## Architecture

### Single source of truth
`~/.genie/plugins/genie` — refreshed atomically by the existing `syncAuxiliaryContent` (`src/genie-commands/update.ts:1626,1652`); the tarball's `cp -RL` (scripts/build-binary.sh:64) dereferences the skills symlink so this one root carries `skills/` + `references/lenses/` + `workflows/council.js`, version-coherent. Fallback root `~/.genie/bin/plugins/genie` (install.sh:265 layout). Hermes source: sibling `~/.genie/plugins/hermes-genie`.

### Engine (internal — NOT a user-facing command)
New `src/lib/agent-sync.ts` (+ tiny `src/lib/genie-home.ts`: `resolveGenieHome()`; all target dirs injectable for tests):
- **Managed-dir model**: each synced skill dir carries `.genie-sync.json` `{managedBy:'genie-agent-sync', version, digest, syncedAt}`; digest = sha256 over sorted (relpath, sha256) pairs excluding the manifest.
- **Auto-adopt-with-backup, zero friction**: genie owns every name it ships. Existing same-name dir (unmanaged or user-modified managed) → backed up to `~/.genie/state-backups/agent-sync-<ts>/<agent>/<name>/`, then replaced; reported line by line. Dirs genie never shipped: untouched.
- **Removal of managed orphans** (mandatory): a managed dir absent from source is backed up + removed — kills the zombie `council/` skill that would otherwise resurrect the skill-vs-workflow name collision.
- **Atomicity**: staged `<dir>.new` + `rename` (pre-cleaning stale `.new`/`.old`), same pattern as `swapAuxiliaryTree` (reimplemented ~20 lines; do not export update.ts's private helper).
- **Report object** per agent: created/updated/unchanged/adopted/removed/skipped + advisory lines; update prints it.

### Adapters (detect → sync)
| Agent | detect() | sync() targets |
|---|---|---|
| **claude** | `${CLAUDE_CONFIG_DIR:-~/.claude}` exists | all source skills → `skills/<name>/`; council stamp → `workflows/council.js` — TS `stampWorkflow` twin of `council-stamp.cjs` (parity test), `LENS_ROOT` = stable source root |
| **codex** | `~/.codex/` exists | all source skills as Agent-Skills folders → `~/.codex/skills/.curated/<name>/` (native SKILL.md support confirmed on-machine; `.system` is OpenAI's, never touched); advisory line "restart Codex to pick up skills" (vendor-documented). Implementation-time verification: confirm `.curated/` discovery with one skill before fanning out; fall back to the skill-installer-visible location actually scanned |
| **hermes** | `${HERMES_HOME:-~/.hermes}` exists or `hermes` on PATH | ensure symlink `~/.hermes/plugins/genie -> ~/.genie/plugins/hermes-genie` (install-local.sh's default mechanism — future updates freshen Hermes for free via the atomic source swap); honor sticky-profile variant (`profiles/<active>/plugins/genie`); real dir found → adopt-with-backup then symlink; foreign symlink (dev checkout) → leave + report; newly linked + `hermes` binary present → `hermes plugins enable genie` (non-fatal; downgrade to advisory if enable proves non-idempotent). Remote cegonha: OUT — only local agents converge |

Notes: the `/council` **workflow** remains CC-only (Codex/Hermes have no dynamic-workflow runtime — already wish-OUT); Codex/Hermes receive the skills (incl. the 7 lanes). CC-specific tool references inside skills are an accepted lossy edge (historical precedent: the old skill-installer rule shipped the same skills to Codex).

### Triggers — one canonical place
- **`genie update`**: sync phase runs on EVERY invocation — including the "already at latest" short-circuit path (`shortCircuitIfCurrent`, update.ts:1424): update = converge everything, not just the binary. After a real swap, the OLD process execs the NEW binary (established pattern — `--version` probes at :693/:881/:1592) with internal env `GENIE_UPDATE_SYNC_ONLY=1` so the freshly landed version's sync logic runs immediately. Failures are non-fatal advisories.
- **`genie install`**: runs the sync phase in-process (fresh installs already execute the new binary via install.sh:374 handoff) + `normalizeAuxLayout()` fixing the `~/.genie/bin/{plugins,skills,templates}` mismatch.
- **CC plugin auto-update (SessionStart trigger)**: `plugins/genie/scripts/smart-install.js` — when the genie CLI is on PATH, exec `genie update` with `GENIE_UPDATE_SYNC_ONLY=1` (quiet, try/catch, throttled by a `~/.genie/.last-agent-sync` marker, e.g. 6h, so session starts stay cheap); its own council-stamp block shrinks to the CLI-less fallback path only (stamp via `resolveStampInputs` preferring the stable `~/.genie/plugins/genie` root, falling back to `CLAUDE_PLUGIN_ROOT` — kills the stale-cache downgrade ping-pong). No sync logic duplicated in the hook.
- **No new command, no new visible flag** — the internal env var is the only re-entry contract.

### Cleanups bundled (root-cause fixes)
- Delete `scripts/smart-install.js` + the `scripts/build.js:103-107` copy block (single source: the shipped `plugins/genie/scripts/smart-install.js` — currently one `bun run build:plugin` away from clobbering the council stamp).
- `skills/review/SKILL.md` + `skills/brainstorm/SKILL.md`: one identical anchor sentence for the lens root (`$GENIE_HOME/plugins/genie`, default `~/.genie/plugins/genie`; repo-relative inside the genie repo) so synced copies work in any repo; `validate/g4-consumers.sh` gains the `GENIE_HOME`-mention assertion. All existing literal path substrings stay intact (gate compatibility).
- `genie doctor`: per-agent freshness section (detected/enabled/linked, managed-current vs stale, council.js present/current); reports the marketplace plugin as optional/disabled — **never auto-re-enables it** (explicit user choice).
- `genie uninstall`: removes manifest-verified managed dirs per agent + stamped council.js + hermes symlink (extends existing `~/.agents/skills/genie` v4 residue cleanup).

## Files

**New:** `src/lib/genie-home.ts`, `src/lib/agent-sync.ts`, `src/lib/agent-sync.test.ts` (tmpdir-isolated: fresh-create/idempotent/update/adopt-backup/removal/orphan-kept/missing-agent-skip/digest-stability/stale-staging-cleanup + stamp parity vs `.cjs` via createRequire), `src/genie-commands/` wiring points below, validate gates `.genie/wishes/agent-sync/validate/{g1-engine,g2-wiring,g3-gate}.sh`.

**Edits:** `src/genie-commands/update.ts` (sync call on short-circuit path + post-swap exec w/ `GENIE_UPDATE_SYNC_ONLY`, new `runAgentSyncSafe` beside `runV4CleanupSafe:1500`); `src/genie-commands/install.ts` (normalize + in-process sync, `--skip` seam mirroring `V4CleanupRunner:20-26`); `src/genie.ts` (env-var branch, no new command registration); `plugins/genie/scripts/smart-install.js` (delegate-to-CLI + fallback stamp via new `resolveStampInputs` in `council-stamp.cjs`); `src/lib/council-workflow-stamp.test.ts` (resolveStampInputs cases); `scripts/build.js` (drop copy block) + delete `scripts/smart-install.js`; `skills/{review,brainstorm}/SKILL.md` + `validate/g4-consumers.sh`; `src/genie-commands/doctor.ts` (pattern at :380); `src/genie-commands/uninstall.ts`; docs (`plugins/genie/README.md` distribution section, `CLAUDE.md` gotchas: "one stamp root", "managed-skill manifest + adopt-with-backup", agent-sync row).

**Wish bookkeeping:** new wish `agent-sync` (this plan = its design; 3 groups: G1 engine+adapters ∥-safe new files → G2 wiring+hook+cleanups → G3 doctor/uninstall/docs/gates); `council-workflow` WISH G5 ritual + Decision 6/G2 note amended (CLI sync is primary; hook = trigger + CLI-less fallback); INDEX entries.

## Verification

1. `bun test src/lib/agent-sync.test.ts` — the behavior matrix above, green.
2. Parity: TS stamp output === `council-stamp.cjs` output.
3. `bun run check` green (725 pass / 1 skip baseline + new tests).
4. Gates `g1/g2/g3` fail-hard scripts green (g2 greps: update short-circuit calls sync, `GENIE_UPDATE_SYNC_ONLY` honored, hook delegates + fallback, `scripts/smart-install.js` ABSENT, build.js block gone, G4 skills mention `GENIE_HOME`).
5. **End-to-end on the reference machine (Felipe's ritual, one-time caveat):** merge → release → `genie update` (swaps binary; old code syncs nothing) → **`genie update` again** (short-circuits + syncs all three agents — no new commands, same canonical verb) → verify `~/.claude/skills` current + `~/.claude/workflows/council.js` present, `~/.codex/skills/.curated/` populated, `~/.hermes/plugins/genie` linked (+enabled) → run `/council` in Claude Code (council-workflow G5 QA evidence). **Every subsequent release: `genie update` once, everything converges — including via the CC-plugin SessionStart trigger.**
