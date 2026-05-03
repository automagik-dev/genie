# genie host-migrations

`genie migrate` applies versioned host-state migrations that fix drift
between current code expectations and persisted host state (pm2 env
blocks, embedded pgserve fantasmas, config drifts). Same pattern as DB
migrations (drizzle, alembic) but for HOST state.

## Lifecycle

```
bun add -g @automagik/genie
  └─ postinstall hook → genie migrate --quiet
                          └─ for each step:
                              ├─ check(ctx)    — needs apply?
                              ├─ apply(ctx)    — make it so
                              ├─ validate(ctx) — confirm it stuck
                              └─ record APPLIED in ~/.genie/migrations.json
```

## Subcommands

| Command | Behavior |
|---------|----------|
| `genie migrate` | Apply all pending in alphabetical order |
| `genie migrate --dry-run` | List pending without executing |
| `genie migrate --quiet` | Suppress per-step OK lines (used by postinstall) |
| `genie migrate --status` | Show applied / pending / failed table |

## Tracking store

`~/.genie/migrations.json` — atomic-write JSON. Override path via `GENIE_MIGRATIONS_STORE`.

## Writing a new migration

1. Pick the next 3-digit ID — alphabetical = apply order
2. Create file `src/migrations/steps/<NNN>-<kebab-case-name>.ts`
3. Export the contract:

```typescript
import type { MigrationContext } from '../discover.js';
export const id = 'NNN-kebab-case-name';
export const description = 'One-line operator-facing description';
export async function check(ctx: MigrationContext): Promise<boolean> { /* return true if needs apply */ }
export async function apply(ctx: MigrationContext): Promise<void> { /* write side */ }
export async function validate(ctx: MigrationContext): Promise<void> { /* throw on fail */ }
```

## Idempotency requirement

Every migration MUST be idempotent at the apply level. Prefer "set X to Y" over "increment X by 1". Re-runs after partial failure must never corrupt state.

## Failure semantics

- A migration that throws is recorded as `FAILED` with error message
- Subsequent `genie migrate` runs RETRY the failed migration
- `genie migrate --status` surfaces FAILED rows
- Postinstall hook soft-fails (warn + exit 0) — `bun install` never breaks

## Override / escape hatch

| Env var | Effect |
|---------|--------|
| `GENIE_SKIP_MIGRATIONS=1` | Postinstall exits 0 without invoking migrate |
| `GENIE_MIGRATIONS_STORE` | Override `~/.genie/migrations.json` path |
| `GENIE_KEEP_LEGACY_PG=1` | Migration 002 will not stop the legacy embedded |

## See also

- Wish: `.genie/wishes/genie-host-migrations/WISH.md`
- Sibling: `pgserve/autopg-upgrade-command` (same self-heal pattern, pgserve subsystem)
- Drizzle DB migrations (separate concern): `src/db/migrations/`
