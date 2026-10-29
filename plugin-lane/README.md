# Genie's plugin lane

genie-dsh releases reach the Automagik desktop app without a Genie CLI release or an
Automagik one. The shape is Automagik's lane, schemaVersion 1 (automagik-dev/automagik
`plugin-lane/README.md`), with `publisher: "genie"`:

- https://raw.githubusercontent.com/automagik-dev/genie/lane/lane.json
- https://raw.githubusercontent.com/automagik-dev/genie/lane/lane.json.sig

- The `lane` branch holds those two files only, a new commit on every publish. Unlike
  Automagik's, Genie's lane is not a rolling release: this repository's releases are
  immutable, so a published release takes no new files. The signature is what a consumer
  trusts, wherever the bytes come from.
- Each tarball stays on its own immutable `genie-dsh-v<version>` release.
- `lane.json.sig` is ed25519 over the exact bytes of `lane.json`, detached, base64.
  `keys.json` here lists the public keys, `{ keys: [{ keyId, publicKey }] }`, PEM (SPKI).
- `sequence` is genie-dsh's version M.m.p as M·10⁸ + m·10⁴ + p.
- `base` is the floor of genie-dsh's `@automagik/bots-dsh` peer range: the oldest Bot team
  it runs on. genie-dsh does not follow Automagik's 3.N lines.
- The lane names `@automagik/genie-dsh` and nothing else.

`.github/workflows/plugin-lane.yml` publishes it when a genie-dsh change lands on dev:
`scripts/plugin-lane.ts` packs, writes, signs and verifies. The signing key is the
`PLUGIN_LANE_KEY` Actions secret and exists only there.
