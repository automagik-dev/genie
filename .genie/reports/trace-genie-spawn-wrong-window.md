# Trace: `genie work` spawns engineers into the wrong tmux window

**Investigated:** 2026-04-19 (UTC)
**Reporter:** Opus 4.7 (1M ctx)
**Severity:** P1 — silent topology corruption; PG metadata and tmux placement disagree
**Source repo:** `/home/genie/repos/automagik-dev/genie/`
**Source HEAD:** `b5c3b068 feat(brain): chain brain install wizard after install (closes #1203)`
**Installed package:** `@automagik/genie@4.260418.20`

---

## 1. Repro confirmation

Operator (in `genie:simone` window, pane `%43`) ran:

```
genie team create agentic-foundation --repo /home/genie/repos/khal-os/brain --branch dev --wish agentic-brain-foundation
```

Team config landed in PG with `tmux_session_name = 'genie'`, leader = `agentic-foundation`. Team-lead spawned correctly in `genie:agentic-foundation` (pane `%56`).

Team-lead then executed `genie work agentic-brain-foundation` from inside `%56`. The dispatcher built `effectiveRole = "engineer-1"` (group "1") and called `handleWorkerSpawn` to spawn it. The new pane `%57` landed in `genie:simone` instead of `genie:agentic-foundation`.

PG state at investigation time:

| Source | session | window | window_id | pane |
|---|---|---|---|---|
| `agents.id=agentic-foundation-engineer-1` | (n/a) | `null` | `null` | `%57` |
| `agents.id=agentic-foundation-agentic-foundation` | (n/a) | `agentic-foundation` | `@29` | `%56` |
| `executors` for engineer-1 | `agentic-foundation` (also wrong; see §4 secondary) | `null` | `null` | `%57` |
| Actual `tmux -L genie display -t '%57'` | `genie` | `simone` | `@26` | `%57` |

Audit event recorded: `entity_id=agentic-foundation-engineer-1, event_type=spawn, actor=agentic-foundation, details.name=engineer`. Confirms team-lead invoked the spawn (not the operator, not auto-spawn-on-message).

---

## 2. Code path trace

### Entry: team-lead executes `genie work <slug>`

Plugin AGENTS.md for `team-lead` (`plugins/genie/agents/team-lead/AGENTS.md`) instructs `Phase 2 → genie work <slug>`. That maps to `autoOrchestrateCommand` → `workDispatchCommand`.

### `workDispatchCommand` constructs the spawn (`src/term-commands/dispatch.ts:541-621`)

Critical block at line **606-614**:

```ts
const effectiveRole = `${agentName}-${group}`;       // "engineer-1"
...
await handleWorkerSpawn(agentName, {
  provider: 'claude',
  role: effectiveRole,
  extraArgs: ['--append-system-prompt-file', contextFile],
  initialPrompt: workPrompt,
});
```

**No `team` is passed. No `session` is passed.** `process.env.GENIE_TEAM` is set to `agentic-foundation` in the team-lead pane, but `workDispatchCommand` does not forward it as `--team`.

### `handleWorkerSpawn` builds context (`src/term-commands/agents.ts:1917-2046`)

- `resolveTeamAndResume` reads `options.team` (undefined) → `teamWasExplicit = false` (line 1862).
- It then resolves the team from `agent.entry.team` / `GENIE_TEAM` (line 1696-1699), so `team = 'agentic-foundation'` is set, but **`teamWasExplicit` stays `false`** by design.
- `process.env.TMUX` is set in the team-lead pane → `insideTmux = true` (line 2002).

The fatal line is **2031**:

```ts
spawnIntoCurrentWindow: !teamWasExplicit && insideTmux && !options.session,
// = !false && true && true = TRUE
```

### `launchTmuxSpawn` skips `resolveSpawnTeamWindow` (`src/term-commands/agents.ts:921-966`)

Because `spawnIntoCurrentWindow=true`, line 932-935 short-circuits to `teamWindow = null`:

```ts
const teamWindow =
  ctx.spawnIntoCurrentWindow || isolatedSessionSpawn
    ? null
    : await resolveSpawnTeamWindow(ctx.validated.team, ctx.cwd, ctx.sessionOverride);
```

`resolveSpawnTeamWindow` would have correctly resolved to `genie:agentic-foundation` (it reads `teamConfig.tmuxSessionName = 'genie'` and calls `ensureTeamWindow('genie', 'agentic-foundation', cwd)`). It is **bypassed**.

