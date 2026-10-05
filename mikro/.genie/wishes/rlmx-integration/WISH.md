# Wish: rlmx Integration Testing + npm Publish — Make It Real

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `rlmx-integration` |
| **Date** | 2026-03-27 |
| **Design** | None — this is the "verify what we built" wish |
| **Repo** | `/home/genie/research/rlmx/` |

## Summary

Stop building features. Start verifying they work. rlmx has v0.2-v0.4 code committed but most features have never been tested against live APIs. This wish runs every feature against real endpoints, fixes what breaks, publishes a stable version to npm, and creates a test suite that prevents regressions. Nothing new gets added — only what exists gets proven.

## Scope

### IN

**Phase 1: Core verification (must work or rlmx is useless)**
1. `npm publish` v0.2.0 to npm registry — verify `npx rlmx --help` works
2. `rlmx init` creates valid rlmx.yaml
3. `rlmx "What is 2+2?" --output json` returns valid JSON with answer (Gemini flash-lite)
4. `rlmx "query" --context ./src/ --tools standard` loads context + uses batteries
5. `rlmx "query" --stats` produces stats on stderr
6. `rlmx "query" --log /tmp/run.jsonl` writes valid JSONL
7. Budget controls: `--max-cost 0.01` stops the run
8. Python 3.10+ check: graceful error on wrong version
9. REPL crash recovery: kill subprocess mid-run, verify restart

**Phase 2: CAG verification (v0.3 features)**
10. `--cache` puts full context in system prompt (verified by token count increase)
11. Second query with `--cache` shows cache hit in stats (Anthropic or Gemini)
12. `rlmx batch questions.txt --cache` processes multiple questions
13. `rlmx cache --estimate` shows token count and cost estimate
14. Cache TTL config parsed and passed to provider

**Phase 3: Gemini 3 verification (v0.4 features)**
15. `--thinking minimal` vs `--thinking high` shows different token counts
16. Thought signatures circulate across 5+ iterations (no 400 errors)
17. Structured output with `output.schema` forces valid JSON from API
18. `web_search()` battery returns real Google Search results in REPL
19. `fetch_url()` battery returns page content in REPL
20. `gemini.code-execution: true` enables server-side code execution
21. Media resolution config changes token count for image context
22. Graceful degradation: Gemini features silently ignored on Anthropic provider

**Phase 4: Ship**
23. Fix every bug found in phases 1-3
24. Update version to reflect actual stable state
25. `npm publish` final stable version
26. README Quick Start verified end-to-end on clean environment

### OUT
- No new features — only verify and fix what exists
- No README rewrite (separate wish)
- No new batteries or tools
- No architecture changes
- No performance optimization

## Decisions

| Decision | Rationale |
|----------|-----------|
| Test against REAL APIs, not mocks | Mocks pass, prod fails. Learned this the hard way — v0.3/v0.4 have zero live testing. |
| Fix bugs inline during testing | Don't create separate fix wishes. Find bug → fix → retest → move on. |
| Publish v0.2 first, then v0.3/v0.4 | v0.2 is most tested (dogfood + unit tests). Get it on npm. Then validate and publish advanced versions. |
| Test Gemini AND Anthropic | Multi-provider is a promise. Must verify at least 2 providers work. |
| Each test is a bash script | Reproducible, runnable by CI, no test framework needed for integration tests. |

## Success Criteria

- [ ] `npx rlmx@latest --help` works from clean npm install
- [ ] All 22 feature tests pass against live APIs
- [ ] All bugs found are fixed and retested
- [ ] Stable version published on npm
- [ ] Integration test scripts committed to `tests/integration/`

## Execution Strategy

### Wave 1 (sequential — core must work first)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Core verification: tests 1-9 against live Gemini API |

### Wave 2 (sequential — after core passes)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | CAG verification: tests 10-14 against live Gemini/Anthropic API |

### Wave 3 (sequential — after CAG passes)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Gemini 3 verification: tests 15-22 against live Gemini API |

### Wave 4 (ship)
| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Fix all bugs, npm publish stable version, commit integration test scripts |
| review | reviewer | Verify npm install works, Quick Start works, all tests scripted |

## Execution Groups

### Group 1: Core Verification (Tests 1-9)
**Goal:** Prove rlmx core works end-to-end against a real LLM.

**Deliverables:**
1. **`tests/integration/01-core.sh`** — script running tests 1-9:
   ```bash
   # 1. npm pack + install locally
   # 2. rlmx init → verify rlmx.yaml created
   # 3. rlmx "2+2" --output json → parse answer
   # 4. rlmx "query" --context ./src/ → verify items loaded
   # 5. rlmx "query" --stats → verify stderr JSON
   # 6. rlmx "query" --log /tmp/run.jsonl → verify JSONL
   # 7. rlmx "query" --max-cost 0.001 → verify budget stops run
   # 8. Python version check → verify graceful error
   # 9. REPL crash recovery → kill -9 python3 mid-run, verify recovery
   ```
2. **Bug fixes** for every failure found
3. **`npm publish --access public`** of v0.2.0 after all 9 pass

**Acceptance Criteria:**
- [ ] All 9 tests pass against live Gemini API
- [ ] `npm install -g rlmx` works after publish
- [ ] `npx rlmx --help` shows help from npm registry
- [ ] Bugs found are committed as fixes

