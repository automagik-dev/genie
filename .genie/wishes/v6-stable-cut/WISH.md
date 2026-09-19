# Wish: Cut the first stable v6

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `v6-stable-cut` |
| **Date** | 2026-09-19 |
| **Author** | Felipe Rosa |
| **Appetite** | large |
| **Branch** | `wish/v6-stable-cut` (one branch per group: `wish/v6-stable-cut-g<n>`) |
| **Repos touched** | automagik-dev/genie, automagik-dev/docs (submodule bump) |
| **Design** | [genie-v6-corpo-leve rev. 4](../../brainstorms/genie-v6-corpo-leve/DESIGN.md) |

## Summary

`.genie/INDEX.md:9,28` already claims the number: the open dev→main promotion PR [#2935](https://github.com/automagik-dev/genie/pull/2935) is "the v6 stable cut". Nothing in the repository makes it true — `scripts/version.ts:42,63`, `scripts/release-guard.sh:40,41` and `.github/workflows/version.yml:114,322,328` all hardcode the `5.` major — and #2935 is `BLOCKED` with an empty `reviewDecision`, behind a `main` ruleset that wants an approval, last-push approval and an extra approval for unattributed changes, which its bot-authored `[auto-version]` tip is. This wish moves the major, repairs the pipeline that carries it, discharges the debt a major exists to discharge, fixes the known-broken surfaces, and rewrites the story to match the product. Every line number is derived at **dev at `68e3431c7`** (the merge of #3004); `origin/dev` is already one `[auto-version]` bump ahead at `2ea6ee919`, which is Risk 1 live — a dev release between the bump merge and the promotion is exactly what Decision 2 forbids.

## Scope

### IN

- The `5.` → `6.` major in all three authorities plus their `Format:` comments, landed as the last dev change before promotion.
- Release-pipeline repairs that must exist **before** the first `6.x` tag: #2923, #2924, the promotion PR's approval path **and** its `Quality Gate` provenance, one dry rehearsal on a replica HOME.
- Verification of the two behaviours that merged while this design was in review — the darwin gate (#3003) and Omni's removal (#3004) — plus their named residuals.
- Orca-mode honesty and the board freeze (D-C), including the explicit reversal of #2830.
- Dead surfaces a major may drop: the `mcp` and `ui-bridge` stubs and their registrations, `hire_roster` with a `user_version` 1 → 2 migration written in `sqlite-open.ts`, the `skills/quick` stub, `src/lib/legacy-integration-retirement.ts`.
- Four open bugs (#2919 item 2, #2917, #2942 `--check` in CI, doctor's per-entry mode-drift flood), two skill-intake lint guards, and `genie wish lint`.
- README and `docs/` rewritten to the v6 story, with the `.docs-vendor` submodule bumped; adoption of the Orca-plugin PR if it lands first.

### OUT

- The `.genie/mode` per-repo marker and `GENIE_MODE` (deferred to v7; the v6 mitigation is detective-on-demand via `genie doctor`, and after G5 the commit path gives the orca-side operator no signal — accepted).
- Removing `plugins/genie`, `plugins/dsh-genie-board`, `orca-marketplace.json` or the `orca-plugin` ref (D-B inverts rev. 3.3 item 6). Permanently out of G9: a second board (Orca's board **is** workspace status), a genie task provider (`TaskProvider` is a closed union, [orca#15328]), a status-bar segment ([orca#19809]) and `contributes.agents` ([orca#13306]); a `contributes.panels` Genie panel is deferred to v7 for want of a placement field ([orca#19809]/[orca#16853]).
- Any new board verb, column or lane beyond the `hire_roster` drop (D-C); any `genie-orca-*` skill tree, `## Dispatch plan` section, provenance block or `validate-wish --mode orca` content rule (rev. 4 revokes them).
- Relocating `scripts/{wishes-lint,validate-wish}.ts` under `src/`, adding rules to them, shipping any `genie wish` verb other than `lint`, or deleting an operator's orphaned `~/.genie/genie.db`.
- Authoring the Orca-plugin work (G9 adopts it; it has its own wish and its own plan review) and performing the promotion merge or the stable `workflow_dispatch` — owner actions this wish prepares.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | The major moves in exactly three authorities; `scripts/version.ts` is the local `npm run version` path only (`package.json:13`) | `version.yml:114` (`prefix=5`, used at `:173-183`) and `:322,328` are independent inline generators |
| 2 | The bump takes effect only when **main** carries it, so it is the last dev change before promotion and no dev release fires in between; Group 2 therefore lands first | `release-guard.sh` loads from the control ref (main), not `source_sha` (`release.yml:91`); `version.yml` runs from main. A 6-major on dev under a 5-major main mints a tag dev's own `release-guard.test.ts` rejects. An orphaned first-of-major tag cannot be re-run (#2924) |
| 3 | The first `6.x` tag is the first dev release after promotion; the first `6.x` stable is `release.yml` `workflow_dispatch` `channel=stable` on that version | `release.yml:18,22`; `release-guard.sh:97,106` require a human dispatch for stable, and the else branch at `:111` rejects a human dev dispatch |
| 4 | Dropping a table needs the one new mechanism here, and it lives in a **shared primitive**: `CURRENT_SCHEMA_VERSION` 1 → 2 (`src/lib/v5/genie-db.ts:43`) plus a forward migration in `src/lib/v5/sqlite-open.ts` | `initOrValidate` (`sqlite-open.ts:588-604`) throws `ForeignDbError(… 'unrecognized schema version')` for any stamped version that is neither `schemaVersion` nor `0`. A bump without a migration path makes **every operator database refuse to open**. `sqlite-open.ts` is shared with the global database, so this changes a contract, not one caller |
| 5 | `legacy-integration-retirement.ts` is deleted now | Its window comment (`:1388`) is two stable releases after `skills-everywhere-b` (SHIPPED 2026-08-31, `0efc288b5`); three followed — `v5.260901.4`, `v5.260916.4`, `v5.260916.6` |
| 6 | Groups 3 and 4 are **verification-only** | Their behaviour merged as #3003 and #3004 while this design was in review. Each keeps a named residual — a platform sentence for G3, nothing in-repo for G4 — and closes by verification, not by a commit |
| 7 | Group 5 reverses PR [#2830](https://github.com/automagik-dev/genie/pull/2830)'s "every form of `genie context` degrades identically", by explicit owner decision 2026-09-19 | `wish.js` refused this change at admission (`route=brainstorm`) precisely because it reverses a merged decision. The owner has decided: the board is frozen and orca mode is honest. The reversal is recorded in the code comment (`context.ts:419-423`), in the split test and here — never implicitly |
| 8 | Orca refusals exit **2**, not 1 | 2 is already genie's "operator must act" family — the v4 workspace gate and `mikro call`'s usage refusals both use it — while 1 stays "the command failed". The one fixed message, naming `orca` and `genie setup --orchestration-mode standalone`, is what disambiguates inside the family |
| 9 | `genie wish lint` wraps `scripts/wishes-lint.ts` **imported in place**, the `genie mikro` pattern; no relocation under `src/` | `skills/wish/SKILL.md:75,78` tells every repository to run a linter only this repository ships, and "a linter the project does not provide is reported as a finding" reads to a user as a missing script (owner report 2026-09-19). `src/term-commands/mikro.ts` is the precedent |
| 10 | Removing a retired verb is permitted at a major; `genie doctor` keeps observing the old host routes | A verb that still parses is a promise; the route observers are about host state, not the verb |
| 11 | Group 9 **adopts** the Orca-plugin PR; it gates nothing | That work has its own wish (`.genie/wishes/orca-plugin-genie`), its own plan review and its own branch. If it lands first the cut adopts it; if not, v6 ships without it |

## Simplicity Case

- **Simplest complete design:** one literal in three files, four pipeline repairs, two verifications, five deletions, five bug fixes, three lint/CLI additions, one docs pass, one adoption. No new subsystem.
- **Added machinery:** two — the `user_version` 1 → 2 migration, which is **one new mechanism in a shared primitive with its own contract** (`sqlite-open.ts`, Decision 4), and one commander group (`genie wish lint`) over code that already exists (Decision 9).
- **Deferred until measured:** `.genie/mode` + `GENIE_MODE`; collapsing skills.sh and the Orca plugin; any wish-document validator beyond the structural one; any other `genie wish` verb.
- **Complexity removed:** one global SQLite database, one daemon, one transport dependency, two registered stubs, one board table, one retired skill stub, one time-boxed retirement module, ~10k lines of doctor output per run.

## Dependencies

**depends-on:** none
**blocks:** none

PR #3002 (`accept superseded as a canonical terminal wish status`) is **merged**: `SUPERSEDED` is canonical in `scripts/wishes-lint.ts:32`, so nothing in this wish's status vocabulary is in flight.

## Success Criteria

- [ ] `genie --version` on the first stable release prints `6.YYMMDD.N`; `git tag --list 'v6.*'` is non-empty; no `v5.*` tag is created after the promotion merge.
- [ ] The first `6.x` tag has a Release object, no open `release-incident` issue names it, and the darwin leg (#3003, `ci.yml:138-140,265`) ran on the promotion commit.
- [ ] `genie --help` lists **15** commands — neither `mcp` nor `ui-bridge`, and `wish` present; `grep -rn 'hire_roster' src scripts .genie` is empty; `skills/quick/` and `src/lib/legacy-integration-retirement.ts` are absent; a grep for `omni|nats` in `src/` and `package.json` returns only legacy-retirement references.
- [ ] In orca mode a real `git commit` prints no `board snapshot not refreshed` warning, `genie task create` exits 2, `genie task sync` exits 0 with empty output, and `genie context --wish <slug> --plan` prints its payload and exits 0.
- [ ] `genie wish lint` runs from a non-genie repository over its `.genie/wishes` and exits 0 or 1 on structure alone; README and `docs/` name Omni, the Genie UI and the MCP server only as retired history, and say stable means Linux and macOS.
- [ ] If G9 is adopted: in a live Orca the palette shows the genie verbs in a worktree context, and a wish moving to review flips that workspace's status to `in-review` with the verdict as its card comment.
- [ ] `bun run check` green on the promotion commit with this wish and the rev. 4 design in the corpus.

## Execution Strategy

| Wave | Group | Agent | Complexity | Model | Description |
|------|-------|-------|------------|-------|-------------|
| 1 | 2 | engineer | High: workflow and branch-protection work whose failure mode is an unrecoverable release | opus | Release pipeline: #2923, #2924, approval + Quality-Gate provenance, rehearsal |
| 1 | 3 | engineer | Low: verification of merged #3003 plus one sentence | opus | Darwin gate — verify and close the residual |
| 1 | 4 | engineer | Low: verification of merged #3004; no in-repo residual | opus | Omni out — verify and close |
| 1 | 5 | engineer | High: reverses a merged decision; touches `openDb`, a git hook, the context verb | opus | Orca honesty + board freeze (D-C) |
| 1 | 6 | engineer | High: a destructive migration inside a shared primitive | opus | Stubs and dead surfaces at a major |
| 1 | 7 | engineer | Medium: five small fixes, two lint rules, one new command group | opus | Open bugs, intake guards, `genie wish lint` |
| 1 | 9 | engineer | Medium: review and adopt work planned and executed elsewhere | opus | Adopt the `orca-plugin-genie` PR (gates nothing) |
| 2 | 8 | engineer | Medium: two repositories, one submodule bump; after 3, 4, 6, 7 | opus | Docs and README rewritten to the v6 story |
| 3 | 1 | engineer | High: three release authorities plus the test files carrying the literal | opus | Version major 6 — the last dev change before promotion |

**Global constraints:**
- Never push to `dev` or `main`, never force, never merge, never bypass a hook; every PR targets `dev`. Wave 1 groups run in parallel in isolated worktrees.
- No dev release may fire between the Group 1 merge and the promotion merge; the promotion PR opens immediately after Group 1 merges.
- The board is frozen (D-C): no new verb, lane or column; the `hire_roster` drop in Group 6 is the only schema change permitted.
- `plugins/genie`, `plugins/dsh-genie-board`, `orca-marketplace.json` and `orca-plugin-ref.yml` are not deleted (D-B); the three version files stay three. `INSTALL_PAYLOAD_MEMBERS` stays the frozen 8; `state-backups/` roots written by an earlier run are never removed; doctor is read-only including under `--fix`; genie creates no product home.
- `src/` style: `.js` import specifiers, no `console.log`, cognitive complexity ceiling 25, Biome single quotes / 2 spaces / 120 columns; tests colocated, `bun:test`, tmpdir fixtures, real git repositories, `GENIE_HOME` isolated to a tmpdir. `scripts/{mikro,wishes-lint,validate-wish}` files are not relocated and complexity-budget ceilings are not raised.
- A group that edits CLAUDE.md runs `src/__tests__/claude-md-drift.test.ts`; a group that changes `genie --help` moves the counts at `README.md:158` and `CLAUDE.md:72` in the same commit. The count is **per tree** under the declared merge order: the live registry is 16, Group 7 adds the `wish` group first (**17 / `Seventeen`**), Group 6 then drops `mcp` and `ui-bridge` (**15 / `Fifteen`**), and 15 is the final registry. `scripts/release-docs.test.ts:938-944` asserts the exact `<n> CLI commands` string in README and `<word> top-level commands` in CLAUDE.md, so a wrong word is a red gate.
- This host: `umask 022` before any gate; never run the full `bun test` concurrently with another agent.

Groups 2–7 and 9 are disjoint in code. Shared appended files: `CLAUDE.md` (3, 5, 6, 7) and `README.md` (3, 6, 7, 8) — each group appends or removes its own section and rebases its branch over the earlier one. Expected merge order: 2, 4, 3, 5, 7, 6, 9, 8, 1; **G9 may be dropped from the order entirely without changing the cut.**

## Execution Groups

### Group 1: Version major 6

**Deliverables:**
1. `scripts/version.ts`: tag glob (`:42`), generated string (`:63`), `Format:` comment (`:5`) → `6.`.
2. `scripts/release-guard.sh`: `VERSION_RE` (`:40`), `TAG_REF_RE` (`:41`), the `date_part` strip and the scheme comment (`:37`) → `6.`; the historical incident note keeps its `v5.` citation.
3. `.github/workflows/version.yml`: `prefix=6` (`:114`), the promotion-tag glob and generator (`:322`, `:328`), the comment (`:111`) → `6.`. Every test pinning the scheme rather than a fixture literal follows — `scripts/release-guard.test.ts` and `scripts/version-ci-staging.test.ts` are the known two; `bun run check` names any others. The PR body states the sequencing: merge alone, open the promotion PR immediately, let no dev release fire in between, then dispatch `release.yml` `channel=stable` on the first `6.x` version.

**Acceptance Criteria:**
- [ ] `grep -rn '5\.' scripts/version.ts scripts/release-guard.sh .github/workflows/version.yml` returns only the historical incident note, and `generateVersion()` on a clone with no `v6.*` tags returns `6.<today>.1`.
- [ ] `bun run check` green (`release-guard`, `version-ci-staging`, `version-format` included), the PR body carries the sequencing paragraph, and the PR is the only unmerged dev change when it merges.

**Validation:** `umask 022 && bun run check:fast && bun test scripts/release-guard.test.ts scripts/version-ci-staging.test.ts scripts/version-format.test.ts scripts/release-docs.test.ts`

**depends-on:** Group 2

### Group 2: Release pipeline fit to carry a first-of-major tag

**Deliverables:**
1. #2923: `release-orphan-alert.yml` closes an open `release-incident` issue with a comment once its tag has a Release, on each cron fire; promotion tags are exempt from filing during the documented publish lag.
2. #2924: the Recovery section of `genie/_internal/runbooks/release-pipeline.md` (in `automagik-dev/docs`) is rewritten — a dev orphan recovers by landing any commit on dev through a PR, a stable orphan by the stable re-dispatch; the tag stays and the incident closes as superseded. No `workflow_call`-only workflow is named.
3. The promotion PR's **approval path**, written down and executed: the `main` ruleset requires `required_approving_review_count: 1`, `require_last_push_approval: true`, `require_extra_approval_for_unattributed_changes: true` and `required_review_thread_resolution: true`, and dev's tip is a bot-authored `[auto-version]` commit — an unattributed change. #2935 reads `BLOCKED` with an empty `reviewDecision` today. The PR body names **who** approves (a human with write access who is not the bot author), and states that the last-push approval must post-date the final `[auto-version]` push.
4. The **Quality-Gate provenance**, separately: `version.yml` pushes its `[auto-version]` child with `GITHUB_TOKEN`, so GitHub suppresses push/PR recursion (`ci.yml:8-11`) and the required `Quality Gate (typecheck + lint + test)` context can sit unrun. The dispatched CI run's checks must attach to the promotion head. Plus one dry rehearsal on a replica HOME (tag → release → update hop) recorded in the PR body with its `"outcome":"committed"` line.

**Acceptance Criteria:**
- [ ] A test or recorded manual dispatch shows an open `release-incident` closed automatically once its Release appears; the runbook's Recovery section names no `workflow_call`-only workflow; the rehearsal transcript prints `"outcome":"committed"`.
- [ ] On #2935 (or its successor), `gh pr view <n> --json statusCheckRollup,reviewDecision,mergeStateStatus` shows `Quality Gate` COMPLETED against the promotion head SHA, `reviewDecision` `APPROVED`, and `mergeStateStatus` no longer `BLOCKED`. A green rollup with an empty `reviewDecision` is explicitly **not** sufficient.

**Validation:** `umask 022 && bun run check:fast && bun test scripts/release-guard.test.ts scripts/release-replay-guard.test.ts`

**depends-on:** none

### Group 3: Darwin gate — verify and close the residual

**Goal:** Confirm #3003 did what D-D requires, and close the one thing it left.

**Deliverables:**
1. Verification only: `.github/workflows/ci.yml:138-140` runs `unit-darwin` on `macos-latest`, it is required at `:265` and read at `:274`, and `:129` states the policy. The five darwin-sensitive tests named in the issue verification are re-checked; anything still asserting a linux literal is reported, not silently patched.
2. The residual: one sentence in `README.md` and `CLAUDE.md` stating that stable is declared for **Linux and macOS** (today's only macOS mentions are incidental, `README.md:229-230`).

**Acceptance Criteria:**
- [ ] The darwin leg ran and passed on this group's own PR and appears in its check rollup; README and CLAUDE.md carry the platform sentence.
- [ ] `git grep -n "linux"` over the `src/` and `scripts/` tests names no remaining hardcoded platform literal, or each survivor is listed in the PR body with its reason.

**Validation:** `umask 022 && bun run check:fast && bun test src/lib/orca-orchestration-adapter.test.ts src/__tests__/claude-md-drift.test.ts scripts/release-docs.test.ts`

**depends-on:** none

### Group 4: Omni out — verify and close

**Goal:** Confirm #3004 removed Omni entirely. **There is no in-repo residual**; the public `docs/` pages belong to Group 8.

**Deliverables:**
1. Verification only — if the enumeration turns up a live reference it becomes a one-commit repair here, and the finding is recorded in this wish's `## Review Results`. `package.json` carries no `nats` dependency; `src/lib/omni-*.ts`, `src/lib/v5/{global-db,omni-queue}.ts`, `src/term-commands/omni.ts` and `skills/omni/` are absent; the registry is 16 commands; the doctor omni checks and block 9b of `tests/e2e/v5-lifecycle.sh` are gone. Surviving mentions are enumerated and confirmed historical — **10 files**: `skills/NOTICE`, `src/lib/{legacy-skills-catalog,genie-home}.ts`, `src/lib/genie-home-permissions.test.ts`, `src/genie-commands/{doctor,legacy-v4}.ts`, `src/lib/v5/{TAXONOMY.md,genie-db.ts,sqlite-open.ts}`, `tests/e2e/v5-lifecycle.sh` (the two `genie-home` hits are capitalized `Omni` in prose explaining why v6 opens no machine-scope database).

**Acceptance Criteria:**
- [ ] `grep -rni 'omni\|nats' src scripts package.json skills tests` returns exactly the 10 enumerated historical files, each named in the PR body; `bun run build` succeeds with no NATS client in the bundle, `bash tests/e2e/v5-lifecycle.sh` is green, and `genie doctor --json` reports no omni check.

**Validation:** `umask 022 && bun run check:fast && bun run build && bun test src/genie-commands/doctor.test.ts scripts/release-docs.test.ts`

**depends-on:** none

### Group 5: Orca honesty and the board freeze (D-C)

**Goal:** Orca mode refuses what it forbids with an operator-actionable exit code, stops warning on every commit, and still answers the one read-only question the wave base needs.

This group **reverses** PR #2830's "every form of `genie context` degrades identically" by explicit owner decision, 2026-09-19 (Decision 7). The reversal is recorded in the code comment, in the split test, and here.

**Deliverables:**
1. `ORCA_FORBIDDEN` exported from `src/lib/orchestration-mode.ts` as a closed list: `task` (every subverb **except** `sync`), `board`, `idea`. Nothing else.
2. A **second, non-exempt** commander `preAction` in `src/genie.ts` refusing those verbs before the handler with **exit 2** and one fixed message naming `orca` and the remedy `genie setup --orchestration-mode standalone` (Decision 8). `installWorkspaceCheck`'s hook cannot carry it: `WORKSPACE_EXEMPT` (`src/lib/interactivity.ts:42`, consulted at `:113`) exempts exactly these verbs.
3. `genie task sync` exits **0, silent** in orca mode, with the check placed **before** the `hasGenieWorkspace()` guard in `handleSync` (`src/term-commands/v5-task.ts:727`), so `.husky/pre-commit` stops printing `board snapshot not refreshed` on every commit.
4. `genie context --wish <slug> --plan` answers read-only in orca mode with no `writeWishBase` path reachable; every other form keeps refusing (`context.ts:424`, comment `:419-423`). `src/term-commands/context.test.ts:567`'s four-form `test.each` is **split, not deleted** — three forms still assert refusal, `--plan` asserts the answer — with a comment recording the #2830 reversal. `src/lib/v5/authority-barriers.test.ts` and `src/term-commands/v5-board.test.ts` orca assertions are **amended to exit 2**, not removed.
5. The freeze restated in CLAUDE.md and README (no new verb, lane or column), plus a test pinning `ORCA_FORBIDDEN` so a verb cannot join or leave it silently.

**Acceptance Criteria:**
- [ ] In orca mode: `genie task create --title x`, `genie board` and `genie idea x` each exit **2** with the one fixed message naming the remedy; `genie task sync` exits 0 with empty stdout and stderr; `genie context --wish <slug> --plan` exits 0 with its JSON payload.
- [ ] A real `git commit` in an orca-mode repo prints no `board snapshot not refreshed` warning; in standalone mode every one of those verbs behaves byte-identically to today.
- [ ] `context.test.ts`'s split retains all four forms as assertions and carries the #2830 reversal comment; `authority-barriers.test.ts` and `v5-board.test.ts` assert exit 2 rather than dropping their orca cases; the `ORCA_FORBIDDEN` pin test fails when a verb is added or removed.

**Validation:** `umask 022 && bun run check:fast && bun test src/term-commands/v5-task.test.ts src/term-commands/v5-board.test.ts src/term-commands/context.test.ts src/lib/v5/authority-barriers.test.ts src/lib/orchestration-mode.test.ts src/__tests__/claude-md-drift.test.ts`

**depends-on:** none

### Group 6: Stubs and dead surfaces a major may drop

**Deliverables:**
1. Delete `src/term-commands/{mcp,ui-bridge}.ts` and their tests, the imports at `src/genie.ts:37,39` and the registrations at `:258,259`. `genie doctor` keeps observing the old `.mcp.json` and `.codex/config.toml` routes. `README.md:175,177,273-279` and `CLAUDE.md:83,88` lose their rows and prose; because Group 7 merges first and adds `wish`, the counts at `README.md:158` and `CLAUDE.md:72` move from 17/`Seventeen` to **15/`Fifteen`** in this tree (`scripts/release-docs.test.ts:938-944`).
2. Drop `hire_roster` with `CURRENT_SCHEMA_VERSION` 1 → 2 (`src/lib/v5/genie-db.ts:43`) **and a forward migration in `src/lib/v5/sqlite-open.ts`** (Decision 4): `initOrValidate` (`:588-604`) must learn to migrate a stamped v1 database instead of throwing `ForeignDbError('unrecognized schema version')`. Sites: `genie-db.ts:479,657`; `task-state.ts:2097,2114,2120,2128-2129,2152,2195,2238`; `roadmap-sync.ts:140,146,403`; `doctor.ts:284`; `src/lib/v5/TAXONOMY.md:83`; `.genie/INDEX.md:3` (the board-snapshot preamble's "`hire_roster` worktree state stays machine-local" clause); the committed `.genie/roadmap.json` and its golden. `task import` of a snapshot carrying the key ignores it rather than failing.
3. Delete `skills/quick/` and its references: `skills/README.md:80`, `skills/genie/SKILL.md:41`, `skills/wish/SKILL.md:10`, `scripts/skills-lint.ts:394`, `scripts/release-docs.test.ts:27,1029-1048`, `scripts/wish-workflow-parity.test.ts:134-142`, `.claude/workflows/wish.js:6,58`, `.genie/INDEX.md:28`.
4. Delete `src/lib/legacy-integration-retirement.ts` (window comment `:1388`), its tests and call sites; the update transcript loses its `integrations: ` lines and `CLAUDE.md:219` its gotcha. Window evidence in the PR body (Decision 5).

**Acceptance Criteria:**
- [ ] In **this group's tree** (merged after Group 7) `genie --help` lists **15** commands and neither `mcp` nor `ui-bridge`; `release-docs.test.ts` passes with `Fifteen top-level commands` in CLAUDE.md and `15 CLI commands` in README.
- [ ] A `genie.db` stamped `user_version = 1` and carrying `hire_roster` rows **opens** under the new binary, is migrated to 2, loses the table, and a second open is a no-op — watched failing first against a bump without the `sqlite-open.ts` migration.
- [ ] `grep -rn 'hire_roster' src scripts .genie` is empty, including `.genie/roadmap.json`, `.genie/INDEX.md:3` and `src/lib/v5/TAXONOMY.md:83`; `genie task export` no longer carries the key and `task import` of a pre-migration snapshot succeeds.
- [ ] `bun run skills:lint` and `bun run dead-code` pass with `skills/quick/` absent; `genie update` on a replica HOME succeeds with the retirement module gone and prints no `integrations: ` line.

**Validation:** `umask 022 && bun run check:fast && bun test src/lib/v5/genie-db.test.ts src/lib/v5/sqlite-open.test.ts src/lib/v5/task-state.test.ts src/term-commands/v5-task.test.ts src/genie-commands/doctor.test.ts scripts/release-docs.test.ts scripts/wish-workflow-parity.test.ts src/__tests__/claude-md-drift.test.ts`

**depends-on:** none

### Group 7: Open bugs, intake guards, and `genie wish lint`

**Goal:** The known-broken things are fixed, the two lint rules that would have caught two of them exist, and every repository can run the wish linter its skill tells it to run.

**Deliverables:**
1. #2919 item 2: `.claude/workflows/skill-audit-sweep.js:63` spells `PARITY_CHECK` with no list argument, so `readListInput()` (`scripts/skills-inventory-parity.ts:519-522`) falls through to `Bun.stdin.stream()` and the command can never complete as printed. Replace it with the piped form; `scripts/skill-audit-workflow-parity.test.ts:83` follows.
2. #2917: the five front doors still naming a runtime — `skills/{council,workfly,docs,research,skill-audit}/SKILL.md:12` and `skill-audit/SKILL.md:46` — adopt the neutral form already in `skills/wish/SKILL.md:12`. A new `skills-lint` rule bans a bare product runtime name in skill prose, in the shape of `BANNED_TOKEN_GUIDANCE` (`scripts/skills-lint.ts:72`, collected at `:114-119`), with the waiver hook. `skills/workfly/SKILL.md:41` is the same defect from the other side — it hands every repository a genie-repo-only command — and is fixed here.
3. **`genie wish lint [--dir <repo>]`**: a `wish` command group registered in `src/genie.ts`, wrapping `scripts/wishes-lint.ts` **imported in place** as `src/term-commands/mikro.ts` wraps `scripts/mikro/call.ts` (Decision 9) — the `import.meta.main` block becomes an exported `runWishLintCli(argv): Promise<number>` and the guard calls it. It runs the **structural** checks over `<repo>/.genie/wishes` (default: the git toplevel of cwd), exits 0 or 1, writes nothing, and says in its help that design-review-evidence and cross-wish graph rules stay repository-gate concerns. `skills/wish/SKILL.md:75,78` becomes `genie wish lint`; `bun run wishes:lint` stays the genie-repo alias and CI gate. `wish` is a NEW top-level group, so Group 7's own tree carries **17 / `Seventeen`** commands (16 + 1) and moves both doc counts to that; Group 6 then takes it to 15. Both command tables gain the row in the same commit — `| `genie wish` |` in README's table and `| `wish` |` in CLAUDE.md's — because `scripts/release-docs.test.ts:945-948` matches `^| `genie ([a-z-]+)` and `^| `([a-z-]+)` and asserts each table element-for-element against the live registry, not only the count at `:943-944`.
4. #2942: `scripts/legacy-skills-catalog.ts --check` (`:186`) runs in CI on a **full** checkout (`fetch-depth: 0`) — the comment at `:16` is exactly why it is not in `bun run check`.
5. Doctor mode drift: `src/genie-commands/doctor-modes.ts` emits one result per drifted entry (`describeEntry` `:529-554`, reached from `checkWorktreeModes` `:561`; repair loop `:635+`) over an uncapped scan — ~10k lines on the dogfood host. Aggregate to one `mode drift` line (`CHECK_NAME` `:481`) naming at most five entries plus a `+<n> more` remainder, with the full list under `--json`.
6. Two skill-intake guards in `scripts/skills-lint.ts`: the 40–90 line house size (`SKILL_MIN_LINES` `:374`, `SKILL_MAX_LINES` `:375`, applied at `:423`) covers every roster skill with waivers named, and a new rule refuses a candidate staged under `<GENIE_HOME>/skills`.

**Acceptance Criteria:**
- [ ] The `PARITY_CHECK` string, run verbatim, terminates and prints an `OK` line; the parity test pins the new form.
- [ ] `bun run skills:lint` fails on a skill whose prose names a product runtime or a genie-repo-only command, and passes on all six edited front doors; it also refuses a `SKILL.md` staged under `<GENIE_HOME>/skills`.
- [ ] `genie wish lint` run from a tmp repository that is not genie, carrying one valid and one malformed WISH.md, exits 1 and names the malformed file; with only valid wishes it exits 0 and writes nothing. A built-bundle test proves no foreign entry block runs, and both doc counts read 17 / `Seventeen` in this group's tree.
- [ ] A CI job runs `legacy-skills-catalog.ts --check` on a full clone and fails on a seeded stale catalog. On a host with >100 drifted worktree entries `genie doctor` prints one `mode drift` line with `--json` carrying every entry.

**Validation:** `umask 022 && bun run check:fast && bun run build && bun test src/term-commands/wish.test.ts src/genie-commands/doctor-modes.test.ts $(ls scripts/*-workflow-parity.test.ts) scripts/release-docs.test.ts`

**depends-on:** none

### Group 8: Docs and README tell the v6 story

**Deliverables:**
1. `README.md` rewritten around four things: the Orca happy path (explicit authority, closed one-way adapter, no fallback database), the saved-workflow catalog, `genie mikro` (repo-first agents behind a trusted ref), and the skills.sh channel with signed delivery evidence. Omni, the Genie UI and the MCP server shrink to one historical paragraph each.
2. `docs/` (the `.docs-vendor/genie` submodule): operator pages follow the same story, the Omni pages #3004 left behind are removed, and the `_internal` release runbook keeps Group 2's Recovery rewrite. Separate PR in `automagik-dev/docs`, then `git submodule update --remote .docs-vendor` and the pointer commit here; Linux and macOS named as the supported stable platforms in README and `docs/installation.mdx` (D-D).

**Acceptance Criteria:**
- [ ] `grep -rni 'omni\|ui-bridge\|mcp server' README.md docs/` returns only sentences marked as retired history.
- [ ] `bun test scripts/release-docs.test.ts` passes with the post-Group-6/7 command count; the docs PR is merged, `.docs-vendor` points at a commit on the docs default branch, and `docs-lint.yml` is green with `submodules: recursive`.

**Validation:** `umask 022 && bun run check:fast && bun test scripts/release-docs.test.ts src/__tests__/claude-md-drift.test.ts`

**depends-on:** Group 3, Group 4, Group 6, Group 7

### Group 9: Adopt the `orca-plugin-genie` PR (D-B)

**Goal:** Review and adopt the Orca-plugin work authored elsewhere, so `plugins/genie` stops being one palette entry that prints the Run list.

That work has **its own wish** (`.genie/wishes/orca-plugin-genie`), its own plan review, and its own branch `namastex888/orca-plugin-genie` in an Orca worktree: RF1/RF2/RF3/RF6 executed, RF4/RF5 designed only, eight palette verbs. This group does not author it and **does not gate Group 1 or Group 8** (Decision 11). Measured at `68e3431c7`: that branch is **not pushed to origin** as of `68e3431c7` and the wish document is not yet in the repository, so the adoption subject is still in flight.

**Deliverables:**
1. Independent review of the incoming PR at its exact SHA against its own wish's acceptance criteria — not a re-plan — and a `## Review Results` entry recording whether it was adopted, or that v6 shipped without it.
2. Confirm the two claims this design depends on: `plugins/genie/orca-plugin.json` stops contributing only `genie.orca.run-list` (`:21-22`), and its top-level `"capabilities": []` (`:26`) is widened to exactly the grants the handlers use. `engines.orca` is **floor-bumped** from `>=1.4.192` (`:14`) to `>=1.4.205`, the probed version (CLI 1.4.205, schema v1, 234 commands) — a floor, never a pin.
3. Confirm the manifest and marketplace description no longer say "Genie workflows backed by Orca" — a category genie invented; Orca has no "workflow" concept in 234 commands — and that `scripts/orca-manifest-parity.test.ts` still asserts the symlink-free, ≤2000-file, ≤50 MB tree and the three version files, while `scripts/orca-bundle-parity.test.ts`'s command-set assertion moved to the new exact set.

**Acceptance Criteria:**
- [ ] The incoming PR carries an independent review verdict at its exact SHA, and this wish's Review Results records adopt-or-not with that SHA.
- [ ] If adopted: `bun run lint:orca-bundle` and both parity tests are green on the merged tree, and `engines.orca` reads `>=1.4.205` with no `capabilities` grant the handlers do not use. If not adopted by the time Group 1 is ready, the cut proceeds and the Review Results says so in one line.

**Validation:** `umask 022 && bun run check:fast && bun run lint:orca-bundle && bun test scripts/orca-manifest-parity.test.ts scripts/orca-bundle-parity.test.ts src/lib/orca-orchestration-adapter.test.ts`

**depends-on:** none

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] On the dogfood host after `genie update --dev`: `genie --help` lists the post-cut command set, `genie doctor` prints one `mode drift` line, and no `integrations: ` or `omni` line appears in the transcript. In an orca-mode repo a real commit is warning-free, `genie task create` exits 2 with the remedy, `genie task sync` exits 0 silently, and `genie context --wish <slug> --plan` answers. From a repository that is not genie, `genie wish lint` reports on that repository's own wishes.
- [ ] After the promotion merge the next dev release tags `v6.<date>.1` and publishes a Release; `genie update` from the last `5.x` stable to it prints `"outcome":"committed"`; a `genie.db` carrying `hire_roster` rows from a `5.x` install opens under the new binary, migrates to `user_version = 2`, loses the table, and its board is otherwise byte-identical.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A dev release fires between the Group 1 merge and the promotion, minting a `5.x` tag under a 6-major guard on dev | High | Decision 2 (Group 2 lands first); Group 1 merges alone and the promotion PR opens immediately |
| The promotion PR stays `BLOCKED`: the `main` ruleset wants an approval, a last-push approval and an extra approval for unattributed changes, and dev's tip is a bot-authored `[auto-version]` commit | High | Group 2 deliverable 3 names who approves and asserts `reviewDecision` `APPROVED`, not just a green rollup; measured on #2935 today |
| Bumping `CURRENT_SCHEMA_VERSION` without teaching `sqlite-open.ts` to migrate bricks every operator database (`initOrValidate` `:588-604` throws on an unrecognized version) | High | Decision 4 names the module; Group 6's migration test is watched failing against a bump-only change first |
| Group 5 reverses a merged decision (#2830) and a later reader restores the identical-degrade rule | High | Decision 7 plus the comment in the split `context.test.ts` case; the reversal is never implicit |
| The Orca plugin API is documented by Orca's issue tracker and a third-party reconstruction, not a public doc site; `pluginApi: 1` may change under us | High | Group 9 floor-bumps `engines.orca` to `>=1.4.205` (a floor, never a pin) and keeps `orca-manifest-parity.test.ts` asserting the manifest's exact shape, so drift is a red test rather than a silently dead plugin; only contribution points an `stablyai/orca` issue corroborates are used |
| The first `6.x` tag orphans and cannot be re-run | Medium | Group 2 lands first (#2923, #2924, rehearsal) |
| Groups 3 and 4 are verification-only and a reviewer re-does merged work, or an empty residual reads as an unfinished group | Medium | Decision 6: each group names its merged PR and its residual, and closes by verification with the enumeration recorded in Review Results |
| Group 9's subject moves under us — its wish is not yet in the repository and its branch is not pushed to origin as of `68e3431c7` | Medium | Decision 11: adoption, not authorship; it gates nothing and the cut proceeds without it |
| Groups 6 and 7 both change `genie --help` and `release-docs.test.ts` only knows the words 14–17 (`:938-944`) | Low | The merge order 2, 4, 3, 5, 7, 6, 9, 8, 1 pins the arithmetic: Group 7 adds `wish` (16 → **17 / `Seventeen`**), Group 6 then drops the two stubs (→ **15 / `Fifteen`**, the final registry). Each group moves both doc counts in its own commit |
| Deleting `legacy-integration-retirement.ts` strands a host that never updated inside the window | Low | A retired surface classifies `absent`; the published compat window (`>= 5.260711.6`) has passed and the manual steps are documented |

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

## Files to Create/Modify

```
G0 .genie/brainstorms/genie-v6-corpo-leve/{DESIGN.md,COUNCIL.md,orca-integration-research.md} — a directory copy landed with this wish; COUNCIL.md comes from `git show origin/v6/corpo-leve:.genie/brainstorms/genie-v6-corpo-leve/COUNCIL.md`
G1 scripts/{version.ts,release-guard.sh,release-guard.test.ts,version-ci-staging.test.ts} .github/workflows/version.yml
G2 .github/workflows/{release-orphan-alert,version}.yml · docs/_internal/runbooks/release-pipeline.md (automagik-dev/docs)
G3 README.md CLAUDE.md (verification: .github/workflows/ci.yml, src/lib/orca-orchestration-adapter.test.ts)
G4 none (verification only; docs pages in G8)
G5 src/genie.ts src/lib/orchestration-mode.ts(+test) src/lib/v5/authority-barriers.test.ts src/term-commands/{v5-task,v5-board,context}.ts(+tests) README.md CLAUDE.md
G6 src/term-commands/{mcp,ui-bridge}.ts(+tests) src/genie.ts src/genie-commands/doctor.ts src/lib/v5/{sqlite-open,genie-db,task-state,roadmap-sync}.ts(+tests) src/lib/v5/TAXONOMY.md .genie/roadmap.json .genie/INDEX.md src/lib/legacy-integration-retirement.ts(+test) skills/quick/ skills/{README.md,genie/SKILL.md,wish/SKILL.md} scripts/{skills-lint.ts,release-docs.test.ts,wish-workflow-parity.test.ts} .claude/workflows/wish.js README.md CLAUDE.md
G7 src/term-commands/wish.ts(+test) src/genie.ts scripts/{wishes-lint.ts,skills-lint.ts(+test),skill-audit-workflow-parity.test.ts} .claude/workflows/skill-audit-sweep.js skills/{council,workfly,docs,research,skill-audit,wish}/SKILL.md src/genie-commands/doctor-modes.ts(+test) .github/workflows/ci.yml README.md CLAUDE.md
G8 README.md CLAUDE.md .docs-vendor (pointer) docs/*.mdx (automagik-dev/docs)
G9 review only; if adopted, plugins/genie/** orca-marketplace.json scripts/{orca-manifest-parity,orca-bundle-parity}.test.ts arrive with that PR
```
