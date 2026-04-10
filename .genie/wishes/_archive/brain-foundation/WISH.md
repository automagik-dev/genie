# Wish: brain-foundation — Core Tables, Init, BM25 Search, Obsidian Vault

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `brain-foundation` |
| **Date** | 2026-03-27 |
| **Parent** | [brain-obsidian](../brain-obsidian/WISH.md) (master spec) |
| **Repo** | repos/genie-brain/ |
| **depends-on** | none (ships first) |
| **blocks** | brain-embeddings, brain-intelligence, brain-observability, brain-identity-impl, brain-init-skill |

## Summary

The minimum viable brain. Core Postgres tables, `genie brain init` (basic scaffold), `genie brain update` (text files only), `genie brain search` (BM25 keyword), `genie brain get`, `genie brain health` (lint only), `genie brain status`. Files on disk in Obsidian format. No embeddings, no rlmx, no multimodal — just a working, searchable, lintable brain that opens in Obsidian.

**After this ships:** you can `genie brain init`, write markdown files, `genie brain update`, `genie brain search "query"`, and open it in Obsidian with graph view.

## Scope

### IN
- Migration `001-brain-foundation.sql`: brains, brain_attachments, brain_mounts, brain_collections, brain_documents (core columns only), brain_chunks (no embedding yet), brain_contexts
- `src/term-commands/brain.ts` — command skeleton (all 8 core subcommands, identity stubs)
- `src/lib/brain/types.ts` — BrainConfig, BrainFile, BrainType, Modality
- `src/lib/brain/schema.ts` — Zod frontmatter schemas
- `src/lib/brain/db.ts` — Postgres queries (upsert, search, basic CRUD)
- `src/lib/brain/docid.ts` — 6-char content hash
- `src/lib/brain/chunking.ts` — absorbed from qmd (heading-aware, 900 tokens)
- `src/lib/brain/init.ts` — basic scaffold (.obsidian/, folders, _Templates/, _index.md)
- `src/lib/brain/update.ts` — filesystem → Postgres sync (text .md files only, hash-based skip)
- `src/lib/brain/search.ts` — BM25 via tsvector (keyword search only, no vector)
- `src/lib/brain/health.ts` — lint only (frontmatter validation, missing fields, --fix for dates/tags)
- `src/lib/brain/status.ts` — list brains, file counts, basic stats
- `src/lib/brain/mounts.ts` — mount/unmount, _mounts/ symlinks for Obsidian
- `.obsidian/` config scaffold (app.json, graph.json, daily-notes.json, templates.json)
- _Templates/ (entity.md, intel.md, playbook.md, daily.md, domain.md, moc.md)
- Tests for all modules

### OUT
- Embeddings / vector search (brain-embeddings)
- Multimodal (images, video, audio, PDF) (brain-embeddings)
- rlmx / analyze (brain-intelligence)
- Wikilink generation / semantic links (brain-intelligence)
- Decisions, symbols, refs (brain-intelligence)
- Traces, strategy config (brain-observability)
- Full identity (create/archive/attach/detach) (brain-identity-impl)
- /brain-init skill (brain-init-skill)
- Version chains, forgetting, static/dynamic (brain-intelligence)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Core columns only on brain_documents | id, collection_id, path, title, docid, content_hash, modality, mime_type, content, frontmatter JSONB, fts tsvector, created_at, updated_at. Other columns added by later sub-wishes via ALTER TABLE. |
| BM25 search only | tsvector is free, instant, no embeddings needed. Good enough for MVP. Vector search added by brain-embeddings. |
| Basic init (no context detection) | Just scaffold folders + .obsidian/. Intelligent detection added by brain-init-skill. |
| Lint-only health | Frontmatter validation + missing fields + --fix. Orphans, conflicts, MOCs, composable score added later. |
| Mount support from day 1 | _mounts/ symlinks for Obsidian compatibility. Multi-source brains work immediately. |

## Success Criteria

- [ ] Migration 001 creates 7 core tables in pgserve
- [ ] `genie brain init --name test --path /tmp/test` creates scaffold with .obsidian/, folders, _Templates/
- [ ] `genie brain update` syncs .md files to Postgres (hash-based skip on unchanged)
- [ ] `genie brain search "query"` returns BM25 ranked results from tsvector
- [ ] `genie brain get <path>` retrieves by path, `genie brain get "#docid"` by docid
- [ ] `genie brain health` reports frontmatter lint (PASS/WARN/FAIL per file)
- [ ] `genie brain health --fix` auto-adds missing dates, converts string tags to arrays
- [ ] `genie brain status` shows brain name, file count, health score
- [ ] `genie brain mount <path> --as <alias>` works, creates _mounts/ symlink
- [ ] Opening brain in Obsidian shows valid vault with graph view, daily notes, templates
- [ ] `genie db query "SELECT * FROM brain_documents WHERE frontmatter->>'type' = 'intel'"` works
- [ ] `bun run check` passes
- [ ] `bun test src/lib/brain/` passes

## Execution Strategy

