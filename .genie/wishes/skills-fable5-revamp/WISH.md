# Wish: Fable 5 Revamp of All Genie & Omni Skills

| Field | Value |
|-------|-------|
| **Status** | DRAFT — plan review SHIP on full scope G1–G8 (2026-07-04, 2 review rounds), ready for `/work` (dispatch gate: G7 last) |
| **Slug** | `skills-fable5-revamp` |
| **Date** | 2026-07-04 |
| **Author** | Felipe (planned with Fable 5) |
| **Appetite** | medium |
| **Branch** | `wish/skills-fable5-revamp` (one per repo) |
| **Repos touched** | `automagik-dev/genie` → `/home/feliperosa/vm-home/workspace/repos/genie`; `automagik-dev/omni` → `/home/feliperosa/vm-home/workspace/repos/omni` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

**Problem:** all 36 genie/omni prompt surfaces are over-scaffolded for pre-Fable models, 13 genie skill files (11 of the 36 surfaces plus 2 sibling reference files) invoke a CLI that no longer exists — `bun run skills:lint` exits 1 with 118 dead references — and genie v4 left live trash on upgraded machines (a stale `~/.claude/rules/genie-orchestration.md` that actively misleads agents, orphaned `4.x` plugin caches) that nothing short of full `genie uninstall` cleans today.

Revamp all 36 agent-facing prompt surfaces of the genie plugin (17 skills, 4,185 lines) and the omni plugin (4 skills, 11 commands, 3 agents, 1 rule — 1,329 lines) to the Fable 5 skill standard: lean always-loaded bodies, trigger-focused descriptions, grounded progress claims, real checkpoints only, and bulk content moved to on-demand sibling files. The current surfaces were written for older models — `refine` embeds an 800-line system prompt inline, `genie-hacks` embeds its whole catalog, `omni-ops` is a 484-line manual — burning context on every load and over-prescribing behavior Fable 5 does unprompted. Worse, they document a dead CLI: **118 missing-command references across 13 skill files** (`genie agent/team/wish/events/spawn/…` — the pre-v5 daemon model), so this revamp both compresses the prompts and re-grounds them in the live v5 zero-daemon surface (task DB, `genie launch`, Claude Code native teams). One shared conventions doc (`conventions.md`, shipped with this wish) makes the parallel workers apply an identical standard. A dedicated group (G8, user-requested scope addition) reviews the v4-era Claude rules for deletion and teaches `install.sh` to detect a v4 install and trash-clean it properly on upgrade — today only `genie uninstall` knows those paths.

## Scope

### IN

- Content rewrite of all 17 genie skills (`skills/*/SKILL.md` in `automagik-dev/genie`) per `conventions.md`.
- Content rewrite of all omni plugin surfaces (`plugins/omni/skills/*/SKILL.md`, `commands/*.md`, `agents/*.md`, `rules/*.md` in `automagik-dev/omni`) per `conventions.md`.
- Re-grounding every CLI invocation in the live v5 surface: replace or delete all 118 stale `genie agent/team/wish/events/…` references; rewrite dead daemon-era orchestration flows to the native-team + task-DB model (the shipped v5 `review` skill is the canonical voice).
- Extraction of embedded bulk (system prompts, catalogs, command references) into on-demand sibling files (`prompts/`, `references/`) under each skill directory.
- Deduplication across tiers: one canonical home per fact, links elsewhere (omni commands vs `omni-ops` sections; genie `omni` skill vs omni `omni-setup`).
- Cross-repo consistency verification of the wish→review→work handoff contract and inter-skill references.
- v4 legacy rules review: audit every Claude rule genie v4 installed (`~/.claude/rules/genie-orchestration.md` is the known one — 118-dead-ref CLI era, documents `genie spawn/team/send`), decide delete vs rewrite per rule (default: delete; v5 skills now carry orchestration guidance), and implement the decision consistently with `src/genie-commands/uninstall.ts`.
- Installer v4 detection + trash cleaning: `install.sh` is a curl-pipe bootstrap that ends in `exec genie install` (TS), so detection/cleanup lives in TypeScript wired into the `genie install` flow — a v4→v5 install/upgrade detects v4 leftovers (stale rules file, orphaned `automagik/genie/4.*` plugin caches, dead v4 hook registrations) and cleans them: backup first, exact known paths only, logged, shared manifest with `genie uninstall`.

