# Wish: Routing Matrix — pinned models & efforts across the genie lifecycle

| Field | Value |
|-------|-------|
| **Status** | EXECUTED — execution review SHIP (2026-07-09); day-1 live pin QA recorded 2026-07-10 — **inconclusive by delivery gap** (Fable share rose on every measure, but the 7 pinned role agents did NOT appear as subagent types under plugin cache 5.260710.2, so pins were applied by hand, not mechanically; properly-pinned wish ran ~11% Fable). Re-test after next stable release carrying agent-sync + `genie update` ×2 — see [qa/routing-pin-qa-20260710.md](qa/routing-pin-qa-20260710.md) |
| **Slug** | `routing-matrix` |
| **Date** | 2026-07-09 |
| **Author** | Felipe (planned with Fable 5 + Hermes counter-read) |
| **Appetite** | medium |
| **Branch** | `wish/routing-matrix` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/genie-token-efficiency-program/DESIGN.md) · [track DRAFT](../../brainstorms/routing-matrix/DRAFT.md) |

## Summary

Genie dispatches every subagent with no model/effort pinning, so engineers, fixers and reviewers all inherit the main session's Fable-5-xhigh — the top driver of a measured $17.9k/21-day burn. This wish encodes the decided routing matrix natively: plugin-shipped role agents with pinned model+effort, skill-frontmatter stage pins, per-pane `--model` flags in `genie launch`, a complexity-score column in the wish template, and hard escalation/budget discipline. Target: ≥40% blended $/wish reduction with no SHIP-rate regression (LangWatch-verified).

## Scope

### IN

- Plugin role agents at `plugins/genie/agents/`: `engineer-trivial` (opus·low), `engineer-standard` (opus·high), `engineer-complex` (opus·xhigh), `fixer` (opus·medium), `reviewer` (opus·xhigh), `final-gate` (fable·high), `scout` (haiku·low) — capability-profile descriptions, pinned `model:`+`effort:` frontmatter, context-diet note per role.
- Stage pins via skill frontmatter: `skills/brainstorm` + `skills/wish` → `model: fable`, `effort: high`; `skills/work` → `model: opus`, `effort: xhigh`.
- `genie launch`: per-stage `--model` flag emitted into Warp pane launch configs (execution panes open on opus).
- `templates/wish-template.md`: **Complexity** (score + tier) and **Model** (role-agent) columns required in the **Execution Strategy tables** (single parse location — the table header row) + the score rubric documented as template guidance; `scripts/wishes-lint.ts` extended to require both columns for wishes whose header `Date` ≥ 2026-07-09 (date-threshold grandfathering — all pre-existing wishes exempt; this wish itself must pass).
- Escalation & budget discipline in `skills/fix` + `skills/review` + `skills/work` dispatch tables: cause classification (env/tool/spec failures never escalate the model), no-escalation-without-new-evidence, hard caps (max 3 Fable calls/wish; max 2 escalations/group) with explicit logged override; `templates/genie-config.template.json` gains the budget knobs.
- `genie doctor`: warn when `CLAUDE_CODE_SUBAGENT_MODEL` is set (it silently overrides all pins).
- `max` effort reachable by auto-routing ONLY for the Fable gate on complexity-7+ groups; everywhere else caps at xhigh.

### OUT

- Sonnet 5 anywhere in the matrix (excluded by observed 2× token/time cost; revisit only via LangWatch A/B).
- The single executable dispatch-contract rewrite and global↔repo skill convergence (own wish: control-plane-contract) — this wish edits dispatch TABLES in place, it does not restructure the contract.
- `genie spend` / LangWatch attribution tooling (own wish: genie-spend); interim measurement uses the manual recipes archived in the umbrella DRAFT.
- Cross-agent delegation, refine style cards, companion sessions (own wish: cross-agent-delegate).
- Enforced $/wish ceiling (advisory only until genie-spend phase 2; hard caps here are Fable-calls and escalations only).
- Hard PreToolUse guard blocking /work waves from a Fable session (rejected — warn-level info only).
- Any change to omni, dream, board, or MCP surfaces.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Role agents pinned by capability profile, not hard-coded per-task models | Reproducible routing; profiles survive model churn; local override = native shadowing via project `.claude/agents/<role>.md` (zero new machinery) |
| 2 | Stage switching = skill-frontmatter pins + `genie launch` pane flags; manual `/model` always wins | Automatic, discipline-free; one cache flip at natural stage boundaries; hard guard rejected as friction |
| 3 | Complexity is scored (+2 orchestration/routing/stateful/subjective-acceptance, +1 coupling signals), mapped 0-1→opus-low (Haiku only for non-code mechanical chores), 2-3→opus-med/high, 4-6→opus-xhigh, 7+→xhigh + Fable gate at max | Real complexity = coupling+uncertainty+blast-radius+verifiability, not patch size (Hermes); kills routing-by-vibes |
| 4 | Hybrid budgets: HARD 3 Fable calls/wish + 2 escalations/group (logged override to exceed); $/wish advisory until measurable | Countable in-session today; prevents escalation laundering without false blocks from cost estimation |
| 5 | Escalation requires diagnosed cause + new evidence; env/tool/spec failures never climb the ladder | A bigger model on rotten context "only burns money more eloquently" (Hermes) |
| 6 | Budget knobs live in genie config (template keys), not in skill prose | One revisable place; LangWatch data can retune without prompt edits |

