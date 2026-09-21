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

A name carried by **both** roots is decided by comparing the two files. Which root
wins is undocumented upstream, and on 2026-09-15 a stale personal copy shadowed a
repository's own file (`workflows-catalog`) — but refusing every collision also
refuses the case where both copies are the same bytes:

| The two files | What happens |
|---|---|
| **Byte-identical** | The **project** copy runs, and the result carries a warning naming both paths — identical bytes cannot disagree about what the workflow does. |
| **Divergent** | **Refused**, naming both paths: something changed on one side, and this loader will not guess which. |
| `allowShadowing: true` | The project copy runs regardless, with no warning. |

The refusal is reserved for the one case where guessing could run a workflow you
did not mean. Accepting identical copies is what keeps the tool usable on an
installed host (next section but one).

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

### On an installed host this collision is the common case, not an edge case

The workflows channel (`genie install` / `genie update`) delivers every catalog file
this release ships into `~/.claude/workflows/`, so a repository that carries its own
`.claude/workflows/council.js` has a personal copy of the same name beside it.

That is the identical-bytes row of the table, and it used to be a refusal: before
the comparison rule landed, `workflow_run({"name": "council"})` from inside such a
repository failed on the collision alone. Verified on this host on 2026-09-20 — all
five shipped names hash the same in both roots (`council` = `d51089f2a939`, both
sides) — and the rule now runs them. A live council run raised this as its first
usability finding (`decision: revise`, journal
`<DSH_HOME>/workflow-runs/<ts>-council-<runId>.json`); the byte comparison is the
fix for that finding. The refusal that remains is the one that carries information:
a personal copy that has drifted from the project's.

## Verification

- `bun test src/` — 47 tests: the dialect against this repository's own catalog,
  and the row end to end with a stub engine.
- `bun scripts/dsh-workflow-loader-smoke.ts` — boots a real `dsh web` in an
  isolated `DSH_HOME`/`HOME`/`TMPDIR` tree with the row installed, asserts the
  composed profile carries it, and holds the Host through the 10 s settle window
  the boot audit needs. It found the two defects that would have broken a boot:
  the shipped patch's own `journalDir: ''` and a resolver that was not idempotent.
- The plugin is a **release payload member**: `scripts/build-binary.sh` stages its dist
  into the tarball, `scripts/release-payload-version.ts` stamps its `package.json` with
  the release version, and the release contract names it. An installed host loads the
  released copy (`~/.genie/plugins/dsh-workflow-loader`), not a checkout.
- A live headless session (`dsh --profile headless "<task>"`) on an isolated host
  called `workflow_run` for real: `probe` returned `{ok: true, word: "ok"}` with
  the stripped `effort` recorded in the journal, and `council` completed with six
  agents in 304 s, `decision: revise`, and a 141 KB journal behind the bounded
  projection. That run is what found the missing `workflowEngine` declaration —
  cordis refuses an undeclared service read at CALL time, so registration and the
  boot audit both pass and only a real call fails.

## Not done yet

- **No client half.** Discovery stays in the board's catalog panel.
- **Four open conditions from the loader's live council review** (2026-09-20,
  `decision: revise` — revise means do not default this yet):
  - **Projection budget and ordering.** The projection is a head cut with an omission
    marker; nothing ranks what it keeps, so a workflow whose synthesis lands at the end
    still loses it from the model-visible result. The journal holds everything.
  - **Cost and `stoppedEffort` visibility.** A run reports how many agents it started
    and which `effort` options it stripped, but no cost figure; the engine exposes none.
  - **Failed and cancelled runs are not journaled**, and `<DSH_HOME>/workflow-runs` has
    no retention policy — only completed runs write a file, and nothing prunes them.
  - **The profile mount is not pinned by exact version.** The installed host points a
    `link:` at the released copy, so the loaded loader is whatever that directory holds,
    not a version the profile names.
- **The `effort` policy is a drop, not a mapping.** Effort is recorded in the
  journal and not passed to dispatch; a mapping to a model tier is deferred until
  a body needs it.

