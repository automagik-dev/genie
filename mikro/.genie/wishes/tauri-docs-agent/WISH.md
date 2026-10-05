# Wish: rlmx CLI + Tauri Documentation Agent

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `tauri-docs-agent` |
| **Date** | 2026-03-24 |
| **Design** | [DESIGN.md](../../brainstorms/tauri-docs-agent/DESIGN.md) |

## Summary

Build `rlmx`, an npm CLI that implements the real RLM algorithm (prompt externalization, Python REPL with symbolic recursion, code-driven navigation) using `pi/ai` as the LLM client. Any coding agent runs `rlmx "query" --context ./corpus/` and gets RLM-powered research. Drop `.md` files in cwd to rewrite behavior — first run scaffolds paper defaults. Then build the first consumer: a Tauri v2 documentation specialist as a genie agent scaffold.

## Scope

### IN
- `rlmx` npm package: faithful RLM loop, Python REPL sandbox, pi/ai LLM client, .md config system, first-run scaffolding, `rlmx init`, context loading (dir/file/pipe/JSON), output modes (text/json/stream)
- Doc sync scraper: `sync-docs.py` downloads all 85 Tauri v2 pages from `llms.txt` as organized `.md` files
- Tauri docs agent: `SOUL.md` / `HEARTBEAT.md` / `AGENTS.md` + rlmx `.md` configs tuned for Tauri research
- npm publish of `rlmx`

### OUT
- No `pi/agent-core` dependency — rlmx writes its own RLM loop
- No Docker/Modal/E2B sandboxes — local Python REPL only (v1)
- No web UI or visualizer — CLI-only
- No fine-tuning or training data generation
- No Tauri plugin API reference (llms.txt covers guides/tutorials only)
- rlmx is generic — Tauri agent is just the first consumer, not a hard dependency

## Decisions

| Decision | Rationale |
|----------|-----------|
| rlmx repo at `/home/genie/research/rlmx/` | Alongside original RLM research. Own git repo, publishable to npm. |
| Tauri agent at `/home/genie/agents/tauri/tauri-docs/` | Standard genie agent workspace path. |
| Python REPL, not JS vm | RLM paper uses Python. Models trained on Python REPL patterns. JS would degrade quality. |
| `pi/ai` for LLM calls only | Council consensus: pi's tool-calling loop is wrong abstraction for RLM. pi/ai gives multi-provider LLM access. |
| `.md` files for config | Same pattern as CLAUDE.md/SOUL.md. Natural for coding agents, human-readable, git-friendly. |
| First-run scaffolding | Writes paper defaults so users see what they're overriding. Like `npm init`. |
| IPC via stdin/stdout JSON lines | Simpler than TCP sockets. Node.js parent ↔ Python child. |
| `uv` for Python deps | System rule: no pip. Use `uv pip install` or `uv run`. |

## Success Criteria

### rlmx CLI
- [ ] `rlmx init` scaffolds 5 `.md` files with paper defaults + inline comments
- [ ] First run in empty dir auto-scaffolds before executing
- [ ] `rlmx "query" --context ./docs/` returns answer with file references
- [ ] Prompt externalization: context NEVER in LLM message history (metadata only)
- [ ] `--context dir/` loads as `list[str]` with path metadata per file
- [ ] `--context file.md` loads as `str`
- [ ] `--output json` returns `{answer, references, usage, iterations, model}`
- [ ] `llm_query()` and `rlm_query()` work inside ```repl``` code blocks
- [ ] `llm_query_batched()` runs concurrent sub-LLM calls
- [ ] `rlm_query()` child inherits parent .md configs
- [ ] Editing SYSTEM.md changes system prompt
- [ ] Editing TOOLS.md injects custom REPL functions
- [ ] Editing CRITERIA.md changes output format
- [ ] Max iterations (30) + timeout prevent runaway loops
- [ ] Published on npm as `rlmx`

### Tauri docs agent
- [ ] `sync-docs.py` downloads 80+ of 85 Tauri docs as clean markdown
- [ ] Freshness check: `--check` exits 0 if fresh, 1 if stale
- [ ] SOUL/HEARTBEAT/AGENTS define specialist identity and workflow
- [ ] rlmx .md configs tuned for Tauri doc research
- [ ] Full flow: sync → `rlmx --context ./docs/ --output json` → validate refs → present

