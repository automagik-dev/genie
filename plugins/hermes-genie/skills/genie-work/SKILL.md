---
name: genie-work
description: Work execution discipline for Genie wishes — dry-run work plans first, dispatch stays in the Genie/Claude Code lane, reviewer differs from engineer.
---

# Genie Work Discipline

## Work-plan first

- Always produce a work plan before anything moves: call `genie_work_plan`,
  which runs `genie launch <slug> --dry-run`. Read it and surface it to the
  operator before any execution is even proposed.
- No direct execution unless the user explicitly requested it. The dry-run
  plan is the default deliverable of this skill; execution is a separate,
  explicitly approved step.

## Dispatch stays in the Genie lane

- Execution is dispatched through Genie / Claude Code workers — never
  re-implemented ad hoc inside the Hermes session and never routed around
  the Genie task state.
- The reviewer must differ from the engineer: never assign review of a task
  group to the worker that implemented it.

## Validation evidence

- Cite validation evidence with every progress claim: the exact command run,
  its key output, and the wish/task references it affects. A claim without
  evidence is a plan, not a result.
