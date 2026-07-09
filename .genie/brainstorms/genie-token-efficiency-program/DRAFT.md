# DRAFT: Genie Token-Efficiency Program (umbrella)

**Slug:** `genie-token-efficiency-program`
**Date started:** 2026-07-08
**Status:** Poured — `DESIGN.md` crystallized; independent review SHIP

## Ask (Felipe, 2026-07-08)

1. **Model routing** — Fable 5 selectively for complex reasoning; Opus 4.8 at varying efforts for the rest; max-effort reviews + final Fable review. Objective: most token-efficient combination.
2. **LangWatch-driven analysis** — genie is very token-intensive; all sessions recorded via CC OTel → langwatch.khal.ai (creds in ~/.claude/settings.json, raw API bodies ON).
3. **Context-domain breakdown** — break genie into context areas, brainstorm each individually. Time is not a constraint.
4. **Per-agent/per-skill disposition audit** — absorb / delete / keep / refactor, each with recommendation, pressure-tested with Hermes (cegonhas).
5. **Native CC adoption** — bundled workflows, worktrees, agent teams, plugin improvements.
6. **Meta** — brainstorm skill lacks context-domain & gap mapping; that is what brainstorming must fill to yield a flawless spec. Propose the improvement.

## Evidence so far

- Genie repo `skills/`: brainstorm, council, docs, dream, fix, genie, genie-hacks, learn, omni, pm, refine, report, review, trace, wish, wizard, work (17) + README.
- Global `~/.claude/skills/` (installed): brainstorm, wish, work, review, skill-management, hermes-pairing, fde-*, movecta (9). Overlap = the lifecycle four.
- Existing wish: `skills-fable5-revamp` — must read as seed.
- OTel: `OTEL_EXPORTER_OTLP_ENDPOINT=https://langwatch.khal.ai/api/otel`, bearer key present, `OTEL_LOG_RAW_API_BODIES=1`.
- Repo `.claude/`: commands/, hooks/, worktrees/, settings.json.
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` already enabled globally.

## Evidence — LangWatch baseline (final, langwatch-research 2026-07-09)

- **21-day window (06-18→07-09): $17,857 total cost, 95.77M billable tokens (19.68M prompt + 76.09M completion), 11.79B cache-read tokens, 1097 traces — ~1000 of them in the last ~4 days.** Burn rate at current pace ≈ $3–4k/day.
- Cost by model (span-attributed shares): **Fable $13,766 · Opus 4.8 $7,125 · Haiku $1,220 · Sonnet $478** (sums exceed trace-total; use as shares).
- Effort distribution (recent 1000 traces): xhigh 425 · high 343 · **max 198** · medium 27 · low 2.
- Analytics API: metrics incl. total_cost/prompt/completion/cache_read/cache_write/reasoning_tokens; groupBy incl. `metadata.labels`, `metadata.thread_id`, `metadata.model`, `traces.trace_name`; NO reasoning_effort groupBy (loop filtered queries: `filters:{"metadata.key":["gen_ai.request.reasoning_effort"],"metadata.value":["<v>"]}`). Working recipes archived in langwatch-research report.
- LangWatch CLI (`npm i -g langwatch`) is designed to be driven by a coding assistant — `langwatch trace search/export`, `langwatch analytics`, `--format json`. Candidate substrate for a `genie spend` report (Domain A).
- LangWatch "skills" = 7 read-docs-first guides (Tracing, Evaluations, Scenarios, Prompts, **Analytics**, Datasets, Level Up); PM/domain-experts = same skills as collab framing. Nothing to import wholesale for Domain E — write our own lens prompts.
- Valid analytics groupBy enums: topics.topics, traces.trace_name, metadata.{user_id,thread_id,customer_id,labels,model,span_type}, sentiment, events.event_type, evaluations.*, error.has_error. → `metadata.labels` = the hook for per-skill/per-dispatch attribution.
- Traces carry `gen_ai.request.reasoning_effort`, thread_id (CC session), full bodies (OTEL_LOG_RAW_API_BODIES=1).

## Evidence — genie surfaces

- `/work` dispatches engineer/reviewer/fixer via Agent tool with **zero model/effort pinning** → everything inherits session model (currently Fable 5 xhigh). Single biggest cost lever.
- Skills post-fable5-revamp: 17 dirs, ~12.5k words total; heaviest: work 1161w, report 965w, brainstorm 940w, review 933w, genie 897w.
- skills-fable5-revamp wish: G1–G8 committed on dev, awaiting execution review — don't double-plan its scope (compression is DONE; disposition/routing is NOT).
- skills/README.md already carries the v5 keep/port table (4 core, 9 portable-now, 3 port-deferred, 1 needs-capability) — seed for the disposition audit, but pre-dates native workflows/teams lens.
- Plugin (plugins/genie/): hooks (3× SessionStart incl. session-context injector, PreToolUse SendMessage+Write, Stop validate-completion), rules/genie-orchestration.md (20 lines, always-loaded), references/, .mcp.json (genie mcp), settings perms.
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` already on globally.

