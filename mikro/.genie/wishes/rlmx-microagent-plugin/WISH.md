# Wish: rlmx microagent plugin — first-pass explore for Claude Code, honestly positioned

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `rlmx-microagent-plugin` |
| **Date** | 2026-07-27 |
| **Author** | Genie (Claude, Fable 5) |
| **Appetite** | medium |
| **Branch** | `wish/rlmx-microagent-plugin` |
| **Repos touched** | automagik-dev/rlmx |
| **Design** | [DESIGN.md](../../brainstorms/rlmx-claude-plugin/DESIGN.md) |

## Summary

Wish B of the `rlmx-claude-plugin` program, executed under the design's
**Amendment 2026-07-27** (first-pass + escalate positioning, user decision
after the parity gate failed twice). Ships the Claude Code plugin that makes
`explore-r` a one-command install: MCP registration passing `--dir`, an
offload-guidance skill teaching first-pass routing with an evidence-grounded
escalation rule, propose-only `/microagent-create`, the amended worker-model
bench (station arm + consolidated table), and legacy-agent archival. Every
user-facing claim inherits the parity report's scoping — 0.714 out-of-sample
coverage, zero fabrications in the frozen configuration, ~1000× premium-token
reduction — never the parity claim.

## Scope

### IN

- **Claude Code plugin** at `plugins/claude-code/` in the rlmx repo (design
  D5): current plugin format (research the live docs before building —
  plugin manifest, bundled MCP server config, bundled skills). Registers
  `rlmx mcp --dir <project dir>` and installs in one documented command.
- **Offload-guidance skill** (bundled): teaches the host to route
  explore-class questions to `rlmx_explore-r` first and escalate to native
  when (a) the answer lacks resolvable citations, (b) the run errors/times
  out, or (c) completeness matters more than cost (deep-parity work — the
  frozen-suite class). Claims in the skill text use the report's scoped
  numbers only.
- **`/microagent-create`** (bundled skill, design D7 propose-only): reads
  last-24h Claude Code transcripts (+ token-optimizer session data when
  present), identifies repeatable offload candidates ranked by token burn,
  writes a draft `agent.yaml` + `SYSTEM.md` + evidence file into the
  workspace's `.rlmx/agents/<name>.proposed/`, and stops. Creates nothing
  without approval; activating = user renames the directory.
- **Amended B2 bench**: station-local arm (n=2 replicates) on the round-2
  train suite via the existing harness; consolidated worker-model table in
  `docs/` merging the round-2 matrix + campaign evidence, with noise
  caveats carried over and station's row marked not-rank-comparable (n=2
  buys feasibility/cost/noise-estimate, not rank). Default worker stays
  `khal/deepseek-v4-flash` (cost-robust). **No new frozen-suite runs.**
- **Legacy archival (B5), ordered and honest**: (1) copy all three legacy
  agents (`changelog`, `codebase-qa`, `log-triage`) into `examples/agents/`
  as documented recipes — **including `codebase-qa`**, because "explore-r
  replaces it" is positioning, not a demonstrated result (the gate scored
  0/6; plan-review B-3); (2) verify the in-repo copies load; (3) host-side
  removal from `~/.rlmx/agents/` is a **documented user step** in the
  recipe README, not an action this wish performs. Flat `examples/<name>/`
  agent entries migrate under `examples/agents/` (design plan-02 M4).
  Validation targets the repo-side artifacts only.
- **Routing eval (B3), PRE-REGISTERED here** (immutable before Group 2
  starts, inheriting the frozen-shot discipline): the 5 prompts are the
  Question blocks of train fitness tasks **3, 4, 5, 6, 7** (
  `parity/round2/train-tasks/`), verbatim. The planted escalation case is
  the campaign's recorded lost-run signature: the tool result is replayed
  as the gen-4 rep-2 task-5 error answer (the ~67-character
  `REPL execution timed out` string, zero citations) — the session must
  respond by re-running natively. Pass bar: ≥4 of 5 prompts route to
  `rlmx_explore-r`; planted case escalates. The raw session transcript is
  required in evidence — the number must be checkable, not asserted.