## Execution Strategy

### Wave 1 (parallel — foundations)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | rlmx project scaffold: package.json, CLI, config loader, scaffolding, context loader |
| 2 | engineer | Python REPL sandbox: subprocess, safe builtins, IPC, namespace injection |
| 3 | engineer | Doc sync scraper: sync-docs.py for Tauri llms.txt |

### Wave 2 (after Wave 1 — core engine + agent)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | RLM core loop: iteration engine, pi/ai client, FINAL detection, output modes, TOOLS.md parsing |
| 5 | engineer | Tauri docs agent: genie scaffold + rlmx .md configs |

### Wave 3 (after Wave 2 — ship)
| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | npm publish + end-to-end validation |
| review | reviewer | Review all groups against criteria |

## Execution Groups

### Group 1: rlmx Project Scaffold
**Goal:** Create the rlmx npm package foundation with CLI, config loader, scaffolding, and context loading.

**Deliverables:**

1. **`/home/genie/research/rlmx/`** — Git repo initialized
   - `package.json` with `@earendil-works/pi-ai` dependency, `bin: { rlmx: "./dist/cli.js" }`
   - `tsconfig.json` for TypeScript compilation
   - `.gitignore`

2. **`src/cli.ts`** — CLI entry point
   - `rlmx "query" --context <path> [--output text|json|stream] [--verbose] [--max-iterations N] [--timeout N]`
   - `rlmx init` — scaffold .md files without running query
   - Parse args, load config, invoke RLM loop (stub for now)

3. **`src/config.ts`** — Config loader
   - Read `SYSTEM.md`, `CONTEXT.md`, `TOOLS.md`, `CRITERIA.md`, `MODEL.md` from cwd
   - Parse each: raw markdown content as the override value
   - TOOLS.md parser: `## heading` = tool name, `python` code block = implementation
   - MODEL.md parser: extract provider + model name + sub-call model

4. **`src/scaffold.ts`** — First-run scaffolding
   - Detect missing .md files in cwd
   - Write defaults from RLM paper with inline `<!-- comments -->` explaining each section
   - `SYSTEM.md` default: exact `RLM_SYSTEM_PROMPT` from paper (`/home/genie/research/rlm/rlm/utils/prompts.py`)
   - `TOOLS.md` default: empty template with format guide
   - `CRITERIA.md` default: free-form text explanation
   - `MODEL.md` default: `anthropic` / `claude-sonnet-4-5` / sub-call model
   - `CONTEXT.md` default: auto-detect explanation

5. **`src/context.ts`** — Context loader
   - Directory → recursively read files (default `*.md`), return `{type: "list", items: [{path, content}], metadata}`
   - Single file → return `{type: "string", content, metadata}`
   - Stdin → return `{type: "string", content, metadata}`
   - JSON file → parse, return `{type: "dict"|"list", content, metadata}`
   - Generate metadata string: type, total length, chunk lengths, short prefix

**Acceptance Criteria:**
- [ ] `npm run build` compiles without errors
- [ ] `rlmx init` creates 5 .md files in cwd with paper defaults
- [ ] `rlmx --help` shows usage
- [ ] Config loader reads and parses all 5 .md file types
- [ ] Context loader handles directory, file, and stdin input
- [ ] TOOLS.md parser extracts tool name + Python code from markdown

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && node dist/cli.js init --dir /tmp/rlmx-test && ls /tmp/rlmx-test/{SYSTEM,CONTEXT,TOOLS,CRITERIA,MODEL}.md && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 2: Python REPL Sandbox
**Goal:** Build the Python subprocess REPL with safe builtins, persistent namespace, and IPC protocol.

**Deliverables:**

1. **`src/repl.ts`** — REPL manager (Node.js side)
   - Spawn Python subprocess with `repl_server.py`
   - Send execute commands via stdin JSON lines
   - Receive results (stdout, stderr, variables, final answer) via stdout JSON lines
   - Handle subprocess lifecycle: start, execute, reset, kill
   - Timeout per execution (kill subprocess if hung)

