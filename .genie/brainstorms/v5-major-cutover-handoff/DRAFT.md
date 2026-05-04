# Brainstorm DRAFT: Genie v5 Major Cutover Handoff

| Field | Value |
|-------|-------|
| **Slug** | `v5-major-cutover-handoff` |
| **Date** | 2026-05-04 |
| **Status** | DRAFT (active) |
| **WRS** | 30/100 |
| **Umbrella** | [aegis-distribution-sovereignty](../aegis-distribution-sovereignty/DESIGN.md) — likely Wave 1 / 2 scope-add, exact relationship TBD |
| **Sibling wishes (existing)** | [distribution-exodus](../../wishes/distribution-exodus/WISH.md), [genie-self-update](../../wishes/genie-self-update/WISH.md) |

---

## Problem

Genie v5 ships as a clean restart on the new CDN distribution channel (off npm). Users currently on 4.x receive updates via `genie update` reading from npm. Without a deliberate cutover plan, 4.x users are stranded on npm — `genie update` keeps them on 4.x forever and never reveals v5 exists on the new channel. The `genie-self-update` wish covers within-major channel-aware updates but **explicitly excludes** npm path changes; `distribution-exodus` covers the CDN exit but **assumed v4 was the artifact that moved**, not that v5 is the cutover event.

This brainstorm decides the cross-major handoff: how a 4.x-on-npm install discovers, fetches, and migrates to 5.x-on-CDN.

## Settled context (from prior decisions)

