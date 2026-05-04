# Wish: Genie v5 Major Cutover Handoff

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `v5-major-cutover-handoff` |
| **Date** | 2026-05-04 |
| **Author** | Felipe + Genie |
| **Appetite** | medium (~2 weeks) |
| **Branch** | `wish/v5-major-cutover-handoff` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | [DESIGN.md](../../brainstorms/v5-major-cutover-handoff/DESIGN.md) |
| **Umbrella** | [aegis-distribution-sovereignty](../../brainstorms/aegis-distribution-sovereignty/DESIGN.md) — sub-project under Wave 1/2 |

## Summary

Ship the cross-major handoff from genie 4.x-on-npm to genie 5.x-on-CDN as a single user-facing verb (`genie v4-upgrade`) on the v4 final release. The verb handles pre-flight refusal on in-flight state, mandatory pgdump snapshot, Tier-A user-content export to a portable JSONL bundle, v5 install via `distribution-exodus` install.sh, and handoff to v5's `import-from-v4` for reinjection. Filesystem assets and Tier-B operational tables regenerate on v5 first run via existing `genie agent sync`.

## Scope

### IN

- **Goodbye banner** in the v4 final npm release shown unconditionally on `genie update`, `genie --version`, and first launch after upgrading to the final-v4 version. Cites 2026 npm incidents (Axios RAT Mar 2026, Shai-Hulud / CanisterSprawl worm Apr 2026, SAP package compromises Apr 2026, automagik typosquat per InfoWorld) with hyperlinks. Points to `genie v4-upgrade` as the canonical migration path.
- **`genie v4-upgrade` subcommand on v4** with the full flow: pre-flight checks → snapshot → export → download v5 from CDN via install.sh → install v5 → handoff to `genie import-from-v4` → Tier-B regenerate via `genie agent sync` → summary + rollback instructions.
- **Pre-flight refusal** on pending `approvals` rows or non-terminal `omni_requests` rows. Lists offending rows. `--force` bypass not permitted for these. Warn-and-allow-`--force` for active `runs`/`executors` and recent `sessions` (<5min).
- **Mandatory pgdump snapshot** to `~/.genie/backups/v4-pre-upgrade-<timestamp>.pgdump` before any DB mutation. Pre-flight disk check ≥3× DB size; refuse if snapshot fails.
- **Tier-A exporter** producing `~/.genie/exports/v4-upgrade-<timestamp>.jsonl.gz`. Export contract: 14 tables (`tasks`, `task_actors`, `task_dependencies`, `task_stage_log`, `task_tags`, `tags`, `task_types`, `projects`, `boards`, `board_templates`, `wishes`, `schedules`, `notification_preferences`, `triggers`). JSONL line format: `{"schema_version":1,"table":"<name>","row":{...}}`. Bundle metadata header records source DB version + per-table row counts.
- **Bundle schema spec** as a versioned, code-checked-in contract document (`docs/v5-cutover/bundle-schema.md` + `scripts/validate-v4-bundle.ts`). Frozen at v4-final-release ship; v5's import-from-v4 consumes it without modification.
- **CI integration tests** running on every v4-final release-candidate: clean v4-on-npm install AND clean v4-on-bun-global install → run `genie v4-upgrade` end-to-end against a representative DB → consume v5 from CDN beta channel → verify Tier-A row counts preserved + Tier-B regenerated + pgdump exists + rollback path tested.
- **`npm deprecate` automation** — GitHub Action that calls `npm deprecate @automagik/genie` at v5 GA with deprecation message pointing to `get.automagik.dev/genie`.
- **Rollback runbook** — `docs/v5-cutover/rollback.md` documenting `npm install -g @automagik/genie@<v4-final>` + `pg_restore` from the snapshot. Single-page, copy-pasteable commands.

### OUT

