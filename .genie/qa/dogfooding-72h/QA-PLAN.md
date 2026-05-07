# /qa Spawn Plan — Dogfooding 4.260507.1

**Mission:** Validate the past 72 h of genie fixes against the installed binary, surface any regressions or unverified claims, and produce a structured PASS/FAIL/NEW-REGRESSION report.

**Owner:** `qa` agent spawned via `genie spawn qa --team <qa-team>`.

**Inputs:**
- `AUDIT.md` (this directory) — what was claimed fixed.
- `BATTERY.md` (this directory) — explicit test matrix.
- `DOGFOOD-SCRIPT.md` (this directory) — end-to-end /work cycle reproduction.

**Output:** `VERDICT.md` written by qa agent — one section per cluster, evidence, severity tags.

---

## Phase 0 — Pre-flight (orchestrator does this BEFORE spawn)

```bash
# Confirm installed version + source state
genie --version                                   # expect 4.260507.1
cd /home/genie/workspace/repos/genie
git rev-parse --abbrev-ref HEAD                   # expect docs/reflection-c2-c3-ship or main
git status -s                                     # working tree should be reasonably clean

# Snapshot live state for delta detection
genie ls --json > /tmp/qa-pre-ls.json
genie events errors --since 1h > /tmp/qa-pre-errors.txt
psql "$(genie db connstr 2>/dev/null)" -c "SELECT COUNT(*) FROM agents; SELECT COUNT(*) FROM teams; SELECT COUNT(*) FROM audit_events;" > /tmp/qa-pre-counts.txt 2>&1 || true
```

**Pre-flight PASS gate:** binary version matches, no fatal error events in last 1h that aren't already documented.

---

## Phase 1 — Spawn the QA agent

**Team:** `qa-dogfood-72h` (new isolated team, separate from `genie` orchestrator team).
**Repo:** `/home/genie/workspace/repos/genie` (source repo — qa reads/runs but does not edit production code).
**Branch:** `qa/dogfood-72h-$(date +%Y%m%d)` (created by team-create).

```bash
genie team create qa-dogfood-72h \
  --repo /home/genie/workspace/repos/genie \
  --branch main \
  --wish dogfooding-72h \
  --no-interactive
```

**If `--wish` triggers FK error (Bug 1 regression):** drop `--wish`, then:
```bash
genie team create qa-dogfood-72h --repo /home/genie/workspace/repos/genie --branch main --no-interactive
genie spawn qa --team qa-dogfood-72h
genie send '/qa run .genie/qa/dogfooding-72h/BATTERY.md' --to qa@qa-dogfood-72h
```

**Note:** the FK-error-on-create path *itself* becomes a Bug 1 regression test. Document the result either way.

---

## Phase 2 — Test battery (qa agent executes BATTERY.md)

Each cluster gets a dedicated check. The qa agent:

1. Reads `BATTERY.md`.
2. Executes each test in order, capturing stdout + exit code to `/tmp/qa-evidence/<cluster>.log`.
3. Tags each test PASS / FAIL / SKIP / NEW-REGRESSION.
4. After all clusters: writes `VERDICT.md` in `.genie/qa/dogfooding-72h/`.

The qa agent does NOT fix anything. It reports.

---

## Phase 3 — Dogfooding cycle (after battery)

`DOGFOOD-SCRIPT.md` runs a real end-to-end `/work` cycle on a throwaway wish:
- Create team in a sibling repo (omni or pgserve, not genie itself, to test cross-repo flows).
- Brief team-lead with `genie send --to team-lead@<team>` — exercises the #1676 cross-team fix.
- Have the team-lead spawn an engineer.
- Run a trivial change (touch a comment, commit, push, open PR).
- Validate `genie wish status`, `genie events timeline`, `genie ls --json` all reflect reality.
- Disband cleanly.

Failure of any orchestration primitive during the cycle = a regression of the dispatch flow.

---

## Phase 4 — Verdict synthesis (orchestrator merges qa report)

Orchestrator (this Genie):
1. Reads `VERDICT.md`.
2. Cross-references against `AUDIT.md` open-bugs list.
3. For each NEW-REGRESSION → file a fresh GH issue.
4. For each confirmed-still-broken → comment on existing issue with new repro evidence.
5. For each confirmed-fixed → close GH issue with verification link.
6. Updates task #208 with summary.

**Ship gate:** zero NEW-REGRESSION. Existing-known-open is acceptable but documented.

---

## Spawn command (final)

```bash
# Phase 1
genie team create qa-dogfood-72h \
  --repo /home/genie/workspace/repos/genie \
  --branch main \
  --no-interactive

# If team-lead spawn races, manual:
genie spawn qa --team qa-dogfood-72h --model sonnet

# Phase 2 brief
genie send --to qa@qa-dogfood-72h "$(cat <<'EOF'
You are the QA agent for the 72h dogfooding sweep. Your inputs:
- /home/genie/workspace/repos/genie/.genie/qa/dogfooding-72h/AUDIT.md
- /home/genie/workspace/repos/genie/.genie/qa/dogfooding-72h/BATTERY.md
- /home/genie/workspace/repos/genie/.genie/qa/dogfooding-72h/DOGFOOD-SCRIPT.md

Workflow:
1. Read all three docs.
2. Execute BATTERY.md cluster-by-cluster. Capture every command's stdout/exit to /tmp/qa-evidence/<cluster>-<test>.log.
3. After every cluster, write a one-paragraph status into VERDICT.md (start the file fresh).
4. After the battery, run DOGFOOD-SCRIPT.md end-to-end.
5. Final VERDICT.md sections: per-cluster table, NEW-REGRESSION list (with repro), CONFIRMED-FIXED list (with evidence), STILL-OPEN list (with notes).
6. DO NOT fix bugs. DO NOT modify production code. Only write under .genie/qa/dogfooding-72h/.
7. Report back via 'genie send --to genie@genie' when VERDICT.md is final.

Ship gate: zero NEW-REGRESSION = green. Anything else = report and stop.
EOF
)"
```
