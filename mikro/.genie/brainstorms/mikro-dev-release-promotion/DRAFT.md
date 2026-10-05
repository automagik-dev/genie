# DRAFT — Dev and release promotion

Date: 2026-08-31
Status: READY FOR REVIEW

WRS: ██████████ 100/100

- Problem ✅ — dirty source, distinct H0/B0, absent dev, rolling-workflow race, and release-child identity are explicit.
- P0/A0 ✅ — exact 14-path B0-parent product replay remains P0; pre-existing content-addressed external review metadata is committed unchanged only in the four-path A0 planning/admission child.
- Bootstrap ✅ — rolling workflow disable/read-back precedes dev; exactly one draft/unmergeable PR is established; gated restore creates no extra main PR.
- CAS ✅ — every push uses `--porcelain`; ancestry, pre-read, lease, actual created/updated status, and post-read reject non-FF, stale, and up-to-date/no-op results.
- Portfolio ✅ — every child/unit has a predecessor, exact manifest artifact, overlap owner, and fail-closed rejection rule.
- Promotion ✅ — pre-merge tree identity and post-merge SHA/ordered-parent identity are separate.
- Release ✅ — release workflow is disabled/read back before merge, post-merge oracle runs behind that fence, then workflow is re-enabled/read back and explicitly dispatched through its live `workflow_dispatch` capability; metadata mutation remains one direct child from five exact paths.
- Install ✅ — dev/public journeys set primary and fallback URLs to the canonical repository, mechanically excluding legacy access; repository/workflow/run/attempt/event/branch/head/conclusion and installer URL/source/digest/origin/head/version/journey form one evidence chain.
- Ownership ✅ — delivery-owned workflow, installer, smoke, docs, manifest, and evidence paths are enumerated exactly.
- Rollback ✅ — new commits/releases and full re-gates only; no branch or tag rewrite.
- Disposition ✅ — all 14 retained Prime v2 replay paths and four explicitly rejected/superseded v1 benchmark artifacts are accounted for.

Simplest complete design: one clean B0, one reviewed P0 tree, one CAS-owned dev lane, one draft rolling PR, one reviewed merge tree, one identity-bound release/install chain.

Next Step: independent review of the corrected DESIGN, then `wish` for this child only after verified SHIP evidence.