- **`genie import-from-v4` implementation on v5** — owned by the v5 backend wish (separate slug TBD). This wish authors the bundle contract; v5 owns reading it.
- **v5 schema bootstrap SQL** — owned by the v5 backend wish. This wish decides only what content reaches v5 via Tier-A export; v5 decides where it lands.
- **CDN + install.sh + cosign infrastructure** — owned by `distribution-exodus`. This wish CONSUMES install.sh; does not author it.
- **Within-major channel-aware self-update (`genie self-update --channel`)** — owned by `genie-self-update`. v5's intra-major patch path is unaffected by this cutover.
- **DB schema dead-wood sweep** (5 likely-dead + 10 low-usage tables identified in DRAFT static sweep) — owned by sibling brainstorm `v5-schema-deadwood-sweep`. Output feeds v5 bootstrap SQL, not this wish.
- **Native Windows distribution** — deferred to v2 per umbrella platform matrix.
- **Anti-rollback enforcement** (refusing rollback to a known-bad version) — out for v1; operators have full control over rollback target.
- **Aegis daemon distribution** — owned by sibling wishes `aegis-runtime` / `aegis-scanner`.
- **Cross-major rollback (v5→v4)** beyond the documented `npm install + pg_restore` path — schemas diverge; full programmatic rollback is out for v1.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **D1 — v5 launches CDN-only; v4 stays on npm forever** | Matches user intent "truly a clean restart, we leave npm at v5." 2026 npm incidents (Axios RAT, Shai-Hulud, SAP, automagik typosquat) are the public justification. v4 frozen-as-final on npm; v5 never appears on npm. |
| 2 | **D2 — `genie v4-upgrade` lives on the v4 final release** | v4 has the live DB connection + schema knowledge. Asymmetric ownership: v4 exports, v5 imports. v5 must not embed v4 schema knowledge (clean-restart principle). |
| 3 | **D3 — 14 Tier-A migrate, 6 Tier-B regenerate, 27 Tier-C explicit-skip** | Filesystem-as-source-of-truth principle (user, 2026-05-04). Minimal export contract = minimal frozen surface = least likely to drift. Tier breakdown verified against full v4 schema (47 tables: 14+6+27=47). |
| 4 | **D4 — Mandatory pgdump snapshot before any DB mutation** | Single-command rollback floor. Removes "did I lose my data?" anxiety. Pre-flight disk check ensures snapshot fits before mutation begins. |
| 5 | **D5 — Pre-flight refusal on pending approvals / non-terminal omni_requests** | Prevents silent data loss for in-flight work. Refusal lists offending rows so user can drain them. Active runs/sessions warn + allow `--force`. |
| 6 | **D6 — Goodbye banner cites 2026 npm incidents with sources** | Honest user communication. Banner copy in DESIGN.md §D1 (DRAFT.md goodbye-banner draft). Sources: GTIG/Axios, The Hacker News/Shai-Hulud, The Register, InfoWorld/automagik typosquat. |
| 7 | **D7 — `npm deprecate` called at v5 GA, not at v4-final ship** | v4 final users need a window to actually run `genie v4-upgrade` before npm signals "this is dead." Deprecation message points to `get.automagik.dev/genie`. |
| 8 | **CDN posture inherited from `distribution-exodus` Council Amendment 2026-05-04** | Cloudflare primary + GitHub Releases failover. No Fastly day-1. install.sh falls through CF→GH on connect/HTTP-5xx. (Fastly deferred until a real CF outage justifies it; downgrade defenses ship first.) |

## Success Criteria

- [ ] A 4.x user running `genie v4-upgrade` on a representative DB ends up on v5 with all 14 Tier-A tables intact (verified by row counts) and Tier-B regenerated via `genie agent sync`.
- [ ] A v4 pgdump snapshot exists at `~/.genie/backups/v4-pre-upgrade-<timestamp>.pgdump` after every upgrade. Rollback path tested end-to-end and documented in `docs/v5-cutover/rollback.md`.
- [ ] Pre-flight refusal blocks upgrade when `approvals` rows are pending OR `omni_requests` rows are non-terminal. Refusal message lists offending rows with primary keys.
- [ ] Goodbye banner ships in v4 final npm release; shown unconditionally on `genie update`, `genie --version`, and first launch after install. Cites all 2026 npm incidents with source hyperlinks. `genie v4-upgrade` highlighted as recommended path.
- [ ] v5 install path called from `genie v4-upgrade` is cosign + SLSA L3 + SHA256 verified per `distribution-exodus` install.sh contract; refuses on verification failure unless `INSECURE=1`.
- [ ] `npm deprecate @automagik/genie` GitHub Action runs at v5 GA with deprecation message pointing to `get.automagik.dev/genie`.
- [ ] CI integration test exercises clean v4-on-npm install path AND clean v4-on-bun-global install path. Both must pass on every v4-final release-candidate before tagging.
- [ ] Bundle schema spec (`docs/v5-cutover/bundle-schema.md`) is committed; sample-bundle validator (`scripts/validate-v4-bundle.ts`) exits 0 on a known-good bundle and non-zero with specific error codes on schema violation.

