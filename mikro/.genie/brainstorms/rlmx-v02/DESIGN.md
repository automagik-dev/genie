# Design: rlmx v0.2.0

| Field | Value |
|-------|-------|
| **Slug** | `rlmx-v02` |
| **Date** | 2026-03-26 |
| **WRS** | 100/100 |
| **Repo** | `/home/genie/research/rlmx/` (github: `namastex888/rlmx`) |

## Problem

rlmx v0.1.0 implements the RLM algorithm faithfully but can't be installed from npm, has zero tests, no observability, no budget controls, and forces users to manage 5 separate .md config files. It needs to ship as a real tool.

## Scope

### IN
- **Single config file** — `rlmx.yaml` replaces 5 .md files, backward-compat fallback to .md
- **npm publish** — fix repo URL, publish, verify `npx rlmx --help` works
- **Observability** — structured JSONL logging (`--log`), stats output (`--stats`), per-call cost/tokens/timing
- **Budget controls** — `--max-cost`, `--max-tokens`, `--max-depth` (configurable in rlmx.yaml)
- **Tool levels** — `--tools core|standard|full`, default `core` (paper-faithful). Batteries in `standard`.
- **Batteries** — `python/batteries.py`: describe_context, preview_context, search_context, grep_context, chunk_context, chunk_text, map_query, reduce_query
- **Auto-detect packages** — probe numpy/pandas/etc at startup, inject availability into system prompt (in `full` mode)
- **Context config** — configurable extensions and excludes for directory loading
- **REPL hardening** — crash recovery (restart + retry once), Python 3.10+ check at startup
- **Tests** — scaffold, config parsing, REPL lifecycle, FINAL detection, budget enforcement, YAML loading
- **Error messages** — graceful errors for missing Python, missing API key, unknown model

### OUT
- No TS REPL migration — Python subprocess stays
- No pi/ai replacement — keep multi-provider support
- No web UI or TUI (pi/ai provides TUI separately)
- No Docker/cloud sandbox environments (v1 is local only)
- No breaking changes to programmatic API (index.ts exports stay)

## Approach

### Architecture

```
rlmx.yaml (single config)
    ↓ load + validate
Node.js CLI (src/)
    ↓ spawn
Python REPL subprocess (python/)
    ↕ JSON lines IPC
pi/ai LLM client
    ↕ API calls
Anthropic / OpenAI / Google / etc.
```

Keep Python subprocess REPL. It works, it's fast (17ms cold start, persistent process), and gives the agent access to the entire Python data analysis ecosystem. LLMs generate better analytical code in Python than JS. The REPL is already faithful to the paper — blank canvas + LLM functions + `__import__` allowed.

### Config: rlmx.yaml

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-5
  sub-call-model: claude-haiku-4-5

system: |
  Custom system prompt here.
  {custom_tools_section}

tools:
  search_docs: |
    def search_docs(keyword):
        """Search context docs for keyword."""
        return [item['path'] for item in context
                if keyword.lower() in item['content'].lower()]

criteria: |
  Provide answers with file path references.

context:
  extensions: [.md, .txt, .py, .ts, .js]
  exclude: [node_modules, .git, dist, __pycache__]

budget:
  max-cost: 1.0
  max-tokens: 50000
  max-depth: 3

tools-level: core
```

Lookup order: `rlmx.yaml` → `.rlmx.yaml` → individual .md files (v0.1 compat) → defaults.

`rlmx init` scaffolds one `rlmx.yaml` with paper defaults and inline comments.

### Tool Levels

| Level | What's in the REPL | System prompt describes |
|-------|-------------------|----------------------|
| `core` (default) | 6 paper functions + `__import__` + TOOLS.md/yaml tools | Core 6 + custom tools |
| `standard` | core + batteries.py | Core 6 + batteries + custom tools |
| `full` | standard + auto-detected packages listed | Core 6 + batteries + custom + available packages |

Batteries (`python/batteries.py`) — pure stdlib, zero deps:
- `describe_context()` — print context type, size, previews
- `preview_context(n, chars)` — show first n items truncated
- `search_context(query, top_n)` — keyword search across context items
- `grep_context(pattern)` — regex search across context
- `chunk_context(n)` — split context into n chunks
- `chunk_text(text, size, overlap)` — split text with overlap
- `map_query(items, template, batch_size)` — llm_query_batched over items with template
- `reduce_query(results, prompt)` — aggregate results via llm_query

Stats track which batteries were used → enables benchmarking across tool levels.

### Output Model (agent-first)

```bash
# Default: clean answer to stdout (agents consume this)
rlmx "query" --context ./docs/

# Stats: answer + structured metadata
rlmx "query" --stats
# stdout: answer text
# stderr: JSON stats block {iterations, tokens, cost, time_ms, tools_used, ...}

# JSON mode: everything in one JSON object
rlmx "query" --output json --stats
# {"answer": "...", "references": [...], "stats": {iterations, tokens, cost, ...}}

# Log: full observability to file (every iteration, LLM call, REPL exec)
rlmx "query" --log run.jsonl

