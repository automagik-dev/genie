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
| `orca-entrypoint.ts` → `orca-entrypoint.min.js` | The plugin entrypoint and its committed esbuild bundle. `bun run lint:orca-bundle` fails CI on any drift between the two, so an edited blob can never be attested as reviewed source. |
| `orca-runtime.ts` | The runtime the entrypoint bundles. |
| `plugin.json` | Compatibility metadata only — `extensions."dev.orca.compatibility"` and `minimumRuntimeVersion`. |
| `package.json` | Runtime payload metadata, version-stamped with the binary. |
| `references/orca-orchestration.md` | The operator and contributor contract. |

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