2. **`python/repl_server.py`** — REPL server (Python side)
   - Read JSON commands from stdin, write JSON results to stdout
   - Persistent `globals` namespace across executions
   - Safe builtins: block `eval`, `exec`, `input`, `compile`, `globals`, `locals`
   - Reserved names (protected): `context`, `llm_query`, `rlm_query`, `llm_query_batched`, `rlm_query_batched`, `FINAL_VAR`, `FINAL`, `SHOW_VARS`
   - `FINAL_VAR(name)` → signal completion with variable value
   - `FINAL(answer)` → signal completion with inline answer
   - `SHOW_VARS()` → return list of user-created variables
   - Truncate stdout to 20,000 chars (faithful to paper)

3. **`src/ipc.ts`** — IPC protocol types
   - `ExecuteRequest: { code: string }`
   - `ExecuteResult: { stdout: string, stderr: string, variables: string[], final?: { type: "var"|"inline", value: string }, error?: string }`
   - `LLMRequest: { type: "llm_query"|"llm_query_batched", prompts: string[], model?: string }`
   - `LLMResponse: { results: string[] }`

4. **`python/llm_bridge.py`** — LLM call bridge (Python side)
   - `llm_query(prompt, model=None)` → sends LLMRequest to parent via stdout, blocks on stdin for response
   - `llm_query_batched(prompts, model=None)` → sends batched request, blocks for response
   - `rlm_query(prompt, model=None)` → signals parent to spawn child rlmx process
   - `rlm_query_batched(prompts, model=None)` → signals parent for parallel children
   - Thread-safe: uses a lock for IPC since REPL code may use threads

**Acceptance Criteria:**
- [ ] Python REPL executes code and returns stdout + variable list
- [ ] Variables persist across multiple execute calls
- [ ] Safe builtins: `eval()` and `exec()` raise error inside REPL
- [ ] `FINAL_VAR("x")` returns the value of variable `x`
- [ ] `FINAL("answer")` returns inline answer
- [ ] `SHOW_VARS()` lists user-created variables
- [ ] Stdout truncated to 20,000 chars
- [ ] `llm_query()` sends IPC request and receives response
- [ ] Subprocess killed on timeout

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && node -e "
const {REPL} = require('./dist/repl');
(async () => {
  const repl = new REPL();
  await repl.start({context: 'hello world'});
  const r1 = await repl.execute('x = len(context); print(x)');
  console.log('stdout:', r1.stdout.trim());
  const r2 = await repl.execute('FINAL_VAR(\"x\")');
  console.log('final:', r2.final?.value);
  await repl.stop();
  console.log(r1.stdout.trim() === '11' && r2.final ? 'PASS' : 'FAIL');
})()
" && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 3: Doc Sync Scraper
**Goal:** Build a Python script that downloads all Tauri v2 docs from `llms.txt` as organized markdown files.

**Deliverables:**

1. **`/home/genie/agents/tauri/tauri-docs/scripts/sync-docs.py`** — Sync script
   - Fetch `https://v2.tauri.app/llms.txt`, parse all URLs (85 entries)
   - For each URL: fetch HTML, extract main content (`<main>` or `<article>`, strip nav/header/footer), convert to markdown
   - Save to `docs/<section>/<path>.md` mirroring URL structure
   - Write `docs/.last-synced` with ISO timestamp
   - Cache `docs/llms.txt` as local copy
   - Flags: `--force` (re-download all), `--check` (report freshness, exit 0/1), `--ttl N` (hours, default 24)
   - Polite: 0.5s delay between requests, proper User-Agent
   - Graceful errors: log per-URL failures, continue, report summary

2. **`/home/genie/agents/tauri/tauri-docs/scripts/requirements.txt`**
   - `httpx`, `beautifulsoup4`, `markdownify`, `rich`

