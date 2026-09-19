# Wish: Portable Phoenix observability, shipped as the `observe` skill

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `observe-skill-bundle` |
| **Date** | 2026-09-17 |
| **Author** | genie (operator: Felipe) |
| **Appetite** | medium |
| **Branch** | `wish/observe-skill-bundle` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

> **Truth (2026-09-19):** The one live wish with real open work: not one of the five groups has executed (`skills/observe` does not exist and `observe` is absent from `SHIPPED_SKILLS` in `scripts/release-docs.test.ts`), and it edits the shipped skill roster, so it lands after the stable cut and ahead of the wish-v7 program.

## Summary

Fix the known gaps in the Phoenix observability tooling merged in #2936 so it works for anyone who runs Phoenix locally, then ship it with genie releases as the `observe` skill. Two `/wish` runs were refused with route `plan`: `wf_be0903ef-7b3` because registering a shipped skill edits the denylisted `scripts/release-docs.test.ts`, and `wf_8491beac-ef6` because the fixes count as 9 units against a maximum of 3. This plan splits the work into five groups that each fit the admission band.

## Scope

### IN

- Correctness fixes in `backfill.ts` and `annotate.ts`: usage maximum per message id, exact-identity `--verify`, `--batch`/`--pace-ms` validation, failed annotation upserts exit non-zero, a bounded default window for `annotate.ts`.
- Portability: project names from the recorded working directory, a configurable transcripts root, a runtime skill roster that needs no repo-only script.
- Metadata-only exports carry no subagent free text; one Phoenix endpoint default; `px-queries.sh` takes its date range from an argument.
- Relocation into the shipped skill `skills/observe/` with its registration in the release pin and the generated skills catalog.

### OUT

- Documentation outside `skills/observe/README.md` and `skills/observe/SKILL.md`: no AGENTS.md, CLAUDE.md, root README or docs/ edits (operator decision 2026-09-17). The generated catalog block in `skills/README.md` is regenerated because skills:lint requires it; that is not hand-written documentation.
- The `observe` row in the genie router table (`skills/genie/SKILL.md:20-35`): deferred under the same operator decision; add when the router is next revised.
- Moving the `observability-review` workflow out of `.claude/workflows/`.
- A Codex transcript converter; ingesting workflow-agent transcripts; hooks, launchd or host wiring.
- `package.json`, `src/`, `plugins/`, `templates/`, `scripts/build-binary.sh`, `biome.json`, `.github/`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Ship through `skills/observe/` | `scripts/build-binary.sh:72` copies `skills/` into the release and `:118-119,:164` strip and check test files; `src/lib/install-promotion.ts:58` allowlists `skills`. No release-script change. Operator decision 2026-09-17: bundle it for any genie user with a local Phoenix. |
| 2 | Transcripts root: `--transcripts-root <dir>` or `OBSERVE_TRANSCRIPTS_ROOT`, default `$HOME/.claude/projects`, read by `annotate.ts` only | Resolves the judge's open question. `backfill.ts` keeps requiring explicit transcript paths (backfill.ts:916 rejects a run with none), so no unbounded discovery mode is added; a bare run cannot post the whole history. |
| 3 | Endpoint: `PHOENIX_ENDPOINT`, else `http://127.0.0.1:6006`; `PHOENIX_COLLECTOR_ENDPOINT` is not read | One variable, matching the `px` CLI; removes the `localhost` vs `127.0.0.1` split. |
| 4 | `px-queries.sh --since-days N` (default 7), timestamps computed with `python3` | `python3` is already a prerequisite of the script; avoids GNU `date -d` vs BSD `date -v`. |
| 5 | Tests at `scripts/observe-backfill.test.ts` and `scripts/observe-annotate.test.ts` after relocation | The release build never copies `scripts/`; tests under `skills/` would reach the public `npx skills add` path unstripped. Precedent: `scripts/design-review-evidence.test.ts:13` imports a skill helper. |
| 6 | Invocation form in skill docs: `bun "<observe-skill-dir>/scripts/backfill.ts"` and `bash "<observe-skill-dir>/scripts/px-queries.sh"` | `scripts/skills-lint.ts:501` rejects `bun scripts/…ts` as `repo-script-invocation`; brainstorm SKILL.md:40 is the precedent. |
| 7 | Keep the folder name `scripts/` inside the skill | Biome 1.9.4 `scripts/**` (biome.json:98) also matches `skills/observe/scripts/`; the same files under another folder raise 15 `noConsole` and 7 complexity errors (verified by the plan reviewer in a scratch copy). |
| 8 | `agents/openai.yaml` sets `allow_implicit_invocation: false` | The description loads on every turn; dream and omni use the same setting. |