## Proposed context-domain map (to confirm with Felipe)

| Domain | Content | Ships independently? |
|--------|---------|---------------------|
| **A. Measurement** | LangWatch attribution: label every genie dispatch (skill/group/role), repeatable spend report, baseline dashboards | yes |
| **B. Model-mix routing** | Fable-vs-Opus×effort matrix per lifecycle stage; encode in dispatch prompts/agents/workflows; final-Fable-review pattern | yes |
| **C. Skill/agent disposition audit** | 17 genie skills + plugin surfaces + global overlap: absorb/delete/keep/refactor; Hermes (cegonha) pressure-test | coupled to D |
| **D. Native CC adoption** | bundled workflows, worktrees, agent teams, plugin modernization | coupled to C |
| **E. Brainstorm-skill upgrade** | context-domain & gap mapping phase → flawless-spec output | yes |

## Domain B — model-mix routing (in progress)

Confirmed order: **B → C+D → A → E** (Felipe, 2026-07-08).

Pricing (claude-api skill, cached 2026-06-24): Fable 5 $10/$50; Opus 4.8 $5/$25; Sonnet 5 $3/$15 (intro $2/$10 through 2026-08-31); Haiku 4.5 $1/$5 per MTok.

Key mechanics:
- Effort (`low..max`) is the 2nd cost axis — controls thinking + tool-call count + verbosity. Fable at low "often exceeds xhigh of previous models".
- Prompt cache is model-scoped; switching models mid-session invalidates it. Official workaround = genie's architecture: main loop one model, subagents pinned cheaper. Model pinning on subagents costs nothing cache-wise.
- Reviews-recall gotcha: Opus 4.8/Sonnet 5 follow "only report high-severity" literally → report-everything-filter-downstream prompts for reviewers.
- Felipe's stated philosophy (given, not open): Fable selectively for complex reasoning; Opus tiers for the rest; max reviews; final Fable review.

**DECIDED matrix (Felipe 2026-07-08 — Sonnet 5 excluded everywhere: observed 2× time + 2× tokens for same tasks, making it pricier than Opus even at intro rates; Opus ladder opens downward for low-complexity):**

| Stage | Model × effort |
|---|---|
| /brainstorm + /wish main session | Fable 5 · high |
| Plan-review loops (subagent) | Opus 4.8 · xhigh |
| Final plan gate | Fable 5 · high |
| /work orchestrator session | Opus 4.8 · high |
| Engineers — trivial/mechanical group | Opus 4.8 · low–medium |
| Engineers — standard group | Opus 4.8 · high |
| Engineers — complex group | Opus 4.8 · xhigh |
| Fixers | Opus 4.8 · medium–high (by gap severity) |
| Execution reviews (per group) | Opus 4.8 · xhigh |
| Final execution review (pre-ship) | Fable 5 · high |
| Scouts/Explore, mechanical chores | Haiku 4.5 |

