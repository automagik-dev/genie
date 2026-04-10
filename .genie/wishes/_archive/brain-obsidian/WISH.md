# Wish: `genie brain` — Native Knowledge Graph Engine

| Field | Value |
|-------|-------|
| **Status** | PARENT SPEC (broken into 6 sub-wishes — execute those, not this) |
| **Slug** | `brain-obsidian` |
| **Date** | 2026-03-27 |
| **Design** | 5 /review rounds + /council + Vegapunk research (RepoMind + Supermemory) |
| **Repo** | repos/genie-brain/ (private) + repos/genie/skills/ (brain-init skill) |

## Sub-Wishes (execute these)

| # | Wish | depends-on | What Ships |
|---|------|------------|-----------|
| 1 | [brain-foundation](../brain-foundation/WISH.md) | none | Core tables, init, BM25 search, Obsidian vault |
| 2 | [brain-embeddings](../brain-embeddings/WISH.md) | foundation | Gemini E2, pgvector, multimodal, RRF, cross-modal |
| 3 | [brain-intelligence](../brain-intelligence/WISH.md) | embeddings + rlmx v0.2 | Decisions, symbols, links, analyze, version chains, forgetting |
| 4 | [brain-observability](../brain-observability/WISH.md) | foundation | Traces, strategy, budgets, cascade, events, heartbeat |
| 5 | [brain-identity-impl](../brain-identity-impl/WISH.md) | foundation | Lifecycle, auto-brain, attach/detach, admin, entity links |
| 6 | [brain-init-skill](../brain-init-skill/WISH.md) | foundation | Intelligent init, context detection, /brain-init skill |

```
brain-foundation ────────→ ships FIRST (blocks everything)
  ├── brain-embeddings ──→ ships after foundation
  │     └── brain-intelligence → ships after embeddings + rlmx v0.2
  ├── brain-observability → parallel with embeddings (independent)
  ├── brain-identity-impl → parallel with embeddings (independent)
  └── brain-init-skill ──→ parallel with embeddings (independent)
```

## Summary (parent spec)

Add a full `genie brain` command suite to the Genie CLI powered by Genie's existing Postgres (pgserve) — no new database dependencies. Absorb ~940 lines of search algorithms from qmd (chunking, RRF fusion, search pipeline). Use Gemini Embedding 2 for vector embeddings (cloud, free, 3072 dims, no hardware). Import `rlmx` as reasoning engine. The `genie brain init` command is intelligent — it auto-detects context, interviews the user, and refines scaffolded config files into domain-specific prompts. Brain data lives in Postgres alongside tasks, events, and wishes — queryable, joinable, first-class.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    genie brain                            │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  CLI Commands          Reasoning           Skill         │
│  (genie brain *)       (rlmx SDK)         (/brain-init) │
│       │                    │                    │        │
│       └────────────────────┼────────────────────┘        │
│                            │                             │
│  ┌─────────────────────────┼─────────────────────────┐   │
│  │            src/lib/brain/                          │   │
│  │                                                    │   │
│  │  Absorbed from qmd (~940 lines):                   │   │
│  │  - Smart chunking (heading-aware, 900 tokens)      │   │
│  │  - RRF fusion (reciprocal rank + position blend)   │   │
│  │  - Search pipeline (BM25 + vector + rerank)        │   │
│  │  - Docid system (6-char content hash)              │   │
│  │  - Collection/context management                   │   │
│  │                                                    │   │
│  │  Native to Genie:                                  │   │
│  │  - Frontmatter schema (Zod)                        │   │
│  │  - Wikilink generation (tag overlap)               │   │
│  │  - MOC generation                                  │   │
│  │  - Health scoring                                  │   │
│  │  - Intelligent init (context detection)            │   │
│  │  - Obsidian config scaffolding                     │   │
│  └────────────────────────────────────────────────────┘   │
│                            │                             │
│  ┌─────────────────────────┼─────────────────────────┐   │
│  │         Postgres (pgserve — already running)       │   │
│  │                                                    │   │
│  │  brain_collections    brain_documents (+ tsvector) │   │
│  │  brain_chunks (+ pgvector 3072d)                   │   │
│  │  brain_contexts       brain_links                  │   │
│  │                                                    │   │
│  │  JOINable with: tasks, events, audit_events,       │   │
│  │  messages, conversations, wishes                   │   │
│  └────────────────────────────────────────────────────┘   │
│                            │                             │
│  ┌─────────────────────────┼─────────────────────────┐   │
│  │    Gemini Embedding 2 Preview (cloud, free)        │   │
│  │  Multimodal: text, image, video, audio, PDF        │   │
│  │  3072d (Matryoshka: 768/1536/3072)                 │   │
│  │  8 task types: retrieval, similarity, classify,     │   │
│  │    cluster, code, Q&A, fact-verify                  │   │
│  │  Batch API: 50% cheaper for bulk operations        │   │
│  │  Aggregated embedding: text+image in one vector    │   │
│  │  100+ languages | No hardware required             │   │
│  └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

## Scope

### IN

**Brain Identity (from brain-identity DESIGN.md):**
- `brains` table: standalone entity with scoped ID (`scope:owner:name`), lifecycle (permanent/ephemeral/archived), TTL, denormalized stats
- `brain_attachments` table: any entity ↔ any brain, many-to-many, roles (owner/writer/reader), any combination valid
- `brain_mounts` table: multi-source filesystem mounts per brain, with home mount, read-only flag
- `brain_entity_links` table: brain documents ↔ wishes/tasks/PRs/sessions (cross-entity knowledge graph)
- Auto-brain: spawn discovers brain/, task create makes ephemeral, /work creates wish+group brains
- Ephemeral lifecycle: auto-archive when owner completes, TTL auto-purge (customer configurable)
- Admin mode: `--admin` + `GENIE_ADMIN_KEY` env var for server-wide search
- Brain events flow into existing events table. Brain metrics in agent heartbeat.

**Infrastructure:**
- Postgres brain tables: brains, brain_attachments, brain_mounts, brain_entity_links, brain_collections, brain_documents (tsvector FTS), brain_chunks (pgvector 3072d), brain_contexts, brain_links, brain_symbols, brain_refs, brain_decisions, brain_query_traces, brain_strategy_config
- Absorbed algorithms (~1,500 lines from qmd + grepika + Semantica): smart chunking, RRF fusion, search pipeline, docid system, symbol extraction, conflict detection, decision tracking
- `rlmx` as reasoning engine dependency
- Gemini Embedding 2 Preview: ALL 8 task types, multimodal (text/image/video/audio/PDF), Matryoshka dims, Batch API
- Media processing pipeline: ffmpeg for frame/audio extraction, format conversion to supported types

**Gemini Embedding 2 — Full Utilization (8 task types):**
- `RETRIEVAL_DOCUMENT` → `genie brain update` / `genie brain embed` (indexing files)
- `RETRIEVAL_QUERY` → `genie brain search "query"` (text search)
- `CODE_RETRIEVAL_QUERY` → `genie brain search --task code "query"` (NL→code search)
- `SEMANTIC_SIMILARITY` → `genie brain similar <docid>` (find related docs)
- `CLASSIFICATION` → `genie brain classify` (auto-tag, auto-type)
- `CLUSTERING` → `genie brain cluster` (semantic grouping)
- `QUESTION_ANSWERING` → `genie brain ask "question"` (find answers, not just docs)
- `FACT_VERIFICATION` → `genie brain verify "claim"` (evidence for/against)

**Multimodal Embedding (unified vector space):**
- Text (.md): chunk + embed text, aggregated embedding for md with inline images
- Images (.png/.jpg): embed raw image + auto-describe via Vision → embed description
- Video (.mp4/.mov, ≤120s): embed raw video (32 frames max, NO audio) + extract audio separately → embed audio + transcribe → embed transcript
- Audio (.mp3/.wav, ≤80s): embed raw audio + transcribe → embed transcript. Convert .ogg/.m4a/.flac to MP3/WAV first.
- PDF (.pdf, ≤6 pages): embed raw PDF + extract text → embed text chunks
- Interleaved: text+image combined in single Content → ONE aggregated embedding

**Batch API:** Use for bulk operations (50% cheaper than per-request)

**Commands (37 total):**
- Scaffolding: `init` (intelligent, context-detecting)
- Sync: `update` (filesystem→Postgres, hash-based skip), `embed` (vectorize changed files)
- Search: `search` (BM25/semantic/hybrid), `search --image`, `search --audio`, `search --video`, `search --task code`
- Retrieval: `get` (by path, docid, line range)
- Intelligence: `ask` (Q&A), `verify` (fact-check), `similar` (find related), `classify` (auto-tag), `cluster` (group)
- Reasoning: `analyze` (rlmx), `synthesize` (rlmx reports)
- Structure: `lint`, `link`, `alias`, `moc`, `health`, `reorg`
- Media: `describe` (Vision descriptions), `describe --redescribe`
- Ops: `register`, `status`, `queue`, `digest`
- Skill: `/brain-init` (interactive customization)

**Multimodal Limits (from docs):**
- Images: max 6 per request, PNG/JPEG only
- Audio: max 80s, MP3/WAV only (convert others via ffmpeg)
- Video: max 120s, MP4/MOV, H264/H265/AV1/VP9. Max 32 frames sampled. **Audio NOT processed in video — must extract separately**
- PDF: max 6 pages
- Overall: 8192 token input limit
- Matryoshka: 3072 (default, pre-normalized), 1536, 768 (require L2 normalization)

**Cost Optimization:**
- Batch API for bulk embedding (50% off)
- Hash-based change detection (never re-embed unchanged)
- `--estimate` flag shows cost before processing
- `--budget` flag caps spending
- Text first (cheapest) → images → PDFs → audio → video (most expensive)
- Store model version in brain_chunks — incompatible across model versions, must re-embed on upgrade

### OUT
- qmd as dependency (absorbed algorithms, Postgres replaces SQLite)
- node-llama-cpp / local GGUF models (Gemini cloud replaces)
- MCP server (CLI-first, no MCP)
- Dataview queries (Obsidian plugin, not portable)
- Graph visualization UI (desktop app scope)
- Custom graph database (Postgres is enough)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Native Postgres, not qmd SQLite | Genie already has pgserve. One DB, not two. Brain data joins with tasks/events/wishes. |
| Absorb ~940 lines from qmd | Chunking, RRF, search pipeline are algorithms, not storage. Take the logic, drop the SQLite. |
| Absorb code indexing patterns from grepika | `refs` (symbol references) and `outline` (file structure) for codebase brains. Trigram indexing for partial matches. Query intent detection (regex vs NL vs symbol). |
| Gemini Embedding 2 (cloud) | 3072 dims, batch support, free tier, no hardware. Better than local embeddinggemma-300M. |
| pgvector for vector search | Industry standard. IVFFlat + HNSW indexes. Scales to millions. |
| tsvector for full-text search | 20+ years mature. GIN indexes. Language-aware stemming. Already in Postgres. |
| pg_trgm for trigram search | Postgres built-in trigram extension. Catches partial matches BM25 misses (e.g. `handleWork` when searching `Work`). Third search backend alongside tsvector + pgvector. |
| Frontmatter as JSONB column | Query tags, type, confidence, source at DB level. `WHERE frontmatter->>'type' = 'intel'`. |
| brain_links as first-class table | Relationships are queryable data, not grep in markdown. Link types: `tag-overlap`, `semantic`, `caused`, `superseded`, `contradicts`, `supports`. |
| brain_decisions table | Decisions as first-class objects: what was decided, alternatives considered, rationale, outcome. Inspired by Semantica. Folds into `analyze --decision`. |
| brain_symbols table for codebase brains | Function/class/struct definitions, imports, usages — queryable. Inspired by grepika's `refs`. |
| Temporal validity | `valid_from`/`valid_until` on brain_documents. Facts expire. `health` flags expired knowledge. Inspired by Semantica. |
| Conflict detection | During `link` and `health`: detect contradictory claims across brain files. Warn, don't silently coexist. |
| Provenance tracking | `source_url`, `source_type` on brain_documents. WHERE knowledge came from + HOW it arrived (direct, derived, inferred). |
| `rlmx` as reasoning dep (not absorbed) | rlmx is a reasoning engine (Python REPL loop). Orthogonal to storage. Different concern. |
| Intelligent init with /brain-init skill | CLI scaffolds files, skill guides customization. CLI + skill = complete flow. |
| CLI-first, no MCP | Genie is a CLI tool. Agents call it via subprocess. No protocol servers. |
| Obsidian format for files on disk | Files are the source of truth. Postgres is the index. Both stay in sync. |
| Knowledge brains vs codebase brains | Different indexing strategies: knowledge = frontmatter + chunks + embeddings. Codebase = symbols + outlines + trigrams + embeddings. Same search interface. |

