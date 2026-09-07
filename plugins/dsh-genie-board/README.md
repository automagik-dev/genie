# Genie board for DSH Web

Open **Genie board** from the button in DSH Web. Choose a registered repository
workspace and board to view its lanes, cards, owners, activity, blocks, dependencies,
comments, and history. Select a card to move, comment, block/hold, unblock, claim,
release, or complete it. Create adds a task to the selected board. Refresh and
returning to the visible tab read a complete board again; there is no polling.

## Build and install

Requires Bun (checkout builds), a Host-installed Genie CLI, and DSH
**0.1.2-rc.1 or newer**. This floor was exercised with the actual installed Host.

```sh
bun run build:plugin
dsh plugin --profile web add link:/absolute/path/to/genie/plugins/dsh-genie-board
dsh plugin --profile web list --depth 0
# Restart DSH after installation.
dsh web --no-open --host 127.0.0.1 --port 0
```

The immutable artifacts are `dist/index.js` (Host) and `dist/client.js` (browser).
`minimumGenieVersion` in package.json is the checkout version for source builds;
the release packaging step stamps it and the package version together. Startup
checks strict SemVer using the fixed executable's version; incompatible or invalid
versions expose health only, with no board operation routes.

## Trust and consistency

The Host resolves Genie once from its installation PATH, canonicalizes the
executable, and runs only fixed argv with `shell: false`. Its environment is limited
to PATH, HOME, GENIE_HOME, NO_COLOR, GENIE_AGENT_NAME and GENIE_AGENT_KIND. The Host
identity is derived from its OS user and hostname. Browser requests contain only
registry IDs, selected board/task IDs and validated action fields. They never
supply paths, worker identity, executables, environment or commands. Positional
comment arguments use the standard `--` boundary so option-shaped text is literal. All routes
first apply DSH connection authentication (its signed browser-session cookie), then
require loopback and same-origin browser signals; mutations require exact Origin
and application/json. Remote/reverse-proxy operation is intentionally unsupported.

The Host retains bounded **selection evidence**, not board content: registry ID,
canonical repository path, listed board IDs, and the selected board's task IDs and
lane names. Explicit list then load establishes this evidence. One request per
workspace may run at a time; concurrent selection/mutation requests reject. Every
list/load still invokes Genie once, and mutations invoke the fixed action then one
complete aggregate read. No previous aggregate is served or optimistic change
rendered. Selection errors, failed operations, workspace removal and path changes
invalidate evidence. A mutation followed by a failed refresh reports that the
operation may have completed and requires reload; never automatically retry it.
The selection authorizes the last confirmed board; direct external database edits
or task imports racing a request are outside this snapshot guarantee.

CLI work has a shared 10-second deadline and 4 MiB combined stdout/stderr budget.
The active child is killed on timeout/output overflow/error. Closed schemas reject
incomplete or foreign aggregates. Request bodies are limited to 16 KiB. Laneless
legacy boards do not expose the required complete aggregate and fail explicitly.
The plugin has no database access, persistence, filesystem watcher, task poller,
or autonomous agent runner.

DSH's installed sidebar package exposes no extension slot. The original client
uses its public apply/effect lifecycle to mount an accessible modal board button
without patching DSH sources or observing its DOM.

## Validation

```sh
bun run check
bun run build:plugin
bun test plugins/dsh-genie-board
bun scripts/dsh-genie-board-smoke.ts
```

The smoke installs into a disposable DSH_HOME, registers a disposable repository
through the real workspace registry, starts/stops/restarts DSH, verifies plugin
listing and compatibility, creates and moves a task through Host routes, then
removes the plugin and temporary state in `finally`. Personal profiles are not used.