### OUT

- No renames, moves, or deletions of existing skill/command/agent files — namespaces (`omni:automate`), hooks, and muscle memory stay intact. Converting omni `commands/` into `skills/` is a possible follow-up wish, not this one.
- No CLI/source-code changes in either repo (`src/**`, `packages/**`, `scripts/**` untouched; `.md` prompt surfaces only, plus new sibling `.md` files) — **except Group 8's enumerated surface**: a new legacy-paths module + v4-cleanup step under `src/genie-commands/` (with colocated tests), the cleanup call wired into `src/genie-commands/install.ts`, a guarded one-line post-delivery call in `src/genie-commands/update.ts` (adjudicated expansion — upgrade path must clean too), `src/genie-commands/uninstall.ts` refactored to consume the shared manifest, minimal command registration (`src/genie.ts`, `src/lib/interactivity.ts` exemption), and `install.sh` only for the restored handoff + flag pass-through. No broader refactor of `install.ts` / `update.ts` / `scripts/smart-install.js`.
- No new skills, no removed skills.
- No docs-site changes (`docs/` submodule untouched).
- Other plugins (workit, token-optimizer, brain) untouched.
- No plugin release/version-bump engineering beyond what CI already automates.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Single wish spanning both repos, one `wish/skills-fable5-revamp` branch per repo | User asked for one wish; groups are repo-scoped so each branch/PR stays reviewable and independently shippable |
| 2 | Content-only revamp — zero file renames/moves | Filenames are load-bearing: plugin namespaces, hook wiring, and user muscle memory survive; restructuring is a separable follow-up |
| 3 | Shared `conventions.md` authored at plan time, curated into every worker prompt | Six parallel workers must apply one standard, not six interpretations; removes a sequential "define standards" bottleneck group |
| 4 | Numeric always-loaded budgets (SKILL.md ≤ 200 lines, commands/agents ≤ 40, total ≥ 40% reduction) | Makes "lean" testable by `wc -l` instead of vibes; ceilings have an explicit justification escape hatch |
| 5 | Bulk → progressive disclosure: `prompts/` for runtime-read system prompts, `references/` for catalogs/API detail | Keeps trigger/flow always-loaded and cheap; depth stays one `Read` away; pattern already proven by `brainstorm/references/` and `council/members/` |
| 6 | Groups partitioned by work type and file-set disjointness, not alphabet | Extraction-heavy rewrites (refine, genie-hacks) are a different job than lifecycle-contract edits (wish/work/review); disjoint file sets make same-branch parallel work conflict-free |
| 7 | Frozen contracts list in `conventions.md` (paths, lint gates, status vocabulary, task-linkage commands, routing tables, `allowed-tools`) | The revamp must not change how the machine works — only how well the prompts read; G7 verifies the contract survived |
| 8 | Per-group validation uses a dead-namespace grep on the group's own files; repo-wide `skills:lint` green is the Group 7 gate | skills:lint walks the whole tree, so no Wave-1 group can turn it green alone; scoped greps keep parallel groups independently verifiable |
| 9 | v4 cleanup is conservative by construction: exact known genie-installed paths only, content-marker check on the rules file, backup to `~/.genie/state-backups/v4-cleanup-<ts>/` before removal, every removal logged | Deleting from a user's `~/.claude` is the one destructive surface in this wish; marker-gating + backup makes it reversible and provably scoped to genie's own artifacts |
| 10 | Default verdict for v4-era rules is DELETE, not rewrite (user-confirmed: "mostly old… even deleted too"); the legacy path list lives in ONE shared module consumed by both `genie uninstall` and the install-time cleanup | v5 plugin skills carry orchestration guidance now; a rewritten global rules file would duplicate them and drift again. One path list prevents install/uninstall disagreeing |

## Success Criteria