## Key Insight: Files + Postgres, Not Files OR Postgres

```
brain/                          ← SOURCE OF TRUTH (Obsidian-compatible markdown)
├── DevRel/content-backlog.md
├── Intelligence/people/sama.md
└── ...

Postgres brain_documents        ← INDEX (parsed, searchable, embeddable)
├── content, frontmatter JSONB, tsvector, docid
└── brain_chunks with pgvector embeddings

Sync: genie brain update        ← filesystem → Postgres (like git index)
```

Agents write markdown files normally. `genie brain update` syncs to Postgres. Search hits the DB. Files remain portable, git-versioned, Obsidian-compatible. Best of both worlds.

## Postgres Schema

```sql
-- ═══════════════════════════════════════════════════════════
-- BRAIN IDENTITY: Standalone entity, any Genie object can own/attach
-- ═══════════════════════════════════════════════════════════

-- The brain itself (independent entity)
CREATE TABLE brains (
  id TEXT PRIMARY KEY,                      -- "agent:genie:gtm", "task:42:context"
  short_name TEXT NOT NULL,                 -- last segment: "gtm", "context"
  name TEXT NOT NULL,                       -- human-readable: "Genie GTM Brain"
  description TEXT,

  -- Ownership (ID-level, no auth)
  owner_type TEXT NOT NULL,                 -- agent | task | wish | project | team | app | org | user
  owner_id TEXT NOT NULL,

  -- Lifecycle
  lifecycle TEXT DEFAULT 'permanent',       -- permanent | ephemeral | archived
  archive_ttl INTERVAL,                     -- null = permanent archive, '90 days' = auto-purge after archival
  archived_at TIMESTAMPTZ,                  -- when lifecycle changed to 'archived'

  -- Config
  home_path TEXT,                           -- filesystem path for home mount
  embed_model TEXT DEFAULT 'gemini-embedding-2-preview',
  embed_dims INT DEFAULT 3072,
  default_strategy TEXT DEFAULT 'auto',

  -- Denormalized stats (fast for status/list, refreshed by update/health/query)
  file_count INT DEFAULT 0,
  mount_count INT DEFAULT 0,
  health_score INT,
  health_checked_at TIMESTAMPTZ,            -- staleness indicator (warn if >24h)
  last_query_at TIMESTAMPTZ,
  last_update_at TIMESTAMPTZ,
  total_queries INT DEFAULT 0,
  total_cost_cents REAL DEFAULT 0,
  embedding_coverage REAL DEFAULT 0,        -- 0.0 to 1.0

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_brains_owner ON brains(owner_type, owner_id);
CREATE INDEX idx_brains_lifecycle ON brains(lifecycle);
CREATE UNIQUE INDEX idx_brains_owner_short ON brains(owner_type, owner_id, short_name);

-- Any entity can attach to any brain (many-to-many)
CREATE TABLE brain_attachments (
  id SERIAL PRIMARY KEY,
  brain_id TEXT REFERENCES brains(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,                -- agent | task | wish | project | team | app | org | user
  entity_id TEXT NOT NULL,
  role TEXT DEFAULT 'reader',               -- owner | writer | reader
  attached_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(brain_id, entity_type, entity_id)
);

CREATE INDEX idx_attachments_entity ON brain_attachments(entity_type, entity_id);
CREATE INDEX idx_attachments_brain ON brain_attachments(brain_id);

-- Filesystem mounts within a brain (multi-source)
CREATE TABLE brain_mounts (
  id SERIAL PRIMARY KEY,
  brain_id TEXT REFERENCES brains(id) ON DELETE CASCADE,
  mount_path TEXT NOT NULL,                 -- filesystem path
  mount_type TEXT NOT NULL,                 -- source | docs | brain | codebase | shared
  alias TEXT,                               -- short name: "src", "docs", "shared"
  pattern TEXT DEFAULT '**/*.md',           -- glob for this mount
  is_home BOOLEAN DEFAULT false,            -- where new files save (one per brain)
  read_only BOOLEAN DEFAULT false,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_mounts_brain ON brain_mounts(brain_id);

-- Cross-entity links: brain documents ↔ wishes/tasks/PRs/sessions
CREATE TABLE brain_entity_links (
  id SERIAL PRIMARY KEY,
  document_id INT REFERENCES brain_documents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,                -- wish | task | pr | event | session | agent
  entity_id TEXT NOT NULL,
  link_reason TEXT,                         -- "informed by" | "produced for" | "referenced in" | "decided during"
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_entity_links_doc ON brain_entity_links(document_id);
CREATE INDEX idx_entity_links_entity ON brain_entity_links(entity_type, entity_id);

-- ═══════════════════════════════════════════════════════════
-- BRAIN CONTENT: Documents, chunks, symbols (per-mount indexed)
-- ═══════════════════════════════════════════════════════════

-- Collections map to mounts (one collection per mount)
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
  modality TEXT NOT NULL DEFAULT 'text',    -- text | image | video | audio | pdf
  mime_type TEXT,                            -- image/jpeg, video/mp4, audio/mp3, application/pdf
  media_path TEXT,                           -- filesystem path to original media file
  content TEXT,                              -- text content (from md, OCR, transcript, extraction)
  description TEXT,                          -- auto-generated media description (Gemini Vision)
  frontmatter JSONB,                        -- only for .md files
  -- Temporal validity (Semantica pattern)
  valid_from TIMESTAMPTZ,                   -- when this knowledge becomes valid (null = always)
  valid_until TIMESTAMPTZ,                  -- when this knowledge expires (null = never)
  -- Provenance (Semantica pattern)
  source_url TEXT,                           -- where this knowledge came from
  source_type TEXT DEFAULT 'direct',         -- direct | derived | inferred | imported
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'') || ' ' || coalesce(description,''))
  ) STORED,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(collection_id, path)
);

CREATE INDEX idx_brain_docs_fts ON brain_documents USING GIN(fts);
CREATE INDEX idx_brain_docs_docid ON brain_documents(docid);
CREATE INDEX idx_brain_docs_frontmatter ON brain_documents USING GIN(frontmatter);
CREATE INDEX idx_brain_docs_tags ON brain_documents USING GIN((frontmatter->'tags'));
CREATE INDEX idx_brain_docs_modality ON brain_documents(modality);

CREATE TABLE brain_chunks (
  id SERIAL PRIMARY KEY,
  document_id INT REFERENCES brain_documents(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  pos INT DEFAULT 0,
  modality TEXT NOT NULL DEFAULT 'text',    -- text | image | audio | video | pdf | aggregated
  content TEXT,                              -- text content of chunk (null for raw media chunks)
  media_path TEXT,                           -- for media chunks: path to media file
  embedding vector(3072),                   -- Gemini Embedding 2 (same space for ALL modalities)
  embed_model TEXT DEFAULT 'gemini-embedding-2-preview',  -- track model version for re-embedding
  embed_task TEXT,                           -- which task_type was used (RETRIEVAL_DOCUMENT, etc.)
  embed_dims INT DEFAULT 3072,              -- actual dimension (Matryoshka: 768/1536/3072)
  UNIQUE(document_id, seq)
);

CREATE INDEX idx_brain_chunks_embedding ON brain_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_brain_chunks_modality ON brain_chunks(modality);

-- Codebase brain: symbol index (inspired by grepika refs/outline)
CREATE TABLE brain_symbols (
  id SERIAL PRIMARY KEY,
  document_id INT REFERENCES brain_documents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                       -- function/class/struct/variable name
  kind TEXT NOT NULL,                       -- function | class | struct | interface | method | import | export | variable
  line_start INT,
  line_end INT,
  signature TEXT,                           -- full signature line(s)
  parent_symbol_id INT REFERENCES brain_symbols(id),  -- nesting: method inside class
  UNIQUE(document_id, name, kind, line_start)
);

CREATE INDEX idx_brain_symbols_name ON brain_symbols(name);
CREATE INDEX idx_brain_symbols_kind ON brain_symbols(kind);
CREATE INDEX idx_brain_symbols_name_trgm ON brain_symbols USING gin(name gin_trgm_ops);

-- Symbol references: where each symbol is used across the codebase
CREATE TABLE brain_refs (
  id SERIAL PRIMARY KEY,
  symbol_id INT REFERENCES brain_symbols(id) ON DELETE CASCADE,
  document_id INT REFERENCES brain_documents(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL,                   -- definition | import | usage | export
  line INT NOT NULL,
  context TEXT                              -- surrounding line(s) for snippet
);

CREATE INDEX idx_brain_refs_symbol ON brain_refs(symbol_id);
CREATE INDEX idx_brain_refs_type ON brain_refs(ref_type);

-- Decisions as first-class objects (inspired by Semantica)
CREATE TABLE brain_decisions (
  id SERIAL PRIMARY KEY,
  collection_id INT REFERENCES brain_collections(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  decision TEXT NOT NULL,                   -- what was decided
  alternatives JSONB,                       -- [{option: "X", rejected_because: "Y"}, ...]
  rationale TEXT,                           -- why this choice over alternatives
  context_doc_ids INT[],                    -- brain_document IDs that informed this decision
  outcome TEXT,                             -- what happened after (filled later)
  status TEXT DEFAULT 'active',             -- active | superseded | reversed
  decided_at TIMESTAMPTZ DEFAULT now(),
  decided_by TEXT,                          -- agent name or human
  superseded_by INT REFERENCES brain_decisions(id)  -- if this decision was replaced
);

CREATE INDEX idx_brain_decisions_status ON brain_decisions(status);
CREATE INDEX idx_brain_decisions_collection ON brain_decisions(collection_id);

-- Enable trigram extension for partial/fuzzy matching
-- (catches "handleWork" when searching "Work")
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_brain_docs_content_trgm ON brain_documents USING gin(content gin_trgm_ops);

CREATE TABLE brain_contexts (
  id SERIAL PRIMARY KEY,
  collection_id INT REFERENCES brain_collections(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  context TEXT NOT NULL,
  UNIQUE(collection_id, path)
);

CREATE TABLE brain_links (
  id SERIAL PRIMARY KEY,
  from_doc_id INT REFERENCES brain_documents(id) ON DELETE CASCADE,
  to_doc_id INT REFERENCES brain_documents(id) ON DELETE CASCADE,
  link_type TEXT DEFAULT 'tag-overlap',     -- tag-overlap | semantic | wikilink | caused | superseded | contradicts | supports
  shared_tags TEXT[],
  score REAL DEFAULT 0,
  evidence TEXT,                            -- for contradicts/supports: what specifically conflicts or supports
  UNIQUE(from_doc_id, to_doc_id, link_type)
);

CREATE INDEX idx_brain_links_type ON brain_links(link_type);
```

## Gemini Embedding 2 — Full Specification

### Task Type Routing

Each brain command uses the OPTIMAL task type for its purpose:

```typescript
// src/lib/brain/embedding.ts — task type selection
const TASK_ROUTING = {
  'brain update':    'RETRIEVAL_DOCUMENT',     // Indexing brain files
  'brain embed':     'RETRIEVAL_DOCUMENT',     // Bulk embedding
  'brain search':    'RETRIEVAL_QUERY',        // Text search queries
  'brain search --task code': 'CODE_RETRIEVAL_QUERY', // NL→code search
  'brain similar':   'SEMANTIC_SIMILARITY',    // Find related docs
  'brain classify':  'CLASSIFICATION',         // Auto-tag/type files
  'brain cluster':   'CLUSTERING',             // Group documents
  'brain ask':       'QUESTION_ANSWERING',     // Find answers
  'brain verify':    'FACT_VERIFICATION',      // Evidence for/against claims
}
```

### Multimodal Processing Pipeline

```
File arrives → detect modality → process → embed → store in pgvector

TEXT (.md):
  1. Parse frontmatter (JSONB)
  2. Check for inline image references (![](path))
     - If images found: load images, create Content with [text_part, ...image_parts]
       → ONE aggregated embedding (captures text+visual context)
     - If no images: chunk text (900 tokens, heading-aware)
       → embed each chunk separately
  3. Task type: RETRIEVAL_DOCUMENT

IMAGE (.png, .jpeg — ONLY these formats):
  Max 6 per request.
  1. Embed raw image → pgvector (visual similarity search)
  2. Auto-describe via Gemini Vision → .desc.md
  3. Embed text+image interleaved: Content([description_text, image_bytes])
     → ONE richer aggregated embedding
  4. Task type: RETRIEVAL_DOCUMENT

VIDEO (.mp4, .mov — H264/H265/AV1/VP9):
  Max 120s. Max 32 frames (short ≤32s: 1fps, longer: uniform 32 samples).
  ⚠️ AUDIO TRACKS ARE NOT PROCESSED IN VIDEO EMBEDDING
  1. If ≤120s: embed raw video → pgvector (visual+motion search)
  2. Extract audio track: ffmpeg -i video.mp4 -vn -acodec pcm_s16le audio.wav
  3. Embed extracted audio separately (see AUDIO below)
  4. Transcribe audio → .transcript.md → chunk + embed transcript
  5. Extract key frames (ffmpeg) → auto-describe → .desc.md
  6. Task type: RETRIEVAL_DOCUMENT

AUDIO (.mp3, .wav — ONLY these formats):
  Max 80s. Convert .ogg/.m4a/.flac/.webm first: ffmpeg -i input -ac 1 output.mp3
  1. If ≤80s: embed raw audio → pgvector (audio content search)
  2. Transcribe → .transcript.md → chunk + embed transcript
  3. Transcription chain: Groq Whisper (<19.5MB) → Gemini (fallback)
  4. Task type: RETRIEVAL_DOCUMENT

PDF (.pdf):
  Max 6 pages.
  1. If ≤6 pages: embed raw PDF → pgvector (document visual+text search)
  2. Extract text via Gemini → .extracted.md → chunk + embed text
  3. Task type: RETRIEVAL_DOCUMENT

CODE FILES (.ts, .py, .rs, .go, .js, .java, etc. — codebase brains only):
  1. Parse with tree-sitter or regex: extract symbols (functions, classes, structs, interfaces)
  2. Store symbols in brain_symbols table with kind, line range, signature
  3. Find references across codebase: definitions, imports, usages → brain_refs table
  4. Chunk code (heading-aware: split on function/class boundaries)
  5. Embed text chunks + embed symbol signatures (CODE_RETRIEVAL_QUERY for queries)
  6. Generate outline: extractable via `genie brain search --outline <file>`

FORMAT CONVERSION (before embedding):
  .webp/.gif → .png (convert via ffmpeg/sharp)
  .ogg/.m4a/.flac/.aac → .mp3 (ffmpeg -i input -ac 1 -ar 16000 output.mp3)
  .avi/.mkv/.webm → .mp4 (ffmpeg -i input -c:v libx264 output.mp4)
```

### Matryoshka Dimensions

```bash
genie brain init --dims 768              # Smaller vectors, faster search, less storage
genie brain init --dims 1536             # Balance
genie brain init --dims 3072             # Maximum quality (default)
```

⚠️ Dimensions < 3072 require L2 normalization before storing:
```typescript
// Applied automatically by embedding.ts
if (dims < 3072) {
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0))
  vector = vector.map(v => v / norm)
}
```

### Batch API (50% cost reduction)

For `genie brain embed` bulk operations, use Gemini Batch API:
- Higher throughput
- 50% cheaper than per-request embedding
- Ideal for initial brain indexing or full re-embed
- `genie brain embed --batch` enables this mode

### Embedding Aggregation Strategy

| Content Type | Strategy | Result |
|-------------|----------|--------|
| Pure text (.md, no images) | Chunk → embed each chunk | N chunks, N embeddings |
| Text + inline images (.md with ![]()) | All parts in single Content | 1 aggregated embedding |
| Standalone image | Raw image embed + desc+image interleaved | 2 embeddings |
| Video ≤120s | Raw video + audio embed + transcript chunks | 3+ embeddings |
| Video >120s | Key frames (up to 32) + audio + transcript | Many embeddings |
| Audio ≤80s | Raw audio + transcript chunks | 2+ embeddings |
| PDF ≤6 pages | Raw PDF + text chunks | 2+ embeddings |
| PDF >6 pages | Per-page screenshots + text chunks | Many embeddings |

### Model Version Tracking

Embedding spaces are **INCOMPATIBLE across model versions.** brain_chunks stores `embed_model` to detect when re-embedding is needed:

```bash
genie brain embed --force              # Re-embed everything (model upgrade)
genie brain status                     # Shows: "12 chunks on gemini-embedding-2-preview, 0 stale"
```

### Power Queries This Enables

```sql
-- Find all intel files about agents with high confidence
SELECT path, title, frontmatter->>'confidence' as confidence
FROM brain_documents
WHERE frontmatter->>'type' = 'intel'
  AND frontmatter->'tags' ? 'agent'
  AND frontmatter->>'confidence' = 'high';

-- Find orphan documents (no incoming links)
SELECT d.path, d.title
FROM brain_documents d
LEFT JOIN brain_links l ON d.id = l.to_doc_id
WHERE l.id IS NULL AND d.frontmatter->>'type' != 'moc';

-- Cross-reference: which brain knowledge relates to active tasks?
SELECT bd.title, bd.path, t.title as task_title
FROM brain_documents bd
JOIN brain_links bl ON bd.id = bl.from_doc_id
JOIN brain_documents bd2 ON bl.to_doc_id = bd2.id
CROSS JOIN tasks t
WHERE bd.frontmatter->'tags' ?| ARRAY['orchestration', 'context']
  AND t.status = 'in_progress';

-- Find all images in the brain
SELECT path, description, modality
FROM brain_documents
WHERE modality = 'image';

-- Cross-modal: find text docs semantically similar to an image
SELECT bd.path, bd.title,
  1 - (bc.embedding <=> (SELECT embedding FROM brain_chunks WHERE document_id = 42 LIMIT 1)) as similarity
FROM brain_chunks bc
JOIN brain_documents bd ON bc.document_id = bd.id
WHERE bd.modality = 'text'
ORDER BY similarity DESC LIMIT 5;

-- Codebase brain: find all functions in the brain
SELECT s.name, s.kind, s.signature, d.path, s.line_start
FROM brain_symbols s
JOIN brain_documents d ON s.document_id = d.id
WHERE s.kind = 'function'
ORDER BY s.name;

-- Codebase brain: where is handleWorkerSpawn used?
SELECT r.ref_type, d.path, r.line, r.context
FROM brain_refs r
JOIN brain_symbols s ON r.symbol_id = s.id
JOIN brain_documents d ON r.document_id = d.id
WHERE s.name = 'handleWorkerSpawn'
ORDER BY r.ref_type;  -- definition first, then imports, then usages

-- Trigram: find partial matches (catches "handleWork" when searching "Work")
SELECT path, title, similarity(content, 'Work') as sim
FROM brain_documents
WHERE content % 'Work'
ORDER BY sim DESC LIMIT 10;

-- Stale documents (not updated in 30 days)
SELECT path, frontmatter->>'updated' as last_updated
FROM brain_documents
WHERE (frontmatter->>'updated')::date < now() - interval '30 days'
ORDER BY frontmatter->>'updated';
```

## The Intelligent Init Flow

### Phase 1: Auto-Detect Context
```bash
genie brain init
```

| What it finds | Brain type | Behavior |
|--------------|-----------|----------|
| `package.json` / `Cargo.toml` / `go.mod` | **Codebase brain** | SYSTEM.md tuned for code analysis. TOOLS.md with `find_imports()`, `trace_calls()`. Folders: Architecture/, Decisions/ |
| `SOUL.md` / `AGENTS.md` / `HEARTBEAT.md` | **Agent brain** | SYSTEM.md for agent intelligence. TOOLS.md with `search_by_tag()`. Folders: Intelligence/, Domains/ |
| `.genie/` directory | **Genie workspace** | Links brain to existing genie state |
| Empty directory | **Generic brain** | Triggers `/brain-init` skill for interview |
| `--name` + `--path` flags | **Named agent brain** | Full scaffold with agent defaults |

### Phase 2: Interview (via `/brain-init` skill)
After scaffold, agent invokes `/brain-init` which:
1. Reads scaffolded files
2. Asks domain, audience, reasoning style, custom tools
3. Auto-invokes `/refine` on SYSTEM.md + TOOLS.md
4. Generates starter entities

### Phase 3: Auto-Register
`genie brain init` auto-runs `genie brain register` + `genie brain update` + `genie brain embed` so the brain is immediately searchable.

## The Command Suite (8 commands, full power via flags)

Council reviewed: 37 flat commands → 8 smart commands. Zero features lost. Cognitive load cut 78%.

**Design principles:**
- Smart defaults — the tool infers intent, user doesn't choose task types
- Progressive disclosure — `genie brain search` just works; `--hybrid --task code` for power users
- One command per user intent, not one command per implementation detail

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. INIT — Scaffold a brain
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
genie brain init                                      # Auto-detect context + scaffold + register
genie brain init --name sofia --path ~/agents/sofia/brain
genie brain init --type codebase                      # Force brain type
genie brain init --dims 768                           # Matryoshka: smaller vectors
genie brain init --minimal                            # Skip interview
# After scaffold: "Run /brain-init to customize"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. UPDATE — Sync everything (files, media, embeddings, descriptions, links)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
genie brain update                                    # Full sync: scan → index → describe → embed → link
genie brain update --brain genie                      # Specific brain
genie brain update --estimate                         # Preview cost before processing
genie brain update --budget 0.50                      # Hard cost cap
genie brain update --force                            # Re-embed + re-describe everything (model upgrade)
genie brain update --batch                            # Batch API (50% cheaper)
# Subsumes: embed, describe, queue (all handled internally by update)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. SEARCH — Find anything (smart task type selection)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
genie brain search "context graph"                    # Auto: BM25 if no embeddings, hybrid if available
genie brain search "Does Genie support Codex?"        # Auto-detects question → QUESTION_ANSWERING
genie brain search "CrewAI has 44,500 stars"          # Auto-detects claim → FACT_VERIFICATION
genie brain search "#ca89e3"                          # Auto-detects docid → retrieves similar docs
genie brain search screenshot.png                     # Auto-detects file → cross-modal search
genie brain search voice-note.mp3                     # Audio → cross-modal
genie brain search --task code "how does dispatch work"  # Force CODE_RETRIEVAL_QUERY
genie brain search --intent "find security risks"     # Custom retrieval intent
genie brain search --refs handleWorkerSpawn            # Find all references to a symbol (codebase brains)
genie brain search --outline src/lib/brain/search.ts   # Extract file structure: functions, classes, exports
genie brain search --semantic                         # Force vector-only
genie brain search --hybrid                           # Force BM25 + vector + RRF
genie brain search --modality image                   # Filter results by modality
genie brain search --brain vegapunk --all             # Scope to brain or search all
genie brain search -n 10 --min-score 0.5 --full       # Count, threshold, full content
genie brain search --format json|md|csv               # Output format
# Subsumes: ask, verify, similar (auto-detected from query intent)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. GET — Retrieve a specific document
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
genie brain get Intelligence/people/sama              # By path (.md optional)
genie brain get "#ca89e3"                             # By docid
genie brain get "#ca89e3" --from 10 -l 30             # Line range
genie brain get "DevRel/video-draft-*.md"             # Glob pattern (multi-get)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5. ANALYZE — Reason over the brain (rlmx) or classify/cluster (Gemini)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
genie brain analyze "What gaps exist in our positioning?"       # rlmx reasoning loop
genie brain analyze "Architecture of dispatch?" --context src/  # Reason over codebase
genie brain analyze --classify new-file.md                      # Auto-suggest type + tags
genie brain analyze --classify --untagged                       # Classify all untagged files
genie brain analyze --cluster                                   # Group by semantic similarity
genie brain analyze --cluster --k 8                             # Force K clusters
genie brain analyze --synthesize "Weekly brief"                 # Synthesis report → Daily/
genie brain analyze --digest                                    # Daily brain state summary
genie brain analyze --digest --weekly                           # Weekly synthesis
genie brain analyze --decision "Use Postgres not SQLite" \
  --alternatives '["qmd SQLite","custom graph DB"]' \
  --rationale "One DB, joins with tasks"                        # Record decision (Semantica pattern)
