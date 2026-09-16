# Genie board for DSH Web

The plugin adds three entries to the DSH Web sidebar, each a global panel in the
main column: **Genie board**, **Skills** and **Workflows**. Every panel starts with
a registered repository workspace picker.

- **Genie board** shows a board's lanes, cards, owners, liveness, blocks,
  dependencies, comments and history. Select a card to move, comment, block/hold,
  unblock, claim, release or complete it; Add creates a task on the selected board.
  Refresh and returning to the visible tab read a complete board again; there is no
  polling.
- **Skills** lists the repository's `skills/<name>/SKILL.md` catalog with a filter,
  the shipped resources of each skill, and the document body. Entries are grouped
  under category headers in taxonomy order (lifecycle, routing, delivery,
  investigation, authoring, verification, integration, skill-ops, then anything
  uncategorized), read from the optional flat `category:` frontmatter key; the
  optional `mutates:` key shows as a quiet tag. Both keys are optional and closed:
  an unrecognised value is dropped rather than shown, so a typo never invents a
  category header. The panel is a
  read-only view of the git-tracked source; it does not feed the DSH model. The
  DSH body already reads genie's skills through the one recorded channel: `genie
  install`/`update` copy the pinned tree into `~/.agents/skills`, which DSH's stock
  `skill-filesystem` discoverer (mounted by the `standard` and `ptc` agent presets)
  serves as source `user-agents`, rank 500, with each skill directory as its
  resource base. A council on 2026-09-15 decided against a plugin `ctx.skills`
  provider: it would duplicate delivery outside the install record, bypass the
  `--integrations none` consent, need its own invalidation, and couple the board
  row to the skill service. To dogfood a checkout instead of the installed copy,
  add a profile patch row — `id: skill-filesystem`, `config.customSkillDirs:
  ['<checkout>/skills']` (rank 300, watched) — which shadows the release copy as an
  explicit, visible operator choice.
- **Workflows** lists the repository's `.claude/workflows/<name>.js` catalog (the
  canonical saved-workflow format), each script's phases and when-to-use guidance,
  and the script body. Both catalogs are read-only: nothing is executed from the
  panel.

The panels are React components rendered through DSH's own slot system
(`sidebar.panellist` + `main`), styled with DSH alias tokens so they follow the
active theme, and built against the frozen browser module table (React and
`@deepseek-ai/dsh-client-ui-primitives`).

## Four rows: one manager, three sub-plugins

The Host half is four cordis rows, all from this one package:

| Row id | Package specifier | Registers |
|---|---|---|
| `genie-dsh-board` | `@automagik/genie-dsh-board` | the `genieRuntime` service and `/api/genie-board/health` |
| `genie-dsh-board-board` | `@automagik/genie-dsh-board/board` | `/workspaces` and the one mutating `/action` |
| `genie-dsh-board-skills` | `@automagik/genie-dsh-board/skills` | `/skills` and `/skills/document` |
| `genie-dsh-board-workflows` | `@automagik/genie-dsh-board/workflows` | `/workflows` and `/workflows/document` |

The **manager** row owns everything the sub-rows must not each own a copy of:
the Genie executable resolved once with its compatibility verdict, workspace
resolution, and **the whole trust fence** — loopback address, loopback `Host`,
exact `Origin` on POST, `Sec-Fetch-Site`, the 415 content-type check, the 16 KiB
body cap, the derived socket deadline and the single error shape. It publishes
them as the cordis service `genieRuntime`, and a sub-row registers every route
through `genieRuntime.route`. A sub-row that cannot resolve the service
registers nothing at all and never resolves an executable of its own.

A sub-row waits for that service through cordis' **deferred**
`ctx.inject(['genieRuntime'], …)` (the `whenRuntime` helper in `src/runtime.ts`),
never a row-level `export const inject`. A row-level `inject` is a *hard*
dependency: cordis parks the row's own fiber in `PENDING` while the service is
missing, and DSH's boot audit fails the whole Host on any enabled loader entry
that is still pending once the tree settles. That is why disabling only the
manager row used to kill DSH with `3 entries did not activate` (one
`pending (waiting for service: genieRuntime)` line per sub-row) instead of
simply dropping the Genie panels. With the deferred form each sub-row activates
immediately and its callback runs in a child fiber — invisible to the boot audit
— if and when the manager provides the service.

The fence stays singular on purpose. Three copies drift, and the first row that
forgot `Origin`-on-POST would reopen CSRF against a loopback service that can
spawn the Genie binary.

Health reports which sub-rows are mounted and the resolved config of each:

```json
{
  "compatible": true, "version": "5.x.y", "executable": "/…/genie",
  "mounted": { "board": true, "skills": true, "workflows": true },
  "config": {
    "manager": { "deadlineMs": 10000, "outputBudgetBytes": 4194304 },
    "board": { "order": 10 },
    "skills": { "order": 11, "groupBy": "category" },
    "workflows": { "order": 12 }
  }
}
```

Degraded mode is unchanged: a missing or incompatible binary records the error,
health stays up, the read-only catalogs still serve, and only the mutating route
is withheld.

### Per-row config, and disabling a row

Every row takes a `config` block, and every key has a default, so a row inserted
with no config behaves exactly as it did before the split. Each schema is a
[Standard Schema](https://standardschema.dev) object the DSH loader validates
against (`Config`), wrapping the same pure `resolveConfig` function the unit
tests call — so a test and a live profile can never disagree about what a config
means. The validator is hand-written rather than schemastery: the Host bundle is
fully bundled by esbuild from a dependency-free source tree, and cordis requires
only a Standard Schema object, not that library specifically.

| Row | Key | Default | Refinement |
|---|---|---|---|
| manager | `deadlineMs` | `10000` | the derived socket deadline is `deadlineMs + 5000` and must stay at or under the 120 s ceiling, so the socket timer always strictly outlives the handler budget |
| manager | `outputBudgetBytes` | `4194304` | hard maximum of 4 MiB; a larger budget cannot help, because the whole answer is buffered before the browser sees any of it |
| board | `order` | `10` | 0–1000 |
| skills | `order` / `groupBy` | `11` / `category` | `category` or `name` |
| workflows | `order` | `12` | 0–1000 |

Any row can be turned off from a profile patch by its id:

```yaml
- id: genie-dsh-board-skills
  disabled: true
