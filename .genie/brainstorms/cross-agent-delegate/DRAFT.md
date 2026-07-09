# DRAFT: cross-agent-delegate (Domain F — umbrella G6 + refine)

**Parent:** [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) · **Status:** Simmering

## KNOWN (evidence — nous-skills-research 2026-07-09)
- NousResearch/hermes-agent `skills/autonomous-ai-agents/` = one adapter skill per external CLI (claude-code, codex, hermes, opencode), all CLI-over-terminal. Portable mechanics:
  - codex: `codex exec` one-shot needs git repo + PTY + `--full-auto`; JSON output; `codex review --base origin/main`; parallel via git worktrees; auth via OPENAI_API_KEY or ~/.codex/auth.json.
  - hermes: oneshot `hermes chat -q` (host alias `-z` works on cegonha); continue-by-title `-c <name>` (title-fallback trap!); sessions in ~/.hermes/state.db; `delegate_task` in-process subagents; kanban board ≈ genie task-state parallel.
  - claude-code (mirror image): `claude -p --output-format json` returns {result, session_id, cost}; `--session-id <uuid>` pins; `--resume`; `--bare` skips plugins.
- hermes-pairing skill already does the manual version (SSH + base64 + timeout + wish-<slug> sessions); its gotchas are proven (used live in this brainstorm, 2 rounds).
- Cross-LLM = off-Anthropic-bill cost arbitrage + genuine dissent diversity.

## DECIDED (umbrella D11, D12; Felipe 2026-07-09)
- ONE `delegate` skill + per-agent adapter references (delegate/agents/codex.md, hermes.md). Launch scope Codex + Hermes; opencode = stub, OUT.
- Wish-based companion sessions: one named session per (wish × agent), title `wish-<slug>`, session ref persisted on the wish row in genie.db; every /work turn reconnects.
- Structured hand-back (JSON) + background+poll for long runs.
- refine = cross-LLM prompt adapter: backbone method (intent→constraints→evidence→acceptance) + per-target style cards `refine/targets/{fable,gpt-codex,hermes,haiku}.md` ≤60 lines; auto-applied to outgoing briefs; manual `/refine --target`.
- **Auto Hermes counter-read at plan gates** (decided); execution gates trigger-based (disagreement/high blast radius). Codex + council LLM-lenses on-demand.

## Degradation policy (learned live, 2026-07-09)
First real invocation of the auto plan-gate counter-read hit cegonha unreachable (network path down; host fine an hour earlier). Decided behavior to encode in the delegate skill: **counter-read fails OPEN** — the gate proceeds on the internal reviewer alone, logs "counter-read unavailable (host unreachable)" in the review record, and the next gate retries. Never block a plan gate on external-agent availability; never silently pretend the counter-read happened.

## GAPS
- [ ] Codex reality on your machines: installed? auth method (API key vs OAuth)? Which lifecycle roles do you want Codex for first — engineer on suitable groups, PR review dissent, or both?
- [ ] Hermes canonical vs alias: confirm `-z` is a cegonha alias (helper works today; adapter should document canonical `hermes chat -q` + fallback).
- [ ] Budget/limits for external agents: max concurrent companion sessions? Hermes host load limits (cegonha is shared infra — benchmarks run there)?
- [ ] Session lifecycle: when a wish ships, are its companion sessions retired (hermes sessions delete is gated on shared infra) or kept as history?
- [ ] Collision: v5-completion wish carries "Codex launch target + Hermes decision" — reconcile scope so two wishes don't both own Codex integration.
- [ ] The 721-line optimizer → style cards distillation: you said your method is well-structured — walk me through the parts you consider load-bearing so the cards keep them.
