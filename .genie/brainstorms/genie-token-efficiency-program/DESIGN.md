# Design: Genie Token-Efficiency Program — control plane on a native substrate

| Field | Value |
|-------|-------|
| **Slug** | `genie-token-efficiency-program` |
| **Date** | 2026-07-09 |
| **WRS** | 100/100 |
| **Scale** | Umbrella (6 domains, 10 seed groups → multiple wishes) |
| **Pressure-tested** | Hermes (cegonha) session `wish-genie-token-efficiency`, 2 adversarial rounds — amendments incorporated |

## Problem

Genie's lifecycle burns $3–4k/day ($17,857 / 95.77M billable tokens in the last 21 days, LangWatch-measured) because every subagent dispatch inherits the main session's model (Fable 5 xhigh, the most expensive tier — ~$13.8k of attributed cost), nothing attributes spend to skills/roles/decisions, and genie re-implements surfaces native Claude Code now provides.

## Thesis (Hermes-refined)

**Reduce genie to the control-plane / audit / contract layer; use native Claude Code as the execution substrate.** Native CC = executor, scheduler, worktrees, runtime. Genie = ownership of done, reviewer≠engineer, lint gates, ledger, idempotency, cancellation, audit, promotion policy. Every disposition below follows from this split.

## Scope

### IN
- **B. Model-mix routing**: the decided matrix + escalation discipline + complexity scoring, encoded in plugin `agents/` (pinned `model:`+`effort:` frontmatter, capability-profile named) and WISH.md group columns.
- **C. Skill dispositions**: all 17 skills ruled (Decision 7); lifecycle-four convergence (global=runtime/adapter base, repo=contract/invariant base); dispatch contract hoisted to ONE executable reference.
- **D. Plugin/native modernization**: always-on genie identity (SessionStart in-process inject + thin rules), hook contract (fail-closed, fixtures, CI smoke), native worktree adoption with isolation policy, stale-reference purge.
- **E. Brainstorm-skill upgrade**: domain map phase, gap ledger, WRS coupling, lens-library integration, crystallize domain-coverage check.
- **F. Cross-agent delegation**: `delegate` skill (Codex + Hermes adapters), wish-based companion sessions (refs in genie.db), refine re-scoped as cross-LLM prompt adapter (per-target style cards), auto Hermes counter-read at plan gates.
- **A. Measurement**: `genie spend` (LangWatch recipes), fingerprint attribution (phase 1), decision-level join → cost-per-accepted-group-without-reopen (phase 2).

### OUT
- Sonnet 5 anywhere in the matrix (Felipe-observed 2× tokens/time; revisit only via LangWatch A/B evidence).
- Agent-teams shared task list as task truth (genie.db remains truth; optional read-only scratchpad bridge only).
- Workflow-tool migration of /work wave dispatch (later experiment).
- opencode adapter (future reference stub).
- pm/"real software spec" methodology discussion (parked — Felipe brings context; own brainstorm).
- learn→brain transfer execution (skill parked at `.genie/attic/skills/learn/`; transfer is brain-repo work).
- Bidirectional native↔genie task sync; terminal-scraping state of any kind.
- Docs-site restructure beyond reference fixes.

## Approach

Five moves, ordered by leverage: (1) stop model inheritance — pin every role via plugin agents; (2) collapse duplicated contracts into one executable dispatch+routing reference; (3) make genie identity always-on via SessionStart injection while skills stay on-demand; (4) add cross-LLM delegation with persistent per-wish companion sessions (quality dissent + off-Anthropic-bill arbitrage); (5) measure decisions, not calls, so the matrix becomes data-governed config.

