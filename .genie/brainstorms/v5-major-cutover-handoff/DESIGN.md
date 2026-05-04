# Design: Genie v5 Major Cutover Handoff

| Field | Value |
|-------|-------|
| **Slug** | `v5-major-cutover-handoff` |
| **Date** | 2026-05-04 |
| **WRS** | 100/100 |
| **Status** | CRYSTALLIZED |
| **Umbrella** | [aegis-distribution-sovereignty](../aegis-distribution-sovereignty/DESIGN.md) — scope amendment to Wave 1/2 |
| **Sibling wishes (existing)** | [distribution-exodus](../../wishes/distribution-exodus/WISH.md), [genie-self-update](../../wishes/genie-self-update/WISH.md) |
| **Sibling brainstorm (proposed)** | `v5-schema-deadwood-sweep` (separate brainstorm; static-sweep snapshot included here for reference) |

## Problem

Genie v5 ships as a clean restart on the new CDN distribution channel (off npm). Users on 4.x receive updates via `genie update` reading from npm. Without a deliberate cutover plan, 4.x users are stranded — `genie update` keeps them on 4.x forever and never reveals v5 exists. The existing wishes assume different premises: `distribution-exodus` assumed v4 was the moving artifact; `genie-self-update` explicitly excludes npm path changes. Neither covers the cross-major handoff that v5 launch requires.

## Scope

### IN

**A — v5 launches CDN-only (Option A sequencing)**
- distribution-exodus is repurposed: it ships the CDN + install.sh + cosign/SLSA infrastructure as v5's launch vehicle, not as a v4 cutover. v4 never appears on CDN.
- v5 binary is the first artifact published to `cdn.automagik.dev/genie/stable/`.

**B — Final v4 release on npm (`@automagik/genie@4.x.final`)**
- Includes all current dev-branch fixes (not a frozen point-in-time release; ships best-of-v4 state).
- Ships a goodbye banner shown unconditionally on `genie update`, `genie --version`, and first-launch-after-install of this version. Banner cites 2026 npm incidents (Axios RAT, Shai-Hulud worm, SAP packages, automagik typosquat) as justification and points to `genie v4-upgrade`.
- Ships the new `genie v4-upgrade` subcommand (described in C).
- After this version, no further v4.x patches ship on npm. `npm deprecate @automagik/genie` is called at v5 GA.

**C — `genie v4-upgrade` subcommand on v4**
The canonical path from v4 to v5. Lives on v4 (it has the live v4 DB connection + schema). Steps:
1. **Pre-flight checks:**
   - pgserve up; v4 schema head matches expected (last v4 migration applied).
   - Refuse if any `approvals` rows are pending. List them. Exit non-zero.
   - Refuse if any `omni_requests` rows are non-terminal. List them. Exit non-zero.
   - Warn (allow `--force`) if `runs`/`executors` show active rows or any `sessions` row newer than 5 minutes.
   - Disk space ≥3× v4 DB size (snapshot + export breathing room).
2. **Snapshot:** `pg_dump` of full v4 DB → `~/.genie/backups/v4-pre-upgrade-<timestamp>.pgdump`. This is the rollback floor.
3. **Export:** Tier-A tables only (see "Export contract") → `~/.genie/exports/v4-upgrade-<timestamp>.jsonl.gz`. Each line is `{"table": "tasks", "row": {...}}`.
4. **Download v5:** invoke the `distribution-exodus` install.sh path. Cosign + SLSA L3 + SHA256 verified. Refuse on signature failure (unless `INSECURE=1`).
5. **Install v5:** atomic symlink swap to `~/.local/bin/genie` (per `distribution-exodus`).
6. **Handoff:** spawn `genie import-from-v4 <bundle-path>` so v5's import path reinjects Tier-A content into its fresh schema. v5's import path is owned by v5 code and can evolve.
7. **Regenerate Tier-B from filesystem:** v5 first-run (or `genie agent sync` invoked by import-from-v4) reads `.genie/agents/`, `.genie/skills/`, `~/.claude/teams/`, `~/.genie/config.json`, etc., and rebuilds the registry tables.
8. **Summary:** print row counts (exported vs reinjected), Tier-B regenerated count, snapshot path, rollback instructions, and next steps.
9. **Optional cleanup:** offer to `npm uninstall -g @automagik/genie` interactively at the end (default: skip, ask user).

