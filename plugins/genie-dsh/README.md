# @automagik/genie-dsh

Genie for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), on the
Automagik Bot team ([`@automagik/bots-dsh`](https://github.com/automagik-dev/automagik/tree/dev/apps/bots-dsh)).
It adds **Genies**, Bots that grant wishes in a project: each wish runs as its own thread, in its
own copy of the project on a `wish/<name>` branch, and reports back to that Genie's chat. A team
can have many Genies, one per repository, each in its own color.

## What it does

- **Genie**: the first time the plugin loads with the Bot team, it makes one Bot of kind `genie`
  (drawn as the clay Genie). Its project is a new folder in the team workspace
  (`<team workspace>/genie`), started as a git repository on `dev` the first time Genie needs it.
  To work in your own repository, pick it as Genie's **Working folder** in its settings. A Genie
  you delete is not made again.
- **More Genies**: the `genie-create` endpoint of the Bot team (`POST /api/omni-ui`,
  `{ endpoint: 'genie-create', payload: { folder } }`) adds a Genie for the git repository
  `folder` is in, named `Genie` while that is free, else `Genie <repository>`. A repository that
  already has a Genie answers that Genie instead (`existed: true`). Each Genie takes the first
  color no other Genie wears (`GENIE_COLORS`, twelve); with all twelve worn, a new one is
  refused. The team view's `genie.colors` and `genie.taken` say which are free.
- **Granting a wish**: Genie's `grant_wish` tool (Genie only) first binds the wish to its
  repository, fresh each time: the base branch is `genie context`'s (a local `dev`, else the
  remote's default branch, `<remote>/HEAD`), and the remote is `branch.<base>.remote`, else
  `origin`, else the only one. The host fetches that branch in your repository, with your own
  git configuration and credentials (`git fetch --no-tags --recurse-submodules=no <remote>
  refs/heads/<base>`), and takes the commit from that fetch's `FETCH_HEAD`, never from a
  remote-tracking ref. A failed fetch refuses the wish with git's error and its fix; it never
  falls back to your local HEAD. A repository with no remote runs from local HEAD (`local` mode).
  Then it makes a local clone in `<team workspace>/wishes/<project>/<name>`, on a new branch
  `wish/<name>` from that commit, and hands the wish to a Tasks session there (the Bot team's
  `startTask`). The thread plans, makes the change, runs the project's own checks, commits on its
  branch and ends with a short report. A plain wish's copy has no push route: its `origin` (your
  checkout) has a push URL that goes nowhere and its credential helper is empty, and there is no
  `publish` remote. The real boundary against a URL an agent spells by hand is DSH's sandbox.
- **A follow-up wish, scoped to branches**: a wish that must repair or publish branches an
  earlier wish made passes their names in `grant_wish`'s optional `branches` list. Those existing
  branches are created as local branches in the wish's copy, and the project's real remote becomes
  its `publish` remote. The brief then lets that wish commit on exactly those branches, push them
  to `publish` and open or update their pull requests — never force-push, merge or deploy, and
  never touch a branch the wish was not given. The branch the project is on (the integration
  branch) and `main`/`master` are never grantable, so a wish cannot bypass review. With no
  remote, a scoped wish commits its repairs and reports that it could not publish. A remote whose
  `http(s)` URL has a user name or password written into it refuses a scoped wish, so no secret is
  copied into its copy, and the branch wishes start from is never grantable either.
- **When it ends**: the team brings the thread's report to Genie's chat. This plugin counts what
  moved in the wish's copy (the wish branch against its base, each given branch against the
  commit it was given on), fetches the given branches back on every end, and the wish branch
  whenever it is ahead. The outcome is one of **Local branch** (`local-only`: a branch moved; it
  is in your repository as a local branch, not published), **No change** (no branch moved),
  **Stopped**, **Failed** or **Lost** (the team no longer has the task's record). Nothing is
  called done or delivered. A wish that ended while DSH was closed is settled at the next start,
  from the team's task record, once the team's resume pass is over.
- **In the sidebar**: a running wish shows as a thread under Genie (the team's task threads); the
  last ended ones stay listed under Genie with their outcome, and open their thread.
- **No git**: on a Mac without the Command Line Tools, Genie says so with the one-line fix
  (`xcode-select --install`) instead of starting git, which would open Apple's install dialog.

Why a clone and not a `git worktree`: DSH's `workspace-write` sandbox lets a session write only
under its folder, and a worktree's commits land in the project's own `.git`, outside it.

## Install

- In the Automagik desktop app: the welcome's Genie card installs it.
- In your own DSH, next to `@automagik/bots-dsh`: add it from a git source pinned to a commit,
  `git+https://github.com/automagik-dev/genie.git#<commit>&path:/plugins/genie-dsh`.

Its data is one file beside the team's, `genie.json` in the team home (`~/.omni/ui`): the wishes
and whether Genie was made. A wish record (v2) keeps its binding (the remote only in the form
above: an `http(s)` URL without its user name or password), its base commit, its outcome, and
the evidence: every git command the host ran for it as `{ step, argv, code, ms }` (the newest 40),
with the base, head and ahead counts. Records written before v2 load and show as they did.

## Host contract

Every member of the Bot team's runtime (`rt`) and of DSH's context (`ctx`) this plugin uses, with
what provides it (bots-dsh files are under `apps/bots-dsh` in automagik-dev/automagik). The test
fake fails on any member that is not in this table, so a new use has to be added here first.

| Member | Provided by | Used for |
|--------|-------------|----------|
| `rt.home` | `index.js` | where `genie.json` lives |
| `rt.state.bots` | `src/host/store.js` | the Genie Bots |
| `rt.state.tasks` | `src/host/agents.js` | a wish's task status, at startup and right after the grant (not a documented API) |
| `rt.load` | `src/host/store.js` | waiting for the team's state |
| `rt.save` | `src/host/store.js` | saving the team after a grant |
| `rt.readOnly` | `src/host/store.js` | no writes while another dsh holds the team |
| `rt.findBot` | `src/host/store.js` | a free Genie name |
| `rt.selfOf` | `src/host/store.js` | who called `grant_wish` |
| `rt.botOf` | `src/host/store.js` | the caller's Bot |
| `rt.createBot` | `src/host/roster.js` | making a Genie |
| `rt.ensureWorkspace` | `src/host/roster.js` | the team workspace for Genie's first project |
| `rt.teamFolder` | `src/host/folders.js` | where wish copies live |
| `rt.workDirOf` | `src/host/folders.js` | a Genie's project folder |
| `rt.defaultModel` | `src/host/models.js` | whether a new Genie waits for a model |
| `rt.startTask` | `src/host/agents.js` | the wish's Tasks session |
| `rt.cutByRestart` | `src/host/resume.js` | a turn a restart cut is no end |
| `rt.resumesDone` | `src/host/resume.js` | the startup pass waits for the team's resume pass |
| `rt.warn` | `src/host/diagnostics.js` | warnings |
| `rt.hooks.view` | `src/host/extend.js` | the wishes in the team view |
| `rt.hooks.endpoint` | `src/host/extend.js` | `genie-create` |
| `ctx.on` | DSH (cordis `Context`) | `session/event`, for turn ends |
| `ctx.effect` | DSH (cordis `Context`) | registrations that go with the plugin |
| `ctx.tools.register` | DSH (`@deepseek-ai/dsh-tools`, the `tools` service) | `grant_wish` |

## Develop

Node runs the tests, as it runs DSH; they need the Bot team's DSH harness (`bun run harness` in
automagik's `apps/bots-dsh`, found beside this repository, or `BOTS_DSH` / `DSH_HARNESS`).

```sh
bun install                         # esbuild, for the client build
node scripts/build-client.mjs       # src/client → client.js (committed; --check verifies it)
npm test                            # node --test with the harness resolver
```

`client.js` is committed so git installs need no build. This package has its own gate, like
`mikro/`: the repository's `bun test` and Biome skip it where noted in `bunfig.toml` and
`biome.json`.

## License

MIT, as the genie repository ([LICENSE](LICENSE)).
