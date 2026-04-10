# Wish: brain-cag — CAG Mode + Provider Caching

| Field | Value |
|-------|-------|
| **Status** | DRAFT (blocked by rlmx v0.3) |
| **Slug** | `brain-cag` |
| **Date** | 2026-03-26 |
| **depends-on** | `brain-obsidian` (Phase 1 must ship first), `rlmx-v03` |
| **blocks** | `brain-optimizer` |

## Summary

Add CAG (Context-Augmented Generation) as a retrieval strategy to `genie brain search`. Instead of returning chunks (RAG), select and load whole relevant files as LLM context. Leverage rlmx v0.3's `--cache` flag for provider-level prompt caching (Anthropic 90% off, OpenAI 50% off). Auto-warm cache on `genie brain update`. Strategy router reads `brain_strategy_config` to auto-select RAG vs CAG.

## Scope

### IN
- `genie brain search --strategy cag` → rlmx `--cache --max-iterations 1` (one-shot CAG)
- Hierarchical file pruning: LLM scans directory tree → picks relevant dirs → picks files (from RepoMind pattern)
- Provider cache warmup on `genie brain update` (auto-warm changed brains)
- Cache hit/miss tracking in `brain_query_traces`
- Strategy router: reads `brain_strategy_config`, auto-picks RAG vs CAG
- Cost comparison in traces: "RAG cost: $0.003 | CAG would have cost: $0.0004"
- `genie brain search --explain` shows cache status + cost savings
- Query→selection cache: same query pattern → skip file selection (brain_query_cache or in strategy_config)

### OUT
- Strategy optimizer agent (Phase 3)
- A/B testing (Phase 3)
- Auto-approve strategy changes (Phase 3)

## Success Criteria
- [ ] `genie brain search "query" --strategy cag` returns full-context answer
- [ ] Provider cache reduces cost by ≥50% on repeated queries
- [ ] `genie brain update` auto-warms cache for registered brains
- [ ] Traces show cache_hit, cost savings
- [ ] Strategy router auto-selects CAG for patterns configured in brain_strategy_config
