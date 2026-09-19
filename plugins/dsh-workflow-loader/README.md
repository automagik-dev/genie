# dsh-workflow-loader

Run a repository's saved workflow catalog on a DSH body, **by name**.

A workflow saved at `.claude/workflows/<name>.js` is a Claude Code Workflow
script. `plugins/dsh-genie-board` already *lists* that catalog in the Web UI; this
row is the other half — the one that runs one. The catalog panel ships a browser
half, this row ships a host half, and neither knows about the other.

## Why this exists (and why it is a loader, not a fork)

Wish [`dsh-workflow-fork`](../../.genie/wishes/dsh-workflow-fork/WISH.md) put a
seam comparison in front of every other group. Group 0
([evidence](../../.genie/wishes/dsh-workflow-fork/docs/seam-comparison.md))
asked whether to fork a QuickJS workflow plugin or write a thin loader over DSH's
first-party `ctx.workflowEngine`, and answered **loader**:

- the catalog uses **none** of what a fork exists to shim — `budget(` 0,
  `workflow(` 0, `isolation` 0, `agentType` 0, clock APIs 0, model aliases 0
  across all nine scripts; the options it does use are `model:` and `effort:`;
- the engine already supplies `agent` + `schema` + `model`, `parallel`,
  `pipeline`, `phase`, `log` and `args`;
- the `spawn` provider already advertises `outputSchema`, `depthLimit`,
  `persona`, `toolFilter` and `agentOptions`, so no new subagent seam is needed;
- and a recorded run proves it: `.claude/workflows/council.js` with its
  `export const meta` split off and `effort` dropped ran to completion —
  `workflow "council" completed (6 agents)`, `decision: gather-evidence`.

The fork stays the answer for the triggers Group 0 names (worktree isolation,
nested `workflow()`, `budget`, a runtime-enforced clock ban, model aliases). Each
of those is a loud refusal here rather than an approximation.

## What the tool does

One model-facing tool, `workflow_run` by default:

| Argument | Meaning |
|---|---|
| `name` | The workflow name — the filename stem, e.g. `council` |
| `args` | The workflow's own arguments, exactly as it documents them |
| `cwd` | Optional repository root; defaults to the calling session's working directory |

It resolves the name, transforms the file, starts a run on `ctx.workflowEngine`,
waits for it, writes the **complete** return value to a journal, and hands the
model a bounded projection plus that path. The script never passes through the
model's context, so a 106 KB workflow costs the same as a small one.

## The two transforms

A saved file is not runnable as-is on this engine, and both differences are
verified rather than assumed (the exact engine messages are in the Group 0
evidence):

1. **`export const meta = {...}` is lifted off the body** into the `meta` request
   field. The engine rejects the statement at parse:
   *"workflow meta rides the `meta` request field, not the script"*. The literal
   is parsed as data — never evaluated — and the catalog contract requires it to
   be a pure literal, so anything computed is refused by name.
2. **`effort` is dropped from `agent()` option objects** — the engine rejects it
   at the call: *`agent() option "effort" is deferred and not supported by this
   engine`*. The removal is call-scoped and AST-free:

   - the lexer masks strings, templates, comments and regex literals, so `agent(`
     in a prompt is prose and `effort` in a prompt is text;
   - a property is only removed when it sits in a property position (after `{` or
     `,`) of the **second argument** of an `agent()` call;
   - an option this engine does not know refuses the run instead of being
     passed through, because the engine would reject it one call later with less
     context;
   - the transform must compile (`new Function`, wrapped exactly as the engine
     wraps a body) before it is returned. A transform nobody can compile is a
     refusal, never a half-rewrite.

   This distinction is not cosmetic: `workfly.js` defines `effort: enumOf([...])`
   and `effort: str` as **schema fields**, and `docs-audit.js` carries `effort` on
   every `SURFACES` entry. Those are data the run depends on. Across the nine
   catalog files the transform removes 35 options (7 files) and preserves every
   data occurrence.

Absent hooks (`budget()`, `workflow()`, `isolation`, `agentType`) are refused with
a line number. None is used by the current catalog, so the refusal is a guard for
the next script, not a limitation today.

## Catalog roots

- project: `<cwd>/.claude/workflows/<name>.js`
- personal: `~/.claude/workflows/<name>.js` (override with `userRoot`)

A name carried by **both** roots is refused by name, not resolved by luck: which
root wins is undocumented upstream, and on 2026-09-15 a stale personal copy
shadowed a repository's own file (`workflows-catalog`). `allowShadowing: true`
accepts the project copy instead.

## Result delivery

The consumer caps the model-facing projection (50000 characters on the installed
host), and a run that returns more loses its **tail** — the recorded `council` run
lost its synthesis block exactly that way. So the full value goes to
`<DSH_HOME>/workflow-runs/<timestamp>-<name>-<runId>.json` (deliberately outside
the DSH run root) and the tool returns the head plus how much it left out.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `toolName` | `workflow_run` | The model-facing tool name |
| `maxResultChars` | `20000` | Projection budget; the journal always holds everything |
| `journalDir` | `<DSH_HOME>/workflow-runs` | Where full results are written |
| `allowShadowing` | `false` | Accept the project copy when both roots carry a name |
| `userRoot` | `~/.claude/workflows` | The personal root |

## Tests

```bash
bun test src/          # the dialect, the catalog, and the row end to end
```

`src/dialect.test.ts` runs against **this repository's own catalog** — all nine
files must split, transform, compile and lint clean, with the removal counts
cross-checked against an independent TypeScript-AST transform. `src/tool.test.ts`
drives the row with a stub `ctx.workflowEngine` that executes the submitted script
in-process, so resolution, the transform, journaling and the projection are
covered without a host.

## Not done yet

- **The release payload does not carry this plugin.** `scripts/build-binary.sh`
  enumerates `plugins/dsh-genie-board/*` explicitly and `scripts/version.ts`
  stamps the packages the tarball ships; adding a member is a release-contract
  change and belongs to the group that wires it, not to this row's first cut.
- **No host smoke.** The row is tested against a stub engine, not a running
  profile. The board's `scripts/dsh-genie-board-smoke.ts` is the pattern to copy
  once the payload carries it.
- **No client half.** Discovery stays in the board's catalog panel.