**Validation:**
```bash
cd /home/genie/research/rlmx && bash tests/integration/01-core.sh && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 2: CAG Verification (Tests 10-14)
**Goal:** Prove --cache mode and batch work against real provider caching.

**Deliverables:**
1. **`tests/integration/02-cag.sh`** — script running tests 10-14:
   ```bash
   # 10. --cache → verify token count > non-cache (full context in prompt)
   # 11. Second --cache query → verify stats show cache hit
   # 12. rlmx batch questions.txt --cache → verify JSONL output
   # 13. rlmx cache --estimate → verify token count output
   # 14. Cache TTL in rlmx.yaml → verify no errors
   ```
2. **Bug fixes** for every failure
3. Test against both Gemini (primary) and Anthropic (secondary) if API keys available

**Acceptance Criteria:**
- [ ] Cache mode puts full context in system prompt (verified by token delta)
- [ ] Cache hit reported in stats on second query
- [ ] Batch processes 3+ questions with JSONL output
- [ ] --estimate shows token count without querying

**Validation:**
```bash
cd /home/genie/research/rlmx && bash tests/integration/02-cag.sh && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1 (core must work first)

---

### Group 3: Gemini 3 Verification (Tests 15-22)
**Goal:** Prove v0.4 Gemini-specific features work against live Gemini 3 API.

**Deliverables:**
1. **`tests/integration/03-gemini3.sh`** — script running tests 15-22:
   ```bash
   # 15. --thinking minimal vs high → compare output tokens
   # 16. Thought signatures → 5+ iteration run, no 400 errors
   # 17. Structured output → output.schema forces valid JSON
   # 18. web_search() → returns real search results
   # 19. fetch_url() → returns page content
   # 20. code-execution → server-side Python works
   # 21. media-resolution → image token count changes
   # 22. Anthropic graceful degradation → gemini: section ignored
   ```
2. **Bug fixes** for every failure
3. Features that genuinely don't work: documented as "preview" in README, not silently broken

**Acceptance Criteria:**
- [ ] Thinking levels produce different token counts
- [ ] 5+ iteration run completes without signature errors
- [ ] Structured output returns valid JSON matching schema
- [ ] web_search returns real results (or documented as requires API setup)
- [ ] Anthropic provider: zero errors when gemini section present

**Validation:**
```bash
cd /home/genie/research/rlmx && bash tests/integration/03-gemini3.sh && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 2 (CAG must work — Gemini features build on it)

---

### Group 4: Ship
**Goal:** Publish stable version with all integration tests passing.

**Deliverables:**
1. All bugs from Groups 1-3 fixed and committed
2. Version number reflects actual stability:
   - If all 22 tests pass: publish as v0.4.0
   - If only core + CAG pass: publish as v0.3.0, mark Gemini features as preview
   - If only core passes: publish as v0.2.0, mark CAG + Gemini as preview
3. `npm publish --access public`
4. Verify: `npx rlmx@latest --version` shows correct version
5. Run Quick Start on a completely clean directory

**Acceptance Criteria:**
- [ ] Stable version published to npm
- [ ] Version number matches actual working feature set
- [ ] `npx rlmx@latest --help` works
- [ ] Quick Start (init + query) works from npm install
- [ ] All integration test scripts committed to `tests/integration/`

**Validation:**
```bash
npx rlmx@latest --version && npx rlmx@latest init --dir /tmp/rlmx-verify && cd /tmp/rlmx-verify && npx rlmx@latest "What is 2+2?" --output json | python3 -c "import sys,json; r=json.load(sys.stdin); print('PASS' if r.get('answer') else 'FAIL')"
```

**depends-on:** Group 1, Group 2, Group 3

---

## QA Criteria

- [ ] `npm install -g rlmx` from npm registry works on clean machine
- [ ] Quick Start in README produces a valid answer
- [ ] Integration test scripts are reproducible (run twice, same result)
- [ ] No silent failures — every broken feature either fixed or documented as preview
- [ ] Multi-provider: at least Gemini works. Anthropic tested if key available.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Gemini API rate limits during testing | Medium | Use flash-lite (free tier). Space out tests. Budget controls prevent runaway. |
| npm name `rlmx` taken | High | Check first. Fallback: `@automagik/rlmx`. |
| v0.3/v0.4 code is fundamentally broken | High | Version number reflects reality. If only core works, publish v0.2.0. |
| API keys not available for all providers | Medium | Test Gemini (free tier). Anthropic optional. Document which providers are verified. |
| web_search/fetch_url require Google Cloud setup | Medium | If they need extra setup beyond API key, document as "requires Google Cloud project" — not broken, just needs config. |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
CREATE  tests/integration/01-core.sh        — core feature tests (9 tests)
CREATE  tests/integration/02-cag.sh         — CAG cache tests (5 tests)
CREATE  tests/integration/03-gemini3.sh     — Gemini 3 feature tests (8 tests)
CREATE  tests/integration/README.md         — how to run integration tests
MODIFY  package.json                        — version based on what passes
MODIFY  src/*.ts                            — bug fixes found during testing
MODIFY  python/*.py                         — bug fixes found during testing
```