## Success Criteria

- [ ] All 7 role agents exist at `plugins/genie/agents/*.md` with valid `model:` + `effort:` frontmatter (the plugin tree ships wholesale via sync — no dist emission step; live pin behavior proven by QA criterion 1).
- [ ] `skills/brainstorm`, `skills/wish`, `skills/work` carry the stage pins in frontmatter.
- [ ] `genie launch` pane configs include the per-stage model flag (unit test asserts emitted config).
- [ ] A new wish scaffolded from the template fails `bun run wishes:lint` if any execution group lacks Complexity or Model.
- [ ] `genie doctor` emits a warning when `CLAUDE_CODE_SUBAGENT_MODEL` is set, silent when unset.
- [ ] fix/review/work skills state the cause-classification, new-evidence rule, and caps; `genie-config.template.json` contains `budgets.maxFableCallsPerWish` (3) and `budgets.maxEscalationsPerGroup` (2).
- [ ] Post-merge (QA window): a dispatched engineer-standard run shows `claude-opus-4-8` × `high` in LangWatch, not the session model.

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|-----------|-------|-------------|
| 1 | engineer | 4 (routing surface) | opus·xhigh | Role agents + stage pins (prompt surfaces) |
| 2 | engineer | 4 (stateful CLI) | opus·xhigh | genie launch model flags + doctor check (TS) |
| 3 | engineer | 3 (template+lint) | opus·high | Wish template columns + rubric + lint extension |

### Wave 2

| Group | Agent | Complexity | Model | Description |
|-------|-------|-----------|-------|-------------|
| 4 | engineer | 5 (policy, touches review loop) | opus·xhigh | Escalation discipline + budget knobs |

## Execution Groups

### Group 1: Role agents + stage pins

**Goal:** Ship the seven pinned role agents in the plugin and pin the lifecycle stages in skill frontmatter.

**Deliverables:**
1. `plugins/genie/agents/{engineer-trivial,engineer-standard,engineer-complex,fixer,reviewer,final-gate,scout}.md` — frontmatter `name`, `description` (capability profile + when-to-use), `model`, `effort`; body: role charter + context-diet shape (what the brief must/must-not contain).
2. Frontmatter additions: `skills/brainstorm/SKILL.md` + `skills/wish/SKILL.md` → `model: fable` / `effort: high`; `skills/work/SKILL.md` → `model: opus` / `effort: xhigh`.
3. `skills/work` dispatch table rewritten to reference role agents by name (Agent tool `subagent_type`), never bare general-purpose spawns.

**Acceptance Criteria:**
- [ ] 7 agent files, each with parseable frontmatter containing `model` and `effort` from the decided matrix.
- [ ] 3 skills carry the stage pins.
- [ ] work skill's dispatch table names role agents for engineer/fixer/reviewer/final-gate/scout rows.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
for a in engineer-trivial:opus:low engineer-standard:opus:high engineer-complex:opus:xhigh fixer:opus:medium reviewer:opus:xhigh final-gate:fable:high scout:haiku:low; do
  f="plugins/genie/agents/${a%%:*}.md"; m=$(echo "$a" | cut -d: -f2); e=$(echo "$a" | cut -d: -f3)
  test -f "$f" || { echo "MISSING $f"; exit 1; }
  grep -q "^model: $m$" "$f" || { echo "$f: bad model pin"; exit 1; }
  grep -q "^effort: $e$" "$f" || { echo "$f: bad effort pin"; exit 1; }
