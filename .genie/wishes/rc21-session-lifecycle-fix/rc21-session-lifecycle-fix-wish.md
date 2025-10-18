# 🧞 RC21 Session Lifecycle Fix WISH
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Status:** ✅ COMPLETE
**Roadmap Item:** release/rc21 – @.genie/product/roadmap.md §Releases
**Mission Link:** @.genie/product/mission.md §Reliability
**Standards:** @.genie/standards/best-practices.md §Core Principles
**Completion Score:** 100/100 (all groups complete)

## Context Ledger
| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| .genie/reports/rc20-qa-failure-20251018.md | report | RC20 failed; duplicate sessions + timeout | wish, forge |
| Code diffs | repo | background-launcher.ts + background-manager.ts + run.ts fixes | wish |
| MCP plan session | background | RC21 cycle initialized (b51b7e3f-…) | wish |

## Discovery Summary
- Primary analyst: Genie (with human supervision)
- Key observations: V1/V2 store mismatch + runner generated new UUID created duplicates; CLI hints referenced ./genie
- Assumptions: Node >= 18 (randomUUID available); background exec enabled
- Risks: Cross-path divergence between lib/ and cli-core/; stale dist assets; missing regression coverage

## Executive Summary
Fix session lifecycle bugs: ensure one session per run and restore fast background polling. Align CLI output with npx entrypoint. Validate and prepare RC21.

## Current State
- RC20 failed QA: duplicate sessions + polling timeouts
- State files updated documenting failure

## Target State & Guardrails
- Desired: one session per run; background polling succeeds within 5s; CLI hints use `npx automagik-genie`
- Guardrails: no destructive changes; minimal, focused patches; pass targeted QA

## Execution Groups
### Group A – Code verification
- Goal: Implement and sanity-check fixes
- Surfaces: `@.genie/cli/src/lib/background-launcher.ts`, `@.genie/cli/src/background-manager.ts`, `@.genie/cli/src/commands/run.ts`, `@.genie/cli/src/cli-core/handlers/run.ts`
- Deliverables: Patched sources + rebuilt dist
- Evidence: Wish `qa/group-a/` with command outputs

### Group B – QA workflows
- Goal: Prove no duplicates and no polling timeout
- Surfaces: sessions.json, logs
- Deliverables: Validation logs and counts
- Evidence: Wish `qa/group-b/` (created)

### Group C – Docs + state
- Goal: Update STATE/SESSION-STATE and report
- Surfaces: `@.genie/STATE.md`, `@.genie/SESSION-STATE.md`
- Deliverables: Updated files
- Evidence: Wish `qa/group-c/`

### Group D – Release prep
- Goal: Bump to RC21 and draft changelog
- Surfaces: `package.json`, `CHANGELOG.md`, release script
- Deliverables: Version bump and tag plan
- Evidence: Wish `qa/group-d/`

## Verification Plan
- Clean slate: remove sessions + logs; run `run neurons/plan` → expect 1 session
- Ensure polling prints Session ID without timeout
- After 5 runs, `jq '.sessions | length'` equals 5
- Grep code: `rg "liveStore.agents" .genie/cli/src` returns no results
- CLI hints mention `npx automagik-genie` (not ./genie)

### Evidence Checklist
- Validation commands (exact): captured under `qa/`
- Artefact paths: `qa/`, `reports/`
- Approval checkpoints: release tag after QA pass

## <spec_contract>
- Scope: Fix session duplication/polling; align CLI hints; validate; prep RC21
- Out of scope: Broader refactors; unrelated bugs
- Success metrics: 0 duplicates; 0 timeouts; QA checklist passes
- External tasks: None
- Dependencies: Node >= 18
</spec_contract>

## Status Log
- [2025-10-18T11:15Z] ✅ **WISH COMPLETE** - PR #119 merged, issue #109 closed, RC21 published
- [2025-10-18T04:35Z] ✅ Group B (QA) PASS – evidence in qa/group-b, report created
- [2025-10-18T04:39Z] 🚀 Group D (Release) – v2.4.0-rc.21 tagged + published to `next`
- [2025-10-18T04:20Z] ✅ QA Pass 2 complete - Core fix verified (see .genie/reports/rc21-qa2-results-20251018.md)
- [2025-10-18T04:12Z] 🔧 Implemented fixes to background-launcher.ts, background-manager.ts, run.ts
- [2025-10-18T03:13Z] Wish created