- [ ] All 36 surface files conform to `conventions.md`: frontmatter at byte 0, `name` = directory, trigger-focused description.
- [ ] Budgets hold: every `SKILL.md` ≤ 200 lines, every command/agent ≤ 40 lines, every rule ≤ 30 lines (or a one-line justification in the group report).
- [ ] Total always-loaded lines across both surfaces ≤ 3,300 (≥ 40% reduction from 5,514), measured by `wc -l` on the same file set.
- [ ] `bun run skills:lint` and `bun run wishes:lint` exit 0 in the genie repo (skills:lint currently exits 1: 118 missing-command references in 13 files — this wish takes it to zero).
- [ ] Per-file ceilings are not targets: most files land near their ~120-line aim; the ≤ 3,300 repo-total (sum of ceilings ≈ 3,568 does NOT satisfy it) is the binding constraint, enforced by Group 7.
- [ ] Omni structural check exits 0 (frontmatter + budget script in Group 6 validation).
- [ ] Zero reasoning-extraction language: `grep -riE "chain.of.thought|thinking block|internal reasoning|show your (full )?reasoning"` returns no matches on either repo's prompt surfaces.
- [ ] Frozen contracts intact: template paths, lint commands, `genie task` linkage, DRAFT/SHIP/FIX-FIRST/BLOCKED vocabulary, omni three-tier routing, `allowed-tools` frontmatter — verified by Group 7 against `conventions.md` § Preserve.
- [ ] `git status` in both repos shows only modified existing files plus new sibling files under skill directories — no deletions or renames (Group 8's enumerated source files are the sole exception).
- [ ] v4 rules verdict implemented: `~/.claude/rules/genie-orchestration.md` handling decided (default delete) and encoded in one shared path list used by both the install-time cleanup and `genie uninstall`; G8's bun tests green (pgserve caveat in G8 AC applies).
- [ ] The install flow (`install.sh` bootstrap → `genie install`) detects a v4 install (stale rules file by content marker, orphaned `automagik/genie/4.*` caches, dead v4 hook registrations) and cleans with backup + log; cleanup covered by bun tests proving it cannot touch paths genie did not install; `bash -n install.sh` clean if the bootstrap is touched.

## Execution Strategy

### Wave 1 (parallel — 7 groups, disjoint file sets)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | genie extraction-heavy: `refine`, `genie-hacks` (1,429 lines → bulk extracted to sibling files) |
| 2 | engineer | genie lifecycle core: `brainstorm`, `wish`, `work`, `review`, `fix`, `trace` (928 lines; frozen handoff contract; re-ground stale CLI refs) |
| 3 | engineer | genie routing & onboarding: `genie`, `wizard`, `learn`, `docs`, `omni` (699 lines; re-ground stale CLI refs incl. `genie/reference/lifecycle.md`) |
| 4 | engineer | genie PM & multi-agent: `pm`, `dream`, `council`, `report` (1,129 lines; heaviest stale-CLI density — daemon-era team/agent/events flows) |
| 5 | engineer | omni skill tier: `omni`, `omni-agent`, `omni-setup`, `omni-ops` (915 lines) |
| 6 | engineer | omni commands, agents, rules: 15 thin files (414 lines; dedupe against omni-ops) |
| 8 | engineer | v4 legacy audit & trash cleaning: rules review/delete + installer v4 detection/cleanup in the `genie install` flow (genie repo source surface — disjoint from all skill groups) |

### Wave 2 (sequential — after all Wave 1 groups)

| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Cross-repo verification: lints, budget totals, frozen-contract audit, cross-reference consistency, final evidence report |

**Dispatch gate (orchestrator-enforced):** the task DB has no dependency encoding — Group 7's task row is `ready` from creation, so `genie launch skills-fable5-revamp` alone would start verification alongside Wave 1. The orchestrator must dispatch Group 7 only after groups 1–6 and 8 are `genie task done`.

## Execution Groups

### Group 1: Genie extraction-heavy rewrites

**Goal:** Rewrite `refine` and `genie-hacks` so their always-loaded bodies carry only trigger + flow, with embedded bulk moved to on-demand files.

**Deliverables:**
1. `skills/refine/SKILL.md` ≤ 120 lines; the embedded Prompt Optimizer system prompt extracted to `skills/refine/prompts/optimizer.md`, which the skill Reads at subagent-dispatch time.
2. `skills/genie-hacks/SKILL.md` ≤ 120 lines; the hack catalog extracted to `skills/genie-hacks/references/` (per-category or single catalog file), with browse/search/contribute flow intact.

**Acceptance Criteria:**
- [ ] Both skills conform to `conventions.md` (structure, budgets, behavioral clauses, delete-list).
- [ ] `refine` dispatch flow explicitly Reads `prompts/optimizer.md`; file exists and contains the full optimizer prompt.
- [ ] No hack from the current catalog is dropped — moved, not deleted.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)" && \
  ! grep -rEn 'genie (agent|team|wish|events|project|metrics|spawn|sessions|send|chat|broadcast|dir)\b' skills/refine skills/genie-hacks && \
  test -f skills/refine/prompts/optimizer.md && \
  [ "$(wc -l < skills/refine/SKILL.md)" -le 200 ] && \
  [ "$(wc -l < skills/genie-hacks/SKILL.md)" -le 200 ] && echo G1-OK