# Stream: JSONL events per iteration
rlmx "query" --output stream
```

### Observability — JSONL Log Format

```jsonl
{"type":"run_start","run_id":"abc123","query":"...","model":"anthropic/claude-sonnet-4-5","tools_level":"core","timestamp":"..."}
{"type":"llm_call","run_id":"abc123","iteration":0,"input_tokens":1200,"output_tokens":450,"cost":0.008,"time_ms":2100}
{"type":"repl_exec","run_id":"abc123","iteration":0,"code":"...","stdout":"...","time_ms":12,"batteries_used":[]}
{"type":"llm_subcall","run_id":"abc123","iteration":1,"request_type":"llm_query","prompt_len":500,"response_len":200,"cost":0.002}
{"type":"run_end","run_id":"abc123","iterations":3,"total_tokens":8500,"total_cost":0.042,"time_ms":8500,"answer_len":450}
```

### Budget Controls

| Control | Flag | YAML key | Default |
|---------|------|----------|---------|
| Max cost (USD) | `--max-cost` | `budget.max-cost` | 1.0 |
| Max tokens | `--max-tokens` | `budget.max-tokens` | 50000 |
| Max recursion depth | `--max-depth` | `budget.max-depth` | 3 |
| Max iterations | `--max-iterations` | (existing) | 30 |
| Timeout | `--timeout` | (existing) | 300000ms |

When a budget limit is hit: stop gracefully, force final answer, include budget info in stats.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Keep Python subprocess REPL | Already works, 17ms startup, full Python ecosystem, LLMs generate better Python. Migration to TS/WASM = weeks of work for worse results. |
| Keep pi/ai | No vendor lock-in, multi-provider, TUI support, more features than raw SDK. |
| YAML config (not JSON) | System prompts and Python code blocks need clean multiline strings. JSON escape hell. One dep (js-yaml). |
| Single rlmx.yaml | 5 files pollute repo root. One file = one commit, like tsconfig.json. Backward compat with .md files. |
| core tools as default | Paper-faithful baseline. Batteries are opt-in. Measurable via --stats. |
| Batteries as stdlib-only Python | Zero external deps. Ship with npm package. Patterns the LLM writes anyway, pre-packaged. |
| Stats on stderr, answer on stdout | Agent-first: stdout is clean, parseable. Stats never pollute the answer stream. |
| Absorb fast-rlm patterns | Budget controls, depth tracking, JSONL logging — proven in sister project. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| npm name `rlmx` taken | Medium | Check before publish. Fallback: `@automagik/rlmx` |
| pi/ai breaking change on ^0.62 | Medium | Pin exact version in v0.2, test before bump |
| Python 3.8 users hit syntax errors | Medium | Check `python3 --version` at startup, require 3.10+, clear error |
| REPL subprocess hangs/crashes | High | Crash recovery: detect exit, restart, retry once. Per-exec timeout. |
| Cost runaway from recursive rlm_query | High | Budget controls: max-cost, max-tokens, max-depth with sensible defaults |
| Batteries confuse LLM / hurt performance | Medium | Default is `core` (no batteries). Benchmarkable via --tools + --stats. |
| js-yaml dep adds attack surface | Low | Well-maintained, widely used, small package. |
| YAML multiline edge cases in system prompts | Low | Validate on load, clear parse errors. |
| Backward compat with .md config users | Low | Fallback chain: yaml → .md files → defaults. Document migration. |

## Success Criteria

### Ship
- [ ] `npm install -g rlmx && rlmx --help` works from clean environment
- [ ] `npx rlmx --version` shows 0.2.0
- [ ] Package repo URL points to `namastex888/rlmx`

### Config
- [ ] `rlmx init` scaffolds one `rlmx.yaml` with paper defaults + comments
- [ ] All fields parsed: model, system, tools, criteria, context, budget, tools-level
- [ ] Fallback to individual .md files if no yaml found (v0.1 compat)
- [ ] `rlmx.yaml` with tools section injects Python functions into REPL

### Core
- [ ] `rlmx "2+2" --output json` returns valid JSON with answer
- [ ] `rlmx "query" --context ./docs/` loads files matching `context.extensions`
- [ ] `context.exclude` patterns are respected
- [ ] Python 3.10+ check at startup with actionable error message
- [ ] REPL crash recovery: if subprocess dies, restart and retry once
- [ ] Graceful errors for missing API key, unknown model

### Observability
- [ ] `--stats` appends JSON stats to stderr (tokens, cost, iterations, time, tools used)
- [ ] `--output json --stats` includes stats in JSON response
- [ ] `--log run.jsonl` writes per-iteration JSONL with run_id, timing, tokens, cost
- [ ] Normal output (no --stats, no --log) is completely clean — answer only

### Budget
- [ ] `--max-cost 0.50` stops run when cost exceeds limit, forces final answer
- [ ] `--max-tokens 10000` stops when total tokens exceed limit
- [ ] `--max-depth 2` prevents recursive rlm_query beyond depth 2
- [ ] Budget limits configurable in `rlmx.yaml` budget section
- [ ] Stats report which budget limit was hit (if any)

### Tools
- [ ] `--tools core` — only 6 paper functions (default)
- [ ] `--tools standard` — core + batteries.py functions available
- [ ] `--tools full` — standard + auto-detected packages listed in system prompt
- [ ] Batteries: describe_context, preview_context, search_context, grep_context, chunk_context, chunk_text, map_query, reduce_query
- [ ] Stats include `batteries_used` list for benchmarking

### Tests
- [ ] YAML config loading + validation
- [ ] Scaffold (init creates rlmx.yaml)
- [ ] REPL lifecycle (start, execute, stop, crash recovery)
- [ ] FINAL / FINAL_VAR detection
- [ ] Budget enforcement (cost, tokens, depth)
- [ ] Batteries functions (unit tests)
- [ ] Backward compat (.md file fallback)

## v0.3 Vision: CAG + RLM (Cache-Augmented Generation)

**Paper:** arxiv:2412.15605 — "Don't Do RAG: When Cache-Augmented Generation is All You Need"
**Research repo:** /home/genie/research/cag/

### Core Idea
`--cache` flag = bake full context into system prompt + use provider-level caching.
The user tunes `--max-iterations` to dial between pure CAG (1-shot) and full RLM (iterative REPL).

```
--cache --max-iterations 1   = pure CAG (fastest, cheapest per query)
--cache --max-iterations 5   = light reasoning over cached corpus
--cache --max-iterations 30  = full RLM with cached context
(no --cache)                 = paper RLM (context externalized, current default)
```

### pi/ai Already Supports Caching
Research confirmed: pi/ai v0.62 has `cacheRetention` and `sessionId` options.
rlmx just passes 2 fields through `completeSimple()`. No bypass needed.

| Provider | Support | Savings |
|----------|---------|---------|
| Anthropic | Auto (cache_control ephemeral) | 90% on cached reads |
| OpenAI | Auto (prefix caching + prompt_cache_key) | 50% on cached reads |
| Bedrock | Auto (cachePoint) | Provider-dependent |
| Google (implicit) | Auto (repeated prefixes) | Automatic |
| Google (explicit) | Needs onPayload hook | Requires cachedContents API |

### Use Cases
1. **Batch interrogation** — cache corpus once, fire 100 questions, each 90% cheaper
2. **Agent sessions** — brain feeds corpus, agent asks multiple questions in a loop
3. **Study mode** — cache a paper, ask 50 questions, first caches rest are nearly free
4. **A/B benchmarking** — same cached corpus, compare tool levels / iterations
5. **Repo index** — cache codebase, ask questions all day

### rlmx.yaml cache section (v0.3)
```yaml
cache:
  enabled: false
  strategy: full            # full (CAG) | metadata (paper RLM)
  session-prefix: "myproject"
  retention: long           # short (5min) | long (1h+)
