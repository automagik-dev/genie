# Data Retention Policies

Genie applies automatic retention cleanup to unbounded tables. Cleanup runs once per process on first database connection (via `getConnection()` in `src/lib/db.ts`) and was initially seeded by migration `019_retention.sql`.

## Retention Periods

| Table | Retention | Rationale |
|-------|-----------|-----------|
| `genie_runtime_events` | 14 days | High-volume append-only event stream; older events rarely queried |
| `heartbeats` | 7 days | Periodic health pings; only recent state is relevant |
| `machine_snapshots` | 30 days | System metrics snapshots; month of history sufficient for trends |
| `audit_events` (otel_* only) | 30 days | OpenTelemetry-prefixed audit entries; non-otel events are retained indefinitely |

## Automatic Cleanup

Retention runs automatically on every `getConnection()` call (once per process lifetime). The cleanup is:

- **Non-fatal** -- failures are logged to stderr but never block startup
- **Idempotent** -- safe to run multiple times concurrently
- **Once-per-process** -- a flag prevents repeated execution within the same process

## Manual Pruning

For on-demand cleanup beyond automatic retention:

```bash
# Preview what would be deleted (no changes made)
genie db prune-events --older-than 7d --dry-run

# Delete events older than 7 days
genie db prune-events --older-than 7d

# Delete events older than 30 days (default: 14d)
genie db prune-events --older-than 30d
```

Supported duration formats: `7d`, `24h`, `30m`, `60s` (and variants like `7days`, `24hr`, `30min`).

## Schema Reference

The `genie_runtime_events` table is defined in `src/db/migrations/010_runtime_events.sql`:

- Primary key: `id BIGINT GENERATED ALWAYS AS IDENTITY`
- Partitioned by: `created_at TIMESTAMPTZ` (indexed)
- Indexes: `repo_path`, `agent`, `team`, `subject`, `kind` (all compound with `id`)

## Adding New Retention Policies

1. Add the `DELETE` statement to `runRetention()` in `src/lib/db.ts`
2. Document the policy in this file
3. Optionally add a one-time migration to clean existing data (see `019_retention.sql`)