Domain B decisions:
1. **Matrix above** — complexity column per execution group in WISH.md (trivial/standard/complex → effort rung); /wish assigns, plan review validates.
2. **Encoding**: plugin `agents/` role definitions (engineer/fixer/reviewer/scout) pin model+effort in frontmatter (pending cc-native-research confirmation of effort frontmatter); dispatch tables in work/review skills reference roles, never bare Agent calls. One canonical routing reference so LangWatch data can revise it in one place.
3. **Escalation rung**: failed fix loop or 2× FIX-FIRST → one rung up (opus-high → opus-xhigh → Fable-high). Never silently escalate to Fable without logging.
4. **Data-adjustable**: matrix is config informed by LangWatch (Domain A labels genie.role/group/model); Sonnet exclusion revisitable only via LangWatch A/B evidence.

Domain B risks:
- Agent-def model/effort pinning must be honored by CC (verify via cc-native-research; fallback = model param on Agent tool + effort via prompt).
- Opus-low on trivial groups may under-think → mitigated by review gate + escalation rung.
- Fable main session may dominate spend even after subagent routing → Domain A measurement decides whether /work driving moves to an Opus session.

Domain B criteria:
- [ ] No genie dispatch inherits the session model implicitly — every role pins model+effort.
- [ ] Blended $/wish (LangWatch) drops ≥40% within 2 weeks, SHIP rate non-regressing.
- [ ] Escalation rung implemented + visible in review reports.

### Hermes (cegonha) pressure-test — AMENDMENTS ACCEPTED (2026-07-09)

Hermes' core critique: the matrix optimizes cost-per-call before proving **cost-per-correct-decision**; the orchestrator is a multiplier, not a worker. Amendments:

1. **/work orchestrator: Opus-xhigh default** (standard/complex wishes); Opus-high only for low-coupling mechanical groups with objective acceptance tests. "Economizing on the orchestrator saves cents on the call that decides millions of tokens later." Orchestrator gets a *verification budget*: before accepting a group it requires diff summary, real test evidence, acceptance checklist, residual risks, files touched, cross-group impact.
2. **Fable final review = narrow adversarial risk gate**, never generic review. Prompt: hunt ship-blockers, verify WISH adherence, find cross-group contradictions, missing proof; classify BLOCKER/FIX-FIRST/FOLLOW-UP/NIT; no plan rewrites, no aesthetics. Trivial/mechanical wishes: Opus-xhigh aggregate review, Fable only on triggers (failed fix loop, reviewer/orchestrator disagreement, missing proof, security/stateful/production impact, cost-routing changes, ambiguous acceptance).
3. **Escalation discipline** (anti "escalation laundering"): mandatory `escalation_reason` with cause classification (model capacity vs missing context vs ambiguous spec vs env/tool failure — the last three NEVER escalate the model); **no escalation without new evidence** (new test/log/smaller diff/minimal repro); caps: max escalations per group, max Fable calls per wish, hard stop when same acceptance criterion fails N times; reviewer↔gate disagreement = explicit appeal with recorded resolution, never silent big-model override.
4. **Complexity score replaces vibes**: +2 orchestration/agent-lifecycle/routing · +2 cost/model/escalation changes · +2 stateful · +2 subjective acceptance · +1 each multi-package / OTel-labels dependency / no deterministic test / prior rework / prompt-skill changes / CI-release. Route: 0-1→Haiku/Opus-low · 2-3→Opus-medium/high · 4-6→Opus-xhigh · 7+→Opus-xhigh + Fable gate. /wish computes the score per group; plan review validates it.
5. **Context budget parallel to model budget** ("context diet"): scouts get question+paths only; engineers get group+acceptance+relevant files; reviewers get diff+acceptance+proof; final gate gets WISH+aggregate evidence+unresolved risks (never full transcripts); fixers get finding+relevant diff+failing proof. Golden rule: **no model escalation without reducing/improving context**.
6. **Outcome labels for Domain A** (measure decisions, not calls): wish_slug, group_id, role, model, effort, complexity_score, retry_count, escalation_from/reason, fix_first_count, reviewer_verdict, final_gate_verdict, reopened, shipped, reverted. North-star metric: **cost per group accepted without reopening**, not cost per agent run.

