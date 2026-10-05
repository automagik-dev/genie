# Wish: rlmx v0.3.0 — CAG Mode + Provider Caching

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `rlmx-v03-cag` |
| **Date** | 2026-03-26 |
| **Design** | [DESIGN.md](../../brainstorms/rlmx-v02/DESIGN.md#v03-vision-cag--rlm-cache-augmented-generation) |
| **Repo** | `/home/genie/research/rlmx/` (github: `namastex888/rlmx`) |
| **Paper** | [arxiv:2412.15605](https://arxiv.org/abs/2412.15605) — "Don't Do RAG: When Cache-Augmented Generation is All You Need" |

## Prerequisites

- [ ] **rlmx v0.2.0 MUST be released to npm before v0.3 execution begins**
  - v0.2 provides: YAML config parsing, `--max-cost` budget, `--stats` output, `--log` observability, batteries, REPL hardening
  - Gate check: `npm view rlmx versions | grep 0.2`
  - v0.3 extends v0.2's YAML config with `cache:` section, extends v0.2's budget for batch, extends v0.2's stats with cache metrics

## Summary

Add `--cache` flag that bakes full context into the system prompt and enables provider-level caching (Anthropic prompt caching, OpenAI prefix caching, Bedrock cachePoint). Combined with `--max-iterations`, users dial between pure CAG (1-shot, cheapest) and full RLM (iterative REPL). First query pays full cost; subsequent queries against the same corpus cost 50-90% less. pi/ai already supports `cacheRetention` and `sessionId` — implementation is a mode switch, not a rewrite.

## Scope

### IN
- **`--cache` flag** — enables CAG mode: full context in system prompt + provider caching
- **Cache strategy in rlmx.yaml** — `cache:` section with enabled, strategy, session-prefix, retention, ttl, expire-time
- **Explicit TTL control** — per-provider TTL: `ttl: <seconds>` for explicit cache lifetimes, `expire-time: <ISO 8601>` for Google explicit expiry
- **Full context injection** — when `--cache` is on, put actual content (not just metadata) in system prompt
- **Content hashing** — stable `sessionId` derived from context content hash (same corpus = same cache)
- **Cache stats** — report cache hit/miss, tokens cached, tokens read from cache, cost savings
- **Batch query support** — `rlmx batch questions.txt --context ./docs/ --cache` for bulk interrogation
- **Cache warmup command** — `rlmx cache --context ./docs/` to pre-warm without a query
- **Provider-specific handling** — Anthropic (ephemeral + TTL), OpenAI (prompt_cache_key), Google (onPayload hook for explicit cachedContents)
- **Context size validation** — check if context fits provider's context window before caching, error with guidance if too large
- **Documentation** — README section on CAG mode, when to use --cache vs default, cost comparison

### OUT
- No local KV cache (PyTorch DynamicCache) — API providers only
- No custom cache eviction strategies — rely on provider TTL
- No persistent local cache index — cache lives at the provider
- No automatic cache invalidation on file changes — user controls via content hash
- No changes to the core RLM loop — `--cache` only changes what goes in the system prompt

## Decisions

| Decision | Rationale |
|----------|-----------|
| `--cache` as opt-in flag, not default | Paper RLM (externalized context) is the proven default. CAG is a different tradeoff — better for repeated queries, worse for single deep analysis. User chooses. |
| Full context in system prompt (CAG mode) | The whole point of CAG: LLM sees everything directly. No retrieval, no metadata indirection. Provider caches the system prompt. |
| Content hash for sessionId | Same corpus → same cache. Change a file → new hash → new cache. Deterministic, no state management. |
| Use pi/ai `cacheRetention` + `sessionId` | Already implemented in pi/ai v0.62. Anthropic, OpenAI, Bedrock work out of the box. No need to bypass pi/ai. |
| `onPayload` hook for Google explicit caching | Google's `cachedContents` API requires a 2-step pattern. pi/ai's `onPayload` hook lets us inject the `cachedContent` reference without forking pi/ai. |
| Batch command for bulk queries | The killer use case for CAG: cache once, ask 100 questions. Needs a dedicated batch interface, not just shell loops. |
| Context size validation before caching | Caching a 2M token corpus into a 200K context window fails silently and wastes money. Check first, error clearly. |

## Success Criteria

### Cache Flag
- [ ] `rlmx "query" --context ./docs/ --cache` puts full content in system prompt
- [ ] `rlmx "query" --context ./docs/ --cache --max-iterations 1` does pure CAG (one LLM call)
- [ ] `rlmx "query" --context ./docs/ --cache --max-iterations 5` does CAG + REPL reasoning
- [ ] Without `--cache`, behavior is unchanged (metadata only, paper RLM)
- [ ] Context also available in REPL `context` variable when `--cache` is on (both paths)

### Provider Caching
- [ ] Anthropic: `cache_control` with `cacheRetention: "long"` and 1h TTL
- [ ] OpenAI: `prompt_cache_key` with stable sessionId
- [ ] Google: `onPayload` hook injects `cachedContent` when explicit caching configured
- [ ] Bedrock: `cachePoint` with optional TTL
- [ ] Second query against same corpus shows cache hit in stats

### Session & Hashing
- [ ] Same `--context` directory with same files → same sessionId → cache hit
- [ ] Changed file in directory → different hash → new session → cache miss
- [ ] `cache.session-prefix` in rlmx.yaml prepended to hash

### Stats
- [ ] `--stats` includes `cache.enabled`, `cache.hit`, `cache.tokens_cached`, `cache.cost_savings`
- [ ] `--log` JSONL includes cache events per LLM call
- [ ] Cost calculation accounts for cache read/write pricing

### Batch
- [ ] `rlmx batch questions.txt --context ./docs/ --cache --output json` processes all questions
- [ ] First question caches, subsequent questions hit cache
- [ ] Output: one JSON per line (JSONL) with answer + stats per question
- [ ] `--max-cost` budget applies across entire batch

### Warmup
- [ ] `rlmx cache --context ./docs/` sends a warmup request to prime the cache
- [ ] Reports: context size (tokens), estimated cache cost, provider, TTL
- [ ] `rlmx cache --context ./docs/ --estimate` shows cost without actually caching

### Validation
- [ ] Context size check: error if context exceeds provider's context window
- [ ] Error message includes: context size, provider limit, suggestion to reduce

### Config
- [ ] `cache:` section in rlmx.yaml parsed and applied
- [ ] `--cache` flag overrides `cache.enabled: false` in YAML
- [ ] `cache.retention: short|long` mapped to pi/ai `cacheRetention`
- [ ] `cache.ttl: <seconds>` passed to providers that support explicit TTL (Anthropic, Google, Bedrock)
- [ ] `cache.expire-time: <ISO 8601>` used for Google explicit caching expiry
- [ ] Per-provider TTL behavior documented (Anthropic rounds to 300s/3600s, OpenAI informational only)

## Execution Strategy

### Wave 1 (parallel — core caching)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Cache mode: --cache flag, full context injection, content hashing, sessionId |
| 2 | engineer | Provider integration: cacheRetention/sessionId passthrough, Google onPayload hook |
| 3 | engineer | Cache stats: hit/miss tracking, cost savings calc, JSONL log events |

### Wave 2 (parallel — features)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Batch command: `rlmx batch` with JSONL output, shared cache, budget across batch |
| 5 | engineer | Cache warmup: `rlmx cache` command, --estimate flag, context size validation |
| 6 | engineer | Config + docs: YAML cache section, README CAG docs, examples |

### Wave 3 (ship)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Tests: cache mode, provider passthrough, hash stability, batch, warmup, stats |
| review | reviewer | Review all groups against criteria |

## Execution Groups

### Group 1: Cache Mode Core
**Goal:** Implement `--cache` flag that puts full context in system prompt with provider caching.

**Deliverables:**
1. **`src/rlm.ts` modifications** — CAG mode
   - When `--cache` enabled: build system prompt with FULL context content (not just metadata)
   - Context format in system prompt: preserve file paths + content, structured as document sections
   - Context ALSO injected into REPL `context` variable (dual access)
   - Respect `--max-iterations` — 1 = pure CAG, N = CAG + REPL reasoning

2. **`src/cache.ts`** — Cache utilities
   - `estimateTokens(context)` — character count / 4 with 20% safety margin for window validation
   - `computeContentHash(context)` — stable SHA256 of sorted file paths + contents
   - `buildSessionId(prefix, hash)` — `{prefix}-{hash}` for provider routing
   - `buildCachedSystemPrompt(config, context)` — system prompt with full context embedded
   - Context size estimation (token count approximation)

3. **`src/cli.ts` modifications** — `--cache` flag
   - Parse `--cache` boolean flag
   - Wire to rlm loop options

**Acceptance Criteria:**
- [ ] `--cache` puts full content in system prompt
- [ ] Same content produces same session hash
- [ ] `--max-iterations 1 --cache` = single LLM call, no REPL
- [ ] REPL `context` variable still available in cache mode

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && echo "test" | node dist/cli.js --cache --max-iterations 1 --output json 2>/dev/null | python3 -c "import sys,json; r=json.load(sys.stdin); print('PASS' if r.get('answer') else 'FAIL')"
```

**depends-on:** none (builds on v0.2 foundation)

---

### Group 2: Provider Integration
**Goal:** Pass caching parameters through pi/ai to each provider correctly, with explicit TTL control.

**Deliverables:**
1. **`src/llm.ts` modifications** — Add cacheRetention + sessionId + TTL to completeSimple calls
   - When cache enabled: pass `cacheRetention: config.cache.retention` and `sessionId`
   - When cache disabled: omit (current behavior)
   - Track cache usage from pi/ai response: `cacheRead`, `cacheWrite` tokens
   - **Per-provider TTL handling:**
     - **Anthropic**: Pass `ttl` (in seconds) via `cache_control` header. Anthropic rounds to 300s or 3600s increments. Store actual TTL returned in response headers.
     - **OpenAI**: `ttl` is informational only (OpenAI doesn't support explicit TTL yet). Document in logs.
     - **Google**: Pass `ttl` and `expire-time: <ISO 8601>` when using explicit caching (cachedContents API). Respect Google's 1h-24h range or error if out of bounds.
     - **Bedrock**: Pass `ttl` via `cachePoint` configuration if supported by model.

2. **`src/providers/google-cache.ts`** — Google explicit caching (OPTIONAL for v0.3 MVP)
   - Use `onPayload` hook to inject `cachedContent` reference
   - Optional: manage `cachedContents` resource lifecycle (create, reference, delete)
   - **MVP**: implicit caching works without setup (repeated prefixes cached automatically)
   - **Stretch**: explicit caching via onPayload if pi/ai hook supports it
   - Spike task: verify pi/ai `onPayload` hook works with Google `cachedContents` API before implementing

3. **`docs/TTL_CONTROL.md`** — Provider-specific TTL behavior documentation
   - Document each provider's TTL semantics: what values are accepted, rounding behavior, defaults
   - Anthropic: TTL rounds to 300s (5min) or 3600s (1h), default long = 3600s
   - OpenAI: No explicit TTL support, prompt_cache_key is stable identifier only
   - Google: Explicit caching requires 1h-24h ISO 8601 expiry, implicit caching uses API defaults
   - Bedrock: Check docs for cachePoint TTL support per model
   - Example: user sets ttl: 1800, provider rounds/rejects accordingly

**Acceptance Criteria:**
- [ ] Anthropic calls include `cache_control` with correct TTL, respecting rounding
- [ ] OpenAI calls include `prompt_cache_key` with sessionId (no TTL field)
- [ ] Google calls inject `cachedContent` via onPayload when configured, with expire-time if set
- [ ] Bedrock cachePoint includes TTL if model supports it
- [ ] Cache usage (read/write tokens) captured from provider response
- [ ] Per-provider TTL behavior documented and tested

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && \
echo "test" | ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY node dist/cli.js --cache --stats --output json 2>/tmp/stats.txt && \
grep -q "cache" /tmp/stats.txt && \
grep -q "ttl\|cache_control" /tmp/stats.txt && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1 (cache mode must exist)

**Provider TTL Testing (per-provider validation):**
- Anthropic: Set `cache.ttl: 1800` in rlmx.yaml, verify Anthropic response includes cache_control with rounded TTL
- OpenAI: Set `cache.ttl: 1800`, verify no TTL field in OpenAI request (documented as informational)
- Google: Set `cache.expire-time: "2026-03-27T12:00:00Z"`, verify cachedContents expiry matches

---

### Group 3: Cache Stats
**Goal:** Report cache hit/miss, tokens cached, and cost savings in observability output.

**Deliverables:**
1. **`src/output.ts` modifications** — Cache stats in --stats output
   - `cache.enabled`, `cache.hit`, `cache.tokens_cached`, `cache.tokens_read`, `cache.cost_savings`
   - Cost savings = (normal_input_cost - cache_read_cost)

2. **`src/logger.ts` modifications** — Cache events in JSONL
   - `type: "cache_init"` — context hash, session ID, estimated tokens
   - `type: "cache_hit"` / `type: "cache_miss"` — per LLM call
   - Include cache read/write tokens in `llm_call` events
   - Provider-specific notes: Anthropic reliably returns `cache_read_input_tokens` / `cache_creation_input_tokens`. OpenAI returns `cached_tokens` in `prompt_tokens_details`. If provider doesn't report cache tokens, log as `"cache_tokens": "unknown"` — don't fabricate numbers.

**Acceptance Criteria:**
- [ ] `--stats` shows cache block when `--cache` is used
- [ ] `--log` includes cache events
- [ ] Cost calculation reflects cache pricing (not base pricing)

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && echo "test" | node dist/cli.js --cache --stats --output json 2>&1 | grep -q "cache" && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1, Group 2

---

### Group 4: Batch Command
**Goal:** `rlmx batch` for bulk interrogation against a cached corpus.

**Deliverables:**
1. **`src/batch.ts`** — Batch processing engine
   - Read questions from file (one per line) or JSON array
   - Share cached context across all questions
   - Output format: JSONL to stdout — one JSON per question, final line is aggregate stats
     ```jsonl
     {"question":"What is IPC?","answer":"...","stats":{...}}
     {"question":"How do plugins work?","answer":"...","stats":{...}}
     {"type":"aggregate","total_questions":2,"total_cost":0.012,"cache_savings":0.045}
     ```
   - Integrate with v0.2's `--max-cost` budget: track cumulative cost across entire batch
   - Stop batch when budget exceeded, report how many questions completed

2. **`src/cli.ts` modifications** — `rlmx batch` subcommand
   - `rlmx batch questions.txt --context ./docs/ --cache --output json`
   - `--max-cost` applies to total batch (extends v0.2's budget system for batch context)
   - `--parallel N` for concurrent questions (default: 1, sequential)

**Acceptance Criteria:**
- [ ] `rlmx batch questions.txt --context ./docs/ --cache` processes all questions
- [ ] First question triggers cache, rest hit cache
- [ ] JSONL output: one JSON per question
- [ ] `--max-cost` stops batch when budget exceeded
- [ ] Aggregate stats at end: total questions, total cost, cache savings

**Validation:**
```bash
cd /home/genie/research/rlmx && echo -e "What is 2+2?\nWhat is 3+3?" > /tmp/qs.txt && npm run build && node dist/cli.js batch /tmp/qs.txt --cache --output json --max-iterations 1 | wc -l | xargs test 3 -eq && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1, Group 2 (cache must work)

---

### Group 5: Cache Warmup + Validation
**Goal:** `rlmx cache` command to pre-warm cache and validate context fits.

**Deliverables:**
1. **`src/cli.ts` modifications** — `rlmx cache` subcommand
   - `rlmx cache --context ./docs/` — send warmup request, prime the cache
   - `rlmx cache --context ./docs/ --estimate` — show size + cost without caching
   - Report: context size (chars, est. tokens), provider, TTL, estimated cost

2. **`src/cache.ts` additions** — Context size validation
   - Estimate token count from character count (heuristic: chars / 4)
   - Check against provider context window limits
   - Error with guidance if too large: "Context is ~150K tokens, provider limit is 128K. Reduce with context.exclude or split into collections."

**Acceptance Criteria:**
- [ ] `rlmx cache --context ./docs/` primes the cache
- [ ] `rlmx cache --context ./docs/ --estimate` shows stats without caching
- [ ] Context exceeding window produces clear error with size info
- [ ] Reports: token estimate, provider, TTL, cost

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && node dist/cli.js cache --context ./src/ --estimate 2>&1 | grep -q "tokens" && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1

---

### Group 6: Config + Documentation
**Goal:** YAML cache section with TTL control and comprehensive documentation.

**Deliverables:**
1. **`src/config.ts` modifications** — Extend v0.2's YAML parser with cache section including TTL
   - Add `cache:` section parsing to existing rlmx.yaml loader (v0.2 already created YAML infrastructure)
   - Fields: `cache.enabled`, `cache.strategy`, `cache.session-prefix`, `cache.retention`, `cache.ttl`, `cache.expire-time`
   - Defaults: enabled=false, strategy=full, retention=long, ttl=null (use provider default), expire-time=null
   - **TTL parsing:** Convert ttl (seconds) to provider-specific format. Validate expire-time as ISO 8601.
   - **Validation:** If ttl is set, warn if outside provider's accepted range (e.g., Google: 1h-24h). If expire-time invalid, error.
   - **YAML schema example:**
     ```yaml
     cache:
       enabled: true
       retention: long           # short|long, maps to pi/ai cacheRetention
       ttl: 3600                # seconds, applies to Anthropic/Google/Bedrock
       expire-time: "2026-03-27T12:00:00Z"  # ISO 8601, for Google explicit caching
       session-prefix: "proj"   # prepended to content hash
     ```

2. **`src/scaffold.ts` modifications** — Add cache section to existing `rlmx init` template
   - Append commented-out `cache:` section to v0.2's scaffold template with all fields documented

3. **`README.md`** — CAG mode documentation
   - When to use `--cache` vs default
   - Cost comparison table (first query vs subsequent)
   - Batch usage patterns
   - Provider-specific notes and TTL behavior
   - Link to `docs/TTL_CONTROL.md` for detailed provider semantics

4. **`examples/cag-study/rlmx.yaml`** — Example: study mode (cache a paper, ask questions)
   - Include TTL configuration example: `ttl: 3600` (1 hour) for short-lived study session

5. **`examples/cag-batch/rlmx.yaml`** — Example: batch interrogation config
   - Include TTL configuration: `ttl: 1800` (30 min) to avoid unnecessary cache recreation during batch

**Acceptance Criteria:**
- [ ] `cache:` section with ttl and expire-time fields parsed from rlmx.yaml
- [ ] `rlmx init` includes all cache fields in commented-out scaffold
- [ ] README documents CAG mode and TTL control clearly
- [ ] Examples show TTL in realistic scenarios
- [ ] Config parser validates TTL ranges and ISO 8601 format
- [ ] Error messages guide users if TTL is out of bounds

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && \
node dist/cli.js init --dir /tmp/cache-test && \
grep -q "cache:" /tmp/cache-test/rlmx.yaml && \
grep -q "ttl:" /tmp/cache-test/rlmx.yaml && \
grep -q "expire-time:" /tmp/cache-test/rlmx.yaml && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1, Group 2 (TTL_CONTROL.md must exist)

---

### Group 7: Tests
**Goal:** Test suite for all cache-related features including TTL control.

**Deliverables:**
1. **`tests/cache.test.ts`** — Cache mode, hash stability, system prompt injection
2. **`tests/cache-stats.test.ts`** — Cache hit/miss reporting, cost savings
3. **`tests/batch.test.ts`** — Batch command, JSONL output, budget enforcement
4. **`tests/cache-validate.test.ts`** — Context size validation, provider limits
5. **`tests/cache-config.test.ts`** — YAML cache section parsing, TTL validation
   - Parse `cache.ttl` (seconds) and validate numeric type
   - Parse `cache.expire-time` and validate ISO 8601 format
   - Test TTL range validation per provider (e.g., Google: 1h-24h must error if < 3600 or > 86400)
6. **`tests/cache-ttl.test.ts`** — Per-provider TTL behavior
   - Anthropic: TTL rounds to 300s or 3600s increments; test that 1800 rounds to 3600
   - OpenAI: TTL is logged as informational; test that no TTL field is sent to OpenAI
   - Google: expire-time ISO 8601 validation; test invalid dates are rejected

**Acceptance Criteria:**
- [ ] All test files passing
- [ ] Hash stability: same content → same hash across runs
- [ ] Cache mode: full content in system prompt verified
- [ ] Batch: correct number of outputs, budget respected
- [ ] TTL parsing: numeric validation, ISO 8601 validation, range validation per provider
- [ ] Per-provider TTL: Anthropic rounds correctly, OpenAI omits TTL, Google validates expiry

**Validation:**
```bash
cd /home/genie/research/rlmx && npm test -- --grep "cache|ttl" 2>&1 | tail -10
```

**depends-on:** Group 1-6

---

## QA Criteria

- [ ] `rlmx "query" --cache --context ./docs/` works end-to-end with Anthropic
- [ ] Second query with same context shows cache savings in stats
- [ ] `rlmx batch` processes file of questions against cached corpus
- [ ] `rlmx cache --estimate` gives accurate size estimate
- [ ] Context too large for provider → clear error, not silent failure
- [ ] Default behavior (no --cache) unchanged from v0.2

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Context exceeds provider window | High | Size validation before caching, clear error with guidance |
| Provider cache evicted before next query | Medium | Document TTLs. `--cache` re-caches if miss. Stats show hit/miss. |
| Full context in system prompt degrades quality (lost-in-middle) | Medium | User controls: can fall back to default RLM mode. Benchmarkable via --stats. |
| pi/ai cacheRetention API changes | Low | Pin pi/ai version. Caching is a stable feature. |
| Google explicit caching requires extra setup | Low | Document. Implicit caching works without setup. |
| Batch with large corpus + many questions = expensive | Medium | `--max-cost` budget applies across batch. `--estimate` previews cost. |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
# Modified
src/cli.ts             — --cache flag, rlmx cache subcommand, rlmx batch subcommand
src/rlm.ts             — CAG mode system prompt, dual context injection
src/llm.ts             — cacheRetention + sessionId passthrough
src/config.ts          — parse cache: section from rlmx.yaml
src/scaffold.ts        — include cache section in rlmx init
src/output.ts          — cache stats in --stats output
src/logger.ts          — cache events in JSONL
src/context.ts         — token estimation for size validation
package.json           — version bump to 0.3.0
README.md              — CAG mode documentation

# New
src/cache.ts           — content hashing, sessionId generation, size validation, cached prompt builder
src/batch.ts           — batch processing engine
src/providers/google-cache.ts — Google explicit caching via onPayload hook
tests/cache.test.ts    — cache mode tests
tests/cache-stats.test.ts — cache stats tests
tests/batch.test.ts    — batch command tests
tests/cache-validate.test.ts — context size validation tests
tests/cache-config.test.ts — YAML cache config tests
examples/cag-study/rlmx.yaml — study mode example
examples/cag-batch/rlmx.yaml — batch interrogation example
```