### `createTmuxPane` issues `split-window` with no `-t` (`src/term-commands/agents.ts:765-843`)

With `teamWindow = null`, control falls to the catch-all branch at lines 831-842:

```ts
const splitTarget = teamWindow ? `-t '${teamWindow.windowId}'` : '';   // ← empty
const cwdFlag = ctx.cwd ? `-c '${ctx.cwd}'` : '';
...
const splitCmd = `${tmuxPrefix}split-window -d ${splitTarget} ${cwdFlag} -P -F '#{pane_id}' '${escapedCmd}'`;
return execSync(splitCmd, { encoding: 'utf-8' }).trim();
```

The resulting command is `tmux -L genie -f <conf> split-window -d  -c '<cwd>' -P -F '#{pane_id}' '<cmd>'` — **no target**.

### tmux's "current" target resolution (the actual bug surface)

Empirical test from this investigation (genie tmux server):

```
$ TMUX=/tmp/tmux-1000/genie,36568,0 TMUX_PANE=%56 tmux -L genie display -p '#{session_name}:#{window_name}.#{pane_id}'
genie:simone.%43        ← operator's currently active pane, NOT %56
```

Even with `TMUX_PANE=%56` and the matching `TMUX` socket env, `tmux` (no `-t`) resolves to **the most recently active client's session/window**. The operator's TUI is the attached client at `genie:simone.%43`; tmux ignores `TMUX_PANE` for `display`/`split-window` target resolution and uses the active client. That puts the new pane in `genie:simone`.

Confirmation with explicit target:
```
$ ... tmux -L genie display -t '%56' -p '...'
genie:agentic-foundation.%56     ← correct
```

**Root cause:** `genie work` does not propagate the team into the spawn invocation, which flips `spawnIntoCurrentWindow=true`, which short-circuits team-window resolution, which makes `split-window` run with no `-t`, which falls back to tmux's active-client default — the operator's window.

This matches **hypothesis (b)** with a contributing factor from **hypothesis (d)**: the `genie work` spawn path lacks the `--team` propagation that `genie spawn` would provide explicitly.

---

## 3. Other affected callsites

`grep -rn "split-window" src/ --include="*.ts"` (excluding tests):

| File:Line | Risk |
|---|---|
| `src/term-commands/agents.ts:777` | Safe — explicit `-t ${windowTarget}` when `--window` flag is present |
| `src/term-commands/agents.ts:818` | Safe — explicit `-t ${teamWindow.windowId}` (created branch) |
| `src/term-commands/agents.ts:834` | **Vulnerable** — `splitTarget` can be empty (useLaunchScript branch) |
| `src/term-commands/agents.ts:841` | **Vulnerable** — `splitTarget` can be empty (default branch) — site of this bug |
| `src/lib/protocol-router-spawn.ts:189` | **Vulnerable** — `splitTarget` empty when `ensureTeamWindow` throws (best-effort catch) |
| `src/term-commands/serve.ts:208` | Safe — explicit `-t ${TUI_SESSION}:0` |

Adjacent issue: `applySpawnLayout` at `agents.ts:846-859` calls `tmux.getCurrentSessionName()` which has the same active-client problem and would apply layout to the operator's window when run from a worker pane.

Adjacent issue: in `agents.ts:871` the executor row records `tmuxSession: ctx.validated.team` (the team name, e.g. `agentic-foundation`) instead of the real tmux session name (`genie`). That's why the executors row says `tmux_session = 'agentic-foundation'` while the actual tmux session is `genie`. Out of scope for this PR but worth a follow-up.

---

## 4. Recommended hotfix

**Three changes, in order of importance.** All in `automagik-dev/genie`.

### 4.1 Forward team in `genie work` spawn (1 line, eliminates the bug today)

`src/term-commands/dispatch.ts:609-614`:

```diff
-  await handleWorkerSpawn(agentName, {
-    provider: 'claude',
-    role: effectiveRole,
-    extraArgs: ['--append-system-prompt-file', contextFile],
-    initialPrompt: workPrompt,
-  });
+  await handleWorkerSpawn(agentName, {
+    provider: 'claude',
+    team: process.env.GENIE_TEAM,
+    role: effectiveRole,
+    extraArgs: ['--append-system-prompt-file', contextFile],
+    initialPrompt: workPrompt,
+  });
```

