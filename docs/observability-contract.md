# Observability Contract — Genie Serve Structured Observability

Wish: `genie-serve-structured-observability` · Status: **v0 (public)**

This document is the public consumer-compat contract for the event substrate.
External consumer agents, compliance tooling, and operator dashboards may
depend on the promises made here. Anything NOT listed here is an
implementation detail that may change without notice.

---

## 1. What consumers may rely on

### 1.1 Event type stability

Once an event type is added to the registry (`src/lib/events/registry.ts`)
and ships in a tagged release, the following is stable for the lifetime of
its `schema_version`:

| Guarantee | Details |
|---|---|
| Type name | Never renamed. Retiring requires a new type + deprecation window. |
| `schema_version` | Monotonically increasing integer. A query pinned to `schema_version=1` reads `v1`-shaped rows forever. |
| `kind` | `span` vs `event` never flips. |
| `tier_defaults` | `default` / `debug` / `audit` never downgrades. An audit-tier event never becomes non-audit. |
| Required fields | Once required, always required within the same `schema_version`. |
| Tier tagging | A field tagged tier-A stays tier-A. Downgrading a field to tier-B or tier-C would be a security regression and is forbidden. |

### 1.2 Schema evolution rules

New `schema_version` bumps happen only for:

- Adding a required field. (Optional-field additions do not bump.)
- Changing a field's type or validation.
- Renaming a field. (Field rename = new field + deprecation + removal in a
  future major.)
- Any change to redaction tier. (A tier upgrade — e.g. tier-C → tier-A — is
  safe; a downgrade is forbidden.)

Optional-field additions and new tier-C metadata fields do not bump
`schema_version`. Consumers that use strict Zod parsers must tolerate this
by accepting unknown optional fields (all registry schemas are `.strict()`
internally; consumers should parse with a permissive schema derived from the
public contract rather than mirroring the producer schema verbatim).

### 1.3 Never-rename, never-drop

Two invariants enforced by CI:

1. **Never rename a column** in `genie_runtime_events*`. New columns are
   added (nullable) via `ALTER TABLE ADD COLUMN IF NOT EXISTS`.
2. **Never drop a column** or a table. Deprecated columns are set to NULL by
   writers but remain present in the schema for a minimum of 180 days after
   the deprecation notice.

### 1.4 Transport stability

| Surface | Stability |
|---|---|
| `genie events list --enriched` flag output (alias `--v2` removed next release) | Stable shape; columns only grow, never shrink or reorder |
| `genie events stream --follow` NDJSON output | Stable key set; new keys may appear but existing keys will not be removed within a `schema_version` |
| `genie events timeline <trace_id>` ASCII output | Human-readable only — not a contract surface |
| `LISTEN genie_events.<prefix>` channel names | Stable; adding a new type under an existing prefix does not rename the channel |
| HMAC-chained `chain_hash` in audit table | Algorithm (HMAC-SHA256 over `prior_hash \|\| row_digest`) is stable; key rotation bumps the key version, not the algorithm |

---

## 2. Deprecation window

When a type or a field is deprecated:

| Day | What happens |
|---|---|
| **D0** | Deprecation announced; new `schema_version` released alongside the v0; dual-write begins |
| **D0 – D89** | Both versions produced; consumers may migrate at any time |
| **D90** | **Warning window ends.** Producers log a warning on every emit that still uses the deprecated shape |
| **D90 – D179** | Deprecated shape still accepted by consumers. New releases carry a `DEPRECATED_SINCE` tag on the schema file |
| **D180+** | Producers may stop emitting the deprecated shape. Consumers that pinned `schema_version` continue to work against historical rows. No column drops — only writes stop |

Consumers pinned to `schema_version=<n>` continue to read historical rows
produced with version `<n>` forever. Only new writes stop at D180+.

---

## 3. Version policy

### 3.1 Semantic versioning of the substrate

| Change | Bump |
|---|---|
| Add optional tier-C field | none |
| Add new type under existing prefix | none |
| Add new LISTEN prefix | none |
| Require a previously-optional field | type `schema_version` |
| Change a field's validation or type | type `schema_version` |
| Rename a column / table / type | Major release only (with 180d window) |
| Drop a column / table / type | Major release only, after 180d window |

### 3.2 Release tagging

Every release of `@automagik/genie` publishes the full `EventRegistry` as
`schema.json` alongside the tarball. A consumer can verify compatibility
with:

```bash
curl -s https://registry.npmjs.org/@automagik/genie/latest |
  jq -r '.dist.tarball' | xargs curl -s | tar -Oxzf - package/schema.json
```

A CI gate rejects any PR that changes `schema_version` for a type without an
entry in `CHANGELOG.md` naming the reason.

---

## 4. Compatibility matrix

### 4.1 Consumer ↔ Substrate

| Consumer built against | Works against substrate version |
|---|---|
| v0 | v0, v1, v2 (never-rename guarantees) |
| v1 | v1, v2 (may miss v2-only optional fields; tolerated) |
| v2 | v2, v3 (same rule recursively) |

Backwards compatibility — an older consumer reading a newer substrate —
never breaks provided the consumer ignores unknown optional fields.

Forwards compatibility — a newer consumer reading an older substrate — is
only guaranteed for the current and previous major release.

### 4.2 Audit-tier special rules

The audit tier (`genie_runtime_events_audit`) has stricter guarantees:

- Rows never updated, never deleted (WORM via trigger + role privileges).
- `chain_hash` column never changes algorithm within a major.
- Key rotation (`genie events rotate-redaction-keys`) adds a new HMAC key
  version; prior-version rows are re-verifiable forever.
- Schema evolution on the audit table is column-add-only. Every other
  mutation requires a coordinated migration that creates a new WORM table
  and keeps the old one readable indefinitely.

---

## 5. Non-promises

The following are implementation details and may change without notice:

- In-memory queue size, flusher cadence, batch size.
- Whether `emit.ts` uses COPY FROM STDIN vs batched INSERT (currently the
  latter; subject to change for perf reasons).
- The exact shape of the `data` JSONB column outside the documented
  `payload` keys (internal `_trace_id`, `_span_id`, etc. are subject to
  change — consumers should use the top-level columns instead).
- Partition naming conventions (`genie_runtime_events_p20260419`).
- PG role names beyond the four RBAC roles (`events:admin`,
  `events:operator`, `events:subscriber`, `events:audit`).
- Watchdog systemd unit file contents.

If a consumer depends on any of these, open an issue — either the contract
needs expansion or the consumer needs to change.

---

## 6. Support channels for consumers

| Question | Where |
|---|---|
| Schema contract dispute | Open an issue labelled `observability-contract` |
| Missing type / prefix | PR against `src/lib/events/schemas/` + `registry.ts` |
| Deprecation timing concern | Email maintainers before D0 of the deprecation |
| Security finding | `SECURITY.md` private disclosure path |

---

## 7. Links

- Rollout plan: [docs/observability-rollout.md](./observability-rollout.md)
- Consumer agent pattern: [docs/observability-consumers.md](./observability-consumers.md)
- Acid-test SQL suite: [docs/observability-acid-tests.sql](./observability-acid-tests.sql)
- Flip-default PR template: [docs/templates/observability-v0-flip.md](./templates/observability-v0-flip.md)
- Source registry: `src/lib/events/registry.ts`
- Source schemas: `src/lib/events/schemas/*.ts`

---

## Change log

| Date | Change |
|---|---|
| 2026-04-20 | v0 contract published (Group 8) |
