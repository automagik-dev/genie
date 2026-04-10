# Wish: rlmx v0.2.0 — Ship, Observe, Control

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `rlmx-v02` |
| **Date** | 2026-03-26 |
| **Design** | [DESIGN.md](../../brainstorms/rlmx-v02/DESIGN.md) |
| **Repo** | `/home/genie/research/rlmx/` (github: `namastex888/rlmx`) |

## Summary

Ship rlmx as a real npm package with single-file YAML config, structured observability, budget controls, and configurable tool levels. Replace 5 scattered .md config files with one `rlmx.yaml`. Add JSONL logging, `--stats` output, cost/token/depth limits, and batteries (convenience functions). Keep Python subprocess REPL and pi/ai — both work, both stay.

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
- No CAG / context caching (v0.3 scope)
- No web UI or TUI (pi/ai provides TUI separately)
- No Docker/cloud sandbox environments (local only)
- No breaking changes to programmatic API (index.ts exports stay)

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
| Absorb fast-rlm patterns | Budget controls, depth tracking, JSONL logging — proven in sister project at /home/genie/research/fast-rlm/. |

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

## Execution Strategy

### Wave 1 (parallel — foundations)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | YAML config: loader, validator, scaffold, fallback chain |
| 2 | engineer | Observability: JSONL logger, stats collector, output formatting |
| 3 | engineer | Batteries: python/batteries.py + package auto-detection |

### Wave 2 (parallel — after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Budget controls: tracking, enforcement, depth limiting |
| 5 | engineer | REPL hardening: crash recovery, Python version check, tool levels |
| 6 | engineer | Context config: extensions, excludes, integration with YAML config |

### Wave 3 (after Wave 2 — ship)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | CLI integration: wire all new flags, update help, npm publish prep |
| 8 | engineer | Tests: full test suite covering all new features |
| 9 | engineer | Examples: rlmx.yaml configs for tauri-docs, codebase-qa, paper-review |
| review | reviewer | Review all groups against criteria |

## Execution Groups

### Group 1: YAML Config System
**Goal:** Replace 5 .md files with single `rlmx.yaml` config, with backward compatibility.