genie brain analyze "query" --output json --verbose             # Structured output
# Subsumes: classify, cluster, synthesize, digest, decision (all flags on analyze)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 6. HEALTH — Everything about brain quality in one report
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
genie brain health                                    # Full report: lint + links + orphans + stale + MOCs + conflicts + expired + score
genie brain health --fix                              # Auto-fix: missing frontmatter, broken tags, generate MOCs
genie brain health --brain vegapunk                   # Specific brain
# Now also reports (Semantica patterns):
#   ⚠️ CONFLICT: sama.md says "4.5M followers" but ecosystem-stats.md says "4.54M"
#   📅 EXPIRED: crewai-teardown.md has valid_until 2026-04-01 — refresh needed
#   🔗 3 decisions are active, 1 superseded
# Subsumes: lint, moc, conflict detection, expiry warnings

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 7. LINK — Manage relationships (including causal/conflict types)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
genie brain link                                      # Generate [[wikilinks]] + aliases + semantic + causal links
genie brain link --dry-run                            # Preview only
genie brain link --semantic                           # Use vector similarity, not just tags
genie brain link --detect-conflicts                   # Find contradictory claims across docs
genie brain link --min-tags 1                         # Lower tag overlap threshold
# Subsumes: alias (link auto-generates aliases too)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 8. STATUS — Brain identity, attachments, mounts, network overview
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
genie brain status                                    # MY brains: files, health, coverage, cost
genie brain status --all                              # All brains on server
genie brain status --brain agent:genie:gtm            # Specific brain detail

# === BRAIN LIFECYCLE ===
genie brain create --name "Auth Research" --owner task:42 --lifecycle ephemeral --ttl 90d
genie brain create --name "GTM" --owner agent:genie   # Permanent by default
genie brain archive agent:genie:old-research          # Lifecycle → archived (read-only)
genie brain delete agent:genie:abandoned              # Permanent delete (rare)

# === ATTACHMENTS (any entity ↔ any brain, any role) ===
genie brain attach gtm --entity agent:vegapunk --role writer    # Share write access
genie brain attach shared --entity task:42 --role reader        # Task reads shared
genie brain attach gtm --entity wish:brain-obsidian --role reader
genie brain detach gtm --entity task:42

# === MOUNTS (multi-source brains) ===
genie brain mount ~/repos/genie/src --as codebase --pattern "**/*.ts"
genie brain mount ~/repos/genie/docs --as docs --pattern "**/*.mdx"
genie brain mount ~/agents/shared-brain --as shared --read-only
genie brain mount ~/agents/genie/brain --as knowledge --home     # Where new files save
genie brain unmount codebase
genie brain mounts                                              # List current mounts

# === LIST (who has what) ===
genie brain list                                      # MY attached brains + roles
genie brain list --entity task:42                     # Brains for task 42
genie brain list --brain shared                       # Who's attached to shared?
genie brain list --archived                           # Archived brains
genie brain list --lifecycle ephemeral                # All ephemeral

# === ADMIN (server-wide, gated by GENIE_ADMIN_KEY) ===
genie brain search "query" --admin                    # Search ALL brains
genie brain list --admin                              # See ALL brains + attachments
```

### What Collapsed Into What

| Old (37) | New (8 + identity) | How |
|----------|-------------------|-----|
| `init` | `init` | Same + auto-creates brain entity in Postgres |
| `update`, `embed`, `describe`, `queue` | `update` | Update does ALL sync. Queue is internal. |
| `search`, `ask`, `verify`, `similar` | `search` | Smart intent detection from query. Searches attached brains. |
| `get` | `get` | Same + glob support |
| `analyze`, `synthesize`, `classify`, `cluster`, `digest`, `decision` | `analyze` | All flags on analyze |
| `lint`, `moc`, `health` | `health` | One report. `--fix` repairs all. |
| `link`, `alias` | `link` | One pass. Wikilinks + aliases + semantic + causal. |
| `register`, `status` | `status` | Brain identity, stats, attachments, mounts. |
| — | `create`, `archive`, `delete` | Brain lifecycle management (NEW) |
| — | `attach`, `detach` | Entity ↔ brain relationship management (NEW) |
| — | `mount`, `unmount`, `mounts` | Multi-source brain mounting (NEW) |
| — | `list` | Who has what, filtered by entity/brain/lifecycle (NEW) |
| `reorg` | `analyze --cluster` | Cluster analysis includes reorg suggestions |
| `describe`, `queue` | `update` | Update handles media processing internally |

# === POSTGRES POWER ===
genie db query "SELECT * FROM brain_documents WHERE frontmatter->>'type' = 'intel'"
genie db query "SELECT * FROM brain_links WHERE shared_tags @> '{orchestration}'"
```

## Success Criteria

### Storage + Search
- [ ] Brain migration creates all 5 tables in pgserve
- [ ] `genie brain update` syncs filesystem → Postgres (new, updated, removed files detected)
- [ ] `genie brain search "query"` returns BM25 results from tsvector
- [ ] `genie brain embed` generates Gemini Embedding 2 vectors (3072 dims) stored in pgvector
- [ ] `genie brain search "query" --semantic` returns vector cosine results
- [ ] `genie brain search "query" --hybrid` combines BM25 + vector via RRF fusion
- [ ] `genie brain get "#docid"` retrieves by 6-char hash
- [ ] `genie db query "SELECT ... FROM brain_documents WHERE frontmatter->>'type' = ..."` works
- [ ] pgvector extension loaded in pgserve

### init
- [ ] Auto-detects codebase/agent/workspace/empty
- [ ] Scaffold includes .obsidian/, SYSTEM.md, TOOLS.md, CRITERIA.md, MODEL.md, folders, _index.md
- [ ] `/brain-init` skill interviews user, refines configs

### update
- [ ] Syncs filesystem → Postgres (new, updated, removed detected)
- [ ] ALL modalities: text, images (PNG/JPEG), video (MP4/MOV ≤120s), audio (MP3/WAV ≤80s), PDF (≤6 pages)
- [ ] Auto-converts unsupported formats, extracts video audio separately
- [ ] Hash-based skip, `--estimate`, `--budget`, `--force`, `--batch`

### search
- [ ] Auto-detects intent: question → Q&A, claim → fact-check, docid → similar, file → cross-modal
- [ ] `--task code` for CODE_RETRIEVAL_QUERY
- [ ] `search screenshot.png` works cross-modally
- [ ] All flags work: `--modality`, `--brain`, `--all`, `--format`, `-n`, `--min-score`, `--full`

### analyze
- [ ] Reasons via rlmx with file references
- [ ] `--classify` auto-suggests type + tags (CLASSIFICATION)
- [ ] `--cluster` groups semantically (CLUSTERING)
- [ ] `--synthesize` and `--digest` produce reports

### health
- [ ] ONE report: lint + orphans + broken links + stale + MOCs + score/100
- [ ] `--fix` auto-repairs everything fixable

### link
- [ ] Generates [[wikilinks]] + aliases in one pass
- [ ] `--semantic` uses vector similarity
- [ ] Writes to brain_links table AND files

### traces + strategy (Phase 1 self-enhancement)
- [ ] Every `search` and `analyze` call writes to brain_query_traces
- [ ] `genie brain traces` lists recent with query, strategy, latency, cost, accepted
- [ ] `genie brain traces --failed` shows implicit rejections (same topic retry <5 min)
- [ ] `genie brain traces --purge --older-than 90d` works
- [ ] `genie brain strategy` shows current config per brain
- [ ] `genie brain strategy set "pattern" rag --reason "..."` creates switching handle
- [ ] `genie brain search --strategy rag|cag|hybrid` overrides config
- [ ] `genie brain search --explain` shows strategy reasoning
- [ ] `genie brain status` includes trace stats (query count, acceptance rate, cost trend, strategy split)

### Brain Identity
- [ ] `brains` table with scoped IDs (`agent:genie:gtm`), owner, lifecycle, TTL, denormalized stats
- [ ] `brain_attachments` with owner/writer/reader roles, any combination
- [ ] `brain_mounts` for multi-source brains, home mount, read-only
- [ ] `brain_entity_links` for cross-entity references (brain docs ↔ wishes/tasks/PRs)
- [ ] `genie brain create --owner task:42 --lifecycle ephemeral --ttl 90d` works
- [ ] `genie brain attach <brain> --entity <type:id> --role <role>` works
- [ ] `genie brain list` shows MY brains. `--entity`, `--brain`, `--lifecycle` filters work.
- [ ] `genie brain mount` adds filesystem source. `--home` sets write target.
- [ ] Short alias resolution: `--brain gtm` resolves to `agent:genie:gtm`
- [ ] `--admin` gated by `GENIE_ADMIN_KEY` env var
- [ ] Auto-brain on `genie spawn` (discover brain/, attach shared)
- [ ] Ephemeral brains auto-archive when owner completes
- [ ] TTL purge with `brain.expiring` event before deletion
- [ ] Brain events in existing events table (`entity_type='brain'`)
- [ ] Brain metrics in agent heartbeat JSON
- [ ] `genie brain status` shows denormalized stats with staleness indicator
- [ ] `genie events --entity-type brain` works
- [ ] `genie events costs --entity-type brain` works
- [ ] Obsidian sees mounts via `_mounts/` symlinks in home path

### Integration
- [ ] All existing brains registered, attached, searchable
- [ ] `bun run check` passes
- [ ] `bun test src/lib/brain/` passes

## Execution Strategy

### Wave 1 (parallel — infrastructure + identity)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Postgres migration: 14 brain tables + pgvector + pg_trgm + all columns |
| 2 | engineer | Brain identity: `identity.ts` (CRUD, scoped IDs), `attachments.ts` (roles), `mounts.ts` (multi-source), `auto-brain.ts` (spawn/task auto-discovery) |
| 3 | engineer | Absorb algorithms (~1,500 lines): qmd chunking/RRF/search + grepika symbols/refs/intent + Semantica decisions/conflicts/temporal |
| 4 | engineer | Gemini Embedding 2 client: all 8 task types, multimodal, Matryoshka, Batch API, normalization |
| 5 | engineer | `src/term-commands/brain.ts` skeleton: 8 core + identity subcommands + all flags |

