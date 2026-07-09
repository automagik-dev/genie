# Wish: /council — Native Workflow Engine (Deliberation + Audit)

| Field | Value |
|-------|-------|
| **Status** | DRAFT — design review SHIP + plan review SHIP (2026-07-09, same independent reviewer, 1 fix pass each); `/work` user-gated |
| **Slug** | `council-workflow` |
| **Date** | 2026-07-09 |
| **Author** | Felipe (planned with Fable 5) |
| **Appetite** | medium (≈1 week) |
| **Branch** | `wish/council-workflow` |
| **Design** | [DESIGN.md](../../brainstorms/council-workflow/DESIGN.md) |

## Summary

Genie's multi-perspective reasoning is split across two model-driven orchestrators — `skills/council/` (deliberation) and the personal `specialist-panel` skill (7-lane audit) — duplicating the same fan-out→synthesize pattern in fragile, non-resumable prompt form. This wish replaces both with one native dynamic-workflow command: `/council <topic>` deliberates, `/council audit [focus]` audits, backed by a unified 13-lens library (7 persona skills renamed by lane + 6 deliberation cards) shipped with the genie plugin and distributed by install-time stamp+copy to `~/.claude/workflows/council.js` (plugins verifiably cannot ship workflows). `/review` and `/brainstorm` gain lens-library consumption (panel dispatch and domain-experts steps, both new to the repo skills).

## Scope

### IN
- `plugins/genie/workflows/council.js` — workflow template: `meta.name 'council'`, phases Resolve → Round 1 → Round 2 (deliberation) → Synthesis → Persist (audit), ROUTING keyword table + LENSES map as JS data, schema-validated stage returns, ≥2-members rule, fresh-agent Socratic round 2, single-writer `.genie/repo-profile.md` persist.
- 7 standalone lane skills under `skills/`: `repo-hygiene`, `architecture`, `code-quality`, `qa`, `perf`, `supply-chain`, `dx-docs` — persona methodologies migrated, "inspired by the work of <expert>" cited, no real person's name as identity.
- 6 deliberation lens cards at `plugins/genie/references/lenses/` (questioner, simplifier, operator, deployer, measurer, tracer) with frontmatter (name, modes, voice).
- Install/update stamp+copy: `LENS_ROOT` (absolute installed-plugin path) stamped into the template, result written to `~/.claude/workflows/council.js`; re-stamped on update.
- Cutover: delete `skills/council/` entirely (SKILL.md, members/, templates/ absorbed into script + lens frontmatter); purge stale references.
- Consumers: `/review` gains lens-panel dispatch (multi-lens reviewers by change-type); `/brainstorm` lens-subagent step reads library cards.
- Lints wired into `bun run check`: council.js structural lint (ESM parse, banned APIs, meta, ROUTING↔LENSES integrity), lens frontmatter lint, lens-reference existence check for review/brainstorm.
- Docs: skills/README.md decision table, plugin docs, workflow requirements note (CC ≥ 2.1.154, paid plan, org `disableWorkflows`).

### OUT
- Rewiring `/work`, `/fix`, `/pm` to consume lenses (skill-absorbs G4 follow-up).
- Codex/Hermes support for the engine (workflow runtime is Claude Code-only — accepted).
- `genie council` term-command; per-repo `.claude/workflows/` scaffolding via `genie init` (repo override stays a documented capability).
- dream/scheduler autonomy; routing-matrix role-agent changes.
- Deleting Felipe's personal `~/.claude/skills/` copies (local hygiene, outside the repo).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | One engine, two modes | Both surfaces are the same fan-out→synthesize pattern; one script + mode presets maximizes reuse and honors the skill-absorbs G4 ruling |
| 2 | Personas absorbed as standalone plugin skills | Workflow reads the same SKILL.md as its lens — single source of truth; fix-mode ships to every genie user |
| 3 | `/council` is the single entry (`audit` subcommand) | Council is genie lore; closes the G4 naming GAP |
| 4 | Lane names, not people names | Real experts' names as speaking product personas without consent is a liability; inspiration cited in body |
| 5 | Saved workflow command, no launcher skill | Most native shape; args model-mediated; routing lives as data in the script |
| 6 | Install-time stamp+copy to `~/.claude/workflows/` | Plugins cannot ship workflows (verified against plugins reference 2026-07-09); smart-install runs with `CLAUDE_PLUGIN_ROOT` so `LENS_ROOT` stamping is deterministic and update-safe |
| 7 | Fresh-agent Socratic round 2 | Workflows have no SendMessage; feeding each member its own R1 back preserves identity, gains resumability |
| 8 | `skills/council/` deleted whole | Skill-vs-workflow precedence for one name is undocumented — avoid the collision |
| 9 | Consumers wired now (not deferred) | Felipe chose delivering the full G4 vision in this wish; both steps are new to the repo skills; sequencing handled by waves |