### Encoding surface — CONFIRMED (cc-native-research 2026-07-09)

- **Subagent definitions (plugin `agents/` or `.claude/agents/*.md`) pin BOTH `model:` and `effort:` in frontmatter** — aliases accepted; applies whenever the agent is spawned. → canonical surface: genie plugin ships role agents `engineer-trivial/standard/complex`, `fixer`, `reviewer`, `final-gate` (Fable), `scout` (Haiku) with pinned model+effort. Genie plugin ships ZERO agents today.
- **Skill frontmatter also takes `model:` + `effort:`** (overrides session for that turn) — could pin /brainstorm=/wish=Fable-high, /work=Opus-xhigh at the skill level. ⚠️ cache caveat: model switch invalidates the main-session prompt cache, so mid-session skill-level model flips have a real cost; prefer session-level defaults per lifecycle stage + pinned subagents (subagents have separate contexts → no cache penalty).
- Workflow `agent(prompt, {model, effort})` per call; Agent tool has `model` param; teams: teammates inherit lead effort, no per-teammate pinning (spawn-prompt text only).
- Hygiene risk: `CLAUDE_CODE_SUBAGENT_MODEL` env globally overrides per-agent pins — genie doctor should check it's unset.

WRS(B): ✅ 100 — matrix + Hermes amendments + encoding surface all locked.

## Domain D raw material (cc-native-research)

- **Native worktrees**: `--worktree`, EnterWorktree, `isolation: "worktree"` per-agent, `.worktreeinclude`, `worktree.baseRef`, PR-based worktrees; project plugins auto-load in worktrees (v2.1.200). Genie launch keeps: Warp multi-pane UX, task-group→worktree mapping, persistent task metadata.
- **Workflows**: NOT plugin-shippable (project `.claude/workflows/` or `~/.claude/workflows/` only) → `genie init` could scaffold them into target repos. /work wave-dispatch is workflow-shaped (deterministic fan-out, per-agent model/effort, 16-concurrent cap, resumable same-session).
- **Agent teams** (experimental, already enabled): shared task list, SendMessage, plan-approval mode — overlaps genie task checkout/board; limitations: no resume, one team/session, no nested teams, task-status lag.
- **Token features**: hook preprocessing (PreToolUse/PostToolUse filter tool output before context), skill-description budget 1,536 chars, auto-compaction, `DISABLE_PROMPT_CACHING_*` per tier, `/fast`.
- **Native gaps genie legitimately fills**: persistent cross-session task state (SQLite), wish/brainstorm git persistence, board queries, omni approval queue, multi-pane cockpit.

## Domain E — brainstorm-skill domain/gap mapping (preliminary draft)

Felipe's critique: /brainstorm tracks readiness (WRS) but never *maps the context domains and gaps* — which is what brainstorming must fill to yield a flawless spec. This session is itself evidence: the domain map (A–E table) had to be improvised; nothing in the skill asks for it.

Proposed changes to skills/brainstorm + ~/.claude/skills/brainstorm:
1. **Domain Map phase** (new step between "read context" and "clarify intent"): enumerate the context domains the idea touches; for each: evidence-in-hand (with source), open gaps, gap-filling route (ask user / dispatch research agent / mark OUT). Persisted as a DRAFT.md section, updated as gaps close.
2. **Gap ledger discipline**: every AskUserQuestion and research dispatch must map to a named gap; a gap with no route is a blocker for crystallize.
3. **WRS coupling**: Scope ✅ requires the domain map to exist; Decisions ✅ requires zero open gaps routed "ask user"; umbrella brainstorms track per-domain WRS (WRS(A), WRS(B)…) like this session does.
4. **Domain-expert lenses**: extend the existing "Decisions stuck → dispatch 2-3 lens subagents" rule — lenses come from the domain map (one per under-evidenced domain), not a fixed simplicity/ops/security triad. (Borrow framing from LangWatch skills/PMs-and-domain-experts docs — pending langwatch-research.)
5. **Crystallize check #5**: every mapped domain is either covered by Decisions/Criteria or explicitly OUT with rationale.