```

**depends-on:** none

---

### Group 2: Genie lifecycle core

**Goal:** Tighten the plan→execute→review loop skills (`brainstorm`, `wish`, `work`, `review`, `fix`, `trace`) to Fable 5 standard without changing any handoff contract.

**Deliverables:**
1. Six revamped SKILL.md files (plus `brainstorm/references/design-template.md`) applying `conventions.md` behavioral clauses (act-on-enough-info for brainstorm; grounded progress for work/fix; assessment-vs-action for trace/review; tight scope for fix) and re-grounded in the live v5 CLI.
2. Frozen contracts preserved verbatim: template path, `bun run wishes:lint` gate, `genie task create --wish --group` linkage, SHIP/FIX-FIRST/BLOCKED vocabulary, `.genie/wishes/<slug>/` paths.

**Acceptance Criteria:**
- [ ] All six conform to `conventions.md`; each ≤ 200 lines.
- [ ] Every `genie <cmd>` fence names a live v5 subcommand (verified against `genie --help` / `genie task --help`); dead-namespace grep clean on this group's files.
- [ ] Diff review shows no change to any path, command, or status token listed in `conventions.md` § Preserve.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)" && \
  ! grep -rEn 'genie (agent|team|wish|events|project|metrics|spawn|sessions|send|chat|broadcast|dir)\b' skills/brainstorm skills/wish skills/work skills/review skills/fix skills/trace && \
  for s in brainstorm wish work review fix trace; do [ "$(wc -l < skills/$s/SKILL.md)" -le 200 ] || exit 1; done && echo G2-OK
```

**depends-on:** none

---

### Group 3: Genie routing & onboarding

**Goal:** Revamp `genie` (router), `wizard`, `learn`, `docs`, and `omni` (channel-wiring flow) — sharpen routing triggers, delete narration of default behavior.

**Deliverables:**
1. Five revamped SKILL.md files per `conventions.md`.
2. `genie` router keeps its full route table (compressed, no dropped routes); lifecycle reference stays in `skills/genie/reference/lifecycle.md`.
3. genie `omni` skill deduped against omni plugin's `omni-setup`: wiring flow stays canonical here, setup detail links to the omni plugin skill.

**Acceptance Criteria:**
- [ ] All five conform to `conventions.md`; each ≤ 200 lines.
- [ ] Router still routes every currently-routed intent (route table entries preserved or consolidated, none silently dropped).

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)" && \
  ! grep -rEn 'genie (agent|team|wish|events|project|metrics|spawn|sessions|send|chat|broadcast|dir)\b' skills/genie skills/wizard skills/learn skills/docs skills/omni && \
  for s in genie wizard learn docs omni; do [ "$(wc -l < skills/$s/SKILL.md)" -le 200 ] || exit 1; done && echo G3-OK
```

**depends-on:** none

---

### Group 4: Genie PM & multi-agent

**Goal:** Revamp `pm`, `dream`, `council`, `report` — the heaviest orchestration playbooks — with deliberate-parallelism and grounded-progress clauses replacing prescriptive step rituals.

**Deliverables:**
1. Four revamped SKILL.md files per `conventions.md`; mode playbooks (pm copilot/autopilot/pair) compressed to decision rules, bulky mode detail to `references/` if needed.
2. `council` keeps `members/` and `templates/` structure; `dream` and `report` keep their dispatch contracts (`genie` CLI invocations lint-clean).

**Acceptance Criteria:**
- [ ] All four conform to `conventions.md`; each ≤ 200 lines.
- [ ] Grounded-progress clause present in every skill that reports on dispatched work (pm, dream, report).

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)" && \
  ! grep -rEn 'genie (agent|team|wish|events|project|metrics|spawn|sessions|send|chat|broadcast|dir)\b' skills/pm skills/dream skills/council skills/report && \
  for s in pm dream council report; do [ "$(wc -l < skills/$s/SKILL.md)" -le 200 ] || exit 1; done && echo G4-OK
```

