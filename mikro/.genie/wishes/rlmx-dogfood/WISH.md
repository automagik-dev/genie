# Wish: rlmx Dogfood Loop — Self-Improving Context Agent

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `rlmx-dogfood` |
| **Date** | 2026-03-26 |
| **Design** | Inline — emergent from v0.2/v0.3 brainstorm session |

## Summary

Execute rlmx v0.3 using rlmx itself as the sole context navigation engine. Replace every native Claude Code tool (Read, Grep, Glob, Agent/Explore) with rlmx calls. When rlmx fails or underperforms, pause v0.3 implementation, hotfix rlmx, validate the fix, resume. Every gap discovered becomes a patch. The result: v0.3 ships AND rlmx is battle-tested on its own codebase. Document the orchestration loop as a reusable protocol for any agent that wants to dogfood its own tools.

## Prerequisites

- [ ] **rlmx v0.2.0 released to npm** (`npx rlmx --version` shows 0.2.x) — team `rlmx-v02` is building this now
- [ ] `rlmx.yaml` configured for the rlmx repo itself (Group 1 of this wish creates it)
- [ ] rlmx can answer basic questions about its own codebase (Group 1 validates this)

### Versioning Strategy
v0.2.0 is the stable baseline published to npm. All dogfood hotfixes are **patch releases** (0.2.1, 0.2.2, ...) built and tested locally on the v0.3 feature branch. Each hotfix is merged into the v0.3 branch and tested locally — **not published to npm until v0.3 is complete**. When v0.3 ships, it publishes as v0.3.0 with all accumulated hotfixes baked in.

## Scope

### IN

**The Dogfood Protocol:**
- `rlmx.yaml` for the rlmx repo — system prompt tuned for navigating TypeScript + Python codebase
- Custom TOOLS.md tools: `find_definition`, `list_files`, `show_file`, `find_references`, `diff_files`
- Tool substitution table: every native tool → rlmx equivalent
- Gap log: structured JSONL tracking every dogfood failure (`gaps.jsonl`)
- Hotfix workflow: pause → branch → fix → test → merge → resume

