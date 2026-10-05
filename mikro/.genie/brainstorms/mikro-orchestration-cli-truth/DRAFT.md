# DRAFT — Orchestration CLI truth

Date: 2026-08-31
Status: READY FOR PARENT VALIDATION; RE-REVIEW NOT RUN

WRS: ██████████ 100/100

- Problem ✅ — ignored parallel and incomplete query logging are false contracts.
- CLI gates ✅ — raw pre-parse rejection covers `--parallel N` and `--parallel=N` in every placement; parsed pre-dispatch rejection makes `--log` query-only for every non-query command.
- Event contract ✅ — exact row union preserves crash-recovery `repl_exec`, freezes null/omitted rules, and wires dormant root `llm_call`, IPC `llm_subcall`, and normal REPL rows.
- Outcomes ✅ — closed `run_error` enum is `provider | timeout | empty_response | cancelled | setup | logger | internal`; precedence and every exit are explicit.
- Validation ✅ — schema misses remain fail-open as `run_end(validation_failed: true)` with exit 0.
- Accounting ✅ — `runQuery` owns a synchronous cumulative snapshot callback, so thrown/setup/cancelled outcomes retain committed iterations, tokens, cost, and budget state.
- Cancellation ✅ — one query supervisor owns SIGINT/SIGTERM, propagates abort through providers/subcalls/children/REPL/storage, memoizes terminal/cleanup/close, awaits flush, and exits 130/143.
- Logger ✅ — awaited open/write/end and immediate read-back oracles cover success plus open, write, terminal-write, end, finish, and premature-close failures without inventing durable rows on failed storage.
- Read-back ✅ — both the local candidate and exact-SHA remote-dev gates run `npm run build` then full `npm test`, while retaining focused matrices that pin rejections, event ordering, all outcomes, partial totals, idempotence, durability, and candidate identity.

Simplest complete design: reject removed concurrency before permissive parsing and make the existing query JSONL stream truthful through one supervisor-owned terminal commit.

Next Step: parent validation and normal workflow handoff; no independent review was run in this fix session.
