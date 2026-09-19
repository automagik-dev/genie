# Design: genie v6 — rev. 4 ("the number, honestly")

| Field | Value |
|-------|-------|
| **Slug** | `genie-v6-corpo-leve` |
| **Rev.** | **4** (2026-09-19) — rewritten over rev. 3.3 (SHIP `d91de43a…`, 2026-08-25, never landed on dev) after the item-by-item audit against `origin/dev` and owner decisions D-A…D-D; repaired after the rev. 4 design review returned FIX-FIRST |
| **Audit basis** | **dev at `68e3431c7`** (the merge of #3004); `origin/main` `15b7870f3`; branch `origin/v6/corpo-leve` `19a016b85`. Every line number below is derived there. `origin/dev` is already one `[auto-version]` bump ahead at `2ea6ee919` — Risk 1 live |
| **Evidence** | [orca-integration-research.md](orca-integration-research.md) (D-B, G9) · [COUNCIL.md](COUNCIL.md) (rev. 3 dossier) · `scratchpad/roadmap/{v6-design-vs-dev,issues-verification}.md` |
| **Design review** | rev. 3.3: SHIP. Rev. 4 round 1: **FIX-FIRST**. This revision answers H1–H5, M1–M7 and the LOWs; it awaits the confirming review. |

## Problem

Rev. 3.3 was approved 2026-08-25 as a subtraction program and **dev never executed it**. `.genie/brainstorms/genie-v6-corpo-leve/` does not exist on dev; the v6-shaped work dev did ship went under the `genie-dual-mode-orca-plugin` slug with its own design and its own review chain.

Of rev. 3.3's eight acceptance criteria, **one passes ((e), nothing to reconcile), two pass in half ((d), (f)), and five have no subject at all**. Three of its ten scoped items were directly contradicted by shipped code.

Meanwhile three subsystems rev. 3.3 never contemplated became the product: the saved-workflow catalog, `genie mikro`, and the skills.sh delivery channel with signed delivery evidence.

Rev. 4 stops trying to land rev. 3.3. It names what v6 **is** on dev today, disposes of every rev. 3.3 item honestly, and scopes the smallest cut that makes the version number true. `.genie/INDEX.md:9,28` already records the vehicle: **the open dev→main promotion PR [#2935](https://github.com/automagik-dev/genie/pull/2935) is the v6 stable cut.**

## Framing decisions (Felipe, 2026-09-19)

> **D-A — Omni leaves v6 entirely:** the lib, the verb, the skill, the NATS dependency and the global-db paths. The legacy retirement of omni-era host assets stays.

**Shipped.** PR **#3004** (`feat(v6)!: remove Omni entirely`, merged; `68e3431c7` is its merge commit). `package.json` carries no `nats` dependency; `src/term-commands/omni.ts`, `src/lib/omni-*.ts` and `src/lib/v5/{global-db,omni-queue}.ts` are gone; the live registry is **16** commands (`README.md:158`, `CLAUDE.md:72`). Residual mentions are historical only, in **10 files** — `skills/NOTICE`, `src/lib/{legacy-skills-catalog,genie-home}.ts`, `src/lib/genie-home-permissions.test.ts`, `src/genie-commands/{doctor,legacy-v4}.ts`, `src/lib/v5/{TAXONOMY.md,genie-db.ts,sqlite-open.ts}`, `tests/e2e/v5-lifecycle.sh` — plus the operator's own `~/.genie/genie.db`, which the release does not delete. The public `docs/` pages are the one outstanding piece and belong to G8.

> **D-B (replaced 2026-09-19, after reading that `plugins/genie` contributes exactly one command) — `plugins/genie` becomes a REAL integration with Orca's native mechanisms in v6: never a second board, never a task provider (Orca's `TaskProvider` is a closed union, [orca#15328]). `plugins/dsh-genie-board` stays.**

Consequence: rev. 3.3's largest deletion is still cancelled, but the plugin stops being a stub. Today `plugins/genie/orca-plugin.json` contributes exactly one command — `genie.orca.run-list`, "Genie: List Orca Runs" (`:21-22`) — under a top-level `"capabilities": []` (`:26`), an empty grant rather than an absent key, with `engines.orca` a **floor** of `>=1.4.192` (`:14`). Every real capability already lives in the CLI adapter, which needs no plugin at all, so the honest answer to "what is the plugin for" is currently "one palette entry that prints the Run list" ([research §C](orca-integration-research.md)). v6 makes it ride native mechanisms instead: the command palette (`contributes.commands` + `keybindings` + `terminal.sendText`), the board — which **is** workspace status, not a separate object — and automations.

Bounded by what `pluginApi: 1` permits ([research §B], sourced from Orca's own tracker): seven strict contribution keys, seven capabilities, a 13-method host API. A plugin **cannot** register a task source ([orca#15328]), add a status-bar segment ([orca#19809]), place a panel ([orca#19809]/[orca#16853]) or expose settings ([orca#15655]); `contributes.agents` exists but nothing consumes it ([orca#13306]).

> **D-C — the board FREEZES: kept, tested, no new verb and no new column. Orca mode is made honest — `ORCA_FORBIDDEN` as a closed list, exit 2 from a `preAction`, `task sync` silent exit 0, `context --wish --plan` answering read-only.**

Consequence: D1 of rev. 3.3 survives, 25 days late — six verbs and five columns landed after the stamp. The freeze starts now, not retroactively. The honesty half is rev. 3.3's translation points 1, 2 and the `--plan` degrade, which are absent or contradicted on dev (`src/term-commands/context.ts:424` asserts before option resolution; its comment at `:419-423` calls the identical degrade deliberate).

> **D-D — the number 6 goes to today's dev plus this cut. Stable platforms are Linux and macOS ONLY.**

**Mostly shipped.** PR **#3003** (`fix(ci): gate darwin in CI and stop tests asserting linux literals`, merged) added the darwin leg: `.github/workflows/ci.yml:138-140` (`unit-darwin`, `runs-on: macos-latest`), required at `:265` and read at `:274`, with `:129` stating "Stable is declared for Linux AND macOS, so darwin is a gate, not a courtesy." The residual is one sentence: neither `README.md` nor `CLAUDE.md` yet says stable means Linux **and** macOS (README's only macOS mentions are incidental, `:229-230`).

## What v6 is — the identity dev converged on

Rev. 3.3 described none of this. Rev. 4 owns it as the v6 story:

1. **The saved-workflow catalog.** `.claude/workflows/*.js`, `wish.js` as one-prompt delivery, staged into `templates/workflows/` and installed to `~/.claude/workflows/` with per-file sha256 in `skills-install.json`; doctor observes drift, uninstall removes only digest-proven copies.
2. **`genie mikro`.** A microagent runtime on PATH whose agents are read **repo-first at a trusted git ref** — never from the working tree of the PR under review — with `bench`, `coach`, `fixtures` and `init`; four rounds of adversarial security review.
3. **The skills.sh channel.** One pinned CLI over the locally delivered tree, with retirement, collision backup, prune, an install record that fails closed, and release verification from the release's own signed delivery evidence with no GitHub credential.
4. **Orca as a selectable lifecycle authority**, explicit and never inferred, over a closed one-way `orca orchestration … --json` boundary with no fallback database in either direction.

That is the subtraction rev. 3.3 wanted, arrived at by a different road: `packages/`, the whole hook subsystem, `mcp-server`/`mcp-tools`, `session-context`, the Codex/Hermes delivery machinery and the role-agent tree are all gone — but the board and the plugin survived, and three new capabilities took their place.

## Rev. 3.3 disposition

| Rev. 3.3 item | Rev. 4 | One line |
|---|---|---|
| 1 — mode resolved at the edge | **superseded-by-dev** | Mode is `orchestration.mode` in `<GENIE_HOME>/config.json` (`src/lib/orchestration-mode.ts:40`), enum `standalone`/`orca`, chosen by `genie setup --orchestration-mode`. Two states, hard throw on garbage. Kept as-is. |
| 1a — `.genie/mode` committed marker + `GENIE_MODE` env | **deferred-to-v7** | See "The clone risk" below. Dev's model makes authority an operator property; adding a repo tier now is a second marker with no measured requirement. |
| 2 — board gate in `openDb()` | **kept, completed by D-C** | Placement shipped — `assertLocalLifecycleEnabled()` is the first statement of `openDb` (`src/lib/v5/genie-db.ts:464-465`) — and went further (five `roadmap-sync.ts` assert sites). Missing: the closed `ORCA_FORBIDDEN` list, exit 2, and `task sync` exit 0; `.husky/pre-commit` warns on **every** commit in orca mode today. |
| 3 — wave base via `context --wish --plan` | **kept, completed by D-C** | `context.ts:424` asserts before option resolution, so `--plan` refuses too. D-C restores the read-only answer, which **revokes** PR [#2830](https://github.com/automagik-dev/genie/pull/2830)'s "every form degrades identically" (`context.ts:419-423`). The validator's four content rules are **revoked** (see item 4). |
| 4 — Genie↔Orca boundary | **kept** | Shipped in spirit and better: `src/lib/orca-orchestration-adapter.ts` is closed and one-way; no reconciliation code exists. |
| 4a — append-only provenance block in WISH.md | **revoked** | Seven fields of hand-copied receipt data, unenforced, in a document a reviewer already stamps. `## Review Results` plus the design-review evidence block are the evidence surface that exists and is linted. |
| 4b — `## Dispatch plan` + `validate-wish --mode orca` content rules | **revoked** | The largest new module in rev. 3.3, built to pin a base SHA no code reads. Orca owns dispatch; making WISH.md cells into argv buys an injection surface for a cache Orca rebuilds. |
| 5 — `skills/genie-orca-{wish,work,review}` + 3 lints | **revoked** | Never existed on dev to flatten. Drift risk 3 got a stronger answer than a lint: the skills.sh install record with per-directory digests, collision backup and doctor observation. |
| 6 — `plugins/` out | **revoked and inverted (D-B)** | The plugin is not deleted; it is finished. Rev. 3.3 called it "a vehicle for authenticating bytes that stop existing" — true of the plugin-era delivery machine, false of the Orca manifest, the only way genie verbs reach Orca's palette, keybindings and board. G9 adopts that work; the second board and the task provider it must never become are named permanently OUT with their evidence. |
| 7 — hooks by mode + `genie init --claude-hooks` writer | **revoked** | `src/hooks/` does not exist; every handler was deleted. Enforcement is server-side branch protection plus the repo's own `.claude/hooks/git-safety.sh`. |
| 8 — Omni out | **kept and SHIPPED (D-A)** | #3004. The one rev. 3.3 deletion that survives intact. |
| 9 — no UI, no khal | **kept, finished in v6** | `packages/` and `bridge-watcher` are gone. Two remainders: the `ui-bridge` stub and the `hire_roster` table (`genie-db.ts:479,657`), both G6. |
| 10 — acceptance vehicle `caio-cria-ds-tokens-hapvida` | **revoked** | No such wish exists anywhere. v6's acceptance vehicle is this repository's own promotion: PR #2935 shipped as the first `6.x` stable. |
| 11 — `genie mcp` deleted | **kept, finished in v6** | Server and tools deleted; the verb survives as a registered stub (`src/genie.ts:258`, `ui-bridge` at `:259`). A major may drop a retired verb — G6. |
| 12–22 (inherited) | **revoked** | Tracker chain, dispatch-as-source, per-mode fixture, reviewer families, model policy: all orbit the dispatch-plan machinery 4b revokes. The two that are real — two human gates, and a reviewer who is not the engineer — already live in `skills/wish` and `skills/review`. |

### The clone risk, decided

Rev. 3.3 risk 9 ("High if unmitigated") is real on dev: mode lives in `<GENIE_HOME>/config.json`, so a fresh machine cloning an orca repo resolves `standalone` and the board writes.

**Rev. 4 defers the fix to v7, with the reason.** Under dev's model the authority is the operator's, not the repository's — the same checkout is legitimately driven by Orca on one machine and by the local board on another. And the failure rev. 3.3 feared (silent divergence) is the one dev already solved: `.genie/roadmap.json` is git-tracked and canonical, and three-way `task sync` unions card timelines by identity on pull and commit.

**Accepted with this stated:** the v6 mitigation is **detective on demand, not preventive** — it is a line an operator sees only when they choose to run `genie doctor`, and after G5 makes `task sync` exit 0 and silent, the orca-side operator gets no signal at all from the commit path that a standalone clone is writing cards. The trade is deliberate: the alternative is the second repo-tier marker rev. 4 declines to build. **v7 trigger:** the first report of a team whose standalone operator's board writes fight an Orca-driven roadmap, or a second thing that needs to be a per-repo property.

## Approach

v6 = a version cut plus a truth-telling pass, sequenced so the number is the last thing that moves.

One wish, `v6-stable-cut`, with nine groups. Two of them (G3 darwin, G4 Omni) are **verification-only**: their behaviour merged as #3003 and #3004 while this design was in review, so each keeps only its residual — a platform sentence for G3, nothing in-repo for G4, with the public docs pages moved to G8. G9 **adopts** the Orca-plugin work happening under its own wish; it does not gate the cut.

Alternatives rejected: shipping v6 as rev. 3.3 (five of eight criteria have no subject; the two largest deletions are revoked by the owner); shipping v6 as a pure rename (the `mcp`/`ui-bridge` stubs, `hire_roster`, the `quick` stub and `legacy-integration-retirement.ts` are exactly the debt a major exists to discharge); deferring the major until the deferred v7 items land (the number is already claimed in `.genie/INDEX.md:9` and on PR #2935).

## Simplicity Case

- **Simplest complete design:** change one literal in three places, repair the pipeline that carries it, delete five proven-dead surfaces, fix four open bugs, rewrite the story, adopt one externally-planned plugin PR. No new subsystem, no new command beyond `genie wish lint`.
- **Added machinery:** **one new mechanism, and it lives in a shared primitive with its own contract** — the `user_version` 1 → 2 migration that drops `hire_roster`. Bumping `CURRENT_SCHEMA_VERSION` (`src/lib/v5/genie-db.ts:43`) alone is not enough and is actively dangerous: `initOrValidate` in `src/lib/v5/sqlite-open.ts:588-604` throws `ForeignDbError(… 'unrecognized schema version')` for any stamped version that is neither `schemaVersion` nor `0`, so a bump without a migration path makes **every operator database refuse to open**. `sqlite-open.ts` is the module that must learn to migrate, and it is shared with the global database, so the change is to a contract, not to one caller.
- **Deferred until measured:** `.genie/mode` + `GENIE_MODE`; any orca-specific skill tree; any wish-document validator beyond the structural one; collapsing the two delivery channels.
- **Complexity removed:** one global SQLite database, one daemon, one transport dependency, two registered stubs, one board table, one retired skill stub, one time-boxed retirement module, and ~10k lines of doctor output per run.

## Decisions (rev. 4)

| # | Decision | Rationale |
|---|---|---|
| 1 | D-A, D-B, D-C, D-D are recorded verbatim above and bind every item below | Owner, 2026-09-19 |
| 2 | v6 keeps the `<major>.YYMMDD.N` scheme with the daily counter; only the leading digit moves | Same shape as 4→5. The counter resets to 1 because `v6.*` tags do not exist |
| 3 | The major bump is the **last** dev change before promotion, and takes effect only when main carries it | `release-guard.sh` is loaded from the **control ref (main)**, not from `source_sha` (`release.yml:91`), and `version.yml` runs from main with its own inline generators (`:114`, `:322`, `:328`). `scripts/version.ts` is the local `npm run version` path only (`package.json:13`) |
| 4 | The first `6.x` tag is the first **dev** release after the promotion; the first `6.x` **stable** is a `release.yml` `workflow_dispatch` with `channel=stable` | `release.yml:18,22` offers stable as the only manual channel; `release-guard.sh:97,106` require a human dispatch for stable, and the else branch at `:111` rejects a human dev dispatch |
| 5 | Removing the `mcp` and `ui-bridge` verbs is permitted at a major; `genie doctor` keeps observing the old routes | A retired verb that still parses is a promise; a major is the one release allowed to break it. The route observers are about **host state**, not the verb |
| 6 | `hire_roster` is dropped with `user_version` 1 → 2, through `sqlite-open.ts` | See the Simplicity Case. Criterion (c) of rev. 3.3 becomes assertable: the export schema differs by exactly this key |
| 7 | `legacy-integration-retirement.ts` is deleted in v6 | Its own comment (`:1388`) sets the window at two stable releases after `skills-everywhere-b` (SHIPPED 2026-08-31, `0efc288b5`). Three stable releases have followed — `v5.260901.4`, `v5.260916.4`, `v5.260916.6` |
| 8 | This design and this wish are written in English | Rev. 3.3 is Portuguese; every current wish, skill and lint message in the corpus is English. Stated as a decision so the owner can overrule cheaply |
| 9 | PR [#2830](https://github.com/automagik-dev/genie/pull/2830)'s identical-degrade rule for `genie context` is **revoked** by owner decision, 2026-09-19 | A merged decision is only reversed explicitly. `wish.js` refused this change at admission (`route=brainstorm`) for exactly that reason, so it is recorded here, in the code comment, and in the split `context.test.ts` case |
| 10 | Orca refusals exit **2**, not 1 | 2 is already genie's "operator must act" family — the v4 workspace gate and `mikro call`'s usage refusals both use it — while 1 stays "the command failed". The fixed message naming `orca` and `genie setup --orchestration-mode standalone` is what disambiguates within the family |
| 11 | `genie wish lint` ships the wish linter in the binary, wrapping `scripts/wishes-lint.ts` **imported in place** (the `genie mikro` pattern) | `skills/wish/SKILL.md:75,78` tells every repository to run a linter only this repository provides, and "a linter the project does not provide is reported as a finding" reads to a user as a missing script. `skills/workfly/SKILL.md:41` is the same defect from the other side and folds into #2917 |

## Risks

| # | Risk | Sev. | Mitigation |
|---|---|---|---|
| 1 | The bump lands on dev, a dev release fires before promotion, and main's 5-major generator mints a tag dev's own guard tests reject | **High** | Decision 3: bump is the last dev change and the promotion PR opens in the same window. Falsifiable: no dev release between the bump merge and the promotion merge |
| 2 | The promotion PR is BLOCKED on more than a check: the `main` ruleset requires `required_approving_review_count: 1`, `require_last_push_approval: true` and `require_extra_approval_for_unattributed_changes: true`, and dev's tip is a bot-authored `[auto-version]` commit — an unattributed change | **High** | G2 names who approves and proves the rollup separately; #2935 reads `BLOCKED` with an empty `reviewDecision` today, so the gap is real and measured |
| 3 | The first `6.x` tag orphans and cannot be re-run | Med-High | #2923 and #2924 are both in G2, **before** the cut; plus one dry rehearsal on a replica HOME |
| 4 | Dropping `hire_roster` bricks an operator's `genie.db` because `initOrValidate` refuses an unrecognized `user_version` (`sqlite-open.ts:588-604`) | **High** | Decision 6: the migration is written in `sqlite-open.ts` itself, with an open of a stamped-v1 database carrying rows as the acceptance test |
| 5 | The command count moves twice and `scripts/release-docs.test.ts` derives it from `genie --help`, knowing only the words 14–17 (`:938-944`) | Med | It is **per tree** under the merge order: G7 adds the new `wish` group (16 → **17 / `Seventeen`**), G6 then drops `mcp` and `ui-bridge` (→ **15 / `Fifteen`**, the final registry). Never 14 — `genie wish lint` is a new top-level group, not a flag. `CLAUDE.md:72` and `README.md:158` move in each group's own commit |
| 6 | **The Orca plugin API is documented by Orca's issue tracker and a third-party reconstruction, not a public doc site.** `pluginApi: 1` may change under us: there is no `orca plugin` CLI verb, no plugin directory under `~/.orca/`, and the authoritative `orca-plugin.json` schema was not reachable | **High** | G9 floor-bumps `engines.orca` from `>=1.4.192` to `>=1.4.205` (the probed version: CLI 1.4.205, schema v1, 234 commands) — a floor, never a pin — and keeps `scripts/orca-manifest-parity.test.ts` asserting the manifest's exact shape, so drift is a red test rather than a silently dead plugin. Only contribution points an `stablyai/orca` issue corroborates are used |
| 7 | G3 and G4 are verification-only groups; a reviewer could read them as unstarted work and re-do a merged change | Med | Both name their merged PR (#3003, #3004) and carry only a named residual — a platform sentence for G3, nothing in-repo for G4. A group whose residual is empty is closed by verification, not by a commit |
| 8 | G9's subject is planned and executed outside this wish, so its scope can move under us | Med | G9 is adoption, not authorship: it does **not** gate G1 or G8. If the PR lands first the cut adopts it; if not, v6 ships without it and it follows in a point release |
| 9 | Deleting `legacy-integration-retirement.ts` strands a host that never ran an update in the window | Low | A retired surface classifies `absent`; the published compat window (`>= 5.260711.6`) has passed and the manual steps are documented |

## Success criteria

- [ ] **The number is true.** `genie --version` on the first stable v6 prints `6.YYMMDD.N`; `git tag --list 'v6.*'` is non-empty; no `5.*` tag is minted after the promotion.
- [ ] **The pipeline carried it.** The `6.x` tag has a Release object; no `release-incident` issue is open against it; `release-orphan-alert.yml` closes an incident once the Release appears.
- [ ] **The surfaces are gone.** `genie --help` lists **15** commands — neither `mcp` nor `ui-bridge`, and `wish` present; `grep -rn 'hire_roster' src scripts .genie` is empty; `skills/quick/` and `src/lib/legacy-integration-retirement.ts` are absent; a grep for `omni|nats` in `src/` and `package.json` returns only legacy-retirement references.
- [ ] **The board is frozen and honest.** In orca mode a real commit prints no `board snapshot not refreshed` warning, `genie task create` exits 2, `genie task sync` exits 0 silently, and `genie context --wish --plan` answers.
- [ ] **The plugin does something** (if G9 lands): in a live Orca the command palette shows the genie verbs in a worktree context, and a wish moving to review flips that workspace's status to `in-review` with the verdict as its card comment.
- [ ] **macOS is a declared platform.** The darwin leg (#3003, `ci.yml:138-140,265`) runs on the promotion commit, and README and CLAUDE.md say stable means Linux and macOS.
- [ ] **The story matches the product.** README and `docs/` describe the Orca happy path, the workflow catalog, `genie mikro` and skills.sh, and mention Omni, the Genie UI and the MCP server nowhere except as retired history.
- [ ] `bun run check` green on the promotion commit, including `wishes:lint` over a corpus that carries this design and this wish.

## Delivery

```
G2 release pipeline (#2923, #2924, approval + Quality-Gate provenance, rehearsal)
     │ requires
G1 version major ──────────────── last dev change before promotion
G3 darwin residual (#3003 merged) ─┐
G4 Omni residual (#3004 merged) ───┤
G6 stubs and dead surfaces ────────┼── independent of G1
G7 bugs + 2 lints + `genie wish lint` ─┘
G5 orca honesty + board freeze ────── independent
G8 docs and README ───────────────── after G3, G4, G6, G7
G9 adopt orca-plugin-genie ───────── gates NOTHING; adopted if it lands first
```

Sequencing rules: G2 lands before G1 (an orphaned first-v6 tag is the expensive failure). G3, G4, G6 and G7 all change what genie declares or exposes, so G8 follows them. G1 merges alone, and the promotion PR opens immediately after it; no dev release fires in between. **G9 does not gate G1 or G8** — the cut proceeds without it and adopts it if it lands first, so it no longer extends the promotion timeline.

## Not in v6 — deferred to v7, with reasons

| Item | Reason |
|---|---|
| `.genie/mode` per-repo marker + `GENIE_MODE` env | No measured requirement under dev's operator-scoped authority model; the divergence it prevents is already handled by git-tracked `roadmap.json` + three-way sync. Accepted knowing the v6 mitigation is detective-on-demand only |
| Un-freezing or replacing the board | D-C froze it; replacing it is a program, not a cut |
| Collapsing skills.sh and the Orca plugin into one channel | They deliver different artifacts to different consumers; no measured redundancy |
| A Genie panel in Orca (`contributes.panels`) | Placement is **not controllable** — `panels` has no location field ([orca#19809]/[orca#16853]) — so we cannot promise where it appears, and the panel↔worker RPC is evidenced only by a third-party reconstruction |
| `contributes.agents` — "genie" as a selectable harness | Reserved and unconsumed ([orca#13306]); the real proposal upstream is a future `contributes.harnesses[]`. Highest-value item in the research's ranking and entirely gated on Orca |
| A genie task provider, a second board, a status-bar segment | `TaskProvider` and `WorkspaceLinkedItem['provider']` are closed unions in Orca's `src/shared/` ([orca#15328]); the board already **is** workspace status, so a genie board duplicates `workspace.openBoard`; the status line has no extension point ([orca#19809]). **Permanently out**, not deferred, unless Orca changes |
| `brain`/`brain-init` acknowledgement path (#2927 residual) | Cosmetic; needs a persisted operator ack, which is new durable state |

## Next step

Confirming independent review of this repaired rev. 4, then stamp with `skills/brainstorm/references/design-review-evidence.mjs`. `wishes-lint` refuses a wish whose `Design` cell links an unstamped DESIGN.md (`scripts/wishes-lint.ts:223`), so the stamp gates landing `v6-stable-cut`, not writing it.

`[orca#N]` cites issue N in `stablyai/orca`; every URL is in the Sources section of [orca-integration-research.md](orca-integration-research.md), which is this rev.'s evidence for D-B and G9.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `2a74bdc356e4d34d7c25ad828c3b2c2c97aba398a86d78297547d972489abd6f`
- **Reviewer:** claude-opus-5 independent design reviewer (3 rounds, session b17f7778)
- **Reviewed at:** 2026-09-19T17:20:12.000Z
<!-- genie-design-review:end -->
