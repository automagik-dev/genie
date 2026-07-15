# Wish: Routing delivery fix — `genie update` fans the pinned role agents

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS — Groups A+B **SHIP** (2026-07-12); awaiting PR/release, then Group C day-3 QA (user-gated live ritual) |
| **Slug** | `routing-delivery-fix` |
| **Date** | 2026-07-11 |
| **Author** | Felipe + team-lead session (rebaseline wish 1) |
| **Appetite** | small |
| **Branch** | `wish/routing-delivery-fix` |
| **Repos touched** | genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

The seven pinned role agents (engineer-trivial/standard/complex, fixer, reviewer, final-gate, scout)
ship only inside the genie Claude Code plugin, which is disabled — so the routing matrix's model pins
never loaded and every dispatch inherited the session's Fable-max tier. This wish makes `genie update`
(agent-sync) fan the role-agent files into `~/.claude/agents/` under the managed-stamp + backup
contract it already uses for skills, with `genie doctor` able to distinguish genie-managed agents from
merely-present files. Mechanism proven live 2026-07-11: a hand-copy into `~/.claude/agents/` surfaced
all seven as bare-named agent types in fresh and reloaded sessions.

## Scope

### IN

- agent-sync fans the canonical source's `agents/` dir into `~/.claude/agents/` on explicit
  `genie update` / `genie install`, with: managed stamp (`.genie-sync.json`,
  `managedBy: genie-agent-sync`), backup-first adoption of pre-existing unmanaged files (covers the
  2026-07-11 hand-copy), stale refresh, orphan removal of genie-stamped agents whose source vanished,
  and unmanaged (user-authored) entries never touched.
- `genie uninstall` removes only provably genie-stamped role agents (backup-first), leaving
  user-authored agents intact.
- `genie doctor` reports role-agent state: genie-managed (stamped) vs merely-present vs stale vs
  missing; warns when `enabledPlugins["genie@automagik"]` is true in `~/.claude/settings.json`
  (duplicate-surface risk: plugin `genie:*` agents + fanned bare names).
- Day-3 QA evidence: fresh-session surface check against **stamped** files (not the hand-copy) +
  LangWatch pull re-running the day-2 recipe set with the mechanical `model×effort` fingerprint check
  as the primary test.

### OUT

- Re-enabling the Claude Code plugin as a delivery path (rejected in the design).
- Codex role-agent delivery (`codex-agents/` in the plugin) — separate track, not this wish.
- Any change to the seven agent files' content (model/effort values are routing-matrix scope).
- `genie spend` (rebaseline wish 2) and the /work workflow re-platform (rebaseline wish 3).
- Windows shim/exec concerns — agent fan-out reuses the existing file-copy engine only.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Deliver via agent-sync fan-out into `~/.claude/agents/`, plugin stays disabled | Felipe-ratified 2026-07-11; bare names match the acceptance test, dir is live-watched, no duplicate listings. Reuses the shipped managed-file CONTRACT (stamp/backup/orphan semantics) but requires **new per-FILE machinery** — the existing engine is directory-oriented (per-skill dirs, stamp inside each dir) and its whole-dir replace (`writeManagedDir`) is FORBIDDEN on `~/.claude/agents/`: applied there it would delete user-authored agent files (plan-review HIGH) |
| 2 | Acceptance discriminator = the managed stamp, not file presence | The 2026-07-11 hand-copy already makes "files present + agents surface" pass; only `genie update` writing the stamp (or a clean-host QA) proves the fan-out itself (plan-review MEDIUM) |
| 3 | Doctor warns (not blocks) on enabled genie plugin | Duplicate `genie:*` + bare-name agents degrade UX but break nothing; warn + document the resolution (design Risk 7) |
| 4 | Adopt-with-backup for pre-existing files, never overwrite silently | Same contract as skills; the hand-copy must be adopted under the stamp, and user-authored agents with colliding names must be backed up before replacement, never lost |
| 5 | SessionStart remains diagnostic-only and read-only | Hook trust and workspace trust are explicit user decisions. Lifecycle hooks must not mutate global delivery state; install/update are the consented synchronization surfaces. |
| 6 | Recovery backups live beside, not inside, `GENIE_HOME` | `~/.genie-recovery/agent-sync-*` survives a full uninstall and cannot be erased with the tree whose removal it protects. |

