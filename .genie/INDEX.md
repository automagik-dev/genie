# Plans Index

## Raw

- [control-plane-contract](brainstorms/control-plane-contract/DRAFT.md) — single executable dispatch+routing contract; global↔repo lifecycle convergence by layer; work/review policy refactor (umbrella G2+G3, 2026-07-09)
- [skill-absorbs](brainstorms/skill-absorbs/DRAFT.md) — trace→fix, wizard→genie, pm→work-ref, council→[council-workflow](brainstorms/council-workflow/DESIGN.md) (poured), report→LangWatch (umbrella G4, 2026-07-09)
- [always-on-genie](brainstorms/always-on-genie/DRAFT.md) — SessionStart identity/state inject, hook contract w/ fixtures, worktree isolation policy (umbrella G5+G10, 2026-07-09)
- [genie-spend](brainstorms/genie-spend/DRAFT.md) — LangWatch-backed spend report + decision-level cost join (umbrella G7, 2026-07-09)
- [dream-replatform](brainstorms/dream-replatform/DRAFT.md) — scheduler adapter + genie.db ledger; cron = trigger never authority; omni approval gates (umbrella G9, 2026-07-09)

## Simmering
- [intent-to-wish-compiler](brainstorms/intent-to-wish-compiler/DRAFT.md) — WRS 92; Shape Up spine + Working Backwards intake + Impact Mapping roadmap + Genie proof compiler; invisible Incident/Patch/Small/Standard/Program/Spike routing; breaker contract RATIFIED ("cut breadth/attempts, never proof; only humans cut payout"; autonomous flex cuts, human-only partial-ship) — program-scale, splits at pour time (2026-07-09)
- [brainstorm-domain-map](brainstorms/brainstorm-domain-map/DRAFT.md) — WRS 80; executable-specification compiler: stakeholder intent → requirement/oracle graph → bounded execution → proof packet → residual-risk review; open boundary is ownership of irreducibly subjective truth (umbrella G8, resumed 2026-07-09)
- [cross-agent-delegate](brainstorms/cross-agent-delegate/DRAFT.md) — delegate skill (Codex+Hermes), wish companion sessions, refine style cards, auto plan-gate counter-read (umbrella G6, 2026-07-09)

## Ready


- [WISH: hook-injection-hardening](wishes/hook-injection-hardening/WISH.md) — BLOCKED-clearing safety edit: `execFileSync` at 3 hook sites (audit-context, freshness×2) + hostile-filename regression tests + `core.bare` probe removal; flips panel verdict BLOCKED→FIX-FIRST — SHIPPED → PR #2536 (wish/hook-injection-hardening→main), G1+G2+whole-wish reviews SHIP, 729 pass/0 fail (2026-07-09)
- [WISH: v5-completion](wishes/v5-completion/WISH.md) — CLAUDE.md-for-v5 rewrite ∥ Codex launch target + Hermes decision ∥ distribution 5.x (drafted 2026-07-02)
- [WISH: dispatch-inproc-default](wishes/dispatch-inproc-default/WISH.md) — HIGH discovered defect: v5 hooks fall open by default (daemon deleted in demolition); re-arm branch-guard + unblock omni approvals (drafted 2026-07-02)
- [WISH: omni-approval-ux](wishes/omni-approval-ux/WISH.md) — correlated approval identity, reaction approve/deny, anti-spam feedback; grounded in the 2026-07-03 live WhatsApp QA (drafted 2026-07-03)
- [WISH: omni-runner-port](wishes/omni-runner-port/WISH.md) — umbrella Group 5: approval-capture spike, global genie.db queue, genie omni serve, inbound one-shot (drafted 2026-07-02)
- [WISH: warp-integration](wishes/warp-integration/WISH.md) — umbrella Group 3: genie init, Warp launch-config emitter, genie launch, /work multi-session opt-in (drafted 2026-07-02)