**depends-on:** none

---

### Group 5: Omni skill tier

**Repo:** `/home/feliperosa/vm-home/workspace/repos/omni` — branch `wish/skills-fable5-revamp` off `dev`. All paths below are relative to `plugins/omni/` in that checkout. Do NOT touch the genie repo; if `plugins/omni/` is missing from your cwd, you are in the wrong repo — stop and relocate, never create it.

**Goal:** Revamp the three-tier omni system (`omni` router, `omni-agent`, `omni-setup`, `omni-ops`) — keep the tier design and keyword routing, move command-reference bulk into `references/`.

**Deliverables:**
1. Four revamped SKILL.md files per `conventions.md`; `omni-ops` keyword-routing table preserved (compressed), per-domain command detail extracted to `plugins/omni/skills/omni-ops/references/<domain>.md`.
2. `allowed-tools` frontmatter preserved on every skill.
3. Dedup: omni-setup keeps setup canonical; omni-ops links instead of restating; router stays a pure dispatcher.

**Acceptance Criteria:**
- [ ] All four conform to `conventions.md`; each ≤ 200 lines.
- [ ] Every keyword row in the current omni-ops routing table still resolves to a section or reference file.
- [ ] Every `omni <cmd>` in retained fences is a real subcommand of the current CLI (spot-verified against `omni --help`).

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"/plugins/omni && \
  for f in skills/*/SKILL.md; do head -c 4 "$f" | grep -q -- '---' || { echo "BAD FM: $f"; exit 1; }; \
  [ "$(wc -l < "$f")" -le 200 ] || { echo "OVER BUDGET: $f"; exit 1; }; done && echo G5-OK