- **v5 architecture (council 2026-05-04):** flatten migrations + raw SQL + `kysely` query builder + codegen. No Drizzle. No in-place DB migration — old DB has tasks **extracted then reinjected** into v5 schema.
- **v5 distribution:** off npm, on CDN (matches `distribution-exodus` plan: cdn.automagik.dev / get.automagik.dev, cosign + SLSA, per-platform binaries via `bun build --compile`).
- **v5 is the moment we leave npm** (user statement 2026-05-04). This may *redefine* the distribution-exodus wish's premise (which assumed v4 was the moving artifact).
- **Existing infra patterns:** autopg has shipped per-platform binary tarballs (#188), CDN publish workflow (#191/#192/#193/#194), install.sh ≤80 lines (#196), install binary subcommand (#197). These templates apply.
- **Existing `genie update` command:** `src/genie-commands/update.ts` (1059 LOC). Today reads from npm.

## Decisions locked

### D1 — Sequencing = Option A: v5 launches CDN-only ✅

**v5 is the first thing on CDN. v4 stays on npm forever, frozen. Final 4.x release ships a goodbye banner.**

Rationale: matches user intent ("truly a clean restart, we leave npm at v5"). Distribution-exodus wish gets retargeted from "v4 cutover" to "v5 launch infrastructure." No v4-on-CDN intermediate state.

**Justification material for goodbye banner — 2026 npm registry incidents:**
- **Axios compromise** (Mar 31, 2026) — RAT shipped via npm to a 100M weekly-download HTTP client. Attributed to UNC1069, North Korea-nexus. ([Google Threat Intelligence Group](https://cloud.google.com/blog/topics/threat-intelligence/north-korea-threat-actor-targets-axios-npm-package), [Sophos](https://www.sophos.com/en-us/blog/axios-npm-package-compromised-to-deploy-malware), [Talos](https://blog.talosintelligence.com/axois-npm-supply-chain-incident/))
- **CanisterSprawl / Shai-Hulud worm** (Apr 22, 2026) — self-propagating supply-chain worm using stolen npm tokens to backdoor packages via postinstall hooks. ([The Hacker News](https://thehackernews.com/2026/04/self-propagating-supply-chain-worm.html), [The Register](https://www.theregister.com/2026/04/22/another_npm_supply_chain_attack/))
- **Mini Shai-Hulud / Bitwarden CLI typosquat** (Apr 29, 2026) — `@bitwarden/cli@2026.4.0` impersonator stole cloud-provider + CI credentials, self-propagated by backdooring every package the victim could publish.
- **SAP package compromise** (Apr 2026) — `@cap-js/sqlite`, `@cap-js/postgres`, `@cap-js/db-service`, `mbt` shipped credential stealers. ([The Hacker News](https://thehackernews.com/2026/04/sap-npm-packages-compromised-by-mini.html))
- **36 malicious Strapi-plugin packages** (Apr 2026) — postinstall hooks deploying Redis/PostgreSQL exploit + persistent implant. ([The Hacker News](https://thehackernews.com/2026/04/36-malicious-npm-packages-exploited.html))
- **Direct relevance — automagik typosquat:** InfoWorld reported "Malicious pgserve, automagik developer tools found in npm registry." ([InfoWorld](https://www.infoworld.com/article/4162198/malicious-pgserve-automagik-developer-tools-found-in-npm-registry.html)) The npm channel was actively being exploited against *our* package namespace.

**Goodbye banner draft (final 4.x npm release):**

```
╭─────────────────────────────────────────────────────────────────╮
│  Genie has left npm.                                            │
│                                                                 │
│  v5 ships exclusively from our own CDN, signed end-to-end with  │
│  cosign + SLSA L3 + SHA256 verification at install time.        │
│                                                                 │
│  Why we left:                                                   │
│   • npm was the vector for Axios RAT (Mar 2026), Shai-Hulud     │
│     self-propagating worm (Apr 2026), SAP package compromises   │
│     (Apr 2026), and a typosquat targeting automagik directly.   │
│   • npm cannot enforce maintainer-side signatures or block      │
│     postinstall scripts in transitive deps.                     │
│   • We can. So we did.                                          │
│                                                                 │
│  Upgrade now (recommended):                                     │
│    genie v4-upgrade                                             │
│                                                                 │
│  This snapshots your DB, exports your tasks/boards/projects,    │
│  installs v5 from the CDN, and reinjects everything.            │
│  Rollback path documented if you need to revert.                │
│                                                                 │
│  Or fresh install (no v4 data carry-over):                      │
│    curl -fsSL get.automagik.dev/genie | bash                    │
│                                                                 │
│  This 4.x install on npm keeps working until you run v4-upgrade │
│  or uninstall it. It will never auto-upgrade itself.            │
╰─────────────────────────────────────────────────────────────────╯
```

(Exact copy refines in wish; this is the spirit + the citations.)

### D2 — Migration verb = `genie v4-upgrade` on v4 final release ✅

**v4 hands forward, v5 does not reach back.** The final 4.x npm release is **not frozen** — it ships:
1. All current dev-branch fixes (last v4 release reflects best v4 state).
2. The goodbye banner shown on `genie update` / `genie --version` / first run after install.
3. **A new subcommand `genie v4-upgrade`** — the canonical path from v4 to v5.

`genie v4-upgrade` flow (sketch):
1. Pre-flight: confirm pgserve up + v4 schema head (currently 067-ish post-recent migrations) + free disk + acknowledged user consent.
2. **Snapshot** v4 DB → `~/.genie/backups/v4-pre-upgrade-<timestamp>.pgdump` (rollback floor).
3. **Export** user-content tables → portable JSONL bundle at `~/.genie/exports/v4-upgrade-<timestamp>.jsonl.gz`.
4. **Download v5** from CDN via the `distribution-exodus` install.sh path (cosign + SLSA verified).
5. **Install v5** to `~/.local/bin/genie` (atomic symlink swap, per `distribution-exodus`).
6. **Handoff:** spawn `genie import-from-v4 <bundle-path>` so v5 reinjects the user content into its fresh schema.
7. Print summary + rollback instructions if anything looks off.

Why on v4 not v5:
- v4 already has the live DB connection + schema knowledge. Reading v4 from v5 means embedding v4 schema in v5 (bad — v5 is a clean restart).
- v4 owns the source of truth at upgrade time; making v4 author the export is correct asymmetry.
- v5's `import-from-v4` only needs to consume a portable bundle — no v4 schema knowledge in v5 code.

### Open questions (not yet decided)

### Q2 — `genie update` behavior on 4.x-on-npm when v5 is live ✅ (resolved by D1)

**Resolved:** banner-only. `genie update` on 4.x continues to do whatever it does today (intra-4.x update from npm) but **prints the goodbye banner first** when running on the final 4.x version — or unconditionally when running with `--check`. No auto-migration logic shipped to 4.x.

Sub-decision: does the banner print on **every** `genie update` invocation post-cutover, or only on the final-frozen 4.x release? **Recommendation: only the final-frozen release prints unconditionally; earlier versions print only if `npm view @automagik/genie deprecated` returns the deprecation flag (which we set on the final release).** Avoids retroactively annoying mid-4.x users. Confirm in wish.

### Q3 — Channel discovery from 4.x ✅ (resolved by D1)

**Resolved:** hardcoded URL in the goodbye banner: `curl -fsSL get.automagik.dev/genie | bash`. No dynamic endpoint query needed — v4 doesn't try to know what v5 is, just where to find it. The CDN's own manifest layer (per `distribution-exodus`) handles version negotiation from there.

### Q4 ✅ resolved by D2

### D3 — Export contract: definitive table-by-table list ✅

**Principle (user-stated 2026-05-04):** *Filesystem is source of truth most of the time. DB is migrated only when it is the sole home of user-authored content.*

Full v4 schema (47 tables, enumerated from `grep ^CREATE TABLE migrations/*.sql`) classified:

#### Tier A — MIGRATE (DB is the sole home of user labor)

| Table | Why | FS source? |
|-------|-----|------------|
| `tasks` | Task records — title, body, state, priority. Pure user content. | None |
| `task_actors` | Who is assigned to which task. | None |
| `task_dependencies` | Task graph (blocks/blocked-by). | None |
| `task_stage_log` | Task stage history (audit trail of state changes). | None |
| `task_tags` | Many-to-many task↔tag links. | None |
| `tags` | Tag dictionary. | None |
| `task_types` | Custom task type definitions. | None |
| `projects` | Project records. | None |
| `boards` | Board layouts (columns, lanes, view config). | None |
| `board_templates` | User-saved board templates. | None |
| `wishes` | Wish metadata row (status, dates, assignment links). The WISH.md FILE survives via git; **the row metadata does not.** | Partial (file is content, row is metadata) |
| `schedules` | User-defined recurring schedules. | None |
| `notification_preferences` | User-set notification rules. | None |
| `triggers` | User-configured automation triggers. **VERIFY** in wish whether this table holds user-config or runtime-trigger state — migrate if user-config. | Verify |

**Total: 14 tables. Small, well-bounded export bundle.**

#### Tier B — REGENERATE from filesystem on v5 first run

| Table | Filesystem source |
|-------|-------------------|
| `agents` | `.genie/agents/<name>/` directories — prompt, config, MEMORY |
| `agent_templates` | Code-bundled templates (re-seeded by v5 install) |
| `agent_checkpoints` | Per-agent state files |
| `agent_projects` | Re-derived from `.genie/agents/<name>/` config + project files |
| `teams` | `~/.claude/teams/<name>/config.json` (file-backed) |
| `team_chat` | Empty on v5 first run; re-emerges as teams chat |

**Mechanism: v5's `genie agent sync` (already exists) reads FS and rebuilds the registry. Run automatically as last step of `genie v4-upgrade` after import.**

#### Tier C — DO NOT MIGRATE (operational / runtime / preserved only in pgdump backup)

| Table | Why |
|-------|-----|
| `sessions`, `session_content`, `session_sync` | Runtime agent sessions; v5 starts fresh |
| `genie_runtime_events`, `_audit`, `_debug` | Telemetry partitions, huge, transient |
| `tool_events` | Telemetry |
| `audit_events` | Historical record; preserved in pgdump backup, not migrated live |
| `genie_audit_chain_keys`, `genie_events_redaction_keys`, `genie_events_revocations` | Operational keys; v5 generates fresh |
| `genie_bridge_sessions` | Runtime bridges |
| `omni_requests` | In-flight Omni; refuse v4-upgrade if any are open |
| `approvals` | In-flight approvals; refuse v4-upgrade if any are pending |
| `mailbox` | Transient messages |
| `heartbeats` | Runtime liveness signals |
| `machine_snapshots` | Debug snapshots |
| `runs` | Runtime executor records |
| `executors` | Runtime executor registry |
| `assignments` | Runtime allocation table |
| `conversations`, `conversation_members`, `messages` | Claude conversation runtime state |
| `installed_apps`, `app_versions` | Deprecated app store (018 dropped `app_store`) |
| `organizations` | Recreated if used — verify |

#### Pre-flight refusal conditions for `genie v4-upgrade`

- Any rows in `approvals` with status='pending' → refuse, list them, ask user to resolve.
- Any rows in `omni_requests` not in terminal state → refuse, ask user to drain.
- Any rows in `runs`/`executors` marked active → warn, allow `--force`.
- Active session rows newer than 5min → warn (probably stale), allow `--force`.

#### Filesystem assets that survive automatically (no action needed)

- `.genie/wishes/<slug>/WISH.md` — git-tracked
- `.genie/brainstorms/<slug>/DRAFT.md` + `DESIGN.md` — git-tracked
- `.genie/agents/<name>/` — git-tracked or workspace-local
- `.genie/skills/<name>/` — files
- `brain/memory/` — files
- `~/.claude/teams/<name>/` — user home
- `~/.genie/config.json` — user home (may need version-bump migration handled by v5 first-run)
- Workspace `dir add` history → user re-runs (small, recreatable)

#### Open verifications (to settle in wish, not blocking crystallize)

1. `triggers` table: user-config or runtime state?
2. `messages` table: user-content (Claude conversations) or operational mailbox?
3. `organizations` table: live or vestigial?

### Q6 — Filesystem layout transition (post-v4-upgrade)

After `genie v4-upgrade` completes, the v4 npm binary is still on disk. Options:
- v5 install warns and lets user choose to `npm uninstall -g @automagik/genie` themselves.
- v5 install runs `npm uninstall -g @automagik/genie` automatically as last step of `genie v4-upgrade`.
- Symlinks: ensure `~/.local/bin/genie` (v5) takes precedence in PATH; warn if a `genie4` binary remains.

### Q7 — Rollback story

- `genie v4-upgrade` produces `~/.genie/backups/v4-pre-upgrade-<timestamp>.pgdump` as floor.
- Documented rollback: `npm install -g @automagik/genie@<last-v4>` + `pg_restore` from the snapshot.
- Should `genie v4-upgrade` print the rollback instructions on completion or only on failure?

### Q8 — Communication / timeline

- v4-final + v5-GA same day, or v4-final ships the banner first (people see "v5 coming soon"), then v5-GA a week later?
- Beta channel for v5 via CDN's `beta` channel? Early adopters can `curl -fsSL get.automagik.dev/genie?channel=beta | bash`.
- When does `npm deprecate @automagik/genie` get called? On v4-final ship, or on v5 GA?

## Constraints / assumptions

- v5 launch date is TBD (post-council, this brainstorm precedes wish).
- distribution-exodus + genie-self-update are DRAFT, can be retargeted.
- `aegis-distribution-sovereignty` umbrella DESIGN may need scope amendment if Q1 lands on Option A.
- npm package `@automagik/genie` is currently the only install channel; user base on it is small but non-zero.

## Risks (initial)

- **R1 — User data loss.** Extract/reinject mismatches between v4 and v5 schemas could lose tasks. Severity: **HIGH** if no backup-before-upgrade. Mitigation: mandatory `pg_dump` snapshot before reinjection.
- **R2 — Stranded 4.x users.** If communication is weak and `genie update` does nothing visible, users sit on 4.x indefinitely. Severity: **MEDIUM** for project momentum.
- **R3 — Distribution-exodus rewrite.** Q1=Option A means redrafting the v4-cutover wish into a v5-launch wish. Severity: **MEDIUM** scope/timeline impact.
- **R4 — Schema drift between extract and reinject.** v4's `tasks` table shape vs v5's. If v5 reinjector can't accept a v4 export shape, users hit a hard wall. Severity: **HIGH**. Mitigation: freeze v4 export schema before v5 launches.
- **R5 — Two binaries on PATH.** If v5 install doesn't clean up npm install, `which genie` is non-deterministic. Severity: **MEDIUM**. Mitigation: install.sh detects + warns.

## Success criteria (initial — not all settled)

- [ ] A 4.x user running `genie update` learns about v5 and gets a one-command path to migrate.
- [ ] Tasks are preserved across the v4→v5 boundary (no data loss).
- [ ] Rollback path documented (even if just "reinstall v4 from npm + restore pg_dump").
- [ ] One filesystem location for the active genie binary post-cutover (no PATH ambiguity).
- [ ] Bridge release tested on a clean v4-on-npm install + clean v4-on-bun install before v5 GA.

## Scope-size check

This brainstorm touches: 4.x npm shim, CDN install path, extract/reinject (database), v5 installer behavior, communication. All bound by single user journey "v4 user → v5 user." **Single cohesive project — proceeding.**

Out of this brainstorm: extract/reinject *implementation details* (schema mapping, transactional safety) — those live in a sibling wish driven by the v5 schema work itself. This brainstorm decides *where* the extract/reinject lives and *who* runs it, not the SQL.

**Sibling brainstorm proposed: `v5-schema-deadwood-sweep`** — static + runtime sweep of 47 v4 tables and their columns to identify dead schema. Output = kill-list, input to v5 bootstrap.sql. Separable workstream; shared timing but distinct deliverable. Static-sweep preliminary results captured below for reference.

**Council finding 2026-05-04: CDN posture for v5 launch.** Council deliberation (deployer + operator + sentinel + simplifier, unanimous) recommends amending `distribution-exodus` from "Cloudflare primary + Fastly secondary + GitHub Releases tertiary" to **"Cloudflare primary + GitHub Releases tertiary; defer Fastly."** Key insight (sentinel): multi-CDN closes zero security attack classes that cosign+SLSA doesn't already close, AND introduces a downgrade-attack class (Cloudflare serves binary-A signed-valid, Fastly serves binary-B signed-valid-but-stale-with-CVE — verifier passes both) without compensating controls (Rekor monitoring, TUF timestamps). Fastly is also fictional today (no account). Real ROI lives in: secondary DNS provider, Rekor transparency log monitoring, cosign signing key hardening, tested CF-down → GitHub Releases runbook. Trigger to revisit Fastly: a real Cloudflare outage that demonstrably blocks real genie users.

### Static sweep snapshot (2026-05-04)

47 tables in v4 schema. Tier-A migration list (D3) is unaffected by deletion candidates — none of the 14 migrating tables are in the dead/low-usage set.

**🚨 Likely dead (5 tables, 0–2 src refs):**
`app_store`, `app_versions`, `installed_apps`, `organizations`, `agent_projects`, `agent_checkpoints`

**⚠️ Low usage (10 tables, 4–9 src refs — need runtime confirmation):**
`genie_audit_chain_keys`, `genie_events_redaction_keys`, `genie_events_revocations`, `genie_runtime_events_debug`, `notification_preferences`, `task_stage_log`, `task_tags`, `team_chat`, `session_sync`, `machine_snapshots`

Full sibling brainstorm scope: static + runtime + column-level sweep, kill-list output. Reference command for static sweep is preserved in this DRAFT (executable in repo root).

---

## WRS

```
WRS: █████████░ 90/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ▓
```

- Problem ✅ — locked.
- Scope ✅ — locked (D1 = Option A; v4 final-on-npm + v5 CDN-only).
- Decisions ✅ — D1 (sequencing) + D2 (`genie v4-upgrade` on v4) + D3 (table-by-table export contract). Q6 (filesystem coexistence), Q7 (rollback details), Q8 (timeline) are wish-level operational details, not brainstorm forks.
- Risks ✅ — R1–R5 named; mitigations clear (mandatory pgdump backup, refusal conditions for in-flight state, agent-sync regenerates from FS).
- Criteria ▓ — drafted; need final user confirm before crystallize.

## Conversation log

(Populated during brainstorm exchanges.)
