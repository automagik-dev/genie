# Wish: Cut the first stable v6

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `v6-stable-cut` |
| **Date** | 2026-09-19 |
| **Author** | Felipe Rosa |
| **Appetite** | large |
| **Branch** | `wish/v6-stable-cut` (one branch per group: `wish/v6-stable-cut-g<n>`) |
| **Repos touched** | automagik-dev/genie, automagik-dev/docs (submodule bump) |
| **Design** | [genie-v6-corpo-leve rev. 4](../../brainstorms/genie-v6-corpo-leve/DESIGN.md) |

## Summary

`.genie/INDEX.md:9,28` already claims the number: the open dev→main promotion PR [#2935](https://github.com/automagik-dev/genie/pull/2935) is "the v6 stable cut". Nothing in the repository makes it true — `scripts/version.ts:42,63`, `scripts/release-guard.sh:40,41` and `.github/workflows/version.yml:114,322,328` all hardcode the `5.` major — and #2935 is `BLOCKED` solely on `reviewDecision: ""`, behind a `main` ruleset that wants an approval, a last-push approval and an extra approval for unattributed changes, which its bot-authored `[auto-version]` tip is. This wish moves the major, repairs the pipeline that carries it, discharges the debt a major exists to discharge, fixes the known-broken surfaces, and rewrites the story to match the product. Every line number is derived at **dev at `94adc6e96`** (the merge of #3005).

## Scope

### IN

- The `5.` → `6.` major in all three authorities plus their `Format:` comments, landed as the last dev change before promotion.
- Release-pipeline work that must exist **before** the first `6.x` tag: the promotion PR's approval path, #2923 (adopt), #2924, one dry rehearsal on a replica HOME.
- Verification of the three behaviours that merged while this design was in review — the darwin gate (#3003), Omni's removal (#3004) and the `PARITY_CHECK` stdin fix (#3005) — plus their named residuals.
- Orca-mode honesty and the board freeze (D-C), including the explicit reversal of #2830.
- Dead surfaces a major may drop: the `mcp` and `ui-bridge` stubs and their registrations, `hire_roster` with a `user_version` 1 → 2 migration written in `sqlite-open.ts`, the `skills/quick` stub, `src/lib/legacy-integration-retirement.ts`.
- Open bugs and guards: #2942's `--check` in CI, #2917 (adopt), doctor's per-entry mode-drift flood, two skill-intake lint guards.
- `genie wish lint` — the wish linter shipped in the binary, as its own group — and README plus `docs/` rewritten to the v6 story, with the `.docs-vendor` submodule initialized and bumped; adoption of the Orca-plugin PR if it lands first.

### OUT

- The `.genie/mode` per-repo marker and `GENIE_MODE` (deferred to v7; the v6 mitigation is detective-on-demand via `genie doctor`, and after G5 the commit path gives the orca-side operator no signal — accepted).
- Removing `plugins/genie`, `plugins/dsh-genie-board`, `orca-marketplace.json` or the `orca-plugin` ref (D-B inverts rev. 3.3 item 6). Permanently out of G9: a second board (Orca's board **is** workspace status), a genie task provider (`TaskProvider` is a closed union, [orca#15328]), a status-bar segment ([orca#19809]) and `contributes.agents` ([orca#13306]); a `contributes.panels` Genie panel is deferred to v7 for want of a placement field ([orca#19809]/[orca#16853]).
- Any new board verb, column or lane beyond the `hire_roster` drop (D-C); any `genie-orca-*` skill tree, `## Dispatch plan` section, provenance block or `validate-wish --mode orca` content rule (rev. 4 revokes them).
- Relocating `scripts/{wishes-lint,validate-wish}.ts` under `src/`, adding lint rules to them, or shipping any `genie wish` verb other than `lint`.
- Deleting an operator's orphaned `~/.genie/genie.db`, authoring the Orca-plugin work (G9 adopts it), and performing the promotion merge or the stable `workflow_dispatch` — owner actions this wish prepares.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | The major moves in exactly three authorities; `scripts/version.ts` is the local `npm run version` path only (`package.json:13`) | `version.yml:114` (`prefix=5`, used at `:173-183`) and `:322,328` are independent inline generators |
| 2 | The bump takes effect only when **main** carries it, so it is the last dev change before promotion and no dev release fires in between; Group 2 lands before Group 1 | `release-guard.sh` loads from the control ref (main), not `source_sha` (`release.yml:91`); `version.yml` runs from main. A 6-major on dev under a 5-major main mints a tag dev's own `release-guard.test.ts` rejects. An orphaned first-of-major tag cannot be re-run (#2924) |
| 3 | The first `6.x` tag is the first dev release after promotion; the first `6.x` stable is `release.yml` `workflow_dispatch` `channel=stable` on that version | `release.yml:18,22`; `release-guard.sh:97,106` require a human dispatch for stable, and the else branch at `:111` rejects a human dev dispatch |
| 4 | `hire_roster` is dropped through a **migration ladder on the shared open primitive**: `CURRENT_SCHEMA_VERSION` 1 → 2 (`src/lib/v5/genie-db.ts:43`) plus `OpenSqliteOptions.migrations` applied inside `initOrValidate` (`src/lib/v5/sqlite-open.ts:588-604`) when `version < schemaVersion` | `initOrValidate:604` throws `ForeignDbError(… 'unrecognized schema version')` for any stamped version that is neither `schemaVersion` nor `0`, so a bump alone makes **every operator database refuse to open**. Since #3004 deleted `global-db.ts`, `openSqlite` has exactly **one non-test caller** (`genie-db.ts:468`) — the blast radius is small, but the change is still to a shared primitive's contract, so the ladder is declared on the options type rather than special-cased in the caller |
| 5 | `legacy-integration-retirement.ts` is deleted now | Its window comment (`:1388`) is two stable releases after `skills-everywhere-b` (SHIPPED 2026-08-31, `0efc288b5`); three followed — `v5.260901.4`, `v5.260916.4`, `v5.260916.6` |
| 6 | Groups 3 and 4 are **verification-only**, and three sub-items elsewhere are **adopt-only** | #3003, #3004 and #3005 merged while this design was in review. #2923 is running by hand on branch `wish/release-orphan-alert-autoclose` — `wish.js` refuses `.github/` changes by policy, so it could not be delivered through the workflow — and #2917 is running as the `front-doors-runtime-neutral` wish. Each is reviewed and adopted here, not re-authored |
| 7 | Group 5 reverses PR [#2830](https://github.com/automagik-dev/genie/pull/2830)'s "every form of `genie context` degrades identically", by explicit owner decision 2026-09-19 | `wish.js` refused this change at admission (`route=brainstorm`) precisely because it reverses a merged decision. The owner has decided: the board is frozen and orca mode is honest. The reversal is recorded in the code comment (`context.ts:419-423`), in the split test and here — never implicitly |
| 8 | Orca refusals exit **2**, not 1 | 2 is already genie's "operator must act" family — the v4 workspace gate and `mikro call`'s usage refusals both use it — while 1 stays "the command failed". The one fixed message, naming `orca` and `genie setup --orchestration-mode standalone`, is what disambiguates inside the family |
| 9 | `genie wish lint` is **its own group (G10)** and wraps `scripts/wishes-lint.ts` imported in place, the `genie mikro` pattern | `skills/wish/SKILL.md:75,78` tells every repository to run a linter only this repository ships. The script has **no `import.meta.main` guard** — bare `main()` at `:474`, `process.exit` inside it, and `ROOT`/`DEFAULT_WISHES_DIR` derived from `import.meta.url` at `:19-20`, which resolves under `/$bunfs` in a compiled binary — so this is real work, not a registration, and it does not belong inside the bug-fix group |
| 10 | Removing a retired verb is permitted at a major; `genie doctor` keeps observing the old host routes | A verb that still parses is a promise; the route observers are about host state, not the verb |
| 11 | Group 9 **adopts** the Orca-plugin PR; it gates nothing | That work has its own wish (`.genie/wishes/orca-plugin-genie`), its own plan review and its own branch. If it lands first the cut adopts it; if not, v6 ships without it |

## Simplicity Case

- **Simplest complete design:** one literal in three files, three pipeline items, three verifications, two adoptions, five deletions, four bug fixes, three lint/CLI additions, one docs pass. No new subsystem.
- **Added machinery:** two — the `migrations` ladder on `OpenSqliteOptions` (Decision 4) and one commander group, `genie wish lint`, over code that already exists (Decision 9).
- **Deferred until measured:** `.genie/mode` + `GENIE_MODE`; collapsing skills.sh and the Orca plugin; any wish-document validator beyond the structural one; any other `genie wish` verb. **Complexity removed:** one global SQLite database, one daemon, one transport dependency, two registered stubs, one board table, one retired skill stub, one time-boxed retirement module, ~10k lines of doctor output per run.

## Dependencies

**depends-on:** none
**blocks:** none

PR #3002 (`accept superseded as a canonical terminal wish status`) is **merged**: `SUPERSEDED` is canonical in `scripts/wishes-lint.ts:32`, so nothing in this wish's status vocabulary is in flight.

## Success Criteria

- [ ] `genie --version` on the first stable release prints `6.YYMMDD.N`; `git tag --list 'v6.*'` is non-empty; no `v5.*` tag is created after the promotion merge.
- [ ] The first `6.x` tag has a Release object, no open `release-incident` issue names it, and the darwin leg (#3003, `ci.yml:138-140,265`) ran on the promotion commit.
- [ ] `genie --help` lists **15** commands — neither `mcp` nor `ui-bridge`, and `wish` present; `grep -rn 'hire_roster' src scripts .genie/roadmap.json .genie/INDEX.md src/lib/v5/TAXONOMY.md` is empty; `skills/quick/` and `src/lib/legacy-integration-retirement.ts` are absent; a grep for `omni|nats` in `src/` and `package.json` returns only the enumerated historical references.
- [ ] In orca mode a real `git commit` prints no `board snapshot not refreshed` warning, `genie task create` exits 2, `genie task sync` exits 0 with empty output, and `genie context --wish <slug> --plan` prints its payload and exits 0.
- [ ] `genie wish lint` runs from a non-genie repository over its `.genie/wishes`, exits 0 or 1 on structure alone, and does not trip the workspace gate.
- [ ] README and `docs/` name Omni, the Genie UI and the MCP server only as retired history, and say stable means Linux and macOS.
- [ ] If G9 is adopted: in a live Orca the palette shows the genie verbs in a worktree context, and a wish moving to review flips that workspace's status to `in-review` with the verdict as its card comment.
- [ ] `bun run check` green on the promotion commit with this wish and the rev. 4 design in the corpus.

## Execution Strategy

| Wave | Group | Agent | Complexity | Model | Description |
|------|-------|-------|------------|-------|-------------|
| 0 | 0 | engineer | Low: documents only, already open as #3006 | sonnet | Land the rev. 4 design and this wish |
| 1 | 2 | engineer | High: branch-protection and release-workflow work whose failure mode is an unrecoverable release | opus | Release pipeline: approvals, #2923 (adopt), #2924, rehearsal |
| 1 | 3 | engineer | Low: verification of merged #3003 plus one sentence | sonnet | Darwin gate — verify and close the residual |
| 1 | 4 | engineer | Low: verification of merged #3004; no in-repo residual | sonnet | Omni out — verify and close |
| 1 | 5 | engineer | High: reverses a merged decision; adds a second `preAction`; touches a git hook and the context verb | opus | Orca honesty + board freeze (D-C) |
| 1 | 7 | engineer | High: four independent concerns plus a new lint rule with a waiver path | opus | Open bugs and intake guards |
| — | 9 | engineer | Medium: review and adopt work planned and executed elsewhere | opus | Adopt the `orca-plugin-genie` PR — runs whenever its subject lands; merge slot 9; gates nothing |
| 2 | 10 | engineer | Medium: an entry-point refactor of a script that has no guard today | opus | `genie wish lint` |
| 3 | 6 | engineer | High: a destructive migration on a shared primitive, plus four shared files | opus | Stubs and dead surfaces at a major |
| 4 | 8 | engineer | Medium: two repositories, a submodule init and a pointer bump | opus | Docs and README rewritten to the v6 story |
| 5 | 1 | engineer | High: three release authorities plus the test files carrying the literal | opus | Version major 6 — the last dev change before promotion |

**Merge order: 0, 2, 4, 3, 5, 7, 10, 6, 9, 8, 1.**

**Global constraints:**
- Never push to `dev` or `main`, never force, never merge, never bypass a hook; every PR targets `dev`. Wave-1 groups run in parallel in isolated worktrees.
- No dev release may fire between the Group 1 merge and the promotion merge; the promotion PR opens immediately after Group 1 merges. `origin/dev` already advanced past `94adc6e96` while this plan was written — that drift is the live form of the first risk below.
- **Shared source files across parallel groups** — a group that touches one of these rebases its branch over the earlier group's branch before its PR leaves draft, in merge order: `src/genie.ts` (G5, G6, G10), `src/lib/interactivity.ts` + its test (G10 creates both; G6 removes the dead `'mcp'`/`'ui-bridge'` entries), `scripts/skills-lint.ts` (G6, G7), `scripts/release-docs.test.ts` (G6, G7), `src/term-commands/v5-task.ts` + its test (G5 owns the file; G6 strips `hire_roster` from `:667,716,780` and 17 test assertions), `skills/wish/SKILL.md` (G6 d.3 removes the `quick` sentence, G10 d.4 rewrites the linter step), `README.md` (G3, G6, G10, G8), `CLAUDE.md` (G3, G5, G6, G10, G8). Group 7 touches neither README nor CLAUDE.md — its one documentation line, the doctor mode-drift aggregation gotcha, belongs to Group 8.
- The board is frozen (D-C): no new verb, lane or column; the `hire_roster` drop in Group 6 is the only schema change permitted. `plugins/genie`, `plugins/dsh-genie-board`, `orca-marketplace.json` and `orca-plugin-ref.yml` are not deleted (D-B); the three version files stay three. `INSTALL_PAYLOAD_MEMBERS` stays the frozen 8; `state-backups/` roots written by an earlier run are never removed; doctor is read-only including under `--fix`; genie creates no product home.
- `src/` style: `.js` import specifiers, no `console.log`, cognitive complexity ceiling 25, Biome single quotes / 2 spaces / 120 columns; tests colocated, `bun:test`, tmpdir fixtures, real git repositories, `GENIE_HOME` isolated to a tmpdir. `scripts/{mikro,wishes-lint,validate-wish}` files are not relocated and complexity-budget ceilings are not raised.
- A group that edits CLAUDE.md runs `src/__tests__/claude-md-drift.test.ts`. The command count is **per tree** under the merge order: the live registry is 16, G10 adds the new `wish` group (**17 / `Seventeen`**), G6 then drops `mcp` and `ui-bridge` (**15 / `Fifteen`**, the final registry). `scripts/release-docs.test.ts:938-944` asserts the exact `<n> CLI commands` string in README and `<word> top-level commands` in CLAUDE.md, and `:947-948` asserts both **command tables** equal the live registry element-for-element — so a group that changes the registry edits the counts *and* the table rows.
- This host: `umask 022` before any gate; never run the full `bun test` concurrently with another agent.

## Execution Groups

### Group 0: Land the design and this wish

**Goal:** The rev. 4 design and this wish are in the repository before any group cites them.

**Deliverables:**
1. `.genie/brainstorms/genie-v6-corpo-leve/` lands as a directory copy — `DESIGN.md` (rev. 4, SHIP-stamped), `COUNCIL.md`, `DRAFT.md`, `council/`, `reviews/`, `orca-integration-research.md` — together with `.genie/wishes/v6-stable-cut/WISH.md`. Open as **PR [#3006](https://github.com/automagik-dev/genie/pull/3006)**.
2. `.genie/INDEX.md` gains the Poured entry pointing at both.

**Interfaces:** Consumes: none. Produces: the paths every other group's `Design` cell and citations resolve against.

**Acceptance Criteria:**
- [ ] `bun run wishes:lint` is green on the branch — with the design stamped, zero findings — and PR #3006's checks are green and it is merged before any Wave-1 PR opens.

**Validation:** `umask 022 && bun run wishes:lint && bun run skills:lint && bun run check:fast`

**depends-on:** none

### Group 1: Version major 6

**Goal:** The next release after the promotion is `6.YYMMDD.N`, and nothing in the pipeline disagrees.

**Deliverables:**
1. `scripts/version.ts`: tag glob (`:42`), generated string (`:63`), `Format:` comment (`:5`) → `6.`.
2. `scripts/release-guard.sh`: `VERSION_RE` (`:40`), `TAG_REF_RE` (`:41`), the `date_part` strip and the scheme comment (`:37`) → `6.`; the historical incident note keeps its `v5.` citation.
3. `.github/workflows/version.yml`: `prefix=6` (`:114`), the promotion-tag glob and generator (`:322`, `:328`), the comment (`:111`) → `6.`. Every test pinning the scheme rather than a fixture literal follows — `scripts/release-guard.test.ts` and `scripts/version-ci-staging.test.ts` are the known two; `bun run check` names any others. The PR body states the sequencing: merge alone, then open the promotion PR. **Corrected 2026-09-19 (G1 review, H1):** "let no dev release fire in between" was a false mechanism. Generator and guard both load from **main** — `release.yml:91-93` checks out the control ref for the guard, and `workflow_run` always executes the default-branch copy of `version.yml` — so they move together and can never disagree, and `scripts/version.ts` is the local `npm run version` path the pipeline never reads. Merging G1 therefore *does* fire `version.yml` on the merge commit (its `if` skips only `[auto-version]`/`[release-manifest]` tips, `version.yml:75-76`) and mints one final, **valid** `5.x` dev release. The real hazard is the dev tip that push moves: under main's `require_last_push_approval` + `dismiss_stale_reviews_on_push` it dismisses the promotion PR's approval. **ACCEPTED:** the merge of G1 triggers the last `5.x` dev release; #2935 is approved only after that release's `[auto-version]` tip is dev's head, with no queued Version run. Then dispatch `release.yml` `channel=stable` on the first `6.x` version.

**Interfaces:** Consumes: Group 2's merged approval path and recovery contract. Produces: the version scheme itself; no code interface.

**Acceptance Criteria:**
- [ ] `grep -rn '5\.' scripts/version.ts scripts/release-guard.sh .github/workflows/version.yml` returns **five** lines, all prose, and no executable line: the two `5.→6.` transition notes (`version.ts`, `release-guard.sh`), the `release-guard.sh` note recording that merging G1 triggers one final valid `5.x` dev release, and the two historical incident notes (`release-guard.sh`, the 2026-09-18 orphan tag; `version.yml:221`, the 2026-07-20 Quality Gate break). Line numbers are not pinned — the roles are. `generateVersion()` on a clone with no `v6.*` tags returns `6.<today>.1`.
- [ ] The drift guard in `scripts/release-guard.test.ts` asserts all **nine** hardcoding sites across the three authorities carry one shared major and that it is `6`, and fails loudly if a site is renamed away rather than passing vacuously.
- [ ] `bun run check` green (`release-guard`, `version-ci-staging`, `version-format` included), the PR body carries the sequencing paragraph, and the PR is the only unmerged dev change when it merges.

**Validation:** `umask 022 && bun run check:fast && bun test scripts/release-guard.test.ts scripts/version-ci-staging.test.ts scripts/version-format.test.ts scripts/release-docs.test.ts`

**depends-on:** Group 2

### Group 2: Release pipeline fit to carry a first-of-major tag

**Goal:** The promotion PR can actually merge, and a first `6.x` tag that stalls is recoverable and visible.

**Deliverables:**
1. **The approval path — the real work.** #2935 is `BLOCKED` *only* because `reviewDecision` is `""`: the required `Quality Gate (typecheck + lint + test)` context already reads SUCCESS on it, because `version.yml:295` dispatches `gh workflow run ci.yml --ref v${VERSION}` and `ci.yml:3-12` carries the `workflow_dispatch` trigger for exactly that. The `main` ruleset needs `required_approving_review_count: 1` **plus** `require_extra_approval_for_unattributed_changes: true` — so a bot-authored `[auto-version]` tip may need **two** approvals — with `require_last_push_approval: true`, `dismiss_stale_reviews_on_push: true`, `required_review_thread_resolution: true` and `allowed_merge_methods: ["merge"]`. The PR body names **who** approves (humans with write access who are not the bot author) and records that the last-push approval must post-date the final push of any kind, since any later push dismisses it.
2. **#2923 — adopt.** The orphan-alert autoclose plus promotion-tag skip is open as **PR #3007** (`fix(release-orphan-alert): auto-close healed incidents and skip promotion tags`, branch `wish/release-orphan-alert-autoclose`, head `412c724fd`), authored by hand because `wish.js` refuses `.github/` changes by policy. Review it at `412c724fd` and adopt; if it has not landed, do the work here under the same policy caveat.
3. **#2924.** The Recovery section of `genie/_internal/runbooks/release-pipeline.md` (in `automagik-dev/docs`) is rewritten — a dev orphan recovers by landing any commit on dev through a PR, a stable orphan by the stable re-dispatch; the tag stays and the incident closes as superseded. No `workflow_call`-only workflow is named. Run `git submodule update --init --recursive .docs-vendor` first: `docs/` is a dangling symlink here and `git submodule status` reports `.docs-vendor` uninitialized (`-41eb2dd…`). The edit goes to `automagik-dev/docs` as its own PR plus a submodule bump, per CLAUDE.md's Docs section.
4. **Verify, do not build:** one dry rehearsal on a replica HOME (tag → release → update hop) recorded in the PR body with its `"outcome":"committed"` line, and a recorded confirmation that the dispatched CI checks attach to the promotion head.

**Rollback** (added 2026-09-19, G1 review M2 — the contract for a first `6.x` that ships broken):

- **(a) Fix forward is the default.** Land the repair on dev and let the next release allocate `6.<next>.N`. Versions only ever increase; a burned build number is never reused and a pre-fanout failure is never re-dispatched (#2674).
- **(b) The 5-minute rollback is a hand PR to `main` reverting `.well-known/latest.json` to the last good `5.x`.** `install.sh` reads the channel manifest from **main** on both paths — the raw CDN at `raw.githubusercontent.com/<repo>/main/.well-known` (`install.sh:24`, ~5-minute cache) and the credential-free contents API pinned `?ref=main` (`install.sh:33,435-439`) — so reverting that one file on main is what actually moves installers, and it takes effect within the CDN window. `scripts/reconcile-channel-manifests.sh` is the *producer* side and is **not** in the read path: do not try to roll back through it. The bad release's tag, Release object and assets all stay; only the channel pointer moves.
- **(c) Reverting the promotion merge on `main` restores the generator and the guard together**, because both load from main — `version.yml` via `workflow_run`'s default-branch copy, `release-guard.sh` via `release.yml:91-93`'s control-ref checkout. There is no window in which one is `6.` and the other `5.`.
- **What is NOT available:** re-dispatching `release.yml` `channel=stable` on a `5.x` version after the promotion. Once main carries the `6.` guard, `VERSION_RE` rejects a `5.` input and `guard-trusted-release` exits **3**. That is by design — the stable channel is rolled back by (b), not by re-releasing a retired major.

**Interfaces:** Consumes: none. Produces: the recovery contract Group 1's PR body cites, the rollback contract above, and the named approver set.

**Acceptance Criteria:**
- [ ] On #2935 (or its successor), `gh pr view <n> --json reviewDecision,mergeStateStatus` reads `APPROVED` and no longer `BLOCKED`, with the approving reviews post-dating the final push. A green rollup with an empty `reviewDecision` is explicitly **not** sufficient.
- [ ] The #2923 change is merged (adopted or authored here) and a recorded cron fire closes an open `release-incident` once its Release appears, skipping promotion tags during the publish lag.
- [ ] `.docs-vendor` is initialized, the runbook's Recovery section names no `workflow_call`-only workflow, the docs PR plus submodule bump are open or merged, and the rehearsal transcript prints `"outcome":"committed"`.

**Validation:** `umask 022 && bun run check:fast && bun test scripts/release-guard.test.ts scripts/release-replay-guard.test.ts`

**depends-on:** Group 0

### Group 3: Darwin gate — verify and close the residual

**Goal:** Confirm #3003 did what D-D requires, and close the one thing it left.

**Deliverables:**
1. Verification only: `.github/workflows/ci.yml:138-140` runs `unit-darwin` on `macos-latest`, it is required at `:265` and read at `:274`, and `:129` states the policy. The five darwin-sensitive tests named in the issue verification are re-checked; anything still asserting a linux literal is reported, not silently patched.
2. The residual: one sentence in `README.md` and `CLAUDE.md` stating that stable is declared for **Linux and macOS** (today's only macOS mentions are incidental, `README.md:229-230`).

**Interfaces:** Consumes: none. Produces: the required check name the promotion depends on.

**Acceptance Criteria:**
- [ ] The darwin leg ran and passed on this group's own PR and appears in its check rollup; README and CLAUDE.md carry the platform sentence; `git grep -n "linux"` over the `src/` and `scripts/` tests names no remaining hardcoded platform literal, or each survivor is listed in the PR body with its reason.

**Validation:** `umask 022 && bun run check:fast && bun test src/lib/orca-orchestration-adapter.test.ts src/__tests__/claude-md-drift.test.ts scripts/release-docs.test.ts`

**depends-on:** Group 0

### Group 4: Omni out — verify and close

**Goal:** Confirm #3004 removed Omni entirely. **There is no in-repo residual**; the public `docs/` pages belong to Group 8.

**Deliverables:**
1. Verification only — if the enumeration turns up a live reference it becomes a one-commit repair here, and the finding is recorded in this wish's `## Review Results`. `package.json` carries no `nats` dependency; `src/lib/omni-*.ts`, `src/lib/v5/{global-db,omni-queue}.ts`, `src/term-commands/omni.ts` and `skills/omni/` are absent; the registry is 16 commands; the doctor omni checks and block 9b of `tests/e2e/v5-lifecycle.sh` are gone. Surviving mentions are enumerated and confirmed historical — **10 files**: `skills/NOTICE`, `src/lib/{legacy-skills-catalog,genie-home}.ts`, `src/lib/genie-home-permissions.test.ts`, `src/genie-commands/{doctor,legacy-v4}.ts`, `src/lib/v5/{TAXONOMY.md,genie-db.ts,sqlite-open.ts}`, `tests/e2e/v5-lifecycle.sh` (the two `genie-home` hits are capitalized `Omni` in prose at `genie-home.ts:21` and `genie-home-permissions.test.ts:131`, explaining why v6 opens no machine-scope database).

**Interfaces:** Consumes: none. Produces: the enumeration Group 8 cites when it rewrites the docs.

**Acceptance Criteria:**
- [ ] `grep -rni 'omni\|nats' src scripts package.json skills tests` returns exactly the 10 enumerated historical files, each named in the PR body; `bun run build` succeeds with no NATS client in the bundle, `bash tests/e2e/v5-lifecycle.sh` is green, and `genie doctor --json` reports no omni check.

**Validation:** `umask 022 && bun run check:fast && bun run build && bun test src/genie-commands/doctor.test.ts scripts/release-docs.test.ts`

**depends-on:** Group 0

### Group 5: Orca honesty and the board freeze (D-C)

**Goal:** Orca mode refuses what it forbids with an operator-actionable exit code, stops warning on every commit, and still answers the one read-only question the wave base needs.

This group **reverses** PR #2830's "every form of `genie context` degrades identically" by explicit owner decision, 2026-09-19 (Decision 7). The reversal is recorded in the code comment, in the split test, and here.

**Deliverables:**
1. `ORCA_FORBIDDEN` exported from `src/lib/orchestration-mode.ts` as a closed set: `task` (every subverb **except** `sync`), `board`, `idea`. Nothing else.
2. A **second, non-exempt** commander `preAction` in `src/genie.ts` refusing those verbs before the handler with **exit 2** and one fixed message naming `orca` and the remedy `genie setup --orchestration-mode standalone` (Decision 8). `installWorkspaceCheck`'s hook cannot carry it: `WORKSPACE_EXEMPT` (`src/lib/interactivity.ts:42-94`, consulted by `commandRequiresWorkspace` at `:113` and short-circuited at `:173`) exempts exactly these verbs.
3. `genie task sync` exits **0, silent** in orca mode, with the check placed **before** the `hasGenieWorkspace()` guard in `handleSync` (`src/term-commands/v5-task.ts:727`), so `.husky/pre-commit` stops printing `board snapshot not refreshed` on every commit.
4. `genie context --wish <slug> --plan` answers read-only in orca mode with no `writeWishBase` path reachable; every other form keeps refusing (`context.ts:424`, comment `:419-423`). `src/term-commands/context.test.ts:567`'s four-form `test.each` is **split, not deleted** — three forms still assert refusal, `--plan` asserts the answer — with a comment recording the #2830 reversal. `src/lib/v5/authority-barriers.test.ts` and `src/term-commands/v5-board.test.ts` orca assertions are **amended to exit 2**, not removed.
5. The freeze restated in CLAUDE.md and README (no new verb, lane or column), plus a test pinning `ORCA_FORBIDDEN` so a verb cannot join or leave it silently.

**Interfaces:**
- Consumes: `LOCAL_LIFECYCLE_DISABLED_CODE` (`src/lib/orchestration-mode.ts:7`), `LocalLifecycleDisabledError` (`:28`), `assertLocalLifecycleEnabled` (`:57`).
- Produces: `export const ORCA_FORBIDDEN: ReadonlySet<string>`; `export function orcaRefusalPreAction(thisCommand: Command, actionCommand: Command): void`, registered as `program.hook('preAction', orcaRefusalPreAction)` and calling `process.exit(2)` after writing the fixed message to stderr.

**Acceptance Criteria:**
- [ ] In orca mode: `genie task create --title x`, `genie board` and `genie idea x` each exit **2** with the one fixed message naming the remedy; `genie task sync` exits 0 with empty stdout and stderr; `genie context --wish <slug> --plan` exits 0 with its JSON payload.
- [ ] A real `git commit` in an orca-mode repo prints no `board snapshot not refreshed` warning; in standalone mode every one of those verbs behaves byte-identically to today.
- [ ] `context.test.ts`'s split retains all four forms as assertions and carries the #2830 reversal comment; `authority-barriers.test.ts` and `v5-board.test.ts` assert exit 2 rather than dropping their orca cases; the `ORCA_FORBIDDEN` pin test fails when a verb is added or removed.

**Validation:** `umask 022 && bun run check:fast && bun test src/term-commands/v5-task.test.ts src/term-commands/v5-board.test.ts src/term-commands/context.test.ts src/lib/v5/authority-barriers.test.ts src/lib/orchestration-mode.test.ts src/__tests__/claude-md-drift.test.ts`

**depends-on:** Group 0

### Group 6: Stubs and dead surfaces a major may drop

**Goal:** The debt a major exists to discharge is discharged, without stranding a single operator database.

**Deliverables:**
1. Delete `src/term-commands/{mcp,ui-bridge}.ts` and their tests, the imports at `src/genie.ts:37,39` and the registrations at `:258,259`, **and their now-dead `WORKSPACE_EXEMPT` entries** (`src/lib/interactivity.ts:83` `'mcp'`, `:88` `'ui-bridge'`). `genie doctor` keeps observing the old `.mcp.json` and `.codex/config.toml` routes. `README.md:175,177,273-279` and `CLAUDE.md:83,88` lose their rows and prose; because G10 merges first, the counts at `README.md:158` and `CLAUDE.md:72` move from 17/`Seventeen` to **15/`Fifteen`** in this tree, and both command tables lose their two rows (`scripts/release-docs.test.ts:938-944`, `:947-948`).
2. Drop `hire_roster` behind the Decision-4 ladder: `CURRENT_SCHEMA_VERSION` 1 → 2 (`src/lib/v5/genie-db.ts:43`), a `migrations` entry `{from: 1, to: 2}` applied inside `initOrValidate` (`src/lib/v5/sqlite-open.ts:588-604`) when `version < schemaVersion`. Sites: `genie-db.ts:479,657`; `src/term-commands/v5-task.ts:667,716,780` — the declarations are `snapshotCarriesHires` at `:715` and `preserveHireRoster` at `:786` — plus its 17 test assertions — **G5 owns that file, so this group rebases over G5's branch**; `task-state.ts:2097,2114,2120,2128-2129,2152,2195,2238`; `roadmap-sync.ts:140,146,403`; `doctor.ts:284`; `src/lib/v5/TAXONOMY.md:83`; `.genie/INDEX.md:3` (the board-snapshot preamble's "`hire_roster` worktree state stays machine-local" clause); the committed `.genie/roadmap.json` and its golden. `task import` of a snapshot carrying the key ignores it rather than failing.
3. Delete `skills/quick/` and its references: `skills/README.md:80`, `skills/wish/SKILL.md:10`, `scripts/skills-lint.ts:394`, `scripts/release-docs.test.ts:27,1029-1048`, `scripts/wish-workflow-parity.test.ts:134-142`, `.claude/workflows/wish.js:6,58`, `.genie/INDEX.md:28`. `skills/genie/SKILL.md:41` is **not** touched — its "Quick idea" is live routing prose about the word, not a reference to the skill.
4. Delete `src/lib/legacy-integration-retirement.ts` (window comment `:1388`), its tests and call sites; the update transcript loses its `integrations: ` lines and `CLAUDE.md:219` its gotcha. Window evidence in the PR body (Decision 5).

**Interfaces:**
- Consumes: G5's `src/genie.ts` preAction registration and `v5-task.ts`; G7's `scripts/{skills-lint,release-docs.test}.ts`; G10's `src/genie.ts` `wish` registration and doc counts.
- Produces: `OpenSqliteOptions.migrations?: ReadonlyArray<{ from: number; to: number; apply: (db: Database) => void }>` — a ladder applied in ascending `from` order inside `initOrValidate` when `version < schemaVersion`, each step in one transaction, re-stamping `PRAGMA user_version` at the end. **After the ladder runs the database falls through to the current-version branch** — `schemaIsCurrent` then `ensureSchema` — so additive backfills still apply to a just-migrated database exactly as they do to one already at `schemaVersion`. An unbridgeable gap still throws `ForeignDbError`. Plus `CURRENT_SCHEMA_VERSION = 2`.

**Acceptance Criteria:**
- [ ] In **this group's tree** `genie --help` lists **15** commands and neither `mcp` nor `ui-bridge`; `release-docs.test.ts` passes with `Fifteen top-level commands` in CLAUDE.md, `15 CLI commands` in README, and both command tables equal the live registry.
- [ ] A `genie.db` stamped `user_version = 1` and carrying `hire_roster` rows **opens** under the new binary, is migrated to 2, loses the table, and a second open is a no-op — watched failing first against a bump without the ladder. A database stamped at an unbridgeable version still throws `ForeignDbError`.
- [ ] `grep -rn 'hire_roster' src scripts .genie/roadmap.json .genie/INDEX.md src/lib/v5/TAXONOMY.md` is empty (archived wishes and brainstorms legitimately keep the word); `genie task export` no longer carries the key and `task import` of a pre-migration snapshot succeeds.
- [ ] `bun run skills:lint` and `bun run dead-code` pass with `skills/quick/` absent; `genie update` on a replica HOME succeeds with the retirement module gone and prints no `integrations: ` line.

**Validation:** `umask 022 && bun run check:fast && bun test src/lib/v5/genie-db.test.ts src/lib/v5/sqlite-open.test.ts src/lib/v5/task-state.test.ts src/term-commands/v5-task.test.ts src/lib/interactivity.test.ts src/genie-commands/doctor.test.ts scripts/release-docs.test.ts scripts/wish-workflow-parity.test.ts src/__tests__/claude-md-drift.test.ts`

**depends-on:** Group 5, Group 7, Group 10

### Group 7: Open bugs and intake guards

**Goal:** The known-broken things are fixed or adopted, and the lint rules that would have caught two of them exist.

**Deliverables:**
1. **#2919 — verification only.** It shipped as #3005: `.claude/workflows/skill-audit-sweep.js:66` now reads the piped form, `npx -y skills@1.5.23 add "$PWD" --list 2>&1 | bun scripts/skills-inventory-parity.ts --repo .`, so `readListInput()` (`scripts/skills-inventory-parity.ts:519-522`) no longer blocks on `Bun.stdin.stream()`. Confirm and record.
2. **#2917 — adopt.** The runtime-neutral front doors are running as the `front-doors-runtime-neutral` wish: `skills/{council,workfly,docs,research,skill-audit}/SKILL.md:12` and `skill-audit/SKILL.md:46` adopt the neutral form already in `skills/wish/SKILL.md:12`, plus a `BANNED_TOKEN_GUIDANCE`-shaped rule (`scripts/skills-lint.ts:72`, collected at `:114-119`) and its test. The `wish.js` run for `front-doors-runtime-neutral` is in flight with **no branch on origin as of `94adc6e96`**; adopt it at its SHA once it lands, else do the work here. `skills/workfly/SKILL.md:41` — which hands every repository the genie-repo-only `bun test scripts/workflows-meta.test.ts` — is the same defect from the other side and is in scope either way.
3. **#2942:** `scripts/legacy-skills-catalog.ts --check` (`:186`) runs in CI on a **full** checkout (`fetch-depth: 0`) — the comment at `:16` is exactly why it is not in `bun run check`.
4. **Doctor mode drift:** `src/genie-commands/doctor-modes.ts` emits one result per drifted entry (`describeEntry` `:529`, reached from `checkWorktreeModes` `:561`; repair loop `:635`) over an uncapped scan — ~10k lines on the dogfood host. Aggregate to one `mode drift` line (`CHECK_NAME` `:481`) naming at most five entries plus a `+<n> more` remainder, with the full list under `--json`.
5. **Two skill-intake guards** in `scripts/skills-lint.ts`: the 40–90 line house size (`SKILL_MIN_LINES` `:374`, `SKILL_MAX_LINES` `:375`, applied at `:423`) covers every roster skill with waivers named, and a new rule refuses a candidate staged under `<GENIE_HOME>/skills`.

**Interfaces:**
- Consumes: `BANNED_TOKEN_GUIDANCE`, `collectBannedTokenViolations` (`scripts/skills-lint.ts:72,114`).
- Produces: two new `skills-lint` rule ids (`[runtime-name]` and `[staged-candidate]`) reported like `[retired-token]`, each with an `isHazardWaived`-style waiver path; `summarizeModeDrift(entries: ModeDriftEntry[]): CheckResult` returning one aggregated `mode drift` result with the full entry list on its JSON payload.

**Acceptance Criteria:**
- [ ] The `PARITY_CHECK` string at `skill-audit-sweep.js:66`, run verbatim, terminates and prints an `OK` line, and `scripts/skill-audit-workflow-parity.test.ts` pins that exact form.
- [ ] `bun run skills:lint` fails on a skill whose prose names a product runtime or a genie-repo-only command, passes on all six front doors, and refuses a `SKILL.md` staged under `<GENIE_HOME>/skills`; each new rule has a waiver test.
- [ ] A CI job runs `legacy-skills-catalog.ts --check` on a full clone and fails on a seeded stale catalog.
- [ ] On a host with >100 drifted worktree entries `genie doctor` prints one `mode drift` line naming at most five, and `--json` carries every entry.

**Validation:** `umask 022 && bun run check:fast && bun test src/genie-commands/doctor-modes.test.ts scripts/skills-lint.test.ts $(ls scripts/*-workflow-parity.test.ts)`

**depends-on:** Group 0

### Group 8: Docs and README tell the v6 story

**Goal:** README and `docs/` describe the product that exists.

**Deliverables:**
1. `git submodule update --init --recursive .docs-vendor` **first** — `docs/` is a dangling symlink in a fresh checkout and `git submodule status` reports `-41eb2dd…`. Every docs edit is then made under `.docs-vendor/genie/`.
2. `README.md` rewritten around four things: the Orca happy path (explicit authority, closed one-way adapter, no fallback database), the saved-workflow catalog, `genie mikro` (repo-first agents behind a trusted ref), and the skills.sh channel with signed delivery evidence. Omni, the Genie UI and the MCP server shrink to one historical paragraph each.
3. `.docs-vendor/genie/` operator pages follow the same story and lose the Omni pages #3004 left behind; the `_internal` release runbook keeps Group 2's Recovery rewrite. That goes to `automagik-dev/docs` as its own PR; this repository then carries only the `.docs-vendor` pointer bump. Linux and macOS are named as the supported stable platforms in README and `.docs-vendor/genie/installation.mdx` (D-D), and CLAUDE.md gains the one documentation line Group 7's work needs — the doctor mode-drift aggregation gotcha — which lives here because Group 7 touches neither document.

**Interfaces:** Consumes: Group 4's omni enumeration, Group 6's command set, Group 10's `wish` verb, Group 7's aggregated `mode drift` line. Produces: none.

**Acceptance Criteria:**
- [ ] `git submodule status .docs-vendor` shows an initialized submodule, and `grep -rni 'omni\|ui-bridge\|mcp server' README.md .docs-vendor/genie/` returns only sentences marked as retired history.
- [ ] `bun test scripts/release-docs.test.ts` passes with the post-Group-6 command count and tables; the `automagik-dev/docs` PR is merged, `.docs-vendor` points at a commit on the docs default branch, and `docs-lint.yml` is green with `submodules: recursive`.

**Validation:** `umask 022 && git submodule update --init --recursive .docs-vendor && bun run check:fast && bun test scripts/release-docs.test.ts src/__tests__/claude-md-drift.test.ts`

**depends-on:** Group 4, Group 6, Group 7, Group 10

### Group 9: Adopt the `orca-plugin-genie` PR (D-B)

**Goal:** Review and adopt the Orca-plugin work authored elsewhere, so `plugins/genie` stops being one palette entry that prints the Run list.

That work has **its own wish** (`.genie/wishes/orca-plugin-genie`), its own plan review, and its own branch `namastex888/orca-plugin-genie` in an Orca worktree: RF1/RF2/RF3/RF6 executed, RF4/RF5 designed only, eight palette verbs. This group does not author it and **does not gate Group 1 or Group 8** (Decision 11). Measured at `94adc6e96`: that branch is **not pushed to origin** and the wish document is not yet in the repository, so the adoption subject is still in flight.

**Deliverables:**
1. Independent review of the incoming PR at its exact SHA against its own wish's acceptance criteria — not a re-plan — and a `## Review Results` entry recording whether it was adopted, or that v6 shipped without it.
2. Confirm the two claims this design depends on: `plugins/genie/orca-plugin.json` stops contributing only `genie.orca.run-list` (`:21-22`), and its top-level `"capabilities": []` (`:26`) is widened to exactly the grants the handlers use. `engines.orca` is **floor-bumped** from `>=1.4.192` (`:14`) to `>=1.4.205`, the probed version (CLI 1.4.205, schema v1, 234 commands) — a floor, never a pin. The marketplace description no longer says "Genie workflows backed by Orca" (a category genie invented; Orca has no "workflow" concept in 234 commands); `scripts/orca-manifest-parity.test.ts` still asserts the symlink-free, ≤2000-file, ≤50 MB tree and the three version files, and `scripts/orca-bundle-parity.test.ts`'s command-set assertion moved to the new exact set.

**Interfaces:** Consumes: `src/lib/orca-orchestration-adapter.ts`'s closed allowlist (any new operation arrives with that PR and is reviewed as part of it). Produces: none in this repository.

**Acceptance Criteria:**
- [ ] The incoming PR carries an independent review verdict at its exact SHA, and this wish's Review Results records adopt-or-not with that SHA.
- [ ] If adopted: `bun run lint:orca-bundle` and both parity tests are green on the merged tree, and `engines.orca` reads `>=1.4.205` with no `capabilities` grant the handlers do not use. If not adopted by the time Group 1 is ready, the cut proceeds and the Review Results says so in one line.

**Validation:** `umask 022 && bun run check:fast && bun run lint:orca-bundle && bun test scripts/orca-manifest-parity.test.ts scripts/orca-bundle-parity.test.ts src/lib/orca-orchestration-adapter.test.ts`

**depends-on:** Group 0

### Group 10: `genie wish lint`

**Goal:** Every repository can run the wish linter its skill tells it to run, from the installed binary, without tripping the workspace gate.

**Deliverables:**
1. `scripts/wishes-lint.ts` gains an entry-point guard it does not have today: `main()` is called bare at `:474` and exits through `process.exit`, and `ROOT`/`DEFAULT_WISHES_DIR` are derived from `import.meta.url` at `:19-20`, which resolves under `/$bunfs` in a compiled binary and would point at nothing. Refactor to an exported `runWishLintCli(argv): Promise<number>` that **returns** instead of exiting, wrapped in an `import.meta.main` guard, with the wishes root a parameter — never `import.meta.url` — so `--dir` and the default (the git toplevel of cwd) both work inside the binary.
2. `src/term-commands/wish.ts` exporting `registerWishCommands(program)`, registered in `src/genie.ts`, giving `genie wish lint [--dir <repo>]`. It runs the **structural** checks over `<repo>/.genie/wishes`, exits 0 or 1, writes nothing, and says in its help that design-review-evidence and cross-wish graph rules stay repository-gate concerns.
3. **`'wish'` is added to `WORKSPACE_EXEMPT` (`src/lib/interactivity.ts:42-94`)**, beside `'mikro'` at `:79`. Without it, `installWorkspaceCheck`'s `preAction` (`:173`, via `commandRequiresWorkspace` `:113`) refuses or prompts for `genie init` in any repository that is not a genie workspace — which is every repository this verb exists for. No test pins that set today, so this group **creates** `src/lib/interactivity.test.ts` asserting the exempt membership of `wish` (and of the other verbs that must never require a workspace).
4. `skills/wish/SKILL.md:75,78` becomes `genie wish lint`; `bun run wishes:lint` stays the genie-repo alias and CI gate. `wish` is a NEW top-level group, so this tree carries **17 / `Seventeen`** commands (16 + 1): both doc counts and both command tables move here.

**Interfaces:**
- Consumes: `validateWish` (`scripts/validate-wish.ts`), `designReviewViolations` (`skills/brainstorm/references/design-review-evidence.mjs`).
- Produces: `export async function runWishLintCli(argv: string[]): Promise<number>`; `export function registerWishCommands(program: Command): void`; `export function lintWishes(options: { wishesDir: string }): WishStructureIssue[]` — the root is injected, never resolved from `import.meta.url`.

**Acceptance Criteria:**
- [ ] `genie wish lint` run from a tmp repository that is not genie, carrying one valid and one malformed WISH.md, exits 1 and names the malformed file; with only valid wishes it exits 0 and writes nothing.
- [ ] The same run inside a directory that is not a genie workspace does **not** prompt for `genie init` and does not exit 2 — with a test that fails when `'wish'` is removed from `WORKSPACE_EXEMPT`.
- [ ] A built-bundle test proves `dist/genie.js wish lint` resolves its wishes root from the argument or the cwd's git toplevel, never from `import.meta.url`, and that no foreign entry block runs.
- [ ] `bun run wishes:lint` still behaves identically in this repository, and both doc counts read 17 / `Seventeen` with the `wish` row in both tables.

**Validation:** `umask 022 && bun run check:fast && bun run build && bun test src/term-commands/wish.test.ts src/lib/interactivity.test.ts scripts/wishes-lint.test.ts scripts/release-docs.test.ts src/__tests__/claude-md-drift.test.ts`

**depends-on:** Group 0

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] On the dogfood host after `genie update --dev`: `genie --help` lists the post-cut command set, `genie doctor` prints one `mode drift` line, and no `integrations: ` or `omni` line appears in the transcript. In an orca-mode repo a real commit is warning-free, `genie task create` exits 2 with the remedy, `genie task sync` exits 0 silently, and `genie context --wish <slug> --plan` answers. From a repository that is not genie, `genie wish lint` reports on that repository's own wishes without prompting for init.
- [ ] After the promotion merge the next dev release tags `v6.<date>.1` and publishes a Release; `genie update` from the last `5.x` stable to it prints `"outcome":"committed"`; a `genie.db` carrying `hire_roster` rows from a `5.x` install opens under the new binary, migrates to `user_version = 2`, loses the table, and its board is otherwise byte-identical.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A dev release fires between the Group 1 merge and the promotion, minting a `5.x` tag under a 6-major guard on dev — `origin/dev` already moved past `94adc6e96` while this plan was written | High | Decision 2 (Group 2 lands first); Group 1 merges alone and the promotion PR opens immediately |
| The promotion PR stays `BLOCKED`: the `main` ruleset wants an approval, a last-push approval and an extra approval for unattributed changes, and dev's tip is a bot-authored `[auto-version]` commit; `dismiss_stale_reviews_on_push` voids an approval given too early | High | Group 2 deliverable 1 names who approves, records that up to two approvals may be needed and that the last-push approval must post-date the final push, and asserts `reviewDecision: APPROVED` — not just a green rollup |
| Bumping `CURRENT_SCHEMA_VERSION` without the migration ladder bricks every operator database (`initOrValidate:604` throws on an unrecognized version) | High | Decision 4 declares the ladder on `OpenSqliteOptions`; Group 6's migration test is watched failing against a bump-only change first |
| Group 5 reverses a merged decision (#2830) and a later reader restores the identical-degrade rule | High | Decision 7 plus the comment in the split `context.test.ts` case; the reversal is never implicit |
| `genie wish lint` ships but trips the workspace gate in every non-genie repository, which is the only place it is useful | High | Group 10 deliverable 3 adds `'wish'` to `WORKSPACE_EXEMPT` and creates the test that pins it — no such test exists today |
| The Orca plugin API is documented by Orca's issue tracker and a third-party reconstruction, not a public doc site; `pluginApi: 1` may change under us | High | Group 9 floor-bumps `engines.orca` to `>=1.4.205` (a floor, never a pin) and keeps `orca-manifest-parity.test.ts` asserting the manifest's exact shape; only contribution points an `stablyai/orca` issue corroborates are used |
| Four source files are touched by more than one parallel group | Medium | The named shared-file set in the global constraints, plus explicit `depends-on` edges G6 → G5, G7, G10 and G8 → G4, G6, G7, G10; each group rebases over the earlier branch in merge order before leaving draft |
| Two adopted items (#2923, #2917) are authored outside this wish and their scope can move | Medium | Decision 6: each is reviewed at its exact SHA and adopted, or done here under the stated policy caveat (`wish.js` refuses `.github/`) |
| `docs/` is a dangling symlink and `.docs-vendor` is uninitialized, so a docs edit silently writes nowhere | Medium | `git submodule update --init --recursive .docs-vendor` is the first step of Groups 2 and 8, and Group 8's Validation runs it |
| Group 9's subject moves under us — its wish is not yet in the repository and its branch is not pushed to origin as of `94adc6e96` | Medium | Decision 11: adoption, not authorship; it gates nothing and the cut proceeds without it |
| The command count moves twice and `release-docs.test.ts` also asserts both tables element-for-element (`:947-948`); deleting `legacy-integration-retirement.ts` strands a host that never updated inside its window | Low | The merge order pins the count: G10 → 17/`Seventeen`, G6 → 15/`Fifteen`, each group editing counts *and* table rows in its own commit. A retired surface classifies `absent`, the published compat window (`>= 5.260711.6`) has passed, and the manual steps are documented |

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### 2026-09-19 — plan review, round 1 — FIX-FIRST

Independent plan reviewer (claude-opus-5), read-only, against dev at `94adc6e96`. Sixteen findings: **6 HIGH** — `genie wish lint` would trip `installWorkspaceCheck` in every repository it exists for (`'wish'` missing from `WORKSPACE_EXEMPT`, `src/lib/interactivity.ts:42-94`); `scripts/wishes-lint.ts` has no `import.meta.main` guard (bare `main()` at `:474`, `process.exit`, `ROOT`/`DEFAULT_WISHES_DIR` from `import.meta.url` at `:19-20`) so the deliverable was mis-stated as a registration; four source files shared across parallel groups with no `depends-on` edge; `docs/` is a dangling symlink and `.docs-vendor` uninitialized, so docs edits would write nowhere; G7 d.1 (#2919) had already shipped as #3005; the `hire_roster` criterion was unscoped and unreachable. **6 MEDIUM** — #2935's `Quality Gate` already reads SUCCESS (`version.yml:295` dispatches `ci.yml:3-12`), so the real work is the approvals; Decision 4's rationale predated #3004 deleting `global-db.ts`; every group lacked `**Goal:**`/`**Interfaces:**`; G0 was not a real group; `genie wish lint` belonged in its own group; `src/lib/interactivity.ts` was missing from G6's files. **4 LOW** — `skills/genie/SKILL.md:41` is live routing prose, not a `quick` reference; Complexity and Model columns disagreed; two wording items. All repaired in **`69317d9be`**.

### 2026-09-19 — plan review, round 2 — SHIP

Same reviewer, same basis, against `69317d9be`. All sixteen round-1 findings verified resolved against code; no contradiction introduced; the plan is approved for execution. Nine bookkeeping items returned with the verdict and applied in this commit without re-review: the shared-file list gains `src/lib/interactivity.ts(+test)` and `skills/wish/SKILL.md` and loses Group 7's README/CLAUDE.md claim (its one doc line moves to Group 8); Group 0's Validation appends `check:fast` and its acceptance drops a transient check count for "merged"; Group 5's Interfaces cite `orchestration-mode.ts:7,28,57`; Group 6 names the `snapshotCarriesHires` (`:715`) and `preserveHireRoster` (`:786`) declarations and states that the migration ladder falls through to the current-version branch so additive backfills still apply; Group 2 names **PR #3007** (`412c724fd`) as its adopt subject and Group 7 mirrors Group 9's in-flight sentence for `front-doors-runtime-neutral`; Group 9's wave becomes "whenever its subject lands; merge slot 9". Status persisted by the orchestrator: **APPROVED**.

## Files to Create/Modify

```
G0  .genie/brainstorms/genie-v6-corpo-leve/{DESIGN.md,COUNCIL.md,DRAFT.md,council/,reviews/,orca-integration-research.md} .genie/wishes/v6-stable-cut/WISH.md .genie/INDEX.md   (PR #3006)
G1  scripts/{version.ts,release-guard.sh,release-guard.test.ts,version-ci-staging.test.ts} .github/workflows/version.yml
G2  .github/workflows/release-orphan-alert.yml (adopt) · .docs-vendor/genie/_internal/runbooks/release-pipeline.md (automagik-dev/docs PR) · .docs-vendor (pointer)
G3  README.md CLAUDE.md          (verification: .github/workflows/ci.yml, src/lib/orca-orchestration-adapter.test.ts)
G4  none                          (verification only; docs pages in G8)
G5  src/genie.ts src/lib/orchestration-mode.ts(+test) src/lib/v5/authority-barriers.test.ts src/term-commands/{v5-task,v5-board,context}.ts(+tests) README.md CLAUDE.md
G6  src/term-commands/{mcp,ui-bridge}.ts(+tests) src/term-commands/v5-task.ts(+test) src/genie.ts src/lib/interactivity.ts(+test)
    src/genie-commands/doctor.ts src/lib/v5/{sqlite-open,genie-db,task-state,roadmap-sync}.ts(+tests) src/lib/v5/TAXONOMY.md
    src/lib/legacy-integration-retirement.ts(+test) skills/quick/ skills/{README.md,wish/SKILL.md} .claude/workflows/wish.js
    scripts/{skills-lint.ts,release-docs.test.ts,wish-workflow-parity.test.ts} .genie/{roadmap.json,INDEX.md} README.md CLAUDE.md
G7  scripts/{skills-lint.ts(+test),legacy-skills-catalog.ts,skill-audit-workflow-parity.test.ts} .github/workflows/ci.yml
    skills/{council,workfly,docs,research,skill-audit}/SKILL.md (adopt) src/genie-commands/doctor-modes.ts(+test)
G8  README.md  CLAUDE.md  .docs-vendor (pointer)  .docs-vendor/genie/*.mdx (automagik-dev/docs PR)
G9  review only; if adopted, plugins/genie/** orca-marketplace.json scripts/{orca-manifest-parity,orca-bundle-parity}.test.ts arrive with that PR
G10 scripts/wishes-lint.ts(+test) src/term-commands/wish.ts(+test) src/genie.ts src/lib/interactivity.ts(+test) skills/wish/SKILL.md README.md CLAUDE.md
```