```

**depends-on:** none

---

### Group 6: Omni commands, agents, rules

**Repo:** `/home/feliperosa/vm-home/workspace/repos/omni` — branch `wish/skills-fable5-revamp` off `dev`. All paths below are relative to `plugins/omni/` in that checkout. Do NOT touch the genie repo; if `plugins/omni/` is missing from your cwd, you are in the wrong repo — stop and relocate, never create it.

**Goal:** Revamp the 11 command files, 3 agent definitions, and 1 rule file — trigger-focused, deduped against the omni-ops tier, generic filler deleted.

**Deliverables:**
1. 11 `commands/*.md` rewritten: keep frontmatter shape (`description`, `arguments`), body = trigger + 2–3 canonical examples + link to the owning omni-ops section; ≤ 40 lines each (`chats.md` currently 85 → within budget).
2. 3 `agents/*.md` rewritten: capability + evidence expectations + stop conditions replace "Working Style" filler; ≤ 40 lines each; `tools` frontmatter preserved.
3. `rules/omni-agent.md` tightened; ≤ 30 lines.

**Acceptance Criteria:**
- [ ] All 15 files conform to `conventions.md` budgets and structure.
- [ ] Each command body defers detail to its canonical omni-ops home instead of restating it.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)"/plugins/omni && \
  for f in commands/*.md agents/*.md; do [ "$(wc -l < "$f")" -le 40 ] || { echo "OVER: $f"; exit 1; }; done && \
  [ "$(wc -l < rules/omni-agent.md)" -le 30 ] && echo G6-OK
```

**depends-on:** none

---

### Group 7: Cross-repo verification & consistency

**Repos:** requires BOTH checkouts on their wish branches — genie at `/home/feliperosa/vm-home/workspace/repos/genie`, omni at `/home/feliperosa/vm-home/workspace/repos/omni`. Lints and the evidence report run in the genie repo; omni budget/frontmatter checks run in the omni checkout.

**Goal:** Prove the revamp holds as a system: budgets, lints, frozen contracts, and cross-references verified with pasted evidence; fix inconsistencies found.

**Deliverables:**
1. Evidence report at `.genie/wishes/skills-fable5-revamp/verification.md` (genie repo): per-file before→after line counts, total reduction %, lint outputs, reasoning-extraction grep output, frozen-contract audit table.
2. Cross-reference consistency pass: genie `omni` ↔ omni `omni-setup` links resolve; wish/work/review mutual references match; omni command→omni-ops section links resolve.
3. Fixes applied for any violation found (within this wish's scope only).

**Acceptance Criteria:**
- [ ] Every wish-level Success Criterion checked with command output pasted in `verification.md`.
- [ ] Total always-loaded line count ≤ 3,300 across both repos' surfaces.
- [ ] Both branches lint-clean and ready for PR.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)" && bun run skills:lint && bun run wishes:lint && \
  test -f .genie/wishes/skills-fable5-revamp/verification.md && \
  ! grep -riE "chain.of.thought|thinking block|internal reasoning" skills/ && echo G7-OK
```

**depends-on:** Group 1, Group 2, Group 3, Group 4, Group 5, Group 6, Group 8

---

### Group 8: v4 legacy audit & trash cleaning

**Repo:** `/home/feliperosa/vm-home/workspace/repos/genie` — branch `wish/skills-fable5-revamp`. Source surface only: new legacy-paths module + cleanup step under `src/genie-commands/` (+ colocated tests), cleanup call wired into `src/genie-commands/install.ts`, `src/genie-commands/uninstall.ts` consuming the shared manifest, `install.sh` only for flag pass-through. This group touches NO skill files — fully disjoint from Groups 1–4.

**Goal:** A v4→v5 install/upgrade detects and properly cleans v4 trash — today only full `genie uninstall` knows the legacy paths, so upgraded machines keep a stale, actively misleading `~/.claude/rules/genie-orchestration.md` and orphaned `4.x` plugin caches. Architecture fact (dev reality, adapted during execution): dev's v5 cutover deleted the old `genie install` command and install.sh's handoff entirely, so G8 recreates a thin TS `genie install` finisher (bootstrap hands off via a plain non-exec call) and wires the same cleanup into `genie update` post-delivery — the upgrade path real machines actually use. Cleanup lives in TypeScript, never duplicated in bash.

**Deliverables:**
1. v4-footprint inventory in the group report, grounded in the v4 plugin cache (`~/.claude/plugins/cache/automagik/genie/4.260509.9/` ships `rules/`, `agents/`, `hooks/`, `references/`, `scripts/`) and repo history: every artifact classified keep / rewrite / delete with evidence. Known targets: the rules file (verdict: delete per Decision 10), orphaned `automagik/genie/4.*` caches (`.orphaned_at`-marked), any `~/.claude/settings.json` hook entry invoking dead v4 genie commands (audit `genie hook dispatch` liveness before touching — it looks live in v5).
2. One shared legacy-path manifest (extend `uninstall.ts`'s `ORCHESTRATION_RULES_PATH` into a reusable list/module) consumed by both uninstall and the new cleanup, with colocated pgserve-free bun tests (tmpdir fixture pattern).
3. A `detectV4Install()` + cleanup step in TypeScript, wired into the `genie install` flow (`install.ts`) AND — adjudicated expansion after review — a guarded post-delivery `cleanupV4()` call in `genie update` (update.ts, try/catch, never fails the update): content-marker check on the rules file (only delete if it matches known v4 content markers, e.g. `genie spawn`/`genie team create`), backup to `~/.genie/state-backups/v4-cleanup-<timestamp>/`, removal log to stdout + `~/.genie/logs/`, idempotent on re-run, and a `--skip-v4-cleanup` opt-out on `genie install` (forwarded by `install.sh`'s restored handoff).
4. If the rules file was user-modified (marker mismatch): do not delete — warn and leave it, listing it in the log.

**Acceptance Criteria:**
- [ ] Re-running the install flow on an already-clean machine is a no-op (idempotent); `bash -n install.sh` clean if the bootstrap is touched.
- [ ] Tests prove: marker-matched rules file → backed up + removed; user-modified rules file → left in place with warning; non-genie files in `~/.claude/rules/` → never touched; v4 cache dirs → removed only under `automagik/genie/4.*` AND only when `.orphaned_at`-marked (unmarked/live versions untouched); settings.json hook entries → live `genie hook dispatch` kept as a no-op, removal only for provably-dead commands.
- [ ] `bun test src/genie-commands/` green in a pgserve-capable environment (CI runs it; some tests in that dir spawn pgserve and die with exit 144 in restricted sandboxes — fall back to the G8-owned test files (`*v4*.test.ts`, `install.test.ts`), which run pgserve-free); `bun run check:fast` shows no new failures beyond the pre-existing skills:lint baseline (owned by Groups 1–4/7).
- [ ] `genie uninstall` and install-time cleanup consume the same path manifest — zero duplicated path literals (no legacy path appears in both bash and TS, nor twice in TS).

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)" && bash -n install.sh && \
  grep -rqE 'detectV4|v4[A-Za-z]*[Cc]lean' src/genie-commands/ && \
  bun test $(ls src/genie-commands/*v4*.test.ts src/genie-commands/install.test.ts 2>/dev/null) && echo G8-OK
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Fresh Claude Code session with updated plugins (`claude plugins update`): `/genie` routes a natural-language planning request to the right skill; `/omni` routes to the correct tier (agent/setup/ops).
- [ ] Lifecycle dry-run on a toy idea: `/brainstorm` → `/wish` produces a wish that passes `bun run wishes:lint` — handoff contract survived the rewrite.
- [ ] `/refine` on a sample brief still dispatches the optimizer subagent (extracted `prompts/optimizer.md` loads at runtime) and writes output to the expected path.
- [ ] omni-agent verbs (`say`, `react`, `history`) still work against a test instance; omni-ops keyword routing lands on the right section for 3 spot-checked intents.
- [ ] genie repo CI `skills:lint` job green on the wish branch; no regression in `bun run check:fast`.
- [ ] Spot-run 3 CLI commands copied verbatim from revamped skills (one genie lifecycle, one omni verb, one omni ops) — all exist and execute against the live CLIs.
- [ ] v4 cleanup end-to-end on this machine (it IS a v4-upgraded box): run the updated install.sh — it detects the stale `~/.claude/rules/genie-orchestration.md` and orphaned `automagik/genie/4.*` caches, backs them up to `~/.genie/state-backups/v4-cleanup-<ts>/`, removes them, logs each removal; a fresh Claude session no longer loads the dead orchestration rules; re-run is a no-op.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Revamp silently alters the wish→work→review handoff contract, breaking live orchestration | High | Frozen-contracts list in `conventions.md`; Group 2 diff review; Group 7 audit; QA lifecycle dry-run |
| Workers "fix" stale CLI refs by inventing plausible v5 commands that don't exist | High | `conventions.md` § Current CLI reality: check `genie <ns> --help` / `omni --help`, never guess; G7 runs repo-wide `skills:lint` as the hard gate |
| Genie hook detectors (e.g. `pattern-10-agent-tool-bypass`) still encode the daemon-era model and may conflict with native-team flows in revamped skills | Medium | Skills follow the shipped v5 `review` skill's native-team pattern (already in production); detector/source updates are flagged as a follow-up wish, not changed here |
| v4 cleanup deletes something the user owns (modified rules file, non-genie file in `~/.claude/rules/`) | High | Decision 9: exact-path + content-marker gating, backup-first, warn-and-skip on marker mismatch, tests prove non-genie paths unreachable; `--skip-v4-cleanup` opt-out |
| `genie hook dispatch` in `~/.claude/settings.json` is misjudged as dead and removed, breaking live hook middleware | Medium | G8 must prove liveness/deadness against the v5 CLI (`genie hook --help`) before classifying; hook entries default to KEEP when uncertain |
| G8 scope creeps into a full installer refactor (`install.ts` is 25K) | Medium | OUT-scope carve-out enumerates the allowed files; reviewer checks the diff file list against it |
| `refine`'s extracted runtime prompt fails to load at dispatch (wrong path) | Medium | G1 validation `test -f`; QA criterion exercises the real dispatch |
| Aggressive compression drops a route/keyword some user relies on | Medium | "Compress, never drop routes" rule; G3/G5 acceptance criteria count route entries |
| Plugin cache staleness makes QA test stale prompts | Low | QA starts with `claude plugins update` and verifies installed versions advance past 5.260703.5 / 2.260703.6 |
| Parallel groups conflict on the same branch | Low | File sets are disjoint by construction; per-repo branches |
| Omni repo `dev`-branch PR flow diverges from genie's | Low | Groups 5–6 branch from `dev`, standard PR; wish is shippable per-repo |

---

## Review Results

**Plan review — 2026-07-04 — verdict: SHIP** (independent reviewer subagent, 1 fix loop)

- Loop 0 (FIX-FIRST): 1 HIGH (omni repo location missing from G5/G6/G7 — fabrication vector), 1 MEDIUM (Wave-2 gate not machine-enforced), 4 LOW (118-vs-116 count drift, dirty exemplar caveat, Σceilings > total budget, multi-sentence problem statement). All six amended.
- Loop 1 (SHIP): all six closures verified in the files; grounding re-confirmed (line counts exact, live CLI surface matches `--help` verbatim, all validation blocks execute, file sets disjoint, 7 task rows ready). Residual LOWs (problem-line wording — fixed post-review; G7 bash narrower than Success Criteria — covered by G7's pasted-evidence AC): non-gating.

**Delta review (G8 scope addition, user-requested) — 2026-07-04 — verdict: SHIP** (same independent reviewer)

- Interim finding (HIGH, confirmed): `install.sh` is a curl-pipe bootstrap ending in `exec genie install` — bash-resident cleanup would have contradicted the single-manifest requirement. Fixed: G8 redesigned TS-resident across all eight touchpoints; reviewer verified each and ran the validation block verbatim (green: 12/12 installer-resolution tests, pgserve-free).
- Test-gate reality documented: full `bun test src/genie-commands/` requires a pgserve-capable environment (exit 144 / hang in restricted sandboxes); AC carries the fallback.
- Residual LOWs applied post-verdict: SC/Decision-10 manifest wording, `.orphaned_at` gating + settings.json hook case added to the G8 test matrix, stale-CLAUDE.md caveat added to conventions.md. Repo CLAUDE.md rewrite remains a follow-up wish.

_Execution review: populated by `/review` after `/work` completes._

---

## Files to Create/Modify

```
# genie repo (automagik-dev/genie) — modify (current line counts)
skills/refine/SKILL.md        803   G1   skills/brainstorm/SKILL.md  233   G2
skills/genie-hacks/SKILL.md   626   G1   skills/wish/SKILL.md        106   G2
skills/pm/SKILL.md            395   G4   skills/work/SKILL.md        192   G2
skills/report/SKILL.md        281   G4   skills/review/SKILL.md      178   G2
skills/council/SKILL.md       258   G4   skills/fix/SKILL.md         111   G2
skills/dream/SKILL.md         195   G4   skills/trace/SKILL.md       108   G2
skills/genie/SKILL.md         185   G3   skills/learn/SKILL.md       108   G3
skills/omni/SKILL.md          164   G3   skills/docs/SKILL.md         82   G3
skills/wizard/SKILL.md        160   G3

# genie repo — create
skills/refine/prompts/optimizer.md
skills/genie-hacks/references/<catalog>.md
skills/*/references/<as needed per group>.md
.genie/wishes/skills-fable5-revamp/verification.md   (G7)