### Wave 2 (parallel — the 8 commands + identity + observability)
| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | `init` (context detection, scaffold, .obsidian, rlmx configs, auto-create brain entity) + `status` (identity + stats + staleness) |
| 7 | engineer | `create`/`archive`/`delete` + `attach`/`detach` + `mount`/`unmount`/`mounts` + `list` (brain identity CLI) |
| 8 | engineer | `update` (full sync: scan per mount, index, describe, convert, embed, link) + media queue |
| 9 | engineer | `search` (smart intent, 8 task types, cross-modal, --strategy, --explain, trace recording, searches attached brains) + `get` |
| 10 | engineer | `analyze` (rlmx + classify + cluster + synthesize + digest + --decision) + `entity-links.ts` |
| 11 | engineer | `health` (lint + orphans + links + stale + MOCs + conflicts + expiry + score + --fix) |
| 12 | engineer | `link` (wikilinks + aliases + semantic + causal + --detect-conflicts) |
| 13 | engineer | `traces` + `strategy` (switching handles) + implicit rejection detection |

### Wave 3 (sequential — skill + apply)
| Group | Agent | Description |
|-------|-------|-------------|
| 11 | engineer | `brain-init` skill at `skills/brain-init/SKILL.md` |
| 12 | engineer | Run full suite on Genie, Vegapunk, Shared brains. Fix issues. |
| 13 | engineer | Tests: `src/lib/brain/*.test.ts` for all modules |
| review | reviewer | Review all changes against criteria |

## Absorbed Code Map (from qmd)

| Algorithm | Source | Lines | Adaptation |
|-----------|--------|------:|------------|
| Smart chunking | qmd `store.ts:scanBreakPoints, findBestCutoff, findCodeFences` | ~120 | As-is. Heading-aware, code-fence-safe, 900 tokens. |
| RRF fusion | qmd `store.ts:reciprocalRankFusion` | ~80 | As-is. Position-aware blending (75/60/40%). Now 4 backends: tsvector + pgvector + trigram + grep. |
| Search pipeline | qmd `store.ts:search, searchLex, searchVector` | ~200 | Rewrite for Postgres (tsvector + pgvector + pg_trgm). Keep orchestration logic. |
| Query expansion | qmd `store.ts:expandQuery` | ~60 | Route to Gemini instead of local GGUF model. |
| Document indexing | qmd `store.ts:syncCollection, parseDocument` | ~200 | Rewrite for Postgres. Keep filesystem scanning, title extraction, hashing. |
| Collection management | qmd `collections.ts` | ~150 | Rewrite for Postgres. Same concepts, different storage. |
| Context management | qmd `store.ts:updateStoreContext, getStoreContexts` | ~100 | Rewrite for Postgres. brain_contexts table. |
| Docid system | qmd `store.ts:generateDocid` | ~30 | As-is. SHA256 first 6 chars. |
| Query intent detection | grepika `tools/search.rs` | ~60 | Classify: regex vs natural language vs exact symbol. Route to best backend. |
| Symbol extraction | grepika `tools/outline.rs` + `tools/refs.rs` | ~150 | Rewrite in TS with tree-sitter. Extract functions/classes/structs → brain_symbols. |
| Reference tracking | grepika `tools/refs.rs` | ~100 | Find definitions, imports, usages across codebase → brain_refs. |
| Trigram indexing | grepika `services/trigram.rs` | ~0 | Use Postgres pg_trgm extension (built-in, no code to absorb). |
| Decision tracking | Semantica `context.decision` | ~80 | Record decisions as first-class objects. Rewrite in TS with brain_decisions table. |
| Conflict detection | Semantica `context.conflict` | ~60 | Detect contradictory claims during link/health. Compare key facts across docs. |
| Temporal validity | Semantica `context.temporal` | ~30 | valid_from/valid_until on documents. Health flags expired knowledge. |
| Provenance enrichment | Semantica `kg.provenance` | ~40 | source_url, source_type tracking. Surface in health reports. |
| Causal link types | Semantica `context.causal` | ~40 | caused, superseded, contradicts, supports link types. |
| **Total absorbed** | | **~1,500** | |

## Self-Enhancing Brain — Trace Capture + Strategy Routing

### The Vision

The brain learns HOW you use knowledge. Every query saves a trace. Traces accumulate into data. An async agent analyzes data and proposes strategy tweaks. The brain gets faster, cheaper, and more accurate over time — without manual tuning.

### Phased Delivery

```
PHASE 1 (ships with brain v1 — must work today)
├── brain_query_traces table — persist every query
├── brain_strategy_config table — switching handles for retrieval strategy
├── --strategy flag on search — manual override (rag | cag | hybrid)
├── --explain flag on search — show why a strategy was chosen
├── genie brain traces — list/filter/purge traces
├── Trace stats in genie brain status
└── Implicit rejection detection (same topic retry within 5 min)

PHASE 2 (after rlmx v0.3 — separate wish: brain-cag)
├── CAG mode live (rlmx --cache, provider caching 50-90% cheaper)
├── Auto-warm cache on genie brain update
├── Auto-select RAG vs CAG based on query pattern
└── Cache hit/miss tracking in traces

PHASE 3 (after 500+ traces — separate wish: brain-optimizer)
├── Async agent consumes all traces
├── Proposes strategy tweaks prioritized: accuracy → speed → cost
├── A/B testing (alternative strategy every Nth query)
├── File affinity scores (which files are always relevant for which topics)
├── Cost trajectory tracking (prove brain gets cheaper over time)
└── Auto-flip switching handles based on learned data
```

### Phase 1 Schema (ships now)

```sql
-- Trace every knowledge retrieval query
CREATE TABLE brain_query_traces (
  id SERIAL PRIMARY KEY,
  collection_id INT REFERENCES brain_collections(id) ON DELETE CASCADE,
  query_hash CHAR(16) NOT NULL,           -- SHA256 first 16 chars of query text
  query_text TEXT NOT NULL,
  strategy TEXT NOT NULL,                  -- rag | cag | hybrid | auto
  strategy_reason TEXT,                    -- why this strategy was chosen
  selected_doc_ids INT[],                  -- which documents were selected/returned
  selected_file_count INT,
  answer_length INT,                       -- chars in the answer
  tokens_input INT,
  tokens_output INT,
  cost_cents REAL,                         -- estimated cost in cents
  latency_ms INT,
  cache_hit BOOLEAN DEFAULT false,
  model TEXT,                              -- which LLM model was used
  task_type TEXT,                           -- Gemini task type used (RETRIEVAL_QUERY, Q&A, etc.)
  modalities_searched TEXT[],              -- which modalities were searched (text, image, etc.)
  accepted BOOLEAN,                        -- null=unknown, true=kept, false=retried
  feedback TEXT,                           -- optional explicit feedback
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_traces_query ON brain_query_traces(query_hash);
CREATE INDEX idx_traces_strategy ON brain_query_traces(strategy);
CREATE INDEX idx_traces_created ON brain_query_traces(created_at);
CREATE INDEX idx_traces_accepted ON brain_query_traces(accepted);

-- Auto-purge: default 90-day retention
-- genie brain traces --purge --older-than 90d

-- Strategy switching handles — configurable per brain
CREATE TABLE brain_strategy_config (
  id SERIAL PRIMARY KEY,
  collection_id INT REFERENCES brain_collections(id) ON DELETE CASCADE,
  query_pattern TEXT,                      -- regex or keyword pattern (null = default)
  strategy TEXT NOT NULL DEFAULT 'auto',   -- rag | cag | hybrid | auto
  priority_order TEXT[] DEFAULT '{accuracy,speed,cost}',  -- optimization priority
  min_confidence REAL DEFAULT 0.0,         -- minimum confidence to use this strategy
  max_cost_cents REAL,                     -- cost cap per query for this pattern
  enabled BOOLEAN DEFAULT true,
  reason TEXT,                             -- why this config exists (human or agent-written)
  proposed_by TEXT,                        -- 'human' | 'agent' | 'auto-optimizer'
  approved BOOLEAN DEFAULT true,           -- agent proposals need human approval
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(collection_id, query_pattern)
);
```

### Switching Handles — CLI Interface

```bash
# === VIEW current strategy config ===
genie brain strategy                              # Show all strategy configs for current brain
genie brain strategy --brain vegapunk             # Show for specific brain

# Output:
#   default:     auto (accuracy → speed → cost)
#   "competitive*": rag (set by human — "RAG finds specific competitor mentions better")
#   "weekly*":   cag (set by agent — "repeated query, CAG with cache is 90% cheaper")
#   "what is*":  cag (set by agent — "Q&A queries perform 2x better with full context")

# === SET strategy for a pattern ===
genie brain strategy set "competitive*" rag --reason "RAG finds specific mentions better"
genie brain strategy set "weekly*" cag --reason "Repeated query, cache saves 90%"
genie brain strategy set --default hybrid          # Change default strategy

# === REMOVE a strategy config ===
genie brain strategy rm "competitive*"

# === VIEW agent proposals (Phase 3) ===
genie brain strategy proposals                    # Show pending agent-proposed changes
genie brain strategy approve <id>                 # Approve an agent's proposal
genie brain strategy reject <id>                  # Reject with reason

# === SEARCH with strategy override ===
genie brain search "query" --strategy rag         # Force RAG regardless of config
genie brain search "query" --strategy cag         # Force CAG
genie brain search "query" --explain              # Show: "Used CAG because pattern 'what*' matched config..."
```

### Trace Commands (fold into status)

```bash
# === TRACES ===
genie brain traces                                # List recent (last 50)
genie brain traces --query "competitive"          # Filter by query text
genie brain traces --strategy cag                 # Filter by strategy used
genie brain traces --failed                       # Show rejected (retried within 5 min)
genie brain traces --cost                         # Sort by cost descending
genie brain traces --slow                         # Sort by latency descending
genie brain traces --explain <id>                 # Full detail for one trace
genie brain traces --purge --older-than 90d       # Retention cleanup
genie brain traces --export csv                   # Export for analysis

# === STATUS now includes trace stats ===
genie brain status
# ...
# Query Traces (last 7d):
#   142 queries | 89% acceptance rate
#   Strategy: RAG 60% | CAG 30% | Hybrid 10%
#   Avg cost: $0.003/query (↓ 40% from last week)
#   Avg latency: 180ms (↓ 25% from last week)
#   Top patterns: "competitive*" (12 hits) | "weekly*" (7 hits)
#   Cache hits: 34% (saving $0.42/week)
#   Implicit rejections: 8 (same topic retried within 5 min)
```

### Implicit Feedback Detection

```
Query at 14:00: "What's our competitive positioning?" → answer A
Query at 14:03: "competitive analysis against CrewAI" → answer B
  → Same topic (cosine similarity > 0.8), within 5 min
  → Mark trace A as accepted=false (implicit rejection)
  → Mark trace B as the "correction" attempt
  → Strategy router learns: for "competitive*" queries, strategy A was suboptimal
```

### Phase 2 Wish Seed (brain-cag)

```
# .genie/wishes/brain-cag/WISH.md (to be created when rlmx v0.3 ships)
- CAG mode: genie brain search --strategy cag → rlmx --cache --max-iterations 1
- Provider cache warmup on genie brain update (auto-warm changed brains)
- Cache hit/miss tracking in brain_query_traces
- Auto-select: strategy router reads brain_strategy_config, picks best
- Cost comparison: trace shows "RAG cost: $0.003 | CAG would have cost: $0.0004"
```

### Phase 3 Wish Seed (brain-optimizer)

```
# .genie/wishes/brain-optimizer/WISH.md (to be created after 500+ traces)
- Async agent (genie spawn optimizer) consumes brain_query_traces
- Analyzes: which strategies work for which query patterns
- Proposes: new brain_strategy_config entries (proposed_by='agent', approved=false)
- A/B testing: every Nth query, try alternative strategy, compare
- File affinity: which documents are ALWAYS selected for which topics → pin them
- Cost trajectory: weekly report showing brain is getting cheaper
- Auto-flip: agent can auto-approve low-risk strategy changes (e.g. switching to cache)
- Optimization priority: accuracy (search quality) → speed (latency) → cost (tokens)

The agent's analysis loop:
1. Pull all traces from last 7 days
2. Group by query pattern (cluster similar queries)
3. For each pattern: compare strategy performance (accuracy proxy = acceptance rate)
4. If alternative strategy beats current on accuracy AND (speed OR cost): propose switch
5. If confidence > 0.9 and pattern is low-risk: auto-approve
6. Save proposal to brain_strategy_config (proposed_by='agent')
7. Report: "3 strategy improvements proposed. Expected savings: $2.40/week, +12% acceptance"
```