done
grep -q '^model: fable$' skills/brainstorm/SKILL.md && grep -q '^model: fable$' skills/wish/SKILL.md || exit 1
grep -q '^model: opus$' skills/work/SKILL.md && grep -q '^effort: xhigh$' skills/work/SKILL.md || exit 1
grep -q 'final-gate' skills/work/SKILL.md || { echo "work dispatch table missing role agents"; exit 1; }
```

**depends-on:** none

---

### Group 2: Launch model flags + doctor check

**Goal:** Execution panes open on the right model, and doctor catches the global override footgun.

**Deliverables:**
1. `genie launch` (src/term-commands/launch.ts + src/lib/v5/warp-launch.ts) emits a per-pane model flag for execution panes (opus) in the generated Warp launch config; flag value sourced from genie config with matrix default.
2. `genie doctor` check: warns (non-fatal) when `CLAUDE_CODE_SUBAGENT_MODEL` is set, naming the pins it overrides.
3. Colocated tests for both (bun:test, real config emission asserted).

**Acceptance Criteria:**
- [ ] Launch config for a ready group contains the model flag.
- [ ] Doctor output includes the warning iff the env var is set.
- [ ] `bun run check` green.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bun run build || exit 1
bun test src/term-commands/launch.test.ts || exit 1
CLAUDE_CODE_SUBAGENT_MODEL=sonnet ./dist/genie.js doctor 2>&1 | grep -q 'CLAUDE_CODE_SUBAGENT_MODEL' || { echo "doctor missing override warning"; exit 1; }
env -u CLAUDE_CODE_SUBAGENT_MODEL ./dist/genie.js doctor 2>&1 | grep -q 'CLAUDE_CODE_SUBAGENT_MODEL' && { echo "doctor warns when unset"; exit 1; }
bun run check || exit 1
```

**depends-on:** none

---

### Group 3: Wish template complexity/model columns + lint

**Goal:** Every future wish declares per-group complexity and model, enforced by lint.

**Deliverables:**
1. `templates/wish-template.md`: Complexity + Model columns in the Execution Strategy table headers; score rubric as template guidance. (Per-group inline fields NOT required — the strategy table is the single parse location.)
2. `scripts/wishes-lint.ts`: wishes with header `Date` ≥ 2026-07-09 must contain ≥1 Execution Strategy table (absence fails lint — closes the vacuous-pass hole) and every such table must carry Complexity + Model columns; earlier wishes exempt. The routing-matrix wish itself must pass. Target dir parameterized (arg/env, default `.genie/wishes`) so fixtures can drive it.
3. `scripts/wishes-lint.test.ts` (bun:test, tmpdir fixtures): asserts lint exits non-zero on a post-threshold fixture missing Complexity, zero on a complete fixture, zero on a pre-threshold fixture without columns.

**Acceptance Criteria:**
- [ ] Template scaffolds with the new columns in strategy tables.
- [ ] Lint fails on a post-threshold fixture missing Complexity; passes on complete and on grandfathered fixtures.
- [ ] Existing wishes still lint green; this wish lints green.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
grep -q 'Complexity' templates/wish-template.md || exit 1
grep -qi 'rubric' templates/wish-template.md || exit 1
bun test scripts/wishes-lint.test.ts || exit 1
bun run wishes:lint || exit 1
```

**depends-on:** none

---

### Group 4: Escalation discipline + budget knobs

**Goal:** Escalation becomes diagnosed and capped instead of a token casino.

**Deliverables:**
1. `skills/fix/SKILL.md` + `skills/review/SKILL.md` + `skills/work/SKILL.md`: cause-classification table (model-capacity / missing-context / ambiguous-spec / env-tool-failure — only the first escalates), new-evidence requirement, caps with logged-override wording, reviewer↔gate disagreement = logged appeal.
2. `templates/genie-config.template.json`: `budgets.maxFableCallsPerWish: 3`, `budgets.maxEscalationsPerGroup: 2`, `routing.maxAutoEffort: "xhigh"`, `routing.fableGateMaxAt: 7`.
3. `max`-effort rule documented: auto only for complexity-7+ Fable gates.

**Acceptance Criteria:**
- [ ] All three skills contain the four cause classes and both caps.
- [ ] Config template parses as JSON and carries the four keys.
- [ ] No skill instructs unconditional escalation on failure anymore.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
for s in skills/fix/SKILL.md skills/review/SKILL.md skills/work/SKILL.md; do
  for c in model-capacity missing-context ambiguous-spec env-tool; do
    grep -qi "$c" "$s" || { echo "$s missing cause class: $c"; exit 1; }
  done
  grep -q 'new evidence' "$s" || { echo "$s missing new-evidence rule"; exit 1; }
  grep -q 'maxFableCallsPerWish' "$s" || { echo "$s missing Fable cap reference"; exit 1; }
  grep -q 'maxEscalationsPerGroup' "$s" || { echo "$s missing escalation cap reference"; exit 1; }
done
bun -e "const c=await Bun.file('templates/genie-config.template.json').json();if(c.budgets.maxFableCallsPerWish!==3)throw 1;if(c.budgets.maxEscalationsPerGroup!==2)throw 1;if(c.routing.maxAutoEffort!=='xhigh')throw 1;if(c.routing.fableGateMaxAt!==7)throw 1" || exit 1
```