## Success Criteria

- [ ] After `genie update`, `~/.claude/agents/` contains all seven role files AND the
      `.genie-sync.json` managed stamp (`managedBy: genie-agent-sync`); the pre-existing hand-copy is
      adopted with backups under `~/.genie-recovery/agent-sync-*`.
- [ ] Fresh session (or `/reload-plugins`) lists all seven bare-named agent types sourced from the
      stamped files (verify on this host post-update; mechanism itself already proven 2026-07-11).
- [ ] `genie doctor` output distinguishes genie-managed vs merely-present vs stale role agents, and
      emits the duplicate-surface warning when the genie plugin is enabled.
- [ ] `genie uninstall` (dry-run acceptable for QA) removes only stamped agents; an injected
      user-authored agent file survives untouched.
- [ ] `bun run check` green; `bun run wishes:lint` green.
- [ ] Day-3 LangWatch evidence recorded at `.genie/wishes/routing-matrix/qa/`: dispatched traces carry
      the pinned `model×effort` fingerprints per role (primary); Fable-share trend reported as
      directional only, with top-3-thread exclusion noted.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A | engineer-complex | 4 — agent-lifecycle/routing delivery (+2), stateful adopt/backup/orphan handling (+2); net-new per-file managed machinery mirroring the dir contract; deterministic tests exist | opus-xhigh | agents-fanout: per-file managed fan-out of `agents/` into `~/.claude/agents/` + uninstall coverage |

### Wave 2 (after A merges to the wish branch)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| B | engineer-standard | 2 — diagnostics over A's stamp format (+2 routing-adjacent surface); no state mutation, deterministic tests | opus-high | doctor-duplicate-guard: managed/present/stale reporting + enabledPlugins warning |

### Wave 3 (post-release, evidence only — user-gated live ritual)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| C | scout | 1 — bounded evidence collection with documented recipes | opus-low | day3-qa: stamped-surface check + LangWatch fingerprint pull, evidence to routing-matrix qa/ |

> Group C cannot execute in the same /work run as A+B — it gates on a released build plus Felipe's
> live update ritual. /work must treat the wish's code scope as complete after A+B ship; C stays a
> ready task until the release lands and must NOT mark the wish blocked.

## Execution Groups

### Group A: agents-fanout

**Goal:** `genie update` converges `~/.claude/agents/` from the canonical source's `agents/` dir under the same managed-stamp + backup contract as skills.

