# Triage W3 — Easy CLI/UX Bugs

> **Pilot wish for autonomous-team triage campaign.** Three independent low-blast-radius CLI/UX bugs grouped for a single engineer to ship green. Designed to validate the autonomous-team flow before queuing higher-risk wishes.

## Problem

Three unrelated CLI/UX defects, each blocking a small workflow. Bundled because:
- Each is independently shippable (no cross-dependencies)
- Each has a clearly-bounded code surface
- Each has an obvious validation command
- Combined surface is ~3-4hr and zero overlap with active high-risk work

## Scope

### IN
- **G1 (#1473)**: Add `genie task priority <id> <urgent|high|normal|low>` subcommand to mutate priority on existing tasks
- **G2 (#1470)**: Add a 4th fallback to `scripts/tmux/osc52-copy.sh` for nested-tmux + no-utmp + no-SSH_TTY (Linux headless), OR emit a clear stderr warning so the user knows copy failed
- **G3 (#1478)**: Fix wave-tracker false-positives — make wave-completion detection source from `genie wish status` (group state) instead of `wip:` commit greps; OR cross-validate before emitting the wave-complete mailbox

### OUT
- Refactoring the task subcommand hierarchy (just add `priority`)
- Replacing osc52-copy.sh entirely
- Reworking the wave-tracker architecture (just fix the false-positive emission)

## Execution Groups

### Group 1 — `genie task priority` subcommand (#1473)

**Files**:
- `src/term-commands/task.ts` (locate the `task create --priority` plumbing)
- New: tests for the `priority` subcommand

**Acceptance**:
- [ ] `genie task priority <#seq|id> high` exits 0 and updates the row
- [ ] Accepts `--comment "<note>"` and stores as a task comment
- [ ] Emits a `task.priority.updated` audit event
- [ ] Rejects invalid priority values with a clear error
- [ ] `genie task priority` (no args) prints usage
- [ ] Tests cover all 4 priority levels + invalid input + comment passthrough

**Validation**:
```bash
bun test src/term-commands/task.test.ts
bun run typecheck
bun run lint
SEQ=$(genie task create "Test priority edit" --priority normal --board Roadmap --json | jq -r .seq)
genie task priority "#$SEQ" high --comment "elevating per W3 pilot"
genie task show "#$SEQ" --json | jq '.priority,.comments[-1].body'
genie task done "#$SEQ"
```

### Group 2 — `osc52-copy.sh` 4th fallback or explicit failure (#1470)

**Files**:
- `scripts/tmux/osc52-copy.sh`
- New (optional): shellcheck/bats tests

**Acceptance** (pick one path, document choice in commit):

**Path A — file-based fallback**:
- [ ] When SSH_TTY/who-m/stdout fallbacks all fail, write OSC 52 to `~/.genie/clipboard.osc52` and print `genie clipboard read` hint
- [ ] Add `genie clipboard read` that emits the cached sequence to stdout once

**Path B — explicit failure surfacing**:
- [ ] When all fallbacks fail, exit non-zero AND surface an obvious tmux status-line message
- [ ] Document the failure mode in the script header

Either is acceptable. Path B is smaller; Path A more useful.

**Validation**:
```bash
bash scripts/tmux/osc52-copy.sh < /dev/null  # must not silent-no-op
shellcheck scripts/tmux/osc52-copy.sh
```

### Group 3 — Wave-tracker false-positive fix (#1478)

**Files**:
- Wherever the wave-tracker emits `Wave N complete` (grep for `Wave.*complete` in `src/`)
- Likely candidates: `src/term-commands/work.ts`, `src/lib/wave-tracker.ts`

**Acceptance**:
- [ ] Wave-complete emitted ONLY when `wishStatus` reports the corresponding group(s) `done`
- [ ] If tracker reads `wip:` commits as a hint, MUST cross-validate against `genie wish status` first
- [ ] Test: stale `wip:` commits on a worktree branch must NOT trigger a false wave-complete
- [ ] Happy-path regression: real wave completion still fires the mailbox exactly once

**Validation**:
```bash
bun test src/lib/wave-tracker.test.ts
bun run typecheck
```

## Validation Gate (full suite)

```bash
bun run typecheck
bun run lint
bun test --timeout 15000
```

All three groups must pass independently AND the full test suite must remain green.

## Dependencies

- None. All three groups are independently shippable.
- No interaction with active PRs (#1446, #1511, #1512).

## Definition of Done

- [ ] All three groups merged to dev as ONE PR titled `fix(triage-w3): easy CLI/UX bugs (#1473 #1470 #1478)`
- [ ] PR body lists each issue + acceptance + evidence
- [ ] All CI checks green (no flake re-runs needed)
- [ ] Issues closed by `Closes #N` lines in PR body

## Out-of-scope follow-ups

- If task-priority surfaces deeper task-edit gaps, file new issue
- If osc52-copy needs full clipboard subsystem rework, file as enhancement
- If wave-tracker has other false-positive triggers, file separately

---

**Wish owner**: triage-w3-easy-cli team (autonomous)
**Pilot context**: First wish in autonomous-team triage campaign per Felipe's directive 2026-04-29.
