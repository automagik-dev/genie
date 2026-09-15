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
Source builds use the root checkout version as their compatibility floor.
Release packaging stamps `minimumGenieVersion` and package version together and
rebuilds the Host with that exact candidate without changing checkout metadata. Startup
checks strict SemVer using the fixed executable's version; incompatible or invalid
versions expose health only, with no board operation routes.

## Trust and consistency

The Host resolves Genie once at startup: every PATH entry first, then
`$GENIE_HOME/bin`, `~/.genie/bin` and `~/.local/bin`, so a DSH launched from a
desktop session that never sourced a shell profile still finds an installed
Genie. `/api/genie-board/health` reports the executable it picked. The Host
canonicalizes it and runs only fixed argv with `shell: false`. Its environment is
limited to PATH, HOME, GENIE_HOME, NO_COLOR, GENIE_AGENT_NAME and
GENIE_AGENT_KIND. The Host identity is derived from its OS user and hostname.
Browser requests contain only registry IDs, selected board/task IDs and validated
action fields. They never supply paths, worker identity, executables, environment
or commands. Positional comment arguments use the standard `--` boundary so
option-shaped text is literal. All routes first apply DSH connection
authentication (its signed browser-session cookie), then require a loopback
address and a loopback Host header, and reject any cross-origin Origin or
Sec-Fetch-Site. A mutation additionally requires an exact Origin and
application/json; a read does not, because a same-origin `fetch` sends no Origin
and older Safari/Firefox and embedded WebViews send no Sec-Fetch-Site either.
Every route answers exactly once, including when its handler throws: an
unexpected failure is a 500 with a generic message, never an unanswered request
and never a Host path. Remote/reverse-proxy operation is intentionally
unsupported.

The Host retains bounded **selection evidence**, not board content: registry ID,
canonical repository path, listed board IDs, and the selected board's task IDs and
lane names. Explicit list then load establishes this evidence. One request per
workspace may run at a time; concurrent selection/mutation requests reject. Every
list/load still invokes Genie once, and mutations invoke the fixed action then one
complete aggregate read. No previous aggregate is served or optimistic change
rendered. Workspace removal, path changes, a killed child (deadline or output overflow)
and a failed refresh invalidate evidence. A command that ran and refused does
not: Genie applies a verb in one transaction, so a non-zero exit changed
nothing, the selection stands and the browser keeps the board and the open card
it acted on while showing the refusal. That refusal is Genie's own first
`Error:` line, or the tail of its stderr — never a bare exit code. A mutation
followed by a failed refresh reports that the operation may have completed and
requires reload; never automatically retry it.
The selection authorizes the last confirmed board; direct external database edits
or task imports racing a request are outside this snapshot guarantee.

CLI work has a shared 10-second deadline and 4 MiB combined stdout/stderr budget.
The active child is killed on timeout/output overflow/error. The request's own
answer deadline is strictly longer than that budget (10 s + 5 s), so a hung child
produces a 504 JSON body rather than a destroyed socket, and the socket's idle
timer is armed later still. Request bodies are limited to 16 KiB.

The aggregate schemas accept everything the CLI can emit and nothing more
convenient: duplicate lane names (`board create X --lanes A,A` makes them), empty
comment notes, and any bounded identifier `task import` can store, including ids
that match no generated pattern. Unknown keys pass through, because the emitter's
contract is additive under `schemaVersion` 1; a different `schemaVersion` is
reported as an incompatible-genie message naming both versions. Typed text keeps
newlines, tabs and format characters (ZWJ, soft hyphen) exactly as the CLI stores
them; only C0 controls and DEL are refused, and a rejected request answers with
one sentence, never a Zod issues array. A card's timeline and comments are the
newest 25 entries of a longer history, and the view says "showing last N of M"
using the `eventCount`, `eventsTruncated` and `commentCount` the aggregate
carries.

Genie bounds the whole aggregate, not just each card: past a few hundred busy
cards (or roughly 750 quiet ones) it narrows every card's embedded history
(25 → 10 → 5 → 2 → 0 entries, reported as the payload's `eventLimit`) so the
response stays inside this Host's budget, and the counts stay exact at every
step. Cards are never dropped. A board too large to serialize even with no
history at all — around 4,000 cards — is refused by Genie itself with a sentence
naming the board and telling you to scope the read to a wish or split the board;
the view shows that sentence and keeps the board it already had. Overrunning this
Host's 4 MiB budget is reported the same way, as a board-size message rather than
a bare overflow.

Laneless legacy boards (a `boards.lanes` that migration or an import left NULL or
unparsable) do not expose the lane aggregate. The picker marks them `(no lanes)`
and loading one says so explicitly instead of surfacing a schema failure.

A card claimed from this board is claimed by the Host identity, so the Host keeps
it alive: the claim heartbeats immediately (it renders `running`, not `stale`)
and again every 4 minutes for as long as the plugin process lives — Genie renders
a claim `running` for 5 minutes after its last heartbeat, `idle` up to 2 hours,
and any worker may reclaim a card whose claim is older than 15 minutes. Releasing
or completing the card, or seeing it claimed by someone else, stops the pulse;
so does unloading the plugin. The plugin has no database access, persistence,
filesystem watcher, task poller, or autonomous agent runner.

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

`src/contract.test.ts` runs the REAL CLI (`bun <repo>/src/genie.ts`) against a
seeded temporary repository through this plugin's own process layer and parses
its output with these schemas, so a producer change that the two hand-written key
lists would both miss fails here. `src/client.test.ts` mounts the browser half on
a minimal DOM stand-in and drives it end to end.

The smoke rebuilds `dist/` itself before installing, so it can never pass
against a bundle left over from an earlier build; a failing plugin build fails
the smoke. It installs into a disposable DSH_HOME, registers a disposable
repository through the real workspace registry, starts/stops/restarts DSH, verifies plugin
listing and compatibility, creates and moves a task through Host routes, then
removes the plugin and temporary state in `finally`. Personal profiles are not used.

## Release verification

The release payload includes this document, NOTICE, both Cordis manifests,
package metadata and both Host/browser bundles. The repository verifier requires
all seven members independently on all four supported platforms:

```sh
bun scripts/verify-dsh-genie-board-release.ts --unsigned-artifact-dir dist --version VERSION
bun scripts/verify-dsh-genie-board-release.ts --signed-artifact-dir dist --version VERSION --channel stable
bun scripts/verify-dsh-genie-board-release.ts --release vVERSION --channel stable
```

Unsigned mode proves packaging only. Signed modes require `cosign`,
`slsa-verifier`, and `gh` in PATH. They verify descriptor digests, cosign identity,
SLSA provenance, and the signed delivery endorsement binding the descriptor to
its candidate/source identity for every artifact. Release mode
reads back the published tag/source binding. Stable publication still requires
the protected production approval in the existing Release workflow. Only after
that publication and the release-mode proof may a maintainer add the `dsh-plugin`
repository topic and read it back. No local build authorizes that action.