**Deliverables:**
1. **`src/config.ts`** — Rewrite config loader
   - Parse `rlmx.yaml`: model, system, tools, criteria, context, budget, tools-level
   - YAML tools section: name → Python code (replaces ## heading + ```python``` parsing)
   - Lookup chain: `rlmx.yaml` → `.rlmx.yaml` → individual .md files → defaults
   - Validate all fields with clear error messages
   - Add `js-yaml` dependency

2. **`src/scaffold.ts`** — Rewrite scaffolding
   - `rlmx init` creates one `rlmx.yaml` with paper defaults + YAML comments
   - Include all sections: model, system, tools (empty), criteria, context, budget, tools-level
   - Comments explain each field

**Acceptance Criteria:**
- [ ] `rlmx init` creates `rlmx.yaml` (not .md files)
- [ ] All YAML fields parsed correctly
- [ ] Fallback to .md files works when no YAML present
- [ ] Invalid YAML produces clear error message

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && node dist/cli.js init --dir /tmp/rlmx-yaml-test && node -e "const yaml = require('js-yaml'); const fs = require('fs'); const cfg = yaml.load(fs.readFileSync('/tmp/rlmx-yaml-test/rlmx.yaml','utf8')); console.log(cfg.model?.provider === 'anthropic' ? 'PASS' : 'FAIL')"
```

**depends-on:** none

---

### Group 2: Observability
**Goal:** Add structured JSONL logging and stats output for full run observability.

**Deliverables:**
1. **`src/logger.ts`** — JSONL structured log writer
   - Write to file (--log flag) or discard
   - Event types: run_start, llm_call, repl_exec, llm_subcall, run_end
   - Each event: run_id, timestamp, relevant metrics (tokens, cost, time_ms)
   - Generate unique run_id per invocation

2. **`src/output.ts`** — Stats output formatting
   - `--stats` flag: emit JSON stats block to stderr after answer
   - `--output json --stats`: include stats object in JSON response
   - Stats: iterations, total_tokens, total_cost, time_ms, tools_level, batteries_used, budget_hit
   - No stats output when flags not present (clean by default)

3. **`src/llm.ts`** — Per-call cost tracking
   - Compute cost from model pricing (input/output token rates)
   - Track per-call: tokens, cost, time_ms
   - Emit to logger on each LLM call

**Acceptance Criteria:**
- [ ] `--log run.jsonl` creates valid JSONL file with all event types
- [ ] `--stats` emits JSON to stderr, stdout stays clean
- [ ] `--output json --stats` includes stats in response JSON
- [ ] No output leaks when stats/log flags not used

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && echo "test" | node dist/cli.js --stats --output json > /tmp/rlmx-out.json 2>/tmp/rlmx-stats.json && python3 -c "import json; json.load(open('/tmp/rlmx-stats.json')); json.load(open('/tmp/rlmx-out.json')); print('PASS')" || echo "FAIL"
```

**depends-on:** none

---

### Group 3: Batteries
**Goal:** Ship convenience functions that save the LLM 1-2 iterations of boilerplate.

**Deliverables:**
1. **`python/batteries.py`** — Built-in power tools (stdlib only)
   - `describe_context()` — print context type, size, item count, previews
   - `preview_context(n=5, chars=200)` — show first n items with truncated previews
   - `search_context(query, top_n=10)` — keyword search across context items
   - `grep_context(pattern)` — regex search across context items
   - `chunk_context(n=10)` — split context into n roughly equal chunks
   - `chunk_text(text, size=4000, overlap=200)` — split text with overlap
   - `map_query(items, template, batch_size=10)` — llm_query_batched with {item} template
   - `reduce_query(results, prompt)` — aggregate results via llm_query

2. **`src/detect.ts`** — Package auto-detection
   - At REPL startup, probe for: numpy, pandas, httpx, beautifulsoup4, sklearn, matplotlib
   - Return availability dict
   - In `full` tools mode: inject "Available packages: ..." into system prompt

**Acceptance Criteria:**
- [ ] All 8 battery functions work in REPL
- [ ] Batteries use only stdlib (no external deps)
- [ ] `map_query` correctly calls `llm_query_batched` internally
- [ ] Package detection correctly identifies installed packages
- [ ] `--tools standard` injects batteries, `--tools core` does not

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && node -e "
// REPL.start() accepts REPLStartOptions with context param (see src/repl.ts:REPLStartOptions)
const {REPL} = require('./dist/repl');
(async () => {
  const repl = new REPL();
  await repl.start({context: [{path:'a.md',content:'hello world'},{path:'b.md',content:'goodbye world'}]});
  const r = await repl.execute('result = describe_context(); print(result)');
  console.log(r.stdout.includes('2') ? 'PASS' : 'FAIL');
  await repl.stop();
})()
"
```

**depends-on:** none

---

### Group 4: Budget Controls
**Goal:** Prevent cost runaway with configurable spending limits.

**Deliverables:**
1. **`src/budget.ts`** — Budget tracking + enforcement
   - Track running totals: cost, input_tokens, output_tokens, depth
   - Check limits after each LLM call
   - When limit hit: set abort signal, force final answer
   - Report which limit was hit in stats

2. **`src/rlm.ts` modifications** — Wire budget into loop
   - Pass budget tracker to each llm call
   - Check budget before each iteration
   - On budget exceeded: graceful stop, force final answer prompt
   - `--max-cost`, `--max-tokens`, `--max-depth` CLI flags
   - Read defaults from `rlmx.yaml` budget section

**Acceptance Criteria:**
- [ ] `--max-cost 0.001` stops run quickly and forces final answer
- [ ] `--max-tokens 500` stops when token limit exceeded
- [ ] `--max-depth 1` prevents recursive rlm_query children
- [ ] Budget from YAML used when flags not provided
- [ ] Stats include `budget_hit: "max-cost"` (or null if not hit)

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && echo "test" | node dist/cli.js --max-tokens 100 --output json --stats 2>/tmp/budget-stats.json && python3 -c "import sys,json; r=json.load(sys.stdin); s=json.load(open('/tmp/budget-stats.json')); print('PASS' if r.get('answer') and s.get('budget_hit') else 'FAIL')"
```

**depends-on:** Group 1 (YAML config for budget defaults), Group 2 (stats reporting)

---

### Group 5: REPL Hardening
**Goal:** Make the Python REPL robust — crash recovery, version checks, tool level injection.

**Deliverables:**
1. **`src/repl.ts` modifications** — Crash recovery
   - Detect subprocess exit during execution
   - On crash: restart subprocess, re-inject context + tools, retry execution once
   - If second crash: fail gracefully with error
   - Log crash events to JSONL logger

2. **`src/detect.ts` additions** — Python version check
   - At startup: run `python3 --version`, parse output
   - If < 3.10: clear error message with install instructions
   - If python3 not found: clear error with platform-specific guidance

3. **`src/repl.ts` additions** — Tool level injection
   - `core`: inject only core 6 functions (current behavior)
   - `standard`: also inject batteries.py functions
   - `full`: also inject package availability info into system prompt
   - Track which batteries are called during execution (for stats)

**Acceptance Criteria:**
- [ ] REPL recovers from subprocess crash (restart + retry)
- [ ] Python < 3.10 shows clear error, not stack trace
- [ ] Missing python3 shows clear error with install guidance
- [ ] `--tools core` has 6 functions, `--tools standard` adds batteries
- [ ] Battery usage tracked in stats

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && cd /home/genie/research/rlmx && npm run build && PATH="/usr/bin:$PATH" node dist/cli.js --version && echo "Version check passed" && node -e "const {checkPythonVersion} = require('./dist/detect'); checkPythonVersion().then(v => console.log(v >= '3.10' ? 'PASS' : 'FAIL'))"
```

**depends-on:** Group 3 (batteries.py must exist)

---

### Group 6: Context Config
**Goal:** Make directory context loading configurable — extensions and excludes.

**Deliverables:**
1. **`src/context.ts` modifications**
   - Read `context.extensions` from config (default: `[.md]` for backward compat)
   - Read `context.exclude` from config (default: `[node_modules, .git]`)
   - Support glob patterns in exclude list
   - `--ext` CLI flag as override: `--ext .md,.txt,.py`
   - Note: `loadContext()` returns `LoadedContext { type, content, metadata }` where `content` is `ContextItem[]` for dirs (see src/context.ts)

**Acceptance Criteria:**
- [ ] `context.extensions: [.md, .txt, .py]` loads all three types
- [ ] `context.exclude: [node_modules, dist]` skips those directories
- [ ] `--ext .md,.txt` overrides YAML config
- [ ] Default behavior unchanged (only .md, skip .git/node_modules)

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && mkdir -p /tmp/ctx-test && echo "hello" > /tmp/ctx-test/a.md && echo "world" > /tmp/ctx-test/b.txt && node -e "
const {loadContext} = require('./dist/context');
(async () => {
  const ctx = await loadContext('/tmp/ctx-test', {extensions: ['.md', '.txt']});
  console.log(ctx.content.length === 2 ? 'PASS' : 'FAIL');
})()
"
```

**depends-on:** Group 1 (YAML config for context section)

---

### Group 7: CLI Integration + npm Publish
**Goal:** Wire everything together in the CLI and prepare for npm publish.

**Deliverables:**
1. **`src/cli.ts`** — Add all new flags
   - `--stats`, `--log <path>`, `--tools core|standard|full`
   - `--max-cost <n>`, `--max-tokens <n>`, `--max-depth <n>`
   - `--ext <list>` for context extensions
   - Update `--help` text

2. **`package.json`** — Publish prep
   - Version bump to 0.2.0
   - Fix repo URL: `namastex888/rlmx`
   - Pin pi/ai to exact version: `"@mariozechner/pi-ai": "0.62.0"` (not `^0.62.0`, per risk mitigation)
   - Add `js-yaml` dependency
   - Verify `files` includes `python/batteries.py`

3. **npm publish**
   - `npm run build`
   - `npm pack` and verify contents
   - `npm publish --access public`
   - Verify: `npx rlmx@0.2.0 --help`

**Acceptance Criteria:**
- [ ] All new flags parsed and wired to implementations
- [ ] `--help` documents all flags
- [ ] `npm publish` succeeds
- [ ] `npx rlmx --help` works from clean environment
- [ ] `npx rlmx --version` shows 0.2.0

**Validation:**
```bash
npx rlmx@0.2.0 --help && npx rlmx@0.2.0 --version | grep "0.2.0" && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1-6 (all features must be complete)

---

### Group 8: Tests
**Goal:** Comprehensive test suite for all new v0.2 features.

**Deliverables:**
1. **`tests/config.test.ts`** — YAML loading, validation, fallback
2. **`tests/scaffold.test.ts`** — init creates rlmx.yaml
3. **`tests/repl.test.ts`** — lifecycle, crash recovery, tool injection
4. **`tests/parser.test.ts`** — FINAL/FINAL_VAR detection
5. **`tests/budget.test.ts`** — cost/token/depth enforcement
6. **`tests/batteries.test.ts`** — all 8 battery functions
7. **`tests/context.test.ts`** — extensions, excludes, backward compat
8. **`tests/compat.test.ts`** — .md file fallback when no YAML

**Acceptance Criteria:**
- [ ] All test files created and passing
- [ ] Tests run via `npm test`
- [ ] Coverage of all acceptance criteria from groups 1-7

**Validation:**
```bash
cd /home/genie/research/rlmx && npm test && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1-6 (tests validate implementations)

---

### Group 9: Examples
**Goal:** Ship example rlmx.yaml configs showing real use cases.

**Deliverables:**
1. **`examples/tauri-docs/rlmx.yaml`** — Tauri v2 documentation researcher
2. **`examples/codebase-qa/rlmx.yaml`** — Code analysis agent
3. **`examples/paper-review/rlmx.yaml`** — Academic paper reviewer
4. **`examples/README.md`** — Brief guide on using examples

**Acceptance Criteria:**
- [ ] Each example has valid rlmx.yaml with customized system, tools, criteria
- [ ] Examples demonstrate different tool levels and budget configs
- [ ] README explains how to use

**Validation:**
```bash
cd /home/genie/research/rlmx && test -f examples/tauri-docs/rlmx.yaml && test -f examples/codebase-qa/rlmx.yaml && test -f examples/paper-review/rlmx.yaml && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1 (YAML format must be finalized)

---

## QA Criteria

- [ ] `npm install -g rlmx` from npm registry works
- [ ] `rlmx init && rlmx "What is 2+2?" --output json` end-to-end in temp dir
- [ ] `rlmx "query" --context <dir> --stats --log run.jsonl` produces clean answer + stats + log
- [ ] Budget limits actually stop runs (not just report)
- [ ] `.md` file users can upgrade without breaking existing configs
- [ ] All tests pass on Node 18+ with Python 3.10+

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| npm name `rlmx` taken | Medium | Check before publish. Fallback: `@automagik/rlmx` |
| pi/ai breaking change on ^0.62 | Medium | Pin exact version, test before bump |
| Python 3.8 users hit syntax errors | Medium | Version check at startup, require 3.10+, clear error |
| REPL subprocess hangs/crashes | High | Crash recovery: restart + retry once. Per-exec timeout. |
| Cost runaway from recursive rlm_query | High | Budget controls with sensible defaults |
| Batteries confuse LLM / hurt performance | Medium | Default `core` (no batteries). Benchmarkable via --tools + --stats. |
| js-yaml adds attack surface | Low | Well-maintained, widely used |
| YAML multiline edge cases | Low | Validate on load, clear parse errors |
| Backward compat with .md users | Low | Fallback chain preserves old behavior |

## Review Results

_Populated by `/review` after execution completes._

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
tests/                 — test suite (8 test files)
examples/              — example rlmx.yaml configs (3 examples + README)
```