**The Orchestration Loop (reusable protocol):**
1. **NAVIGATE** — use rlmx to understand the codebase area
2. **IMPLEMENT** — write code (still use Write/Edit — rlmx doesn't write code)
3. **VALIDATE** — use rlmx to verify changes make sense in context
4. **GAP?** — if rlmx couldn't navigate or gave wrong answer:
   - Log the gap to `gaps.jsonl`
   - Pause current v0.3 group
   - Branch: `hotfix/rlmx-<gap-id>`
   - Fix rlmx (the tool itself)
   - Test the fix against the original question
   - Merge hotfix to dev, bump patch version
   - Resume v0.3 group

**Deliverables:**
- `rlmx.yaml` for the rlmx repo (self-referential config)
- `python/tools/codebase.py` — code navigation batteries (find_definition, list_files, etc.)
- `docs/dogfood-protocol.md` — the reusable orchestration loop
- `gaps.jsonl` — every gap found, with before/after evidence
- Patch releases: 0.2.1, 0.2.2, ... for each hotfix
- Final report: gaps found, patches applied, rlmx improvement metrics

### OUT
- No changes to the core RLM algorithm — gaps are fixed in tools, batteries, config, not the loop itself
- No skipping the dogfood constraint — if you want to Read a file, rlmx must do it
- No artificial gaps — only log real failures during real v0.3 work
- Write/Edit tools still allowed — rlmx is for reading/understanding, not writing code
- Bash still allowed for git, npm, test runners — rlmx replaces context navigation, not system commands

## The Dogfood Protocol

### Tool Substitution Table

| Task | Native Tool | rlmx Replacement | Fallback |
|------|------------|-------------------|----------|
| Read file contents | `Read(path)` | `rlmx "show the complete contents of src/config.ts" --context ./src/` | `show_file("src/config.ts")` battery |
| Search for pattern | `Grep(pattern)` | `rlmx "find every file that uses cacheRetention" --context ./src/` | `grep_context(pattern)` battery |
| Find files | `Glob(pattern)` | `rlmx "list all TypeScript files in src/" --context ./` | `list_files("src/", "*.ts")` battery |
| Explore codebase | `Agent(Explore)` | `rlmx "explain how the budget system works end to end" --context ./src/` | Full RLM loop with standard tools |
| Find definition | `Grep("function X")` | `rlmx "find the definition of llmComplete and show its signature" --context ./src/` | `find_definition("llmComplete")` battery |
| Understand changes | `Bash(git diff)` | `rlmx "what changed in the last 3 commits?" --context ./src/` | Still use git directly (not context nav) |

### Still Allowed (not context navigation)
- `Write` / `Edit` — rlmx reads, you write
- `Bash` for: git, npm, test runners, build commands, system ops
- `Bash` for: `rlmx` invocations themselves

### Gap Logging Format

```jsonl
{"id":"gap-001","timestamp":"2026-04-01T14:30:00Z","v03_group":1,"task":"understand cache.ts","native_tool":"Read","rlmx_query":"show contents of src/cache.ts","rlmx_answer":"[summarized, not exact]","expected":"exact file contents","gap_type":"precision","severity":"high","hotfix_branch":"hotfix/rlmx-raw-file-mode","status":"open"}
{"id":"gap-002","timestamp":"2026-04-01T15:00:00Z","v03_group":1,"task":"find all cacheRetention refs","native_tool":"Grep","rlmx_query":"find every use of cacheRetention","rlmx_answer":"found 3 of 5","expected":"all 5 references","gap_type":"recall","severity":"medium","hotfix_branch":"hotfix/rlmx-exhaustive-search","status":"fixed","patch":"0.2.1"}
```

### Gap Types

| Type | Meaning | Typical Fix |
|------|---------|-------------|
| `precision` | rlmx summarizes instead of giving exact content | Add `--raw` mode or `show_file()` battery |
| `recall` | rlmx misses matches that Grep would find | Improve search_context or add exhaustive mode |
| `speed` | rlmx takes 5s+ for something Read does in 10ms | Add fast-path battery or cache result |
| `hallucination` | rlmx invents code that doesn't exist | Improve system prompt grounding |
| `scope` | rlmx can't handle the query type at all | Add new battery or tool |
| `format` | rlmx returns answer but in unusable format | Improve criteria or add output mode |

### The Hotfix Loop

```bash
# v0.3 work in progress on feat/v03-cag branch...
# rlmx fails or underperforms → HOTFIX

# 1. Log the gap
./scripts/log-gap.sh --id gap-NNN --group N --task "..." --native-tool Read \
  --query "the rlmx query that failed" --answer "what rlmx returned" \
  --expected "what we needed" --type precision --severity high

# 2. Save v0.3 progress
git add -A && git stash push -m "v0.3-group-N-wip"

# 3. Branch for hotfix (from current v0.3 branch — includes all prior hotfixes)
CURRENT_BRANCH=$(git branch --show-current)
git checkout -b hotfix/rlmx-gap-NNN

# 4. Fix rlmx (edit batteries, tools, config, or core)
# ... make changes ...

# 5. Test: re-run the exact query that failed
rlmx "the original failing query" --context ./src/ --tools standard --output json
# Verify the answer is now correct

# 6. Run existing tests to prevent regressions
npm test

# 7. Commit the fix (DO NOT npm version patch — version bump happens at v0.3.0 release)
git add -A && git commit -m "fix: rlmx gap-NNN — <description>"

# 8. Merge hotfix back into v0.3 branch
git checkout "$CURRENT_BRANCH"
git merge --no-ff hotfix/rlmx-gap-NNN -m "merge: hotfix gap-NNN into v0.3"

# 9. Restore v0.3 progress
git stash pop
# If stash pop conflicts:
#   git checkout --theirs <conflicting-files>  # keep v0.3 WIP version
#   git add <files> && git stash drop
# If stash pop is unrecoverable:
#   git stash show -p | git apply --3way  # try 3-way merge
#   If still fails: manually reconstruct from stash diff

# 10. Update gap status
# Edit gaps.jsonl: set "status": "fixed", add "fix_commit": "<sha>"

# 11. Resume v0.3 group work

# ROLLBACK (if hotfix breaks things):
# Before merge: git checkout "$CURRENT_BRANCH" && git branch -D hotfix/rlmx-gap-NNN
# After merge: git revert <merge-commit-sha> -m 1
```

**Hotfix rules:**
- One hotfix in flight at a time (no concurrent hotfix branches)
- Max 30 minutes per hotfix — if exceeded, `./scripts/hotfix.sh` auto-logs as DEFERRED
- DEFERRED gaps go to post-v0.3 backlog, use native tool as temporary fallback
- Always run `npm test` before merging hotfix
- Hotfix priority: CRITICAL > HIGH > MEDIUM > LOW

## Decisions

| Decision | Rationale |
|----------|-----------|
| Write/Edit still allowed | rlmx is a context navigator, not a code generator. It reads and reasons, agents write. |
| Bash still allowed for system ops | git, npm, test runners are system commands, not context navigation. |
| Gap log as JSONL | Structured, appendable, queryable. Can generate reports from it. |
| Hotfix as patch releases (0.2.x) | Each fix is small, tested, and immediately usable. Don't accumulate fixes. |
| Hotfix merges into v0.3 branch | v0.3 always runs on the latest rlmx. Fixes compound. |
| Protocol documented as reusable | Any agent building a tool can follow this loop. Not rlmx-specific. |
| Custom codebase tools in TOOLS section | find_definition, show_file, list_files are rlmx-native — they use the REPL + context, not external tools. |

## Success Criteria

### Dogfood Infrastructure
- [ ] `rlmx.yaml` for rlmx repo answers "how does the RLM loop work?" correctly
- [ ] `show_file("src/rlm.ts")` returns exact file contents via REPL battery
- [ ] `find_definition("llmComplete")` finds the function with signature
- [ ] `list_files("src/", "*.ts")` returns all 11+ TypeScript files
- [ ] `grep_context("cacheRetention")` finds all references (verified against native Grep)

### Gap Discovery
- [ ] `gaps.jsonl` exists and logs every dogfood failure
- [ ] Each gap has: id, query, expected, actual, gap type, severity
- [ ] At least 1 hotfix patch shipped from dogfood discoveries (proves the loop works)
- [ ] All CRITICAL/HIGH gaps have hotfix branches

### Hotfix Loop
- [ ] Hotfix branch created, fixed, tested, merged — at least once (proves the workflow)
- [ ] Patch version bumped after each hotfix
- [ ] rlmx re-tested against the original failing query after each fix
- [ ] v0.3 work resumes cleanly after hotfix merge

### Protocol Documentation
- [ ] `docs/dogfood-protocol.md` exists in rlmx repo
- [ ] Documents: tool substitution table, gap logging, hotfix loop, orchestration flow
- [ ] Includes concrete examples from actual v0.3 dogfood gaps
- [ ] Reusable by any agent/tool — not rlmx-specific language

### v0.3 Completion
- [ ] v0.3 CAG features implemented using rlmx for ALL context navigation
- [ ] No native Read/Grep/Glob/Explore used for understanding code (Write/Edit/Bash still ok)
- [ ] Final report: total gaps found, fixed, remaining, improvement metrics

## Execution Strategy

### Wave 0 (bootstrap — before v0.3 starts)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | rlmx.yaml for rlmx repo + codebase navigation tools |
| 2 | engineer | Gap logging infrastructure + hotfix workflow scripts |
| review | reviewer | Verify rlmx can answer basic questions about its own codebase |

### Wave 1-3 (v0.3 execution — using dogfood protocol)
The v0.3 wish groups execute normally, but every context navigation uses rlmx.
Hotfixes interrupt and improve rlmx as gaps are discovered.
These are the v0.3 groups (from rlmx-v03-cag WISH.md), executed under dogfood constraint.

### Wave 4 (documentation + report)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `docs/dogfood-protocol.md` — reusable protocol with real examples |
| 4 | engineer | Final report: gaps found, patches applied, metrics, lessons |

## Execution Groups

### Group 1: Self-Referential Config
**Goal:** Make rlmx understand its own codebase via `rlmx.yaml` + custom codebase tools.

**Deliverables:**

1. **`rlmx.yaml`** in the rlmx repo root — self-referential config
   ```yaml
   model:
     provider: anthropic
     model: claude-sonnet-4-5
     sub-call-model: claude-haiku-4-5

   system: |
     You are navigating the rlmx codebase — an npm CLI that implements
     the RLM algorithm (REPL-LM). The codebase is TypeScript (src/) with
     a Python REPL subprocess (python/).

     Key architecture:
     - src/cli.ts: CLI entry point, arg parsing
     - src/rlm.ts: core RLM iteration loop
     - src/repl.ts: Python subprocess manager
     - src/llm.ts: pi/ai LLM client wrapper
     - src/config.ts: YAML config loader
     - src/budget.ts: cost/token/depth tracking
     - python/repl_server.py: Python REPL server
     - python/batteries.py: convenience functions

     When asked to show file contents, return the EXACT content.
     When asked to find references, be EXHAUSTIVE — find ALL matches.
     Always include file paths and line numbers in answers.
     {custom_tools_section}

   tools:
     show_file: |
       def show_file(path):
           """Return exact contents of a file from the context."""
           items = context if isinstance(context, list) else []
           if isinstance(context, str):
               return context  # single-file context, return as-is
           if not isinstance(context, list):
               return f"Error: context is {type(context).__name__}, expected list or str"
           # Exact match
           for item in items:
               p = item.get('path', '') if isinstance(item, dict) else ''
               if p == path or p.endswith('/' + path) or p.endswith(path):
                   return item.get('content', '')
           # Partial match (filename only)
           import os
           matches = [item for item in items if isinstance(item, dict) and os.path.basename(item.get('path', '')) == os.path.basename(path)]
           if len(matches) == 1:
               return matches[0].get('content', '')
           if len(matches) > 1:
               return f"Ambiguous: {len(matches)} files match '{path}': {[m['path'] for m in matches]}"
           available = sorted([item['path'] for item in items if isinstance(item, dict)])[:30]
           return f"File '{path}' not found. Available ({len(items)} files): {available}"

     find_definition: |
       def find_definition(name):
           """Find function/class/const definition across all files. Supports TS, JS, Python."""
           import re
           results = []
           items = context if isinstance(context, list) else [{"path": "stdin", "content": str(context)}]
           # Patterns for TS/JS/Python definitions
           patterns = [
               rf'(?:export\s+)?(?:async\s+)?function\s+{re.escape(name)}\b',
               rf'(?:export\s+)?(?:const|let|var)\s+{re.escape(name)}\b\s*=',
               rf'(?:export\s+)?class\s+{re.escape(name)}\b',
               rf'(?:export\s+)?interface\s+{re.escape(name)}\b',
               rf'(?:export\s+)?type\s+{re.escape(name)}\b\s*=',
               rf'^def\s+{re.escape(name)}\s*\(',
               rf'^class\s+{re.escape(name)}\s*[\(:]',
           ]
           combined = '|'.join(f'({p})' for p in patterns)
           for item in items:
               if not isinstance(item, dict):
                   continue
               content = item.get('content', '')
               lines = content.split('\n')
               for i, line in enumerate(lines, 1):
                   if re.search(combined, line):
                       results.append(f"{item['path']}:{i}: {line.strip()}")
           return '\n'.join(results) if results else f"Definition of '{name}' not found"

     find_references: |
       def find_references(name):
           """Find all references to a name across all files. Uses word boundary matching."""
           import re
           results = []
           items = context if isinstance(context, list) else [{"path": "stdin", "content": str(context)}]
           pattern = re.compile(rf'\b{re.escape(name)}\b')
           for item in items:
               if not isinstance(item, dict):
                   continue
               content = item.get('content', '')
               lines = content.split('\n')
               for i, line in enumerate(lines, 1):
                   if pattern.search(line):
                       results.append(f"{item['path']}:{i}: {line.strip()}")
           return '\n'.join(results) if results else f"No references to '{name}' found"

     list_files: |
       def list_files(directory="", ext=""):
           """List files in context, optionally filtered by directory and extension."""
           items = context if isinstance(context, list) else []
           if isinstance(context, str):
               return "(single-file context, no file listing available)"
           paths = [item.get('path', '') for item in items if isinstance(item, dict)]
           if directory:
               paths = [p for p in paths if p.startswith(directory) or ('/' + directory) in p]
           if ext:
               paths = [p for p in paths if p.endswith(ext)]
           return '\n'.join(sorted(paths)) if paths else f"No files found (directory='{directory}', ext='{ext}')"

     file_summary: |
       def file_summary(path):
           """Get a structural summary of a file: exports, functions, classes.
           Note: llm_query() is injected into the REPL namespace by rlmx core at startup.
           It is always available alongside context, FINAL, SHOW_VARS, etc."""
           content = show_file(path)
           if 'not found' in content.lower() or 'error' in content.lower():
               return content
           summary = llm_query(f"List every export, function, class, interface, and type in this file. Format as a bullet list with line numbers.\n\n{content}")
           return summary

   criteria: |
     When showing file contents: return EXACT text, no summarization.
     When finding references: return ALL matches with file:line format.
     When explaining code: cite specific file paths and line numbers.
     Include confidence level if answer is uncertain.

   context:
     extensions: [.ts, .py, .json, .md, .yaml]
     exclude: [node_modules, dist, .git, __pycache__, .tgz]

   budget:
     max-cost: 0.50
     max-tokens: 30000
     max-depth: 2
     timeout: 120000

   tools-level: standard
   ```

2. **Validation: rlmx can navigate itself**
   ```bash
   rlmx "what files are in src/?" --context ./src/ --tools standard --output json
   rlmx "show the contents of src/ipc.ts" --context ./src/ --tools standard
   rlmx "find the definition of rlmLoop" --context ./src/ --tools standard
   ```

**Acceptance Criteria:**
- [ ] `rlmx.yaml` parses and rlmx runs against its own codebase
- [ ] `show_file("ipc.ts")` returns exact file contents
- [ ] `find_definition("rlmLoop")` returns `src/rlm.ts` with line number
- [ ] `list_files("src/", ".ts")` returns all TS source files
- [ ] `find_references("completeSimple")` finds all call sites (verified against `grep -rn completeSimple src/`)
- [ ] Baseline test query set (10 queries) established and scored before v0.3 starts

**Validation:**
```bash
cd /home/genie/research/rlmx && rlmx "find the definition of rlmLoop and show its full signature" --context ./src/ --tools standard --output json 2>/dev/null | python3 -c "import sys,json; r=json.load(sys.stdin); print('PASS' if 'rlmLoop' in r.get('answer','') and 'rlm.ts' in r.get('answer','') else 'FAIL')"
```

**depends-on:** rlmx v0.2.0 released

---

### Group 2: Gap Infrastructure
**Goal:** Set up structured gap logging and hotfix workflow automation.

**Deliverables:**

1. **`scripts/log-gap.sh`** — CLI for logging gaps
   ```bash
   ./scripts/log-gap.sh \
     --id gap-001 \
     --group 1 \
     --task "understand cache.ts" \
     --native-tool Read \
     --query "show contents of src/cache.ts" \
     --answer "[summarized]" \
     --expected "exact contents" \
     --type precision \
     --severity high
   ```
   Validates required fields (id, timestamp, v03_group, task, native_tool, rlmx_query, answer, expected, type, severity) and enum values (type: precision|recall|speed|hallucination|scope|format; severity: critical|high|medium|low) before appending. Rejects malformed entries with error.
   Appends to `gaps.jsonl`.

2. **`scripts/hotfix.sh`** — Hotfix workflow automation with 30min timeout
   ```bash
   ./scripts/hotfix.sh start gap-001    # stash, branch hotfix/rlmx-gap-001, start 30min timer
   ./scripts/hotfix.sh test gap-001     # re-run original rlmx query from gaps.jsonl
   ./scripts/hotfix.sh finish gap-001   # run tests, merge, pop stash, resume
   # If 30min exceeded: auto-logs as DEFERRED, aborts hotfix branch, pops stash, resumes v0.3
   ```
   Includes: branch existence checks, `npm test` before merge, stash pop conflict handling (--3way fallback), rollback on test failure.

3. **`scripts/gap-report.sh`** — Generate gap summary
   ```bash
   ./scripts/gap-report.sh              # summary: open/fixed/total by type and severity
   ```

**Acceptance Criteria:**
- [ ] `log-gap.sh` appends valid JSONL to `gaps.jsonl`
- [ ] `hotfix.sh start` creates branch and stashes work
- [ ] `hotfix.sh finish` merges, bumps version, pops stash
- [ ] `gap-report.sh` produces readable summary

**Validation:**
```bash
cd /home/genie/research/rlmx && ./scripts/log-gap.sh --id test-001 --group 0 --task "test" --native-tool Read --query "test" --answer "test" --expected "test" --type precision --severity low && python3 -c "import json; json.loads(open('gaps.jsonl').readline()); print('PASS')"
```

**depends-on:** none

---

### Group 3: Dogfood Protocol Documentation
**Goal:** Document the complete orchestration loop as a reusable protocol.

**Deliverables:**

1. **`docs/dogfood-protocol.md`** — The complete protocol
   - Introduction: why dogfooding works, the self-improving loop
   - Tool substitution table (with concrete examples from v0.3)
   - Gap logging format and taxonomy
   - Hotfix loop: step-by-step with git commands
   - Orchestration flow diagram (ASCII)
   - Metrics to track: gaps/day, fix time, rlmx improvement rate
   - Reuse guide: "Adapting to YOUR Tool" section — step-by-step for any agent/tool, not rlmx-specific, with hypothetical example
   - Metrics definition: success rate (correct answers / total queries), fix time per gap, v0.3-to-hotfix time ratio
   - Baseline test query set: 10 standard queries run before and after each hotfix to measure improvement
   - Appendix: actual gaps found during v0.3 (populated during execution)

**Acceptance Criteria:**
- [ ] Protocol document exists and is comprehensive
- [ ] Includes real examples (at least 3) from actual v0.3 dogfood gaps
- [ ] Tool substitution table covers Read, Grep, Glob, Agent/Explore
- [ ] Hotfix loop has runnable git commands
- [ ] Protocol is tool-agnostic (reusable for any agent, not just rlmx)

**Validation:**
```bash
cd /home/genie/research/rlmx && test -f docs/dogfood-protocol.md && grep -q "Tool Substitution" docs/dogfood-protocol.md && grep -q "Hotfix Loop" docs/dogfood-protocol.md && grep -q "Gap Log" docs/dogfood-protocol.md && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1 (needs real rlmx.yaml), populated with real examples after v0.3 groups run

---

### Group 4: Final Report
**Goal:** Compile dogfood results into a metrics report.

**Deliverables:**

1. **`docs/dogfood-report.md`** — Execution report
   - Total gaps found (by type, severity)
   - Patches released (0.2.1, 0.2.2, ...)
   - Before/after: rlmx accuracy on its own codebase
   - Query examples: what rlmx couldn't do before vs after
   - Time spent: v0.3 work vs hotfix work (ratio)
   - Lessons learned: what made the loop efficient or slow
   - Recommendations for v0.4

**Acceptance Criteria:**
- [ ] Report includes quantitative gap metrics
- [ ] At least 1 before/after comparison showing rlmx improvement
- [ ] Hotfix patch count documented
- [ ] Recommendations for next version

**Validation:**
```bash
cd /home/genie/research/rlmx && test -f docs/dogfood-report.md && grep -q "gaps" docs/dogfood-report.md && echo "PASS" || echo "FAIL"
```

**depends-on:** v0.3 completion, all gaps logged

---

## Orchestration Flow (the reusable protocol)

```
┌─────────────────────────────────────────────────────────┐
│  THE DOGFOOD LOOP                                        │
│                                                          │
│  ┌──────────┐    ┌───────────┐    ┌──────────┐          │
│  │ NAVIGATE │───→│ IMPLEMENT │───→│ VALIDATE │          │
│  │ (rlmx)   │    │ (Write/   │    │ (rlmx +  │          │
│  │          │    │  Edit)    │    │  tests)  │          │
│  └────┬─────┘    └───────────┘    └────┬─────┘          │
│       │                                │                 │
│       │ rlmx fails?                    │ rlmx fails?     │
│       ▼                                ▼                 │
│  ┌──────────────────────────────────────────┐            │
│  │              GAP DETECTED                 │            │
│  │                                          │            │
│  │  1. Log gap → gaps.jsonl                 │            │
│  │  2. git stash (save v0.3 work)           │            │
│  │  3. git checkout -b hotfix/rlmx-<id>     │            │
│  │  4. Fix rlmx (battery/tool/config/core)  │            │
│  │  5. Test: re-run failing query           │            │
│  │  6. npm version patch                    │            │
│  │  7. Merge hotfix → v0.3 branch           │            │
│  │  8. git stash pop                        │            │
│  │  9. Update gap → "fixed"                 │            │
│  │  10. RESUME                              │            │
│  └──────────────────────────────────────────┘            │
│                                                          │
│  Metrics tracked:                                        │
│  - Gaps found per group                                  │
│  - Fix time per gap                                      │
│  - rlmx accuracy before/after each patch                 │
│  - Ratio: v0.3 work time vs hotfix time                  │
│                                                          │
│  Exit: v0.3 complete + all CRITICAL gaps fixed           │
└─────────────────────────────────────────────────────────┘
```

## QA Criteria

- [ ] rlmx can answer "how does the budget system work?" about its own codebase
- [ ] All v0.3 groups completed with zero native Read/Grep/Glob for context navigation
- [ ] gaps.jsonl has structured entries for every failure
- [ ] At least 1 hotfix patch proves the loop works end-to-end
- [ ] Protocol doc is reusable by another team

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| rlmx too slow for rapid iteration | High | Add fast-path batteries (show_file, list_files). Accept 2-5s for complex queries. |
| Too many gaps → v0.3 never finishes | High | Cap hotfix time at 30min per gap. If > 30min, log as DEFERRED and use native tool. |
| rlmx hallucinates code structure | Medium | System prompt includes real architecture. Criteria demands exact content + file paths. |
| Hotfix loop adds overhead | Medium | Automation scripts (hotfix.sh) minimize ceremony. Each fix is <50 lines. |
| Some queries genuinely need native tools | Low | Write/Edit/Bash for system ops explicitly allowed. Only context nav is dogfooded. |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
# In rlmx repo (/home/genie/research/rlmx/)
CREATE  rlmx.yaml                          — self-referential config for dogfooding
CREATE  scripts/log-gap.sh                  — gap logging CLI
CREATE  scripts/hotfix.sh                   — hotfix workflow automation
CREATE  scripts/gap-report.sh               — gap summary generator
CREATE  gaps.jsonl                          — gap log (populated during execution)
CREATE  docs/dogfood-protocol.md            — reusable protocol documentation
CREATE  docs/dogfood-report.md              — final execution report
MODIFY  python/batteries.py                 — add show_file, find_definition, find_references, list_files if not in TOOLS
MODIFY  package.json                        — patch versions from hotfixes
```