Alternatives considered: Sonnet-engineer default (rejected — user evidence + effective-cost math); per-skill model frontmatter flips mid-session (rejected — model switch invalidates main-session prompt cache; session-level defaults + pinned subagents instead); Nous-style one-skill-per-external-agent (folded to one `delegate` skill + per-agent references to keep the listing lean); deleting learn/refine outright (rejected after user ruling + Hermes quarantine argument).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Routing matrix: Fable-high for /brainstorm+/wish sessions and both final gates; /work orchestrator Opus-xhigh default (Opus-high only for mechanical low-coupling wishes); engineers on Opus ladder by complexity score (trivial→low/med, standard→high, complex→xhigh); fixers Opus-med/high; per-group reviews Opus-xhigh; scouts/chores Haiku; **no Sonnet** | Fable only where reasoning compounds; orchestrator is a multiplier not a worker (Hermes); Sonnet 2× tokens observed; effort is the second cost axis |
| 2 | Encoding: plugin `agents/` with pinned `model:`+`effort:` frontmatter, named by capability profile (engineer-trivial/standard/complex, fixer, reviewer, final-gate, scout) + local config override | Confirmed CC surface; profiles avoid model-name fossilization; subagent pinning costs nothing cache-wise (separate contexts) |
| 3 | Complexity score (not vibes) per execution group: +2 orchestration/routing/stateful/subjective-acceptance, +1 coupling signals; 0-1→Opus-low (Haiku only for pure mechanical chores with deterministic acceptance — code-producing groups never go below Opus-low), 2-3→Opus-med/high, 4-6→Opus-xhigh, 7+→xhigh+Fable gate; /wish assigns, plan review validates | Real complexity = coupling+uncertainty+blast-radius+verifiability, not patch size (Hermes) |
| 4 | Escalation discipline: mandatory cause classification (env/tool/spec failures never escalate the model), no escalation without new evidence, caps per group/wish, reviewer↔gate disagreement = logged appeal (council thin route) | Prevents escalation laundering and "bigger model as false authority" (Hermes) |
| 5 | Context budget parallel to model budget: per-role context diet (engineers: group+acceptance+relevant files; reviewers: diff+acceptance+proof; final gate: WISH+aggregate evidence); golden rule: no model escalation without improving context | Otherwise Opus-volume replaces Fable-price and burn continues (Hermes) |
| 6 | Fable final review = narrow adversarial risk gate (BLOCKER/FIX-FIRST/FOLLOW-UP/NIT, no rewrites); reviewers prompted coverage-first, filtering downstream | Opus/Fable follow severity filters literally → recall drops with "only high-severity" prompts |
| 7 | Dispositions: keep+refactor brainstorm/wish/work/review/fix/genie-router; keep docs/genie-hacks/omni; absorb trace→fix, wizard→genie, pm→work-ref+dream-successor; council→lens library + thin /council route (strategy, dissent, appeals); dream→scheduler adapter + genie.db ledger (cron = trigger, never authority); report→LangWatch-backed + local fallback; refine→cross-LLM prompt adapter; learn→attic (brain transfer pending) | Inventory evidence + Hermes counter-read + Felipe rulings 2026-07-09 |
| 8 | Lifecycle-four convergence by layer: global = runtime/adapter base (dual-backend, CLI-optional), repo = contract/invariant base (reviewer≠engineer, orchestrator-owns-done, wishes:lint); dispatch-contract.md = single versioned executable reference (schema+lint+route matrix+duplication check) both import | Don't pick a base — split interface from invariants (Hermes); kills the 6× contract duplication |
| 9 | Always-on genie: SessionStart additionalContext via in-process fail-closed `genie hook dispatch` (identity + live wish/board state + first-run wizard branch) + thin ≤40-line rules identity; deep playbooks stay on-demand skills | Hermes-agent SOUL.md pattern translated to CC; user requirement: zero-action genie load every session |
| 10 | Hook contract: schema-version manifest, v4/v5 fixtures, per-hook CI smoke, unknown schema ⇒ fail closed with message; the 3 dead .cjs scripts rewritten or deleted; /forge reference removed | 3/5 hooks died silently — the failure is the missing contract, not the scripts (Hermes) |
| 11 | Cross-agent: one `delegate` skill with codex/hermes adapter references (Nous mechanics ported); wish-based companion sessions titled `wish-<slug>`, session refs stored in genie.db; JSON hand-back; background+poll for long runs; **auto Hermes counter-read at plan gates**, execution gates trigger-based | Different-LLM dissent + off-Anthropic-bill arbitrage; plan-gate auto matches standing pair-with-Hermes instruction and proved itself in this very brainstorm |
| 12 | refine = adapter: backbone method + per-target style cards (fable/gpt-codex/hermes/haiku ≤60 lines), auto-applied to outgoing cross-agent briefs, manual `/refine --target` | Prompting is target-relative; pre-Fable universal method hurts Fable prompts; adapter sits where prompts are produced |
| 13 | Measurement: phase 1 = `genie spend` on proven LangWatch recipes + fingerprint attribution (distinct model×effort per role); phase 2 = genie.db outcome labels (verdicts, retries, escalation reasons, reopens) joined to trace cost → **cost per group accepted without reopening** as north star | Measure decisions, not calls (Hermes); zero CC-internals plumbing |
| 14 | Native worktrees adopted with isolation policy (per-agent branch+env overlay, stateful resource locks, orphan reaper, integration gate); genie launch keeps Warp cockpit as view, never truth | Worktrees solve file conflicts, not stateful contention (Hermes) |
| 15 | Brainstorm-skill upgrade (Domain E), five changes: domain-map phase (domains + evidence + gaps + gap-filling route, persisted in DRAFT); gap ledger (every question/research dispatch maps to a named gap; unrouted gap blocks crystallize); WRS coupling (Scope requires the map; Decisions requires zero open ask-user gaps; umbrella brainstorms track per-domain WRS); lens subagents drawn from the domain map (council lens library) instead of a fixed triad; crystallize check #5 (every mapped domain covered or explicitly OUT) | The skill tracks readiness but never maps context domains/gaps — the thing brainstorming must fill for a flawless spec; this session had to improvise exactly that map |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| Cheap orchestrator accepts bad work → multiplies downstream burn | HIGH | Orchestrator Opus-xhigh default + verification budget (evidence checklist before accepting any group) |
| Escalation laundering (bigger model masks bad context/diagnosis) | HIGH | Decision 4: cause classes, new-evidence rule, caps, logged appeals |
| Complexity misclassification routes hard groups to weak rungs | MED | Explicit score rubric + plan-review validation + escalation rung as backstop |
| Native cron becomes authority for dream → lost leases/idempotency/audit | HIGH | Decision 7: run rows, idempotency keys, leases, human gates in genie.db; cron is trigger only |
| Hooks die silently again after rewrite | MED | Decision 10 contract: fixtures + CI smoke + fail-closed |
| `CLAUDE_CODE_SUBAGENT_MODEL` env silently overrides all pins | MED | `genie doctor` check; documented in dispatch contract |
| Model-name fossilization in pinned agents as providers/prices shift | LOW | Capability-profile naming + config override + LangWatch-driven revision loop |
| Context fan-out keeps burn high despite cheaper models | HIGH | Decision 5 context diets; measured via prompt_tokens per role in phase 2 |
| Convergence picks wrong base and drops an invariant | MED | Decision 8 layer rule + golden tests asserting both surfaces obey the contract |
| Hermes/Codex CLI drift breaks adapters (e.g. `-z` alias vs canonical) | LOW | Adapters document canonical + alias; helper scripts own the gotchas; status probe before use |
| Assumption: agent-frontmatter model/effort pins are honored by CC | — | Confirmed by research; smoke-tested in G1 validation before dependent groups proceed |