**Acceptance Criteria:**
- [ ] `uv run scripts/sync-docs.py` downloads docs into organized `docs/` folders
- [ ] At least 80 of 85 URLs downloaded successfully
- [ ] Each `.md` file is clean markdown (no HTML tags, no nav chrome)
- [ ] `docs/.last-synced` has valid ISO timestamp
- [ ] `--check` exits 0 if fresh (<24h), 1 if stale
- [ ] `--force` re-downloads regardless of freshness
- [ ] Folder structure: `docs/{start,concept,security,develop,distribute,learn}/`

**Validation:**
```bash
cd /home/genie/agents/tauri/tauri-docs && uv run scripts/sync-docs.py --force 2>&1 | tail -5 && test -f docs/.last-synced && find docs -name "*.md" -not -name "llms.txt" | wc -l | xargs -I{} test {} -ge 70 && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 4: RLM Core Loop
**Goal:** Implement the faithful RLM iteration engine that ties together config, REPL, and pi/ai LLM client.

**Deliverables:**

1. **`src/rlm.ts`** — Core RLM loop
   - `rlmLoop(query, context, config)` — main entry point
   - Build system prompt: config.system (from SYSTEM.md or paper default) + custom tools section + context metadata
   - Build user prompt: iteration 0 safeguard ("you haven't seen context yet") + iteration N continuation
   - Iteration loop (max `config.maxIterations`, default 30):
     1. Call pi/ai `completeSimple()` with current messages
     2. Parse response for ` ```repl``` ` code blocks (regex extraction)
     3. Execute each code block in REPL sandbox
     4. Check for FINAL/FINAL_VAR in REPL result
     5. If found → return final answer
     6. Append assistant message + formatted execution result (code + truncated stdout + variables) to history
     7. Check limits (timeout, max iterations)
   - If max iterations reached without FINAL: force a final answer prompt
   - Return `RLMResult: { answer, references, usage: {inputTokens, outputTokens, llmCalls}, iterations, model }`

2. **`src/llm.ts`** — pi/ai LLM client wrapper
   - `llmComplete(prompt, model, config)` → calls `completeSimple()` from `@earendil-works/pi-ai`
   - `llmCompleteBatched(prompts, model, config)` → concurrent `Promise.all` of `completeSimple()`
   - Handle IPC requests from Python REPL: when REPL sends `llm_query` request, route to this module
   - `rlmQuery(prompt, model, config)` → spawn child `rlmx` process with same cwd, return result
   - `rlmQueryBatched(prompts, model, config)` → parallel child processes (max 4 concurrent)
   - API key resolution: check env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) or MODEL.md config

3. **`src/parser.ts`** — Code block extraction + FINAL detection
   - Extract ` ```repl``` ` blocks from LLM response (regex: ` ```repl\s*\n(.*?)\n``` `)
   - Detect `FINAL(answer)` and `FINAL_VAR(variable_name)` in response text (outside code blocks)
   - Format iteration result: code executed + stdout + variable list (for appending to history)
   - Truncate formatted output to 20,000 chars

4. **`src/output.ts`** — Output formatting
   - Text mode: print answer to stdout
   - JSON mode: `JSON.stringify({answer, references, usage, iterations, model})`
   - Stream mode: JSONL events per iteration `{type: "iteration"|"final", ...}`
   - Verbose mode: iteration progress to stderr, answer to stdout
   - If CRITERIA.md specifies format: append criteria to system prompt so LLM structures FINAL accordingly

**Acceptance Criteria:**
- [ ] RLM loop runs: sends metadata → LLM responds with code → code executes in REPL → results fed back
- [ ] Context NEVER appears in message history (verified by logging messages)
- [ ] FINAL_VAR correctly returns REPL variable value
- [ ] FINAL inline answer correctly captured
- [ ] Max iterations (30) stops the loop and forces final answer
- [ ] Timeout kills the run gracefully
- [ ] `llm_query()` from inside REPL code successfully calls pi/ai and returns
- [ ] `rlm_query()` from inside REPL spawns child rlmx and returns
- [ ] `llm_query_batched()` runs concurrently
- [ ] `--output json` produces valid JSON with all fields
- [ ] TOOLS.md custom functions are available in REPL namespace
- [ ] CRITERIA.md content appended to system prompt

**Validation:**
```bash
cd /home/genie/research/rlmx && npm run build && echo "What is 2+2?" | node dist/cli.js --output json 2>/dev/null | python3 -c "import sys,json; r=json.load(sys.stdin); print('PASS' if 'answer' in r and r['iterations'] >= 1 else 'FAIL')"
```

**depends-on:** Group 1, Group 2

---

### Group 5: Tauri Docs Agent Scaffold
**Goal:** Create the genie agent workspace with specialist identity and rlmx configuration tuned for Tauri v2 doc research.

**Deliverables:**

1. **`/home/genie/agents/tauri/tauri-docs/SOUL.md`** — Tauri specialist identity
   - Role: Tauri v2 documentation researcher
   - Source-of-truth mindset: every claim backed by a doc file reference
   - Deep knowledge areas: Rust backend, webview frontend, IPC, plugins, security, distribution
   - Cross-referencing habit: links related docs (e.g., security when discussing IPC)
   - Honest about gaps: if it's not in the docs, say so
   - Voice: precise, technical, always with file path citations

2. **`/home/genie/agents/tauri/tauri-docs/HEARTBEAT.md`** — Doc sync + corpus health
   - **Sync check:** run `uv run scripts/sync-docs.py --check` → sync if stale
   - **Corpus integrity:** verify doc count matches llms.txt URL count
   - **Freshness report:** log last sync time, staleness

3. **`/home/genie/agents/tauri/tauri-docs/AGENTS.md`** — Mission + workflow
   - Mission: Navigate Tauri v2 docs to provide accurate, source-backed assessment
   - Do NOT write code — only provide guidance from documentation
   - Workflow: receive query → sync check → `rlmx "query" --context ./docs/ --output json` → validate refs → present
   - Tools: `rlmx` (research), `uv run scripts/sync-docs.py` (sync), `Read`/`Grep`/`Glob` (validation)
   - Reference validation: read each cited file, confirm quote exists, strip unvalidated claims
   - Authority: can research and advise, cannot modify docs or write code

4. **`/home/genie/agents/tauri/tauri-docs/SYSTEM.md`** — rlmx system prompt override
   - Tauri-specific research instructions
   - Doc structure awareness (6 sections: start, concept, security, develop, distribute, learn)
   - Methodical navigation: structure → search → read → cross-reference → synthesize
   - Mandatory file path references in every claim

5. **`/home/genie/agents/tauri/tauri-docs/TOOLS.md`** — rlmx custom REPL tools
   - `search_docs(keyword)` — search corpus for files matching keyword
   - `read_doc(path)` — read a specific doc file
   - `list_sections()` — list all doc sections and file counts

6. **`/home/genie/agents/tauri/tauri-docs/CRITERIA.md`** — rlmx output format
   - JSON output with: answer, references (file + section + quote), confidence, related_docs
   - Validation rules: every claim needs a reference, references need exact quotes

7. **`/home/genie/agents/tauri/tauri-docs/MODEL.md`** — rlmx model config
   - Root model: anthropic / claude-sonnet-4-5
   - Sub-call model: anthropic / claude-haiku-4-5 (cheaper for chunk processing)

**Acceptance Criteria:**
- [ ] SOUL.md defines clear Tauri specialist persona (<2500 words)
- [ ] HEARTBEAT.md has runnable sync check workflow
- [ ] AGENTS.md has complete research workflow with rlmx invocation
- [ ] SYSTEM.md overrides default RLM prompt with Tauri-specific instructions
- [ ] TOOLS.md defines 3 custom REPL tools with valid Python implementations
- [ ] CRITERIA.md specifies JSON output format with reference requirements
- [ ] MODEL.md specifies root + sub-call models

**Validation:**
```bash
cd /home/genie/agents/tauri/tauri-docs && test -f SOUL.md && test -f HEARTBEAT.md && test -f AGENTS.md && test -f SYSTEM.md && test -f TOOLS.md && test -f CRITERIA.md && test -f MODEL.md && grep -q "rlmx" AGENTS.md && grep -q "def search_docs" TOOLS.md && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 3 (needs doc structure to write accurate SYSTEM.md)

