# Hermes homogeneous integration — regression baseline

Captured by Group 1 (eng-g1) at wish start. This records the **current** hermes-genie /
agent-sync behavior so later groups (2–6) can prove they only added the intended convergence
and did not silently regress the read-only MVP surface. Docs-only group — no product code changed.

- Wish: `hermes-homogeneous-integration`
- Branch: `wish/hermes-homogeneous-integration` (base commit `a191224`)
- Worktree: `.claude/worktrees/agent-a335b967e6666af59`
- Task: `t_mriij4ej186defa7` (worker `eng-g1`)

## `git status -sb` (worktree, at capture)

```
## worktree-agent-a335b967e6666af59
```

Clean working tree at capture (before Group 1 wrote its docs deliverables).

## Current `plugins/hermes-genie/plugin.yaml`

```yaml
name: genie
version: 0.1.0
description: "Native Hermes surface for Genie orchestration: read-only status, board, wish, task, work-plan, and review-plan tools plus KHAW bridge hooks, commands, and skills."
provides_tools:
  - genie_status
  - genie_board
  - genie_wish_status
  - genie_task_list
  - genie_task_status
  - genie_work_plan
  - genie_review_plan
provides_hooks:
  - on_session_start
  - pre_tool_call
  - post_tool_call
provides_commands:
  - genie
  - genie-board
  - genie-wish
  - genie-work-plan
  - genie-review-plan
provides_cli_commands:
  - genie
provides_skills:
  - genie
  - genie-work
  - genie-review
  - genie-khaw-bridge
```

Baseline note: manifest ships **7 native tools** today (`genie_status`, `genie_board`,
`genie_wish_status`, `genie_task_list`, `genie_task_status`, `genie_work_plan`,
`genie_review_plan`). The target (built by groups 2–6) retires four of these
(`genie_board`, `genie_wish_status`, `genie_task_list`, `genie_task_status`) in favor of the
5 shared MCP tools, keeping only 3 natives (`genie_status`, `genie_work_plan`,
`genie_review_plan`). See `plugins/hermes-genie/references/hermes-integration-map.md`.

## `rg -n "syncHermes|ensureHermes|hermes" src/lib/agent-sync.ts | head -30`

```
139:targets?: { claude?: string; codex?: string; hermes?: string; agentsSkills?: ...
144:hermesBinary?: string | null;
145:/** Injectable exec seam for `hermes plugins enable genie` (default execFileS...
177:agent: 'claude' | 'codex' | 'hermes';
200:hermesRoot: string | null;
221:hermesRoot: string | null;
224:targets: { claude: string; codex: string; hermes: string; agentsSkills: strin...
252:*   - hermesRoot: sibling `hermes-genie` in the same plugins layout,
257:const hermesRoot = firstExisting([
258:join(genieHome, 'plugins', 'hermes-genie'),
259:join(genieHome, 'bin', 'plugins', 'hermes-genie'),
262:return { pluginRoot, hermesRoot, version };
938:{ pluginRoot: null, hermesRoot: null, version: null },
2219:function syncHermes(ctx: RunContext, opts: AgentSyncOptions, report: AgentRep...
2220:const hermesHome = ctx.targets.hermes;
2222:if (!existsSync(hermesHome) && binary === null) return;
2224:if (ctx.hermesRoot === null) {
2225:report.advisories.push('hermes source (hermes-genie) not found next to plugin...
2228:const hermesRoot = ctx.hermesRoot;
2229:const mainAction = ensureHermesLink(ctx, join(hermesHome, 'plugins', 'genie')...
2230:ensureStickyProfileLink(ctx, hermesHome, hermesRoot, report);
2239:* Converge `linkPath` onto a symlink at `ctx.hermesRoot`:
2245:function ensureHermesLink(
2248:hermesRoot: string,
2255:symlinkSync(hermesRoot, linkPath);
```

Baseline note: the Hermes lane already exists in `agent-sync.ts`. `syncHermes` converges
`$HERMES_HOME/plugins/genie` (and any sticky-profile plugins dir) onto a symlink pointing at
the sibling `hermes-genie` checkout, then best-effort runs `hermes plugins enable genie`. The
lane is guarded (skips when neither `$HERMES_HOME` nor a `hermes` binary is present) and only
runs on the explicit install/update paths.

## Host probes (read-only, best-effort)

`hermes plugins list --plain | rg genie`:

```
enabled      user     0.1.0    genie
```

`genie doctor | rg -i hermes`:

```
✔ agent sync: hermes — linked → /home/feliperosa/vm-home/.genie/plugins/hermes-genie
```

`test -L "$HERMES_HOME/plugins/genie" && readlink -f ...` (HERMES_HOME unset → `~/.hermes`):

```
/home/feliperosa/vm-home/.genie/plugins/hermes-genie
```

Baseline note: on this host the plugin is already installed and enabled at the user tier; the
`$HERMES_HOME/plugins/genie` symlink resolves to `~/.genie/plugins/hermes-genie` (the
agent-sync-managed root), and `genie doctor` reports the Hermes lane linked. This is the
"current" state the parity map's current-vs-target rows describe.