### The Self-Enhancement Loop

```
Day 1:   All queries → RAG (default). Traces accumulate.
Day 7:   Human sets "weekly*" → CAG (knows it's a repeated pattern)
Day 14:  rlmx v0.3 ships. CAG mode live. Cache saves 90% on repeated queries.
Day 30:  500+ traces. Async agent runs first analysis.
         Proposes: "what is*" → CAG (93% acceptance vs 71% with RAG)
         Proposes: "find all*" → RAG (precise matching needed)
         Human approves both.
Day 60:  Agent auto-approves cache-warming for top 5 patterns.
         Cost per query: $0.003 → $0.0008 (73% reduction).
Day 90:  Brain knows its own usage patterns better than the user.
         Strategy router is 95% accurate on strategy selection.
         Human rarely overrides. The brain manages itself.
```

## RepoMind-Inspired Improvements (7 from Vegapunk research)

### 1. Content-Addressable Docs ✓ (already in schema)
`content_hash` on `brain_documents`. `genie brain update` skips unchanged files. Already designed — just confirming it's there.

### 2. Query Cascade Config (NEW — not yet in wish)

The search pipeline should cascade cheapest-to-most-expensive, stopping early when confidence is high enough:

```
Step 1: Exact match (docid, filename)     → cost: $0     latency: <1ms
Step 2: Trigram (pg_trgm partial match)   → cost: $0     latency: ~2ms
Step 3: BM25 full-text (tsvector)         → cost: $0     latency: ~5ms
Step 4: Vector semantic (pgvector)        → cost: $0     latency: ~10ms   (embeddings pre-computed)
Step 5: RRF fusion (combine 2+3+4)       → cost: $0     latency: ~15ms
Step 6: LLM reranking (Gemini)           → cost: ~$0.001 latency: ~200ms
Step 7: CAG full-context (rlmx)          → cost: ~$0.01  latency: ~2000ms
```

Each step checks: is the top result above `min_confidence` threshold? If yes, STOP — don't run more expensive steps.

```sql
-- Add cascade config to brain_strategy_config
ALTER TABLE brain_strategy_config ADD COLUMN cascade_steps TEXT[]
  DEFAULT '{exact,trigram,bm25,vector,rrf}';  -- which steps to run and in what order
ALTER TABLE brain_strategy_config ADD COLUMN min_confidence REAL DEFAULT 0.8;
  -- stop cascade when top result exceeds this score
ALTER TABLE brain_strategy_config ADD COLUMN max_step TEXT DEFAULT 'rrf';
  -- never go beyond this step (cost control)
```

```bash
# Configure cascade for a pattern
genie brain strategy set "find exact*" --cascade exact,trigram,bm25 --min-confidence 0.9
genie brain strategy set "understand*" --cascade bm25,vector,rrf --max-step rrf
genie brain strategy set "deep analysis*" --cascade bm25,vector,rrf,cag --max-step cag
```

### 3. Query + Embed Budgets ✓ (partially in wish via --budget flag)

Extend from per-query `--budget` to per-brain daily caps:

```sql
ALTER TABLE brains ADD COLUMN daily_query_budget_cents REAL;   -- null = unlimited
ALTER TABLE brains ADD COLUMN daily_embed_budget_cents REAL;   -- null = unlimited
ALTER TABLE brains ADD COLUMN budget_reset_at TIMESTAMPTZ;     -- next reset time
ALTER TABLE brains ADD COLUMN budget_spent_cents REAL DEFAULT 0;
```

```bash
genie brain create --name gtm --daily-query-budget 1.00 --daily-embed-budget 5.00
# Agent tries to search → checks budget → if exceeded: fallback to BM25 only (free)

genie brain status
#   agent:genie:gtm  Budget: $0.04/$1.00 today (resets in 18h)
```

Chatty agents don't blow up costs. Budget exceeded → degrade gracefully to free-tier search (BM25 + trigram), not hard fail.

### 4. Context Quality Scoring (NEW)

Every search result gets a composite quality score, not just relevance:

```
quality_score = (
  freshness     × 0.3   # How recently updated (exponential decay)
  + relevance   × 0.3   # BM25/vector/RRF score (what we have now)
  + authority   × 0.2   # confidence field in frontmatter (low=0.3, medium=0.6, high=1.0)
  + completeness × 0.2  # Has frontmatter? Has tags? Has links? Not an orphan?
)
```

```sql
-- Computed per-result during search, returned alongside relevance score
-- Not stored — computed at query time from document metadata
```

```bash
genie brain search "competitive positioning" --explain
# Results:
#   0.87 overall | rel:0.92 fresh:0.95 auth:0.80 comp:0.70 | strategic-positioning.md
#   0.71 overall | rel:0.85 fresh:0.40 auth:0.60 comp:0.90 | crewai-teardown.md (STALE: 30d old)
#   0.63 overall | rel:0.78 fresh:0.90 auth:0.30 comp:0.40 | new-untagged-file.md (LOW AUTHORITY)
```

Agents can trust higher-quality results more. Stale + low-authority results rank lower even if text-relevant.

### 5. Conflict Resolution Tracking (NEW)

We detect conflicts (`brain.conflict` event). But we don't track RESOLUTION. When a conflict is resolved, record how:

```sql
-- Extend brain_links for conflict lifecycle
ALTER TABLE brain_links ADD COLUMN conflict_status TEXT;  -- null | detected | resolved | accepted
ALTER TABLE brain_links ADD COLUMN resolution TEXT;        -- how it was resolved
ALTER TABLE brain_links ADD COLUMN resolved_at TIMESTAMPTZ;
ALTER TABLE brain_links ADD COLUMN resolved_by TEXT;       -- agent or human who resolved it
```

```bash
# Detect conflicts
genie brain health
#   ⚠️ CONFLICT: sama.md says "4.5M followers" but ecosystem-stats.md says "4.54M"

# Resolve manually
genie brain health --resolve-conflict <link-id> --resolution "sama.md is stale, ecosystem-stats.md is current" --keep ecosystem-stats

# Or auto-resolve by freshness
genie brain health --fix --resolve-conflicts-by freshness
# → Keeps the more recently updated document's claim, marks the other as superseded

# Events:
#   brain.conflict.detected  { doc_a, doc_b, claim_a, claim_b }
#   brain.conflict.resolved  { link_id, resolution, resolved_by, strategy: "freshness" }
```

### 6. Live vs Snapshot Mounts (NEW)

Two mount modes — critical difference for codebase mounts:

```sql
ALTER TABLE brain_mounts ADD COLUMN sync_mode TEXT DEFAULT 'snapshot';
-- snapshot: indexed at update time, search hits Postgres (stale until next update)
-- live: search falls through to filesystem for file content (always current, slower)
```

```bash
genie brain mount ~/repos/genie/src --as codebase --sync live
# Search queries against this mount check filesystem for changes before returning
# Slower but always current — critical for active codebases

genie brain mount ~/agents/genie/brain --as knowledge --sync snapshot --home
# Standard: indexed at update time, fast search, acceptable staleness for knowledge files
```

**Why this matters:** A developer searching code wants CURRENT state. A developer searching knowledge can tolerate 1-hour staleness. Different mounts, different freshness requirements.

Live mode: `genie brain search` → check file mtime → if changed since last index → re-read from disk → return fresh content (bypass Postgres for this file). More expensive but always accurate.

### 7. Composable Health Score (NEW)

Health score is NOT a single opaque number. It's a breakdown that's useful:

```
genie brain health
#
# ═══ Health Report: agent:genie:gtm ═══
#
# Overall: 87/100
#
# ┌─────────────┬───────┬────────────────────────────────────┐
# │ Dimension   │ Score │ Details                            │
# ├─────────────┼───────┼────────────────────────────────────┤
# │ Freshness   │ 92/100│ 48/52 files updated in last 7d     │
# │ Coverage    │ 85/100│ 44/52 files embedded (85%)          │
# │ Schema      │ 96/100│ 50/52 pass lint (2 missing tags)    │
# │ Connections │ 78/100│ 45/52 have ≥1 link (7 orphans)      │
# │ Conflicts   │ 90/100│ 1 active conflict (sama vs eco)     │
# │ Acceptance  │ 89/100│ 89% query acceptance rate (7d)       │
# │ MOCs        │ 86/100│ 6/7 folders have _index.md           │
# └─────────────┴───────┴────────────────────────────────────┘
#
# Quick Fixes (--fix would resolve):
#   +4 points: generate missing _index.md for Decisions/
#   +4 points: add missing tags to 2 files
#   +8 points: link 7 orphan files
#   = 103/100 (capped at 100)
```

```sql
-- Store breakdown in denormalized JSON on brains table
ALTER TABLE brains ADD COLUMN health_breakdown JSONB;
-- Example: {"freshness": 92, "coverage": 85, "schema": 96, "connections": 78, "conflicts": 90, "acceptance": 89, "mocs": 86}
```

The breakdown is what makes health ACTIONABLE. "87/100" means nothing. "7 orphans + 1 conflict + 2 missing tags" means everything. And `--fix` tells you exactly how many points it would gain.

## Supermemory-Inspired Improvements (5 from Vegapunk research)

Supermemory is #1 on all three major AI memory benchmarks (LongMemEval 81.6%, LoCoMo, ConvoMem). It has fact-level sophistication that Brain needs. Brain has system-level sophistication that Supermemory lacks. Combining both = the moat.

### 1. Version Chains at Document Level (NEW)

When a brain file is updated with NEW information that contradicts the old version, the old version isn't deleted — it becomes a previous version in a chain. "I moved to SF" doesn't delete "I live in NYC" — it supersedes it. Full history, no data loss.

```sql
ALTER TABLE brain_documents ADD COLUMN parent_doc_id INT REFERENCES brain_documents(id);
ALTER TABLE brain_documents ADD COLUMN is_latest BOOLEAN DEFAULT true;
ALTER TABLE brain_documents ADD COLUMN version INT DEFAULT 1;

CREATE INDEX idx_brain_docs_parent ON brain_documents(parent_doc_id);
CREATE INDEX idx_brain_docs_latest ON brain_documents(is_latest) WHERE is_latest = true;
```

```bash
# When a file changes significantly (not just typo fixes):
genie brain update
#   Intelligence/people/sama.md changed significantly (cosine < 0.7 with previous)
#   → Previous version: parent_doc_id set, is_latest=false
#   → New version: is_latest=true, version=2
#   → brain_links: new → old with link_type='supersedes'

# Query version history
genie brain get "#ca89e3" --versions
#   v2 (current) 2026-03-26 — "4.54M followers, Codex subagents launched"
#   v1            2026-03-20 — "4.5M followers"
#   Change: follower count updated, Codex subagents section added

# Search defaults to is_latest=true (current knowledge)
# But historical search is possible:
genie brain search "sama followers" --include-history
```

**Why this beats deletion:** Six months from now, "what did we think about Sam Altman's strategy in March 2026?" has an answer. Version chains are the memory equivalent of git history.

### 2. Static/Dynamic Classification (NEW)

Every brain document classified as static (permanent facts) or dynamic (evolving knowledge). Enables instant profile generation: "What does this agent permanently know?" vs "What is it working on right now?"

```sql
ALTER TABLE brain_documents ADD COLUMN knowledge_type TEXT DEFAULT 'dynamic';
-- static: facts that rarely change (company info, architecture decisions, domain knowledge)
-- dynamic: evolving information (daily logs, research findings, market data)
-- derived: auto-generated from other docs (descriptions, transcripts, MOCs)
```

