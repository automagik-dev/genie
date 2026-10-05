# DRAFT — ACP correctness and opt-in direct mode

Date: 2026-09-01
Status: PENDING REVIEW

WRS: ██████████ 100/100

- Problem ✅ — false root success, ineffective ACP cancellation, and unsafe failed-turn storage are explicit.
- Root contract ✅ — exact success/error discriminants, code-to-phase table, precedence, metadata, and CLI/cache-warmup/MCP/batch/benchmark/child/ACP mappings are frozen; incomplete provider/child accounting is a terminal fail-closed result rather than synthetic zero spend.
- Direct parity ✅ — dedicated request builder, raw system prefix, criteria, context, structured output, one-shot `VALIDATE.md`, and captured-request assertions remain explicit.
- Budgets ✅ — executable hierarchical leases replace nonexistent live root permits: a parent serially leases one child its remaining cost/token/depth and unchanged absolute deadline, the child owns its subtree ledger, and the parent merges one complete envelope once before later work.
- Tokens ✅ — admission uses accrued reported input-plus-output tokens, provider output `maxTokens` is capped to the remaining declared allowance, post-call usage is mandatory, one admitted serialized call may overshoot because input is unknown, and missing usage terminates as `accounting_incomplete`.
- Ordering ✅ — ordinary `llm_query_batched` and recursive `rlm_query_batched` both execute and settle in prompt order with no overlapping sibling/provider work.
- Cancellation ✅ — cooperative child settlement is bounded; terminate/hard-kill/reap is also bounded, and a child killed without a complete envelope leaves accounting incomplete rather than fabricated.
- ACP behavior ✅ — prompt-scoped exact env selection, real cancellation with `stopReason:"cancelled"`, unchanged capabilities/wire framing, and nine exact local/exact-SHA journeys are enumerated.
- Persistence ✅ — clone → sibling temp → atomic replace → in-memory swap; all pre-replace failures preserve disk and memory, cleanup temps, and fail before answer delivery.
- Inventory ✅ — provider-call inventory is pinned to rebased base `d8aea5ccfd91a9f09251e7eee8c09892197a03d7`.
- Delivery ✅ — ordered prefixes build independently; rollback removes only a failing suffix in reverse order.

Simplest complete design: one root union, serialized local ledgers with one-child hierarchical leases, one prompt-scoped selector, one direct completion, and one atomic accepted-turn commit.

Next Step: separate review of the amended design. No `wish` or implementation is authorized by this draft.
