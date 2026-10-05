# rlmx-claude-plugin — Brainstorm Draft

**Status:** Simmering · started 2026-07-26
**Supersedes:** the three ad-hoc global microagents (`~/.rlmx/agents/{log-triage,codebase-qa,changelog}`) — built without workload evidence, to be replaced. Also reshapes the wish-2 benchmark arms (khal LiteLLM replaces "cheap cloud").

## Problem

Claude Code burns premium-model quota on repeatable, mechanical delegation.
Measured on this host, last 7 days (58 transcripts):

- **3.09B input+cacheRead tokens** across 13,105 turns, ~all Fable/Opus tier
  (9,090 Fable + 3,898 Opus turns), 14M output tokens, 88M cacheWrite.
- **245 subagent spawns/week**: genie:reviewer x121 (101 + 20 unprefixed),
  engineer-standard/complex x60 (31+25+4), fixer x33 (29+4), general-purpose
  x15, Explore x9, final-gate x7 — sums to 245. Each re-reads wish + diff at
  premium price for a spec-driven, repeatable role.
- Bash result bytes dominated by exploration dumps: grep/sed/cat/ls/tail,
  git/gh, journalctl — 28% of tool-result bytes in the 48h window.

rlmx already has the offload primitive (microagents as MCP tools, `rlmx mcp`,
workspace discovery in `src/mcp/agents.ts`) but the current integration is 3
global toy agents with no mapping to real workloads, no workspace presence, no
way to grow the set, and no guidance telling Claude *when* to delegate.

## Vision (user's words, condensed)

Workspace-scoped microagents: if the cwd has `.rlmx/agents/` (or `.agents/`),
Claude Code sees that workspace's microagents as tools and offloads small
repeatable work (explore-class tasks) to cheap models instead of spending
premium quota. Delivered as a **Claude Code plugin** with a microagent
skillset instructing Claude how to do everything — including
`/microagent-create`, which self-reflects over the past 24h of session
transcripts to identify new microagent opportunities ranked by what consumes
the most tokens. Benchmark khal models to pick the fastest/best worker.

## Scope

**IN**
- Claude Code plugin: skills + MCP server wiring + microagent conventions.
- Workspace microagent convention (`.rlmx/agents/` per repo; global fallback).
- Skillset: when-to-offload guidance for Claude (explore, triage, summarize),
  `/microagent-create` (transcript self-reflection → proposed agent.yaml),
  `/microagent-bench` or equivalent for model shootouts.
- `khal` provider in rlmx (LiteLLM at https://llm.khal.ai, OpenAI-compatible;
  key via env — never committed).
- Live tool refresh: re-run `discoverAgents` per tools/list + emit
  `listChanged` so agents created mid-session appear without reconnect
  (today discovery runs once at server start — `src/mcp/server.ts:328`).
- Model shootout across khal arms on real microagent tasks; winner becomes the
  default worker model.
- Initial dogfood agent set derived from the 7-day evidence (see questionary).

**OUT**
- npm publishing (user lost access; SDK channel already decoupled).
- ACP hosts beyond Claude Code/Codex/Hermes/CLI (settled earlier).
- Replacing genie — the plugin offloads *worker lanes*, genie stays the
  orchestrator.

## khal model landscape (fetched 2026-07-26, /model/info)

| model | upstream | $/M in | $/M out | ctx |
|---|---|---|---|---|
| khal/deepseek-v4-flash | DeepSeek-V4-Flash | 0.10 | 0.20 | 1M |
| khal/mimo-v2.5 | MiMo-V2.5 | 0.40 | 2.00 | 262k |
| khal/minimax-m3 | MiniMax-M3 | 0.50 | 2.25 | 196k |
| khal/kimi-code | Kimi-K2.7-Code | 0.74 | 3.50 | 262k |
| khal/mimo-v2.5-pro | MiMo-V2.5-Pro | 1.00 | 3.00 | 1M |
| khal/glm-5.2 | GLM-5.2 | 1.00 | 4.00 | 1M |
| khal/claude-haiku | Haiku 4.5 | 1.00 | 5.00 | 200k |
| khal/deepseek-v4-pro | DeepSeek-V4-Pro | 1.30 | 2.60 | 1M |
| khal/qwen3.7-max | Qwen3.7-Max | 2.50 | 7.50 | 256k |
| khal/claude-sonnet | Sonnet 4.6 | 3.00 | 15.00 | 200k |

Shortlisted bench arms: deepseek-v4-flash (cost outlier), mimo-v2.5,
minimax-m3, kimi-code, glm-5.2, claude-haiku (quality reference). Sonnet is
what we're offloading *from*, not an arm. Station (local, $0) stays as arm 0.

## Candidate initial microagents (evidence-ranked)

1. **explore** — answer a codebase question (grep/read/summarize inside the
   REPL, return the answer not the dumps). Offloads Explore spawns + the
   grep/sed/cat/ls Bash-dump class. Biggest context-growth class.
2. **review-lite** — first-pass diff review against stated criteria; premium
   reviewer only on escalation. genie:reviewer is x121/week.
3. **triage** — logs/test-output/journalctl → structured verdict (the one
   Opus-built agent worth keeping, generalized).
4. **git-historian** — summarize git log/blame/PR state for a question.

## Decisions

- D1 (settled): workspace-first discovery already in code; plugin makes it a
  convention. Live refresh required.
- D2 (settled): khal key handled as env secret (`~/.rlmx` env or bitwarden
  flow), never committed. LiteLLM virtual keys supported later.
- D3 (settled by evidence): microagents must be `loop`-shaped by default —
  single-step + externalized context answers without reading (dogfood finding,
  PR #118).
- D4 (settled 2026-07-26): **explore first** — plus the user's dogfood method:
  mine one significant real opportunity from past-24h transcripts, run it
  through the explore microagent, loop-improve until on par with native
  Explore. review-lite / git-historian become /microagent-create candidates
  after parity.
- D5 (settled): plugin lives in the rlmx repo (`plugins/claude-code/`).
- D6 (settled): bench = real microagent tasks now; Aider polyglot deferred to
  the launch wish (khal arms replace "cheap cloud" there too).
- D7 (settled): /microagent-create is propose-only — draft + evidence, user
  approves.

## Risks

- **Quality floor:** a cheap model's wrong answer costs more than it saves.
  Mitigation: bench on real replayed tasks; escalation path to premium.
- **cwd assumption:** workspace discovery relies on Claude Code spawning the
  stdio server with the project cwd. Must verify with a probe agent before
  building on it.
- **Static tools/list:** fixed in-scope (live refresh); until then created
  agents need a `/mcp` reconnect.
- **Secret handling:** khal key appeared in chat; treat as compromised-ish —
  recommend rotation after setup; never write into repo files.
- **Benchmark drift vs wish-2:** Aider polyglot full-run decision predates
  khal; must be explicitly reconciled (Q3), not silently dropped.

## Criteria (draft)

- From a workspace with `.rlmx/agents/explore/`, a Claude Code session lists
  and calls `rlmx_explore`; answer correct; tokens-through-Claude for the task
  ≥80% lower than doing it inline (measured on a fixed task).
- `/microagent-create` reads last-24h transcripts and proposes ≥1 viable
  agent.yaml with evidence (token counts) for why it exists.
- Bench table in docs: ≥5 khal arms + station on ≥10 real microagent tasks,
  wall-time + cost + correctness per arm; default model = winner.
- Old global toy agents archived; plugin installable in one command.

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

Crystallized → `DESIGN.md` (2026-07-26).
