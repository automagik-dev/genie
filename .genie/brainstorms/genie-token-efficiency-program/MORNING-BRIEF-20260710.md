# MORNING BRIEF — 2026-07-10 (Felipe's decision menu)

One page, in priority order. This is the living document; [HANDOFF-20260710.md](HANDOFF-20260710.md) is the historical record of the night. Each item says what to do and what it unblocks.

---

### 1. Merge promotion PR #2542 → stable release  *(human-via-UI, §19)*
[PR #2542](https://github.com/automagik-dev/genie/pull/2542) `release: agent-sync + /council native workflow` is OPEN, base `main` ← head `dev`. **Verified: it already carries the resource-shipping LOW follow-ups (`65759f53`) and dev tip `9b15140f` — its head IS the live dev branch (v5.260710.6).** Only the *title label* says "5.260710.5" (stale from when it was created before #2543 merged); the diff is current. No rolling-PR refresh needed for correctness — merge it as-is via the GitHub UI. This mints the signed CalVer stable release that carries agent-sync + /council.

### 2. After stable: `genie update` ×2 (one-time self-sync bootstrap)
Run `genie update` **twice** on the dogfood host — once ever. The release that introduces self-sync needs the first run to install the new updater and the second to let it self-sync (wish Decision 9). Then verify the delivery actually happened:
- **7 role agents appear as subagent types** in a fresh Claude Code session (`engineer-trivial/standard/complex`, `fixer`, `reviewer`, `final-gate`, `scout`). This is the exact gap that made last night's pin QA inconclusive.
- **string-args fix is stamped** into the local council workflow: `grep -n "typeof" ~/.claude/workflows/council.js` (or grep for the string-coercion the fix added) confirms `ec68cd8f` reached the stamped script.

### 3. Council live-QA ritual: `/council "revisar tudo"`
Run it against the released, self-synced `council.js`. This exercises the string-args path end-to-end on the shipped artifact and **unblocks the council-workflow final execution review** (the g5-gate parks in `.genie/wishes/council-workflow/qa/` until then). Defect story + secondary skill-text-vs-script mismatch are pre-written in [overnight-observations-20260710.md](../../wishes/council-workflow/qa/overnight-observations-20260710.md).

### 4. Routing-pin re-test
Once #2 confirms the 7 agents are real subagent types, re-pull the exact LangWatch comparison. Method + working `langwatch` CLI recipes are in [routing-pin-qa-20260710.md](../../wishes/routing-matrix/qa/routing-pin-qa-20260710.md). Expect Fable token share to fall toward gate-only (~11%, the level the one properly-pinned wish hit) and Opus engineering share to rise. Last night was inconclusive *only* because pins weren't mechanically enforced — not because the design is wrong.

### 5. genie-spend — close the 4 open gaps (closest-to-wishable track)
Tonight's calibration ([genie-spend DRAFT](../genie-spend/DRAFT.md) CALIBRATION section) answers most of these; your ruling turns them into a `/wish`:
- **Key/endpoint source** → recommend: read the OTLP-ingest key from `OTEL_EXPORTER_OTLP_HEADERS` in `~/.claude/settings.json`, endpoint `https://langwatch.khal.ai`. **Proven to authenticate the `langwatch` CLI last night.**
- **Substrate** → recommend: **shell out to the `langwatch` CLI, not hand-rolled REST** (direct REST returned 403; the CLI wraps the same endpoints and works).
- **Effort splits** → recommend: compute **client-side from trace search** (`analytics query` has no `--filter`; the effort-filter is silently broken).
- **Percentiles** → recommend: ship **per-effort p50/p90** (solid: xhigh $5.39/$26.23, high $5.00/$20.81, max $18.76/$43.56); **per-model p50/p90 is parked** — not derivable via the CLI (no per-trace model). Also decide **cadence** (on-demand vs a daily line into `.genie/`), **consumers** (just you vs team/omni), and whether **`genie doctor`** warns above a burn threshold (needs a number from you).

### 6. Mint the rolling-pr PAT  *(only open action on rolling-pr-auth-hardening)*
The workflow hardening already shipped (`c4fdb32b` + `422caaa2`, on dev AND main). The one remaining human action: repo Settings → Secrets → `RELEASE_PLEASE_TOKEN`, a PAT with `contents:read` + `pull-requests:write`. Until then the hourly rolling-PR run fails fast with the actionable error (by design).

### 7. brainstorm-domain-map — oracle-ownership ruling
Decide **who owns irreducibly subjective truth** (the oracle-ownership boundary: machine / model / human oracle classes). This is the one open blocker; ruling it **unblocks the intent-to-wish-compiler pour** (WRS 92, ready to split into 4 child wishes once domain-map + control-plane-contract converge).

### 8. dream-replatform — substrate choice
Your call: local cron vs cloud agents vs hybrid for the scheduler. Cron stays *trigger, never authority*; omni approval gates. This is the gate on the dream track (~50%).

### 9. LOW leftovers (skills-fable5-revamp execution review, all optional)
- **omni-side confirm** — have a reviewer with the `automagik-dev/omni` checkout re-verify the omni G5/G6 numbers (1,329→631); last night's SHIP for the omni half rests on `verification.md` attestation (that repo isn't in the genie checkout).
- **superseded note** — add a one-line "superseded by later wishes" marker where `verification.md` lists `learn`/`council` (both shipped correctly then removed by other wishes) to prevent future diff confusion.

---

### What happened tonight (2026-07-10)

| Thread | Outcome |
|---|---|
| **agent-sync** | Merged to dev as **PR #2541** (by the owning session; final review SHIP `46cc3fb7`). Dev → v5.260710.5. |
| **resource-shipping LOW follow-ups** | Merged as **#2543** (`65759f53`) — temp-dir cleanup, precise same-line guard, replay-safe sweep. |
| **/council** | First real dogfood (3 lenses, 2 rounds); live QA caught a string-args defect, fixed + merged as **`ec68cd8f`**. |
| **routing-pin QA** | Pulled — Fable share *rose* (inconclusive: pins weren't yet subagent types). Re-test after #1+#2. |
| **rolling-pr-auth-hardening** | Found **already implemented** on dev+main (`c4fdb32b`+`422caaa2`) — no work; only the PAT mint (#6) is left. |
