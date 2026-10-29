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
- **Granting a wish**: Genie's `grant_wish` tool (Genie only) makes a local clone of the project
  in `<team workspace>/wishes/<project>/<name>`, on a new branch `wish/<name>` from the project's
  current commit, and hands the wish to a Tasks session there (the Bot team's `startTask`). The
  thread plans, makes the change, runs the project's own checks, commits on its branch and ends
  with a short report. A plain wish never pushes, merges, or touches another branch.
- **A follow-up wish, scoped to branches**: a wish that must repair or publish branches an
  earlier wish made passes their names in `grant_wish`'s optional `branches` list. Those existing
  branches are created as local branches in the wish's copy, and the project's real remote becomes
  its `publish` remote. The brief then lets that wish commit on exactly those branches, push them
  to `publish` and open or update their pull requests — never force-push, merge or deploy, and
  never touch a branch the wish was not given. The branch the project is on (the integration
  branch) and `main`/`master` are never grantable, so a wish cannot bypass review. With no
  remote, a scoped wish commits its repairs and reports that it could not publish.
- **When it ends**: the team brings the thread's report to Genie's chat, and this plugin fetches
  the `wish/<name>` branch, plus any branches the wish was scoped to, back into the project. You
  merge when you are happy with it.
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
and whether Genie was made.

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