### OUT

- Any parity claim, re-run, or new frozen-suite execution (gate closed:
  FAIL ×2, A4b permanently unchecked).
- README full rewrite and launch content — `rlmx-launch` (wish 3) owns it.
- Aider polyglot — `rlmx-proof` owns it.
- review-lite / git-historian agents — expected `/microagent-create`
  proposal candidates, not built here (design OUT, amended).
- Codex/Hermes plugin packaging — Claude Code first; others consume plain
  `rlmx mcp` meanwhile.
- npm publishing; LiteLLM management-API integration.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | All plugin/skill claims inherit the parity report's scoping verbatim | rcp-06 caught the amendment itself rounding up (in-sample vs holdout, fabrication history); the launch story survives checking only if every number does |
| 2 | Escalation triggers are the campaign's measured failure signatures, not invented heuristics | Design amendment (B3): citation-less answers and lost-run errors are the two observed modes across the recorded runs |
| 3 | Proposals land as `.rlmx/agents/<name>.proposed/`; **a discovery skip rule for `*.proposed` dirs is built in `src/mcp/agents.ts` with a regression test** (today no name filter exists — `agents.ts:135-155` would list it as `rlmx_<name>_proposed`, and live refresh would make it callable on the next request); activation = rename by the user | Propose-only (D7) needs a mechanical boundary that must be *built*, not assumed (plan-review B-1); the skip rule is the boundary |
| 4 | Station bench arm n=2, marked not-rank-comparable | Campaign measured ±3-fact run-to-run spread; n=2 cannot rank against n=1 arms (design AM-6 fix) |
| 5 | Default worker `khal/deepseek-v4-flash`; station documented as the $0 offline option | Cost ranking is the robust matrix finding; coverage comparison unresolved at n=1 (design AM-4 fix) |
| 6 | Evidence-preamble facts for docs: recursion product fixes = commit `6ec4822` (child model pinning, `rlm_query` model arg, loud child failure); campaign = four evaluated generations plus a rejected fifth | Corrects design rcp-07 minors AM-8/AM-9 at the point of use — the parity report records harness corrections, the product fixes live in git |
| 7 | Plugin format researched live before building | Claude Code plugin schema evolves; the design predates checking it |

## Dependencies

**depends-on:** rlmx-explore-offload
**blocks:** none

## Success Criteria

- [x] B1: Plugin installs from the rlmx repo in one documented command; a
  fresh Claude Code session in a workspace with `.rlmx/agents/explore-r/`
  sees `rlmx_explore-r` via the plugin's own MCP registration (which passes
  `--dir`).
- [x] B3: Routing eval passes — ≥4 of 5 scripted exploration prompts route
  to `rlmx_explore-r`; the planted escalation case (real failure signature)
  triggers a native re-run.
- [x] B4: `/microagent-create` produces a draft agent.yaml + SYSTEM.md +
  evidence file for ≥1 candidate from real transcripts into a `.proposed/`
  dir; discovery never lists it; activation-by-rename works.
- [x] B2 (amended): station arm n=2 recorded on the train suite;
  consolidated worker-model table committed to docs with run dates,
  per-arm pricing, noise caveats, and station marked not-rank-comparable.
- [x] B5: all three legacy agents preserved as loadable recipes under
  `examples/agents/` (the single recipe tree, flat entries migrated); the
  host-side removal is a documented user step this wish never performs.
- [x] Every user-facing number in plugin/skill/docs text traces to
  `docs/parity-explore.md` or git with the report's own scoping (spot-check
  criterion for the reviewer).
- [x] Full gate green: `npm run check`, `npm run build`, `npm test`,
  `node scripts/smoke-mcp.mjs`, `npm audit --omit=dev` 0 vulnerabilities.

## Execution Strategy

### Wave 1 (parallel — disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 — external format research +1, CI/packaging +1, no deterministic test +1 | engineer-standard / high | Plugin skeleton + MCP registration + install path (B1) |
| 4 | engineer | 2 — bench mechanics on existing harness +1, docs +1 | engineer-standard / medium | Station arm + consolidated table + archival/migration (B2+B5) |

