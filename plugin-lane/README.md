# Genie's plugin lane

genie-dsh releases reach the Automagik desktop app without a Genie CLI release or an
Automagik one. The shape is Automagik's lane, schemaVersion 1 (automagik-dev/automagik
`plugin-lane/README.md`), with `publisher: "genie"`:

- https://github.com/automagik-dev/genie/releases/download/plugin-lane/lane.json
- https://github.com/automagik-dev/genie/releases/download/plugin-lane/lane.json.sig

- The rolling `plugin-lane` release holds those two files only. Each tarball stays on its own
  `genie-dsh-v<version>` release, which never changes.
- `lane.json.sig` is ed25519 over the exact bytes of `lane.json`, detached, base64.
  `keys.json` here lists the public keys, `{ keys: [{ keyId, publicKey }] }`, PEM (SPKI).
- `sequence` is genie-dsh's version M.m.p as M·10⁸ + m·10⁴ + p.
- `base` is the floor of genie-dsh's `@automagik/bots-dsh` peer range: the oldest Bot team
  it runs on. genie-dsh does not follow Automagik's 3.N lines.
- The lane names `@automagik/genie-dsh` and nothing else.

`.github/workflows/plugin-lane.yml` publishes it when a genie-dsh change lands on dev:
`scripts/plugin-lane.ts` packs, writes, signs and verifies. The signing key is the
`PLUGIN_LANE_KEY` Actions secret and exists only there.