```

### Implementation (trivial in llm.ts)
```typescript
completeSimple(model, { systemPrompt, messages }, {
  cacheRetention: config.cache.retention,
  sessionId: `${config.cache.sessionPrefix}-${contentHash}`,
});
```

### Stats include cache metrics
pi/ai already tracks cacheRead, cacheWrite, and cost per cache operation.
rlmx stats report: cache hit/miss, tokens cached, cost savings.

This is OUT of v0.2 scope. v0.2 ships the foundation. v0.3 adds CAG on top.

## Relationship with `genie brain`

brain = knowledge layer (storage, search, embeddings). rlmx = reasoning layer (iterative LLM + REPL).

- **Brain calls rlmx** for `analyze`, `synthesize`, `digest` commands
- **rlmx receives brain search results as context** — never touches Postgres directly
- **rlmx.yaml per brain collection** — each brain can have its own reasoning config
- **TOOLS.yaml can call brain** via subprocess (`genie brain search`, `genie brain get`) — letting the reasoning loop pull more data mid-reasoning
- **No overlap**: brain owns storage/search/structure, rlmx owns reasoning/execution/orchestration
- rlmx v0.2 must ship before brain `analyze` command can work — it's a hard dependency

## Files to Create/Modify

```
# Modified
src/config.ts          — YAML loading, single-file parsing, fallback chain
src/cli.ts             — new flags: --stats, --log, --tools, --max-cost, --max-tokens, --max-depth
src/rlm.ts             — budget enforcement, stats collection, log emission
src/repl.ts            — crash recovery, batteries injection, package auto-detect
src/scaffold.ts        — generate rlmx.yaml instead of 5 .md files
src/output.ts          — stats formatting, JSONL log writer
src/llm.ts             — per-call cost tracking, depth tracking
src/context.ts         — configurable extensions + excludes
package.json           — version bump, repo URL fix, add js-yaml dep

# New
python/batteries.py    — built-in power tools (stdlib only)
src/logger.ts          — JSONL structured log writer
src/budget.ts          — budget tracking + enforcement
src/detect.ts          — Python version check, package auto-detection
tests/                 — test suite (scaffold, config, repl, final, budget, batteries, compat)
examples/              — example rlmx.yaml configs (tauri-docs, codebase-qa, paper-review)
```
