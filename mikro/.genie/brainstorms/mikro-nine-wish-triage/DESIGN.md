# Program Charter: Mikro evidence-led recovery portfolio

| Field | Value |
|---|---|
| **Slug** | `mikro-nine-wish-triage` |
| **Date** | 2026-08-31 |
| **Artifact** | Non-executable program charter |
| **Review state** | FIX-FIRST recorded; no SHIP stamp |

## Authority boundary

This charter is **NON-EXECUTABLE** and coordinates seven independently payable child designs. It is not a single-wish design, grants no execution authority, and **must never be passed to singular `wish`**. Each child remains in Ready until its own independent design review returns SHIP; its own Next Step then invokes `wish` only for that child.

## Problem

The prior umbrella combined seven independently shippable outcomes and left compatibility, identity, rollback, and promotion contracts too broad to execute safely. The program needs a narrow coordination record while each product outcome receives its own testable design and payment boundary.

## Child designs

| Order | Child | Purpose | Program dependency |
|---|---|---|---|
| 1 | [`mikro-npm-only-toolchain`](../mikro-npm-only-toolchain/DESIGN.md) | npm-only reproducible installs | Delivery bootstrap only |
| 2 | [`mikro-cache-contract-truth`](../mikro-cache-contract-truth/DESIGN.md) | Remove false cache TTL contracts | npm toolchain integrated |
| 3 | [`mikro-prime-081-reconciliation`](../mikro-prime-081-reconciliation/DESIGN.md) | Decide `prime-sdk` default eligibility on frozen evidence | Prime patch captured as P0; npm toolchain integrated |
| 4 | [`mikro-orchestration-cli-truth`](../mikro-orchestration-cli-truth/DESIGN.md) | Query logging truth and hard removal of `--parallel` | npm toolchain integrated; serialized after cache on shared CLI/docs/schema paths |
| 5 | [`mikro-acp-correctness-direct-mode`](../mikro-acp-correctness-direct-mode/DESIGN.md) | ACP correctness plus opt-in direct mode | orchestration CLI integrated; ordered internal commits |
| 6 | [`mikro-repeated-cli-context-roots`](../mikro-repeated-cli-context-roots/DESIGN.md) | Repeatable CLI context roots | ACP integrated; owns the shared CLI/context seam next |
| 7 | [`mikro-dev-release-promotion`](../mikro-dev-release-promotion/DESIGN.md) | Clean-base integration, remote-dev proof, and release promotion | Bootstrap precedes all children; final promotion depends on children 1–6 |

Retired archive sanitization, remote-ref deletion, arbitrary provider TTL, broad GitHub #13 reproduction, and legacy Prime deletion remain outside this program.

## Program invariants

- The current dirty checkout is evidence/input only and never an integration base.
- Freeze fresh `origin/main` as `B0`; capture the reviewed Prime patch and exact manifest, replay only those paths into a clean B0 worktree, and commit them as `P0` before other integration.
- The remote `dev` lane has one exclusive integrator. Its first creation is from B0. Every push is fast-forward and compare-and-swap against the expected old ref.
- Every child wish freezes an exact path allowlist before execution. Shared paths are serialized; stale-base work is rejected rather than merged optimistically.
- Every integrated wave runs an aggregate gate. Feature-specific read-back is required; generic health checks are insufficient.
- One canonical rolling `dev → main` PR is opened early, remains draft/unmergeable until final freeze, and does not rely on the current rolling-workflow secret failure.
- Dev rollback uses revert commits and a full re-gate, never branch rewrite. Production rollback uses a revert or forward-fix PR followed by a new release; tags are never deleted.

## Waves

| Wave | Inputs and ownership | Integration condition | Aggregate gate |
|---|---|---|---|
| 0 — capture/bootstrap | Delivery child freezes B0, captures Prime manifest/patch, produces P0 in a clean worktree, creates remote `dev` from B0, and opens the canonical draft PR | Exact old-ref comparison; reviewed Prime paths only | Clean status, P0 patch/manifest equality, remote-dev SHA equality |
| 1 — foundations | Integrate P0, then npm-only toolchain; Prime may collect read-only benchmark evidence against the frozen candidate | Each commit rebased/replayed on expected dev tip; exact child path allowlist | `npm ci`, toolchain guard, typecheck, clean build, full tests, generated-output equality |
| 2 — CLI contracts | Cache truth, then orchestration CLI truth, serialized on CLI/schema/docs/config/tests/dist | Each child independently reviewed and wished; no shared-path overlap in flight | Wave 1 gate plus obsolete-key and removed-flag hard-fail journeys and JSONL read-back |
| 3 — ACP | Root result → direct/error → transactional store → protocol gate commits | Each ordered commit separately addressable; no context-root work in flight | Focused ACP suites, full gate, loop/direct/error/store read-back |
| 4 — context and Prime decision | Context roots integrates; Prime completes eligibility evidence and, only after Felipe approval, any default mutation on a new SHA | Context exact-oracle pass; Prime mutation invalidates prior candidate and reruns its full gate | Full suite/build plus query/cache/batch roots; Prime matrix/benchmark/rollback gate when applicable |
| 5 — freeze/promotion | Delivery child freezes identities, makes PR mergeable, merges, releases, and reads back | All six product children complete; no candidate drift | Final full gate, independent review, PR/merge-tree proof, release/install equality |

Exact source/test/doc/generated path ownership is finalized in each child wish from its child design; the umbrella cannot authorize or widen those allowlists.

## Promotion identity

The delivery child freezes `{reviewed_dev_sha, reviewed_tree, base_main_sha, merge_sha, released_sha}`; exact PR head/base and merge-tree equality are mandatory. A release child after the merge is allowed only when its diff is confined to the metadata-only whitelist frozen by the delivery wish.

## FIX-FIRST review record

The previous umbrella revision was independently reviewed and returned **FIX-FIRST**. This is historical evidence, not a SHIP stamp for this rewritten charter or any child.

- **Reviewed target:** `.genie/brainstorms/mikro-nine-wish-triage/DESIGN.md` (superseded umbrella revision)
- **Verdict:** FIX-FIRST
- **Reviewed content SHA-256:** `cd0b7e3c9e4243e14ff14aeda4464c00cba1961d30a8a9f609ee1d236a11fac7`
- **Whole-file SHA-256:** `2e7166c463f0522be9a3678cf12cd32572c3faeee08fa46c91cb0545e1665ab7`
- **Reviewer:** `openai-codex:gpt-5.6-sol-900k`
- **Reviewed at:** `2026-08-31T20:39:31Z`
- **Blocking evidence:** umbrella did not fit one wish; Prime gate lacked deterministic candidate/matrix/threshold/approval detail; remote dev lacked exact SHA identity; rolling PR timing conflicted with automation; compatibility and executable delivery/rollback contracts were underspecified.

## Next Step

Do not run `wish` on this charter. Independently review each child DESIGN; after a child receives and verifies its own SHIP evidence, run `wish` for that child only.