**depends-on:** 1 (role names referenced by the escalation ladder)

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: dispatching an engineer-standard role agent on a test task produces a LangWatch trace on `claude-opus-4-8` at `high` — not the session's model.
- [ ] Integration: a fresh `/work` invocation in a new session runs the orchestrator turns on opus·xhigh (skill pin active) and its wave dispatch uses the role agents.
- [ ] Regression: `genie launch` still opens a working Warp cockpit for an existing wish; `bun run check` green; existing wishes lint green.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| CC ignores or changes agent-frontmatter `effort` semantics | Medium | G1 validation greps are structural; QA criterion 1 verifies live via LangWatch before dependent wishes build on it |
| Skill-pin model flip mid-session churns prompt cache when stages run in one session | Low | Pins align with natural session boundaries; documented guidance: new session per stage (Warp panes already do this) |
| Opus-low under-thinks a mis-scored "trivial" group | Medium | Review gate + capped escalation rung; complexity score validated at plan review |
| `CLAUDE_CODE_SUBAGENT_MODEL` set on some machine silently defeats all pins | Medium | Doctor warning (G2); documented in dispatch tables |
| Lint column enforcement breaks existing wish files | Low | Grandfather clause for pre-existing wishes; only new wishes require columns |

---

## Review Results

**Plan review (2026-07-09): SHIP** after 1 fix loop. Round 1 FIX-FIRST: 3 HIGH (G3 validation false-pass — empirically confirmed; lint column contract underspecified; G2 stale-dist + env leak), 2 MEDIUM (G4 under-coverage; doctor/dist paths), 4 LOW. All fixed; re-review verified deltas against the live repo, including the grandfather boundary (this wish is the only post-threshold wish and passes its own lint). Residual LOWs folded into G3 spec (no-table vacuous pass guard; lint dir parameterization). **Hermes counter-read: UNAVAILABLE** (cegonha unreachable at gate time) — per degradation policy: gate proceeded on internal reviewer, logged here, retry at execution review.

**Execution review (2026-07-09): SHIP.** Groups 1, 2, and 4 passed their first independent execution reviews. Group 3 returned FIX-FIRST because its template guidance did not literally label the complexity section as a rubric; the minimal wording fix passed re-review. The aggregate gate returned FIX-FIRST once: the new `budgets`/`routing` template keys were being stripped by `GenieConfigSchema`, and launch model parsing accepted option-looking values. Fix loop 1 added typed/defaulted config schemas with load/save round-trip tests and hardened model-token validation; aggregate re-review returned SHIP with no remaining findings. Final gate: `bun run check` passed outside the socket-restricted sandbox — **719 pass, 1 skip, 0 fail**. Task rows for all four groups and both fix loops are done. Post-merge live QA still needs to confirm that Claude Code honors agent-frontmatter `effort` and that LangWatch attributes the routed model/effort as expected.

---

## Files to Create/Modify

```
plugins/genie/agents/engineer-trivial.md        (new)
plugins/genie/agents/engineer-standard.md       (new)
plugins/genie/agents/engineer-complex.md        (new)
plugins/genie/agents/fixer.md                   (new)
plugins/genie/agents/reviewer.md                (new)
plugins/genie/agents/final-gate.md              (new)
plugins/genie/agents/scout.md                   (new)
skills/brainstorm/SKILL.md                      (frontmatter pins)
skills/wish/SKILL.md                            (frontmatter pins)
skills/work/SKILL.md                            (pins + dispatch table + escalation)
skills/fix/SKILL.md                             (escalation discipline)
skills/review/SKILL.md                          (escalation + appeal)
src/term-commands/launch.ts                     (pane model flags)
src/lib/v5/warp-launch.ts                       (config emission)
src/term-commands/launch.test.ts                (tests)
src/genie-commands/doctor.ts                    (env override warning)
src/genie-commands/doctor.test.ts               (doctor test)
templates/wish-template.md                      (columns + rubric)
templates/genie-config.template.json            (budget/routing knobs)
scripts/wishes-lint.ts                          (column enforcement)
scripts/wishes-lint.test.ts                     (lint fixtures test, new)
```