**Auto-classification by folder convention:**
```
brain/
├── Company/        → static  (company facts don't change daily)
├── Domains/        → static  (domain knowledge is foundational)
├── Decisions/      → static  (decisions are historical record)
├── _Templates/     → static
├── Daily/          → dynamic (daily notes are by definition dynamic)
├── Intelligence/   → dynamic (research evolves rapidly)
├── DevRel/         → dynamic (content strategy changes weekly)
└── Playbooks/      → static  (procedures are stable until revised)
```

```bash
# Generate agent profile from static knowledge only:
genie brain analyze --profile
#   "Genie is an AI orchestration CLI built by Namastex Labs.
#    It knows about: agent orchestration (domain), competitive landscape (CrewAI, OpenClaw),
#    and has decided to use Postgres over SQLite for brain storage."
#   (Only static docs used — no noisy daily/intelligence churn)

# Search with knowledge type filter:
genie brain search "competitive" --knowledge static    # Only stable knowledge
genie brain search "competitive" --knowledge dynamic   # Only evolving knowledge
```

### 3. Enriched Relationship Taxonomy (EXTEND existing)

Current brain_links has: `tag-overlap | semantic | wikilink | caused | superseded | contradicts | supports`

Add from Supermemory: `updates | extends | derives`

```sql
-- brain_links.link_type now has 10 types:
-- Discovery:    tag-overlap, semantic, wikilink
-- Causal:       caused, superseded
-- Conflict:     contradicts, supports
-- Evolution:    updates, extends, derives (NEW from Supermemory)
```