```

That row then registers no route, and health stops reporting it as mounted — so
the browser drops its panel instead of leaving one that 404s on first use.

**The manager row is disableable too**, and it is the one whose absence takes
the whole suite with it:

```yaml
- id: genie-dsh-board
  disabled: true
```

DSH then boots normally with **no Genie surface at all**: the three sub-rows
activate cleanly and register nothing, so `/api/genie-board/health` is absent
along with `/workspaces`, `/action`, `/skills`, `/skills/document`,
`/workflows` and `/workflows/document` — every one of them a plain DSH 404 — and
the browser half shows no Genie panels because it has no health to gate them on.
This is the supported way to keep the plugin installed while turning it off.

`scripts/dsh-genie-board-smoke.ts` mounts both patches as its acceptance proof:
phase two disables `genie-dsh-board-skills` and phase three disables
`genie-dsh-board`, holding the Host up past the loader audit (a printed
authenticated URL is *not* a boot — `dsh web` prints one before it audits the
settled tree) and then proving every route 404s. `src/board.test.ts` asserts the
same two shapes against a fake cordis context, plus the rule that keeps the
manager-disabled case working: no sub-row module exports a row-level `inject`.

### Why the client half is NOT split (2026-09-15)

The Host is four rows; the browser bundle is deliberately still **one**, with a
single `exports["./client"]`. DSH's own loader makes per-sub-plugin client
entry points impossible today:

- `dsh-client-modules/lib/index.js` l.825 keys the client module table by
  **package name**, so three rows of one package cannot own three client halves.
- `clientExportOf` (same file, l.155-165) resolves only `exports["./client"]`
  and nothing else.
- `exactPackageSpecifier` (l.132-138) returns `undefined` for a three-segment
  scoped specifier, so on the non-`internal` path a subpath-only row resolves no
  client half at all.

So `src/client/index.ts` splits its old panel loop into three labelled
`ctx.effect` registrations inside the one bundle, and gates each on what the
manager reports as `mounted` — never on loader row state. Each registration also
refuses to own a panel id another plugin already holds: it checks slot occupancy
first and warns instead of overwriting. Revisit per-row client entries only when
the loader gains a subpath client contract; do not re-derive the idea from a
blueprint without re-reading those three call sites.

The package is **not** renamed to `@automagik/genie-dsh` either. That is a
decision, not an omission: subpath exports deliver the whole sub-plugin
structure at zero release cost, while a rename would have to move
`~/.dsh/profiles/web/package.json` (both the `link:` dependency key and
`dsh.profile.bundles`) and `DSH_PLUGIN_MEMBERS` in the same change.

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

The immutable artifacts are the four Host bundles — `dist/index.js`,
`dist/board.js`, `dist/skills.js`, `dist/workflows.js` — and `dist/client.js`
(browser). Each is enumerated explicitly in `DSH_PLUGIN_MEMBERS`; the attested
tarball gaining a member is a reviewed change, never a build detail.
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
and never a Host path. A failure the CALLER caused is separated from that: on
every route, read ones included, an invalid document name, an unknown document
and an unknown or missing workspace answer `400` with one vetted sentence
(`Invalid name`, `Document not found`, `Unknown workspace`, `workspaceId
required`), so the panel and an operator can tell a bad request from a broken
Host. Those four sentences are constants; no other message reaches a read route's
body. Remote/reverse-proxy operation is intentionally unsupported.

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
newest 25 entries of a longer history, capped independently of each other, and
both panes say "showing last N of M" using the `eventCount`, `eventsTruncated`
and `commentCount` the aggregate carries. The Comments pane renders that
`comments` window itself rather than filtering the event window, so it never
shows fewer messages than its own count; worker reports and every other event
are in History, and a report's row carries the handoff text `genie task report`
stored, not just the word "Reported".

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
lists would both miss fails here. `src/client.test.ts` renders the browser half with
real React on a DOM stand-in — DSH's frozen browser module table is stubbed to
the plain elements it wraps — and asserts on the emitted markup: the laneless
mark in the board picker, and the comment window with its "showing last N of M"
label.

The smoke rebuilds `dist/` itself before installing, so it can never pass
against a bundle left over from an earlier build; a failing plugin build fails
the smoke. It installs into a disposable DSH_HOME, registers a disposable
repository through the real workspace registry, starts/stops/restarts DSH, verifies plugin
listing and compatibility, creates and moves a task through Host routes, then
removes the plugin and temporary state in `finally`. Personal profiles are not used.
Its second phase relaunches the same profile with `genie-dsh-board-skills`
disabled by id and asserts both halves of the contract: the row's routes are
absent, and health reports `mounted.skills: false` — which is what the browser
gates its panel on. Its third phase relaunches with the **manager** row
`genie-dsh-board` disabled instead, holds the Host up for ten seconds past the
printed URL so the loader's settled-tree audit has run, and then requires a 404
from every route in `GENIE_ROUTES` — `/health` included. That is the regression
guard for the boot abort described under *Per-row config, and disabling a row*.

## Release verification

The release payload includes this document, NOTICE, both Cordis manifests,
package metadata, the four Host row bundles and the browser bundle. The
repository verifier requires all ten members independently on all four supported
platforms:

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
