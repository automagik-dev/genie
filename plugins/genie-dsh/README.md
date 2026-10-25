# @automagik/genie-dsh

Genie for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), on the
Automagik Bot team ([`@automagik/bots-dsh`](https://github.com/automagik-dev/automagik/tree/dev/apps/bots-dsh)).
It adds one Bot, **Genie**, that grants wishes in a project: each wish runs as its own thread,
in its own copy of the project on a `wish/<name>` branch, and reports back to Genie's chat.

## What it does

- **Genie**: the first time the plugin loads with the Bot team, it makes one Bot of kind `genie`
  (drawn as the clay Genie). Its project is a new folder in the team workspace
  (`<team workspace>/genie`), started as a git repository on `dev` the first time Genie needs it.
  To work in your own repository, pick it as Genie's **Working folder** in its settings. A Genie
  you delete is not made again.
- **Granting a wish**: Genie's `grant_wish` tool (Genie only) makes a local clone of the project
  in `<team workspace>/wishes/<project>/<name>`, on a new branch `wish/<name>` from the project's
  current commit, and hands the wish to a Tasks session there (the Bot team's `startTask`). The
  thread plans, makes the change, runs the project's own checks, commits on its branch and ends
  with a short report. It never pushes or merges.
- **When it ends**: the team brings the thread's report to Genie's chat, and this plugin fetches
  the `wish/<name>` branch back into the project. You merge it when you are happy with it.
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
