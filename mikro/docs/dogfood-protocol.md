# Dogfood Protocol — Self-Improving Tool Development

A reusable protocol for any agent or tool team that wants to build better software by using their own tool as the primary development interface.

## Overview

The dogfood loop is a structured methodology where you develop a tool while simultaneously using it. Every failure becomes a patch. Every patch improves the next development cycle. The tool and its features co-evolve.

```
    NAVIGATE          IMPLEMENT         VALIDATE
   (your tool) ────→ (write code) ────→ (your tool)
       │                                    │
       │ tool fails?                        │ tool fails?
       ▼                                    ▼
  ┌──────────────────────────────────────────────┐
  │              GAP DETECTED                     │
  │                                              │
  │  1. Log gap → gaps.jsonl                     │
  │  2. Stash current work                       │
  │  3. Branch: hotfix/<gap-id>                  │
  │  4. Fix the tool                             │
  │  5. Test: re-run failing query               │
  │  6. Merge hotfix → feature branch            │
  │  7. Pop stash, resume                        │
  └──────────────────────────────────────────────┘
```

## Tool Substitution Table

Replace native development tools with your own tool for all **context navigation** tasks. Writing code and running system commands are still allowed.

| Task | Native Tool | Your Tool Replacement | Fallback |
|------|------------|----------------------|----------|
| Read file contents | `cat`, `Read` | `yourtool "show contents of src/config.ts"` | `show_file()` battery |
| Search for pattern | `grep`, `Grep` | `yourtool "find every file using cacheRetention"` | `grep_context()` battery |
| Find files | `find`, `Glob` | `yourtool "list all TypeScript files in src/"` | `list_files()` battery |
| Explore codebase | Agent/Explore | `yourtool "explain how the budget system works"` | Full iterative loop |
| Find definition | `grep "function X"` | `yourtool "find definition of llmComplete"` | `find_definition()` battery |

### Still Allowed (not context navigation)
- **Code writing** — your tool reads, you write
- **System commands** — git, npm, test runners, build tools
- **Your tool invocations** — running the tool itself via CLI

## Gap Logging

Every time your tool fails or underperforms during development, log it.

### Format (JSONL)

```jsonl
{"id":"gap-001","timestamp":"2026-03-26T14:30:00Z","group":1,"task":"understand cache.ts","native_tool":"Read","mikro_query":"show contents of src/cache.ts","answer":"[summarized, not exact]","expected":"exact file contents","gap_type":"precision","severity":"high","status":"open"}
```

### Gap Types

| Type | Meaning | Typical Fix |
|------|---------|-------------|
| `precision` | Tool summarizes instead of exact content | Add raw/verbatim mode |
| `recall` | Tool misses matches that grep would find | Improve exhaustive search |
| `speed` | Tool takes 5s+ for something native does in 10ms | Add fast-path or cache |
| `hallucination` | Tool invents content that doesn't exist | Improve grounding in system prompt |
| `scope` | Tool can't handle the query type at all | Add new capability |
| `format` | Tool returns answer in unusable format | Improve output formatting |

### Severity Levels
- **critical** — Blocks development, no workaround
- **high** — Significantly slows development
- **medium** — Workaround exists but adds friction
- **low** — Minor inconvenience

## Hotfix Loop

When a gap is detected, pause feature work and fix the tool.

```bash
# 1. Log the gap
./scripts/log-gap.sh --id gap-NNN --group N --task "..." \
  --native-tool Read --query "the failing query" \
  --answer "what the tool returned" --expected "what was needed" \
  --type precision --severity high

# 2. Stash feature work
git stash push -m "feature-group-N-wip"

# 3. Branch for hotfix
git checkout -b hotfix/tool-gap-NNN

# 4. Fix the tool
# ... make changes ...

# 5. Test: re-run the exact query that failed
yourtool "the original failing query" --context ./src/

# 6. Run existing tests
npm test

# 7. Commit the fix
git add -A && git commit -m "fix: gap-NNN — description"

# 8. Merge back
git checkout feature-branch
git merge --no-ff hotfix/tool-gap-NNN

# 9. Restore feature work
git stash pop

# 10. Update gap status in gaps.jsonl → "fixed"
```

