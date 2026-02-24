---
name: dream
description: "Batch-execute SHIP-ready wishes overnight — pick wishes, orchestrate workers, review PRs, wake up to results."
---

# /dream — Overnight Batch Execution

Pick SHIP-ready wishes, build a dependency-ordered execution plan, spawn parallel workers, review PRs, produce a wake-up report.

## When to Use
- Human wants to queue multiple wishes for autonomous overnight execution
- Multiple SHIP-ready wishes exist in `.genie/brainstorm.md` under `Poured`

## Flow
1. **Pick wishes** from `.genie/brainstorm.md`.
2. **Generate DREAM.md** with dependency-ordered execution plan.
3. **Human confirms** DREAM.md (may edit before run).
4. **Phase 1 — Execute:** spawn workers per wish, collect outcomes.
5. **Phase 2 — Review:** spawn reviewers per PR, accept or fix.
6. **Write DREAM-REPORT.md** as the wake-up artifact.

## Picker

1. Read `.genie/brainstorm.md`, locate the `Poured` section.
2. Parse each SHIP-ready entry in listed order, extracting `slug` and one-line description.
3. If no entries found, print `No SHIP-ready wishes found in .genie/brainstorm.md` and exit.
4. Display numbered list preserving original order:
   ```
   1. <slug> — <one-line description>
   ```
5. Prompt human to choose by number(s) (`1 3 5`) or `all`. Accept whitespace-separated numbers.
6. Emit selected set in order:
   ```
   - <slug>: .genie/wishes/<slug>/WISH.md
   ```

## DREAM.md Generation

1. For each selected wish, read `depends_on` from its `WISH.md`.
2. Compute topological sort across selected wishes. Assign `merge_order` as integer layers `1..N`:
   - Layer 1: wishes with no selected dependencies.
   - Increment layer when a wish depends on a lower layer.
   - Same-layer wishes are parallel.
3. Generate per-wish entry:

| Field | Value |
|-------|-------|
| `slug` | wish identifier |
| `branch` | `feat/<slug>` |
| `worktree_path` | `/tmp/dream-worktrees/<slug>` |
| `wish_path` | `.genie/wishes/<slug>/WISH.md` |
| `worker_prompt` | self-contained instructions (wish_path, branch, worktree_path, CI command, reporting format) |
| `depends_on` | upstream slugs from WISH.md |
| `merge_order` | integer from topological layering |

4. Write to `.genie/DREAM.md` in the target repository (not the skills repo).
5. Present for human confirmation before execution.

## Dispatch

Runtime-specific dispatch. Detect runtime, then use the matching pattern. Default: Claude Code.

| Signal | Runtime | Dispatch path |
|--------|---------|---------------|
| `Task` tool available with `isolation: "worktree"` | Claude Code | Teams + worktrees |
| Codex environment (`CODEX_ENV` or native subagent API) | Codex | Native subagents |
| Neither above, `term` CLI available | OpenClaw | term -> Claude Code -> Teams |

### Claude Code (primary)

```
TeamCreate("dream-<date>")

Task(
  model: "sonnet",
  isolation: "worktree",
  prompt: "<worker_prompt from DREAM.md>",
  run_in_background: true
)
```

- Parallel tasks: multiple `Task` calls with `run_in_background: true` in one message.
- Review tasks: separate `Task` (different subagent from implementor).
- Coordination: `SendMessage` for inter-agent communication.
- Cleanup: `TeamDelete` after all workers report.

### Codex

```
codex_subagent(
  task: "<worker_prompt from DREAM.md>",
  sandbox: true
)
```

Isolation is Codex-managed. Documented for future validation.

### OpenClaw

```bash
term spawn --name "worker-<slug>" --model sonnet
# Or for bead-tracked work:
bd create "<task title>" --type task
term work <bead-id>
```

Three-layer chain: OpenClaw -> term -> Claude Code -> Teams. Use timeouts; fall back to sequential on failure. Documented for future validation.

Full reference: `plugins/automagik-genie/references/dispatch-contract.md`.

## Phase 1: Execute

1. Detect runtime (see Dispatch above).
2. Create team context (Claude Code: `TeamCreate("dream-<date>")`).
3. For each wish in DREAM.md, ordered by `merge_order` layer:
   - Same-layer wishes dispatch in parallel.
   - Dispatch one worker per wish using the runtime's dispatch pattern, passing `worker_prompt` from DREAM.md.
4. Collect outcomes via `SendMessage` (Claude Code) or runtime-equivalent.

### Worker Contract

Each worker executes independently:

1. Read WISH.md from `wish_path`.
2. Self-refine task prompt via `/refine` (see Worker Self-Refinement below).
3. Checkout branch in worktree: `cd <worktree_path> && git checkout -b <branch>`.
4. Implement all execution groups from WISH.md.
5. CI fix loop (max 3 retries):
   - Run CI. If fail: fix, `sleep 5`, retry.
   - After 3 failures: mark BLOCKED.
6. Only after CI green: `gh pr create --base <base_branch>`.
7. Report to lead:
   - Success: `DONE: PR at <url>. CI: green. Groups: N/N.`
   - Failure: `BLOCKED: <reason>. Groups: N/N.`

### Worker Self-Refinement

Before executing, workers refine their task prompt:

1. Call `/refine <task-prompt>` (text mode) with WISH.md path as context anchor.
2. Read output from `/tmp/prompts/<slug>.md`.
3. Execute against the optimized prompt.

Fallback: if refiner fails or times out, proceed with original prompt (log warning).
Workers NEVER overwrite WISH.md -- the refined prompt is runtime context only.

## Phase 2: Review

**Trigger:** all execute workers have reported `DONE` or `BLOCKED`.

1. Dispatch one reviewer per open PR from Phase 1 using the runtime's dispatch pattern (see Dispatch above). Skip `BLOCKED` wishes.
   - Reviewer must be a **separate subagent** from the implementor (enforced by dispatch contract).
2. Reviewer loop (max 2 loops per PR):
   - Run `/review` against wish acceptance criteria.
   - `FIX-FIRST`: dispatch fix subagent (separate from both implementor and reviewer), re-run `/review`.
   - Architectural issue: escalate immediately (no fix attempt), record in report.
   - `SHIP`: mark review-complete.
     - Update wish: set `**Status:** SHIPPED` in `.genie/wishes/<slug>/WISH.md`.
     - Close bead: `bd close <slug>` (if unavailable, log warning -- non-blocking).
3. Cleanup:
   - `git worktree remove <worktree_path>` for each wish.
   - `TeamDelete` (Claude Code) or runtime-equivalent to tear down team context.

## DREAM-REPORT.md

Write to `.genie/DREAM-REPORT.md` with this structure:

### Reviewed PRs

| merge_order | slug | PR link | CI status | review verdict |
|-------------|------|---------|-----------|----------------|

### Blocked Wishes
- `<slug>`: blocking reason.

### Follow-ups
- Action items requiring human intervention (escalations, manual decisions, cross-PR sequencing).

## Rules
- Never early-stop: if a wish returns BLOCKED, record reason and continue with remaining wishes.
- Never skip Phase 2 -- every DONE PR must be reviewed.
- Orchestrator never executes wish work directly -- always dispatch workers.
- Do not expand scope beyond what WISH.md defines.
- Always write DREAM-REPORT.md, even if all wishes BLOCKED.