Open (waiting on langwatch-research): whether LangWatch "skills directory" offers importable domain-expert skill prompts worth wiring in vs writing our own lens prompts.

## Domain A — measurement & attribution (draft)

Facts: thread_id = whole CC session (no per-subagent split); model+effort attribution works today (model groupBy + effort filter-loop); `metadata.labels` groupBy exists but CC's OTel export doesn't emit genie labels; CC gives no per-subagent OTel attribute injection.

Design (recommended, zero CC-internals plumbing):
1. **Phase 1 — fingerprint attribution (free, ships with Domain B):** once roles pin distinct model×effort combos, cost splits by role for free (Haiku=scouts, Fable-in-/work-window=final gates, Opus-low/medium=trivial engineers…). Plus session-stage attribution: planning sessions run Fable, execution sessions Opus → thread_id ≈ lifecycle stage.
2. **Phase 1 — `genie spend` command:** wraps the proven analytics recipes (curl or `langwatch` CLI): $/day trend, $/model×effort, top sessions, top traces; reads key/endpoint from CC settings env. Output = terminal table + `--json`.
3. **Phase 2 — decision-level join (Hermes' north star):** genie.db already records dispatch events (task checkout/done, worker, timestamps) and can record verdicts, fix_first_count, escalation_reason, reopened (Domain B outputs). `genie spend --wish <slug>` correlates LangWatch traces (thread_id + time-window + model fingerprint) with genie.db rows → **cost per group accepted without reopening**.
4. **Phase 2 — evaluate LangWatch label-update API** for post-hoc trace labeling (genie labeler tags traces after each wave); only if correlation proves too fuzzy.

Criteria: [ ] `genie spend` answers $/day, $/model×effort, top-5 sessions in <5s. [ ] After one instrumented wish: per-group cost report with verdict/reopen join. [ ] Routing matrix revision proposals cite `genie spend` output.

## Domain C+D — disposition audit (my recommendations, pre-Hermes)

Inventory highlights (skill-inventory agent, 2026-07-09):
- Global ~/.claude/skills {brainstorm,wish,work,review} are NEWER dual-backend rewrites (CLI-optional, native Task tools fallback); repo copies retain stronger contracts (reviewer≠engineer, orchestrator-owns-done, wishes:lint). Convergence: global = base, port repo contracts back, repo = distribution source.
- Same dispatch contract duplicated 6× (work, pm, dream, council, fix, rules/genie-orchestration.md) → hoist to ONE shared reference (which also becomes home of the Domain B routing matrix).
- Plugin hooks: session-context.cjs, validate-wish.cjs, validate-completion.cjs all match v4 wish shapes → silently inert on v5 (one says "Run /forge", a dead v4 command). dispatch-contract.md is v4 (TeamCreate, model:"sonnet"); review-criteria.md contradicts skills (max 3 vs 2); plugin README advertises nonexistent skills/agents; brainstorm/dream reference nonexistent .genie/brainstorm.md (real file: INDEX.md); fix calls nonexistent `genie task comment/block`.

| Skill | Disposition (mine) | Rationale |
|---|---|---|
| brainstorm | KEEP + refactor | Converge repo↔global; add Domain E domain/gap mapping; fix jar path → INDEX.md; session opens on Fable-high |
| wish | KEEP + refactor | Converge; add per-group complexity score + model column (Domain B); global's inlined template wins |
| work | KEEP + refactor | Converge dual-backend; dispatch via pinned role agents; context-diet briefs; orchestrator Opus-xhigh; verification budget. Workflow-tool migration = later experiment, OUT here |
| review | KEEP + refactor | Fable final gate = narrow adversarial risk-gate prompt; Opus-xhigh reviewers; coverage-first reporting; ad-hoc diff review routes to native /code-review |
| fix | KEEP + refactor | Absorbs trace; drop dead task comment/block; hosts Domain B escalation discipline (cause classes, new-evidence rule, caps) |
| trace | ABSORB → fix | Read-only Agent dispatch + report format; no independent value |
| council | ABSORB → lens library | Pure Agent-teams orchestration; keep members/ as shared lenses consumed by review (panel) + brainstorm (domain experts) |
| genie | KEEP + slim | Router + state summary; absorbs wizard as first-run branch |
| wizard | ABSORB → genie | 57-line delegator; genie router already detects state |
| pm | ABSORB → work ref + dream successor | Copilot/pair ≈ work+board; triage guidance → reference; autopilot = dream substrate |
| dream | REFACTOR onto native schedule | Its blocker (bg exec) is solved natively (schedule/cron cloud agents, /loop). Thin skill: enumerate SHIP-ready wishes → schedule /work runs |
| learn | DELETE (confirm) | Native memory + /update-config cover the surfaces; keep at most a routing stub |
| refine | DELETE (archive prompt) | v4-era 721-line optimizer wrapper; Fable guidance: over-prescriptive prompts hurt; archive to genie-hacks catalog |
| docs | KEEP as-is | 43 lines, no native twin, docs-submodule aware |
| genie-hacks | KEEP | Unique community registry; bulk already deferred in references/ |
| report | REFACTOR (later) | Re-source observability to LangWatch (eat own dogfood); shrink; keep gh-issue intake |
| omni | KEEP | Unique external surface; port already planned (Group 5) |

Plugin/native (D) actions: ship `agents/` role definitions (B encoding); rewrite or delete the 3 stale hook scripts; rewrite dispatch-contract.md as the single hoisted dispatch+routing reference; fix review-criteria/README/jar-path drift; adopt `isolation: "worktree"` for parallel engineers + `.worktreeinclude` scaffold in genie init; genie launch keeps Warp cockpit; agent-teams shared task list stays OUT (genie.db is task truth); doctor checks CLAUDE_CODE_SUBAGENT_MODEL unset.

### Felipe's disposition rulings (2026-07-09)

- **refine → KEEP, re-scoped as CROSS-LLM PROMPT ADAPTER (DECIDED 2026-07-09):** Felipe's structured method (intent→constraints→evidence→acceptance) becomes the shared backbone; the 721-line optimizer distills into per-target style cards `refine/targets/{fable,gpt-codex,hermes,haiku}.md` (≤60 lines each: do/don't, structure template, failure modes). Consumed (a) automatically — Domain F cross-agent dispatch pipes every outgoing brief through the target's card; (b) manually — `/refine <prompt> --target <t>` loads only that card. Rationale: prompting is target-relative (pre-Fable universal method actively hurts Fable prompts); cost shape fixed (load one card, not 721 lines); adapter sits where prompts are actually produced (dispatch briefs).
- **learn → moved to attic for brain transfer:** `git mv skills/learn .genie/attic/skills/learn` DONE (uncommitted). Will be transferred to the brain (mnemosyne) later.
- **wizard → absorb into genie APPROVED**, plus NEW REQUIREMENT: **genie must load its main orchestration at all times, on first message, zero user action** (like hermes-agent always loads its agent identity).
  **Always-on design (Domain D):** two-layer, both plugin-shipped:
  (1) `rules/genie-orchestration.md` (always-loaded) grows into the thin genie identity: who genie is, lifecycle routing table (idea→/brainstorm, plan→/wish, execute→/work, gate→/review), control-plane invariants (genie.db=truth, reviewer≠engineer, orchestrator-owns-done), pointer to deep docs. Budget ≤40 lines — identity, not manual.
  (2) `session-context` SessionStart hook rewritten v5-aware (current one is silently dead on v5 shapes): injects live state — active wishes + status from WISH.md tables, ready groups from genie.db, first-run branch (no .genie/ → wizard flow inside genie skill). Fail-closed per Hermes hook contract (fixtures + CI smoke, no silent noop).
  Result: every session opens knowing it IS genie + what's in flight, without the user typing anything.
