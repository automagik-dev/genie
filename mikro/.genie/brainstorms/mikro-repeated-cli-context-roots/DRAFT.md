# DRAFT — Repeated CLI context roots

Date: 2026-08-31
Status: READY

WRS: ██████████ 100/100

- Problem ✅ — repeated CLI values collapse and schema says singular.
- Scope ✅ — query/cache/batch only; no YAML, roles, escaping, or ACP/MCP expansion.
- Parser/schema ✅ — `--context` is an exact repeatable string (`repeatable: true`, `default: []`), commas stay literal, and `--ext` retains separate comma-list semantics with parity tests.
- Normalization ✅ — directory, ordinary string file, dict/JSON-scalar file, and JSON-array file shapes have frozen union identities, order, and mixed-root oracles.
- Injectivity ✅ — candidate collisions receive declaration-index prefixes, then collision-prefix closure deterministically rejects any remaining duplicate; the adversarial second-collision oracle has zero external side effects.
- Identity ✅ — multi-root prompt order, length-framed hash bytes, derived cache session ID, and persisted ordered root records are exact; singleton branches keep legacy framing and shape.
- Compatibility ✅ — singleton goldens compare a bounded byte set with run ID, clock, provider, package version, inputs, HOME, and terminal variability fixed or excluded.
- Risks ✅ — singleton drift, second-order collisions, cross-command divergence, reorder/cache aliasing, symlink dedupe, partial work, and session provenance each have explicit mitigations.
- Criteria ✅ — schema, query, cache, batch, mixed-root, collision closure, persistence, and singleton oracles are frozen.

Simplest complete design: retain the legacy singleton branch; for multi-root, normalize once, prefix direct collisions once, reject closure collisions, and hash the final ordered union with explicit length framing.

Next Step: return this validated planning fix to the parent workflow; no implementation or review in this loop.
