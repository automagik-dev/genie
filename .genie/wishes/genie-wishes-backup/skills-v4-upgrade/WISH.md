# Wish: Skills v4 Upgrade — Leverage PG Task Lifecycle

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `skills-v4-upgrade` |
| **Date** | 2026-03-23 |
| **depends-on** | `task-lifecycle-foundation` (DONE) |

## Summary

Upgrade all 14 genie skills to leverage v4's PG task lifecycle, messaging, and execution locking. Skills currently work against the CLI interface but don't use the new task tracking (`genie task create/move/checkout`), short IDs (`#47`), inline comments, or conversation-based messaging. This upgrade makes skills first-class citizens of the task system — work they dispatch is tracked, commentable, and queryable.

## Scope

### IN
- **work**: Use `genie task checkout` before executing, `genie task move` for stage transitions, `genie task comment` for progress updates
- **wish**: After creating WISH.md, also create parent + child tasks in PG via `genie task create` with proper deps — so the wish is visible in `genie task list`
- **review**: Write review verdicts as task comments (`genie task comment`), update task stage on SHIP/FIX-FIRST
- **fix**: Use `genie task comment` to log fix attempts and loop count
- **dream**: Create a parent task for the dream run, child tasks per wish — full audit trail in PG
- **genie**: Update CLI reference table with all new v4 commands (`genie task/type/tag/release/notify`)
- **report**: Create task for bug report via `genie task create --type software --tags bug`
- **trace**: Log investigation findings as task comments
- **brainstorm**: On crystallize, create draft task (`genie task create --type software` at draft stage)
- **council**: Log council advisory as task comment when task context exists
- **learn**: No changes needed (operates on memory, not tasks)
- **refine**: No changes needed (stateless prompt transformation)
- **brain**: No changes needed (separate knowledge vault)
- **docs**: No changes needed (simple dispatch)

### OUT
- New skill creation — only updating existing skills
- Changing skill behavior/flow — only adding v4 integration points
- Custom task types per skill — use built-in `software` type for now
- OTel integration in skills — separate wish scope
- Modifying task-service.ts or any backend code — skills only use CLI

## Decisions

| Decision | Rationale |
|----------|-----------|
| Skills use `genie task` CLI, not task-service.ts directly | Skills are prompt files, not code. CLI is the interface. |
| 10 skills updated, 4 unchanged | brain, refine, learn, docs don't interact with task lifecycle |
| Add task integration as optional enhancement, not requirement | Skills must still work if PG is unavailable (graceful degradation) |
| Use `genie task comment` for all skill output logging | Single pattern: everything a skill does gets logged as a comment on the task it's working on |
| Group by skill complexity, not alphabetical | Simpler skills first → build patterns → complex skills use established patterns |

## Success Criteria