- **pm → absorb APPROVED**; Felipe has more context to add when we review brainstorm+wish against "real software spec" practices — parked, one subject at a time.
- **NEW SCOPE (Domain F): cross-agent delegation** — absorb NousResearch hermes-agent `autonomous-ai-agents` skill patterns (github.com/NousResearch/hermes-agent/tree/main/skills/autonomous-ai-agents): genie workflows calling OTHER agents/LLMs (Claude Code → Codex, → Hermes) for different-LLM perspectives inside a wish, with **wish-based reusable sessions** (persistent companion session per wish per external agent — generalize the hermes-pairing pattern). Research agent `nous-skills-research` dispatched.
- Process feedback: one subject at a time — no more batched disposition questions.

### Hermes round 2 — AMENDMENTS ACCEPTED (2026-07-09)

**Thesis reframe (program headline):** not "modernize genie using native CC" but **"reduce genie to the control-plane / audit / contract layer; native CC is the execution substrate."** Native = executor, scheduler, worktrees, runtime. genie.db + wish contract = ownership of done, reviewer≠engineer, lint gates, ledger, idempotency, cancellation, audit, promotion policy.

Disposition revisions:
- **learn**: NOT direct delete → **deprecation stub** routing `/learn memory`→native memory, `/learn config`→/update-config, `/learn skill|procedure`→genie-hacks/skill curation, `/learn routing-correction`→dispatch-contract patch. Delete after 1–2 releases of zero use.
- **refine**: delete stands, but with archive→genie-hacks + repo-wide reference scan + 1-cycle stub returning an instructive error.
- **council**: lens library **plus a thin `/council` route** (adapter over the same library). Preserves the 3 uses review/brainstorm don't cover: strategic decisions pre-artifact, dissent-preserving multi-lens output (positions/dissent/decision/unresolved-risks), and **appeal court for reviewer↔gate disagreements** — which Domain B's escalation-appeal rule needs anyway.
- **dream**: native cron/schedule = **trigger, never authority**. New dream = scheduler adapter + policy/ledger: every scheduled run opens a run row in genie.db; idempotency key (wish_slug+schedule_id+intended_at+git_ref); lease before dispatch; wish-state + human-gate checks; records native schedule/run ids + artifact/PR/trace links; terminal-state reconciliation; stale-lease expiry; cancellation flows genie→native.
- **report**: LangWatch-backed but with a portable local markdown/JSON fallback — no observability-health dependency.
- **genie router**: hard scope fence — intent resolution, route, precondition check, delegate, deprecation compat. Must NOT accumulate absorbed logic (no optimizer, no memory policy, no council logic, no PM triage, no autopilot policy).
- **Native team task list**: not ignored — optional read-only/ephemeral "execution scratchpad" bridge, reconciled into genie.db only by explicit orchestrator events; never decides done.

