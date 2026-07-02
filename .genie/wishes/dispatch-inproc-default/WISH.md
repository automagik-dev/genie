# Wish: Dispatch In-Process Default — Re-arm Hooks, Delete the Orphaned Daemon Path

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `dispatch-inproc-default` |
| **Date** | 2026-07-02 |
| **Author** | Felipe + Genie |
| **Appetite** | ~half a day |
| **Branch** | `wish/dispatch-inproc-default` (from `dev`; PR back to `dev`) |
| **Design** | _No brainstorm — direct fix of a discovered HIGH defect_ |
| **Depends on** | none |

## Summary

The v5 demolition deleted the hook daemon (`src/serve/`) but left `src/hooks/dispatch-command.ts` defaulting to it — so on every hook, `runDispatchClient()` connects to a socket that no longer exists, "fails open" (empty stdout = allow-by-default), and runs NO handlers. Proven live: `git push origin main` is denied only under `GENIE_HOOK_FORCE_INPROC=1` and returns empty on the default path; `~/.genie/hook-fallback.log` logs `connect error: ENOENT` on every hook. This has been true since the demolition merged — **branch-guard (the standing §19 merge law) is silently non-functional**. The daemon indirection existed solely to fix a PG-connection leak (#1574, `GENIE_SKIP_DB_BOOT` — verified dead on dev: no PG anywhere in the hook path). Fix: make in-process the default, delete the orphaned daemon client, and close the entry-level fail-open holes.

## Scope

### IN
- **Flip the default to in-process:** in `dispatch-command.ts`, remove the `runDispatchClient()` default branch and the `GENIE_HOOK_FORCE_INPROC` guard; the in-process sequence (readStdin → `dispatch(stdin)` → stdout → drainStdout → exit) becomes unconditional. The registry is already module-level auto-loaded — there is NO `installDispatchRegistry()` to call (that symbol does not exist on `dev`).
- **Delete the orphaned daemon machinery:** `src/hooks/dispatch-client.ts` + `tests/hooks/genie-hook-binary.test.ts` (compiles the client, stubs the daemon — delete wholesale); the `bun build src/hooks/dispatch-client.ts …` segment of package.json's `build` script (dist ships `dist/` wholesale, so this just stops emitting an unused artifact); the `~/.genie/hook-fallback.log` writer and any now-unreferenced socket-path/`GENIE_HOOK_SOCK` helpers. KEEP `tests/hooks/genie-hook-perf.test.ts` (benches `dispatch()` in-process — survives).
- **Orphaned `src/hooks/redaction.ts`:** it is imported ONLY by the deleted dispatch-client.ts + its own test (verified). Delete `redaction.ts` + `redaction.test.ts` too — unless a grep shows a live in-process consumer, in which case keep it and note why (prevents a knip dead-code failure either way).
- **Close the entry-level fail-open holes (the actual bug surface — per-handler throws ALREADY fail closed via runHandler returning `{decision:'deny'}`):**
  - Invalid/unparseable stdin: `dispatch()` currently returns `''` (= allow) on malformed JSON (index.ts:329). On the DEFAULT path this is now the only handler-free allow. Make dispatchAction fail CLOSED on unparseable input — but honor the `AskUserQuestion` / `NON_INTERCEPTABLE_PRE_TOOL_USE_TOOLS` carve-out: a blanket deny breaks the inline picker. Since unparseable stdin means the event/tool is unknown, the safe response is a neutral non-allow via a STDOUT ENVELOPE (not empty-stdout-plus-nonzero-exit — the tests assert a non-empty non-allow response, so the signal must be in stdout, not the exit code). Concretely: when the event/tool are KNOWN-interceptable (the realistic post-parse-throw case), emit the event-appropriate deny/ask envelope; when input is truly unparseable (near-impossible — CC always emits valid JSON), emit a neutral non-allow envelope that does not auto-approve and does not deny a NON_INTERCEPTABLE tool. Document the reasoning in-code.
  - Uncaught throw in `dispatchAction`: today an unexpected `dispatch()` throw has no try/catch → crash → empty stdout = allow. Wrap the dispatch call so an unexpected throw fails CLOSED (same neutral-non-allow policy), never empty-allow.
- **Stale-comment purge:** the #1574 PG-leak rationale, the "in-process DOES open a PG pool" warning, `GENIE_SKIP_DB_BOOT` (set at dispatch-command.ts:46, read nowhere — delete), and the daemon "hot-path" doc block are v4 fossils. Rewrite the file doc to the v5 story: in-process is the path; the fork does no DB work.
- **Retire `GENIE_HOOK_FORCE_INPROC`** entirely (it appears ONLY in dispatch-command.ts's 3 lines — no test sets it; the two-path split is what let the fall-open hide behind a flag nobody flipped). In-process is now unconditional.
- **Live regression gate:** a test that drives the SHIPPED dispatch path (built dist, no env flags) with a `git push origin main` PreToolUse Bash payload and asserts branch-guard DENIES — the exact scenario silently broken. The bug escaped because every test drove `dispatch()` directly and none exercised the `genie hook dispatch` entry against the built binary; this gate closes that.

### OUT
- Rebuilding any daemon / resident hook process (the #1574 PG leak it guarded is gone with Postgres; per-hook in-process fork with no DB is correct for the lightweight body).
- Changing any handler's logic (branch-guard, orchestration-guard, etc. unchanged — purely the dispatch entry path).
- **Any omni-approval reachability proof** — `omni-approval.ts` lives on the `wish/omni-runner-port` branch, NOT `dev`; it does not exist here. That proof (the ~110s block resolving on the default path) belongs to the omni wish, which owns the handler. This wish only re-arms the default dispatch that omni's gate will then ride on.
- Hook timeout tuning in `.claude/settings.json` (guidance only).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | In-process is the default and only dispatch path; delete the daemon client | The daemon existed solely for the #1574 PG leak; v5 has no PG (`GENIE_SKIP_DB_BOOT` read nowhere), so the indirection is dead weight the demolition missed. In-process runs the real registry — proven: branch-guard denies under it today |
| 2 | Close the fail-open at the ENTRY level (invalid stdin, uncaught throw), not per-handler | Per-handler throws already fail closed (runHandler → `{decision:'deny'}`). The remaining allow leaks are `dispatch()` returning `''` on bad JSON and an uncaught dispatchAction throw — both entry-level |
| 3 | Fail-closed must honor the `AskUserQuestion`/NON_INTERCEPTABLE carve-out | A blanket deny on error breaks the inline picker (#1688). On unknown-event/unparseable input the safe response is neutral-non-allow, not a deny envelope |
| 4 | Retire `GENIE_HOOK_FORCE_INPROC` | The two-path split is what let the fall-open hide behind an unflipped flag; one path can't silently diverge from what's tested |
| 5 | Regression gate drives the BUILT dist on the default path | The bug escaped because tests drove `dispatch()` directly, never the `genie hook dispatch` entry against the binary CC actually invokes |
| 6 | Coordinate index.ts with omni-runner-port | That wish (separate branch) also edits buildDenyResponse/buildBlockingResponse; note the overlap so the merge is deliberate, not a collision |

## Success Criteria

- [ ] On the DEFAULT dispatch path (built dist, no FORCE_INPROC), a `git push origin main` PreToolUse Bash payload returns branch-guard's DENY envelope (`permissionDecision:"deny"`); a benign command does not.
- [ ] `src/hooks/dispatch-client.ts` and `tests/hooks/genie-hook-binary.test.ts` deleted; no `dispatch-client` build target; no `hook-fallback.log` writer; no `GENIE_HOOK_FORCE_INPROC` or `GENIE_SKIP_DB_BOOT` anywhere in `src/` or `tests/`.
- [ ] `src/hooks/redaction.ts` resolved (deleted with its test, or kept with a stated live consumer); `bun run dead-code` (knip) clean.
- [ ] Entry-level failure fails CLOSED: unparseable stdin and an injected dispatch throw both produce a non-allow response (not empty), and the `AskUserQuestion` carve-out still yields its empty-picker response — tested.
- [ ] dispatch-command.ts doc carries no PG/#1574/daemon/pool references.
- [ ] Full `bun run check` + build + e2e green; CI green on the PR.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1 | The flip + deletion + entry-level fail-closed — one cohesive change |
| 2 | Group 2 | Live regression gate + docs coherence over the landed change |

---

## Execution Group 1: Flip to in-process, delete the daemon path, fail closed at the entry

**Goal:** In-process dispatch is the default; the orphaned daemon client + redaction are gone; entry-level errors fail closed.

**Deliverables:**
1. `src/hooks/dispatch-command.ts`: remove the `runDispatchClient()` branch + `GENIE_HOOK_FORCE_INPROC` guard + `GENIE_SKIP_DB_BOOT`; the in-process sequence becomes unconditional. Wrap the `dispatch(stdin)` call: on unparseable stdin or an unexpected throw, fail CLOSED per Decision 2/3 (neutral-non-allow; preserve the `AskUserQuestion`/NON_INTERCEPTABLE empty-picker path). Rewrite the file doc to the v5 story.
2. Delete `src/hooks/dispatch-client.ts`, `tests/hooks/genie-hook-binary.test.ts`, the `bun build src/hooks/dispatch-client.ts …` build segment, the `hook-fallback.log` writer + unreferenced socket helpers. Keep `genie-hook-perf.test.ts`.
3. Resolve `src/hooks/redaction.ts`: grep for any live in-process importer; if none (expected), delete it + `redaction.test.ts`; else keep + note the consumer.
4. Tests: entry-level fail-closed (unparseable stdin → non-allow, not empty; injected dispatch throw → non-allow) + the `AskUserQuestion` carve-out still returns its empty-picker response; existing `bun test src/hooks/` green on the now-default path.

**Acceptance Criteria:**
- [ ] dispatch-client.ts + genie-hook-binary.test.ts gone; no build target; no FORCE_INPROC/SKIP_DB_BOOT in src/ or tests/.
- [ ] redaction.ts resolved; knip clean.
- [ ] Unparseable-stdin + injected-throw fail CLOSED (tested); AskUserQuestion carve-out intact.
- [ ] typecheck + `bun test src/hooks/` + build green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
test ! -f src/hooks/dispatch-client.ts
test ! -f tests/hooks/genie-hook-binary.test.ts
if grep -rn 'GENIE_HOOK_FORCE_INPROC\|GENIE_SKIP_DB_BOOT' src/ tests/ ; then echo "FAIL: retired env flag still referenced"; exit 1; fi
if grep -n 'dispatch-client' package.json ; then echo "FAIL: dispatch-client build target remains"; exit 1; fi
bun test src/hooks/
bun run typecheck
bun run dead-code
bun run build
```

**depends-on:** none

---

## Execution Group 2: Live regression gate + coherence

**Goal:** The fall-open can never silently return; docs match the in-process reality.

**Deliverables:**
1. Regression gate test driving the BUILT dist on the default path (no env flags): pipe `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}` to `bun dist/genie.js hook dispatch` → assert `"permissionDecision":"deny"` with the merge-law reason; a benign `ls` payload → no deny. This is the gate that was missing.
2. Docs: any CLAUDE.md / README / hook doc mentioning the daemon socket, `GENIE_HOOK_FORCE_INPROC`, the `hook.sock`, or the "15s hook timeout via daemon" gotcha updated to the in-process reality.
3. Coordination note (not a code change): `wish/omni-runner-port` Group 3 also rewrote `buildDenyResponse`/`buildBlockingResponse` in index.ts; record in this wish's handoff that the two index.ts changes must merge deliberately (whichever lands second rebases). Do NOT reference an omni Discovered-Issues note here — that note lives on the omni branch, not dev.

**Acceptance Criteria:**
- [ ] Regression gate: default-path `git push origin main` → DENY; benign → no deny. Fails hard if the default ever falls open again.
- [ ] Docs carry no daemon/FORCE_INPROC/hook.sock/PG-leak references.
- [ ] Full `bun run check` + e2e green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun run build
OUT=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | bun dist/genie.js hook dispatch)
echo "$OUT" | grep -q '"permissionDecision":"deny"' || { echo "FAIL: default path did not deny push to main"; exit 1; }
BENIGN=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' | bun dist/genie.js hook dispatch)
echo "$BENIGN" | grep -q '"permissionDecision":"deny"' && { echo "FAIL: benign command wrongly denied"; exit 1; } || true
if grep -rniE 'GENIE_HOOK_FORCE_INPROC|dispatch-client|hook\.sock|hook-fallback' README.md CLAUDE.md 2>/dev/null; then echo "FAIL: stale daemon docs remain"; exit 1; fi
bun run check
V5_E2E_BUILD=1 bash tests/e2e/v5-lifecycle.sh
```

**depends-on:** group-1

---

## Cross-wish dependencies

- **Re-arms:** `branch-guard` (the standing §19 merge law, silently open since demolition).
- **Unblocks:** `omni-runner-port` — its approval gate rides on the default dispatch this wish fixes; that wish (separate branch) owns the omni-reachability proof and the index.ts response-builder overlap noted in G2.3.