**D — Export contract (Tier-A) — 14 tables**

| Table | Why migrated |
|-------|--------------|
| `tasks` | Pure user content |
| `task_actors` | Task assignments |
| `task_dependencies` | Task graph |
| `task_stage_log` | Task stage history |
| `task_tags` | Task↔tag links |
| `tags` | Tag dictionary |
| `task_types` | Custom task types |
| `projects` | Project records |
| `boards` | Board layouts |
| `board_templates` | User-saved templates |
| `wishes` | Wish metadata row (WISH.md file content survives via git) |
| `schedules` | User-defined recurring schedules |
| `notification_preferences` | User-set notification rules |
| `triggers` | User-configured automations *(verify in wish: confirm user-config vs runtime-state)* |

**E — Tier-B regeneration — 6 tables (filesystem source-of-truth)**

`agents`, `agent_templates`, `agent_checkpoints`, `agent_projects`, `teams`, `team_chat` — rebuilt from `.genie/agents/`, code-bundled templates, and `~/.claude/teams/`.

**F — Tier-C explicit-skip — 27 tables**

Operational, runtime, security keys, in-flight queues, deprecated app-store. Preserved only in the pgdump snapshot (Step 2). Listed exhaustively in DRAFT.md.

**G — Goodbye banner (final v4 npm release)**

Shown unconditionally on `genie update`, `genie --version`, first launch after upgrade-to-final-v4. Cites:
- Axios RAT compromise (Mar 31, 2026)
- Shai-Hulud / CanisterSprawl self-propagating worm (Apr 22, 2026)
- SAP package compromise (Apr 2026)
- 36 malicious Strapi-plugin packages (Apr 2026)
- automagik typosquat in npm (InfoWorld report)

Banner copy in DRAFT.md §D1; refines in wish.

### OUT

- **DB schema dead-wood sweep** — separable workstream owned by sibling brainstorm `v5-schema-deadwood-sweep`. Static-sweep preliminary snapshot included in DRAFT.md for seed.
- **v5 schema bootstrap SQL authoring** — owned by the v5 backend wish; this brainstorm decides only what content reaches v5 via Tier-A export.
- **Within-major auto-update (`genie self-update --channel`)** — owned by sibling wish `genie-self-update`. v5's self-update across patches/minors is unaffected by this cutover.
- **CDN/install.sh/cosign/SLSA infrastructure** — owned by `distribution-exodus`. This brainstorm consumes that infrastructure; does not author it.
- **Aegis daemon distribution** — owned by sibling wishes `aegis-runtime` and `aegis-scanner` in the umbrella.
- **Native Windows distribution** — deferred to v2 per umbrella platform matrix.
- **Anti-rollback enforcement** (refusing rollback to a known-bad version) — out for v1.

## Approach

**Three-phase release sequence:**
1. Ship v4 final release on npm with goodbye banner + `genie v4-upgrade` subcommand. `npm deprecate` deferred until step 3.
2. Ship v5 to CDN via `distribution-exodus` install.sh path. Beta channel available (`channel=beta`) for early adopters who want to migrate ahead.
3. At v5 GA: call `npm deprecate @automagik/genie` with the goodbye-message URL pointing to `get.automagik.dev/genie`.

**Asymmetric ownership:**
- v4 owns the export (it has live DB + schema knowledge).
- v5 owns the import (it controls the destination schema; can evolve the importer without touching v4).
- The export bundle (`.jsonl.gz`) is the contract between them. Frozen at v4-final-release ship.

**Filesystem-as-source-of-truth bias** (user principle): only Tier-A tables migrate. Tier-B regenerates from filesystem on v5 first run via existing `genie agent sync`. Tier-C is preserved only in the pgdump snapshot.