# omni repo (automagik-dev/omni), under plugins/omni/ — modify
skills/omni-ops/SKILL.md      484   G5   commands/{automate,batch,config,events,instances,monitor,search,send,trace,tts}.md  22-25 each  G6
skills/omni-setup/SKILL.md    261   G5   commands/chats.md            85   G6
skills/omni-agent/SKILL.md    117   G5   agents/{omni-automation-builder,omni-bot-framework,omni-feature-implementor}.md  26-28 each  G6
skills/omni/SKILL.md           53   G5   rules/omni-agent.md          11   G6

# omni repo — create
skills/omni-ops/references/<domain>.md

# genie repo — Group 8 source surface (modify/create)
src/genie-commands/install.ts                (wire v4-cleanup call + --skip-v4-cleanup flag)
src/genie-commands/uninstall.ts              (consume shared legacy-path manifest)
src/genie-commands/<legacy-paths module + v4-cleanup + tests>   (create, colocated pgserve-free tests)
src/genie-commands/update.ts                 (adjudicated: guarded post-delivery cleanupV4 call + test)
install.sh                                   (bootstrap: restored non-exec handoff + flag pass-through)

# machine-side targets of G8's cleanup (NOT repo files — removed at install/upgrade time)
~/.claude/rules/genie-orchestration.md       (delete if v4 content-marker matches; backup first)
~/.claude/plugins/cache/automagik/genie/4.*  (orphaned v4 caches; backup + remove)

# wish artifacts (this repo, created at plan time)
.genie/wishes/skills-fable5-revamp/WISH.md
.genie/wishes/skills-fable5-revamp/conventions.md
```