## Execution Strategy

### Wave 1 (parallel)

G2 (bundle schema spec) and G4 (npm-deprecate automation + rollback runbook) are independent of one another and of G1's runtime code. They can ship in parallel up front so the contract and the operational artifacts exist before the runtime work in G1 lands against them.

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Bundle schema contract + sample validator (frozen contract for v4-exporter and v5-importer) |
| 4 | engineer | `npm deprecate` GitHub Action + rollback runbook + goodbye-banner copy lockdown |

### Wave 2 (sequential after Wave 1)

G1 (v4-upgrade runtime) consumes the Wave 1 artifacts: it produces bundles that conform to G2's schema and ships the banner whose copy was locked in G4.

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | v4 final release: goodbye banner + `genie v4-upgrade` subcommand (pre-flight, snapshot, export, install handoff, summary) |

### Wave 3 (sequential after Wave 2)

G3 (CI integration) requires G1's runtime to actually exercise.

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | qa | CI integration tests: clean v4-on-npm install + clean v4-on-bun-global install; full upgrade round-trip; rollback verified |

## Execution Groups

### Group 1: v4 final release — goodbye banner + `genie v4-upgrade` subcommand

**Goal:** Ship the v4 final npm release with a goodbye banner and a working `genie v4-upgrade` subcommand that pre-flights, snapshots, exports, hands off to v5 install.sh, and reinjects via `genie import-from-v4`.

**Deliverables:**
1. `src/genie-commands/update.ts` — print goodbye banner unconditionally on `genie update`, `genie --version`, and first launch after upgrade-to-final. Banner copy from G4 lockdown.
2. `src/genie-commands/v4-upgrade.ts` — new subcommand. Steps: pre-flight checks → pgdump snapshot → Tier-A export (14 tables) → call `distribution-exodus` install.sh to download v5 → atomic symlink swap → spawn `genie import-from-v4 <bundle>` on v5 → run `genie agent sync` to regenerate Tier-B → print summary with row counts + rollback instructions.
3. Pre-flight refusal logic: query `approvals` for pending rows; query `omni_requests` for non-terminal rows; refuse with row-listing message. `runs`/`executors`/recent `sessions` warn + allow `--force`.
4. Snapshot logic: `pg_dump` of full v4 DB to `~/.genie/backups/v4-pre-upgrade-<timestamp>.pgdump`. Disk check ≥3× DB size before snapshot; refuse if snapshot fails.
5. Tier-A exporter producing `~/.genie/exports/v4-upgrade-<timestamp>.jsonl.gz` conformant to G2's bundle schema.
6. `--dry-run` flag prints planned actions without mutation.
7. Optional final step: prompt user to `npm uninstall -g @automagik/genie` (default skip; user opts in).
8. Tests: `src/genie-commands/__tests__/v4-upgrade.test.ts` — pre-flight refusal scenarios + snapshot success/failure + Tier-A export round-trip against fixture DB.