- [ ] `/work` uses `genie task checkout` before executing and `genie task done` after
- [ ] `/wish` creates PG tasks when crystallizing a wish (parent + children per group)
- [ ] `/review` writes verdict as task comment with severity tags
- [ ] `/fix` logs each fix loop attempt as task comment
- [ ] `/dream` creates parent dream task with child tasks per wish
- [ ] `/genie` CLI reference includes all v4 commands
- [ ] `/report` creates a bug task in PG
- [ ] `/brainstorm` creates draft task on crystallize
- [ ] `/trace` logs findings as task comments
- [ ] `/council` logs advisory as task comment when in task context
- [ ] All updated skills gracefully handle PG unavailability (warn, don't fail)
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1 (foundation — establish the pattern)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | `/genie` + `/work` + `/review` — the core trio that every other skill chains through |

### Wave 2 (parallel — apply the pattern)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | `/wish` + `/brainstorm` — planning skills |
| 3 | engineer | `/fix` + `/trace` + `/report` — investigation/fix skills |
| 4 | engineer | `/dream` + `/council` — orchestration skills |

### Wave 3 (quality gate)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | reviewer | Review all groups, run validation |

## Execution Groups

### Group 1: Core Trio — /genie + /work + /review

**Goal:** Establish the v4 integration pattern in the three most important skills.

**Deliverables:**

1. `plugins/genie/skills/genie/SKILL.md` — Add v4 CLI reference:
   - `genie task create/list/show/move/assign/tag/comment/block/dep/checkout/release/unlock/done`
   - `genie type list/show/create`
   - `genie tag list/create`
   - `genie release create/list`
   - `genie notify set/list/remove`
   - Short ID syntax (`#47`)

2. `plugins/genie/skills/work/SKILL.md` — Add task lifecycle integration:
   - Before executing a group: `genie task checkout #<seq>` (if task exists in PG)
   - On progress: `genie task comment #<seq> "Building group N..."`
   - On group done: `genie task move #<seq> --to review --comment "Group N complete"`
   - On wish done: `genie task done #<parent-seq> --comment "All groups shipped"`
   - Graceful: if no PG task exists, skip task commands (current behavior)

3. `plugins/genie/skills/review/SKILL.md` — Add verdict logging:
   - On SHIP: `genie task comment #<seq> "SHIP — all criteria passed"`
   - On FIX-FIRST: `genie task comment #<seq> "FIX-FIRST: [gap list]"` + `genie task move #<seq> --to build`
   - On BLOCKED: `genie task block #<seq> --reason "<reason>"`

**Acceptance Criteria:**
- [ ] `/genie` SKILL.md contains complete v4 CLI reference
- [ ] `/work` SKILL.md documents task checkout/comment/move/done flow
- [ ] `/review` SKILL.md documents verdict → task comment mapping
- [ ] All three skills include graceful degradation note

**Validation:**
```bash
grep -l "genie task" plugins/genie/skills/genie/SKILL.md plugins/genie/skills/work/SKILL.md plugins/genie/skills/review/SKILL.md | wc -l | grep -q 3 && echo "PASS" || echo "FAIL"
```

**depends-on:** none

---

### Group 2: Planning Skills — /wish + /brainstorm

**Goal:** Planning skills create PG tasks when crystallizing ideas.

**Deliverables:**

1. `plugins/genie/skills/wish/SKILL.md` — After writing WISH.md, also:
   - Create parent task: `genie task create "<wish title>" --type software`
   - Create child tasks per group: `genie task create "<group title>" --parent #<parent-seq>`
   - Add deps: `genie task dep #<child-seq> --depends-on #<dep-seq>`
   - Note: this makes the wish visible in `genie task list` alongside CLI-created tasks

2. `plugins/genie/skills/brainstorm/SKILL.md` — On crystallize:
   - Create draft task: `genie task create "<brainstorm title>" --type software`
   - Task starts at `draft` stage (default)
   - Comment with link to DRAFT.md: `genie task comment #<seq> "Draft: .genie/brainstorms/<slug>/DRAFT.md"`

**Acceptance Criteria:**
- [ ] `/wish` documents PG task creation after WISH.md write
- [ ] `/brainstorm` documents draft task creation on crystallize
- [ ] Both include graceful degradation

**Validation:**
```bash
grep -l "genie task create" plugins/genie/skills/wish/SKILL.md plugins/genie/skills/brainstorm/SKILL.md | wc -l | grep -q 2 && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1

---

### Group 3: Investigation Skills — /fix + /trace + /report

**Goal:** Investigation and fix skills log their work as task comments.

**Deliverables:**

1. `plugins/genie/skills/fix/SKILL.md` — Log fix loops:
   - Each fix attempt: `genie task comment #<seq> "Fix loop 1/2: [changes made]"`
   - On success: `genie task comment #<seq> "Fix complete — [summary]"`
   - On escalation: `genie task block #<seq> --reason "Fix loop exceeded (2/2)"`

2. `plugins/genie/skills/trace/SKILL.md` — Log investigation:
   - On findings: `genie task comment #<seq> "Root cause: [summary]"`
   - Include file paths and line numbers in comment

3. `plugins/genie/skills/report/SKILL.md` — Create bug task:
   - After investigation: `genie task create "<bug title>" --type software --tags bug --priority <severity>`
   - Link to GitHub issue: `genie task comment #<seq> "GitHub: <issue-url>"`

**Acceptance Criteria:**
- [ ] `/fix` documents loop logging as task comments
- [ ] `/trace` documents findings logging as task comments
- [ ] `/report` documents bug task creation in PG
- [ ] All three include graceful degradation

**Validation:**
```bash
grep -l "genie task" plugins/genie/skills/fix/SKILL.md plugins/genie/skills/trace/SKILL.md plugins/genie/skills/report/SKILL.md | wc -l | grep -q 3 && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1

---

### Group 4: Orchestration Skills — /dream + /council

**Goal:** Orchestration skills create audit trails in the task system.

**Deliverables:**

1. `plugins/genie/skills/dream/SKILL.md` — Dream run tracking:
   - Create parent task: `genie task create "Dream run <date>" --type software --tags chore`
   - Child tasks per wish in the dream: `genie task create "<wish>" --parent #<dream-seq>`
   - Move tasks as wishes complete/fail
   - Dream report → parent task comment

2. `plugins/genie/skills/council/SKILL.md` — Advisory logging:
   - When council is invoked in task context: `genie task comment #<seq> "Council advisory: [verdict] — [recommendation]"`
   - When no task context: skip (council can run standalone)

**Acceptance Criteria:**
- [ ] `/dream` documents task creation for dream run tracking
- [ ] `/council` documents advisory logging when task context exists
- [ ] Both include graceful degradation

**Validation:**
```bash
grep -l "genie task" plugins/genie/skills/dream/SKILL.md plugins/genie/skills/council/SKILL.md | wc -l | grep -q 2 && echo "PASS" || echo "FAIL"
```

**depends-on:** Group 1

---

### Group 5: Review + QA

**Goal:** Full review and quality gate across all groups.

**depends-on:** Group 1, Group 2, Group 3, Group 4

---

## QA Criteria

- [ ] All 10 updated skills reference `genie task` commands correctly
- [ ] All 10 updated skills include graceful degradation (warn if PG unavailable, don't fail)
- [ ] 4 unchanged skills (brain, refine, learn, docs) not modified
- [ ] `/genie` CLI reference is complete and accurate against v4 commands
- [ ] `bun run check` passes clean
- [ ] Skills are prompt-only changes (SKILL.md files) — no TypeScript modified

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Skills are prompts, not code — agents may not follow new instructions perfectly | Medium | Clear, specific CLI commands with exact syntax. Test with real dispatch. |
| PG may not be available in all contexts | Low | Every skill includes graceful degradation: "if task exists, comment on it; otherwise skip" |
| Too many task comments could be noisy | Low | Skills only comment on significant events (start, complete, fail), not every step |

## Files to Create/Modify

```
MODIFIED (10 SKILL.md files):
  plugins/genie/skills/genie/SKILL.md
  plugins/genie/skills/work/SKILL.md
  plugins/genie/skills/review/SKILL.md
  plugins/genie/skills/wish/SKILL.md
  plugins/genie/skills/brainstorm/SKILL.md
  plugins/genie/skills/fix/SKILL.md
  plugins/genie/skills/trace/SKILL.md
  plugins/genie/skills/report/SKILL.md
  plugins/genie/skills/dream/SKILL.md
  plugins/genie/skills/council/SKILL.md

UNCHANGED (4 skills):
  plugins/genie/skills/brain/SKILL.md
  plugins/genie/skills/refine/SKILL.md
  plugins/genie/skills/learn/SKILL.md
  plugins/genie/skills/docs/SKILL.md
```
