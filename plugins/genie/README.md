# Genie Orca plugin

This directory is the Orca plugin payload, and nothing else. It ships one native manifest
(`orca-plugin.json`), the entrypoint bundle Orca loads (`orca-entrypoint.min.js`, built from
`orca-entrypoint.ts` and byte-bound to it by `bun run lint:orca-bundle`), the compatibility metadata
Orca reads from `plugin.json`, and the contributor contract under `references/`.

For Orca installation, authority selection, recovery, compatibility, and contribution rules, see the
[Orca dual-mode operator and contributor contract](references/orca-orchestration.md). Standalone
remains the default; the packaged Orca payload is inert until the operator explicitly selects Orca
authority with `genie setup --orchestration-mode orca`.

## What ships here

| File | Purpose |
|------|---------|
| `orca-plugin.json` | The native Orca manifest. Version-stamped inside the release payload by `scripts/release-payload-version.ts`. |
| `orca-entrypoint.ts` → `orca-entrypoint.min.js` | The plugin entrypoint — the eight palette handlers and the agent-settle notification — and its committed esbuild bundle. `bun run lint:orca-bundle` fails CI on any drift between the two, so an edited blob can never be attested as reviewed source. |
| `orca-runtime.ts` | The runtime the entrypoint bundles. |
| `plugin.json` | Compatibility metadata only — `extensions."dev.orca.compatibility"` and `minimumRuntimeVersion`. |
| `package.json` | Runtime payload metadata, version-stamped with the binary. |
| `references/orca-orchestration.md` | The operator and contributor contract. |

## What the plugin contributes

- `contributes.commands`: `genie.wish`, `genie.work`, `genie.review`, `genie.fix`, `genie.report`, `genie.council`,
  `genie.doctor`, `genie.update` (`Genie: …`), all `context: "worktree"`, so they are listed only with an active
  workspace; `contributes.keybindings`: one `Ctrl+Alt+Shift+<letter>` chord per command, `when: "worktree"` (the
  validator requires `when` to equal the command's context); `contributes.events`: `agent.status.changed`.
- `capabilities`, as the `{"kind": …}` objects Orca's manifest schema requires: `workspace:read`, `terminal:send`,
  `notifications:show`, `events:subscribe` — exactly what the handlers call. Consent is per plugin and capability set,
  granted once when the plugin is enabled and asked again only when the set changes.
- The six lifecycle handlers read the active workspace through the host API (`workspace.readContext`), read its
  record and terminals through the adapter (`worktree show --worktree name:<displayName>`, accepted only on the
  context's branch, then `terminal list --worktree id:<id>`; the CLI's `active`/`current` are cwd shortcuts the worker
  can never satisfy, and a desktop paired to a remote runtime cannot see that workspace through its local CLI at all,
  so both reads degrade to the host context and the host's first terminal), and send
  the composed slash command through `terminal.sendText` — never through `orca terminal send`. With no agent terminal
  they `run-create` and `worker-start` from the text. The worker runs outside every terminal and every Run, the host
  rejects a command after 30 s, so the compatibility probe runs once per worker and every operation carries a bound.
- The card itself is written only by the genie binary (`genie orca mirror`); the plugin reads the comment back when a
  workspace's agent settles and turns a changed genie line into a desktop notification.
- Every fact the plugin interpolates into the text it submits — the workspace display name, its path — is stripped of
  control characters and collapsed to one line first. A display name is an agent-facing value (`orca worktree create
  --name`) and the text is sent with `enter: true`, so a newline in one would otherwise arrive in another agent's
  terminal as a second command. The adapter refuses a worktree record whose name or path carries a control character
  at the read boundary, before the plugin ever composes anything.

### Network egress

`Genie: Update` makes the plugin's **only** network request: an unauthenticated HTTPS `GET` of the release manifest
for the channel this host updates on — `https://raw.githubusercontent.com/automagik-dev/genie/main/.well-known/`
`latest.json` on the stable channel, `dev.json` on the dev channel. The channel is not guessed: the plugin asks the
installed binary with `genie config get updateChannel`, the same sticky preference `genie update` resolves, and every
unreadable answer falls back to stable. The result is compared against `genie --version` and shown as one toast;
nothing is downloaded and nothing is installed. Every other handler talks only to the Orca host API and the local
`genie` binary. The egress is named in the manifest description, which is what the consent dialog shows.

Nothing else belongs in this tree. It is force-pushed verbatim as the tree-only `orca-plugin` /
`orca-plugin-dev` subtree refs by `.github/workflows/orca-plugin-ref.yml`, and Orca's loader rejects
any tree containing a symlink and caps an install at 2000 files / 50 MB —
`scripts/orca-manifest-parity.test.ts` is the drift guard for both.

## What no longer ships here

The Claude marketplace plugin, the Kimi payload, the Codex plugin, the generated hook executables,
the role-agent profiles, the council workflow, and the committed `skills/` mirror have all been
removed. Genie delivers skills through the signed binary's own `skills/` tree via the skills channel,
and the Orca integration is the only UI surface. No launcher or registration ships from this
directory, and Genie never registers the plugin with Orca on the operator's behalf.

## Distribution and verification

This tree travels inside the signed release tarball as `plugins/genie/`, verified end to end by
`scripts/build-binary.sh` (staging/extracted tree equality plus `release-payload-version.ts --verify`)
and by the release workflow's delivery-evidence gates. Install and update Genie only through the
documented signed paths described in the repository root `README.md`.
