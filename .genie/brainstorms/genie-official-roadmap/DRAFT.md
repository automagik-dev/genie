# genie-official-roadmap — DRAFT

**Started:** 2026-07-28 · **Mode:** triage brainstorm (Felipe + orchestrator)

## Problem

`.genie/` carries 36 wish dirs + 24 brainstorm dirs; statuses drift between WISH.md headers, INDEX.md, and dev reality. Goal: one official genie roadmap — every wish triaged (done-on-dev / still-relevant / priority), published through the roadmap board (`roadmap.json`).

## WRS

```
WRS: ██████░░░░ 60/100
 Problem ✅ | Scope ✅ | Decisions ◐ | Risks ✅ | Criteria ░
```

## Felipe decisions (2026-07-28)

- **Priority axes (ranked):** public-facing polish · dogfood pain · first-stable-release track. Desktop/Khal explicitly NOT a top axis.
- **DONE wishes** → move to `.genie/wishes/archive/<slug>/`, one INDEX line each.
- **Roadmap board** becomes canonical: seed `roadmap` board, one lifecycle card per surviving initiative, published via roadmap.json.

## Audit result (3 scouts, evidence-first, 2026-07-28)

- **29 DONE-verified** (merge/PR/file evidence checked): agent-sync, agent-sync-hardening, boards-first-class, codex-plugin-update-handoff, council-workflow, dispatch-inproc-default, genie-mcp, genie-ui (superseded-by-design), genie-ui-bridge, hermes-homogeneous-integration, hermes-khaw-native-surface, hook-injection-hardening, omni-approval-ux, omni-branch-drift-sync, omni-runner-port, plugin-resource-shipping, pr-2545-ultra-release-gate, rolling-pr-auth-hardening, routing-delivery-fix, routing-matrix, skills-fable5-revamp, stable-release-security-gate (v5.260727.5 SHIPPED 2026-07-27!), taxonomy-rehoming, v5-completion, v5-demolition, v5-foundation, v5-housekeeping, warp-integration, worktree-isolation-hardening.
- **5 IN_PROGRESS:** codex-plugin-dogfood-remediation (21/24, 3 criteria open), proportional-validation-policy (mirror regen pending), genie-ui-dash (fork, awaits Felipe GUI QA), live-dev-loop (fork, awaits Felipe QA), khal-rebrand (fork, approved not executed).
- **2 OPEN:** v4-home-residue-doctor (DRAFT, 0/8 — carries live bug #2450), release-ops-hardening (DRAFT — its "after first stable" gate has now PASSED, so it is actionable).
- **Felipe-ritual backlog** riding on DONE wishes: council live ritual, genie-mcp Warp QA, warp-integration pane checklist, agent-sync live convergence, codex-plugin-update-handoff homolog dogfood, taxonomy PATH export.

## Open

- Final priority ordering of open items; whether ritual QA items become one bundled card; public-polish axis has no existing wish (gap — the roadmap publication itself may be its first deliverable).

## Risks

- WISH headers can overclaim → mitigated: every DONE bucket verified against merged PRs/files by scouts.
- Archive move must not break INDEX/wish-lint links (wishes-lint checks brainstorm links).