## Simplicity Case

- **Simplest complete design:** fix the scripts in place (four small groups), then `git mv` them into a skill with the minimum front door and register it.
- **Added machinery:** a runtime roster resolver (needed because `scanRepoSkills` does not exist on an installed host) and a transcripts-root setting (needed for any non-default Claude Code home).
- **Deferred until measured:** bundling the weekly review workflow; a Codex converter; a genie router row.
- **Complexity removed:** no genie CLI surface, no hooks, no new shipped top-level directory, no second endpoint variable.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] On dev after merge, `test ! -e scripts/observability` and `skills/observe/scripts/{backfill.ts,annotate.ts,px-queries.sh}` exist.
- [ ] `bun run skills:lint` exits 0 and `bun test scripts/observe-backfill.test.ts scripts/observe-annotate.test.ts scripts/release-docs.test.ts scripts/skills-inventory-parity.test.ts scripts/observability-review-workflow-parity.test.ts` passes.
- [ ] `git grep -n --untracked "scripts/observability/" -- ':!.genie'` prints nothing.
- [ ] `grep -rnE "localhost:6006|2026-01-01|2027-01-01|skills-inventory-parity|scanRepoSkills" skills/observe/scripts skills/observe/README.md` prints nothing.
- [ ] `git diff --name-only origin/dev...HEAD | grep -E '^(package\.json|src/|plugins/|templates/|biome\.json|\.github/|scripts/build-binary\.sh)'` prints nothing.

## Execution Strategy

### Wave 1 (parallel)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | Low coupling; owns backfill.ts and its test only | inherit | backfill.ts correctness |
| 2 | engineer | Low coupling; owns annotate.ts and its test only | inherit | annotate.ts correctness |

### Wave 2 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | Medium; touches both scripts and both tests | inherit | Portability |

### Wave 3 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | Medium; touches both scripts and px-queries.sh | inherit | Exports, endpoint, queries |

### Wave 4 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 5 | engineer | Trust-boundary risk: edits the shipped-skill pin; otherwise renames | inherit | Relocate into the shipped `observe` skill |

**Global constraints:**
- Base `dev`. Gate: `bun run check`, or only the darwin-tolerated test files listed at `.claude/workflows/wish.js:106`, re-confirmed failing at the merge-base.
- Every new test name carries its group tag (`[observe-g1]` … `[observe-g5]`) so each Validation command's `-t` filter fails when the group's tests are missing (Bun exits 1 when a filter matches nothing).
- Roster tests always use a temporary directory (empty or a fixture tree) as the genie home, never the host's `~/.genie`.
- Unchanged in value and algorithm: the scrubber, deterministic span-id derivation, the `cc-` prefix, the eight annotation names, `ANNOTATOR_ID = 'code-annotator/v1'`, and the README ingestion truths except truth 5, which Group 5 rewrites to the expected-id subset rule of Group 1.
- Decisions 2, 3, 4, 5, 6, 7 and 8 apply verbatim.
- No `console.*` calls are added; existing output paths stay as they are.

Describe each group’s coupling and risk in **Complexity**. In **Model**, inherit the active model unless user instructions or an evidenced capacity need justify another supported runtime configuration. Use portable role names; keep actual model/effort settings in the runtime. Order groups by dependencies and give parallel writers disjoint files or isolated worktrees.

## Execution Groups

### Group 1: backfill.ts correctness

**Goal:** `backfill.ts` counts tokens correctly, verifies exactly, and rejects invalid pacing flags.

