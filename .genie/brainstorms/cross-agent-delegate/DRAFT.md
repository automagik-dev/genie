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

## RECONCILE (2026-07-10 — agent-sync shipped, PR #2541 merged to dev)

**The Codex *plumbing* is now built and owned by agent-sync — this track consumes it, does not rebuild it.** `genie update` (and `genie install`) now fan the canonical `~/.genie/plugins/genie` source into every DETECTED coding agent on every invocation, including a **Codex adapter that ships genie skills to `~/.codex/skills/.curated/`** (managed manifest + adopt-with-backup + orphan removal). So the "one delegate skill + per-agent adapter references" decision is unchanged, but its Codex prerequisite — *getting genie's skills onto the Codex side* — is solved for free: the delegate skill can assume the curated genie skills are present on any machine that has run `genie update`. What remains this track's own work is the **delegation runtime** (companion `codex exec` / `hermes chat -q` sessions, JSON hand-back, background+poll, the `wish-<slug>` session persistence on the genie.db row), not the skill distribution. The Codex-install/auth GAP below narrows accordingly to *auth + which roles first*, since "are genie's skills installed on Codex" is answered by agent-sync.

## GAPS
- [ ] Codex reality on your machines: installed? auth method (API key vs OAuth)? Which lifecycle roles do you want Codex for first — engineer on suitable groups, PR review dissent, or both? (Skill distribution to `~/.codex/skills/.curated/` is now handled by agent-sync — see RECONCILE above; this GAP is now auth + role-scoping only.)
- [ ] Hermes canonical vs alias: confirm `-z` is a cegonha alias (helper works today; adapter should document canonical `hermes chat -q` + fallback).
- [ ] Budget/limits for external agents: max concurrent companion sessions? Hermes host load limits (cegonha is shared infra — benchmarks run there)?
- [ ] Session lifecycle: when a wish ships, are its companion sessions retired (hermes sessions delete is gated on shared infra) or kept as history?
- [ ] Collision: v5-completion wish carries "Codex launch target + Hermes decision" — reconcile scope so two wishes don't both own Codex integration.
- [ ] The 721-line optimizer → style cards distillation: you said your method is well-structured — walk me through the parts you consider load-bearing so the cards keep them.
