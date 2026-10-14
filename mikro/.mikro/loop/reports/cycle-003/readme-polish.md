# readme-polish — cycle-003

- when: 2026-08-17T02:27:12.718Z
- tool: mikro_readme-polish · status: ok · wall: 94.4s

---

Verdict: A carefully maintained, accurate README — every concrete claim I spot-checked (models, paths, flags, exit codes, package metadata, event counts) verifies against the code. The remaining polish opportunities are minor: the duplicated model name across sections, one event-count discrepancy in a linked doc, and a few places where cross-references would help.

Keeps: The honest "npm is SDK-only" section (line 36-44), the detailed tool contract (95-146), the `docs/events.md` link with the correct 13-event count (line 322), the RTK before/after example (611-621), and the remarkably precise exit-code documentation (606-609, 888-890). Do not break these.

Previously reported:

1. [GAP] No LICENSE file — **CLOSED**. `LICENSE` now exists in repo root; README.md:1018 "MIT" matches package.json `"license": "MIT"`.
2. [POLISH] Model `station/Qwen3.6-35B-A3B-MTP-GGUF` duplicated at README.md:174 and 271 — **STILL OPEN**. Both lines still show the same model; src/station-provider.ts:123 confirms it's the registered local model.
3. [POLISH] SDK import style inconsistency — **CLOSED** as non-issue. Both `{ sdk }` (line 288) and `{ rlmLoop, loadConfig, loadContext }` (line 983) export styles verified in code; no reader confusion evidence.
4. [STRUCTURE] MCP section too deep — **CLOSED** as non-issue. MCP is the primary integration surface; kept as-is.
5. [POLISH] `--verbose` / `--max-iterations` defaults — **HOLD**. CLI defaults (30 iterations, 300000ms) match README; accurate.
6. [POLISH] `$0.00` cost footer — **STILL OPEN** (minor). Line 271 shows `$0.00` for the local model without the parenthetical "(local — no token cost)".

Findings, severity-ordered:

1. [POLISH] README.md:262 — the "Ready-made ones" section lists `codebase-qa`, `changelog`, `log-triage`, and `explore-r`, but the earlier list at line 325 shows `explore`, `explore-r`, `codebase-qa`, `changelog`, `log-triage` — **explore-r is the only recursive agent but is NOT flagged as recursive in the 255-265 section text**, even though line 263 does say "(recursive)". This is fine; line 263 already marks it. No change needed.

2. [STALE] docs/events.md:1 — the linked doc says "Event catalogue (12 types)" but the code implements **13** event types (AgentStart, IterationStart, IterationOutput, ToolCallBefore, ToolCallAfter, Recurse, Validation, Message, EmitDone, Error, SessionOpen, SessionClose, ToolCallObservation — confirmed in src/sdk/events.ts:262-276). The README correctly says "13-event catalogue" at line 322, so the README is accurate — but the linked docs/events.md is stale at 12.
   Suggest (for docs/events.md, not README): update "Event catalogue (12 types)" to "Event catalogue (13 types)" and add `ToolCallObservation` to the table.

3. [POLISH] README.md:271 — the cost footer example `mikro · agent=triage · station/Qwen3.6-35B-A3B-MTP-GGUF · 3 iterations · 307 in / 36 out · $0.00 · 3.9s` shows `$0.00` which could confuse a user into thinking it's free-but-broken. The preceding text ("what it cost") handles this, but consider adding: "($0.00 = local model — no per-token cost)". This was flagged in cycle-000; still open.
   Suggest: add "(local model — no token cost)" after the `$0.00`.

4. [POLISH] README.md:490 — "Other ACP clients take the same three inputs — `command`, `args`, `cwd` — in whatever shape their config uses." This is under-specified. The Zed example (478-487) uses `agent_servers`; the SSH example (498-507) uses the same shape. Consider naming a concrete example.
   Suggest: change to "Other ACP clients take the same three inputs — `command`, `args`, `cwd` — in whatever shape their config uses (e.g. VS Code's `agent.servers`, or the `acpx` config at `.acpx/config.json`)."

5. [POLISH] README.md:1016-1018 — License section says only "MIT". The LICENSE file now exists (verified OK this session), so link it.
   Suggest: "MIT — see [LICENSE](LICENSE) for the full text."

6. [POLISH] README.md:1009 — "read `CHANGELOG.md`" has no link. Add one for convenience.
   Suggest: "read [`CHANGELOG.md`](CHANGELOG.md), not the version delta"

Checked, holds:
- README.md:174 model `station/Qwen3.6-35B-A3B-MTP-GGUF` — src/station-provider.ts:123 confirms registered local model; no rename in current code.
- README.md:709 / 919 `gemini-3.1-flash-lite-preview` — src/config.ts:124 and src/templates/code/mikro.yaml:12 confirm default.
- README.md:42 "ships no `bin`" — package.json has no `bin` field (verified).
- README.md:1001 Node >= 22.19.0 — package.json engines `'node': '>=22.19.0'` (verified).
- README.md:1002 Python 3.10+ — src/detect.ts:72 "mikro requires Python 3.10+" (verified).
- README.md:606 exit 2 for rtk with always — src/cli.ts:912 `process.exit(2)` (verified).
- README.md:971 MIKRO_AGENTS_DIR replaces roots — src/mcp/agents.ts:17 "replaces the defaults entirely" (verified).
- README.md:965 KHAL_API_KEY env — src/khal-provider.ts:74-76 confirms both env names (verified).
- README.md:978 MIKRO_PARENT_RUN_ID etc — all confirmed in src/llm.ts:485-490 (verified).
- README.md:973 MIKRO_ACP_RUN_TIMEOUT_MS — src/acp/agent.ts:353 confirms env override (verified).
- README.md:325 five agents exist — all five confirmed in examples/agents/ (verified).
- README.md:13 curl installer URL — scripts/install.sh exists (verified).
- README.md:974 STATION_BASE_URL / LEMONADE_BASE_URL — default 13305 confirmed (verified).

References:
- src/station-provider.ts:123 — Qwen model registered in code
- src/config.ts:124 — gemini-3.1-flash-lite-preview default
- src/cli.ts:912 — exit code 2 for rtk.error
- src/mcp/agents.ts:17 — MIKRO_AGENTS_DIR replaces defaults
- src/detect.ts:72 — Python 3.10+ gate
- src/sdk/events.ts:262-276 — 13 event types (ALL_AGENT_EVENT_TYPES)
- package.json:2 — package name, no bin field
- docs/events.md:1 — says "12 types" (stale vs code's 13)


---
mikro · agent=readme-polish · deepseek/deepseek-v4-flash · 8 iterations · 39,689 in / 12,484 out · $0.0095 · 94.4s · session sess_7944644c100fdbd3