Convergence (global↔repo) policy — **don't pick a base; split by layer**: global = runtime/adapter base (dual-backend, CLI-optional); repo = contract/invariant base (reviewer≠engineer, orchestrator-owns-done, wishes:lint). dispatch-contract.md becomes the single VERSIONED contract both import; golden tests assert both surfaces obey the same invariants. Rule: differences about "how to execute without genie CLI" → take global; differences about "when done/review/lint/role-separation apply" → take repo.

Plugin hardening:
- `agents/` pins by **capability profile** (engineer-trivial=cheap-fast … final-gate=highest-reasoning) with default model + local config override — avoids model-name fossilization.
- dispatch-contract.md must be **executable**: schema + examples + lint + route matrix + deprecation map + a CI check that fails if canonical contract text is re-duplicated into skills.
- Hook contract: manifest with supported schema version; v4/v5 fixtures; per-hook CI smoke; unknown schema ⇒ fail closed with clear message — **silent noop prohibited**; /forge reference removed immediately.
- Worktree isolation policy beyond files: per-agent branch + env overlay, resource locks for stateful surfaces (DB migrations, ports, shared caches), orphan-worktree reaper, final integration gate.

## Domain F — cross-agent delegation (design, post nous-skills-research 2026-07-09)

Source pattern (NousResearch/hermes-agent `skills/autonomous-ai-agents/`): one adapter skill per external agent CLI (claude-code, codex, hermes, opencode), each encoding that target's quirks — auth, one-shot vs background+poll, PTY/git-repo requirements, dialog navigation, JSON output flags, session resume semantics. All CLI-over-terminal, no APIs.

