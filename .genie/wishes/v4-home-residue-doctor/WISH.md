# Wish: v4 Home Residue — Manifest + Doctor Check/Fix + Diagnostics Age Filter

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `v4-home-residue-doctor` |
| **Date** | 2026-07-05 |
| **Author** | Felipe (directive: "find and clean all stale genie v4 shit… genie doctor should do that") |
| **Appetite** | small |
| **Branch** | `wish/v4-home-residue-doctor` |
| **Repos touched** | `automagik-dev/genie` → `/home/feliperosa/vm-home/workspace/worktrees/genie-skills-revamp` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

**Problem:** the v4→v5 cutover left daemon-era residue in `~/.genie` on upgraded machines (scheduler/serve/relay/spawn artifacts, megabyte logs), and `genie update`'s diagnostics tail `logs/scheduler.log` with no age filter — a June-22 disk-full incident just resurfaced as "Recent scheduler signals" on a healthy machine. The existing `legacy-v4` cleanup only covers `~/.claude` (rules file, plugin caches). Extend it to `~/.genie` home residue, surface detection in `genie doctor` with an opt-in `--fix`, and age-filter the diagnostics tail — so every upgraded user gets the same cleanup, not just this machine.

## Scope

### IN

- Extend `src/genie-commands/legacy-v4.ts` manifest with `~/.genie` v4 residue, **each entry verified dead against v5 src** (nothing in `src/` reads/writes it) before inclusion. Candidates observed on a real v4-upgraded machine (mtimes May/June vs v5-live today): `serve.pid`, `genie-serve.config.cjs`, `relay/`, `spawn-scripts/`, `hook-fallback.log`, `role-cutover-events.jsonl`, `.role-cutover-*.json`, `config.json.bak-pre-omni`, `state/` (v4 wish-state JSONs; v5 state = genie.db), `logs/scheduler.log`, `Genie.config.cjs`, `model-a/`, `data/`, `tmux.conf.bak`, `tui-tmux.conf.bak`. Engineer classifies each keep/delete from src evidence; uncertain → KEEP (log-only report).
- `genie doctor`: new check "v4 residue" — reports found relics (count + total size, per-path list); `genie doctor --fix` runs the same backup-first cleanup path (`cleanupV4`-family: backup to `~/.genie/state-backups/v4-cleanup-<ts>/`, logged, idempotent). Without `--fix`, detection only, exit code unchanged.
- `src/genie-commands/update.ts` diagnostics: `summarizeJsonlSignals(schedulerLog)` gains an age filter (default: signals older than 48h excluded; if everything is older, print "no recent signals; last entry <date>" instead of resurfacing stale errors).
- Tests (pgserve-free, fixture homes): manifest classification, doctor detect vs --fix behavior, backup-first ordering reuse, age-filter boundary.

### OUT

- No deletion of anything v5 reads/writes (bin/, worktrees/, state-backups/, logs/ other than scheduler.log, genie.db*, config.json, keys/, plugins/skills/templates/, scripts/ + tmux/TUI confs — smart-install still manages those).
- No changes to `~/.claude` handling (already shipped); no doctor UX redesign beyond the one check + flag.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Doctor is detect-by-default, `--fix` opt-in | Doctor is a diagnostic surface users run casually; destructive action needs explicit intent. install/update keep auto-cleaning (already-shipped behavior) but gain the extended manifest |
| 2 | Uncertain classification → KEEP + report | Deleting user home data on a guess is the one unforgivable failure; the manifest only ever lists provably-dead paths |
| 3 | Age-filter in the reporter, not log deletion alone | scheduler.log is also in the delete manifest, but the reporter must be robust for users who never run --fix |

## Success Criteria

- [ ] Every manifest addition justified by a src-grep proof (path absent from v5 read/write surfaces), stated in code comment or test.
- [ ] `genie doctor` on a residue-laden fixture home reports the relics; `--fix` backs up + removes exactly the manifest entries; second run reports clean; non-manifest files untouched (test-proven).
- [ ] Update diagnostics on a fixture scheduler.log with only June entries prints the no-recent-signals line, not the errors.
- [ ] `bun run check:fast` green; existing v4-cleanup tests still green; field run on THIS machine (post-merge): `genie doctor` reports the real residue, `genie doctor --fix` cleans it, backups verified.

## Execution Strategy

### Wave 1 (single group)

| Group | Agent | Description |
|-------|-------|-------------|
| residue | engineer | Manifest extension + doctor check/--fix + diagnostics age filter + tests |

## Execution Groups

### Group residue

**Goal:** Every upgraded machine can find and clean its v4 home residue via genie itself.

**Deliverables:**
1. Manifest extension in `legacy-v4.ts` (src-proof per entry; uncertain → excluded, listed in report only).
2. Doctor check + `--fix` flag wiring (follow the existing doctor check patterns).
3. `summarizeJsonlSignals` age filter (48h default) with stale-summary line.
4. Tests per Success Criteria.

**Acceptance Criteria:**
- [ ] Detect/fix/idempotency/non-manifest-untouched all test-locked.
- [ ] Doctor without --fix mutates nothing (test-proven).
- [ ] tsc, biome, check:fast green.

**Validation:**
```bash
cd "$(git rev-parse --show-toplevel)" && bunx tsc --noEmit && \
  bun test $(ls src/genie-commands/*v4*.test.ts src/genie-commands/install.test.ts 2>/dev/null) && echo RESIDUE-OK
```

**depends-on:** none

---

## QA Criteria

- [ ] Post-merge on this machine: `genie doctor` lists the real residue (~2MB: hook-fallback.log 1MB, role-cutover-events.jsonl 0.9MB, + small files); `--fix` cleans with backup; `genie update` diagnostics no longer show June signals.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A "dead" path is live for some user workflow (TUI/scripts) | High | Decision 2: src-proof required; uncertain → KEEP; backup-first makes mistakes reversible |

---

## Review Results

_Populated by /review._

---

## Files to Create/Modify

```
src/genie-commands/legacy-v4.ts        (manifest extension + home-residue support)
src/genie-commands/legacy-v4.test.ts   (new scenarios)
<doctor command file>                   (v4-residue check + --fix)
src/genie-commands/update.ts            (summarizeJsonlSignals age filter)
```
