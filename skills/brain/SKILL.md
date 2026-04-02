---
name: brain
description: "Knowledge graph engine — search, analyze, and manage AI agent brains with confidence scoring, autoschema, and multimodal support."
---

# /brain — Knowledge Graph Engine

Search, analyze, and manage knowledge brains powered by genie-brain v0.1.0. Brains are Postgres-backed, Obsidian-compatible knowledge vaults with BM25 + vector search, confidence scoring, and agentic autoschema.

## When to Use
- Search for knowledge before answering a question
- Check what the brain knows (and doesn't know) about a topic
- Analyze content with deep reasoning
- Ingest new content into the brain
- Check brain health and coverage gaps
- Mount external directories as brain sources
- Manage brain access (attach agents, tasks, teams)
- Audit query history and search strategy

## Prerequisites

Brain must be installed: `genie brain install`
If not installed, guide the user to run the install command.

---

## Lifecycle Commands

### init — scaffold a new brain vault
```bash
genie brain init --name <name> --path <path> [--type gtm|pm|engineering|research|personal|generic] [--from <raw-content-path>] [--mode automatic|guided]
```
Creates an Obsidian-compatible vault with directory structure, templates, and Postgres registration.

### create — register a brain in Postgres (no vault)
```bash
genie brain create --name <name> [--owner <type:id>] [--lifecycle permanent|ephemeral|archived] [--type <type>] [--ttl <duration>] [--description <text>]
```
For runtime brains that don't need a filesystem vault. Owner format: `agent:genie`, `task:123`.

### archive — make brain read-only
```bash
genie brain archive <brain-id>
```
Marks brain as archived. Still searchable, no longer accepts updates.

### migrate — run database migrations
```bash
genie brain migrate
```
Creates or updates all brain tables. Idempotent — safe to re-run.

---

## Ingest Commands

### update — sync filesystem to Postgres
```bash
genie brain update --brain <id> [--path <path>] [--no-embed] [--skip-if-locked] [--verbose] [--budget-cents <num>]
```
Walks brain directory + mounts, chunks text, computes embeddings, upserts to Postgres. Hash-based skip for unchanged files. Advisory lock prevents concurrent runs.

### process — handle multimodal files in to_process/
```bash
genie brain process --brain <id> [--path <path>]
```
Processes files in `to_process/`:
- Audio → transcript via Whisper
- Video → frame extraction + scene detection + transcript
- PDF → page-level extraction + OCR
- Images → vision API description
- Code → symbol extraction + semantic chunking
- Markdown → classified and moved to decided folder

### watch — auto-index on file changes
```bash
genie brain watch start|stop|status --brain <id> [--path <path>] [--manual]
```
Watchdog on `to_process/` directory. Auto-runs `process` + `update` when files appear.

### mount — attach external directory to brain
```bash
genie brain mount <path> --as <alias> --brain <id> [--path <brain-path>]
```
Creates `_mounts/<alias>` symlink in brain vault. Mounted content is included in `update` scans and appears in Obsidian.

```bash
# Example: mount a codebase into an engineering brain
genie brain mount /home/user/project --as codebase --brain agent:genie:engineering
```

### unmount — remove external directory
```bash
genie brain unmount <alias> --brain <id> [--path <brain-path>]
```
Removes symlink and DB entry. Mounted docs no longer indexed on next update.

---

## Query Commands

### search — find knowledge with confidence scoring
```bash
genie brain search "<query>" --brain <id> [--limit <num>] [--min-confidence <float>] [--strategy rag|cag] [--explain]
```
Returns ranked results with confidence level. `--explain` shows scoring breakdown.

**Always search before answering domain questions.** If confidence is LOW/NONE, say so — don't hallucinate.

### get — retrieve a specific document
```bash
genie brain get <path|#docid> --brain <id>
```
Fetch full document by file path or document ID (e.g., `#abc123`).

### analyze — deep reasoning via rlmx
```bash
genie brain analyze "<query>" --brain <id> [--path <path>] [--thinking high|medium|low] [--mode classify|cluster|synthesize|digest|decision|profile]
```
Generates synthesized answers (not snippets) using the rlmx reasoning engine. Returns answer, sources, and cost.

---

## Knowledge Commands

### link — discover connections between documents
```bash
genie brain link --brain <id> [--semantic] [--dry-run] [--detect-conflicts]
```
Generates 10 link types: `tag-overlap`, `semantic`, `wikilink`, `caused`, `superseded`, `contradicts`, `supports`, `updates`, `extends`, `derives`. Use `--semantic` for vector-similarity links (slower, more accurate).

### health — lint brain + compute health score
```bash
genie brain health [--path <brain-path>] [--fix]
```
7-dimension score (each out of 100): Frontmatter, Structure, Links, Currency, Coverage, Consistency, Orphans. `--fix` auto-repairs: adds missing dates, converts tags, generates MOCs.

### status — brain dashboard
```bash
genie brain status
```
Lists all registered brains with file counts, chunk counts, mounts, health, query stats, and last update time.

---

## Identity Commands (RBAC)

### attach — grant entity access to brain
```bash
genie brain attach <brain-id> --entity <type:id> --role owner|writer|reader
```
Entity format: `agent:genie`, `task:123`, `team:platform`. Role hierarchy: owner (full control) > writer (update + search) > reader (search only).

### detach — revoke entity access
```bash
genie brain detach <brain-id> --entity <type:id>
```

### list — show all attachments
```bash
genie brain list [--brain <id>] [--entity <type:id>]
```
Filter by brain, entity, or both.

---

## Observability Commands

### traces — query history and gap detection
```bash
genie brain traces --brain <id> [--limit <num>] [--failed] [--strategy <name>] [--purge] [--older-than <days>]
```
Lists search/analyze history with confidence, latency, cost, and gap detection. `--failed` shows only queries where the brain had LOW/NONE confidence. `--purge` deletes traces older than N days (default: 90).

### strategy — per-brain search strategy routing
```bash
genie brain strategy show --brain <id>
genie brain strategy set "<pattern>" <strategy> --brain <id> [--reason <text>]
genie brain strategy rm "<pattern>" --brain <id>
```
Route queries matching a glob pattern to a specific strategy. Example: `genie brain strategy set "deployment*" cag --reason "needs full document context"`.

### cache — estimate CAG cache costs
```bash
genie brain cache --estimate --brain <id>
```
Shows token counts, per-query cost with and without caching, and break-even query count.

---

## Search Strategies

### RAG (default) — Retrieval-Augmented Generation
Combines three search backends via Reciprocal Rank Fusion (RRF):
1. **BM25** — full-text search on documents + chunks
2. **Trigram** — fuzzy matching via PostgreSQL pg_trgm
3. **Vector** — semantic search via embeddings (Gemini E2)

Best for: factual lookups, specific topics, quick answers.

### CAG — Context-Augmented Generation
1. Finds top 5 relevant docs via RAG
2. Loads entire documents as LLM context
3. Runs rlmx with prompt caching for synthesis

Best for: synthesized answers, complex reasoning, cross-document analysis. Higher per-query cost but cached after first run (90% savings on repeats).

Use `--strategy cag` to force CAG, or configure per-brain routing with `genie brain strategy set`.

---

## Confidence Scoring

| Level | Top Score | Distribution | Agent Action |
|-------|-----------|-------------|-------------|
| **FULL** | >= 0.80 | 3+ results >= 0.60 | Use directly, cite sources |
| **HIGH** | >= 0.70 | 2+ results >= 0.50 | Use with confidence |
| **PARTIAL** | >= 0.50 | 1+ results >= 0.40 | Use + supplement if needed |
| **LOW** | >= 0.30 | any | Go external, mention brain gap |
| **NONE** | < 0.30 | any | Research externally, don't guess |

**Gap detection:** Automatically flags LOW/NONE results and suggests action: `use_brain`, `supplement`, `go_external`, `research_needed`.

**Authority scoring** affects ranking: hand-written docs score higher than derived/inferred content. Frontmatter `confidence: high|medium|low` also weights results.

---

## Brain Types

| Type | Use Case | Base Folders |
|------|----------|-------------|
| `gtm` | Marketing, competitive intel | Intelligence/, DevRel/, Company/ |
| `pm` | Product management | Backlog/, Roadmap/, Specs/ |
| `engineering` | Architecture, code | Architecture/, Decisions/, Runbooks/ |
| `research` | R&D, papers | Papers/, Notes/, Experiments/ |
| `personal` | Personal knowledge (PARA) | Projects/, Areas/, Resources/ |
| `generic` | Auto-decided by content | (autoschema decides) |

---

## How Agents Should Use This

### Before answering domain questions:
1. `genie brain search "<topic>" --brain <id>`
2. Check confidence level in output
3. FULL/HIGH → cite the results
4. PARTIAL → use results + note limitations
5. LOW/NONE → say "brain doesn't cover this" and research externally

### After learning something new:
1. Write a `.md` file with YAML frontmatter to `brain/to_process/`
2. Run `genie brain process --brain <id>` to classify and index
3. Run `genie brain update --brain <id>` to sync to Postgres

### Integrating external knowledge:
1. `genie brain mount /path/to/docs --as external --brain <id>`
2. `genie brain update --brain <id>` to index mounted content
3. Mounted docs now searchable alongside native brain content

### Sharing brains across agents/tasks:
1. `genie brain attach <brain-id> --entity agent:other --role reader`
2. Other agent can now search the brain
3. Use `writer` role if the other agent should contribute content

### Auditing search quality:
1. `genie brain traces --brain <id> --failed` to see gap queries
2. Write content to fill gaps, then `update`
3. `genie brain strategy set "<pattern>" cag` if certain queries need full-context answers

### Session hygiene:
- Start: `genie brain status` for dashboard
- During: search before making claims
- End: write session learnings to `brain/to_process/`

---

## Rules
- **Search before claiming.** If the brain has an answer, use it.
- **Respect confidence.** NONE means NONE — don't fabricate.
- **Write back.** If you learn something the brain should know, add it.
- **Use frontmatter.** All brain files need YAML frontmatter (type, tags, dates).
- **Keep it Obsidian-compatible.** Wikilinks, not regular links.
- **Check traces.** Review failed queries to find and fill knowledge gaps.
