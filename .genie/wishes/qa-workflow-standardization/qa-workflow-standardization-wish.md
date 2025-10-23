# Wish: QA Workflow Standardization (Per‑Issue, Node‑Only)
**Created:** !`date -u +"%Y-%m-%d"`
**Status:** In Planning → Ready to Forge
**Complexity:** Medium
**Owner:** Felipe (namastex)

---

## Context Ledger

- Current QA artifacts are ad‑hoc (e.g., `scripts/qa/bug1-validate.sh`).
- Desired state: one canonical, per‑issue QA workflow that links to the GitHub issue, executes deterministically (Node), stores evidence predictably, and integrates with Learn agent for continuous improvement.
- We consolidated repo tooling to Node; no Python helpers in this repo.
- QA workflows must remain terminal (no further delegation) and runnable locally and in CI.

Constraints
- Node‑only helpers (no Python). Keep under `.genie/*`.
- Per‑issue structure must be easy to discover and version.
- Deterministic PASS/FAIL with exit codes and evidence artifacts.

---

## Proposed Standard

Directory structure (Option A — Issue‑Centric; recommended)

```
.genie/qa/
  specs/
    bug-<num>.yaml            # QA spec: metadata, preconditions, steps, checks
    feat-<num>.yaml           # Same for features (optional)
  validators/
    bug-<num>.js              # Node validator implementing asserts + evidence
  runs/
    bug-<num>/
      <timestamp>/            # Evidence per run (stdout/stderr, JSON summary)
        report.md
      latest -> <timestamp>/  # Symlink to latest
  helpers/
    common/
      validator.js            # Shared PASS/FAIL helpers, evidence writer
      github.js               # Optional: issue comment helper
      learn-triggers.js       # When to invoke Learn agent
  scripts/
    run.js                    # CLI to execute a spec (local + CI)
    report.js                 # Format/emit reports (optional)
```

Workflow spec template (YAML)

```yaml
issue: 102
url: https://github.com/namastexlabs/automagik-genie/issues/102
title: Session ID collision regression test
labels: [type:bug, area:mcp]
severity: high
owner: @namastex
env:
  node: ">=18"
  pnpm: ">=10"
preconditions:
  - Build CLI: pnpm run build:genie
steps:
  - name: Create multiple sessions
    command: genie run agents/plan "Test A" &
    expect: background session created
  - name: List sessions
    command: genie list sessions
    expect: all session IDs unique
checks:
  - type: json
    file: .genie/state/agents/sessions.json
    criteria: sessions keys are unique and match UUID format
evidence:
  - .genie/state/agents/sessions.json
learn_triggers:
  - flaky
  - missing_assertion
```

Validator contract (Node)
- Read spec, execute commands or equivalent programmatic checks.
- Write evidence under `.genie/qa/runs/bug-<num>/<timestamp>/`:
  - `stdout.log`, `stderr.log`, `summary.json`, `report.md`.
- Exit 0 on PASS; exit 1 on FAIL; concise failure reasons.
- Optional flags: `--ci` (machine‑readable JSON), `--github` (comment on issue).

Invocation
- Single: `node .genie/qa/scripts/run.js bug-102`
- All bugs: `node .genie/qa/scripts/run.js --all --type=bug`
- CI: `node .genie/qa/scripts/run.js bug-102 --ci`

Learn integration
- Triggers: flaky results, manual‑only steps, ambiguous expected behavior.
- Action: capture a learn note under `.genie/wishes/qa-workflow-standardization/reports/learn-<bug>-<ts>.md` with:
  - Gap description, proposal, expected impact, acceptance checks.
- Rubric: clarify, automate, assert, stabilize, document.

---

## Execution Groups (Forge)

Group A: Foundation
- Files:
  - `.genie/qa/specs/template.yaml`
  - `.genie/qa/helpers/common/validator.js`
  - `.genie/qa/scripts/run.js`
- Acceptance:
  - Run CLI executes a spec and writes evidence; returns 0/1 deterministically.

Group B: Migrate First Bug (bug‑1)
- Files:
  - `.genie/qa/specs/bug-1.yaml`
  - `.genie/qa/validators/bug-1.js`
- Acceptance:
  - Behavior parity with the old shell script (timeout, session/log checks, banner detection).
  - Old script archived: `scripts/qa/_archive/bug1-validate.sh.MIGRATED`.

Group C: Port Existing QA Workflows
- Files:
  - `.genie/qa/specs/bug-66.yaml`, `.genie/qa/validators/bug-66.js`
  - `.genie/qa/specs/bug-90.yaml`, `.genie/qa/validators/bug-90.js`
  - `.genie/qa/specs/bug-102.yaml`, `.genie/qa/validators/bug-102.js`
- Acceptance:
  - PASS/FAIL + evidence for each; spec checked into git.

Group D: Learn Hooks
- Files:
  - `.genie/qa/helpers/common/learn-triggers.js`
- Acceptance:
  - When triggers fire, a Learn note is generated with proposals.

Group E: GitHub Reporting (optional)
- Files:
  - `.genie/qa/helpers/common/github.js`
  - `.genie/qa/scripts/report.js`
- Acceptance:
  - Optional `--github` posts a comment to the issue with summary and links.

---

## Spec Contract (Acceptance Criteria)

- Reproducible execution via a single Node command.
- Deterministic PASS/FAIL with clear exit codes.
- Evidence saved under per‑issue timestamped folder; `latest` symlink updated.
- GitHub issue linkage present (ID + URL in spec and report).
- Learn rubric documented; triggers tested at least once.

---

## Recommendation

Adopt Option A (Issue‑Centric) and implement Groups A–C immediately. This yields a consistent QA backbone, unblocks the bug‑1 migration, and positions Learn to iteratively improve specs and validators.

---

## Notes

- After standardization, remove stray QA shell scripts from `scripts/qa/` in favor of Node validators.
- Keep validators pure and side‑effect‑aware so they run locally and in CI the same way.