### Wave 2 (parallel — both consume the skeleton)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 4 — prompt-skill change +1, subjective acceptance +2, eval harness +1 | engineer-complex / high | Offload-guidance skill + routing eval (B3) |
| 3 | engineer | 4 — transcript mining +2, prompt-skill +1, propose-boundary mechanics +1 | engineer-complex / high | /microagent-create propose-only (B4) |

## Execution Groups

### Group 1: plugin skeleton + install (B1)

**Goal:** one documented command installs the plugin; a fresh session gets
`rlmx_explore-r` through the plugin's own MCP registration with `--dir`.

**Deliverables:**
1. Research current Claude Code plugin format (manifest, bundled MCP server
   config, bundled skills layout) from live docs before writing files;
   record findings + doc links in the group evidence file.
2. `plugins/claude-code/` with the researched structure: plugin manifest,
   MCP server entry running `rlmx mcp --dir` against the project dir (use
   the format's project-dir variable if one exists; otherwise document the
   fallback and its limits), and **both skill entries pre-registered in
   the manifest** (offload-guidance, microagent-create) so Wave 2 groups
   only add skill files and never edit the manifest concurrently.
3. Install path documented in `plugins/claude-code/README.md` (one command;
   works from a clone per the release contract — no npm).
4. Smoke: script or documented manual proof that a fresh session in a
   workspace with `.rlmx/agents/explore-r/` lists the tool via the plugin
   registration.
5. CHANGELOG `[Unreleased]` entry under `### plugin`.

**Acceptance Criteria:**
- [ ] Install command from README works on this host from the repo clone.
- [ ] Fresh Claude Code session lists `rlmx_explore-r` (evidence: `claude
  mcp list` output or session transcript excerpt).
- [ ] Plugin format claims match the researched docs (links recorded).

**Validation** (regression floor only — the binding proof for B1 is the
manual acceptance criteria above, since no script can install a plugin
into a real session):
```bash
cd ~/prod/rlmx && npm run build && test -f plugins/claude-code/README.md && node scripts/smoke-mcp.mjs
```

**depends-on:** none

---

### Group 2: offload-guidance skill + routing eval (B3)

**Goal:** the plugin teaches first-pass routing that measurably happens, and
escalation that measurably triggers.

**Deliverables:**
1. Offload-guidance skill under the plugin's skills dir: when to route
   (explore-class questions), how to call (`prompt`, `session_id` resume),
   when to escalate — the three triggers from Scope IN, with the report's
   scoped numbers (0.714 out-of-sample, zero fabrications in the frozen
   config, ~1000×) and nothing rounder.
2. `scripts/eval-routing.mjs`: drives the **pre-registered** eval (Scope
   IN: train tasks 3/4/5/6/7 verbatim + the pinned gen-4 rep-2 task-5
   error-answer planted case) over a scripted session, or the documented
   closest-possible harness with its fidelity limits stated; reports
   routed/escalated counts machine-readably. The item set and pass bar are
   immutable — set in this wish before the group starts.
3. Evidence file with the raw session transcript (the ≥4/5 number must be
   re-derivable from it).

**Acceptance Criteria:**
- [ ] ≥4 of 5 prompts route to `rlmx_explore-r`; planted case escalates.
- [ ] Every number in the skill text traces to the parity report (cite
  lines in the evidence file).
- [ ] Skill loads in a real session (invocation excerpt in evidence).

**Validation:**
```bash
cd ~/prod/rlmx && node scripts/eval-routing.mjs
```

**depends-on:** Group 1

---

### Group 3: /microagent-create (B4)

**Goal:** self-reflection that proposes microagents from real usage and can
never activate one on its own.

**Deliverables:**
1. `/microagent-create` skill under the plugin: scans last-24h
   `~/.claude/projects` transcripts (+ token-optimizer data when present),
   ranks repeatable offload candidates by token burn, writes
   `.rlmx/agents/<name>.proposed/{agent.yaml,SYSTEM.md,EVIDENCE.md}` —
   EVIDENCE.md carries the burn numbers and transcript refs that justify
   the agent. Loop shape + budget defaults per the proven explore-r
   conventions.
