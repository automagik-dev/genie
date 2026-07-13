# Wish: Hermes ↔ Genie homogeneous integration

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `hermes-homogeneous-integration` |
| **Date** | 2026-07-12 |
| **Author** | Felipe (felipe@namastex.io) |
| **Appetite** | medium |
| **Branch** | `wish/hermes-homogeneous-integration` |
| **Repos touched** | automagik-dev/genie |
| **Design** | [DESIGN.md](../../brainstorms/hermes-homogeneous-integration/DESIGN.md) |

## Summary

Bring the Hermes Genie integration from a noisy WIP bridge to the same homogeneous product triangle Claude Code and Codex already ship: 23 product skills via Hermes' first-class skill path, the shared `genie mcp` server via `mcp_servers.genie`, and a Codex-shaped minimal hook set — converged by an expanded `agent-sync` hermes lane and proven by `genie doctor`. The native `hermes-genie` plugin slims to MCP-gap adapter duties, drops the KHAW-specific skill, and pins its version to the Genie release.

## Scope

### IN

- 23 product skills delivered to Hermes first-class (`skills.external_dirs` preferred; digest-managed copies as fallback for older Hermes)
- `mcp_servers.genie` registration in Hermes config via idempotent, backup-first merge; fail-closed absolute path to the canonical `$GENIE_HOME/bin/genie`
- Bounded `pre_llm_call` session context (≤ 8 wish/task lines, ≤ 2 KiB, only when `.genie/` present); non-blocking `pre_tool_call` scrape advisory kept; dead `post_tool_call` removed
- Native tools slimmed to MCP gaps: `genie_status`, `genie_work_plan`, `genie_review_plan`; board/task natives retired (optional one-release `GENIE_HERMES_LEGACY_TOOLS=1` gate)
- `agent-sync` hermes lane expanded to converge plugin link+enable + MCP config + skills path, sticky-profile aware
- `genie doctor` checks for all three Hermes legs (link, MCP, skills), not just the symlink
- `genie-khaw-bridge` removed from the product hermes-genie payload (KHAW plugin owns it)
- `plugin.yaml` version pinned to the Genie release version (source of truth: `package.json` via `scripts/version.ts`, e.g. `5.260712.2`)
- Parity doc `hermes-integration-map.md` + Hermes row in `native-surfaces.md`

### OUT

- Replacing Genie SQLite truth (`genie.db`) with Hermes Kanban
- Mutation tools (`task checkout/done`, live `launch`) without human-gate packets — the read-only boundary stays
- Merging hermes-genie into Nous core
- Fake Claude Code tool names in skills (no Hermes impersonation)
- Auto-trust of hooks where Hermes requires operator consent
- 1:1 port of Claude Stop/PostToolUse wish validators before MCP+skills land
- Shipping Codex role-agent TOMLs into Hermes profiles
- KHAW repo changes (re-homing the bridge skill there is a follow-up wish)

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Primary structured state = Genie MCP (same 5 tools as Claude/Codex: `genie_board`, `genie_wish_status`, `genie_task`, `genie_active`, `genie_worktree_context`), registered via `mcp_servers.genie` config | One shared server/contract across all three clients; Hermes has no plugin MCP-register API — config is the supported path |
| 2 | Product skills go through Hermes' first-class skill path (`skills.external_dirs` preferred, digest-managed copies fallback) | `ctx.register_skill` is plugin-namespaced and hidden from the available_skills index — `/wish`-style discovery requires the first-class path |
| 3 | `ctx.register_skill` reserved for at most one thin Hermes cockpit adapter skill | Product skills must not depend on plugin registration |
| 4 | Native tools keep only MCP gaps (`genie_status`, `genie_work_plan`, `genie_review_plan`) | Duplicate native+MCP tools confuse the model and double the schema surface |
| 5 | Hooks = bounded `pre_llm_call` context + non-blocking `pre_tool_call` advisory; `post_tool_call` deleted | `pre_llm_call` is Hermes' real session-context hook; declared no-ops are pure noise |
| 6 | Config writes are idempotent, backup-first, and touch only managed keys (`mcp_servers.genie`, one skills entry) | agent-sync must never clobber unrelated operator config |
| 7 | Sticky-profile resolution reuses the existing plugin-link lane logic; config lands where the live profile reads it | Profile isolation bugs are the known failure mode; one resolution path |
| 8 | `plugin.yaml` version = Genie release version at release time (from `package.json` / `scripts/version.ts`) | Claude/Codex manifests already pin the release; eternal `0.1.0` defeats doctor version checks |
| 9 | TDD for all new TS helpers and the Python hook; smoke script extends `plugins/hermes-genie/scripts/smoke.sh` | Matches repo QA discipline; contract tests are the regression fence |

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] After `genie update` / agent-sync on a host with Hermes: plugin linked+enabled, `mcp_servers.genie` present and probeable, product skills visible in `hermes skills list` and invocable `/wish`-style
- [ ] In a Hermes session inside a `.genie/` repo: bounded Genie context injected without terminal scraping (unit-tested caps: ≤ 8 lines / ≤ 2 KiB; no injection outside `.genie/` repos)
- [ ] Product skill count parity with the Claude/Codex payload (23 skills) on the Hermes surface
- [ ] No KHAW-specific skill in product hermes-genie; no `post_tool_call` in `plugin.yaml`
- [ ] `genie doctor` reports Hermes link + MCP + skills health
- [ ] `bun run check` green (incl. new `hermes-mcp-config` / `hermes-skills-config` / agent-sync / doctor tests); hermes-genie pytest green
- [ ] Mutation boundary intact: no task checkout/done/launch path added without a human gate

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 1 — docs only, no deterministic test (+1) | engineer-trivial / low | Baseline evidence + Hermes integration map docs |
| 2 | engineer | 3 — stateful config-file mutation (+2), prior agent-sync rework history (+1) | engineer-standard / high | TDD config helpers: `hermes-mcp-config.ts` + `hermes-skills-config.ts` |
| 3 | engineer | 3 — stateful hook behavior (+2), prompt-skill change (+1) | engineer-standard / high | `pre_llm_call` bounded session context in hermes-genie (pytest TDD) |

