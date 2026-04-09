# Wish: Genie Item Registry — Unified Install from Git

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `genie-item-registry` |
| **Date** | 2026-03-25 |
| **Design** | [DESIGN.md](../../brainstorms/genie-item-registry/DESIGN.md) |
| **Phase** | Phase 2 — Decentralized git-install. Depends on `genie-export-import` (Phase 1). |
| **Repo** | **genie CLI** (`/home/genie/agents/namastexlabs/genie/repos/genie/`) |
| **Commands** | `src/term-commands/install.ts`, `src/term-commands/uninstall.ts`, `src/term-commands/publish.ts`, `src/term-commands/update.ts` |
| **Council** | Reviewed — 5 MODIFY, 1 REJECT. All addressed. |

## Summary

Add `genie install <git-url>`, `genie uninstall`, `genie update`, `genie publish`, and the `genie.yaml` manifest format. Unify three disconnected systems (agent directory, Claude plugins, KhalOS app store) into one git-backed install path with DB as source of truth. Migrate `genie dir` from JSON file to DB-backed. Support 8 item types including DB-native boards and workflows.

## Scope

### IN
- `genie.yaml` manifest format (8 types: `agent | skill | app | board | workflow | stack | template | hook`)
- `genie install <git-url>[@version]` — clone, validate, register in DB
- `genie uninstall <name>` — deregister + cleanup
- `genie update <name>` — pull latest, re-validate, update DB
- `genie publish` — set approval status in DB (requires pushed git tag)
- `genie dir` becomes DB-backed (JSON is auto-generated cache)
- Manifest fallback detection (AGENTS.md → agent, manifest.ts → app, skill.md → skill)
- DB-native item install (boards → task_types, workflows → schedules)
- Stack transactional install (all or none)
- All operations logged to `audit_events`

### OUT
- Central registry, cross-company sharing, sandboxing, GUI wizard, auto-update

## Success Criteria
- [ ] `genie.yaml` format validated by install
- [ ] `genie install github.com/user/repo` clones, validates, registers in DB
- [ ] `genie install repo@v1.2.0` installs specific version
- [ ] `genie uninstall <name>` removes clone + DB entry + regenerates cache
- [ ] `genie update <name>` pulls latest, re-validates, updates DB
- [ ] `genie publish` requires pushed git tag, sets approval status
- [ ] `genie dir ls` queries DB
- [ ] `genie dir add` writes to DB + regenerates cache
- [ ] Agent items spawnable after install
- [ ] Board install creates `task_types` entry with stages JSONB
- [ ] Workflow install creates `schedules` entry with cron + run_spec
- [ ] Stack install is transactional (all or none)
- [ ] Fallback detection works (items without genie.yaml)
- [ ] All operations logged to `audit_events`
- [ ] Migration: existing `agent-directory.json` imported to DB on first run

## Execution Strategy

### Wave 1 (framework + manifest)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | `genie.yaml` parser + validator + manifest types |
| 2 | engineer | `genie dir` migration: JSON → DB-backed with cache regeneration |

### Wave 2 (core commands — parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `genie install` — clone, detect manifest, validate, register in DB, type-specific registration |
| 4 | engineer | `genie uninstall` + `genie update` — deregister, cleanup, pull, re-validate |

### Wave 3 (advanced features)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | DB-native items: board → task_types, workflow → schedules. Stack transactional install. |
| 6 | engineer | `genie publish` + fallback detection + agent-directory.json migration |

### Wave 4
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: genie.yaml Parser + Validator

**Goal:** Define the manifest format, TypeScript types, parser, and validator.

**Deliverables:**

1. **`src/lib/manifest.ts`** — types and parser:
   ```typescript
   type ItemType = 'agent' | 'skill' | 'app' | 'board' | 'workflow' | 'stack' | 'template' | 'hook';
   interface GenieManifest {
     name: string; version: string; type: ItemType;
     description?: string;
     author?: { name: string; url?: string };
     agent?: { model: string; promptMode: string; roles: string[]; entrypoint: string };
     skill?: { triggers: string[]; entrypoint: string };
     app?: { runtime: string; natsPrefix?: string; icon?: string; entrypoint: string };
     board?: { stages: StageConfig[] };
     workflow?: { cron: string; timezone?: string; command: string; run_spec: Record<string, unknown> };
     stack?: { items: StackItem[] };
     dependencies?: string[];
     tags?: string[]; category?: string; license?: string;
   }
   function parseManifest(yamlContent: string): GenieManifest;
   function validateManifest(manifest: GenieManifest, itemDir: string): ValidationResult;
   ```

