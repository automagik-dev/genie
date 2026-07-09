# DRAFT: routing-matrix (Domain B — umbrella G1)

**Parent:** [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) · **Status:** Simmering — closest to /wish-ready

## KNOWN (evidence)
- $17,857 / 95.8M billable tokens in 21d; Fable ≈ $13.8k of model-attributed cost; effort spread: xhigh 425 · high 343 · max 198 · medium 27 · low 2 (LangWatch, 2026-07-09).
- `/work` and all lifecycle skills dispatch subagents with ZERO model/effort pinning → everything inherits the session (Fable-xhigh).
- CC surfaces confirmed: subagent frontmatter pins `model:` + `effort:` (plugin-shippable); skill frontmatter can too (⚠️ mid-session model flip invalidates main-session prompt cache); `CLAUDE_CODE_SUBAGENT_MODEL` env overrides ALL pins.
- Pricing: Fable $10/$50 · Opus 4.8 $5/$25 · Haiku $1/$5 /MTok. Effort = second cost axis.

## DECIDED (umbrella D1–D6)
- Matrix: Fable-high = /brainstorm+/wish sessions + final plan gate + final execution review. Opus-xhigh = /work orchestrator (default), plan-review loops, per-group execution reviews. Engineers: Opus ladder by complexity score (0-1→Opus-low; Haiku only for pure mechanical chores with deterministic acceptance; 2-3→med/high; 4-6→xhigh; 7+→xhigh+Fable gate). Fixers Opus-med/high. Scouts/chores Haiku. **No Sonnet 5** (Felipe: 2× tokens/time observed; revisit only via LangWatch A/B).
- Encoding: plugin `agents/` by capability profile (engineer-trivial/standard/complex, fixer, reviewer, final-gate, scout) + local config override.
- Complexity score rubric (Hermes): +2 orchestration/routing/stateful/subjective-acceptance; +1 coupling signals. /wish assigns, plan review validates.
- Escalation discipline: cause classification mandatory (env/tool/spec failures NEVER escalate the model); no escalation without new evidence; caps per group/wish; reviewer↔gate disagreement = logged appeal.
- WISH template gains complexity + model columns; `genie doctor` checks CLAUDE_CODE_SUBAGENT_MODEL unset.

## GAPS (need Felipe / further refinement)
- [x] **Main-session UX — DECIDED (2026-07-09): skill pins + pane flags.** /brainstorm + /wish pin `model: fable` + `effort: high`, /work pins `model: opus` + `effort: xhigh` in skill frontmatter (applies while skill active; one cache flip at stage boundary, stable after). genie launch opens Warp panes with per-stage `--model` flags. Manual /model always overrides. No hard guard hook (rejected as too annoying); the state inject may still note a mismatch informationally.
- [x] **Budgets — DECIDED (2026-07-09): hybrid.** HARD now: max Fable calls/wish = 3 (plan gate, final gate, +1 appeal) and max 2 escalations/group — exceeding requires an explicit logged override. ADVISORY: $/wish, promoted to hard once genie-spend phase 2 makes it measurable.
- [x] **Max effort — DECIDED (2026-07-09): auto-routing caps at xhigh, EXCEPT the Fable gate on complexity-7+ groups runs at max automatically** (the one structural correctness-over-cost point). Manual /effort or explicit WISH.md annotation can always request max. Regular final gates stay Fable-high.
- [x] **Config override surface — decided (engineering call, native-first):** model/effort overrides use CC's native precedence — a project `.claude/agents/<role>.md` shadows the plugin's shipped role agent (zero new machinery); budgets/caps/policy knobs live in genie config (existing surface: `templates/genie-config.template.json`, `GENIE_CONFIG_FILE`, repo `.genie` > global `~/.genie` > shipped defaults). The dispatch-contract documents both.

## STATUS: WISH-READY (all 4 gaps closed 2026-07-09)