---

### Group 6: npm Publish + End-to-End Validation
**Goal:** Publish rlmx to npm and validate the complete pipeline: rlmx + Tauri docs agent.

**Deliverables:**

1. **npm publish**
   - Verify npm token: `npm whoami`
   - Build: `npm run build`
   - Publish: `npm publish --access public`
   - Verify: `npx rlmx --help`

2. **End-to-end test: rlmx standalone**
   - Create temp dir, run `rlmx init`, verify scaffolded files
   - Run `rlmx "What is 2+2?" --output json`, verify JSON response with answer
   - Run `rlmx "Summarize this" --context <test-file> --output json`, verify references

3. **End-to-end test: Tauri docs agent flow**
   - Sync docs: `cd /home/genie/agents/tauri/tauri-docs && uv run scripts/sync-docs.py`
   - Run research: `cd /home/genie/agents/tauri/tauri-docs && rlmx "How does Tauri IPC work?" --context ./docs/ --output json`
   - Verify: response contains answer + references with real file paths
   - Validate: each referenced file exists and contains the cited content

4. **`README.md`** for rlmx package
   - Installation: `npm install -g rlmx`
   - Quick start: `rlmx init && rlmx "query" --context ./data/`
   - .md config files explained
   - Output modes
   - Examples

**Acceptance Criteria:**
- [ ] `npm publish` succeeds, package available on npm
- [ ] `npx rlmx --help` works from clean environment
- [ ] `rlmx init` scaffolds correctly in temp dir
- [ ] Simple query returns valid JSON response
- [ ] Context query returns answer with references
- [ ] Tauri docs full flow: sync → rlmx → valid answer with real doc references
- [ ] README covers installation, usage, and config