This makes `teamWasExplicit=true`, takes the `resolveSpawnTeamWindow` path, and produces `split-window -t '@29'` which lands in `genie:agentic-foundation`. Verified by code inspection.

### 4.2 Honor caller's GENIE_TEAM in `spawnIntoCurrentWindow` heuristic (defense in depth)

`src/term-commands/agents.ts:2031`:

```diff
-    spawnIntoCurrentWindow: !teamWasExplicit && insideTmux && !options.session,
+    // A caller running inside a team context (GENIE_TEAM set) is NOT a TUI
+    // free-form spawn — never spawn into "current window", which falls back to
+    // the most-recently-active client (usually the operator) and silently
+    // misroutes the pane. Authority: trace-genie-spawn-wrong-window.md (#bug).
+    const callerHasTeamContext = teamWasExplicit || Boolean(process.env.GENIE_TEAM);
+    spawnIntoCurrentWindow: !callerHasTeamContext && insideTmux && !options.session,
```

Add a unit test asserting that `spawnIntoCurrentWindow` is false when `GENIE_TEAM` is set in env, even without `--team`.

### 4.3 Never run `split-window` without `-t` (hard guarantee)

`src/term-commands/agents.ts:831-842` — when `teamWindow` is null AND we genuinely intend "split current pane", explicitly target `process.env.TMUX_PANE`:

```diff
-  const splitTarget = teamWindow ? `-t '${teamWindow.windowId}'` : '';
+  const callerPane = process.env.TMUX_PANE;
+  if (!teamWindow && !callerPane) {
+    throw new Error(
+      'createTmuxPane: refusing to split with no target — neither teamWindow nor TMUX_PANE is set. ' +
+      'This indicates a missing --team or --window flag.',
+    );
+  }
+  const splitTarget = teamWindow
+    ? `-t '${teamWindow.windowId}'`
+    : `-t '${callerPane}'`;
```

Apply identical logic at line 834 (useLaunchScript branch) and at `protocol-router-spawn.ts:186`.

### 4.4 Same active-client bug in `applySpawnLayout`

`src/term-commands/agents.ts:846-859` — replace `tmux.getCurrentSessionName()` with `ctx.sessionOverride ?? teamConfig.tmuxSessionName ?? <derive>`. Or skip layout when `teamWindow` is null (simplest).

---

## 5. Test/repro hardening recommendation

Add `src/term-commands/dispatch.test.ts` (does not exist):

```ts
describe('workDispatchCommand', () => {
  it('forwards GENIE_TEAM as --team to handleWorkerSpawn', async () => {
    process.env.GENIE_TEAM = 'foo';
    const spy = mock.method(agents, 'handleWorkerSpawn');
    await workDispatchCommand('engineer', 'wish-x#group-1');
    expect(spy.mock.calls[0].arguments[1]).toMatchObject({ team: 'foo' });
  });
});
```

Add an integration test in `src/term-commands/agents.test.ts`:

```ts
it('spawnIntoCurrentWindow=false when GENIE_TEAM is set even without --team', () => {
  process.env.GENIE_TEAM = 'team-x';
  process.env.TMUX = '/tmp/tmux-fake,1,0';
  const ctx = buildSpawnCtxForTest({ team: undefined });
  expect(ctx.spawnIntoCurrentWindow).toBe(false);
});
```

End-to-end smoke (manual until tmux harness is wired):

```bash
genie team create test-routing --repo /tmp/test-repo --wish smoke
# Verify: tmux list-panes -t genie:test-routing shows leader
# From inside leader: genie work smoke
# Verify: tmux list-panes -t genie:test-routing now has BOTH leader + engineer panes
# Verify: NO panes in caller's original window
```

---

## Confidence

**Very high** for hypothesis confirmation and for fix 4.1. Empirical proof: the tmux command was reproduced live, showing `display -p '#{session_name}'` returns the operator's window even with `TMUX_PANE=%56`. PG state inspection confirms the engineer-1 row was registered with `window_id=null`, consistent with the `teamWindow=null` code path. Audit log confirms team-lead was the spawn actor. The 1-line fix (4.1) is mechanically obvious from the code path.

Fix 4.2 and 4.3 are belt-and-suspenders — the bug recurs anywhere a spawn is called from inside a tmux pane without `--team`. There are likely other dispatchers in the codebase that will trip on this; 4.3 is the universal guarantee.
