# Wish: brain-optimizer — Self-Enhancing Strategy Agent

| Field | Value |
|-------|-------|
| **Status** | DRAFT (blocked by brain-cag + 500 traces) |
| **Slug** | `brain-optimizer` |
| **Date** | 2026-03-26 |
| **depends-on** | `brain-cag` (CAG must be live), 500+ traces in brain_query_traces |
| **blocks** | none (this is the endgame) |

## Summary

Build an async agent that consumes brain_query_traces, analyzes which retrieval strategies work best for which query patterns, and proposes strategy tweaks via brain_strategy_config. The agent optimizes for accuracy first, then speed, then cost. It can auto-approve low-risk changes (cache switches) and requires human approval for high-risk changes (strategy flips on critical patterns).

## Scope

### IN
- Async agent: `genie spawn optimizer` or `genie brain optimize`
- Trace analysis: group queries by pattern, compare strategy performance
- A/B testing: every Nth query, silently try alternative strategy, compare
- File affinity scores: which documents are ALWAYS selected for which topics → pre-cache
- Strategy proposals: write to brain_strategy_config with proposed_by='agent', approved=false
- Auto-approve: low-risk changes (switching repeated queries to cache) auto-approved
- Human approval: high-risk changes surface in `genie brain strategy proposals`
- Cost trajectory: weekly report showing cost-per-query trending down
- `genie brain strategy proposals` — list pending agent proposals
- `genie brain strategy approve/reject <id>` — human decision

### OUT
- Real-time strategy selection (that's the router in brain-cag)
- LLM fine-tuning
- External analytics dashboards

## The Agent's Analysis Loop
```
1. Pull all traces from last 7 days
2. Group by query pattern (cluster similar queries by embedding similarity)
3. For each pattern:
   a. Compare strategy performance:
      - Accuracy proxy = acceptance rate (not retried within 5 min)
      - Speed = average latency
      - Cost = average cost_cents
   b. Rank: accuracy first, then speed (tiebreaker), then cost (tiebreaker)
4. If alternative strategy beats current on accuracy AND (speed OR cost):
   a. Create proposal in brain_strategy_config (proposed_by='agent')
   b. If confidence > 0.9 AND pattern is low-risk (e.g. cache switch): auto-approve
   c. Otherwise: flag for human review
5. Update file affinity scores (which docs are always selected for pattern X)
6. Warm cache for high-affinity file sets
7. Report: "3 improvements proposed. Expected: +12% acceptance, -$2.40/week"
```

## Success Criteria
- [ ] Agent runs, analyzes 500+ traces, produces strategy proposals
- [ ] Proposals include: pattern, current strategy, proposed strategy, evidence, expected improvement
- [ ] Auto-approved changes show measurable improvement in next week's traces
- [ ] Cost per query trends downward over 4 weeks
- [ ] Acceptance rate trends upward over 4 weeks
- [ ] `genie brain status` shows optimization trajectory