2. **Validation rules:**
   - Required: `name`, `type`, `version`
   - Type-specific section must match `type` field
   - Entrypoint files must exist on disk
   - Board stages: `gate` must be `human | agent | human+agent`
   - Workflow: valid cron expression
   - Stack items: each must have `type` + (`source` or `inline: true`)

3. **Fallback detection** — `detectManifest(dir: string)`:
   - Check `genie.yaml` → parse
   - Check `AGENTS.md` → extract YAML frontmatter → infer agent manifest
   - Check `manifest.ts` → infer app manifest
   - Check `skill.md` → infer skill manifest
   - None → return error

**Acceptance Criteria:**
- [ ] `parseManifest()` parses all 8 item types
- [ ] `validateManifest()` rejects missing entrypoints, invalid gates, bad cron
- [ ] `detectManifest()` falls back through AGENTS.md → manifest.ts → skill.md
- [ ] TypeScript types exported for use by install/publish commands

**depends-on:** none

---

### Group 2: genie dir Migration (JSON → DB)

**Goal:** Migrate `genie dir` from JSON file to DB-backed, keeping JSON as cache.

**Deliverables:**

1. **Update `src/term-commands/dir.ts`:**
   - `genie dir add` → INSERT into `app_store` with `itemType: 'agent'`
   - `genie dir ls` → query `app_store WHERE itemType IN ('agent')`, fallback to JSON cache
   - `genie dir rm` → DELETE from `app_store` + remove cache entry
   - `genie dir edit` → UPDATE `app_store` entry

2. **Cache regeneration** — `regenerateAgentCache()`:
   - Query all agents from `app_store`
   - Write `~/.genie/agent-directory.json` in existing format
   - Called after every mutation (add/rm/install/uninstall)

3. **Migration on first run** — `migrateAgentDirectory()`:
   - Read `~/.genie/agent-directory.json`
   - For each entry: INSERT into `app_store` if not exists
   - Rename original to `agent-directory.json.bak`
   - Run once, idempotent

**Acceptance Criteria:**
- [ ] `genie dir add` writes to DB
- [ ] `genie dir ls` reads from DB
- [ ] `genie dir rm` deletes from DB
- [ ] JSON cache regenerated after every mutation
- [ ] Existing directory entries migrated to DB on first run
- [ ] `genie spawn` still works (reads from cache for speed)