**Acceptance Criteria:**
- [ ] Goodbye banner renders unconditionally on `genie update`, `genie --version`, and first-launch after install of the final-v4 version. Cites all 2026 npm incidents with source URLs.
- [ ] `genie v4-upgrade` refuses with non-zero exit and a row-listing message when `approvals` is pending or `omni_requests` is non-terminal.
- [ ] After `genie v4-upgrade` succeeds, a pgdump snapshot exists at `~/.genie/backups/v4-pre-upgrade-<timestamp>.pgdump` and an export bundle exists at `~/.genie/exports/v4-upgrade-<timestamp>.jsonl.gz`.
- [ ] Export bundle validates against `scripts/validate-v4-bundle.ts` (G2) with exit 0.
- [ ] `genie v4-upgrade --dry-run` prints planned actions without writing to disk or DB.
- [ ] `bun test src/genie-commands/__tests__/v4-upgrade.test.ts` passes (≥10 cases covering pre-flight refusal, snapshot success/failure, export bundle round-trip).

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/genie-commands/__tests__/v4-upgrade.test.ts && bun run typecheck
```

**depends-on:** group-2, group-4

---

### Group 2: Bundle schema contract + validator

**Goal:** Author the frozen JSONL bundle contract that v4 exporter produces and v5 importer consumes. Ship a validator that exits 0 on conformant bundles.

**Deliverables:**
1. `docs/v5-cutover/bundle-schema.md` — human-readable spec. Defines: line format `{"schema_version":1,"table":"<name>","row":{...}}`, per-table column shapes for all 14 Tier-A tables, bundle metadata header (source-DB version, per-table row counts, generation timestamp, exporter version), forward-compat rules (extra fields ignored, missing required fields refused).
2. `docs/v5-cutover/bundle-schema.json` — JSON Schema (draft-07) covering bundle metadata header + per-table row schemas. Mirrors what postgres-introspection of v4-final yields for the 14 Tier-A tables.
3. `scripts/validate-v4-bundle.ts` — reads a `.jsonl.gz` bundle, validates header + every line against `bundle-schema.json`. Exit 0 on success; exit codes 2 (schema violation), 3 (missing required), 4 (unknown table), 5 (corrupt gzip).
4. `scripts/__tests__/validate-v4-bundle.test.ts` — fixtures for: known-good bundle, schema-violating bundle (each error code triggered), corrupt-gzip bundle.

**Acceptance Criteria:**
- [ ] Spec document covers all 14 Tier-A tables with their column lists.
- [ ] JSON Schema validates known-good fixture (exit 0) and rejects each error class with the documented exit code.
- [ ] Test fixtures exist for every documented exit code path.
- [ ] Spec is explicitly versioned (`schema_version: 1`) and forward-compat rules are stated.
- [ ] **Schema-vs-reality validation:** for every Tier-A table, the JSON Schema column definitions match what `\d+ <table>` returns on the v4-final migration HEAD. A test (`scripts/__tests__/schema-vs-postgres.test.ts`) introspects each table from a freshly-migrated v4 DB fixture and asserts each column's name + postgres type + nullability matches the JSON Schema. This catches schema drift between spec authoring and v4-final ship — without it, drift only surfaces in G3 integration.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test scripts/__tests__/validate-v4-bundle.test.ts && bun scripts/validate-v4-bundle.ts scripts/__tests__/fixtures/v4-bundle-good.jsonl.gz
```

**depends-on:** none

---

### Group 3: CI integration tests — full upgrade round-trip

**Goal:** Gate every v4-final release-candidate behind a CI integration test that exercises the full v4-on-npm and v4-on-bun-global → v5-on-CDN upgrade path end-to-end.

**Deliverables:**
1. `.github/workflows/v4-upgrade-integration.yml` — GitHub Actions matrix workflow. Jobs: `v4-from-npm` (clean container, `npm install -g @automagik/genie@<rc-version>`), `v4-from-bun-global` (clean container, `bun add -g @automagik/genie@<rc-version>`).
2. `tests/integration/v4-upgrade.sh` — common test driver. Seeds a representative DB fixture (Tier-A populated with synthetic data), runs `genie v4-upgrade`, then asserts: (a) pgdump exists, (b) bundle exists and validates, (c) v5 binary installed at expected path with correct cosign signature, (d) Tier-A row counts preserved post-import, (e) Tier-B regenerated via `genie agent sync`, (f) `pg_restore` from the snapshot brings v4 back online.
3. `tests/integration/fixtures/v4-db-seed.sql` — synthetic Tier-A data covering edge cases (empty tags, large board with many columns, wish row with unicode, scheduled trigger with cron expression).
4. CI gates v4 final release tag — workflow must pass on the release branch before tagging.