**What they mean:**
- `updates` — doc B updates doc A with newer information (but doesn't contradict — just refreshes)
- `extends` — doc B adds depth/detail to doc A (related but richer)
- `derives` — doc B was derived FROM doc A (e.g. .desc.md derived from .png)

**Search uses relationship type to decide preference:**
```
contradicts → prefer the newer doc (is_latest=true wins)
supersedes  → always prefer the superseding doc
updates     → prefer the update, but original still relevant
extends     → both relevant, return both
derives     → if searching for media, return derived text too
supports    → both reinforce each other, boost relevance
```

### 4. Document-Level Forgetting with Audit Trail (NEW)

Brain lifecycle manages brain-level archival. But sometimes you need to forget INDIVIDUAL documents — without losing the audit trail.

```sql
ALTER TABLE brain_documents ADD COLUMN is_forgotten BOOLEAN DEFAULT false;
ALTER TABLE brain_documents ADD COLUMN forget_after TIMESTAMPTZ;       -- auto-forget date
ALTER TABLE brain_documents ADD COLUMN forget_reason TEXT;              -- why it was forgotten
ALTER TABLE brain_documents ADD COLUMN forgotten_at TIMESTAMPTZ;
ALTER TABLE brain_documents ADD COLUMN forgotten_by TEXT;               -- agent or human

CREATE INDEX idx_brain_docs_forgotten ON brain_documents(is_forgotten) WHERE is_forgotten = false;
```

```bash
# Forget a document (soft delete — still in DB, excluded from search)
genie brain forget Intelligence/people/old-contact.md --reason "no longer relevant"

# Auto-forget: set a TTL on a document
genie brain forget Intelligence/market/temporary-analysis.md --after 30d --reason "one-time research"

# Search excludes forgotten docs by default
genie brain search "query"              # Skips forgotten
genie brain search "query" --forgotten  # Include forgotten (for audit)

# Restore a forgotten document
genie brain remember Intelligence/people/old-contact.md

# Health reports forgetting schedule:
genie brain health
#   📅 Forgetting soon: temporary-analysis.md (in 12 days)
#   🗑️ Forgotten: 3 documents (searchable with --forgotten)
```

**Why not just delete?** Audit trail. "Why don't we know about this competitor anymore?" → "Forgotten on 2026-04-15 by agent:genie, reason: acquired by Microsoft, no longer a competitor."

Two tiers of memory management:
- **Brain-level:** lifecycle (permanent → archived) — for entire brains
- **Document-level:** forgetting (active → forgotten) — for individual documents within active brains

### 5. Multi-Model Embedding Storage (EXTEND existing)

When switching embedding models (e.g. `gemini-embedding-2-preview` → `gemini-embedding-3`), don't force immediate re-indexing of everything. Store both old and new embeddings side by side. Migrate incrementally.

```sql
-- brain_chunks already has embed_model column
-- Add a migration-aware query:

-- During migration: both models coexist
-- Search queries: prefer new model chunks, fall back to old model chunks
-- genie brain update --migrate-embeddings: re-embed one batch at a time
-- genie brain status: shows "45% migrated to gemini-embedding-3"
```

```bash
# Start embedding migration (non-blocking, incremental)
genie brain update --embed-model gemini-embedding-3 --migrate
#   Migrating embeddings: gemini-embedding-2-preview → gemini-embedding-3
#   Batch 1/10: 23 chunks re-embedded
#   Progress: 10% migrated. Search uses both models (hybrid).
#   Run again to continue migration.

# Status shows migration progress
genie brain status
#   Embeddings: 90% gemini-embedding-2-preview, 10% gemini-embedding-3 (migrating)

# Search during migration:
# 1. Search new-model chunks first (higher quality)
# 2. Fall back to old-model chunks for un-migrated docs
# 3. RRF fuses results from both
# 4. No downtime, no full re-index required
```

**Why this matters:** Embedding models improve every 3-6 months. A brain with 1000+ documents shouldn't go offline for re-indexing. Incremental migration = zero downtime.

## Patterns & Conventions (underpinning the entire system)

### 1. Brain Inventory (.brain-inventory.json)

Every brain has a filesystem-level inventory tracking every file's state. This is the bridge between the filesystem (source of truth) and Postgres (index). `genie brain update` reads this first to know what changed.

```json
{
  "version": 1,
  "brain_name": "genie",
  "last_sync": "2026-03-26T16:00:00Z",
  "embed_model": "gemini-embedding-2-preview",
  "embed_dims": 3072,
  "files": {
    "DevRel/content-backlog.md": {
      "hash": "a1b2c3d4e5f6",
      "modality": "text",
      "docid": "#a1b2c3",
      "indexed": true,
      "embedded": true,
      "chunks": 3,
      "updated": "2026-03-26T12:48:00Z"
    },
    "Intelligence/media/screenshot.png": {
      "hash": "d4e5f6a7b8c9",
      "modality": "image",
      "docid": "#d4e5f6",
      "indexed": true,
      "embedded": true,
      "chunks": 2,
      "described": true,
      "description_file": "Intelligence/media/screenshot.desc.md",
      "updated": "2026-03-26T10:00:00Z"
    }
  }
}
```

**Sync algorithm:**
1. Walk filesystem, hash each file
2. Compare to inventory → classify as: NEW, MODIFIED, UNCHANGED, DELETED
3. Process only NEW + MODIFIED (skip UNCHANGED entirely)
4. Remove DELETED from Postgres
5. Update inventory
6. Report: "3 new, 1 modified, 0 removed, 48 unchanged"

### 2. Multi-Agent Shared Brain Architecture

Multiple agents share knowledge through a central brain + individual brains:

```
/home/genie/agents/shared-brain/          ← Org knowledge (all agents read/write)
├── Company/                               ← Products, team, strategy
├── Domains/                               ← Agent-orchestration, context-engineering
└── Intelligence/competitors/              ← CrewAI, OpenClaw, etc.

/home/genie/agents/<agent>/brain/          ← Agent-specific brain
├── DevRel/                                ← (Genie only)
├── Intelligence/x-profiles/               ← (Genie only)
└── ...

Cross-brain search:
  genie brain search "query" --all         ← searches ALL registered brains
  genie brain search "query" --brain shared ← searches only shared brain
  genie brain search "query"               ← searches agent's own brain (default)
```

Each agent registers its brain + the shared brain as collections. `genie brain status` shows all. `genie brain init` auto-links to shared-brain if it exists at `../shared-brain`.

### 3. Derivative Files Convention

When media is processed, derivative files are created ALONGSIDE the original. Naming convention:

```
original.mp4              ← NEVER modified by genie brain
original.transcript.md    ← auto-generated transcript (audio/video)
original.desc.md          ← auto-generated description (image/video)
original.extracted.md     ← auto-generated text extraction (PDF)
original.frames/          ← extracted key frames (video)
├── frame_0001.jpg
├── frame_0010.jpg
└── frame_0020.jpg
```

**Rules:**
- Originals NEVER modified
- Derivatives use `.transcript.md`, `.desc.md`, `.extracted.md`, `.frames/` suffixes
- Derivatives ARE indexed as text documents too (double-indexing for maximum recall)
- Derivatives are regenerable: `genie brain update --force` recreates them
- `.brain-inventory.json` tracks derivative paths per media file
- Obsidian shows derivatives alongside originals (navigable)

### 4. Obsidian Compatibility Layer

Every brain is a valid Obsidian vault. The `.obsidian/` directory is scaffolded by `genie brain init`:

```json
// .obsidian/app.json
{
  "newFileLocation": "folder",
  "newFileFolderPath": "Daily",
  "attachmentFolderPath": "assets"
}

// .obsidian/daily-notes.json
{
  "folder": "Daily",
  "format": "YYYY-MM-DD",
  "template": "_Templates/daily.md"
}

// .obsidian/templates.json
{
  "folder": "_Templates"
}

// .obsidian/graph.json
{
  "colorGroups": [
    {"query": "path:DevRel", "color": {"a": 1, "rgb": 65535}},
    {"query": "path:Intelligence", "color": {"a": 1, "rgb": 16776960}},
    {"query": "path:Company", "color": {"a": 1, "rgb": 65280}},
    {"query": "path:Playbooks", "color": {"a": 1, "rgb": 16711935}},
    {"query": "path:Decisions", "color": {"a": 1, "rgb": 16750848}},
    {"query": "path:Daily", "color": {"a": 1, "rgb": 8421504}}
  ]
}
```

**What Obsidian sees:**
- Graph view with colored clusters per folder
- [[wikilinks]] as edges between nodes
- MOC files (`_index.md`) as hub nodes
- Frontmatter (tags, type, confidence, aliases) in sidebar
- Daily notes auto-created in Daily/
- Templates in _Templates/
- Images, PDFs visible inline
- Backlinks panel shows incoming [[links]]

### 5. rlmx Config as Brain Personality

Each brain has rlmx config files that define its "reasoning personality." Scaffolded by `genie brain init`, customized by `/brain-init` skill.

```
brain/
├── SYSTEM.md     ← System prompt for rlmx reasoning
├── TOOLS.md      ← Custom Python REPL functions for this brain
├── CRITERIA.md   ← Output format expectations
├── MODEL.md      ← LLM provider and model selection
```

**Codebase brain SYSTEM.md** (auto-generated from package.json + README + CLAUDE.md):
```markdown
You are analyzing the Genie CLI codebase — a TypeScript/Bun agent orchestration tool
with 46 commands, 14 skills, and a wish-based pipeline.
When reasoning: reference files as src/path/file.ts:line.
```

**Agent brain SYSTEM.md:**
```markdown
You are the intelligence analyst for Genie's GTM brain.
This brain contains market research, competitive analysis, X profiles, and DevRel content.
When answering: cite brain files by path. Flag confidence levels.
```

**TOOLS.md** (custom Python functions available in rlmx REPL):
```markdown
## search_by_tag
` ``python
def search_by_tag(tag):
    """Find all brain files containing a specific tag in frontmatter."""
    return [item for item in context if f'tags:' in item.get('content','') and tag in item['content']]
` ``

## compare_dates
` ``python
def compare_dates(file1, file2):
    """Compare which brain file was updated more recently."""
    import re
    for item in context:
        if item['path'].endswith(file1):
            match = re.search(r'updated: (\d{4}-\d{2}-\d{2})', item['content'])
            if match: return f"{file1}: {match.group(1)}"
    return "not found"
` ``
```

### 6. Search Pipeline Architecture

Four search backends, fused via RRF, with smart intent routing:

```
User query → Intent Detector → Route to optimal backend(s)

Intent Detection:
  "handleWorkerSpawn"           → SYMBOL (exact match → trigram + refs)
  "/^async function/"           → REGEX (grep-style → trigram)
  "how does dispatch work"      → NATURAL LANGUAGE (BM25 + vector + RRF)
  "Does Genie support Codex?"   → QUESTION (QUESTION_ANSWERING task type)
  "CrewAI has 44,500 stars"     → CLAIM (FACT_VERIFICATION task type)
  "#ca89e3"                     → DOCID (direct retrieval, no search)
  "screenshot.png"              → FILE (cross-modal embedding search)

Backend Fusion (for NL queries):
  ┌─────────────────────────────────────────────────┐
  │  1. tsvector BM25        (keyword precision)     │
  │  2. pgvector cosine      (semantic meaning)      │
  │  3. pg_trgm similarity   (partial/fuzzy match)   │
  │  4. Gemini task-specific (intent-optimized)      │
  └─────────────────────────────────────────────────┘
           │           │           │           │
           └───────────┴───────────┴───────────┘
                           │
                    RRF Fusion (k=60)
                    Original query ×2 weight
                    Top-rank bonus: +0.05/#1, +0.02/#2-3
                           │
                    Position-Aware Blend
                    Rank 1-3:  75% retrieval / 25% reranker
                    Rank 4-10: 60% retrieval / 40% reranker
                    Rank 11+:  40% retrieval / 60% reranker
                           │
                    Final ranked results
```

### 7. Frontmatter Schema (complete reference)

```yaml
---
# REQUIRED (all files)
type: entity | intel | playbook | daily | domain | moc | decision
tags: [tag1, tag2]               # Array, not string
created: YYYY-MM-DD
updated: YYYY-MM-DD

# REQUIRED (intel files — type: intel)
confidence: low | medium | high
source: direct-research | x-profile | web | agent-report | felipe

# REQUIRED (people/company — detected by folder or tags containing 'person' or 'company')
aliases: [Name1, @handle, Short Name]

# OPTIONAL (all files)
status: active | archived | draft
valid_from: YYYY-MM-DD           # Temporal validity start (null = always valid)
valid_until: YYYY-MM-DD          # Temporal validity end (null = never expires)
source_url: https://...          # Where this knowledge came from
source_type: direct | derived | inferred | imported
related: []                      # Manual relationship overrides

# DECISION files (type: decision)
decision: "Use Postgres not SQLite"
alternatives: ["qmd SQLite", "custom graph DB"]
rationale: "One DB, joins with tasks/events"
decided_by: "Felipe"
status: active | superseded | reversed
superseded_by: "filename-of-new-decision"
---
```

### 8. Media Format Conversion (ffmpeg commands)

Before embedding, unsupported formats are converted to Gemini-compatible formats:

```bash
# Image: WebP/GIF → PNG
ffmpeg -i input.webp output.png
ffmpeg -i input.gif -frames:v 1 output.png  # First frame for GIF

# Audio: OGG/M4A/FLAC/AAC/WebM → MP3 (Gemini only supports MP3/WAV)
ffmpeg -i input.ogg -ac 1 -ar 16000 output.mp3
ffmpeg -i input.m4a -ac 1 -ar 16000 output.mp3
ffmpeg -i input.flac -ac 1 -ar 16000 output.mp3

# Video: AVI/MKV/WebM → MP4 (Gemini only supports MP4/MOV with H264/H265/AV1/VP9)
ffmpeg -i input.avi -c:v libx264 -c:a aac output.mp4
ffmpeg -i input.mkv -c:v libx264 -c:a aac output.mp4

# Extract audio from video (CRITICAL: Gemini does NOT process audio in video embeddings)
ffmpeg -i video.mp4 -vn -acodec pcm_s16le audio.wav

# Extract key frames from video
ffmpeg -i video.mp4 -vf "fps=0.5" frames/frame_%04d.jpg  # 1 frame per 2 sec
```

### 9. Graceful Degradation

The brain works at every level — even without embeddings, even without Gemini:

```
FULL POWER (Postgres + Gemini + rlmx):
  BM25 + vector + trigram + multimodal + reasoning + traces

WITHOUT GEMINI KEY:
  BM25 + trigram search (tsvector + pg_trgm)
  No vector search, no embeddings, no media descriptions
  analyze still works (rlmx uses whatever LLM is configured)

WITHOUT rlmx:
  Search, health, link, update all work
  analyze/synthesize/classify/cluster unavailable

WITHOUT POSTGRES (pure filesystem mode):
  genie brain health --fs-only
  genie brain link --fs-only
  Fallback to grep + frontmatter parsing
  No search, no traces, no strategies
  Files still work in Obsidian

MINIMUM VIABLE BRAIN:
  genie brain init + markdown files + Obsidian
  Everything else is additive
```

### 10. Cost Model

```
Operation                      Gemini Cost         Postgres Cost
─────────────────────────────────────────────────────────────────
Text embedding (per chunk)     ~$0.000001          ~$0 (local)
Image embedding                ~$0.00005           ~$0
Video embedding (≤120s)        ~$0.0005            ~$0
Audio embedding (≤80s)         ~$0.0001            ~$0
PDF embedding (≤6 pages)       ~$0.0002            ~$0
Vision description (per image) ~$0.0001            ~$0
Transcription (Groq Whisper)   Free (< 19.5MB)     N/A
Transcription (Gemini)         ~$0.0005            N/A
BM25 search                    $0                  ~$0 (local)
Vector search                  $0                  ~$0 (local)
Batch API embedding            50% off above       ~$0

Typical brain (50 .md + 10 images + 2 videos + 1 PDF):
  First index: ~$0.05
  Daily update (3 changed files): ~$0.003
  Daily search (20 queries): ~$0 (all local after embedding)
  Monthly cost: ~$0.15

With rlmx v0.3 caching:
  First analyze: ~$0.01
  Cached analyze: ~$0.001 (90% off with Anthropic, 50% with OpenAI)
```

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| pgvector not in pgserve build | Medium | Check. `CREATE EXTENSION vector`. If missing from build, add to pgserve. BM25 works without it. |
| Gemini Embedding 2 rate limits | Low | Free tier: 1500 RPM. 233 docs = trivial. Batch support reduces calls. |
| Gemini Embedding 2 goes paid | Low | OpenAI text-embedding-3-small as fallback ($0.02/1M tokens). Config in MODEL.md. |
| Absorbed chunking diverges from qmd upstream | Low | We own it now. It's 120 lines. We evolve it for our needs. |
| Large brains slow down update/embed | Low | Incremental sync (content_hash comparison). Only re-embed changed docs. |
| rlmx Python dep for analyze/synthesize | Low | Python 3.10+ is already on the machine. rlmx has 1 npm dep (pi/ai). |

## Files to Create/Modify

```
MODIFY  repos/genie-brain/package.json                         (add rlmx dep, google-genai SDK)
MODIFY  repos/genie-brain/src/db/migrations/NNN-brain.sql      (14 tables: brains + attachments + mounts + entity_links + collections + documents + chunks + contexts + links + symbols + refs + decisions + traces + strategy_config + extensions: pgvector + pg_trgm)

CREATE  repos/genie-brain/src/term-commands/brain.ts            (8 core + identity: init, update, search, get, analyze, health, link, status, create, archive, attach, detach, mount, unmount, list)
CREATE  repos/genie-brain/src/lib/brain/types.ts                (BrainConfig, BrainFile, BrainType, Modality, TaskType)
CREATE  repos/genie-brain/src/lib/brain/schema.ts               (Zod frontmatter schemas per file type)
CREATE  repos/genie-brain/src/lib/brain/db.ts                   (Postgres queries: upsert, search, links)
CREATE  repos/genie-brain/src/lib/brain/chunking.ts             (absorbed from qmd: heading-aware, code-fence-safe, 900 tokens)
CREATE  repos/genie-brain/src/lib/brain/search.ts               (BM25 + vector + RRF + smart intent detection)
CREATE  repos/genie-brain/src/lib/brain/embedding.ts            (Gemini Embedding 2: all 8 task types, multimodal, Matryoshka, Batch API)
CREATE  repos/genie-brain/src/lib/brain/media.ts                (format conversion, frame extraction, audio extraction from video)
CREATE  repos/genie-brain/src/lib/brain/symbols.ts              (tree-sitter symbol extraction: functions, classes, structs → brain_symbols)
CREATE  repos/genie-brain/src/lib/brain/refs.ts                 (reference tracking: definitions, imports, usages → brain_refs)
CREATE  repos/genie-brain/src/lib/brain/intent.ts               (query intent detection: regex vs NL vs symbol vs question vs claim)
CREATE  repos/genie-brain/src/lib/brain/docid.ts                (6-char content hash)
CREATE  repos/genie-brain/src/lib/brain/detect.ts               (context auto-detection: codebase/agent/workspace)
CREATE  repos/genie-brain/src/lib/brain/init.ts                 (intelligent scaffold + .obsidian + rlmx configs)
CREATE  repos/genie-brain/src/lib/brain/update.ts               (full sync: scan, index, describe, convert, embed, link)
CREATE  repos/genie-brain/src/lib/brain/health.ts               (lint + orphans + links + stale + MOCs + score + --fix)
CREATE  repos/genie-brain/src/lib/brain/link.ts                 (wikilinks + aliases + semantic + brain_links)
CREATE  repos/genie-brain/src/lib/brain/analyze.ts              (rlmx wrapper + classify + cluster + synthesize + digest + decision)
CREATE  repos/genie-brain/src/lib/brain/decisions.ts            (decision tracking: record, trace chain, find similar, supersede)
CREATE  repos/genie-brain/src/lib/brain/conflicts.ts            (conflict detection: contradictory claims across docs)
CREATE  repos/genie-brain/src/lib/brain/temporal.ts             (temporal validity: valid_from/valid_until, expiry detection)
CREATE  repos/genie-brain/src/lib/brain/provenance.ts           (provenance: source tracking, lineage)
CREATE  repos/genie-brain/src/lib/brain/identity.ts             (brain CRUD: create, archive, delete, scoped ID generation)
CREATE  repos/genie-brain/src/lib/brain/attachments.ts          (attach, detach, list, role management)
CREATE  repos/genie-brain/src/lib/brain/mounts.ts               (mount, unmount, list, home detection, symlink management)
CREATE  repos/genie-brain/src/lib/brain/entity-links.ts         (cross-entity links: brain docs ↔ wishes/tasks/PRs)
CREATE  repos/genie-brain/src/lib/brain/auto-brain.ts           (auto-discover on spawn, auto-create on task, auto-attach shared)
CREATE  repos/genie-brain/src/lib/brain/traces.ts               (trace recording, querying, implicit rejection detection, purge)
CREATE  repos/genie-brain/src/lib/brain/strategy.ts             (strategy config CRUD, pattern matching, switching handles)
CREATE  repos/genie-brain/src/lib/brain/status.ts               (brain identity + stats + coverage + trace stats + staleness)
CREATE  repos/genie/skills/brain-init/SKILL.md            (brain-init Claude Code skill)

CREATE  repos/genie-brain/src/lib/brain/chunking.test.ts
CREATE  repos/genie-brain/src/lib/brain/search.test.ts
CREATE  repos/genie-brain/src/lib/brain/embedding.test.ts
CREATE  repos/genie-brain/src/lib/brain/update.test.ts
CREATE  repos/genie-brain/src/lib/brain/health.test.ts
CREATE  repos/genie-brain/src/lib/brain/link.test.ts
CREATE  repos/genie-brain/src/lib/brain/init.test.ts
CREATE  repos/genie-brain/src/lib/brain/media.test.ts
CREATE  repos/genie-brain/src/lib/brain/identity.test.ts
CREATE  repos/genie-brain/src/lib/brain/attachments.test.ts
CREATE  repos/genie-brain/src/lib/brain/mounts.test.ts
CREATE  repos/genie-brain/src/lib/brain/traces.test.ts
CREATE  repos/genie-brain/src/lib/brain/strategy.test.ts
```