## Success Criteria

- [ ] `bun run lint:council-workflow` passes (exercised from G3 onward, once G1's lanes exist, and permanently via `bun run check`): template parses as ESM, `meta.name === 'council'`, zero banned APIs — `Date.now`, `Math.random`, `new Date(` (the Workflow tool spec: the determinism trio throws in scripts because it would break resume; `new Date(` banned broader-than-spec deliberately) plus `require(`, `import `, `process.`, `fs.` (workflows.md + tool spec: scripts are self-contained, no filesystem or Node.js API access) — every ROUTING member resolves to an existing lens file on disk (all 13), every lens file has required frontmatter
- [ ] All 7 lane skills exist with domain names; no real person's name in any `name:` field under `skills/` (grep denylist: chacon, ousterhout, hejlsberg, beck, gregg, lorenc, procida); inspiration line present in each
- [ ] Stamp unit test green: installer function replaces `LENS_ROOT` placeholder with an absolute path and output lands at the expected `~/.claude/workflows/council.js` target (tmpdir-isolated via `GENIE_HOME`-style env override)
- [ ] `skills/council/` no longer exists; `git grep -il 'specialist-panel'` returns 0 hits outside `.genie/attic/`, `CHANGELOG.md`, and this wish's artifacts
- [ ] `skills/review/SKILL.md` and `skills/brainstorm/SKILL.md` reference lens-library paths that exist on disk (lint fails on dangling path)
- [ ] `bun run check` green with new lints wired in
- [ ] Live QA evidence committed: one real `/council <topic>` deliberation run + one `/council audit` run on the genie repo, reports saved under `.genie/wishes/council-workflow/qa/`

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | G1 (lane skills) ∥ G2 (engine + lenses + stamp) | New files only — zero collision with the pending skills-fable5-revamp execution review |
| 2 | G3 (cutover) | Gated on G1+G2 AND skills-fable5-revamp MERGED to its base (review-closed insufficient); rebase `wish/council-workflow` onto the post-merge base first |
| 3 | G4 (consumers) | Edits review/brainstorm skills — behind the same fable5 merged-gate |
| 4 | G5 (lints in check + docs + live QA) | Final gate |

---

## Execution Groups

### Group 1: Lane skills — personas migrated and renamed
**Goal:** Ship the 7 specialist personas as standalone genie plugin skills under domain names.

**Deliverables:**
1. `skills/{repo-hygiene,architecture,code-quality,qa,perf,supply-chain,dx-docs}/SKILL.md` — methodology preserved from the personal persona skills, frontmatter `name:` = lane name, body cites "inspired by the work of <expert>", assess/fix contract kept per skill.

**Acceptance Criteria:**
- [ ] All 7 SKILL.md files exist with lane-named frontmatter
- [ ] No real person's name in any `name:` field under `skills/`
- [ ] Each body contains an inspiration attribution line

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bash .genie/wishes/council-workflow/validate/g1-lane-skills.sh
```

**depends-on:** none

### Group 2: Engine — council.js template, lens cards, install stamp
**Goal:** The workflow engine exists as a plugin-shipped template with its lens data and reaches `~/.claude/workflows/` through the install/update flow.

**Deliverables:**
1. `plugins/genie/workflows/council.js` — meta + Resolve/Round 1/Round 2/Synthesis/Persist phases, ROUTING table (absorbed from `members/routing.md`, incl. default trio + members override), LENSES map (`LENS_ROOT`-relative), deliberation and audit stage contracts, ≥2-members failure rule.
2. `plugins/genie/references/lenses/{questioner,simplifier,operator,deployer,measurer,tracer}.md` — frontmatter: name, modes, voice.
3. Stamp function as `src/lib/council-workflow-stamp.ts` (+ colocated `council-workflow-stamp.test.ts`, tmpdir-isolated): replaces the `LENS_ROOT` placeholder with the absolute installed-plugin path and writes `~/.claude/workflows/council.js`. **Call site pinned: the SessionStart hook (`plugins/genie/scripts/smart-install.js`, where `CLAUDE_PLUGIN_ROOT` is set), placed BEFORE its early-exit guards (deps-present, `GENIE_WORKER=1`) and idempotent via drift-check (rewrite only when stamped `LENS_ROOT` ≠ current `CLAUDE_PLUGIN_ROOT` or template hash changed). Re-stamp is therefore driven by the first session start after `claude plugin update` — the `genie update` CLI does not own it.**
4. `scripts/council-workflow-lint.ts` + `package.json` script `lint:council-workflow`.

**Acceptance Criteria:**
- [ ] Template parses as ESM (self-contained `bun build --no-bundle` check); `meta.name === 'council'`; zero banned APIs
- [ ] Every ROUTING member maps to a known lens NAME; the 6 deliberation cards exist with required frontmatter (full on-disk 13-lens resolution — including G1's lane skills — is asserted by `lint:council-workflow` from G3 onward, keeping G2 validatable in parallel with G1)
- [ ] Stamp unit test green in tmpdir isolation

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bash .genie/wishes/council-workflow/validate/g2-engine.sh
```

**depends-on:** none

### Group 3: Cutover — old council dies
**Goal:** Remove the model-driven council orchestrator and every stale reference to it or to specialist-panel.

**Deliverables:**
1. `skills/council/` deleted (SKILL.md, members/routing.md, members/config.md, templates/report.md).
2. References purged across skills/, plugins/, docs (report template + routing absorbed into the script in G2).
3. skills/README.md council row updated to point at the workflow.

**Acceptance Criteria:**
- [ ] `skills/council/` gone; no references to `members/routing.md`, `members/config.md`, or the council skill remain in live surfaces
- [ ] `bun run lint:council-workflow` green — first point where full 13-lens on-disk integrity is assertable (G1+G2 both done)
- [ ] `git grep -il 'specialist-panel'` → 0 hits outside `.genie/attic/`, `CHANGELOG.md`, this wish's artifacts
- [ ] **Process gate:** skills-fable5-revamp MERGED to its base branch (review-closed is not enough — its Wave 1 rewrote these same skill files in place), and `wish/council-workflow` rebased onto the post-merge base before this group starts (checked by the worker, recorded in the group log)

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bash .genie/wishes/council-workflow/validate/g3-cutover.sh
```

**depends-on:** Group 1, Group 2

### Group 4: Consumers — /review panels + /brainstorm domain-experts
**Goal:** The lens library is consumed beyond the council: review can convene multi-lens panels, brainstorm's lens-subagent step reads library cards.

**Deliverables:**
1. `skills/review/SKILL.md` — lens-panel dispatch section (change-type → lens cards; e.g. auth-touching diff adds the supply-chain lens reviewer).
2. `skills/brainstorm/SKILL.md` — gains a Decisions-stuck domain-experts step that dispatches 2-3 lens subagents reading `references/lenses/` cards (step is NEW to the repo skill; pattern mirrors the global brainstorm skill's lens-subagent step).

**Acceptance Criteria:**
- [ ] `skills/review/SKILL.md` has a lens-panel section with change-type → lens mapping (structural grep markers: `lens panel`, `change-type`)
- [ ] `skills/brainstorm/SKILL.md` has a domain-experts step (structural grep marker: `domain-expert`)
- [ ] Both skills reference lens-library paths (cards and lane skills) that exist on disk
- [ ] No duplicated lens definitions inline in either skill — no `voice:`/`modes:` frontmatter blocks outside the library (single source: the library)

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bash .genie/wishes/council-workflow/validate/g4-consumers.sh
```

**depends-on:** Group 3

### Group 5: Gate — lints wired, docs, live QA
**Goal:** The new lints run in the standard gate, docs reflect the new surface, and both modes are proven live.

**Deliverables:**
1. `lint:council-workflow` wired into `bun run check` (package.json).
2. Docs: skills/README.md, plugin README/docs notes, workflow requirements (CC ≥ 2.1.154, paid plans, `disableWorkflows`).
3. Live QA evidence: `.genie/wishes/council-workflow/qa/deliberation-run.md` + `qa/audit-run.md` (real runs on the genie repo, with `/workflows` token totals captured).

**Acceptance Criteria:**
- [ ] `bun run check` green AND its output proves `lint:council-workflow` actually ran (behavioral wiring check, not just script existence)
- [ ] Both QA evidence files present with real run output

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"
bash .genie/wishes/council-workflow/validate/g5-gate.sh
```

**depends-on:** Group 3, Group 4