Genie design:
1. **One `delegate` skill, per-agent adapter references** (`delegate/agents/codex.md`, `delegate/agents/hermes.md`) — Nous ships 4 separate skills; we fold to one skill + references to keep the skill listing lean (consistent with the C audit). Launch scope: **Codex + Hermes** (Felipe-named); opencode = future reference stub, OUT for now.
2. **Adapter mechanics absorbed from Nous** (verbatim-portable): codex → `codex exec` needs git repo + pty + `--full-auto`, JSON output, `codex review --base`; hermes → over SSH, oneshot + continue-by-title, keep hermes-pair.sh gotchas (title-fallback trap, SIGABRT-on-exit, base64 shipping; note: `-z` is a host alias, canonical `hermes chat -q`); claude-code adapter kept as the mirror-image template (how OTHERS drive genie/CC).
3. **Wish-based companion sessions**: per (wish-slug × external agent) one persistent named session — title convention `wish-<slug>` (already the hermes-pairing convention); external session ref (title/uuid) stored in genie.db on the wish row so every /work turn reconnects with full context. Generalizes hermes-pairing from manual skill → systematized per-wish primitive.
4. **Structured hand-back**: delegates always invoked with JSON output where supported (`claude -p --output-format json`, codex JSON) → deterministic parse of result/session_id/cost; long runs via background + poll.
5. **Couples with refine (decided)**: every outgoing brief passes through the target's style card (gpt-codex.md for Codex, hermes.md for Hermes).
6. **Token-efficiency note**: Hermes (gpt-5.5, Namastex infra) and Codex offload spend from the Anthropic bill entirely — cross-LLM perspective is not only quality diversity, it's cost arbitrage. Bounded by quality-control gates.
7. **Lifecycle plug points — DECIDED (Felipe 2026-07-09): auto at plan gates.** Every plan review gets an automatic Hermes counter-read (session `wish-<slug>`); execution gates trigger cross-LLM dissent only on disagreement/high blast radius. Codex delegation + council LLM-lenses remain on-demand.

## WRS — final

WRS: ██████████ 100/100 — Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
Parked (explicitly OUT of this design, own follow-ups): pm/"real software spec" review discussion (Felipe has context to bring); learn→brain transfer execution; Workflow-tool migration of /work; opencode adapter.

### Authoritative final-ruling note

This draft preserves the chronological evidence trail, including recommendations later overruled. The final rulings are:

- `refine` is **kept** as the cross-LLM prompt adapter with target-specific style cards.
- `learn` is **parked in `.genie/attic/skills/learn/`** for later transfer to the brain; no deprecation stub ships in this program.
- Hermes plan-gate counter-reads fail open when unavailable, log the degradation, and retry at the next gate.
- The routing matrix and budget policy in `DESIGN.md` supersede earlier provisional matrices in this draft.

Always-on load refinement (from Nous findings → Domain D): Hermes does identity via system-prompt injection at session construction (SOUL.md analog), NOT by force-loading skills. CC translation: **SessionStart additionalContext via genie's existing in-process fail-closed hook dispatch** (extend `genie hook dispatch` + identity-inject handler to SessionStart) — replaces/augments the dead session-context.cjs; rules file stays the thin static identity, additionalContext carries live state. Keep always-on text small; deep playbooks stay on-demand skills.

## Background research completed

- `cc-native-research` (claude-code-guide): workflows/worktrees/teams/plugins + model-routing surfaces.
- `langwatch-research` (general-purpose): docs (CLI, skills directory, PM/domain-experts) + working analytics recipes.

## Continuation state (handoff absorbed 2026-07-09)

- The umbrella is complete at WRS 100 and split into nine child tracks.
- `routing-matrix` and `plugin-resource-shipping` are SHIP-reviewed wishes; dispatch remains user-gated.
- The next brainstorm must select one open child track and work only that track, preserving Felipe's one-subject-at-a-time rule.
