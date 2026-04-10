# Wish: brain-intelligence — Decisions, Symbols, Links, Analyze, Version Chains

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `brain-intelligence` |
| **Date** | 2026-03-27 |
| **Parent** | [brain-obsidian](../brain-obsidian/WISH.md) |
| **depends-on** | `brain-embeddings` (semantic linking needs vectors), `rlmx v0.2` (analyze needs reasoning engine) |

## Summary

The knowledge graph intelligence layer. Decisions as first-class objects. Symbol extraction for codebases (tree-sitter). Wikilink generation from tags + semantic similarity. Causal link types. `genie brain analyze` via rlmx. `genie brain link` with conflict detection. Version chains (Supermemory pattern). Document-level forgetting. Static/dynamic classification. MOC generation. Composable health score (7 dimensions). Enriched relationship taxonomy (10 link types).

**After this ships:** the brain is a real knowledge graph with relationships, reasoning, conflict detection, version history, and an intelligence layer that explains WHY things are connected.

## Scope

### IN
- Migration `003-brain-intelligence.sql`: brain_decisions, brain_symbols, brain_refs, brain_links (full with 10 link types). ALTER TABLE brain_documents: add parent_doc_id, is_latest, version, knowledge_type, valid_from, valid_until, source_url, source_type, is_forgotten, forget_after, forget_reason, forgotten_at, forgotten_by
- `src/lib/brain/link.ts` — wikilinks + aliases + semantic similarity + causal types + conflict detection + `--detect-conflicts` + `--dry-run` + `--semantic`
- `src/lib/brain/analyze.ts` — rlmx SDK wrapper + --classify + --cluster + --synthesize + --digest + --decision + --profile
- `src/lib/brain/decisions.ts` — record, trace chain, find similar, supersede
- `src/lib/brain/conflicts.ts` — detect contradictory claims, resolution tracking
- `src/lib/brain/temporal.ts` — valid_from/valid_until, expiry detection
- `src/lib/brain/provenance.ts` — source tracking, lineage
- `src/lib/brain/symbols.ts` — tree-sitter symbol extraction (functions, classes, structs → brain_symbols)
- `src/lib/brain/refs.ts` — cross-file reference tracking (definitions, imports, usages → brain_refs)
- `src/lib/brain/moc.ts` — MOC _index.md generation per folder
- Extend `health.ts` — composable 7-dimension score (freshness, coverage, schema, connections, conflicts, acceptance, MOCs) + --fix generates MOCs + --resolve-conflicts-by freshness + conflict/expiry warnings
- Extend `search.ts` — --refs (symbol references), --outline (file structure)
- Version chains: parent_doc_id, is_latest, version. Significant changes create new version, old becomes is_latest=false.
- Static/dynamic classification: knowledge_type auto-detected by folder convention
- Forgetting: is_forgotten soft delete with audit trail, forget_after TTL
- Multi-model embedding migration (incremental, both models coexist)
- Absorbed: Semantica decisions (~80 lines), conflicts (~60 lines), temporal (~30 lines), provenance (~40 lines), causal (~40 lines). Grepika symbols (~150 lines), refs (~100 lines).

### OUT
- Traces / strategy (brain-observability)
- Full identity lifecycle (brain-identity-impl)
- /brain-init skill (brain-init-skill)

## Success Criteria

- [ ] `genie brain link` generates [[wikilinks]] + aliases in one pass, stored in brain_links + files
- [ ] `genie brain link --semantic` uses vector similarity (not just tags)
- [ ] `genie brain link --detect-conflicts` finds contradictory claims
- [ ] brain_links has 10 link types working: tag-overlap, semantic, wikilink, caused, superseded, contradicts, supports, updates, extends, derives
- [ ] `genie brain analyze "query"` returns answer with file references via rlmx
- [ ] `genie brain analyze --classify` auto-suggests type + tags (CLASSIFICATION task type)
- [ ] `genie brain analyze --cluster` groups semantically (CLUSTERING task type)
- [ ] `genie brain analyze --decision "title" --rationale "why"` records to brain_decisions
- [ ] `genie brain analyze --profile` generates agent profile from static knowledge only
- [ ] `genie brain health` shows composable 7-dimension score with breakdown
- [ ] `genie brain health --fix` generates MOCs + resolves conflicts by freshness
- [ ] `genie brain health` reports expired docs (valid_until) and forgotten docs
- [ ] Version chains: significant doc changes create new version, history queryable with `--versions`
- [ ] `genie brain forget <path> --reason "..." --after 30d` works
- [ ] `genie brain search --refs handleWorkerSpawn` finds symbol references (codebase brains)
- [ ] `bun run check` passes

## Files to Create/Modify

```
CREATE  repos/genie-brain/src/db/migrations/003-brain-intelligence.sql
CREATE  repos/genie-brain/src/lib/brain/link.ts
CREATE  repos/genie-brain/src/lib/brain/analyze.ts
CREATE  repos/genie-brain/src/lib/brain/decisions.ts
CREATE  repos/genie-brain/src/lib/brain/conflicts.ts
CREATE  repos/genie-brain/src/lib/brain/temporal.ts
CREATE  repos/genie-brain/src/lib/brain/provenance.ts
CREATE  repos/genie-brain/src/lib/brain/symbols.ts
CREATE  repos/genie-brain/src/lib/brain/refs.ts
CREATE  repos/genie-brain/src/lib/brain/moc.ts
MODIFY  repos/genie-brain/src/lib/brain/health.ts          (composable score + conflicts + expiry + MOC)
MODIFY  repos/genie-brain/src/lib/brain/search.ts          (--refs, --outline)
MODIFY  repos/genie-brain/src/lib/brain/update.ts          (version chains, knowledge_type)
MODIFY  repos/genie-brain/package.json                     (add rlmx dep)

CREATE  repos/genie-brain/src/lib/brain/link.test.ts
CREATE  repos/genie-brain/src/lib/brain/moc.test.ts
CREATE  repos/genie-brain/src/lib/brain/decisions.test.ts
```