## Execution Groups (seed for /wish — likely one wish per group, B first)

| Grupo | Entregável | Depende de | Validação |
|-------|-----------|------------|-----------|
| G1 Routing (B) | plugin `agents/` role definitions (pinned model+effort, capability profiles); WISH template complexity+model columns; escalation rules in fix/review; doctor env check | — | spawn each role agent, assert model+effort via LangWatch trace; wishes:lint accepts new columns; doctor flags set env |
| G2 Contract (C/D) | dispatch-contract.md rewritten as single versioned executable reference (schema, route matrix, lint, duplication check) — hosts the canonical context-diet and verification-budget policy text; duplicated copies replaced by imports; review-criteria/README/jar-path drift fixed | G1 (matrix text) | new CI duplication-lint green (lint defines what counts as a canonical-copy); skills reference the contract instead of restating it |
| G3 Convergence (C) | lifecycle-four merged by layer (global=adapter, repo=contract); golden tests for invariants; repo = distribution source again; **work/review policy refactor**: per-role context-diet briefs (D5), orchestrator verification budget (evidence checklist before accepting a group), reviewer coverage-first prompt + BLOCKER/FIX-FIRST/FOLLOW-UP/NIT taxonomy (D6) | G2 | golden tests pass on both surfaces; global skills reinstall from repo build; dispatched briefs on a test wish match the per-role context-diet shapes; a group missing evidence is refused by the orchestrator checklist; reviewer prompt asserts report-all-then-filter and emits the four-tier taxonomy |
| G4 Absorbs (C) | trace→fix (diagnose mode), wizard→genie (first-run branch), pm→work reference, council→lens library + thin route, report→LangWatch+fallback; stale refs to absorbed skills purged | G2 | skill listing count drops; each absorbed flow exercised once end-to-end |
| G5 Always-on + hooks (D) | SessionStart identity/state inject via in-process dispatch; thin rules identity ≤40 lines; hook contract (fixtures, CI smoke, fail-closed); dead .cjs scripts replaced/deleted | G2 | fresh session shows genie identity+state with zero user action; hook smoke suite green; v4 fixture fails closed with message |
| G6 Delegate (F) | `delegate` skill (codex+hermes adapters); companion-session refs in genie.db schema; refine target cards; auto plan-gate Hermes counter-read wired into review | G1, G2 | live round-trip: codex exec JSON + hermes continue-by-title on a test wish; plan review on a real wish shows counter-read section |
| G7 Spend (A) | `genie spend` (day/model×effort/top sessions/top traces, --json); phase-2 schema: outcome labels in genie.db + join query → cost per accepted group | G1 (fingerprints) | `genie spend` <5s against langwatch.khal.ai; instrumented wish yields per-group cost+verdict report |
| G8 Brainstorm upgrade (E) | domain-map phase, gap ledger, WRS coupling, lens-library integration, crystallize coverage check in both brainstorm skill copies | G3, G4 (lens library) | next real brainstorm produces a domain map + gap ledger; spec self-review includes coverage check |
| G9 Dream replatform (C) | dream → scheduler adapter + policy/ledger: run rows in genie.db, idempotency keys (wish+schedule+intended_at+git_ref), leases, human gates; native cron/schedule as trigger only | G2, G7 | scheduled test wish executes exactly once under duplicate triggers; run row reconciles terminal state; cancellation from genie.db honored |
| G10 Worktree isolation (D) | D14 policy shipped: `isolation: "worktree"` adopted for parallel engineers; per-agent branch + env overlay; stateful-resource locks (DB migrations, ports, shared caches); orphan-worktree reaper; final integration gate; `.worktreeinclude` scaffold in genie init | G1, G2 | two engineers on one wish run in isolated worktrees; a stateful-resource lock blocks the second claimant; reaper cleans an abandoned worktree; genie launch cockpit unaffected |

