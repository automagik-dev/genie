# Mikro lifecycle index

Reconciled on 2026-08-31 after planning review split the over-broad recovery umbrella into independently payable designs. Git-backed plans are durable; no execution authority is inferred from a design, an old wish, or an empty local board.

## Program

- [Mikro evidence-led recovery portfolio charter](brainstorms/mikro-nine-wish-triage/DESIGN.md) — **NON-EXECUTABLE; prior umbrella review FIX-FIRST; no SHIP stamp.** Coordinates seven children, waves, clean B0/P0 bootstrap, exclusive `dev` integration, and final identity/rollback rules. Never pass this charter to singular `wish`.
- `PROGRAM.md` — superseded historical umbrella retained only in the local recovery workspace; it is not part of this reviewed candidate and grants no execution authority.

## Ready — reviewed SHIP

Each entry below is one single-wish child at WRS 100/100 with independently verified SHIP evidence. This index records readiness only; execution still requires its own `wish` handoff and approval.

- [npm-only reproducible toolchain](brainstorms/mikro-npm-only-toolchain/DESIGN.md) — one npm/package-lock authority, pre-install hard guard, no dependency upgrades.
- [Cache contract truth](brainstorms/mikro-cache-contract-truth/DESIGN.md) — obsolete TTL/expire-time keys hard-fail and require a manual choice of `cache.retention: short` or `cache.retention: long`; no semantic auto-migration.
- [Prime 0.8.1 reconciliation](brainstorms/mikro-prime-081-reconciliation/DESIGN.md) — evidence-first eligibility gate with truthful CAP-09 gap; Mikro remains default unless every later gate and owner decision passes.
- [Orchestration CLI truth](brainstorms/mikro-orchestration-cli-truth/DESIGN.md) — removed `--parallel` hard failure and complete query-only JSONL with terminal failure and awaited flush.
- [ACP correctness and opt-in direct mode](brainstorms/mikro-acp-correctness-direct-mode/DESIGN.md) — loop-default selector, serialized hierarchical leases, bounded direct completion, and transactional successful-turn storage.
- [Repeated CLI context roots](brainstorms/mikro-repeated-cli-context-roots/DESIGN.md) — schema-visible repeatability, ordered canonical-root dedupe, singleton byte parity, deterministic collision identities for query/cache/batch.
- [Dev and release promotion](brainstorms/mikro-dev-release-promotion/DESIGN.md) — clean B0/P0 lane, exclusive compare-and-fast-forward `dev`, exact-SHA journeys, one rolling PR, identity-bound merge/release and revert-only rollback.

## Delivered to dev — awaiting promotion

- [Declared tools truth](brainstorms/mikro-declared-tools-truth/DESIGN.md) → [WISH.md](wishes/mikro-declared-tools-truth/WISH.md) — M1+M2 of the brain handoff: default backend loads declared `tools:` through a REPL `tool_request` bridge, sidecar `<tool>.schema.json`, `rlmDriver` throws `NoExposableToolsError` instead of silent one-shot, unresolved/reserved/colliding tools advertised `UNAVAILABLE`. Design review SHIP (three rounds) and plan review SHIP (two rounds) on 2026-09-03; six groups in three waves merged to `dev` at `b3d4a31` via [PR #149](https://github.com/automagik-dev/mikro/pull/149). Acceptance evidence is isolated in [PR #150](https://github.com/automagik-dev/mikro/pull/150), whose merge is a separate Felipe decision. A `juice/GLM-5.3` canary answered and stored `thinkingLevel: max`, but `session_status` rendered `think high`; effective max remains unproven, so the exact default final gate is `UNAVAILABLE` and no reviewer was started. No `dev → main` PR or promotion is authorized.

## Superseded wish records

These local-only wish paths are historical planning inputs, not links in this reviewed candidate. They are not the executable handoff for the corrected portfolio and were not modified by this correction.

- `wishes/mikro-sanitize-recovered-data/WISH.md` — retired/out of the corrected product program.
- `wishes/mikro-reproducible-toolchain/WISH.md` — superseded by the npm-only child design above.
- `wishes/mikro-cache-ttl-enforcement/WISH.md` — superseded by cache contract truth; arbitrary TTL remains out.
- `wishes/mikro-prime-backend-reconciliation/WISH.md` — superseded by the deterministic Prime 0.8.1 child design above.
- `wishes/mikro-orchestration-quality-repro/WISH.md` — broad reproduction retired; narrow CLI truth moved to its child.
- `wishes/mikro-acp-direct-recovery/WISH.md` — superseded by the ordered ACP child design above.
- `wishes/mikro-context-targeting/WISH.md` — superseded by the repeated CLI roots child design above.
- `wishes/mikro-release-truth/WISH.md` — superseded by the dev/release promotion child design above.
- `wishes/mikro-remote-ref-retirement/WISH.md` — retired/out; no remote branch deletion in this program.

## Delivery admission

No child is admitted by this index alone. The delivery child must first freeze fresh `origin/main` B0, replay the reviewed Prime patch/manifest into a clean worktree as P0, create remote `dev` from B0 under an exclusive integrator, and establish the canonical draft rolling PR. Every child then requires independent review, its own approved wish, exact path ownership/base, aggregate wave gates, and expected-SHA remote/CI/install read-back.

## Historical sources

- `wishes/_archive/INDEX.md` — local archive of delivered, settled, and superseded legacy plans; not included in this candidate.
- `brainstorms/_archive/INDEX.md` — local archive of completed historical design records; not included in this candidate.
- `TRIAGE.md` — local recovery and triage ledger; not included in this candidate.