**Deliverables:**
1. Usage for a message id is the per-field maximum across all records sharing that id (fixes the first-record undercount: 3,112 vs 60,889 output tokens observed for one agent).
2. `--verify` counts a session complete only when every expected span id is stored (expected ⊆ stored), replacing the count comparison (bot P2 on #2936, backfill.ts:1001). Set equality is not required: after a full ingest, `--incremental --limit-turns` verifies a limited expected set against a larger stored set (backfill.ts:1038-1043, :1093).
3. `--batch` and `--pace-ms` reject non-integer or non-positive values with a clear error and non-zero exit before any network call (bot P2 on #2936, backfill.ts:927).

**Interfaces:**
- Consumes: none
- Produces: unchanged CLI flags; `verifyDrained` semantics become expected ⊆ stored.

**Acceptance Criteria:**
- [ ] A test with records 3112 then 60889 output tokens for one id asserts 60889.
- [ ] A test where the stored count exceeds the expected count but one expected id is missing reports incomplete; a test where stored is a strict superset containing every expected id reports complete.
- [ ] Tests reject `--batch 0`, `--batch 1.5` and `--pace-ms -1` and assert no fetch occurred.

**Validation:**
```bash
bun test scripts/observability/backfill.test.ts -t "observe-g1"
```

**depends-on:** none

---

### Group 2: annotate.ts correctness

**Goal:** `annotate.ts` counts tokens correctly, fails loudly on rejected upserts, and processes a bounded window by default.

**Deliverables:**
1. Usage per message id is the per-field maximum across records.
2. Any non-2xx upsert response, including 404, is recorded as a failure naming the session; the process exits non-zero after the run (bot P1 on #2936, annotate.ts:244).
3. Without `--since`, only sessions modified in the last 7 days are processed; `--all` processes the whole history.

**Interfaces:**
- Consumes: none
- Produces: new flag `--all`; exit code 1 when any upsert failed.

**Acceptance Criteria:**
- [ ] A test asserts the maximum-usage rule.
- [ ] A test with a mocked 404 asserts the session is named and the exit code is non-zero.
- [ ] Tests cover the 7-day default and `--all`.

**Validation:**
```bash
bun test scripts/observability/annotate.test.ts -t "observe-g2"
```

**depends-on:** none

---

### Group 3: Portability

**Goal:** The scripts run on any host layout without the genie repository.

**Deliverables:**
1. Project name derives from the session's recorded `cwd`: `cc-<basename>`; a `cwd` under the OS temp directory, `/tmp`, `/private/tmp` or a scratchpad path yields `cc-scratch`.
2. Transcripts root per Decision 2 in `annotate.ts`.
3. The skill roster used by `canonicalSkill` resolves at runtime from `GENIE_HOME` (default `$HOME/.genie`) `skills/*/SKILL.md`, falling back to `defaultAdjacentSkillsDir(import.meta.dir)`; for the repository layout that is `<scripts/observability>/../../skills`. `backfill.ts` no longer imports `scripts/skills-inventory-parity.ts`.
4. The existing roster tests (backfill.test.ts:64-88) set `process.env.GENIE_HOME` to an empty temporary directory before the roster is first used, because `canonicalSkill` takes no `genieHome` option and caches its roster (backfill.ts:153-160); otherwise a host `~/.genie/skills` without `observe` makes Group 5's full test run fail locally while CI stays green.

**Interfaces:**
- Consumes: Groups 1 and 2 merged into the branch.
- Produces: `projectNameFor(cwd: string): string`; `defaultAdjacentSkillsDir(scriptDir: string): string`; `resolveSkillRoster(opts?: { genieHome?: string; adjacentSkillsDir?: string }): string[]`; in `annotate.ts`, flag `--transcripts-root` and env `OBSERVE_TRANSCRIPTS_ROOT`.

**Acceptance Criteria:**
- [ ] Tests cover a cwd outside `~/workspace/repos` and a temp cwd.
- [ ] A test calls `resolveSkillRoster({ genieHome: <empty tmpdir>, adjacentSkillsDir: <repository skills/> })` and asserts the same names as `scanRepoSkills` (the import stays in the test only); a second test asserts a non-empty `genieHome` tree wins over the adjacent tree.
- [ ] Tests cover the transcripts-root flag and env var in `annotate.ts`.

**Validation:**
```bash
bun test scripts/observability/ -t "observe-g3" && ! grep -q "skills-inventory-parity" scripts/observability/backfill.ts
```

**depends-on:** Group 1, Group 2

---

### Group 4: Exports, endpoint, queries

**Goal:** Metadata-only exports are safe, all three scripts agree on the endpoint, and queries take a date range.

**Deliverables:**
1. Under `--content metadata`, the subagent span exports no description, prompt or similar free text; under `head` and `full` that text passes through the scrubber and clip (bot P1 on #2936, backfill.ts:678).
2. Endpoint per Decision 3 in `backfill.ts`, `annotate.ts` and `px-queries.sh`.
3. `px-queries.sh --since-days` per Decision 4; the hard-coded year range is removed.

**Interfaces:**
- Consumes: Group 3's `projectNameFor(cwd: string): string` for project selection and `resolveSkillRoster(...)` unchanged.
- Produces: `px-queries.sh [project] [--since-days N]`.

**Acceptance Criteria:**
- [ ] A test asserts no subagent description appears under metadata and a scrubbed one appears under head.
- [ ] `grep -nE "localhost:6006|PHOENIX_COLLECTOR_ENDPOINT|2026-01-01|2027-01-01" scripts/observability/backfill.ts scripts/observability/annotate.ts scripts/observability/px-queries.sh` prints nothing; a test proves the endpoint default and that `PHOENIX_COLLECTOR_ENDPOINT` is ignored.
- [ ] `bash -n scripts/observability/px-queries.sh` exits 0.

**Validation:**
```bash
bun test scripts/observability/ -t "observe-g4" && bash -n scripts/observability/px-queries.sh && ! grep -nE "localhost:6006|PHOENIX_COLLECTOR_ENDPOINT|2026-01-01|2027-01-01" scripts/observability/backfill.ts scripts/observability/annotate.ts scripts/observability/px-queries.sh
```

**depends-on:** Group 3

---

### Group 5: Relocate into the shipped `observe` skill

**Goal:** The fixed tooling ships with genie as `skills/observe/` with no behavior change.

**Deliverables:**
1. `git mv scripts/observability/{backfill.ts,annotate.ts,px-queries.sh}` to `skills/observe/scripts/` and `scripts/observability/README.md` to `skills/observe/README.md`; rewrite usage strings, comments and README paths (backfill.ts:17,27,894; annotate.ts:10; px-queries.sh:2,3,5; README.md:5,41-53) to the invocation form of Decision 6, and drop the README line saying nothing here ships.
2. `git mv` the tests to `scripts/observe-backfill.test.ts` and `scripts/observe-annotate.test.ts`, repointing `import.meta.dir` reads and `REPO_ROOT`; `defaultAdjacentSkillsDir` gains the bundled layout (`<skills/observe/scripts>/../..`) with a `[observe-g5]` test for both layouts.
3. `skills/observe/SKILL.md`, 40 to 90 lines, frontmatter `name: observe`, a description, a `category` accepted by `scripts/skills-inventory-parity.test.ts:404-411`, and `mutates: external`; prerequisites first (Bun, a local Phoenix, `px` and `python3` for queries; reads Claude Code session files).
4. `skills/observe/agents/openai.yaml` with a `short_description` of 25 to 64 characters, a `default_prompt` containing no `$WORD` token, and `allow_implicit_invocation: false`.
5. `observe` inserted between `merge` and `omni` in `SHIPPED_SKILLS` (`scripts/release-docs.test.ts:15`; sorted comparison at :927); catalog regenerated with `bun scripts/skills-inventory-parity.ts --write`.
6. References repointed: `.claude/workflows/observability-review.js:6,142`, `.claude/workflows/README.md:45`, `scripts/observability-review-workflow-parity.test.ts:4,6,8`.
7. `skills/observe/README.md` documents `--transcripts-root`/`OBSERVE_TRANSCRIPTS_ROOT`, the `PHOENIX_ENDPOINT` default, the 7-day window and `--all`, `--since-days`, and the expected-id subset `--verify` (truth 5 rewritten); stale text at README.md:11 (`../../.claude/…`) and :28 (`scanRepoSkills`) is removed.

**Interfaces:**
- Consumes: Group 3's `defaultAdjacentSkillsDir(scriptDir: string): string` and `resolveSkillRoster(opts?)`, and Group 4's final scripts.
- Produces: `skills/observe/scripts/backfill.ts`, `skills/observe/scripts/annotate.ts`, `skills/observe/scripts/px-queries.sh`.

**Acceptance Criteria:**
- [ ] `git diff -M --stat origin/dev...HEAD` shows the scripts, README and tests as renames.
- [ ] `bun run skills:lint` passes.
- [ ] `git grep -n --untracked "scripts/observability/" -- ':!.genie'` prints nothing.
- [ ] `skills/observe/SKILL.md` is 40 to 90 lines and `skills/observe/agents/openai.yaml` contains `allow_implicit_invocation: false`.
- [ ] `scripts/release-docs.test.ts` passes with `observe` in `SHIPPED_SKILLS`.

**Validation:**
```bash
bun run skills:lint && bun test scripts/observe-backfill.test.ts -t "observe-g5" && bun test scripts/observe-backfill.test.ts scripts/observe-annotate.test.ts scripts/release-docs.test.ts scripts/skills-inventory-parity.test.ts scripts/observability-review-workflow-parity.test.ts && test ! -e scripts/observability && ! git grep -n --untracked "scripts/observability/" -- ':!.genie' && n=$(wc -l < skills/observe/SKILL.md) && [ "$n" -ge 40 ] && [ "$n" -le 90 ] && grep -q 'allow_implicit_invocation: false' skills/observe/agents/openai.yaml && ! grep -nE "scanRepoSkills|\.\./\.\./\.claude" skills/observe/README.md
```

**depends-on:** Group 4

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: with a local Phoenix, `bun skills/observe/scripts/backfill.ts --dry-run <transcript>` prints a span summary, and `bun skills/observe/scripts/annotate.ts --dry-run` processes only the last 7 days.
- [ ] Integration: `bash scripts/build-binary.sh --platform <host platform>` stages `skills/observe/scripts/backfill.ts` and no `*.test.ts` under `skills/`.
- [ ] Regression: `bun run check` passes; the `observability-review` workflow parity test passes.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The scripts need Bun (`import.meta.dir`), and `install.sh` does not install it | Medium | SKILL.md lists Bun as the first prerequisite |
| Biome treats `skills/observe/scripts/` as `scripts/**` only because of the folder name; a Biome 2 upgrade could change that | Medium | Decision 7 keeps the name; a Biome upgrade must re-run `bun run lint` over this folder |
| Project names change for sessions already in Phoenix (for example `cc-genie--claude-worktrees-x` becomes `cc-x`), so an incremental re-ingest duplicates them | Medium | After Group 3 lands, re-ingest affected sessions with `--replace` into the new names or delete the superseded `cc-*` projects; stated in the README |
| The skill description loads on every turn for every agent | Low | Decision 8 disables implicit invocation |
| `px-queries.sh` becomes the first executable file under `skills/` | Low | Always invoked with `bash`, never executed directly |
| Codex-only users receive a skill that reads Claude Code session files | Low | Stated in SKILL.md; a Codex converter is a separate wish |

---

## Review Results

### 2026-09-17 plan review, round 1: FIX-FIRST

Independent read-only reviewer over the relocation-only draft. Blocking: (1) the global constraint allowed only import edits while success criteria required no old-path reference, and the moved files' own usage strings, comments and README reference the old path (backfill.ts:17,27,894; annotate.ts:10; px-queries.sh:2,3,5; README.md:5,41-53); (2) the ordering note enforced nothing and the upstream `wish/observability-gap-fixes` branch and PR do not exist. Major: `repo-script-invocation` lint trap (skills-lint.ts:501); required `category`/`mutates` (skills-inventory-parity.test.ts:404-411); openai.yaml constraints; SKILL.md 40-90 lines; sorted `SHIPPED_SKILLS` insert (release-docs.test.ts:927); catalog regeneration command; undecided test location; validation that skipped the moved tests and untracked files; `build-binary.sh` needs `--platform`; missing Bun and Biome risks. Minor: genie router row, implicit invocation, executable bit, a criterion without a command.

Disposition: blocking (1) fixed by Group 5 Deliverable 1; blocking (2) fixed by folding the gap fixes into Groups 1-4 of this wish; majors fixed by Decisions 5-8, Group 5 Deliverables 3-5, the Validation commands and the Risks table; minors fixed or deferred explicitly in Scope OUT.

### 2026-09-17 plan review, round 2: FIX-FIRST

Both round-1 blockers confirmed fixed. Major: (1) Groups 1-4 validation passed vacuously on existing tests (18 pass today); (2) Group 4 had four units (MAX_UNITS 3, wish.js:119) and Decision 2 hid a no-argument discovery mode in Group 3; (3) the adjacent-skills default for `resolveSkillRoster` depends on script location and was untested across the Group 5 move, and a roster test not isolating `genieHome` would fail on a host with `~/.genie/skills`; (4) set-equality verify breaks `--incremental --limit-turns` (backfill.ts:1038-1043, :1093). Minor: README truth 5 is count-based; Group 4 grep scope; shell-dependent grep over ignored worktrees; stale README text at :11 and :28; the Biome mitigation named the wrong command; project renames duplicate existing Phoenix data; cite wish.js:106 for the darwin list; nothing checked the SKILL.md line range or `allow_implicit_invocation`.

Disposition: (1) group test tags with `-t` filters in every Validation; (2) README deliverable moved to Group 5, Decision 2 limits the transcripts root to `annotate.ts`; (3) `defaultAdjacentSkillsDir(scriptDir)` in Group 3 Interfaces, bundled layout added and tested in Group 5, roster tests isolate `genieHome` (Global constraint); (4) verify is expected ⊆ stored with both test cases; minors fixed in Global constraints, Group 4 and 5 criteria, Success Criteria greps (`git grep --untracked`), and two new Risks rows.

### 2026-09-17 plan review, round 3: FIX-FIRST

Round-2 edits verified real (Validation `-t` filters at every group, Group 4 at three deliverables, Decision 2 scoped to annotate.ts, `defaultAdjacentSkillsDir` in Groups 3 and 5, subset verify with both cases, scoped greps, `git grep --untracked`, line-count and implicit-invocation checks, wishes-lint green). Fix first: (1) the existing roster test (backfill.test.ts:65-71) compares the default roster against the repository tree; after Group 3 the roster reads `~/.genie/skills` first, which on this host holds 20 skills without `observe`, and `canonicalSkill` caches its roster with no `genieHome` option (backfill.ts:153-160), so Group 5's full run would fail locally; (2) the empty-tmpdir constraint contradicted the precedence test that needs a non-empty genie home. Minor: Group 5 deliverables were numbered out of order.

Disposition: (1) Group 3 Deliverable 4 sets `GENIE_HOME` to an empty temporary directory in the existing roster tests before first use; (2) the Global constraint now allows an empty or fixture temporary directory; minor: Group 5 deliverables renumbered in order.

### 2026-09-17 plan review, round 4: SHIP

Independent read-only reviewer confirmed: Group 3 Deliverable 4 targets the roster describe block (backfill.test.ts:64-88) and the lazily built roster cache (backfill.ts:153-160), and with an empty genie home the roster falls back to the repository tree, so the roster assertions hold after Group 5; Group 3 stays at three units. The Global constraint is consistent with the empty and fixture precedence tests. Group 5 deliverables are numbered 1-7 with the README last, and earlier dispositions still point correctly. wishes-lint passes; no contradiction. Status set to APPROVED.

---

## Files to Create/Modify

```
scripts/observability/backfill.ts            (G1, G3, G4; moved in G5 to skills/observe/scripts/backfill.ts)
scripts/observability/backfill.test.ts       (G1, G3, G4; moved in G5 to scripts/observe-backfill.test.ts)
scripts/observability/annotate.ts            (G2, G3, G4; moved in G5 to skills/observe/scripts/annotate.ts)
scripts/observability/annotate.test.ts       (G2, G3, G4; moved in G5 to scripts/observe-annotate.test.ts)
scripts/observability/px-queries.sh          (G4; moved in G5 to skills/observe/scripts/px-queries.sh)
scripts/observability/README.md              (moved and rewritten in G5 to skills/observe/README.md)
skills/observe/SKILL.md                      (G5, create)
skills/observe/agents/openai.yaml            (G5, create)
skills/README.md                             (G5, generated catalog block)
scripts/release-docs.test.ts                 (G5, SHIPPED_SKILLS)
.claude/workflows/observability-review.js    (G5, path references)
.claude/workflows/README.md                  (G5, catalog row path)
scripts/observability-review-workflow-parity.test.ts (G5, import path)
```
