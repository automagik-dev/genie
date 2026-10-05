# Criterion-1 judgements — rlmx-v2-prime-backend gate (Group 3)

Rubric criterion 1 (frozen, `docs/parity-explore.md`): the answer states at
least ⌈0.9 × N⌉ of the checklist facts. "A fact counts as stated when the
answer makes the same claim; wording may differ, the anchor may not." It is a
claim-level judgement, so it is judged rather than computed — following the
frozen doc's own convention, two readings were scored per fact:

- **strict** — the claim's named subject (its file or symbol) must appear;
- **generous** — claim substance only; added detail not required.

Both columns are printed; where a task verdict differs between the readings it
is disclosed. The gate verdict uses the **generous** column (the historical
matrix's judged outcomes used the generous column; the strict column is
strictly lower, so no verdict depends on this choice — under the strict column
every task that fails below fails as well).

Judgements by the gate engineer from the run answers under
`gate-agents/runs/gate-v2-<leg>/task-<n>.json`, 2026-08-16. The mechanical
half (criteria 2 and 3) is in the `.score.json` files beside the runs.

## Legacy (`backend: rlmx`)

### Task 1 — need 13/14

| Fact | Strict | Generous | Note |
|---|---|---|---|
| F1 rlmx-config.ts hardcoded provider/model | no | no | answer covers analyze/autoschema/bridge, never rlmx-config.ts |
| F2 rlmx-bridge google + modelId default | no | no | bridge named for SDK/loop only, not the default line |
| F3 scaffold.ts scaffolds model | no | no | not mentioned |
| F4 answer-judge LLM-as-judge GEMINI_API_KEY | no | no | not mentioned |
| F5 image.ts callGeminiVision + BRAIN_VISION_MODEL + ver.py | no | **yes** | model default + env override + fallback stated (lines 45-62); symbol absent |
| F6 ask-pipeline RLMX_API_KEY_ENV_MAP | no | no | not mentioned |
| F7 cache.ts gpt-4o-mini/claude-3.5-sonnet pricing | no | no | answer claims no OpenAI/Anthropic usage at all |
| F8 embed_dims 768 schema defaults (005-brain-embeddings.sql) | no | no | dims default stated for embedding.ts:29 only; the migration-column claim absent (answer admits it did not enumerate migration SQL) |
| F9 EMBEDDED_MIGRATIONS (db.ts) | no | no | migration runner named; embedding claim absent |
| F10 pgserve three DeploymentMode values | **yes** | **yes** | quoted verbatim with line 16 |
| F11 MNEMOSYNE_EMBEDDING_API_URL | no | no | not mentioned |
| F12 _llm_backend local LLM consolidation | no | no | different claim (kv-slot CAG), the mnemosyne consolidation backend absent |
| F13 docs naming Ollama/llama.cpp/vLLM | no | no | answer asserts "No Ollama references found" |
| F14 ASSESSMENT.md "brain lacks MCP…" | no | no | not mentioned |

**Task 1: FAIL** (strict 1/14, generous 2/14 — need 13).

### Task 2 — need 9/10

| Fact | Strict | Generous | Note |
|---|---|---|---|
| F1 runtime-integrations childCwd = process.cwd() | no | no | validator's forbiddenRoots discussed; the cwd-feeding wiring absent |
| F2 install.ts codexFailed → agent-sync skip | **yes** | **yes** | quoted with lines 369-377 and the skip message |
| F3 syncOneSkill digest record | **yes** | **yes** | named with sourceDigest computation |
| F4 doctor summarizeManagedSkills digest equality | **yes** | **yes** | the exact `sourceDigest === managedDigest && computeDirDigest(dir) === managedDigest` condition stated |
| F5 council.js template unstamped __GENIE_LENS_ROOT__ | no | **yes** | stamping mechanism stated in full; template file not named |
| F6 stampWorkflowTemplate | **yes** | **yes** | named with replacement semantics |
| F7 councilStampState | **yes** | **yes** | named with the single-vs-double-quote regex mismatch |
| F8 isInteractive sole consumer | **yes** | **yes** | named with line 25 and the flag check |
| F9 uninstallCommand never calls isInteractive | **yes** | **yes** | stated with lines 3649-3650 |
| F10 auto-mode codex failure skips claude/hermes too | **yes** | **yes** | "agent-sync for ALL agents (claude/hermes too) is skipped" |