### Wave 1 (parallel — infrastructure)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Migration 001: 7 core tables + indexes |
| 2 | engineer | types.ts + schema.ts + db.ts + docid.ts |
| 3 | engineer | brain.ts command skeleton (8 core stubs) |

### Wave 2 (parallel — commands)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | init.ts (scaffold + .obsidian/) + mounts.ts (_mounts/ symlinks) |
| 5 | engineer | update.ts (text-only sync, hash-based skip) + chunking.ts |
| 6 | engineer | search.ts (BM25 only) + get (path + docid) |
| 7 | engineer | health.ts (lint only + --fix) + status.ts |

### Wave 3 (sequential — tests + apply)
| Group | Agent | Description |
|-------|-------|-------------|
| 8 | engineer | Tests: schema, update, search, health, init (5 test files) |
| 9 | engineer | Apply to existing Genie brain — verify it works |
| review | reviewer | Review against criteria |

## Postgres Schema (foundation only)

```sql
-- 001-brain-foundation.sql

CREATE TABLE brains (
  id TEXT PRIMARY KEY,
  short_name TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lifecycle TEXT DEFAULT 'permanent',
  home_path TEXT,
  file_count INT DEFAULT 0,
  mount_count INT DEFAULT 0,
  health_score INT,
  health_checked_at TIMESTAMPTZ,
  last_query_at TIMESTAMPTZ,
  last_update_at TIMESTAMPTZ,
  total_queries INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_brains_owner ON brains(owner_type, owner_id);
CREATE UNIQUE INDEX idx_brains_owner_short ON brains(owner_type, owner_id, short_name);

CREATE TABLE brain_attachments (
  id SERIAL PRIMARY KEY,
  brain_id TEXT REFERENCES brains(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT DEFAULT 'reader',
  attached_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(brain_id, entity_type, entity_id)
);

CREATE TABLE brain_mounts (
  id SERIAL PRIMARY KEY,
  brain_id TEXT REFERENCES brains(id) ON DELETE CASCADE,
  mount_path TEXT NOT NULL,
  mount_type TEXT NOT NULL,
  alias TEXT,
  pattern TEXT DEFAULT '**/*.md',
  is_home BOOLEAN DEFAULT false,
  read_only BOOLEAN DEFAULT false,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE brain_collections (
  id SERIAL PRIMARY KEY,
  brain_id TEXT REFERENCES brains(id) ON DELETE CASCADE,
  mount_id INT REFERENCES brain_mounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  pattern TEXT DEFAULT '**/*.md',
  context TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE brain_documents (
  id SERIAL PRIMARY KEY,
  collection_id INT REFERENCES brain_collections(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT,
  docid CHAR(6) NOT NULL,
  content_hash TEXT NOT NULL,
  modality TEXT NOT NULL DEFAULT 'text',
  mime_type TEXT,
  content TEXT,
  frontmatter JSONB,
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
  ) STORED,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(collection_id, path)
);

CREATE INDEX idx_brain_docs_fts ON brain_documents USING GIN(fts);
CREATE INDEX idx_brain_docs_docid ON brain_documents(docid);
CREATE INDEX idx_brain_docs_frontmatter ON brain_documents USING GIN(frontmatter);

CREATE TABLE brain_chunks (
  id SERIAL PRIMARY KEY,
  document_id INT REFERENCES brain_documents(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  pos INT DEFAULT 0,
  content TEXT NOT NULL,
  UNIQUE(document_id, seq)
);

CREATE TABLE brain_contexts (
  id SERIAL PRIMARY KEY,
  collection_id INT REFERENCES brain_collections(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  context TEXT NOT NULL,
  UNIQUE(collection_id, path)
);
```

## Files to Create/Modify

```
MODIFY  repos/genie-brain/package.json                         (no new deps for foundation)
CREATE  repos/genie-brain/src/db/migrations/001-brain-foundation.sql

CREATE  repos/genie-brain/src/term-commands/brain.ts
CREATE  repos/genie-brain/src/lib/brain/types.ts
CREATE  repos/genie-brain/src/lib/brain/schema.ts
CREATE  repos/genie-brain/src/lib/brain/db.ts
CREATE  repos/genie-brain/src/lib/brain/docid.ts
CREATE  repos/genie-brain/src/lib/brain/chunking.ts
CREATE  repos/genie-brain/src/lib/brain/init.ts
CREATE  repos/genie-brain/src/lib/brain/update.ts
CREATE  repos/genie-brain/src/lib/brain/search.ts
CREATE  repos/genie-brain/src/lib/brain/health.ts
CREATE  repos/genie-brain/src/lib/brain/status.ts
CREATE  repos/genie-brain/src/lib/brain/mounts.ts

CREATE  repos/genie-brain/src/lib/brain/schema.test.ts
CREATE  repos/genie-brain/src/lib/brain/update.test.ts
CREATE  repos/genie-brain/src/lib/brain/search.test.ts
CREATE  repos/genie-brain/src/lib/brain/health.test.ts
CREATE  repos/genie-brain/src/lib/brain/init.test.ts
```
