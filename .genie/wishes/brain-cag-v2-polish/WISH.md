# Wish: brain-cag-v2-polish — Seamless CAG DX

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `brain-cag-v2-polish` |
| **Date** | 2026-04-09 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |
| **Repo** | /home/genie/workspace/repos/genie-brain |

## Summary

Brain CAG v2 core is shipped but requires manual orchestration: explicit `--strategy cag`, separate `brain cache --warmup`, cryptic failures when rlmx is missing. This wish adds the last 10% of DX polish — integrated warmup, rlmx auto-discovery with interactive install, and confidence-based cascade routing so users never need to type `--strategy cag`.

## Scope

### IN
- `brain update --warmup` flag that triggers cache warmup after indexing
- rlmx auto-discovery: detect missing rlmx, warn with install command, offer interactive auto-install
- Confidence-based cascade: RAG first, auto-retry with CAG if confidence < PARTIAL
- `cascadedFrom` field in SearchResult for trace recording

### OUT
- Domain auto-generation from content clustering (filed as khal-os/brain#162)
- Trace-based routing learning (filed as khal-os/brain#161)
- Changes to RAG strategy internals
- New LLM provider integrations
- UI/frontend changes
- Changes to rlmx itself

## Decisions

| Decision | Rationale |
|----------|-----------|
| `--warmup` opt-in flag | Avoids burning API credits on quick metadata updates |
| Interactive auto-install via `npm i -g` | Reduces friction for new users; non-interactive stays safe (warn only) |
| Confidence cascade (RAG→CAG) | Deterministic, uses existing scoring, no brittle query heuristics |
| One cascade max | Prevents loops, bounds latency at ~2.2s worst case |
| `cascadedFrom` trace field | Seeds future trace-based learning without building the full pipeline |

## Success Criteria

- [ ] `genie brain update --warmup` indexes then warms cache with cost confirmation
- [ ] `genie brain update` without flag behaves exactly as before
- [ ] `--strategy cag` without rlmx shows install prompt (interactive) or warning (non-interactive)
- [ ] RAG with confidence < PARTIAL auto-cascades to CAG when rlmx available
- [ ] RAG with confidence >= PARTIAL stays RAG (no cascade)
- [ ] SearchResult includes `cascadedFrom` when cascade occurred
- [ ] Traces record cascade events
- [ ] Typecheck clean (`npx tsc --noEmit`)

## Execution Strategy

### Wave 1 (parallel — all 3 groups are independent)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Integrated warmup flag on brain update |
| 2 | engineer | rlmx auto-discovery + interactive install |
| 3 | engineer | Confidence-based cascade routing |

## Execution Groups

### Group 1: Integrated Warmup

**Goal:** Add `--warmup` flag to `brain update` that triggers cache warmup after indexing.

**Deliverables:**
1. In `src/lib/execute.ts` (or wherever `brain update` is handled), add `--warmup` boolean option
2. After indexing completes, if `--warmup` passed: call `cache.estimate()` to show cost, prompt for confirmation (`process.stdout.isTTY` check), then call `cache.warmup()`
3. If not interactive, warmup proceeds without confirmation (trust the flag)

**Acceptance Criteria:**
- [ ] `brain update --warmup` indexes then shows cost estimate then warms
- [ ] `brain update` (no flag) has zero behavior change
- [ ] Non-interactive `brain update --warmup` skips confirmation prompt

**Validation:**
```bash
cd /home/genie/workspace/repos/genie-brain && npx tsc --noEmit
grep -n "warmup" src/lib/execute.ts && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 2: rlmx Auto-Discovery

**Goal:** Detect missing rlmx when CAG is selected and offer to install it.

**Deliverables:**
1. In `src/lib/strategies/cag.ts`, add `isRlmxAvailable()` async check (try dynamic import, return boolean)
2. In `search()` method, before attempting CAG: if rlmx unavailable AND `process.stdout.isTTY`, prompt "CAG requires rlmx. Install now? (y/n)" → run `npm i -g @automagik/rlmx` on yes
3. If non-interactive or install declined: log warning with manual install command, fall back to RAG results
4. If install fails (e.g. permissions): catch error, show `sudo npm i -g @automagik/rlmx` hint

**Acceptance Criteria:**
- [ ] CAG without rlmx in interactive mode shows install prompt
- [ ] CAG without rlmx in non-interactive mode warns and falls back to RAG
- [ ] After successful install, CAG proceeds normally
- [ ] Install failure shows sudo hint

**Validation:**
```bash
cd /home/genie/workspace/repos/genie-brain && npx tsc --noEmit
grep -n "isRlmxAvailable\|Install now" src/lib/strategies/cag.ts && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 3: Confidence-Based Cascade

**Goal:** Auto-retry with CAG when RAG returns low confidence, so users never need `--strategy cag`.

**Deliverables:**
1. In `src/lib/types.ts`, add `cascadedFrom?: string` field to `SearchResult`
2. In `src/lib/search.ts`, after RAG search completes: if `confidence.level` < PARTIAL AND strategy was not explicitly set AND CAG is registered AND rlmx is available → re-run with `strategy: "cag"`
3. Compare results: return whichever has higher confidence. Set `cascadedFrom: "rag"` on the result if cascade fired.
4. Guard: never cascade if strategy was explicitly passed (respect user choice). Max 1 cascade.
5. In `src/lib/traces.ts`, include `cascadedFrom` in trace record

**Acceptance Criteria:**
- [ ] Low-confidence RAG query auto-cascades to CAG
- [ ] High-confidence RAG query does NOT cascade
- [ ] Explicit `--strategy rag` never cascades (user override respected)
- [ ] `cascadedFrom: "rag"` present in cascaded SearchResult
- [ ] Trace records cascade event
- [ ] No cascade loop possible

**Validation:**
```bash
cd /home/genie/workspace/repos/genie-brain && npx tsc --noEmit
grep -n "cascadedFrom" src/lib/search.ts src/lib/types.ts src/lib/traces.ts && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

## QA Criteria

- [ ] `genie brain search "simple factual query"` returns RAG results (no cascade)
- [ ] `genie brain search "complex cross-doc synthesis"` cascades to CAG when rlmx available
- [ ] `genie brain update --warmup` full pipeline works end-to-end
- [ ] Existing `brain search` without any flags behaves identically for high-confidence queries
- [ ] `brain cache --status` still works independently

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Cascade doubles latency on low-confidence queries | Medium | Only fires below PARTIAL; ~2.2s total is acceptable |
| `npm i -g` may need sudo | Low | Catch error, show sudo hint |
| rlmx SDK import slow first time | Low | Dynamic import, cached after first load |
| Confidence threshold too aggressive/lenient | Medium | Use existing PARTIAL threshold; tunable via config later |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/execute.ts          # Group 1 — add --warmup flag to update handler
src/lib/strategies/cag.ts   # Group 2 — isRlmxAvailable() + install prompt
src/lib/search.ts           # Group 3 — confidence cascade logic
src/lib/types.ts            # Group 3 — cascadedFrom field on SearchResult
src/lib/traces.ts           # Group 3 — record cascade in trace
```