### Wave 2 (parallel, after Wave 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | 4 — agent-lifecycle convergence (+2), stateful (+2) | engineer-complex / high | Expand `syncHermes` (plugin+MCP+skills) + doctor checks |
| 5 | engineer | 3 — stateful plugin contract (+2), prompt-skill change (+1) | engineer-standard / high | Slim native tools, skills cleanup (drop khaw-bridge), version align |

### Wave 3 (sequential, after Wave 2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 6 | engineer | 4 — subjective acceptance on live profile (+2), no deterministic test (+1), release work (+1) | engineer-complex / high | Smoke/dogfood gate on a real Hermes profile + CHANGELOG (whole-wish execution review follows per the `review` skill; no rubric-mandated final-gate at score 4) |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Codex maps these to
the `genie_*` profiles; other runtimes use their matching native roles. Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: Baseline evidence + integration map docs

**Goal:** Capture the current hermes-genie/agent-sync behavior as a regression baseline and publish the single authoritative Hermes parity doc.

**Deliverables:**
1. Baseline notes (plugin.yaml, `syncHermes` grep, host `hermes plugins list` / `genie doctor` output where available) recorded at `.genie/wishes/hermes-homogeneous-integration/reports/baseline.md`
2. `plugins/hermes-genie/references/hermes-integration-map.md` — shipped surfaces, MCP-vs-native tool map (no duplicates), skill invocation paths, install/update convergence, trust/mutation-gate pointer
3. `plugins/hermes-genie/README.md` links the map; `plugins/genie/references/native-surfaces.md` gains a Hermes row

**Acceptance Criteria:**
- [ ] Map contains the required tables (surfaces, tool map, skill invocation, install paths, gates pointer)
- [ ] Baseline notes committed; no product code changed in this group

**Validation:**
```bash
test -f plugins/hermes-genie/references/hermes-integration-map.md && rg -q 'Hermes' plugins/genie/references/native-surfaces.md && rg -q 'hermes-integration-map' plugins/hermes-genie/README.md
```

**depends-on:** none

---

### Group 2: TDD config helpers — hermes MCP + skills convergence

**Goal:** Two pure, idempotent, test-first TS helpers that merge `mcp_servers.genie` and the product-skills `skills.external_dirs` entry into a Hermes `config.yaml` without touching unrelated keys.