## Poured
- [agent-sync](wishes/agent-sync/DESIGN.md) · [WISH](wishes/agent-sync/WISH.md) — `genie update` = único verbo canônico que converge TODOS os coding agents detectados (Claude Code skills+council stamp, Codex Agent-Skills em .curated/, Hermes symlink+enable); engine interna manifest+adopt-with-backup+orphan-removal; hook CC vira trigger; mata scripts/smart-install.js divergente — EXECUTADO 2026-07-10: G1 `033b423f` (fix loop matou HIGH data-loss), G2 `b85ff792` (+hardening), G3 `e871b0fb` (+M1 constantes), ride-along `d0d61211` (coerção string-args do /council, achado no live QA); final review SHIP, 806 pass/1 skip; resta: ritual live user-gated + decisão de PR-topology (3 commits plugin-resource-shipping na linhagem, conteúdo já em dev via #2540)
- [council-workflow](brainstorms/council-workflow/DESIGN.md) · [WISH](wishes/council-workflow/WISH.md) — /council vira saved workflow nativo (deliberation + audit), lens library 13 (7 persona skills renomeadas por lane + 6 cards), distribuição via install-stamp em ~/.claude/workflows; implementa a disposição council do skill-absorbs G4 — EXECUTADO 2026-07-10: G1 `0b222e17`, G2 `12270b21` (1 fix loop: unwrap p/ body-style do runtime), G3 `22a7ed50`, G4 `2af7ebd9`, G5-eng `6494253d` — todos SHIP; QA vivo USER-GATED pós-release (ritual Felipe: merge→release→plugin update→rodar /council "revisar tudo"; g5-gate para na cauda qa/ até lá); final execution review após o QA
- [plugin-resource-shipping](brainstorms/plugin-resource-shipping/DRAFT.md) · [WISH](wishes/plugin-resource-shipping/WISH.md) — in-skill template via ${CLAUDE_SKILL_DIR}, probe-guarded lint refs, resource-shipping lint, fresh-install CI smoke — EXECUTED 2026-07-10 (first wish under the routing matrix: engineers opus·high, gate fable·high; 0 fix loops all groups; gate SHIP after branch surgery — concurrent session had switched the shared checkout): G1 ecbb67fc, G3 203c97df, G2 bbd6439e → PR #2540 merged, CI 10/10; QA pending: live installed-plugin scaffold on next release
- [routing-matrix](brainstorms/routing-matrix/DRAFT.md) · [WISH](wishes/routing-matrix/WISH.md) — pinned role agents (Fable gates / Opus ladder / Haiku scouts), stage pins + pane flags, complexity columns + lint, escalation caps — executed; execution review SHIP, final gate 719 pass / 1 skip / 0 fail; live LangWatch pin QA pending (2026-07-09)
- [genie-token-efficiency-program](brainstorms/genie-token-efficiency-program/DESIGN.md) — umbrella (WRS 100, independent review SHIP; 9 seed groups): genie → control-plane thesis; routing matrix (Fable gates, Opus ladder, no Sonnet, $17.9k/21d baseline); 17-skill dispositions; always-on identity; cross-agent delegate (Codex/Hermes companion sessions); genie spend; brainstorm domain-map upgrade — crystallized 2026-07-09
- [genie-mcp](brainstorms/genie-mcp/DESIGN.md) · [WISH](wishes/genie-mcp/WISH.md) — genie MCP server: Warp/Claude Code/Codex consume genie.db state read-only; stdio, auto-registered; spike-first (2026-07-03)

- [Genie v5 — lightweight body](brainstorms/genie-v5-lightweight-body/DESIGN.md) — skills+files+stock Warp replace the v4 harness; CC/Codex/Hermes targets; omni keeps one runner; crystallized 2026-07-01, umbrella-scale (8 seed groups)
  - [WISH: v5-foundation](wishes/v5-foundation/WISH.md) — umbrella Groups 1+2: genie.db engine + CLI + core skills — DONE 2026-07-02, all groups SHIP
  - [WISH: v5-demolition](wishes/v5-demolition/WISH.md) — umbrella Group 6 pulled forward (D8): harness deletion, bare-name cutover, v4 branch, PR #2499 — DONE 2026-07-02
  - [WISH: v5-housekeeping](wishes/v5-housekeeping/WISH.md) — true-lightweight tree cleanup (root files, .genie v4 history, metrics bot) + README replan (drafted 2026-07-02)
- [WISH: taxonomy-rehoming](wishes/taxonomy-rehoming/WISH.md) — plans migrate to genie's own taxonomy (`.genie/wishes|brainstorms`); path claims made coherent; user skills speak genie (2026-07-02)
