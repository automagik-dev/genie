# Wish: rlmx v0.4.0 — Gemini 3 Native Integration

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `rlmx-v04-gemini3` |
| **Date** | 2026-03-26 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |
| **Repo** | `/home/genie/research/rlmx/` (github: `namastex888/rlmx`) |

## Prerequisites

- [ ] rlmx v0.3.0 merged to dev (PR #8 — done)
- [ ] Gemini API key with access to `gemini-3.1-flash-lite-preview`
- [ ] Verify pi/ai handles thought signatures — spike before Wave 1

## Summary

Integrate all 14 Gemini 3 native features into rlmx, making it the most capable and cheapest context agent available. Add `gemini:` section to rlmx.yaml with thinking levels, Google Search grounding, URL context, server-side code execution, structured JSON output, media resolution control, thought signatures, Batch API, image generation, maps grounding, and file search. Effective cost: $0.0125/M tokens with caching + batch stacking. Non-Google providers: gemini section silently ignored, zero breakage.

## Scope

### IN

**Core (changes the reasoning loop):**
1. **Thinking levels** — `--thinking minimal|low|medium|high` flag + `gemini.thinking-level` YAML config
2. **Thought signatures** — circulate across RLM iterations for multi-turn quality
3. **Structured outputs** — `output.schema` in YAML enforces JSON via API, not text parsing

**New REPL capabilities (Gemini-powered batteries):**
4. **Google Search grounding** — `web_search(query)` battery, real-time web in REPL
5. **URL Context** — `fetch_url(url)` battery, pull live web pages into REPL
6. **Server-side Code Execution** — complementary tool for compute-heavy tasks (charts, data processing)
7. **Image Generation** — `generate_image(prompt)` battery via Nano Banana

**Optimization:**
8. **Media resolution control** — `gemini.media-resolution` per type (images, pdfs, video)
9. **Batch API** — `rlmx batch --batch-api` for 50% off bulk operations
10. **Context caching** — already in v0.3, confirmed working on Gemini 3

**Future-ready flags (opt-in, minimal implementation):**
11. **Computer Use** — flag only, implementation deferred
12. **Maps Grounding** — opt-in for location-aware research
13. **File Search** — opt-in for server-side document search
14. **Function Calling + Built-in Tools combo** — hybrid tool system in one API call

**Infrastructure:**
15. **`gemini:` section in rlmx.yaml** — all features configurable, provider-namespaced
16. **Graceful degradation** — non-Google providers ignore gemini section silently
17. **pi/ai onPayload hooks** — inject Gemini-specific params without forking pi/ai

### OUT
- No Gemini-only mode — rlmx stays multi-provider via pi/ai
- No removal of local Python REPL — Gemini code execution complements, doesn't replace
- No direct @google/genai SDK calls — everything through pi/ai (onPayload hooks)
- No breaking changes to v0.3 API — all features additive and opt-in
- No Computer Use implementation — flag only for v0.4, full implementation v0.5+

## Decisions

| Decision | Rationale |
|----------|-----------|
| All 14 features in one release | Mostly config/passthrough. Low risk per feature. Coherent "Gemini 3 native" story. |
| `gemini:` namespace in YAML | Provider-specific features belong in provider section. Clean separation from core. |
| Graceful degradation | rlmx is multi-provider. Gemini features enhance, never gate-keep. |
| onPayload hooks for injection | pi/ai abstraction preserved. No fork. |
| Local REPL stays primary | Persistent state, custom tools, llm_query — Gemini code exec can't do these. |
| Thought signatures top priority | Directly impacts RLM loop quality at iteration 5+. Must verify or implement. |
| Structured output via API schema | More reliable than FINAL() text parsing. Falls back to text on non-Google. |
| web_search/fetch_url as batteries | Available in REPL code via standard battery pattern. LLM decides when to use them. |
| Temperature stays at 1.0 | Gemini 3 docs: "strongly recommend keeping at default 1.0". Changing degrades reasoning. |

## Success Criteria

### Thinking Levels
- [ ] `--thinking minimal` produces fewer output tokens than `--thinking high` (verified in stats)
- [ ] `gemini.thinking-level` in YAML applied when provider is google
- [ ] Non-Google provider: `--thinking` flag silently ignored

### Thought Signatures
- [ ] pi/ai thought signature handling verified OR manual circulation implemented
- [ ] Query at iteration 10 correctly references facts established at iteration 1
- [ ] Multi-turn quality benchmark: same question at iter 1 vs iter 10 produces consistent quality

### Structured Output
- [ ] `output.schema` in YAML enforces JSON matching schema from API
- [ ] Invalid schema in YAML produces clear parse error
- [ ] Non-Google provider: falls back to FINAL() text parsing

### Google Search
- [ ] `web_search("rlmx npm version")` returns real results inside REPL code
- [ ] Results include search snippets usable by the LLM
- [ ] Non-Google provider: `web_search()` returns clear error message

### URL Context
- [ ] `fetch_url("https://example.com")` returns page content in REPL
- [ ] Non-Google provider: clear error message

### Code Execution
- [ ] `gemini.code-execution: true` enables server-side Python
- [ ] Model generates matplotlib chart via server-side execution
- [ ] Local REPL still works alongside server-side execution

### Image Generation
- [ ] `generate_image("architecture diagram")` returns image via Nano Banana
- [ ] Image saved to output path

### Media Resolution
- [ ] `gemini.media-resolution.images: high` produces ~1120 tokens per image (verified in stats)
- [ ] `gemini.media-resolution.pdfs: medium` produces ~560 tokens per page
- [ ] `gemini.media-resolution.video: low` produces ~70 tokens per frame

### Batch API
- [ ] `rlmx batch --batch-api` processes questions via Gemini Batch API
- [ ] Stats show 50% cost reduction vs per-request pricing
- [ ] Cache + batch stacking verified: < $2 for 100 queries over 500K context

### Config
- [ ] `gemini:` section parsed from rlmx.yaml with all 14 feature flags
- [ ] `rlmx init` scaffolds gemini section with commented defaults
- [ ] Non-Google provider: entire gemini section silently ignored

### Integration
- [ ] All Gemini tools available simultaneously: web_search + fetch_url + code_execution + custom functions in one RLM loop
- [ ] Stats report which Gemini features were used per run
- [ ] pi/ai onPayload hooks inject all params correctly

## Execution Strategy

### Wave 0 (spike — before implementation)
| Group | Agent | Description |
|-------|-------|-------------|
| 0 | engineer | pi/ai verification spike: thought signatures, onPayload for thinking_level/media_resolution/tools |

### Wave 1 (parallel — core reasoning)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Thinking levels: --thinking flag, YAML config, pi/ai passthrough |
| 2 | engineer | Thought signatures: verify pi/ai, implement manual circulation if needed |
| 3 | engineer | Structured outputs: output.schema in YAML, API enforcement, fallback |

### Wave 2 (parallel — Gemini batteries)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | web_search() + fetch_url() batteries with Google Search/URL Context tools |
| 5 | engineer | Server-side code execution: complementary tool, chart generation |
| 6 | engineer | Image generation: generate_image() via Nano Banana, media resolution config |

### Wave 3 (parallel — optimization + config)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Batch API: --batch-api flag, 50% cost reduction, cache+batch stacking |
| 8 | engineer | YAML config: gemini section, graceful degradation, rlmx init scaffold |
| 9 | engineer | Future flags: computer-use, maps, file-search (flag stubs + docs) |

### Wave 4 (ship)
| Group | Agent | Description |
|-------|-------|-------------|
| 10 | engineer | Tests: all 14 features, Gemini-specific + graceful degradation |
| 11 | engineer | Docs: README Gemini 3 section, cost comparison table, examples |
| review | reviewer | Review all groups against criteria |

## Execution Groups

### Group 0: pi/ai Verification Spike
**Goal:** Determine what pi/ai handles natively vs what rlmx must implement.

**Deliverables:**
1. **Spike report** — test each Gemini 3 feature through pi/ai:
   - Does `completeSimple()` accept/pass `thinkingLevel`?
   - Does pi/ai circulate `thoughtSignature` in multi-turn?
   - Does `onPayload` hook let us inject `google_search`, `url_context`, `code_execution` tools?
   - Does pi/ai pass `media_resolution` to Google provider?
   - Does pi/ai support `response_json_schema` for structured output?
2. **Gap list** — features needing rlmx-side implementation vs passthrough

**Acceptance Criteria:**
- [ ] Each of 14 features categorized: "pi/ai native" or "needs rlmx implementation"
- [ ] Working code snippet for each native feature
- [ ] onPayload hook verified for non-native features

**Validation:**
```bash
cd /home/genie/research/rlmx && node -e "const {getModel} = require('@mariozechner/pi-ai'); const m = getModel('google','gemini-3.1-flash-lite-preview'); console.log(m ? 'PASS' : 'FAIL')"
```

**depends-on:** none

---

### Group 1: Thinking Levels
**Goal:** Expose Gemini 3 thinking level control as rlmx flag and YAML config.

**Note:** Implementation depends on Group 0 verification of pi/ai `thinkingLevel` parameter support. If Group 0 determines pi/ai doesn't pass this natively, use onPayload hook as fallback.

**Deliverables:**
1. **`src/cli.ts`** — `--thinking minimal|low|medium|high` flag
2. **`src/config.ts`** — parse `gemini.thinking-level` from YAML
3. **`src/llm.ts`** — pass thinking level via pi/ai options or onPayload hook
4. **`src/output.ts`** — include thinking level in stats

**Acceptance Criteria:**
- [ ] `--thinking low` produces fewer tokens than `--thinking high`
- [ ] YAML config applied when flag not provided
- [ ] Non-Google: silently ignored

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && \
echo "2+2" | node dist/cli.js --thinking low --stats --output json 2>/tmp/low.json && \
echo "2+2" | node dist/cli.js --thinking high --stats --output json 2>/tmp/high.json && \
LOW_TOKENS=$(jq '.stats.output_tokens' /tmp/low.json) && \
HIGH_TOKENS=$(jq '.stats.output_tokens' /tmp/high.json) && \
test $LOW_TOKENS -lt $HIGH_TOKENS && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 0 (spike determines implementation path)

---

### Group 2: Thought Signatures
**Goal:** Ensure RLM iteration quality doesn't degrade across turns.

**Note:** Implementation depends on Group 0 verification of pi/ai `thoughtSignature` circulation. If Group 0 determines pi/ai doesn't handle this natively, implement manual circulation in `src/rlm.ts`.

**Deliverables:**
1. **`src/llm.ts`** — store thoughtSignature from responses, replay in next request
2. **`src/rlm.ts`** — message history includes signatures across iterations
3. If pi/ai handles natively: document and verify. If not: manual circulation.

**Acceptance Criteria:**
- [ ] Thought signatures present in API requests at iteration 5+
- [ ] Quality benchmark: iter 10 answer references iter 1 facts correctly
- [ ] No 400 errors from missing signatures

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && \
rlmx "Count from 1 to 5, one number per iteration" --context ./src/ --max-iterations 5 --output json --stats 2>/tmp/signatures.json && \
python3 -c "import sys,json; r=json.load(open('/tmp/signatures.json')); sig_found = any('thoughtSignature' in str(m) for m in r.get('message_history',[])); print('PASS' if sig_found and r.get('iterations',0) >= 3 else 'FAIL')"
```

**depends-on:** Group 0

---

### Group 3: Structured Outputs
**Goal:** Guarantee valid JSON output via API schema enforcement.

**Note:** Implementation depends on Group 0 verification of pi/ai `response_json_schema` support. If not native, use onPayload hook to inject schema parameter.

**Deliverables:**
1. **`src/config.ts`** — parse `output.schema` from YAML (JSON Schema object)
2. **`src/llm.ts`** — pass `response_json_schema` and `response_mime_type: "application/json"` via onPayload
3. **`src/output.ts`** — when schema active, skip FINAL() text parsing, use API response directly
4. **`src/rlm.ts`** — on final iteration with schema, model output IS the structured answer

**Acceptance Criteria:**
- [ ] With schema: output always valid JSON matching schema
- [ ] Without schema: current FINAL() behavior preserved
- [ ] Non-Google: falls back to FINAL() parsing, no error

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && echo "What is 2+2?" | node dist/cli.js --output json 2>/dev/null | python3 -c "import sys,json; r=json.load(sys.stdin); print('PASS' if 'answer' in r else 'FAIL')"
```

**depends-on:** Group 0

---

### Group 4: Google Search + URL Context Batteries
**Goal:** REPL code can search the web and fetch URLs mid-reasoning.

**Note:** Implementation depends on Group 0 verification of pi/ai `google_search` and `url_context` tool injection via onPayload hook. If verification fails, may require custom pi/ai fork or direct SDK calls (escalate to PM).

**Deliverables:**
1. **`python/gemini_batteries.py`** — Gemini-powered batteries:
   - `web_search(query)` — sends Google Search grounding request, returns results
   - `fetch_url(url)` — sends URL Context request, returns page content
   - Both use IPC to parent Node.js which calls pi/ai with appropriate tools
2. **`src/ipc.ts`** — new IPC message types: `web_search_request`, `url_context_request`
3. **`src/repl.ts`** — handle new IPC types, route to pi/ai with google_search/url_context tools
4. **`src/llm.ts`** — onPayload hook to inject google_search and url_context tools when requested

**Acceptance Criteria:**
- [ ] `web_search("npm rlmx")` returns search results in REPL
- [ ] `fetch_url("https://example.com")` returns page content
- [ ] Non-Google: both functions return clear error "requires provider: google"
- [ ] Stats track web_search and fetch_url calls
- [ ] Function calling + built-in tools tested together: web_search result fed to custom tool processing

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && \
rlmx "Use web_search to find what version of nodejs is latest" --tools standard --thinking low --max-iterations 2 --output json --stats 2>/tmp/websearch.json && \
python3 -c "import sys,json; r=json.load(open('/tmp/websearch.json')); web_called = any('web_search' in str(t) for t in r.get('tool_calls',[])); stats_track = r.get('stats',{}).get('web_search_calls',0) > 0; print('PASS' if web_called or stats_track else 'FAIL')"
```

**depends-on:** Group 0, Group 1 (thinking level for cost control during web calls)

---

### Group 5: Server-Side Code Execution
**Goal:** Enable Gemini's native Python execution as complementary tool for compute-heavy tasks.

**Note:** Implementation depends on Group 0 verification of pi/ai `code_execution` tool support and response field parsing (`executableCode`, `codeExecutionResult`). If pi/ai lacks this, implement custom response handler in `src/rlm.ts`.

**Deliverables:**
1. **`src/llm.ts`** — onPayload hook to add `code_execution` tool when `gemini.code-execution: true`
2. **`src/rlm.ts`** — detect `executableCode` and `codeExecutionResult` in responses, feed back into loop
3. **`src/output.ts`** — track server-side execution in stats

**Acceptance Criteria:**
- [ ] With `gemini.code-execution: true`: model can generate and execute Python server-side
- [ ] Local REPL still works alongside (not replaced)
- [ ] Stats differentiate local vs server-side executions
- [ ] Function calling + built-in tools combo tested: code_execution tool called alongside custom functions

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && \
rlmx "Calculate fibonacci(20) using code" --thinking medium --max-iterations 3 --output json --stats 2>/tmp/fibcode.json && \
python3 -c "import sys,json; r=json.load(open('/tmp/fibcode.json')); has_result = '6765' in r.get('answer',''); exec_tracked = r.get('stats',{}).get('code_executions',{}).get('server_side',0) > 0; print('PASS' if has_result and exec_tracked else 'FAIL')"
```

**depends-on:** Group 0

---

### Group 6: Image Generation + Media Resolution
**Goal:** Generate images via Nano Banana and control media token costs.

**Note:** Image generation requires Nano Banana credentials (separate from Gemini API). Media resolution depends on Group 0 verification of pi/ai `media_resolution` parameter support via onPayload hook.

**Deliverables:**
1. **`python/gemini_batteries.py`** additions:
   - `generate_image(prompt, aspect_ratio="16:9", size="2K")` — IPC to parent, calls Nano Banana
2. **`src/config.ts`** — parse `gemini.media-resolution` (images, pdfs, video)
3. **`src/llm.ts`** — onPayload hook to set media_resolution per content type
4. **`src/repl.ts`** — handle image generation IPC, save returned image

**Acceptance Criteria:**
- [ ] `generate_image("simple diagram")` produces an image file
- [ ] Media resolution config changes token count (verified in stats)
- [ ] Non-Google: generate_image returns clear error

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && node -e "console.log('PASS')" # Image gen requires Nano Banana model — validated manually
```

**depends-on:** Group 0

---

### Group 7: Batch API Integration
**Goal:** Use Gemini Batch API for 50% cost reduction on bulk operations.

**Note:** Implementation depends on Group 0 verification of pi/ai support for Batch API endpoint, or requires direct Gemini API calls. Coordination required with Group 0 on fallback approach.

**Deliverables:**
1. **`src/batch.ts`** modifications — detect `--batch-api` flag, route to Gemini Batch API
2. **`src/llm.ts`** — batch submission endpoint, async result polling
3. **`src/output.ts`** — batch stats: per-question cost, batch discount, total savings

**Acceptance Criteria:**
- [ ] `rlmx batch --batch-api` uses Gemini Batch API (verified in stats)
- [ ] Cost shows ~50% discount vs per-request
- [ ] Cache + batch stacking: < $2 for 100 queries over 500K context

**Validation:**
```bash
cd /home/genie/research/rlmx && echo -e "What is 2+2?\nWhat is 3+3?" > /tmp/batch-test.txt && npm run build && node dist/cli.js batch /tmp/batch-test.txt --batch-api --cache --output json --max-iterations 1 | wc -l | xargs test 3 -eq && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 0, v0.3 batch command

---

### Group 8: YAML Config + Graceful Degradation
**Goal:** Full `gemini:` section in rlmx.yaml with silent degradation on non-Google providers.

**Deliverables:**
1. **`src/config.ts`** — parse full `gemini:` section (all 14 flags)
2. **`src/scaffold.ts`** — include commented `gemini:` section in `rlmx init`
3. **`src/llm.ts`** — provider check: only apply gemini features when `provider === "google"`
4. **Error handling** — non-Google: ignore gemini section. Gemini battery on non-Google: clear error message.

**Acceptance Criteria:**
- [ ] All gemini flags parsed from YAML
- [ ] `rlmx init` includes gemini section with comments
- [ ] Anthropic provider: gemini section ignored, no errors
- [ ] Gemini battery on Anthropic: "web_search() requires provider: google"

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && node dist/cli.js init --dir /tmp/gemini-test && grep -q "gemini:" /tmp/gemini-test/rlmx.yaml && grep -q "thinking-level" /tmp/gemini-test/rlmx.yaml && echo "PASS" || echo "FAIL"
```

**depends-on:** Groups 1-7 (all features must exist to configure)

---

### Group 9: Future Flags
**Goal:** Stub flags for Computer Use, Maps Grounding, File Search — minimal implementation, ready for v0.5.

**Deliverables:**
1. **`src/config.ts`** — parse `gemini.computer-use`, `gemini.maps-grounding`, `gemini.file-search`
2. **Docs** — brief description of each in README
3. **Error handling** — if enabled: "gemini.computer-use is planned for v0.5"

**Acceptance Criteria:**
- [ ] Flags parse without error
- [ ] Enabling produces informational message, not crash
- [ ] README documents as "coming soon"

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && echo "PASS"
```

**depends-on:** Group 8

---

### Group 10: Tests
**Goal:** Comprehensive test suite for all Gemini 3 features.

**Deliverables:**
1. **`tests/gemini-thinking.test.ts`** — thinking level passthrough + stats
2. **`tests/gemini-signatures.test.ts`** — thought signature circulation
3. **`tests/gemini-structured.test.ts`** — schema enforcement + fallback
4. **`tests/gemini-batteries.test.ts`** — web_search, fetch_url, generate_image
5. **`tests/gemini-code-exec.test.ts`** — server-side execution
6. **`tests/gemini-media.test.ts`** — media resolution config
7. **`tests/gemini-batch.test.ts`** — batch API integration
8. **`tests/gemini-config.test.ts`** — YAML parsing + graceful degradation
9. **`tests/gemini-integration.test.ts`** — all features active simultaneously + context caching from v0.3
10. **`tests/gemini-function-tools.test.ts`** — function calling + built-in tools combo (Feature 10)

**Acceptance Criteria:**
- [ ] All test files passing
- [ ] Graceful degradation tests: every feature on non-Google provider
- [ ] Integration test: web_search + code_execution + structured output in one run
- [ ] Function calling test: custom functions + Gemini built-in tools in same request
- [ ] Context caching test: cache behavior from v0.3 still functional with Gemini 3

**Validation:**
```bash
cd /home/genie/research/rlmx && npm test && echo "PASS" || echo "FAIL"
```

**depends-on:** Groups 1-9

---

### Group 11: Documentation
**Goal:** Comprehensive Gemini 3 docs and cost comparison.

**Deliverables:**
1. **`README.md`** — Gemini 3 Native section:
   - Feature overview with rlmx.yaml example
   - Cost comparison table (base vs cached vs batch vs stacked)
   - Per-feature usage guide
   - Provider compatibility matrix
2. **`examples/gemini-research/rlmx.yaml`** — web search + URL context research agent
3. **`examples/gemini-multimodal/rlmx.yaml`** — media resolution + image analysis
4. **`examples/gemini-cheap-batch/rlmx.yaml`** — maximum cost stacking example

**Acceptance Criteria:**
- [ ] README Gemini section covers all 14 features
- [ ] Cost comparison table accurate
- [ ] Examples valid and runnable

**Validation:**
```bash
cd /home/genie/research/rlmx && test -f examples/gemini-research/rlmx.yaml && test -f examples/gemini-multimodal/rlmx.yaml && test -f examples/gemini-cheap-batch/rlmx.yaml && grep -q "gemini" README.md && echo "PASS" || echo "FAIL"
```

**depends-on:** Groups 1-9

---

## QA Criteria

- [ ] `rlmx "query" --thinking high --context ./src/ --cache --stats` end-to-end with Gemini
- [ ] `web_search()` in REPL returns real results
- [ ] Structured output matches schema
- [ ] Thought signatures maintain quality at iteration 10+
- [ ] `rlmx batch --batch-api` cheaper than per-request (verified in stats)
- [ ] Non-Google provider: zero errors, all gemini features silently disabled
- [ ] All tests pass

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| pi/ai doesn't pass Gemini-specific params | High | Spike (Group 0) determines approach. onPayload hooks as fallback. |
| Gemini 3 is preview — API may change | High | Pin model version. Abstract behind YAML. Quick patch on change. |
| Thought signatures not in pi/ai | High | Group 0 spike. Manual circulation if needed. |
| Structured output conflicts with FINAL() | Medium | Schema mode skips FINAL() detection. Documented behavior. |
| web_search/fetch_url only on Google | Medium | Clear error on non-Google. Not silent failure. |
| Cost stacking assumptions wrong | Medium | Empirical validation in Group 7. Budget controls cap spending. |
| Too many features | Medium | Each independently toggleable. Test separately + integration. |
| Temperature must stay 1.0 | Low | Document. Don't expose temperature in rlmx.yaml for Gemini 3. |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
# Modified
src/cli.ts             — --thinking flag, --batch-api flag
src/config.ts          — gemini: section parsing, output.schema, media-resolution
src/llm.ts             — thinking level, thought signatures, onPayload hooks, batch API
src/rlm.ts             — thought signature circulation, server-side code execution handling
src/repl.ts            — web_search/fetch_url/generate_image IPC handlers
src/ipc.ts             — new IPC types for Gemini batteries
src/batch.ts           — --batch-api Gemini Batch API integration
src/output.ts          — Gemini feature stats, structured output handling
src/scaffold.ts        — gemini section in rlmx init
package.json           — version 0.4.0
README.md              — Gemini 3 Native section

# New
python/gemini_batteries.py  — web_search(), fetch_url(), generate_image()
src/gemini.ts               — Gemini-specific onPayload hooks, feature detection
tests/gemini-*.test.ts      — 9 test files
examples/gemini-*/rlmx.yaml — 3 example configs
```
