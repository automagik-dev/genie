# Hermes integration — decision

**Status:** decision doc (no launcher code). Scope: how, if at all, Hermes fits
`genie launch`'s worktree-pane model, and the recommended integration shape.

## Context

`genie launch` (`src/term-commands/launch.ts`) turns each ready wish-group into
one Warp pane. Every pane opens in its own git worktree and runs a **terminal
agent's non-interactive CLI** against a kickoff prompt file:

- `claude "$(cat "<prompt>")"`
- `codex exec "$(cat "<prompt>")"` (added in this group)

The agent→command seam is a single data table (`AGENT_COMMANDS`), so a new
launch target is normally one entry: `<agent> → <shell command that runs a CLI
in a worktree against a prompt file>`.

That seam's hard requirement is a **launchable local terminal CLI** — a binary
on `PATH` that (a) accepts a prompt, (b) runs to completion (or drives an agent
loop) inside the pane's cwd, and (c) can operate on the worktree's files.

## Finding: Hermes does not fit the worktree-pane model

Hermes (Nous Research; developer guide at hermes-agent.nousresearch.com) is an
**HTTP/API agent**, not a terminal program. You interact with it by sending
requests to a hosted API endpoint and reading structured responses. There is:

- **no `hermes` binary** to put on `PATH` and drop into `AGENT_COMMANDS`;
- **no non-interactive CLI** that takes a prompt arg and runs to completion in a
  cwd the way `claude` / `codex exec` do;
- **no notion of "operate on the files in this worktree"** — it is a remote
  request/response service, so the worktree + prompt-file + Warp-pane machinery
  has nothing to bind to.

Forcing Hermes into `AGENT_COMMANDS` would mean wrapping the API in a bespoke
local shim just so a pane has something to `exec` — that shim is a real feature
(an API client with auth, streaming, and a repo-editing loop), not a one-line
command template. Wedging it behind the launch seam would misrepresent its cost
and couple an unrelated integration to the pane launcher.

**Conclusion:** Hermes is out of scope for `genie launch`. It is an
API-agent integration, adjacent to `omni`, not a launch target.

## Options considered

- **(a) A future `genie hermes` runner (like `omni`).** A dedicated command that
  owns the Hermes API client: auth/config, prompt submission, response
  streaming, and (optionally) applying the agent's proposed edits to the repo.
  Mirrors how `omni` is its own runner rather than a launch pane. Highest effort,
  but the only shape that honestly reflects an HTTP agent's surface and gives
  Hermes a first-class home.
- **(b) An emit-to-API path.** Reuse launch's plan/prompt builder to POST each
  group's kickoff prompt to the Hermes endpoint instead of opening a pane —
  "launch, but the executor is an API call." Lighter than (a), but it strands
  Hermes as a half-runner: no session, no interactive follow-up, no place for
  auth/streaming to live, and it complicates the pane launcher with a non-pane
  branch. A stepping stone at best.
- **(c) Defer.** Ship the `claude` + `codex` launch targets now; leave Hermes
  unbuilt until there is a concrete use case and the API contract is pinned.

## Recommendation

**Defer now (c), and when demand is real build a standalone `genie hermes`
runner (a) — do NOT wedge Hermes into `AGENT_COMMANDS` or the launch pane
model.**

Rationale:

1. **Right seam.** An HTTP agent belongs behind a runner that owns auth,
   streaming, and an edit-apply loop — the same shape as `omni` — not behind a
   pane-command template built for local CLIs. Option (a) is the only shape that
   models Hermes honestly; (b) would leak API concerns into the launcher and
   still leave Hermes half-integrated.
2. **No forcing today.** Nothing in the v5-completion wish needs Hermes. The
   launch seam stays clean (claude + codex), and we avoid building an API client
   speculatively before the contract and a use case are pinned.
3. **Cheap to revisit.** The launch seam already proves the "group → prompt →
   executor" decomposition. When Hermes lands as a runner, it can reuse
   `buildLaunchPlan`/`buildPrompt` to produce the same kickoff prompt and POST it
   to the API — no rework of the launcher required.

### Rough sketch of the future `genie hermes` runner

```
genie hermes <slug> [--group <name>]
  1. buildLaunchPlan(db, slug, …)      # reuse the existing plan/prompt builder
  2. for each selected group:
       prompt = group.prompt           # identical kickoff prompt as launch panes
       resp   = hermesClient.run({     # HTTP POST to hermes-agent.nousresearch.com
                  prompt, repo: repoRoot, group: group.name })
       stream resp to stdout           # + optional: apply proposed edits to the worktree
  3. record the run like omni does
```

Config (API key/endpoint) lives with the runner — mirroring `omni` and
`src/lib/codex-config.ts`'s TOML-config pattern — never in the launch pane
command. No Hermes launcher code is added by this wish.