2. **Build the propose boundary**: skip rule in `src/mcp/agents.ts`
   (`discoverAgents` ignores any directory whose name ends `.proposed`)
   plus a regression test in `tests/mcp-agents.test.ts` proving a valid
   `agent.yaml` inside `x.proposed/` is neither listed nor callable, and
   that renaming the dir surfaces it via live refresh without reconnect.
   (Today no filter exists — this is a required code change, not a
   verification; plan-review B-1.)
3. Dogfood run on this host's real transcripts producing ≥1 credible
   candidate (expected class: review-lite / git-historian per the design).

**Acceptance Criteria:**
- [ ] Dogfood proposal exists with evidence tying it to real token burn.
- [ ] Skip rule present in `src/mcp/agents.ts`; regression test proves a
  valid `x.proposed/` agent is neither listed nor callable; rename
  activates without reconnect (live refresh).
- [ ] Nothing is created outside `.proposed/` without user action.

**Validation** (proves the propose boundary; the proposal-quality proof is
the manual dogfood acceptance criterion):
```bash
cd ~/prod/rlmx && npm run build && node --test dist/tests/mcp-agents.test.js
```

**depends-on:** Group 1

---

### Group 4: bench consolidation + archival (B2 amended + B5)

**Goal:** the worker-model evidence lands in docs honestly; the agent
recipe tree becomes single and clean.

**Deliverables:**
1. Station arm: `run-train-round.mjs` on the 6 fitness train tasks,
   station local model, n=2 replicates, records under
   `parity/round2/optimizer/station-arm/`.
2. `docs/worker-models.md`: consolidated table — round-2 matrix arms (with
   the 29–31/34 flash band and noise caveats), station rows (marked
   not-rank-comparable, n=2), per-arm pricing + run dates; default =
   `khal/deepseek-v4-flash` on the cost ranking; station documented as the
   $0 offline option. Evidence-preamble facts per wish decision 6.
3. Archival, copy-then-verify order (host removal is a documented user
   step, never performed by this wish): all three legacy agents
   (`changelog`, `codebase-qa`, `log-triage`) copied as recipes + READMEs
   under `examples/agents/`, each verified to load via `loadAgentSpec`;
   flat `examples/<name>/` agent entries migrated into `examples/agents/`;
   root `README.md` pointers updated (this group owns the root README —
   both the plugin-install and examples pointers; Group 1 owns only
   `plugins/claude-code/README.md`).
4. CHANGELOG entries under a `### docs` sub-heading (Group 1 owns
   `### plugin`; distinct headings, second-lander rebases the anchor).

**Acceptance Criteria:**
- [ ] Station records exist (n=2, honest exit codes) and the table states
  what n=2 does and does not establish.
- [ ] Every table number traces to a committed run record.
- [ ] All three legacy recipes live under `examples/agents/` and load via
  `loadAgentSpec`; the host-removal step is documented; nothing in the
  repo references the old flat paths.