**Validation:**
```bash
npx rlmx@latest --help && cd /home/genie/agents/tauri/tauri-docs && rlmx "What is the Tauri process model?" --context ./docs/ --output json 2>/dev/null | python3 -c "import sys,json; r=json.load(sys.stdin); print('PASS' if r.get('answer') and r.get('references') else 'FAIL')"
```

**depends-on:** Group 4, Group 5

---

## QA Criteria

_What must be verified after all groups complete._

- [ ] rlmx prompt externalization: context never in LLM messages (log and verify)
- [ ] rlmx scaffolding: first run in empty dir creates all 5 .md files
- [ ] rlmx REPL: `llm_query()` and `rlm_query()` callable from inside code blocks
- [ ] rlmx output: `--output json` returns valid, parseable JSON
- [ ] Tauri docs: 80+ docs downloaded as clean markdown
- [ ] Tauri agent: full research flow returns validated, source-backed answers
- [ ] Token efficiency: rlmx uses fewer tokens than equivalent tool-calling approach for same query

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Python REPL security (exec in subprocess) | Medium | Safe builtins, subprocess isolation, timeout kill |
| pi/ai API changes | Low | Pin version in package.json |
| Model writes bad code / infinite loops | Medium | Max 30 iterations, configurable timeout, subprocess kill |
| TOOLS.md parsing edge cases | Medium | Simple convention: `## heading` = name, `python` block = code. No DSL. |
| npm name `rlmx` may be taken | Medium | Check availability before publish. Fallback: `@automagik/rlmx` |
| Tauri HTML structure varies across pages | Medium | Robust extraction: try `<main>`, `<article>`, fall back to `<body>`. Accept 80/85 threshold. |
| pi/ai requires API keys at runtime | Low | Document in README. MODEL.md can specify provider. Env vars checked automatically. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# rlmx package (/home/genie/research/rlmx/)
package.json
tsconfig.json
.gitignore
README.md
src/cli.ts
src/config.ts
src/scaffold.ts
src/context.ts
src/repl.ts
src/ipc.ts
src/rlm.ts
src/llm.ts
src/parser.ts
src/output.ts
python/repl_server.py
python/llm_bridge.py

# Tauri docs agent (/home/genie/agents/tauri/tauri-docs/)
SOUL.md
HEARTBEAT.md
AGENTS.md
SYSTEM.md
TOOLS.md
CRITERIA.md
MODEL.md
scripts/sync-docs.py
scripts/requirements.txt
```
