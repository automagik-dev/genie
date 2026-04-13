# Wish: brain-identity-impl — Full Lifecycle, Auto-Brain, Admin, Cross-Entity Links

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `brain-identity-impl` |
| **Date** | 2026-03-27 |
| **Parent** | [brain-obsidian](../brain-obsidian/WISH.md) |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |
| **depends-on** | `brain-foundation` |

## Summary

Full brain identity: scoped IDs, lifecycle (permanent/ephemeral/archived), TTL auto-purge, create/archive/delete, attach/detach with roles (owner/writer/reader, any combination), auto-brain on spawn/task/work, admin mode (GENIE_ADMIN_KEY), cross-entity links (brain docs ↔ wishes/tasks/PRs), live vs snapshot mounts. The brain becomes a first-class Genie entity like agents, tasks, and teams.

**After this ships:** agents auto-discover brains on spawn. Tasks get ephemeral brains that archive on completion. Any entity can attach to any brain with any role. The knowledge graph crosses entity boundaries.

## Scope

### IN
- Migration `005-brain-identity.sql`: brain_entity_links. ALTER TABLE brains: add lifecycle, archive_ttl, archived_at, embed_model, embed_dims, default_strategy. ALTER TABLE brain_mounts: add sync_mode (live/snapshot), allowed_agents.
- `src/lib/brain/identity.ts` — brain CRUD: create (--owner, --lifecycle, --ttl), archive, delete, scoped ID generation (scope:owner:name), short alias resolution
- `src/lib/brain/attachments.ts` — attach (--entity, --role), detach, list (--entity, --brain, --lifecycle), role upgrade/downgrade. Any combination valid.
- `src/lib/brain/auto-brain.ts` — auto-discover on spawn (brain/ → register, shared → attach reader), auto-create on task (ephemeral), auto-create on /work (wish + group brains)
- `src/lib/brain/entity-links.ts` — cross-entity links: brain docs ↔ wishes/tasks/PRs/sessions. link_reason: informed by, produced for, referenced in, decided during
- `genie brain create`, `genie brain archive`, `genie brain delete` commands
- `genie brain attach`, `genie brain detach` commands
- `genie brain list` command (--entity, --brain, --lifecycle, --archived, --admin filters)
- Admin mode: `--admin` gated by `GENIE_ADMIN_KEY` env var (search all, list all)
- Ephemeral auto-archive: when owner entity completes (task done, wish shipped, team disbanded)
- TTL purge: cron/heartbeat check, `brain.expiring` event before purge
- Live vs snapshot sync_mode on brain_mounts
- Extend `status.ts` — full identity display, attachment listing, mount details
- Extend `search.ts` — respect attachment roles (can't search unattached brain without --admin)

### OUT
- Authentication system (ID-level only, no auth)

## Success Criteria

- [ ] `genie brain create --name "Research" --owner task:42 --lifecycle ephemeral --ttl 90d` works
- [ ] `genie brain archive <brain-id>` changes lifecycle → archived (read-only, searchable)
- [ ] `genie brain attach <brain> --entity agent:vegapunk --role writer` works
- [ ] `genie brain detach <brain> --entity task:42` works
- [ ] `genie brain list` shows MY attached brains with roles
- [ ] `genie brain list --entity task:42` shows brains for task 42
- [ ] `genie brain list --brain shared` shows all attachments
- [ ] Short alias: `--brain gtm` resolves to `agent:genie:gtm`
- [ ] `--admin` with GENIE_ADMIN_KEY searches/lists ALL brains. Without key → error.
- [ ] `genie spawn engineer` auto-discovers brain/, auto-attaches shared
- [ ] Task completion → ephemeral brain auto-archives
- [ ] TTL-expired archives purged with `brain.expiring` event
- [ ] `genie brain mount --sync live` reads current filesystem at search time
- [ ] `genie brain mount --sync snapshot` uses Postgres index (default)
- [ ] Cross-entity: brain doc linked to wish via brain_entity_links
- [ ] `bun run check` passes

## Files to Create/Modify

```
CREATE  repos/genie-brain/src/db/migrations/005-brain-identity.sql
CREATE  repos/genie-brain/src/lib/brain/identity.ts
CREATE  repos/genie-brain/src/lib/brain/attachments.ts
CREATE  repos/genie-brain/src/lib/brain/auto-brain.ts
CREATE  repos/genie-brain/src/lib/brain/entity-links.ts
MODIFY  repos/genie-brain/src/lib/brain/mounts.ts          (sync_mode, allowed_agents)
MODIFY  repos/genie-brain/src/lib/brain/status.ts          (identity display, attachments)
MODIFY  repos/genie-brain/src/lib/brain/search.ts          (attachment role check, --admin)

CREATE  repos/genie-brain/src/lib/brain/identity.test.ts
CREATE  repos/genie-brain/src/lib/brain/attachments.test.ts
```
