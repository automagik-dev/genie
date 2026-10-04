# Upgrading Genie

Genie ships exactly two surfaces, and nothing else:

1. **The signed binary** — installed and updated by `install.sh` and `genie update`.
2. **The skills, and the saved-workflow catalog beside them** — delivered by the [skills.sh](https://skills.sh) channel. `genie install` and `genie update` run the pinned skills CLI over the tree the signed release put on disk, deliver `.claude/workflows/*.js` into `~/.claude/workflows`, then record what landed in `~/.genie/skills-install.json`. Without the binary, the same skills install with `npx skills add automagik-dev/genie` (add `-g` for a machine-wide install; never `--all`, which asks the skills CLI to write a product home for every one of the 77 agents in its registry — 57 of them materialized on the measured dogfood host (2026-08-30, re-confirmed 2026-09-01; only 4 were recorded, leaving 53 unrecorded homes).

There is no Claude marketplace plugin, no Codex plugin, no Orca plugin, no Genie-installed hooks, and no role-agent profiles.

`--integrations auto|codex|claude|all|none` (or `--skip-integrations`) is the consent scope for the skills channel. Any value other than `none` installs to **every** detected agent skill home, because the skills CLI already installs per agent; `none` skips the channel entirely, writes no record, and reports `skills: skipped (consent: none)`. A failed skills install never rolls back the promoted binary — it prints the exact remedy command and sets a non-zero exit code.

Upgrading from a plugin-era release? The one-shot, backup-first retirement `genie update` used to run for that era shipped from `5.260711.6` through the last `5.x` release and **was removed in v6**, three stable releases after its compat window opened. A host that updated through any `5.x` release is already clean and needs nothing. A host coming straight from the plugin era to v6 is not cleaned up by genie at all any more — see [Removing plugin-era leftovers by hand](#removing-plugin-era-leftovers-by-hand). Genie still retires what the **skills** channel itself no longer delivers, backup-first, under `~/.genie/state-backups/skills-retirement-<timestamp>/`.

From inside a trusted initialized repo, run `genie init` to scaffold state and retire proven-owned historical MCP routes. Then run `genie doctor` to confirm the install: it reports one `skills: <agent> <present>/<total> @ <ref>` line per known agent skill home, `not detected` for a home this host does not have, and a warning naming `genie update` when skills are missing or older than the running binary.

## Lifecycle authority

Genie has one lifecycle authority: its own per-repository board — `.genie/genie.db`, reconciled with the tracked
`.genie/roadmap.json`. Orca mode is retired. For one release `genie setup --orchestration-mode` stays as a hidden
stub: `standalone` prints a notice and exits 0, `orca` prints a retirement notice and exits 2, and neither writes
configuration. A leftover `orchestration.mode` key in `~/.genie/config.json` is harmless — genie ignores it and drops
it on the next config write.

### Update, rollback, and uninstall

Run `genie doctor` after installation or update before resuming lifecycle mutations.
`genie update --rollback` checks the retained rollback state and prints signed-version reinstall guidance when a safe
in-place rollback is unavailable; follow that guidance, then run `genie doctor`. A failed update or rollback leaves the
prior configuration unchanged. `genie uninstall` removes only ownership-proven Genie artifacts and registrations.
Modified or unproven files are preserved, and local Genie history is never deleted. Review the command's
backup/recovery output before removing any retained files manually.

### MCP retirement

The legacy Genie MCP server is retired, and v6 removed the `genie mcp` stub that stood in for it — the verb no longer
parses. Use the standalone `genie task` and `genie board` commands instead. `genie init` removes only marker-owned or
exact Genie-owned historical project registrations and preserves unrelated or unproven user configuration
byte-for-byte. Rollback to a pre-A7 signed release remains the migration escape hatch for a host that still needs the
verb to answer at all.

### Orca integration retired

The Orca plugin, its adapter and the one-way card mirror are gone. For one release `genie orca` stays visible as a
stub: any `genie orca …` call, `genie orca mirror` included, prints a retirement notice, writes nothing and exits 2.
Release tarballs keep an empty `plugins/genie/` directory only so earlier binaries can still update; nothing reads
it. An Orca install of the plugin keeps running the commit Orca pinned, so uninstall it from Orca yourself.

### mikro Phoenix spans are off until you configure them

`genie mikro call` used to post every attempt to `http://127.0.0.1:6006`, project `cc-mikro`, whether or not a
Phoenix was there. It now posts only when you name both the project and the endpoint:
`MIKRO_PHOENIX_PROJECT=<your project> PHOENIX_ENDPOINT=<your Phoenix>`. Any Phoenix works, including the self-hosted
single-command install. A `PHOENIX_*` variable set for another tool no longer turns posting on, and an unconfigured
host makes no network call. To keep the old behavior, export `MIKRO_PHOENIX_PROJECT=cc-mikro` and
`PHOENIX_ENDPOINT=http://127.0.0.1:6006`.

## Skills

### Where the skills land

`genie install` and `genie update` run the pinned skills.sh CLI over the delivered tree under `~/.genie/skills`,
never over a GitHub ref — the signed tarball's own bytes are the only source genuinely pinned to your binary. The
public `npx skills add automagik-dev/genie` command serves the repository's default branch instead, so it can be
ahead of or behind any release.

Retirement runs **before** the install pass, so a home the skills CLI replaces has already been backed up. Removed
skills whose content still matches the previous install record are archived under
`~/.genie/state-backups/skills-retirement-<timestamp>/`, mirroring their path relative to `$HOME`. Modified or
unverified copies remain for manual review; a recorded agent home that no longer exists is reported and kept in the
record. If retirement fails, `genie update` retains the previous record and reports a retry.

#### Restoring from a retirement backup

Restore without asking for the backup's modes (`cp -R`, or `rsync -a --no-perms`). A plain `cp -a` copies the
backup's own directory metadata onto the agent homes that already exist, so a `drwxr-xr-x` `~/.claude` silently
becomes `drwx------`:

```bash
BK=~/.genie/state-backups/skills-retirement-<timestamp>
cp -R "$BK/." "$HOME/"
# or, equivalently:
rsync -a --no-perms "$BK/" "$HOME/"
```

Both forms work with GNU coreutils and with the BSD `cp` macOS ships; GNU's `cp -a --no-preserve=mode` is
equivalent on Linux but is rejected on macOS.

Both forms restore the removed trees and leave the modes of pre-existing directories alone.

Every known agent skill home gets a copy:

| Agent | Skill home |
|-------|------------|
| Claude Code | `~/.claude/skills` |
| Codex (and every other agent reading the shared home) | `~/.agents/skills` |
| Goose | `~/.config/goose/skills` |
| Windsurf | `~/.codeium/windsurf/skills` |

Codex reads the shared `~/.agents/skills` home; the skills CLI creates no `~/.codex/skills`. A skill directory a
different tool already owned is backed up before it is overwritten, and the backup location is reported.

After a zero-exit install, Genie records `~/.genie/skills-install.json` — the release tag, the pinned CLI version,
the skill inventory, every agent directory the install actually wrote (a bounded scan of your home, not a fixed
table), a content digest per directory, and any collisions it backed up. That record is what `genie doctor` reads
for its `skills:` lines and what `genie uninstall` proves against before it deletes anything: a directory whose
digest no longer matches is preserved and reported, never removed.

### Removing plugin-era leftovers by hand

Genie no longer removes these. Through the last `5.x` release `genie update` classified and retired them
automatically; v6 deleted that code, so on a host that never updated inside the window the files below simply stay
where the plugin era left them. None of them is read by v6 — they are inert, not harmful — so removing them is
housekeeping, at your own pace. **Back up anything you are unsure about; genie is no longer taking the backup for
you.** Anything in these paths you created yourself is yours: check before deleting.

| What | Path |
|------|------|
| Claude marketplace registration | `~/.claude/plugins/marketplaces/automagik/` |
| Claude plugin cache | `~/.claude/plugins/cache/automagik/genie/` |
| Codex plugin cache | `~/.codex/plugins/cache/automagik/genie/` |
| Codex role-agent profiles | `~/.codex/agents/genie-*.toml` |
| Codex role-agent inventory | `~/.codex/agents/.genie-role-agents.json` |
| Codex fallback transaction dirs | `~/.codex/agents/.genie-*-retirement/`, `~/.agents/skills/.genie-codex-fallback-retirement/` |
| Codex curated skill lane | `~/.codex/skills/.curated/` |
| Hermes link + marker | `~/.hermes/` genie symlinks, and the genie block in `~/.hermes/config.yaml` |
| pi link + marker | `~/.pi/extensions/` genie symlinks, and the genie block in its config |
| Codex plugin enablement | the `[plugins."genie@automagik"]` table in `~/.codex/config.toml` |
| Claude plugin enablement | the `"genie@automagik"` key under `enabledPlugins` in `~/.claude/settings.json` |
| Stamped workflow sidecar | `~/.claude/workflows/council.js.genie-sync.json` |

Two of these are keys inside files you own, not whole files: remove only the named table/key and leave the rest of
`~/.codex/config.toml` and `~/.claude/settings.json` alone. `genie doctor` does not report any of this — the checks
that observed it left with the code that acted on it.

### Verifying and removing

```bash
genie doctor      # one skills: <agent> <present>/<total> @ <ref> line per known home
genie uninstall   # removes the recorded install, then the binary
```

`genie doctor` never repairs this surface — not even with `--fix`. `genie update` owns every mutation. `genie
uninstall` deletes only the recorded skill directories it can still prove are Genie's, leaves skills you installed
yourself in place, and does not restore a foreign directory a previous install overwrote (the backup it took is
yours to restore).

## MCP retirement

The legacy cross-client MCP server, its write tools, plugin launchers, and Genie-owned registrations are retired.
v6 also removed the `genie mcp` retirement stub itself: the verb no longer parses, so use `genie task` and
`genie board`. Host state is still cleaned up, because that was never about the verb — `genie init` removes only
historical registrations proven to be Genie-owned: in `.mcp.json` a `genie` server whose command is a genie binary
with args exactly `["mcp"]`, plus the marker-owned `.codex/config.toml` route, backing the file up first. Meanwhile
unowned same-name routes and every unrelated config key remain untouched, and `genie doctor` keeps reporting a dead
route it finds.

The UI-owned `genie ui-bridge` went the same way: there is no separate Genie UI any more, and the private stdio transport, tool registry, and change watcher behind the bridge are
deleted along with the verb. `genie task` and `genie board` retain their existing behavior.

## Coming from v4?

v4 is preserved on the [`v4` branch](https://github.com/automagik-dev/genie/tree/v4), and its final npm release stays published for existing v4 users — nothing you're running today disappears.

v5 was the deliberate cutover to a lightweight body. The v4 harness — a Postgres backend, pane-based process orchestration, executor registries, the telemetry spine, the full-screen console, and the desktop app — is gone. What remains is the part that always did the work: the skills, the documents, and one SQLite file of state.

v6 is where the product and its documentation finally describe the same thing. It discharges the debt a major exists to discharge: the surfaces that had no implementation behind them are removed rather than left as stubs, the docs describe the commands that exist, and the supported platforms are stated rather than assumed. The `.genie/genie.db` schema migrates itself forward on first open under the new binary; a database at an unbridgeable version still refuses rather than guessing. See the [release notes](https://docs.automagik.dev/genie/release-notes) for what is gone and what to do instead.

> **Channel migration (2026-07):** the `homolog` channel was retired. Configs pinned to `homolog` are migrated to **stable** automatically on next run; `genie update --homolog` no longer exists — use `--stable` or `--dev`.