**Validation** (repo-side artifacts only — host state is the user's):
```bash
cd ~/prod/rlmx && test -f docs/worker-models.md && ls examples/agents/ | grep -q changelog && ls examples/agents/ | grep -q codebase-qa && ls examples/agents/ | grep -q log-triage
```

**depends-on:** none

---

## QA Criteria

- [ ] Functional: fresh session in a plugin-installed workspace → ask an
  explore-class question → session routes to `rlmx_explore-r`, answer has
  resolving citations, footer shows flash cost.
- [ ] Integration: `/microagent-create` → proposal appears in `.proposed/`;
  rename → tool appears without reconnect (live refresh).
- [ ] Regression: 517+ tests green; smoke-mcp full pass; existing MCP
  behavior unchanged for non-plugin users; frozen parity artifacts
  untouched — "frozen" = `.genie/wishes/rlmx-explore-offload/tasks/` and
  `.genie/wishes/rlmx-explore-offload/parity/runs/` (gate + shot records);
  Group 4's station records land only under
  `parity/round2/optimizer/station-arm/`, which is not frozen.
- [ ] Honesty: spot-check 5 user-facing numbers across plugin/skill/docs
  against `docs/parity-explore.md` — all trace with matching scope.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude Code plugin format differs from assumptions | Medium | Group 1 researches live docs first; format findings recorded before any file is written |
| Routing eval can't script a real session end-to-end | Medium | Closest-possible harness accepted with its fidelity limits stated — but the item set is immutable (pre-registered in Scope IN) and the raw session transcript is required evidence either way |
| Skill text drifts back toward rounded-up claims | Medium | Wish decision 1 + reviewer spot-check criterion; every number cites the report |
| Station gateway down for the bench arm | Low | n=2 re-runnable any time; bench is additive, not blocking other groups |
| A legitimately named `*.proposed` agent becomes permanently undiscoverable once the skip rule ships | Low | `.proposed` documented as a reserved suffix in the recipe/plugin docs; the skip rule's error surface is silence by design, so the docs are the mitigation |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Execution review — COMPLETE (2026-07-27/28)

All four groups adversarially verified PASS by non-author opus/max agents
(workflows wf_3e5dad7a + wf_53de75c1): G1 plugin skeleton (install proven
live, format researched from live docs), G4 bench + archival (station n=2
recorded, worker-models table numbers recomputed from records, all three
legacy recipes load, host untouched), G2 guidance + routing eval (5/5
pre-registered prompts routed, planted case escalated, counts re-derived
from raw transcripts; one auth-killed verifier re-run cleanly), G3
/microagent-create (.proposed skip rule proven live: not listed, not
callable, rename activates; dogfood proposal git-historian with audited
burn numbers). Nine evidence-precision gaps fixed post-verification
(false provenance claim, discarded-run numbers, citation-reading split
4/2/1, retry disclosure, prompt-identity fidelity limit, writer-invariant
wording, self-reported annotations, census framing). Final gate: 526
tests / 121 suites green, smoke-mcp PASS, audit 0.

### Plan review — SHIP (2026-07-27)

- **Round 1:** FIX-FIRST — genie:reviewer/plan-b-01, 2026-07-27T16:02:03Z.
  3 MAJOR (B-1 propose boundary asserted but absent from code — no name
  filter in `agents.ts:135-155`, live refresh would make unapproved
  proposals callable; B-2 routing eval self-authored/self-scored with
  unpinned items; B-3 unrecoverable home-dir deletion on a falsified
  premise with a vacuous host-dependent gate) + 5 MINOR (CHANGELOG/README
  ownership, manifest concurrency, weak validations, frozen-path
  ambiguity). All fixed in plan rev 2.
- **Round 2:** **SHIP** — genie:reviewer/plan-b-02, 2026-07-27T16:05:39Z.
  All 8 verified at the root (planted-case artifact read directly: the
  67-character REPL-timeout answer, zero citations). 4 MINOR residuals
  (R1–R4: Files-list completeness, AC hedge, two stale risk rows) — all
  fixed before dispatch.
- Design basis: `rlmx-claude-plugin` DESIGN.md incl. Amendment 2026-07-27,
  SHIP genie:reviewer/rcp-07, digest
  `445cb27dc573f6ddf0571d37a93beabc26b21a6b14a345ce252adcab5dc137bc`,
  verified at wish pre-flight.

---

## Files to Create/Modify

```
plugins/claude-code/                          (new — manifest, MCP config, skills, README)
scripts/eval-routing.mjs                      (new)
docs/worker-models.md                         (new)
examples/agents/changelog/                    (new — archived recipe)
examples/agents/log-triage/                   (new — archived recipe)
examples/agents/<migrated flat entries>/      (moved)
.genie/wishes/rlmx-microagent-plugin/         (evidence files)
.genie/wishes/rlmx-explore-offload/parity/round2/optimizer/station-arm/  (bench records)
src/mcp/agents.ts                             (.proposed skip rule — required)
tests/mcp-agents.test.ts                      (.proposed/ discovery regression — required)
CHANGELOG.md                                  ([Unreleased] entries)
README.md                                     (pointers: plugin install, examples/agents/)
```