**Acceptance Criteria:**
- [ ] Workflow runs on PRs to release branches; all matrix jobs (npm, bun-global) pass on a known-good v4-final candidate.
- [ ] Test driver exercises all 6 assertions (a–f) and exits non-zero with a clear message on any failure.
- [ ] Seed fixture covers Tier-A edge cases (empty/null/large/unicode/cron).
- [ ] A deliberately-broken `genie v4-upgrade` (e.g., skip snapshot) fails the workflow with the right assertion error.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bash tests/integration/v4-upgrade.sh --self-test
```

**depends-on:** group-1

---

### Group 4: `npm deprecate` automation + rollback runbook + banner copy lockdown

**Goal:** Lock in operational artifacts that ship alongside v4 final and v5 GA — the deprecation hook on the npm side, the rollback runbook for users who hit trouble, and the final goodbye-banner copy with all citation hyperlinks.

**Deliverables:**
1. `.github/workflows/npm-deprecate-on-v5-ga.yml` — manually-triggered workflow (`workflow_dispatch`) that calls `npm deprecate @automagik/genie@'>=4.0.0 <5.0.0'` with deprecation message pointing to `get.automagik.dev/genie`. Requires `NPM_TOKEN` secret. Includes `--dry-run` mode for testing.
2. `docs/v5-cutover/rollback.md` — single-page runbook. Sections: "When to roll back," "Pre-flight (verify pgdump exists)," "Step 1: reinstall v4 final," "Step 2: pg_restore from snapshot," "Step 3: verify v4 functional," "Known issues / FAQ." Copy-pasteable commands. Tested manually before merge.
3. `docs/v5-cutover/goodbye-banner.md` — final banner copy lockdown. Includes the ASCII art frame from DRAFT.md §D1, citation hyperlinks for each cited 2026 npm incident (Axios RAT, Shai-Hulud / CanisterSprawl worm, SAP package compromises, 36 malicious Strapi plugins, automagik typosquat — full source list enumerated in this file at lockdown time, one or more URLs per incident as appropriate), and the `genie v4-upgrade` recommended path. Used as the source-of-truth for G1's banner-rendering code.
4. `scripts/test-npm-deprecate.sh` — dry-run validation script that exercises the deprecate workflow against a test npm package (not the real one).

**Acceptance Criteria:**
- [ ] `npm-deprecate-on-v5-ga.yml` parses successfully (`actionlint`); dry-run mode produces correct `npm deprecate` command without invoking it.
- [ ] Rollback runbook is reviewed by one human + tested manually on a development install (does the documented sequence actually restore a v4 install?). Time-to-rollback measured and documented.
- [ ] Goodbye-banner copy enumerates every cited incident with at least one citation hyperlink each (verified by URL link-check) and the recommended `genie v4-upgrade` invocation. The exact citation count is locked in `docs/v5-cutover/goodbye-banner.md` at this group's ship time and consumed verbatim by G1.
- [ ] `bash scripts/test-npm-deprecate.sh --dry-run` exits 0 and prints the deprecate command that would run.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && actionlint .github/workflows/npm-deprecate-on-v5-ga.yml && bash scripts/test-npm-deprecate.sh --dry-run
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional — On a clean v4-on-npm install, `genie update` and `genie --version` print the goodbye banner with all citation hyperlinks resolvable.
- [ ] Functional — `genie v4-upgrade --dry-run` on a representative DB lists planned actions (snapshot path, export path, install URL, post-install commands) without writing to disk or mutating the DB.
- [ ] Integration — Full `genie v4-upgrade` round-trip on a fixture DB lands a working v5 install with Tier-A row counts preserved and Tier-B regenerated via `genie agent sync`.
- [ ] Integration — Rollback runbook executed manually after a v4-upgrade restores a working v4 install with the original DB state.
- [ ] Regression — `genie update` on a non-final v4 version (i.e., not the final release) behaves as it does today (no banner, no v4-upgrade prompt). Banner is gated to the final-v4 version only.
- [ ] Regression — Existing v4 commands (`genie task`, `genie agent`, `genie wish`, etc.) function unchanged on the v4 final release.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **R1 — Tier-A export shape drifts between v4 final and v5 import** | High | G2 ships frozen contract spec + JSON Schema + validator. v5 importer consumes the spec without modification. CI integration test (G3) catches drift before v5 GA. |
| **R2 — User runs `genie v4-upgrade` with in-flight approvals/omni_requests** | High | Pre-flight refusal (D5). Refusal message lists offending rows with primary keys + a one-liner to drain each. Banner mentions "drain pending approvals first." |
| **R3 — pgdump snapshot fails (disk full, perms, pg_dump missing)** | High | Pre-flight disk check ≥3× DB size. Refuse upgrade if `pg_dump` not on PATH. Refuse if snapshot file size is suspiciously small post-creation. |
| **R4 — User stays on 4.x indefinitely, never sees banner** | Medium | Banner unconditional on three entry points. `npm deprecate` at v5 GA gives second visibility (npm prints deprecation warning on every install/update). |
| **R5 — Both v4 (npm-installed) and v5 (CDN-installed) on PATH simultaneously** | Medium | `genie v4-upgrade` step 9 offers `npm uninstall -g`. v5 install.sh warns if v4 npm install detected at a higher PATH precedence. |
| **R6 — `triggers` table user-config vs runtime ambiguity** | Low | Verify in G2 spec authoring; default to migrate (safe direction). Document the verification finding in `docs/v5-cutover/bundle-schema.md`. |
| **R7 — Filesystem source-of-truth assumption breaks for an edge-case agent or team config** | Low | Tier-B regenerated by existing `genie agent sync`; if it fails for any agent, log + continue (don't block v5 upgrade on agent regen). User can re-run `genie agent sync` manually. |
| **R8 — `distribution-exodus` ships late and `v4-upgrade` has no install.sh to call** | High | Cross-wish dependency captured below. v4-upgrade depends-on distribution-exodus completion. Coordinate ship sequence in umbrella roadmap. |
| **R9 — v5 import-from-v4 implementation drifts from G2 spec** | High | v5 backend wish depends-on this wish's bundle-schema spec. CI integration test (G3) exercises both sides; failure fails the v5 release. |

---

## Dependencies

- **depends-on: `distribution-exodus`** — CDN + install.sh + cosign verification stack must be operational before `v4-upgrade` can call install.sh. Cross-wish blocker.
- **depends-on: v5 backend wish (`genie import-from-v4` subcommand)** — separate wish, slug TBD. v5's import side consumes this wish's bundle-schema contract (G2). Coordination required at v5 GA.
- **blocks: v5 GA** — cannot ship v5 GA without `v4-upgrade` tested end-to-end (G3 must pass).
- **blocks: `npm deprecate` action firing** — G4 workflow only fires at v5 GA; depends on this whole wish shipping.

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# Create
.github/workflows/npm-deprecate-on-v5-ga.yml
.github/workflows/v4-upgrade-integration.yml
docs/v5-cutover/bundle-schema.md
docs/v5-cutover/bundle-schema.json
docs/v5-cutover/goodbye-banner.md
docs/v5-cutover/rollback.md
scripts/__tests__/fixtures/v4-bundle-good.jsonl.gz
scripts/__tests__/schema-vs-postgres.test.ts
scripts/__tests__/validate-v4-bundle.test.ts
scripts/test-npm-deprecate.sh
scripts/validate-v4-bundle.ts
src/genie-commands/__tests__/v4-upgrade.test.ts
src/genie-commands/v4-upgrade.ts
tests/integration/fixtures/v4-db-seed.sql
tests/integration/v4-upgrade.sh

# Modify
src/genie-commands/update.ts          # add goodbye banner gating
src/genie.ts                          # register v4-upgrade subcommand
```