**Deliverables:**
1. `src/lib/hermes-mcp-config.ts` + `src/lib/hermes-mcp-config.test.ts` — covers: missing config created minimal; unrelated keys preserved; same-command entry → no write; managed-entry update rules; empty binary path rejected; absolute `$GENIE_HOME/bin/genie` preferred
2. `src/lib/hermes-skills-config.ts` + `src/lib/hermes-skills-config.test.ts` — resolves a stable absolute product-skills root, merges one `external_dirs` entry, preserves user entries, documents/implements the digest-managed copy fallback behind a flag
3. Resolution of open question 1 (does `$GENIE_HOME/skills` exist as a stable populated path, or must agent-sync publish it) recorded at `.genie/wishes/hermes-homogeneous-integration/reports/skills-root-resolution.md` (Group 4 folds it into the integration map — no Wave-1 write to Group 1's file)

**Acceptance Criteria:**
- [ ] All enumerated merge cases have failing-first tests that now pass
- [ ] Helpers perform backup-before-write and never delete user entries

**Validation:**
```bash
bun test src/lib/hermes-mcp-config.test.ts src/lib/hermes-skills-config.test.ts
```

**depends-on:** none

---

### Group 3: `pre_llm_call` bounded session context

**Goal:** Codex-H3-parity session awareness for Hermes turns: a bounded read-only board/wish snapshot injected only inside `.genie/` repos.

**Deliverables:**
1. `plugins/hermes-genie/session_context.py` — no `.genie/` → no injection; else `genie board --json` via the existing argv bridge (timeout ≤ 5 s), capped at ≤ 8 wish/task lines and ≤ 2 KiB; returns `{"context": ..., "mutation": "none"}`; never blocks; on failure injects nothing
2. `plugins/hermes-genie/hooks.py` + `__init__.py` + `plugin.yaml` register `pre_llm_call`; dead `post_tool_call` removed from code and manifest
3. `plugins/hermes-genie/tests/test_session_context.py`
4. `plugins/hermes-genie/tests/test_plugin_contract.py` hook assertions updated to the new hook set (drop `post_tool_call` from the hooks list / `HOOK_EVENTS` / handler-call assertions, add `pre_llm_call`) — touch ONLY hook assertions; tool/skill/version assertions stay for Group 5

**Acceptance Criteria:**
- [ ] Caps, no-`.genie/` skip, timeout, and failure-silence each have a unit test
- [ ] `post_tool_call` absent from `plugin.yaml` and `hooks.py`; contract test asserts the new hook set

**Validation:**
```bash
uv run --with pytest --with pyyaml --no-project python -m pytest plugins/hermes-genie/tests/test_session_context.py plugins/hermes-genie/tests/test_plugin_contract.py -q
```

**depends-on:** none

---

### Group 4: agent-sync hermes lane + doctor depth

**Goal:** One explicit `genie install`/`genie update` convergence path for all three Hermes legs, proven by `genie doctor`.

**Deliverables:**
1. `src/lib/agent-sync.ts` `syncHermes` calls the Group 2 helpers after the existing link/enable steps, sticky-profile-aware config path resolution, report extras (`mcp-config`/`skills-dir`: created|unchanged|failed)
2. `src/genie-commands/doctor.ts` Hermes checks: plugin link (existing), `mcp_servers.genie` command exists + executable, skills external_dir present (or managed skill count ≥ product count), best-effort non-fatal `hermes plugins list` probe
3. Extended agent-sync + doctor tests
4. Group 2's skills-root resolution (`reports/skills-root-resolution.md`) folded into `plugins/hermes-genie/references/hermes-integration-map.md`

**Acceptance Criteria:**
- [ ] Fresh tmpdir `HERMES_HOME` (default and sticky-profile) converges all three legs idempotently — second run reports unchanged
- [ ] Doctor distinguishes each leg's health independently

**Validation:**
```bash
bun test src/lib/agent-sync src/genie-commands
```

**depends-on:** group-1, group-2

---

### Group 5: Slim native surface + skills cleanup + version align

**Goal:** Cut the dual-surface noise: native tools shrink to MCP gaps, duplicate meta-skills and the KHAW bridge leave the payload, version pins to the release.

**Deliverables:**
1. `plugin.yaml` / `__init__.py` / `schemas.py` / `commands.py`: keep `genie_status`, `genie_work_plan`, `genie_review_plan`; retire `genie_board`, `genie_wish_status`, `genie_task_list`, `genie_task_status` (optional one-release `GENIE_HERMES_LEGACY_TOOLS=1` gate); slash `/genie board|…` dispatches to MCP tool names when available
2. `skills/genie-khaw-bridge/` removed (CHANGELOG notes KHAW ownership); at most one thin `skills/genie/SKILL.md` cockpit pointer remains; `genie-work`/`genie-review` duplicates unregistered
3. `plugin.yaml` version = release version; `scripts/version.ts` gains YAML-write support for `plugin.yaml` (today it syncs only JSON manifests — new, small, test-covered capability)
4. Contract tests updated by name — `plugins/hermes-genie/tests/test_plugin_contract.py` (tool/skill/version assertions), `test_commands.py`, `test_genie_bridge.py` — plus `references/native-surface.md` + `mutation-gates.md`

**Acceptance Criteria:**
- [ ] Default registration exposes exactly the three gap tools (legacy flag off)
- [ ] No khaw-bridge skill in the payload; `provides_skills`/`provides_hooks` match reality
- [ ] Version is not `0.1.0` and matches the release source of truth

**Validation:**
```bash
uv run --with pytest --with pyyaml --no-project python -m pytest plugins/hermes-genie/tests -q && ! rg -q 'genie-khaw-bridge' plugins/hermes-genie/plugin.yaml
```

**depends-on:** group-3

---

### Group 6: Smoke / dogfood gate + CHANGELOG

**Goal:** Prove the homogeneous install end-to-end on a real Hermes profile (e.g. isit) and productize the change set.

**Deliverables:**
1. Extended `plugins/hermes-genie/scripts/smoke.sh` covering: plugin enabled + version match, MCP configured + discoverable, product skills listed, no khaw-bridge, doctor green
2. Manual dogfood evidence (doctor output, `hermes skills list`, session smoke transcript showing structured tools instead of tmux scraping) stored under `.genie/wishes/hermes-homogeneous-integration/qa/`
3. `CHANGELOG.md` entry under Unreleased

**Acceptance Criteria:**
- [ ] Smoke script exits 0 on a converged host; each acceptance checklist item from the implementation plan (Task 10) recorded with evidence
- [ ] `bun run check` green on the final tree

**Validation:**
```bash
bash plugins/hermes-genie/scripts/smoke.sh && bun run check
```

**depends-on:** group-4, group-5

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: on a Hermes host after `genie update`, `/wish`-style product skills are invocable and `mcp_servers.genie` tools answer board/task queries
- [ ] Integration: a Hermes session in a `.genie/` repo receives bounded Genie context and completes a board query without `tmux capture-pane`
- [ ] Regression: Claude Code and Codex lanes of agent-sync unchanged (their tests green); existing Hermes plugin link/enable still converges; mutation gates still deny task checkout/done/launch

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `ctx.register_skill` hides skills from the index (design-invalidating if ignored) | High | First-class path (`external_dirs`/managed dirs) is the product route; plugin registration only for the thin adapter |
| Mutating Hermes `config.yaml` is invasive | Medium | Idempotent merge of managed keys only; backup before write; tests for unrelated-key preservation |
| Sticky profile loads config from profile home | Medium | Reuse the existing profile-resolution path; explicit sticky-profile test; dogfood on isit |
| Dual tool surfaces during transition | Medium | Retire natives (optional one-release legacy flag); single tool map doc; confirm Hermes MCP tool-name prefixing in Groups 1–2 |
| `$GENIE_HOME/skills` may not be a stable populated path | Medium | Group 2 resolves open question 1; agent-sync publishes the tree if absent |
| Hermes `skills.external_dirs` unavailable on older Hermes | Medium | Digest-managed copy fallback behind version/schema probe |
| Hook injection token cost | Low | Hard caps (≤ 8 lines / ≤ 2 KiB); silent skip on failure |
| aarch64/OrbStack picks a wrong `genie` binary | Low | Fail-closed absolute canonical binary; no shell string, no PATH hunting |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-07-13T00:58:00Z — FIX-FIRST

- **Reviewer:** genie:reviewer/plan-review-hermes-homogeneous-integration
- **Verdict:** FIX-FIRST
- **Gaps:**
  - MEDIUM: Group 3's validation runs `test_plugin_contract.py`, which hard-asserts `post_tool_call` (hooks list, `HOOK_EVENTS`, handler call) — the command cannot pass given Group 3's own deliverables, and updating the contract test's hook assertions was not a Group 3 deliverable.
  - MEDIUM: Wave-1 file collision — Group 2 deliverable 3 wrote to `hermes-integration-map.md`, which Group 1 creates in the same parallel wave with no dependency edge.
  - LOW: Group 4 fallback `bun test --filter hermes` is not a valid `bun test` flag.
  - LOW: Files-to-Modify omitted the hermes-genie pytest files Groups 3 and 5 must edit.
  - LOW: Group 6 "independent final-gate" at score 4 is inconsistent with the wish's own 7+ rubric; `scripts/version.ts` YAML-write support for `plugin.yaml` was unflagged.
- **Disposition:** all five gaps fixed in place (see plan re-review below).

### Plan re-review — 2026-07-13T01:05:10Z — SHIP

- **Reviewer:** genie:reviewer/plan-review-hermes-homogeneous-integration
- **Verdict:** SHIP
- **Gaps:**
  - LOW (non-blocking): Group 3's contract-test update must also widen `test_hooks_are_advisory_and_never_blocking`'s `set(result) <= {"message","advice","mutation"}` invariant, since `pre_llm_call` returns a `context` key the retired `post_tool_call` did not — surfaces immediately under the group's own TDD/validation loop.
- **Rationale (reviewer):** All five FIX-FIRST gaps resolved in place and verified against the repo: Group 3's validation now updates only the hook assertions its own changes break (tool/skill/version assertions deferred to Group 5); the Wave-1 map collision is broken by routing Group 2's resolution to a private report with `group-1, group-2` edges on the Group 4 fold; the invalid `bun test --filter` fallback is gone; the omitted test/version files are named; Group 6's routing matches the rubric. Dependency graph (4→{1,2}, 5→3, 6→{4,5}) is acyclic and wave-consistent; Wave-2 parallel groups touch disjoint files.
- **Status set by orchestrator:** APPROVED

### Group 1 local+quality review — 2026-07-13T01:28:27Z — SHIP

- **Reviewer:** genie:reviewer/g1-local-review (reviewer ≠ engineer)
- **Work:** commit `0c441a8`, merged to wish branch as `d3584f1`; validation command exit 0 (orchestrator-run)
- **Verdict:** SHIP
- **Gaps (all LOW, provenance-metadata only):** baseline.md header records base commit `a191224`/branch `wish/hermes-homogeneous-integration` while the worktree actually forked from `c350aef` on `worktree-agent-a335b967e6666af59`; captured evidence itself verified byte-exact against the live repo (plugin.yaml transcription, agent-sync grep line numbers, host probes). Informational: worktree lacked WISH.md — orchestration concern, resolved by merging into the wish branch.
- **Substance verified by reviewer:** MCP set = exactly the 5 tools in `src/lib/v5/mcp-tools.ts`; native kept 3 + retired 4 = current 7 in plugin.yaml; 23 real skill dirs; all companion-doc pointers resolve; diff provably docs-only (4 md files, +229/-0).

### Group 3 local+quality review — 2026-07-13T01:35:26Z — SHIP

- **Reviewer:** genie:reviewer/g3-local-review (reviewer ≠ engineer)
- **Work:** commit `f634460`, merged to wish branch as `e6364fb`; validation re-run by orchestrator: 32 passed (full plugin suite 55 passed per engineer)
- **Verdict:** SHIP
- **Gaps:** LOW — `_event_value` duplicated in `session_context.py` and `hooks.py`; deliberate (importing back would create a circular import), accepted as-is.
- **Substance verified by reviewer:** both caps hard and correctly ordered (≤ 8 lines at collection, ≤ 2 KiB on joined text); 5 s timeout wired and asserted; all failure paths return None (double-guarded); injection surface sound — `status` comes from the trusted column key, `id`/`wish` newline-collapsed so hostile rows cannot inflate line count (regression-tested); `on_session_start`/`pre_tool_call` byte-identical; `post_tool_call` gone from hooks.py and plugin.yaml; contract-test edits hook-only with version/tool/skill/khaw assertions intact; output shape confirmed against the real `board --json` emitter (`src/term-commands/v5-board.ts`), not just mocks.
- **Carried forward to Group 5:** `references/native-surface.md` still documents `post_tool_call` (doc drift flagged by engineer; that file is a Group 5 deliverable).

### Group 2 local+quality review — 2026-07-13T01:44:14Z FIX-FIRST → 2026-07-13T01:54:32Z SHIP

- **Reviewer:** genie:reviewer/g2-local-review (reviewer ≠ engineer ≠ fixer)
- **Work:** commits `87ff5bf` + `1ee1390` (engineer) + `b577cd8` (fixer, loop 1 of 2), merged to wish branch as `f2abab6`; validation re-run by orchestrator post-fix: 34 pass / 0 fail (104 assertions)
- **First pass — FIX-FIRST:** MEDIUM — inline/flow/scalar top-level `mcp_servers:`/`skills:` caused a blind duplicate-key append that could silently drop user sibling entries (reproduced end-to-end), violating "never delete user entries". LOW — report precedence ordering contradicted implementation; LOW — digest-managed copy fallback never pruned removed skills.
- **Fix:** fail-closed typed `HermesConfigError('inline-top-level-key')` raised before any backup/write in both modules (merging into flow values would require the parse/re-serialize round-trip the module contract forbids); report precedence corrected; managed target pruned before re-copy. All covered by new tests.
- **Re-review — SHIP, no gaps:** guard verified to fire strictly before `writeBackup`/`writeFileSync`, error path leaves file byte-identical with no backup; no regression across block-style/null-block/missing-file/drifted-update cases; scope exactly the five permitted files.
- **Contract handed to Group 4:** treat `code === 'inline-top-level-key'` as a NON-FATAL per-target convergence outcome — report/doctor WARN with the rewrite-as-block-mapping hint, never a thrown failure that blocks `genie update`; plugin-link leg still converges.
- **Open question 1 resolved:** `$GENIE_HOME/skills` IS a stable populated path (converged by `genie install` `AUX_LAYOUT_DIRS`/`normalizeAuxLayout` and `genie update` `syncAuxiliaryContent`); helper keeps a populated-gated fallback chain for dev checkouts. Recorded in `reports/skills-root-resolution.md`.

### Group 5 local+quality review — 2026-07-13T01:56:18Z — SHIP

- **Reviewer:** genie:reviewer/g5-local-review (reviewer ≠ engineer)
- **Work:** commits `ee5a0d3` + `8e234f3`, merged to wish branch as `53f328a`; validation re-run by orchestrator: 58 pytest pass, khaw absent from plugin.yaml, version `5.260712.2`
- **Verdict:** SHIP
- **Gaps:** LOW — `hooks.py` advisory strings (`_SESSION_REMINDER`/`_STRUCTURED_ADVICE`) still recommend the retired `genie_task_list` (no same-named MCP equivalent; MCP exposes `genie_task`). Non-breaking advisory drift; carried to Group 6 as a one-line cleanup (Group 3's hook tests only assert `genie_board`/`genie_status`, so it's safe).
- **Substance verified by reviewer (live execution, not summary-trust):** flag gate controls registration both ways (default exactly 3 tools; `=1` restores 7; `true` stays 3 by strict compare); MCP-prefer path degrades to the read-only bridge on any exception with only `str` results short-circuiting; skills dir down to the single `genie/SKILL.md` cockpit pointer which does NOT pretend external_dirs is wired; version.ts YAML write provably byte-preserving with 0/2+-version-line preflight rejects; Group 3 hook assertions untouched; tests strengthened, not weakened; no forbidden paths touched.

---

## Files to Create/Modify

```
# Create
plugins/hermes-genie/references/hermes-integration-map.md
plugins/hermes-genie/session_context.py
plugins/hermes-genie/tests/test_session_context.py
src/lib/hermes-mcp-config.ts
src/lib/hermes-mcp-config.test.ts
src/lib/hermes-skills-config.ts
src/lib/hermes-skills-config.test.ts
.genie/wishes/hermes-homogeneous-integration/reports/baseline.md
.genie/wishes/hermes-homogeneous-integration/reports/skills-root-resolution.md

# Modify
plugins/hermes-genie/plugin.yaml
plugins/hermes-genie/__init__.py
plugins/hermes-genie/hooks.py
plugins/hermes-genie/schemas.py
plugins/hermes-genie/commands.py
plugins/hermes-genie/tests/test_plugin_contract.py   (G3: hook assertions; G5: tool/skill/version assertions)
plugins/hermes-genie/tests/test_commands.py
plugins/hermes-genie/tests/test_genie_bridge.py
scripts/version.ts                                    (G5: YAML-write for plugin.yaml)
plugins/hermes-genie/skills/            (drop genie-khaw-bridge, dedupe meta-skills)
plugins/hermes-genie/scripts/smoke.sh
plugins/hermes-genie/README.md
plugins/hermes-genie/references/native-surface.md
plugins/hermes-genie/references/mutation-gates.md
plugins/genie/references/native-surfaces.md
src/lib/agent-sync.ts (+ tests)
src/genie-commands/doctor.ts (+ tests)
CHANGELOG.md

# Do not touch (separate wish)
mutation tools (task checkout/done, live launch)
Claude/Codex hook contracts
KHAW repo
```
