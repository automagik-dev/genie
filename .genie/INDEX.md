# Plans Index

> **Board snapshot (canonical):** [roadmap.json](roadmap.json) is the canonical roadmap board (`genie board`); the local `.genie/genie.db` materializes from it. Git hooks keep them reconciled via three-way `genie task sync`: post-merge/post-rewrite import a pulled snapshot, pre-commit exports local board changes into the commit, and if BOTH moved since the last sync nothing is touched and the hook warns — resolve with `genie task import --replace` (take the snapshot) or `genie task export --write` (keep the local board). Fresh clone: run `genie task sync` once. Scope: roadmap content only (tasks, dependencies, wish groups, boards, timelines) — `hire_roster` worktree state stays machine-local.
>
> **Lanes follow truth** ([roadmap-truth](wishes/archive/roadmap-truth/WISH.md)): a card whose wish still has a live `WISH.md` is re-laned from its Status cell on `--json` board reads (`DRAFT`→Idea · `APPROVED`→Wish · `IN_PROGRESS`→Work · `SHIPPED`→Done); the four lifecycle sections below mirror the lanes and are lint-checked by the doctor `jar: index-lane drift` check. Closed wishes live under [wishes/archive/](wishes/archive/) and are not re-laned — `## Shipped` and `## Superseded` are history, not lanes.
>
> **2026-09-19 triage:** every wish was re-checked against the code on dev; 44 were archived with a `> **Truth (2026-09-19):**` line naming the PR or commit that proves the verdict, and six ledgers were deleted outright — `codex-plugin-dogfood-remediation` (its Codex-plugin and MCP targets were deleted in `5109bf0fb`/#2820; the delivery-integrity half already ships), `delegate-bridge` (Orca orchestration is the cross-agent bridge, and its groups stayed blocked on another repo's unshipped verbs), `genie-ui` (the browser shell left the tree in `831b31b80`/#2622), `genie-ui-dash` (retired 2026-08-30 with its ui-bridge client, #2834; no code ever lived in this repo), `khal-rebrand` (every group targets the private `khal-os/genie-desktop` fork, behind a retired dependency) and `live-dev-loop` (desktop-fork tooling; genie has no UI surface). Thirteen brainstorms went with them: the `genie-token-efficiency-program` umbrella and its unshipped children (`control-plane-contract`, `skill-absorbs`, `always-on-genie`, `genie-spend`, `dream-replatform`, `genie-boards-ui`), the `genie-v5-lightweight-body` umbrella, `ledger-rebaseline`, `token-efficiency-rebaseline`, and the three belonging to deleted wishes; `intent-to-wish-compiler` stays on disk because [wish-v7](brainstorms/wish-v7/DESIGN.md) links it, but its row is gone. Landed by PR [#3001](https://github.com/automagik-dev/genie/pull/3001).
>
> **Release facts:** first full-pipeline stable release v5.260727.5 (2026-07-27); current stable v5.260916.6; current dev v5.260919.7; v6 stable is the pending dev→main promotion [#2935](https://github.com/automagik-dev/genie/pull/2935). v6 direction: the approved 2026-08-25 design (`genie-v6-corpo-leve`, on branch `v6/corpo-leve`) is a subtraction program that dev has not executed; owner decision pending.

## Raw

- [WISH: dsh-workflow-fork](wishes/dsh-workflow-fork/WISH.md) — **DRAFT** (re-opened from FIX-FIRST 2026-09-19): fork a genie-owned workflow runner for DSH bodies. Nothing has executed — `automagik-dev/dsh_workflow` does not exist, Group 0's seam comparison was never written, all five cards are unclaimed — and the wish's own 2026-09-15 council recorded that DSH 0.1.x already ships a first-party `ctx.workflowEngine` that may make the fork unnecessary. Group 0 decides the route before anything downstream starts
- [brainstorm-domain-map](brainstorms/brainstorm-domain-map/DRAFT.md) — WRS 80; executable spec compiler (intent → requirement-ID → oracle-class → execution → proof-packet); deterministic gates, residual-risk review only; subjective-truth ownership still open. Its umbrella was deleted in the 2026-09-19 triage — carry it alone or drop it
- genie-daily-release — daily-cadence release draft; the DRAFT.md is machine-local (gitignored) and has never been committed, so there is nothing to link. Raw until someone commits a design

## Simmering

- [wish-v7 — DESIGN](brainstorms/wish-v7/DESIGN.md) (DRAFT, COUNCIL and REVIEW notes are machine-local beside it) — **design SHIP 2026-09-17** (round 4, digest `dc06b5de…`, after council `revise` and three FIX-FIRST rounds on the boundary-hold mechanism): the canonical wish — every skill verb is a front door to one procedure (capture verbatim → derived-WRS triage → lane → contract → one explicit "go" → deliver → remember); boundaries as `.claude/rules` policy with `holdBeforeWork`/`holdBeforePublish`. A program of slices R, 0, 1, 2, 3, sequenced after `observe-skill-bundle`
- [skill-intake — council 2026-09-18](wishes/skill-intake/council-2026-09-18.md) · [PROCEDURE](wishes/skill-intake/PROCEDURE.md) — the procedure landed as runnable code (`.claude/workflows/skill-intake.js`, parity-tested) and the council ran (verdict `revise`: 1 ABSORB held, 19 merge, 6 improve, 11 personal, 1 drop), but the folder carries no `WISH.md`, so it is invisible to `wishes-lint`. None of the ratified folds exist in `skills/` yet, and the two mechanical guards the council asked for (a `SKILL.md` line-count rule, a stricter token lint) are still missing

## Ready

- [WISH: observe-skill-bundle](wishes/observe-skill-bundle/WISH.md) — **APPROVED 2026-09-17** (direct wish, no brainstorm): fix the Phoenix observability tooling merged in #2936 so it works for anyone running Phoenix locally, then ship it as the `observe` skill. The one live wish with real open work — not one of the five groups has executed, `skills/observe` does not exist and `observe` is absent from `SHIPPED_SKILLS` in `scripts/release-docs.test.ts`. It edits the shipped skill roster, so it lands after the stable cut and ahead of the wish-v7 program

## Poured

- [genie-v6-corpo-leve — DESIGN rev. 4](brainstorms/genie-v6-corpo-leve/DESIGN.md) · [COUNCIL](brainstorms/genie-v6-corpo-leve/COUNCIL.md) · [Orca research](brainstorms/genie-v6-corpo-leve/orca-integration-research.md) → [WISH: v6-stable-cut](wishes/v6-stable-cut/WISH.md) — **APPROVED 2026-09-19** (design SHIP after 3 rounds; plan SHIP after 2): the first stable v6 = dev + this cut; Omni out (#3004), darwin gate (#3003) landed; board frozen and made honest in orca; `genie wish lint`; the `5.`→`6.` bump lands last, promotion #2935 opens right after.
- [wish-v6 — DESIGN](brainstorms/wish-v6/DESIGN.md) · [TIMELINE](brainstorms/wish-v6/TIMELINE.md) · [WISH-DURATION-STUDY](brainstorms/wish-v6/WISH-DURATION-STUDY.md) · [COUNCIL](brainstorms/wish-v6/COUNCIL.md) → [WISH](wishes/wish-v6/WISH.md) — **IN_PROGRESS**: `/wish` = one task delivered, ASAP — one saved workflow (`.claude/workflows/wish.js`) Admit → one executor in one worktree → mechanical gate → blind review → bounded repair → publish PR to dev and read it back; `quick` is a one-release deprecation stub. The body is on dev (PRs #2931, #2932, #2938–#2940 merged 2026-09-16) with its parity tests; **the open promotion PR [#2935](https://github.com/automagik-dev/genie/pull/2935) (dev→main) is the v6 stable cut**
- [dsh-genie-board — DESIGN](brainstorms/dsh-genie-board/DESIGN.md) → [WISH](wishes/dsh-genie-board/WISH.md) — **IN_PROGRESS**: the genie board as a DSH plugin. Built, gated and already riding the release payload (PRs #2895/#2897/#2903/#2908; 34 tracked files under `plugins/dsh-genie-board/`, the frozen `schemaVersion: 1` aggregate at `v5-board.ts:490`, three smoke/verify scripts). The tail is running `scripts/verify-dsh-genie-board-release.ts` against PUBLISHED stable assets rather than local candidates — which the v6 stable cut produces anyway

## Shipped

> Archived under [wishes/archive/](wishes/archive/) on 2026-09-19. Every entry below was verified against dev: a merged PR or a named commit is cited in the wish's own Truth line. Group cards stay on the board as execution history in the Done lane.

- [boards-first-class](wishes/archive/boards-first-class/WISH.md) — SHIPPED 2026-07-21 · PR #2611 — the lifecycle kanban and the jar↔INDEX drift lint
- [cross-agent-delegate](wishes/archive/cross-agent-delegate/WISH.md) — SHIPPED 2026-08-11 · PR #2766 — declared agent routing on the card
- [genie-dual-mode-orca-plugin](wishes/archive/genie-dual-mode-orca-plugin/WISH.md) — SHIPPED 2026-08-30 · #2808–#2838 — Orca lifecycle authority; MCP retired
- [global-workflows-local-mikro](wishes/archive/global-workflows-local-mikro/WISH.md) — SHIPPED 2026-09-18 · #2993–#2998 — `genie mikro call` + workflow catalog
- [harness-audit-landing](wishes/archive/harness-audit-landing/WISH.md) — SHIPPED 2026-08-07 · PR #2752 + `dc0e73c93` — schema lockstep, freshness gate
- [hook-injection-hardening](wishes/archive/hook-injection-hardening/WISH.md) — SHIPPED 2026-07-10 · PR #2536 — de-shelled three hook sites, since deleted
- [lifecycle-lease-busy-grace](wishes/archive/lifecycle-lease-busy-grace/WISH.md) — SHIPPED 2026-08-03 · PR #2745 — steal dead lease holders, fail busy cleanly
- [omni-approval-ux](wishes/archive/omni-approval-ux/WISH.md) — SHIPPED 2026-07-03 · PRs #2507/#2509 — correlated approval identity, ⏳→✅ swap
- [omni-branch-drift-sync](wishes/archive/omni-branch-drift-sync/WISH.md) — SHIPPED 2026-07-04 · omni PRs #770/#773 — a one-shot reconciliation elsewhere
- [omni-runner-port](wishes/archive/omni-runner-port/WISH.md) — SHIPPED 2026-07-02 · PR #2503 — runner, global queue, inbound one-shot
- [plugin-resource-shipping](wishes/archive/plugin-resource-shipping/WISH.md) — SHIPPED 2026-07-10 · PR #2540 — skills carry their own resources, lint-enforced
- [proportional-validation-policy](wishes/archive/proportional-validation-policy/WISH.md) — SHIPPED 2026-07-28 · PR #2725 — smallest sufficient validation
- [remotty-board-asks](wishes/archive/remotty-board-asks/WISH.md) — SHIPPED 2026-08-07 · PR #2755 — block kind, `task set-wish`, `task delete`
- [roadmap-truth](wishes/archive/roadmap-truth/WISH.md) — SHIPPED 2026-08-06 · PR #2751 — board lanes follow WISH.md status on `--json` reads
- [rolling-pr-auth-hardening](wishes/archive/rolling-pr-auth-hardening/WISH.md) — SHIPPED 2026-07-10 · `c4fdb32bd`+`422caaa26` — fail fast on a dead PAT
- [skills-everywhere](wishes/archive/skills-everywhere/WISH.md) — SHIPPED 2026-08-31 · #2866/#2868/#2870 — the skills.sh channel + host retirement
- [skills-everywhere-b](wishes/archive/skills-everywhere-b/WISH.md) — SHIPPED 2026-09-01 · #2878–#2882 — honest recording, then ~20k lines deleted
- [skills-everywhere-c](wishes/archive/skills-everywhere-c/WISH.md) — SHIPPED 2026-09-01 · PR #2888 — the post-plugin vocabulary, lint-enforced
- [skills-fable5-revamp](wishes/archive/skills-fable5-revamp/WISH.md) — SHIPPED 2026-07-04 · PR #2518 — prompt revamp; only the v4 cleanup survives
- [stable-release-security-gate](wishes/archive/stable-release-security-gate/WISH.md) — SHIPPED 2026-07-27 · closed by the first stable release v5.260727.5
- [taxonomy-rehoming](wishes/archive/taxonomy-rehoming/WISH.md) — SHIPPED 2026-07-02 · PR #2500 — plans moved to `.genie/wishes|brainstorms`
- [v4-home-residue-doctor](wishes/archive/v4-home-residue-doctor/WISH.md) — SHIPPED 2026-07-05 · PR #2532 — v4 home-residue detection and `--fix`
- [v5-completion](wishes/archive/v5-completion/WISH.md) — SHIPPED 2026-07-02 · the CLAUDE.md-for-v5 rewrite and the 5.x version scheme
- [v5-demolition](wishes/archive/v5-demolition/WISH.md) — SHIPPED 2026-07-02 · PR #2499 — the v4 harness deleted, bare-name CLI cutover
- [v5-foundation](wishes/archive/v5-foundation/WISH.md) — SHIPPED 2026-07-02 · PR #2499 — the `src/lib/v5/` state engine
- [v5-housekeeping](wishes/archive/v5-housekeeping/WISH.md) — SHIPPED 2026-07-02 · PR #2500 — true-lightweight tree cleanup, README replan
- [workflows-catalog](wishes/archive/workflows-catalog/WISH.md) — SHIPPED 2026-09-15 · `.claude/workflows/` as the catalog, `council.js` first
- [worktree-isolation-hardening](wishes/archive/worktree-isolation-hardening/WISH.md) — SHIPPED 2026-07-27 · PR #2707 — git-state freeze, doctor residue GC

## Superseded

> Archived under [wishes/archive/](wishes/archive/) on 2026-09-19. Each of these shipped or was executed and then had its subject deleted or replaced; the wish's own Truth line names what did it. Nothing here is open work.

- [agent-sync](wishes/archive/agent-sync/WISH.md) — SUPERSEDED 2026-09-19 · merged #2541; `agent-sync.ts` deleted in `699a48bbd`
- [agent-sync-hardening](wishes/archive/agent-sync-hardening/WISH.md) — SUPERSEDED 2026-09-19 · its anchors died with the hook runtime `e250b9463`
- [codex-plugin-update-handoff](wishes/archive/codex-plugin-update-handoff/WISH.md) — SUPERSEDED 2026-09-19 · merged #2617; plugin and channel both gone
- [council-workflow](wishes/archive/council-workflow/WISH.md) — SUPERSEDED 2026-09-19 · the stamped 13-lens council died with the plugin payload
- [dispatch-inproc-default](wishes/archive/dispatch-inproc-default/WISH.md) — SUPERSEDED 2026-09-19 · shipped `bbe281e74`, then `src/hooks/` deleted whole
- [genie-mcp](wishes/archive/genie-mcp/WISH.md) — SUPERSEDED 2026-09-19 · the MCP server was retired by #2820; `genie mcp` refuses
- [genie-official-roadmap](wishes/archive/genie-official-roadmap/WISH.md) — SUPERSEDED 2026-09-19 · never executed; this triage is its successor
- [genie-ui-bridge](wishes/archive/genie-ui-bridge/WISH.md) — SUPERSEDED 2026-09-19 · merged #2610, retired by #2834 (`f45d634b8`)
- [hermes-homogeneous-integration](wishes/archive/hermes-homogeneous-integration/WISH.md) — SUPERSEDED 2026-09-19 · merged #2565/#2566; deleted in `d572f9e0b`
- [hermes-khaw-native-surface](wishes/archive/hermes-khaw-native-surface/WISH.md) — SUPERSEDED 2026-09-19 · merged #2516/#2517; both halves are gone
- [mcp-write-tools](wishes/archive/mcp-write-tools/WISH.md) — SUPERSEDED 2026-09-19 · merged #2773; the server died in `f45d634b8`
- [pr-2545-ultra-release-gate](wishes/archive/pr-2545-ultra-release-gate/WISH.md) — SUPERSEDED 2026-09-19 · closed 2026-07-24; its whole scope was deleted
- [release-ops-hardening](wishes/archive/release-ops-hardening/WISH.md) — SUPERSEDED as written 2026-09-19 · G1/G3 shipped without it; only G2 survives
- [routing-delivery-fix](wishes/archive/routing-delivery-fix/WISH.md) — SUPERSEDED 2026-09-19 · landed as `2315671a`, then the fan-out was deleted
- [routing-matrix](wishes/archive/routing-matrix/WISH.md) — SUPERSEDED 2026-09-19 · three of four surfaces deleted; the lint rule survives
- [warp-integration](wishes/archive/warp-integration/WISH.md) — SUPERSEDED 2026-09-19 · `genie launch` and the Warp emitter died with #2789