**Task 2: strict 8/10 FAIL · generous 9/10 PASS** — the one verdict that differs
between the readings (F5's template file is the strict subject). Committed
convention: generous → **PASS**.

### Task 3 — need 10/11

| Fact | Strict | Generous | Note |
|---|---|---|---|
| F1 state.httpServer = Bun.serve | no | **yes** | Bun.serve + startBrainServer stated (446-450); state var absent |
| F2 default port 3847 | no | no | not mentioned |
| F3 handleRequest first-class routes | **yes** | **yes** | named with route inventory |
| F4 POST /api/search (bench routes) | no | **yes** | "/api/search … mounted via src/bench/routes/*" stated; method/file absent |
| F5 POST /api/brains/:id/ask | no | no | not mentioned |
| F6 extractPrincipal never enforced | **yes** | **yes** | "extraction NEVER denies, throws, or alters a response" quoted |
| F7 BRAIN_KHORTEX_PORT / BRAIN_ENDPOINT | no | no | not mentioned |
| F8 getDb at ~12 sites / 52 modules DSN-direct | no | no | DSN-direct fallbacks stated per verb; the import-sites claim absent |
| F9 DATABASE_URL readPrimaryDsn + admin DSN | no | **yes** | "DSN comes from DATABASE_URL env var … admin operations use BRAIN_ADMIN_DATABASE_URL" (in the MCP/CLI context) |
| F10 khortex-mcp-bin stdio entry | no | **yes** | stdio MCP + direct Postgres stated; entry file absent |
| F11 discoverHookBaseUrl hook speaks HTTP | no | no | not mentioned |

**Task 3: FAIL** (strict 2/11, generous 6/11 — need 10).

### Task 4 — need 11/12

| Fact | Strict | Generous | Note |
|---|---|---|---|
| F1 identity.ts perBrainDb + ensureBrainDatabase | **yes** | **yes** | line 115 quoted verbatim with the full flow |
| F2 init/lazy-init/server deriveDatabaseName call sites | no | no | definition + identity usage only; the three call sites absent |
| F3 lazy-init/server const database = deriveDatabaseName | no | no | same |
| F4 server.ts:261 const database = deriveDatabaseName | no | no | same |
| F5 db.ts CREATE DATABASE, no OWNER clause | no | **yes** | "CREATE DATABASE … against an admin DSN" stated; the no-OWNER-clause wording absent |
| F6 RUNBOOK validation brain + vault | no | no | brain_station_validation inferred; runbook anchor absent |
| F7 registry-db per-brain DB doubles as registry | no | no | shared registry vs per-brain stated; the doubling nuance absent |
| F8 ~/.brain/config.json records database not DSN | no | no | not mentioned |
| F9 rls.ts roleNameFor | no | **yes** | "dedicated Postgres role: brain_<short_name> (rls.ts:26-28)" — symbol absent |
| F10 withBrainRole SET LOCAL ROLE | no | **yes** | "NOINHERIT NOLOGIN … used via SET ROLE" stated; withBrainRole absent |
| F11 applyBrainGrants + ensureDefaultPrivileges | no | no | "role + grants installed" quoted in passing only |
| F12 DRAFT.md future-design-goal phrasing | no | no | answer takes the opposite framing (TRUE as current behavior) |

**Task 4: FAIL** (strict 1/12, generous 4/12 — need 11).

### Task 5 — need 5/5

The run hit the 24-iteration cap and the forced-final answer is an in-progress
search fragment (1078 chars, "Let me verify lines 640-660…" + a repl block).
No fact's claim is made. **Task 5: FAIL** (0/5 both readings).

### Task 6 — need 8/8

| Fact | Strict | Generous | Note |
|---|---|---|---|
| F1 Hermes never reads ~/.claude/skills | no | no | syncHermes named in selection logic only; the skills claim absent |
| F2 runAgentSyncSafe wrapper + marker | no | **yes** | "runAgentSyncSafe() is the primary wrapper … install/update commands use" stated; the .last-agent-sync marker absent |
| F3 install → runAgentSyncSafe default | no | **yes** | install routes through runAgentSyncSafe stated; installCommand/install.sh absent |
| F4 update → runAgentSyncSafe convergence chain | no | **yes** | update accepts sync param defaulting to runAgentSyncSafe stated; chain names absent |
| F5 doctor READ-ONLY, never syncs | no | no | CLAUDE_EXCLUDED_SKILLS detail present; the read-only claim absent |
| F6 uninstall does not sync | no | no | not mentioned |
| F7 setup does not sync | no | no | not mentioned |
| F8 plugin hooks never sync | no | **yes** | "no session hooks or plugin hooks that call runAgentSync directly" stated |

**Task 6: FAIL** (strict 0/8, generous 4/8 — need 8).

## Prime (`backend: prime`)

Every prime answer is one of two forms: the explore starter block (tasks
1, 3, 4, 6 — the model emitted the SYSTEM.md starter block as its only turn
and stopped; 0 facts, 0 citations) or the cap-kill error string (tasks 2, 5 —
"Error: iteration cap reached: the run exceeded 24 turn(s) without producing
a report", 0 facts). No checklist fact is stated in any prime answer.

**Prime: 0/6 pass on criterion 1** under both readings (each task fails with
0/need facts).

## Summary

| Leg | t1 | t2 | t3 | t4 | t5 | t6 | Pass count (generous) | Pass count (strict) |
|---|---|---|---|---|---|---|---|---|
| legacy | FAIL | PASS | FAIL | FAIL | FAIL | FAIL | 1/6 | 0/6 |
| prime | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | 0/6 | 0/6 |

Suite bar (frozen doc arithmetic): ≥5 of 6. Neither leg clears it; prime's
pass count (0) is below legacy's (0 or 1) on the identical model.