**Rollback path:** documented and tested. `npm install -g @automagik/genie@<v4-final>` + `pg_restore` from `~/.genie/backups/v4-pre-upgrade-<timestamp>.pgdump`. Single-command recovery if v5 fails.

### Alternatives considered

- **Option B (v4 ships on CDN first, v5 follows)** — preserves existing wish structure but adds v4-on-CDN intermediate state nobody asked for. Rejected: slower; adds work nobody benefits from.
- **Option C (bridge-only release, no migrate command)** — final v4 prints banner, user does everything manually. Rejected: zero data-loss prevention; user has to know `pg_dump` exists.
- **Drizzle ORM adoption** — rejected upstream by council (2026-05-04). Council outcome captured separately; v5 schema uses raw SQL + Kysely query builder + codegen for typed rows.
- **In-place v4→v5 schema migration (replay)** — rejected: schemas diverge enough that the existing 61-file migration corpus is not the right path. Clean restart with extract+reinject is.
- **Auto-detect v4 from v5 install.sh** — rejected: forces v5 to embed v4 schema knowledge, violating clean-start principle.
- **Manual export + import scripts only** — rejected: too much friction; users will skip the snapshot step and lose data.

## Decisions

| Decision | Rationale |
|----------|-----------|
| **D1: v5 is CDN-only; v4 stays on npm forever** | Matches user intent ("truly a clean restart"). 2026 npm incidents (Axios RAT, Shai-Hulud, SAP, automagik typosquat) are the public justification — npm is no longer a trusted distribution channel for genie. |
| **D2: `genie v4-upgrade` lives on the v4 final release** | v4 has the live DB + schema; v5 is greenfield and should not embed v4 schema knowledge. Asymmetric ownership: v4 exports, v5 imports. |
| **D3: 14 Tier-A tables migrate; 6 Tier-B regenerate from FS; 27 Tier-C preserved only in pgdump** | Filesystem-as-source-of-truth principle. Minimal export contract = minimal frozen surface = least likely to drift. |
| **D4: Mandatory pgdump snapshot before any DB mutation** | Single-command rollback floor. Removes "did I lose my data?" anxiety from the upgrade UX. |
| **D5: Pre-flight refusal on pending in-flight state** | Refuse upgrade if `approvals` pending or `omni_requests` non-terminal — prevents silent data loss for in-flight work. `--force` allowed for runtime/session active state (might be stale). |
| **D6: Banner copy cites 2026 npm incidents** | Honest user communication. Material is grounded (Sources: GTIG/Axios, Hacker News/Shai-Hulud, The Register, InfoWorld/automagik typosquat). |
| **D7: `npm deprecate` called at v5 GA, not at v4-final ship** | v4 final users need a window to actually run `genie v4-upgrade` before npm signals "this is dead." Deprecation message points to `get.automagik.dev/genie`. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| **R1 — Tier-A export shape drifts between v4 final and v5 import** | HIGH | Bundle schema is contract; v5 importer accepts versioned bundle (`{"schema_version": 1, ...}`); CI test installs v4 final + runs full upgrade against fresh v5 before v5 GA. |
| **R2 — User runs `genie v4-upgrade` with in-flight approvals/omni** | HIGH | Pre-flight refusal (D5). Banner mentions "drain pending approvals first." |
| **R3 — pgdump snapshot fails (disk full, perms)** | HIGH | Pre-flight disk check (≥3× DB size). Refuse upgrade if snapshot fails. |
| **R4 — User stays on 4.x indefinitely, never sees banner** | MEDIUM | Banner unconditional on `genie update`/`--version`/first-launch-of-final. `npm deprecate` at v5 GA gives second visibility. |
| **R5 — Both v4 (npm-installed) and v5 (CDN-installed) on PATH simultaneously** | MEDIUM | `genie v4-upgrade` step 9 offers `npm uninstall -g`. v5 install.sh warns if v4 npm install detected. `which genie` ambiguity resolved in user-shell PATH ordering. |
| **R6 — `triggers` table user-config vs runtime ambiguity** | LOW | Verify in wish; default to migrate (safe direction). |
| **R7 — Filesystem source-of-truth assumption breaks for an edge-case agent or team config** | LOW | Tier-B regenerated by existing `genie agent sync`; if it fails for any agent, log + continue (don't block v5 upgrade on agent regen). User can re-run sync. |

## Success Criteria

- [ ] A 4.x user running `genie v4-upgrade` on a representative DB ends up on v5 with all 14 Tier-A tables intact (verified by row counts) and Tier-B regenerated via `genie agent sync`.
- [ ] A v4 pgdump snapshot exists at `~/.genie/backups/v4-pre-upgrade-<timestamp>.pgdump` after every upgrade. Rollback path tested + documented.
- [ ] Pre-flight refusal blocks upgrade when `approvals` rows are pending or `omni_requests` rows are non-terminal. Refusal message lists offending rows.
- [ ] Goodbye banner ships in v4 final release on `genie update`/`genie --version`/first-launch. Cites 2026 npm incidents with hyperlinks.
- [ ] v5 install path (called from `genie v4-upgrade`) is cosign + SLSA L3 + SHA256 verified per `distribution-exodus` contract. Refuses on verification failure unless `INSECURE=1`.
- [ ] `npm deprecate @automagik/genie` is called at v5 GA with deprecation message pointing to `get.automagik.dev/genie`.
- [ ] CI integration test exercises full path: clean v4-on-npm install → `genie v4-upgrade` → v5 ready → row-count verification. Runs on every v4 final release-candidate.
- [ ] CI integration test variant: clean v4-on-bun-global install → upgrade. Both install paths covered.
- [ ] Sibling brainstorm `v5-schema-deadwood-sweep` opened (static-sweep snapshot delivered as seed context). Output feeds v5 bootstrap.sql.

## References

**Sibling wishes (existing, retargeted by D1):**
- `distribution-exodus` — CDN + install.sh + cosign infrastructure (repurposed as v5 launch vehicle, not v4 cutover)
- `genie-self-update` — within-major channel-aware updates (unchanged, lives on v5 from day 1)

**Umbrella DESIGN:**
- [aegis-distribution-sovereignty](../aegis-distribution-sovereignty/DESIGN.md)

**v4 schema:**
- 47 distinct tables across 61 forward-only `.sql` migration files (56 distinct migration numbers — 5 collision pairs: 007/007, 010/010, 015/015, 029/029, 043/043) in `src/db/migrations/`
- Recent investment in regression-tested DDL: `061_agents_id_invariant_and_fk_lockdown.sql` + `.test.ts` (17.9K + 21.6K)

**2026 npm incidents (banner citations):**
- [North Korea Threat Actor Targets Axios NPM Package — Google Cloud](https://cloud.google.com/blog/topics/threat-intelligence/north-korea-threat-actor-targets-axios-npm-package)
- [Self-Propagating Supply Chain Worm — The Hacker News](https://thehackernews.com/2026/04/self-propagating-supply-chain-worm.html)
- [Another npm supply chain worm — The Register](https://www.theregister.com/2026/04/22/another_npm_supply_chain_attack/)
- [SAP-Related npm Packages Compromised — The Hacker News](https://thehackernews.com/2026/04/sap-npm-packages-compromised-by-mini.html)
- [36 Malicious npm Packages — The Hacker News](https://thehackernews.com/2026/04/36-malicious-npm-packages-exploited.html)
- [Malicious pgserve, automagik developer tools found in npm — InfoWorld](https://www.infoworld.com/article/4162198/malicious-pgserve-automagik-developer-tools-found-in-npm-registry.html)

**Council deliberation (foundational decision precluding Drizzle for v5):**
- Genie council 2026-05-04 — flatten migrations + raw SQL + Kysely query builder + codegen. No ORM. Captured in conversation transcript; binds v5 schema design assumptions in this brainstorm.