**Validation:**
```bash
genie dir ls && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 3: genie install

**Goal:** `genie install <git-url>[@version]` — the core install command.

**Deliverables:**

1. **`src/term-commands/install.ts`:**
   - Parse git URL and optional `@version` tag
   - Clone to `~/.genie/items/<name>/` (shallow: `--depth 1`)
   - Detect and parse manifest (genie.yaml or fallback)
   - Validate manifest
   - Check for name conflicts (reject if slug exists, `--force` to override)
   - INSERT into `app_store` with all metadata from manifest
   - Type-specific registration:
     - `agent` → regenerate agent directory cache
     - `skill` → copy/symlink to discoverable location
     - `app` → INSERT into `installed_apps`
     - `board` → INSERT into `task_types` (Group 5)
     - `workflow` → INSERT into `schedules` (Group 5)
     - `stack` → recursive transactional install (Group 5)
   - Log to `audit_events`
   - Print success message with type + version + source

2. **Flags:**
   - `--force` — override existing item
   - `--full` — full clone (not shallow)

**Acceptance Criteria:**
- [ ] `genie install github.com/user/repo` clones and registers
- [ ] `genie install repo@v1.2.0` installs specific version
- [ ] Clone failure cleans up partial directory
- [ ] Name conflict rejected without `--force`
- [ ] Manifest validated before registration
- [ ] Agent items registered in DB + cache regenerated
- [ ] All installs logged to `audit_events`

**depends-on:** Group 1 (manifest parser), Group 2 (agent cache)

---

### Group 4: genie uninstall + update

**Goal:** Clean removal and version updates.

**Deliverables:**

1. **`src/term-commands/uninstall.ts`:**
   - Read manifest from `~/.genie/items/<name>/genie.yaml` to detect type
   - Type-specific deregistration:
     - `agent` → remove from `app_store`, regenerate cache
     - `board` → DELETE from `task_types`
     - `workflow` → DELETE from `schedules`
     - `app` → DELETE from `installed_apps`
   - DELETE from `app_store`
   - Remove `~/.genie/items/<name>/` directory
   - Log to `audit_events`

2. **`src/term-commands/update.ts`:**
   - `genie update <name>` → cd to `~/.genie/items/<name>/`, git pull (or checkout tag)
   - Re-parse and re-validate manifest
   - UPDATE `app_store` entry with new version/metadata
   - Type-specific re-registration
   - `genie update --all` → iterate all installed items
   - Log to `audit_events`

**Acceptance Criteria:**
- [ ] `genie uninstall <name>` removes clone + all DB entries
- [ ] Board/workflow uninstall removes from `task_types`/`schedules`
- [ ] `genie update <name>` pulls latest and updates DB
- [ ] `genie update <name>@v2.0` checks out specific tag
- [ ] `genie update --all` updates all items
- [ ] Both operations logged to `audit_events`

**depends-on:** Group 3 (install establishes patterns)

---

### Group 5: DB-Native Items + Stacks

**Goal:** Board → task_types, workflow → schedules, transactional stack install.

**Deliverables:**

1. **Board install handler:**
   - Read `board.stages` from manifest
   - INSERT INTO `task_types` (id, name, description, stages JSONB, is_builtin: false)
   - Validate: gate values, stage names, action references

2. **Workflow install handler:**
   - Read `workflow.cron`, `workflow.timezone`, `workflow.command`, `workflow.run_spec`
   - Validate cron expression
   - INSERT INTO `schedules` (id, name, cron_expression, timezone, command, run_spec, status: 'active')

3. **Stack transactional install:**
   - Read `stack.items` or `contents` from manifest
   - BEGIN transaction
   - For each item: if `source` → recursive `genie install`; if `inline: true` → handle inline board/workflow
   - If ANY item fails → ROLLBACK (delete all cloned dirs + DB entries)
   - COMMIT on success

4. **Inline DB items in stacks:**
   - Stack contents with `inline: true` + board/workflow config
   - No separate git clone — insert directly from manifest YAML

**Acceptance Criteria:**
- [ ] Board install creates `task_types` entry with correct stages JSONB
- [ ] Workflow install creates `schedules` entry with correct cron + run_spec
- [ ] Stack installs all items transactionally
- [ ] Stack rollback removes all items on failure
- [ ] Inline board/workflow in stacks work without separate clone

**depends-on:** Group 3 (install command structure)

---

### Group 6: Publish + Fallback + Migration

**Goal:** `genie publish`, fallback manifest detection, agent-directory.json migration.

**Deliverables:**

1. **`src/term-commands/publish.ts`:**
   - Must be run from a directory with `genie.yaml`
   - Verify: git tag matching manifest `version` exists AND is pushed
   - Validate manifest
   - UPSERT `app_store` entry: if exists → update `approvalStatus` + version; if new → insert with `approvalStatus: 'pending'` (or 'approved' if admin)
   - Log to `audit_events`

2. **Fallback detection integration** — wire `detectManifest()` into install flow so items without `genie.yaml` still install correctly.

3. **Agent directory migration** — wire `migrateAgentDirectory()` into genie startup (or first `genie dir`/`genie install` call). One-time, idempotent.

**Acceptance Criteria:**
- [ ] `genie publish` requires pushed git tag
- [ ] Publish sets `approvalStatus` correctly
- [ ] Items without `genie.yaml` install via fallback detection
- [ ] Existing `agent-directory.json` migrated to DB on first run
- [ ] Migration is idempotent (running twice is safe)

**depends-on:** Groups 1, 2, 3

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| genie.yaml adoption | Medium | Fallback detection. Auto-generate on install. |
| Git clone failures | Medium | SSH + HTTPS auth. Timeout + cleanup. |
| Agent dir migration | Medium | One-time, idempotent. `.bak` file preserved. |
| Stack install with 10+ items | Low | Progress output. Parallel clone for independent items. |
| Name conflicts | Medium | Reject by default, `--force` to override. |

## Files to Create/Modify

```
REPO: /home/genie/agents/namastexlabs/genie/repos/genie/

CREATE:
  src/lib/manifest.ts               — genie.yaml parser, validator, types
  src/term-commands/install.ts       — genie install command
  src/term-commands/uninstall.ts     — genie uninstall command
  src/term-commands/update.ts        — genie update command
  src/term-commands/publish.ts       — genie publish command
  src/lib/agent-cache.ts             — agent directory cache regeneration
  src/lib/item-handlers/             — type-specific install/uninstall handlers
    agent.ts, skill.ts, app.ts, board.ts, workflow.ts, stack.ts

MODIFY:
  src/term-commands/dir.ts           — migrate from JSON to DB-backed
  src/genie.ts (or command registry) — register new commands
```