### Rules
- **One hotfix at a time** — no concurrent hotfix branches
- **30-minute cap** — if a fix takes longer, log as DEFERRED and use native tool as fallback
- **Always test before merging** — run the full test suite
- **Re-run the failing query** — prove the fix works on the original problem

### Rollback
```bash
# Before merge:
git checkout feature-branch && git branch -D hotfix/tool-gap-NNN

# After merge:
git revert <merge-commit-sha> -m 1
```

## Metrics

Track these to measure the loop's effectiveness:

| Metric | How to Measure |
|--------|---------------|
| **Gaps per group** | Count entries in gaps.jsonl per execution group |
| **Fix time** | Timestamp delta between gap open and fixed |
| **Success rate** | Correct answers / total queries (baseline test set) |
| **Work ratio** | Feature development time / hotfix time |
| **Gap decline rate** | Gaps in group N vs group N+1 (should decrease) |

### Baseline Test Set

Before starting feature work, establish 10 standard queries that exercise your tool's core capabilities. Run them before and after each hotfix to measure improvement:

1. List all files in a directory
2. Show exact contents of a specific file
3. Find a function definition
4. Find all references to a name
5. Explain how a subsystem works
6. Search for a pattern across all files
7. Summarize a file's structure
8. Trace a call chain
9. Compare two files
10. Answer a question requiring multi-file understanding

## Adapting to YOUR Tool

This protocol is not specific to any tool. Here's how to adapt it:

### Step 1: Define your substitution table
What native tools does your tool replace? Map each one.

### Step 2: Configure your tool for its own codebase
Your tool should be able to navigate its own source code. Create whatever config is needed.

### Step 3: Set up gap infrastructure
Create `gaps.jsonl` and scripts for logging, hotfixing, and reporting.

### Step 4: Start feature work under constraint
Pick your next feature. Do ALL context navigation through your tool. Log every failure.

### Step 5: Fix and iterate
Each gap becomes a hotfix. Each hotfix makes the next development cycle smoother.

### Hypothetical Example: A Code Search Tool

Suppose you're building `codesearch`, a semantic code search CLI:

1. **Substitution**: Replace `grep`, `find`, `cat` with `codesearch "query"`
2. **Self-config**: `codesearch index ./src/` on its own repo
3. **Feature work**: Implement "fuzzy matching" using `codesearch` to navigate the codebase
4. **Gap found**: `codesearch "find the ranking function"` returns wrong file
5. **Hotfix**: Improve relevance scoring
6. **Resume**: Fuzzy matching feature now benefits from better search

## Real Examples from mikro v0.3 Dogfood

### Gap: Context loading returns 0 items
- **Query**: `mikro cache --context ./src/ --estimate`
- **Expected**: Token count for all .ts files in src/
- **Actual**: "0 items, 0 tokens"
- **Root cause**: Config extension filtering not applied in cache command
- **Type**: scope | **Severity**: medium
- **Fix**: Pass config context extensions through to loadContext in runCache

### Gap: No API key for LLM validation
- **Query**: `mikro "list files" --context ./src/ --tools standard`
- **Expected**: LLM-powered answer about the codebase
- **Actual**: Empty answer, 0 tokens, 31 failed LLM calls
- **Root cause**: No ANTHROPIC_API_KEY in environment; model switched to Gemini
- **Type**: scope | **Severity**: high
- **Fix**: Changed default provider to Google (gemini-3.1-flash-lite-preview) with available GEMINI_API_KEY

### Gap: Test assertions hardcoded to old default model
- **Query**: `npm test` after changing default model
- **Expected**: All tests pass
- **Actual**: 2 failures checking for "anthropic" provider
- **Root cause**: Tests hardcoded old default instead of reading from config
- **Type**: format | **Severity**: low
- **Fix**: Updated test expectations to match new google default

## Appendix: Gap Summary Template

```
Dogfood Report — [Tool Name] v[X.Y]
═══════════════════════════════════════

Total gaps:     N
  Open:         N
  Fixed:        N
  Deferred:     N

By type:
  precision:    N
  recall:       N
  speed:        N
  hallucination: N
  scope:        N
  format:       N

By severity:
  critical:     N
  high:         N
  medium:       N
  low:          N

Fix rate:       N% (fixed / total)
Avg fix time:   Nm (minutes per hotfix)
Work ratio:     N:1 (feature time : hotfix time)
```