**Deliverables:**
1. agent-sync (src/lib/agent-sync.ts): extend `syncClaude()` (:471–477) to fan the source `agents/`
   dir (confirmed at `plugins/genie/agents/` in repo and live install via `resolveGenieSource()`
   :213–221) into `~/.claude/agents/` with **new per-FILE managed machinery** — the agents are flat
   `*.md` files and MUST stay flat for Claude Code discovery, so the dir-oriented engine does not
   apply. Contract (mirrors the dir contract's semantics, not its code):
   - **Manifest:** one dir-level `~/.claude/agents/.genie-sync.json` mapping
     `filename → { digest: sha256(file), version, syncedAt }` under `managedBy: 'genie-agent-sync'`
     (`SyncManifest` :179–184 field shapes reused).
   - **Create/update:** write the file + record its digest. **Adopt-with-backup:** an existing target
     file not in the manifest (the 2026-07-11 hand-copy, or a user's colliding name) is backed up via
     the `backupInto` closure pattern (:768–776 → `~/.genie-recovery/agent-sync-*`) before replacement.
   - **Orphans:** a manifest-recorded filename whose source vanished is backed-up-then-removed if its
     digest matches (unmodified); a digest-mismatched (user-edited) managed file is KEPT with an
     advisory, never deleted (semantics of `removeManagedOrphans` :418–440, per-file).
   - **User files:** any filename absent from the manifest (other than adopt-on-collision above) is
     NEVER touched. **`writeManagedDir()` (:333–343) is explicitly forbidden on `~/.claude/agents/`**
     — its whole-dir atomic replace would delete user-authored agents.
   - Target dir overridable for tests via the existing `targets` option pattern.
2. Uninstall coverage (src/genie-commands/uninstall.ts): add a **per-file** collector + classifier to
   `collectAgentSyncAssets()` (:193–208) — do NOT reuse `collectManagedSkillDirs()` (:134–155): its
   `isDirectory` gate skips flat files. Classification per manifest entry: 'clean' (digest matches →
   backup-then-remove) | 'modified' (user-edited → keep as `<name>.md.genie-kept`, preserving bytes
   while unloading it from Claude Code) | absent-from-manifest (never touched).
   `removeAgentSyncAssets()` (:232–255) stays the removal executor once collection is wired.
3. Tests (src/lib/agent-sync.test.ts — tmpdir + `GENIE_HOME` isolation): add `writeSourceAgent()`
   writing a **single `agents/<name>.md` file** (NOT a dir tree like `writeSourceSkill()` :78–82);
   extend the `setup()` fixture (:91–120) with an agents dict. Cases: fresh fan-out writes files +
   manifest; second run idempotent; adopt-with-backup over a pre-existing unmanaged copy; a
   user-authored `my-own-agent.md` is **byte-identical after sync AND after uninstall**; unmodified
   orphan backed-up-then-removed; modified managed file kept; uninstall removes only manifest-recorded
   clean files (extend src/genie-commands/uninstall.test.ts).

**Acceptance Criteria:**
- [ ] Running the sync twice is idempotent (second run reports no changes).
- [ ] A pre-existing unmanaged `scout.md` is adopted: backup exists under the sibling recovery root, file
      becomes stamped-managed.
- [ ] A user file `my-own-agent.md` in `~/.claude/agents/` survives sync and uninstall untouched.
- [ ] Deleting `scout.md` from the source and re-syncing removes the target copy (orphan removal),
      with backup.

**Validation:**
```bash
cd /Users/feliperosa/workspace/genie && bun test src/lib/agent-sync.test.ts src/genie-commands/uninstall.test.ts && bun run check
```

**depends-on:** none

---

### Group B: doctor-duplicate-guard

**Goal:** `genie doctor` tells the truth about role-agent delivery — managed vs merely-present vs stale — and warns about the duplicate-surface hazard.

**Deliverables:**
1. Doctor summary for `~/.claude/agents/` (src/genie-commands/doctor.ts): a **new per-file
   classifier** — `summarizeManagedSkills()` (:620–641) cannot be reused (subdir-based via
   `listSubdirs` :570 + manifest-inside-dir via `readManagedDigest` :585; flat files are invisible to
   it and it cannot emit a present-unmanaged state). Per-file states from the Group A manifest:
   genie-managed-current / genie-managed-stale / **present-unmanaged** (file exists, no manifest
   entry — the hand-copy case) / missing-from-target. Report inside `checkClaudeSync()` (:664–680)
   alongside skills + council.js freshness.
2. `enabledPlugins["genie@automagik"] === true` probe in `~/.claude/settings.json` → warning naming
   the duplicate-surface consequence and the resolution (keep plugin disabled, or expect `genie:*`
   duplicates).
3. **Machine-readable contract (UI interface):** the per-file states and the duplicate warning ride
   the existing `genie doctor --json` raw-check output (src/genie-commands/doctor.ts:12 — no new
   flag). This is the "pins mechanically active" integrity fact the execution-optimization dashboard
   (parallel brainstorm `genie-execution-optimization-dashboard`, block 20 measurement-integrity)
   consumes. Doctor's `--json` emits `{ ok, checks: [{ name, status, detail?, suggestion? }] }`
   (doctor.ts:837–838) — the per-file states (`genie-managed-current` / `genie-managed-stale` /
   `present-unmanaged` / `missing-from-target`) must be **deterministically machine-parseable** from
   that output: either a structured payload on the check entry or a documented stable format in
   `detail` — never free prose the dashboard would have to guess at.
4. Tests: fixture settings.json + fixture agents dir driving each state and the warning, asserted on
   both the human and `--json` outputs.

**Acceptance Criteria:**
- [ ] Doctor on a host with only the unstamped hand-copy reports present-unmanaged (NOT healthy
      genie-managed) — the false-PASS discriminator from the plan review.
- [ ] Doctor with the plugin enabled emits the duplicate-surface warning; disabled emits none.
- [ ] `genie doctor --json` carries the per-file role-agent states under stable field names
      (dashboard-consumable without parsing human output).

**Validation:**
```bash
cd /Users/feliperosa/workspace/genie && bun test src/genie-commands/doctor.test.ts && bun run check
```

**depends-on:** A

---

### Group C: day3-qa

**Goal:** Prove the pins fire mechanically end-to-end on the released build, with evidence.

**Deliverables:**
1. Post-release, post-`genie update` (Felipe's live ritual): verify the stamp exists and the seven
   agents surface in a fresh session; record doctor output.
2. LangWatch pull re-running the day-2 recipe set (`.genie/wishes/routing-matrix/qa/routing-pin-qa-20260711.md`
   methodology): primary = dispatched traces carry pinned `model×effort` fingerprints per role;
   secondary = Fable/Opus/Haiku share trend, reported with top-3-thread exclusion. **Record RESOLVED
   model IDs, not aliases** — the agent files pin `opus`/`haiku` aliases, which move across releases;
   the evidence must state what they resolved to during the window (execution-optimization-lab
   benchmark requirement, shared).
3. Evidence file `.genie/wishes/routing-matrix/qa/routing-pin-qa-<date>.md`; if fingerprints pass,
   mark routing-matrix QA CLOSED in `.genie/INDEX.md`.

**Acceptance Criteria:**
- [ ] Evidence file exists with commands + numbers; fingerprint verdict explicit (pass/fail per role).
- [ ] routing-matrix INDEX entry updated to reflect the QA outcome.

**Validation:**
```bash
test -s "$(ls -t /Users/feliperosa/workspace/genie/.genie/wishes/routing-matrix/qa/routing-pin-qa-*.md | head -1)"
```

**depends-on:** B (released build carrying A+B)

---

## Dependencies

**depends-on:** none
**blocks:** none

Scheduling note: the future `work-on-workflows` rebaseline is sequenced after this fix per the ratified
order, but has no canonical wish slug and therefore is not a machine dependency. `genie-spend`
(rebaseline wish 2) is independent and may run in parallel.

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: `genie update` on a real host populates `~/.claude/agents/` with stamp; the seven
      agents surface after `/reload-plugins` or a fresh session.
- [ ] Integration: `genie doctor` reflects the true managed state on that same host; enabling the
      plugin flips the warning on.
- [ ] Regression: skills fan-out, council.js stamping, and Codex/Hermes sync targets unchanged
      (`bun test src/lib/agent-sync.test.ts` full suite green); user-authored agents never touched.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Name collision with a user-authored agent of the same name (e.g. their own `reviewer.md`) | Medium | Adopt-with-backup, never silent overwrite; doctor lists the adoption; backups under `~/.genie-recovery/agent-sync-*` |
| Hosts with the plugin ENABLED get duplicates (`genie:*` + bare) | Medium | Group B warning + documented resolution (design Risk 7) |
| `CLAUDE_CODE_SUBAGENT_MODEL` env silently overrides pins | Medium | Carried from umbrella — doctor env check exists per routing-matrix wish; re-verify in Group C evidence |
| Day-3 share numbers noise-dominated by thread mix | Low | Fingerprint check is primary; shares directional with top-3 exclusion (plan-review MEDIUM) |

---

## Review Results

### Plan review — 2026-07-11 (reviewer role agent, opus-xhigh)

- **Loop 0:** FIX-FIRST — 1 HIGH (Group A framed as reuse of the dir-oriented managed engine;
  `writeManagedDir` whole-dir replace would delete user-authored agents; uninstall/doctor dir-walkers
  skip flat files) + 2 MEDIUM (Group B validation targeted the wrong test dir; present-unmanaged state
  unreachable via `summarizeManagedSkills`) + 2 LOW (Group C post-release gating note; Group A targeted
  command missing uninstall.test.ts). All anchors verified accurate; semantics were the issue.
- **Loop 1:** **SHIP** — all 5 findings verified resolved against the amended file; per-file design
  confirmed sound (dotfile manifest can't surface as an agent; no collision with per-skill manifests).
- **Post-SHIP amendment (Felipe-directed, 2026-07-11, after the SHIP verdict):** convergence with the
  parallel `genie-execution-optimization-dashboard` brainstorm — Group B states explicitly ride the
  existing `genie doctor --json` with stable field names (the dashboard's pins-active integrity fact);
  Group C must record resolved model IDs, not aliases. Delta sent to the reviewer for a
  flag-if-broken check; no engine-contract change.

**Engineer note (non-blocking, Group A):** the clean-remove path can reuse `removeAgentSyncAssets()`'s
file branch, but the MODIFIED-keep path must NOT assume `keepModifiedSkillDir` works unchanged — an
agent's ownership is an ENTRY in the shared dir-level `~/.claude/agents/.genie-sync.json`, so keeping
`<name>.md.genie-kept` also means deleting that filename's manifest entry (not unlinking a per-dir
manifest). The acceptance tests force the correct behavior.

### Execution review — Group A `agents-fanout` (2026-07-11)

- **Engineer pass:** implementation completed in the four Group A files; targeted tests and the full
  repository gate passed.
- **Review loop 0:** **FIX-FIRST** — unsafe `.genie-kept` collision handling, uninstall backups
  deleted by the full uninstall flow, remove-before-write updates, and unsafe shared-manifest paths.
- **Fix/review loop 1:** **FIX-FIRST** — new adversarial evidence found unsafe backup destination
  collisions, file/ownership TOCTOU, fixed staging paths that wedged retries, and a non-idempotent
  backups-only uninstall state.
- **Fix/review loop 2:** **BLOCKED** after the maximum two fix loops. Validation remained green
  (92 focused tests; 953 full-suite passes, 1 skipped; scoped `git diff --check` clean), but the final
  independent reviewer reproduced four remaining boundary defects:
  1. **CRITICAL:** sync can overwrite or delete a replacement created after its final validation but
     before publish/removal (`src/lib/agent-sync.ts`).
  2. **HIGH:** uninstall ignores a failed ownership relinquish and can leave a removed file still
     owned by the manifest (`src/genie-commands/uninstall.ts`).
  3. **HIGH:** lock acquisition can return a usable-looking handle without owning a lock, and
     release/stale-steal boundaries are not ownership-atomic (`src/lib/agent-sync.ts`).
  4. **HIGH:** stage cleanup tracks only pathnames and can delete a replacement object it does not
     own (`src/lib/agent-sync.ts`).

**Escalation diagnosis:** Group A remains `in_progress`; Groups B/C were not dispatched. Cause is
`missing-context`: each bounded fix brief addressed the then-reproduced gap list, while the terminal
review supplied new atomic-boundary invariants (capture-before-validate/publish, checked ownership
relinquish, fail-closed lock acquisition, identity-checked stage cleanup). Model/effort escalation is
not authorized or evidenced. Corrective route: human authorization for a fresh, same-model
engineering cycle carrying those four exact invariants, followed by an independent execution review.
Budget: `attempts=2/2`; `effort_escalations=0/2`; appeal: none.

**Human-authorized repair extension — 2026-07-11T23:41:07-03:00:** Felipe approved one fresh
engineering-and-review cycle for Group A. The inherited model and effort remain unchanged; the
extension carries only the four terminal atomic-boundary invariants above. Extended budget:
`attempts=3/3`; `effort_escalations=0/2`. A non-SHIP re-review stops the group again; it does not
authorize another automatic repair.

**Human-authorized extension review — 2026-07-11:** **FIX-FIRST**. The first formal-review attempt
hit an environment policy false positive; an unchanged-effort retry completed normally. Validation
passed (99 focused tests; 960 full-suite passes, 1 skipped; scoped `git diff --check` clean), while
the formal reviewer and architecture lens reproduced these remaining transaction-boundary defects:

1. **CRITICAL:** sync and uninstall can discard changes made to a captured inode after their one-time
   validation and before final unlink.
2. **HIGH:** sync can commit manifest ownership for different live target bytes changed immediately
   before manifest commit.
3. **HIGH:** successful manifest publication can be misreported as failure when stage cleanup fails,
   causing data rollback plus a multiply-linked manifest that future reads reject.
4. **HIGH:** final-entry ownership relinquish can return success while a concurrently installed
   replacement manifest still owns the removed agent.
5. **HIGH:** full uninstall releases the shared sync lock before deleting the canonical source,
   allowing a sync in the gap to recreate managed agents that uninstall then leaves behind.
6. **HIGH:** exceptions after uninstall staging can hide bytes in a staging directory while leaving
   the live path absent and manifest ownership unchanged.

**Extension diagnosis:** cause is `model-capacity`: the behavioral contract, repository context,
deterministic seams, and validation environment were complete, but the same inherited model/effort
did not close the transaction reasoning after three implementation attempts. Corrective route:
human authorization for an architecture-first repair that centralizes the flat-agent transaction
(`capture → validate → publish → manifest CAS → finalize/rollback`) and holds one lock across the
complete uninstall, using a higher-effort fresh engineering session if the runtime exposes one.
Budget: `attempts=3/3`; `effort_escalations=0/2`; appeal: none. Group A remains `in_progress` and
Groups B/C remain undispatched.

**Human-authorized escalated repair — 2026-07-12:** Felipe approved attempt 4 as an
architecture-first repair at **Fable-5 tier** (above the opus-xhigh pin used in attempts 1–3),
consuming one effort escalation. Mandate: centralize the entire flat-agent transaction
(`capture → validate → publish → manifest CAS → finalize/rollback`) and hold ONE lock across the
complete uninstall, including canonical-source deletion. The six terminal transaction-boundary
defects ride as hard invariants; the existing test suite is kept as the behavioral floor.
Extended budget: `attempts=4/4`; `effort_escalations=1/2`. A non-SHIP re-review stops the group
again; it does not authorize another automatic repair.

### Execution review — Group A attempt 4 (2026-07-12): **SHIP**

Independent Fable-tier reviewer, adversarial syscall-interleaving pass over the uncommitted working
tree. No CRITICAL or HIGH gaps. All six terminal invariants closed — publish-outcome-at-rename,
single-lock-across-uninstall, exception-path restore-or-park, and flat-file structural invisibility
of user files CLOSED-BY-CONSTRUCTION; captured-inode disposal and bytes/ownership divergence
CLOSED-BY-CHECK via at-the-instant re-verification, with residual windows reachable only by a
non-genie process forging genie's own manifest and producing no byte loss on any constructed
interleaving. All four engineer-declared open items judged acceptable (item (b), capture-mismatch
relinquish, is in fact pinned by tests — the "no floor test" note was outdated). Wish-contract
compliance verified in code, including `writeManagedDir` never touching `~/.claude/agents/` and
durable backups now surviving full uninstall (prior code deleted state-backups — fixed and pinned).
The 7 new INV tests were judged to pin the invariants (attempt-3 code would fail each behaviorally).
Gates re-run independently from a script file: 106 focused pass / 0 fail; `bun run check` 967 pass /
1 skip / 0 fail; wishes-lint OK; `git diff --check` clean.

**Non-blocking advisories (follow-up hardening candidates):**
1. MEDIUM — `state.published` re-read from the live path after linkSync instead of derived from the
   staged inode (agent-sync.ts:1098); bounded (all consumers backup-first, no byte loss); recommend
   constructing from stage.stat/stage.bytes.
2. MEDIUM/LOW — SIGKILL between capture and finalize strands quarantine-dir debris with no recovery
   sweep; kill-only, ms-scale, manually recoverable; a startup sweep would close it.
3. LOW — `stealStaleLock` doc comment describes the retired guard-file mechanism (agent-sync.ts:2074).
4. LOW — sync's publish-conflict advisory omits the `.genie-kept` path (agent-sync.ts:1677).
5. LOW — uninstall silently collects zero agents when the shared manifest is unsafe (uninstall.ts:193);
   fail-closed but unexplained in output.

Budget closed: `attempts=4/4` (SHIP on 4); `effort_escalations=1/2`.

### Execution review — Group B `doctor-duplicate-guard` (2026-07-12): **SHIP**

- **Engineer pass (engineer-standard, pinned tier, attempt 1):** per-file classifier inside
  `checkClaudeSync()` over the union of source ∪ manifest names (user-authored agents structurally
  never reported); duplicate-surface warning on strict `enabledPlugins["genie@automagik"] === true`;
  machine-readable `roleAgents` rider on the existing `doctor --json` check entry (`manifestStatus`,
  name-sorted `files[{name, state}]`, `duplicateSurface`, `manifestReason` when unsafe) with the four
  state names documented as a stability contract. Reuses Group A's `enumerateSourceAgentFiles` and
  fail-closed `inspectAgentFilesManifest` (additive exports only — transaction core untouched).
- **Independent review, loop 0: SHIP** — all three acceptance criteria verified test-pinned,
  including the false-PASS discriminator (hand-copy-only host → `present-unmanaged` + warn, asserted
  positively AND negatively); classifier semantics coherent across user-edit / outdated-version /
  vanished-source / never-synced / fresh-host / unsafe-manifest edges; agent-sync delta confirmed
  behaviorally inert; messaging coherent with `checkMarketplacePlugin`. Gates re-run independently:
  43 doctor tests, 106 Group A regression tests, `bun run check` 976 pass / 1 skip / 0 fail,
  `git diff --check` clean. Both declared open items judged acceptable.
- **LOW advisories (non-blocking):** no dedicated human-detail line for `manifestStatus:'foreign'`;
  two finer stale branches and the malformed-settings.json probe path handled in code but unpinned
  by tests.

---

## Files to Create/Modify

```
src/lib/agent-sync.ts               # syncClaude :471 — NEW per-file managed fan-out (dir-level filename→digest manifest)
src/lib/agent-sync.test.ts          # writeSourceAgent (single file) + fan-out/adopt/orphan/user-file-byte-identical cases
src/genie-commands/doctor.ts        # checkClaudeSync :664 — NEW per-file classifier + enabledPlugins warning
src/genie-commands/doctor.test.ts   # per-state fixtures incl. present-unmanaged (hand-copy) + warning on/off
src/genie-commands/uninstall.ts     # collectAgentSyncAssets :193 — per-file collector/classifier (NOT collectManagedSkillDirs)
src/genie-commands/uninstall.test.ts# removes-only-manifest-clean; user + modified files preserved
.genie/wishes/routing-matrix/qa/    # Group C evidence file
```