## Success Criteria

- [ ] No genie dispatch inherits the session model implicitly — every role agent pins model+effort (verify: LangWatch traces show expected model×effort per role fingerprint).
- [ ] Blended $/wish drops ≥40% within 2 weeks of G1+G2 landing, with SHIP rate non-regressing (verify: `genie spend` trend vs the $17.9k/21d baseline; interim before G7 lands: the manual LangWatch analytics recipes archived in DRAFT.md).
- [ ] Dispatch contract exists exactly once; CI fails on re-duplication (verify: G2 lint gate).
- [ ] Fresh session in a genie repo shows identity + live wish state with zero user action (verify: new session transcript).
- [ ] All hook scripts pass fixture smoke; a v4-shaped wish fails closed with a clear message, never a silent noop.
- [ ] A real wish runs with a Codex or Hermes companion session that survives across /work turns (session ref persisted in genie.db).
- [ ] Plan review on the next wish includes an automatic Hermes counter-read section.
- [ ] `genie spend` answers $/day, $/model×effort, top-5 sessions in <5s; after one instrumented wish, reports cost per group with verdict/reopen join.
- [ ] Skill listing shrinks by ≥4 entries (trace, wizard, pm, learn out; council thin route and delegate in).
- [ ] Next brainstorm session produces a domain map + gap ledger natively (E shipped).
