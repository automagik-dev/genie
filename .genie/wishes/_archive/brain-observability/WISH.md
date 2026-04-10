# Wish: brain-observability — Traces, Strategy, Budgets, Events

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `brain-observability` |
| **Date** | 2026-03-27 |
| **Parent** | [brain-obsidian](../brain-obsidian/WISH.md) |
| **depends-on** | `brain-foundation` |
| **blocks** | `brain-cag` (strategy routing needs traces), `brain-optimizer` (needs 500+ traces) |

## Summary

Self-enhancing retrieval infrastructure. Every brain query saves a trace (strategy used, latency, cost, accepted). Strategy switching handles let humans/agents configure which retrieval strategy works best per query pattern. Query cascade config (cheapest→expensive, stop early). Per-brain daily budgets (degrade gracefully, not hard fail). Brain events flow into existing events table. Brain metrics in agent heartbeat. Context quality scoring (freshness × relevance × authority × completeness). Implicit rejection detection.

**After this ships:** the brain records everything it does. The foundation for the self-improving brain is laid — traces accumulate, patterns emerge, the optimizer agent (brain-optimizer, future wish) can propose strategy tweaks.

## Scope

### IN
- Migration `004-brain-observability.sql`: brain_query_traces, brain_strategy_config. ALTER TABLE brains: add daily_query_budget_cents, daily_embed_budget_cents, budget_spent_cents, budget_reset_at, total_cost_cents, embedding_coverage
- `src/lib/brain/traces.ts` — trace recording on every search/analyze, querying, implicit rejection detection (same topic retry <5 min), purge (--older-than), export (csv)
- `src/lib/brain/strategy.ts` — strategy config CRUD, pattern matching, cascade_steps, min_confidence, max_step, switching handles CLI
- `genie brain traces` command — list, filter (--query, --strategy, --failed, --cost, --slow), --explain <id>, --purge, --export
- `genie brain strategy` command — set, rm, show, proposals (future agent proposals)
- Extend `search.ts` — --strategy override, --explain flag, trace recording, cascade execution (stop early when confident), context quality scoring in results
- Extend `status.ts` — trace stats (query count, acceptance rate, cost trend, strategy split, cache hits)
- Brain events → existing events table: brain.queried, brain.updated, brain.embedded, brain.healed, brain.linked, brain.decision, brain.conflict, brain.expired, brain.strategy_set
- Brain metrics in agent heartbeat JSON
- Per-brain daily budgets: degrade to BM25 (free) when exceeded
- `genie events --entity-type brain` and `genie events costs --entity-type brain` work
- `genie log --follow` includes brain events

### OUT
- CAG mode (brain-cag, depends on rlmx v0.3)
- Strategy optimizer agent (brain-optimizer, needs 500+ traces)
- A/B testing (brain-optimizer)

## Success Criteria

- [ ] Every `search` and `analyze` call writes to brain_query_traces
- [ ] `genie brain traces` lists recent with query, strategy, latency, cost, accepted
- [ ] `genie brain traces --failed` shows implicit rejections (same topic retry <5 min)
- [ ] `genie brain traces --purge --older-than 90d` works
- [ ] `genie brain strategy` shows current config per brain
- [ ] `genie brain strategy set "competitive*" rag --reason "..."` creates switching handle
- [ ] `genie brain strategy set --cascade exact,trigram,bm25,vector --min-confidence 0.8` works
- [ ] `genie brain search --strategy rag` overrides config
- [ ] `genie brain search --explain` shows: strategy chosen, cascade steps run, quality scores
- [ ] Search results include quality scoring (freshness × relevance × authority × completeness)
- [ ] Per-brain budget: exceeding degrades to BM25, not hard fail
- [ ] `genie brain status` includes: trace stats, budget status, strategy split, acceptance rate
- [ ] `genie events --entity-type brain` shows brain events
- [ ] `genie events costs --entity-type brain` shows brain costs
- [ ] Agent heartbeat includes brain metrics JSON
- [ ] `bun run check` passes

## Files to Create/Modify

```
CREATE  repos/genie-brain/src/db/migrations/004-brain-observability.sql
CREATE  repos/genie-brain/src/lib/brain/traces.ts
CREATE  repos/genie-brain/src/lib/brain/strategy.ts
MODIFY  repos/genie-brain/src/lib/brain/search.ts          (trace recording, cascade, quality scoring, --explain)
MODIFY  repos/genie-brain/src/lib/brain/status.ts          (trace stats, budget status)
MODIFY  repos/genie-brain/src/lib/brain/db.ts              (events integration)

CREATE  repos/genie-brain/src/lib/brain/traces.test.ts
CREATE  repos/genie-brain/src/lib/brain/strategy.test.ts
```
