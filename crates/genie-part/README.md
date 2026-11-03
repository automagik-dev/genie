# genie-part

Unfold's part contract, mirrored field for field: `trait Part { manifest, digest, schema, asks, call }`,
`PartManifest { schema, id, version, title, tools }`, `PartTool { name, effect, description? }`,
`Effect { None, Reversible, Irreversible }`, `PartOutput` and the `rth-part/v1` schema id. Every Genie
crate that Unfold may later load as a part implements this trait. Licensed Apache-2.0.

## The parity test

`tests/parity.rs` compares the declarations in `src/lib.rs` with a frozen, normalized copy of
Unfold's, `tests/fixtures/rth-tools-part.txt`. The copy records where it came from
(`bench/staging/agentd-rc5.13.3/ws/crates/rth-tools` in the rth checkout, `src/parts.rs`,
`src/authority.rs`, `src/profile.rs`, and `src/web.rs` for the `BoxFuture` alias `Part::call`
returns), the SHA-256 of each of those files, and the SHA-256 of its own body, so a hand edit is
caught too. Normalization drops comments, whitespace and closing
trailing commas; derives, serde attributes, names and types are compared as written.

The test proves only that the mirror still equals the copy. It never reads Unfold, so it cannot see
Unfold move.

## Re-pin

Run it when Unfold publishes `rth-tools`, or changes any of the four files.

1. Check the sources moved: `shasum -a 256 <rth>/bench/staging/agentd-rc5.13.3/ws/crates/rth-tools/src/{parts,authority,profile,web}.rs`
   against the `source` lines of the fixture. A new location means updating `UNFOLD_CRATE` in
   `tests/parity.rs` first.
2. Copy and normalize, which rewrites the fixture with fresh digests:

   ```bash
   GENIE_PART_REPIN=<rth>/bench/staging/agentd-rc5.13.3/ws/crates/rth-tools \
     cargo test -p genie-part --test parity the_mirror_equals_the_frozen_unfold_copy
   ```

   The comparison still runs after the rewrite, so a moved declaration fails here and lists every
   difference.
3. Fix the mirror in `src/lib.rs` until `cargo test -p genie-part` passes, then commit the fixture and
   the mirror together.
