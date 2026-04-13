# WISH: Document `genie brain` Passthrough in --help Output

**Status:** READY
**Priority:** P3 — docs/DX fix
**Repo:** /home/genie/workspace/repos/genie
**Branch:** docs/brain-help-passthrough
**External:** automagik-dev/genie#1118
**Autonomous:** YES (twin-genie reviewed — scope 1/5, risk 1/5, clarity 5/5)
**Depends on:** none

## Problem

`genie brain --help` only lists 4 subcommands:

```
Commands:
  install           Install genie-brain from GitHub
  uninstall         Remove genie-brain installation
  upgrade           Upgrade genie-brain to latest version
  version           Show installed brain version
```

But at runtime, `genie brain <anything>` passes through to the full `@khal-os/brain` CLI (`status`, `health`, `init`, `search`, `ingest`, `analyze`, `config`, etc.) via the `.allowUnknownOption().allowExcessArguments().action(...)` fallback in `registerBrainCommands`.

Because the help text hides this, users file bugs claiming the feature is broken (see automagik-dev/genie#1118). This is a DX paper cut that is 100% fixable by documentation alone.

## Root Cause

**File:** `/home/genie/workspace/repos/genie/src/term-commands/brain.ts`
**Function:** `registerBrainCommands()` (line 521-565)

```typescript
const brain = program
  .command('brain')
  .description('Knowledge graph engine (enterprise)')      // line 524 — no mention of passthrough
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (_options, cmd) => {
    // Fallback: delegate unrecognized subcommands to the enterprise brain module
    const args = cmd.args;
    if (args.length === 0) {
      brain.help();
      return;
    }
    await executeBrainCommand(args);     // runtime passthrough works correctly
  });
```

The passthrough works. The help text does not advertise it.

## Acceptance Criteria

1. **`genie brain --help` advertises passthrough** — the help output includes a section (footer or richer description) that explicitly tells users: "unknown subcommands are forwarded to the `@khal-os/brain` CLI if brain is installed."

2. **Common forwarded commands listed** — the help footer names the most commonly used passthrough commands so users don't have to guess:
   - `status`, `health`, `init`, `search`, `ingest`, `analyze`, `config`, `mount`, `graph`, `traces`

3. **Example usage shown** — at least one concrete example of passthrough invocation, e.g.:
   ```
   Examples:
     genie brain status
     genie brain search "my query"
     genie brain init --name my-brain --path ./brain
   ```

4. **No runtime behavior changes** — this is pure help-text. The `registerBrainCommands` action handler is untouched. `genie brain install/uninstall/upgrade/version` still work identically. Runtime passthrough still works identically.

5. **Quality gates green** — `bun run typecheck`, `bun run lint`, `bun test`.

## Execution Groups

### Group 1: Add `addHelpText` footer to brain command
**File:** `src/term-commands/brain.ts`

**Pattern reference:** Several existing genie commands already use `.addHelpText('after', ...)` — check `msg.ts`, `team.ts`, `genie.ts` for the exact pattern and match it.

**Changes:**
1. After the `.action(...)` chain (around line 536), chain `.addHelpText('after', ...)`:
   ```typescript
   const brain = program
     .command('brain')
     .description('Knowledge graph engine (enterprise) — forwards unknown subcommands to @khal-os/brain')
     .allowUnknownOption()
     .allowExcessArguments()
     .action(async (_options: Record<string, unknown>, cmd: Command) => {
       // ... existing body ...
     })
     .addHelpText('after', `
Forwarded commands (require @khal-os/brain installed):
  status              Show running brain server status
  health              Show brain health score
  init                Initialize a new brain vault
  search <query>      Search the brain knowledge graph
  ingest <path>       Ingest files into the brain
  analyze <path>      Analyze a file against the brain
  config              Manage brain configuration
  mount/unmount       Mount brains
  graph               Explore the knowledge graph
  traces              View reasoning traces

Examples:
  $ genie brain status
  $ genie brain search "how does login work"
  $ genie brain init --name my-brain --path ./brain

Install brain: genie brain install
`);
   ```

2. Update the `.description()` text to hint at passthrough (as shown above).

### Group 2: Verify help output
**Manual validation:**

```bash
cd /home/genie/workspace/repos/genie
bun run build
./dist/genie.js brain --help | grep -E "Forwarded|Examples|status|health"
# Expected: all four grep terms present
```

## Validation

```bash
cd /home/genie/workspace/repos/genie

# Quality gates
bun run typecheck
bun run lint
bun test src/term-commands/brain.test.ts

# Build + inspect help output
bun run build
./dist/genie.js brain --help

# Expected output includes:
#   "Forwarded commands" section
#   "Examples" section
#   Mention of @khal-os/brain

# Smoke test runtime passthrough still works (if brain installed)
./dist/genie.js brain status  # should still execute via passthrough
```

## Worker Contract

1. Branch: `docs/brain-help-passthrough` from `dev`.
2. Edit `src/term-commands/brain.ts` per Group 1. Match the existing `addHelpText` pattern — grep `addHelpText` in src/ for examples.
3. Run the validation block.
4. Run `bun run check`.
5. Commit: `docs(brain): advertise passthrough commands in --help output`.
6. Push and `gh pr create --base dev --title "..." --body "Closes automagik-dev/genie#1118"`.
7. Report DONE with PR URL via `genie agent send`.

## Context

- **Blast radius:** one file, one method call (`addHelpText`). Zero runtime risk.
- **Why safe for autonomous:** Pure docs/help-text fix. The only failure mode is a typo in the help string, which the CI lint catches.
- **Why this is worth shipping:** The passthrough already works. Every user who hits `genie brain --help` and concludes "the feature is missing" files a duplicate of #1118. A ~15-line addition prevents all future duplicates.
