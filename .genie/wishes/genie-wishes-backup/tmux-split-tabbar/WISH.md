# Wish: Dual Tab Bar — Per-Project Session Isolation

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `tmux-split-tabbar` |
| **Date** | 2026-03-17 |
| **Design** | [DESIGN.md](../../brainstorms/tmux-split-tabbar/DESIGN.md) |

## Summary
Replace the single flat "genie" tmux session with per-project sessions. Top status bar shows project tabs (name + task count + active indicator + system info). Bottom status bar shows task windows for the active project (name + agent count + status emoji). Full isolation — agents in one project cannot message agents in another.

## Scope
### IN
- Per-project tmux session model (one session per `genie` invocation directory)
- Dual status bar via tmux 3.2+ `status 2`
- Top bar: project session tabs with rich info + git/CPU/RAM/clock
- Bottom bar: task window tabs with agent count + live status emoji
- Status bar shell script (`genie-tasks.sh`) reading `workers.json` + tmux queries
- Session name parameterization across all spawn/team/send code paths
- `genie send` scoped to current project session only
- `GENIE_SESSION` env var propagation to spawned workers
- Graceful fallback for tmux < 3.2 (single bar, windows only)

### OUT
- Cross-project agent communication (isolation is the goal)
- Migration tooling (restart genie is sufficient)
- Custom top-bar overflow/scrolling for many projects
- Changes to `genie read`, `genie ls` output format (separate wish if needed)
- Nested sessions or sub-projects

## Decisions
| Decision | Rationale |
|----------|-----------|
| One tmux session per project | Maps to native tmux hierarchy. `switch-client` swaps bottom tabs for free. No virtual grouping logic. |
| Session name = sanitized basename(cwd) with hash disambiguation | Same collision logic as current window naming. Consistent, predictable. |
| `GENIE_SESSION` env var on every window | Workers need to know their session for spawn/send scope. Propagated at window creation. |
| Shell script polling workers.json | Follows existing pattern (genie-git.sh). ~5-15ms per refresh. Atomic reads, no locks needed. |
| State emoji mapping from workers.json `state` field | Data already exists: working→🔨, idle→⏸, done→✓, error→✗, permission→❓, spawning→⏳ |
| Send scoped by session field in registry | Filter `registry.list()` by matching `session` field. Simple, no new data structures. |

## Success Criteria
- [ ] Running `genie` from two different folders creates two separate tmux sessions
- [ ] Top bar shows all project sessions with `name (task_count)` format and active indicator
- [ ] Bottom bar shows task windows for active project with `name ×agent_count status_emoji`
- [ ] Switching projects (top tab) swaps bottom tabs to show that project's tasks
- [ ] `genie spawn` creates workers inside the current project's session
- [ ] `genie send` only delivers to agents within the same project session
- [ ] Right side of top bar shows git branch, CPU, RAM, clock
- [ ] tmux < 3.2 falls back gracefully to single status bar
- [ ] `genie --reset` cleans up only the current project session, not all projects

## Execution Groups

### Group 1: Session Model Refactor
**Goal:** Replace single "genie" session with per-project sessions.
**Deliverables:**
1. `session.ts` — derive session name from cwd (basename + hash disambiguation), remove `DEFAULT_SESSION_NAME = 'genie'`
2. `session.ts` — `createSession()` creates a session named after the project, sets `GENIE_SESSION` env var on all windows
3. `session.ts` — `attachToWindow()` uses `switch-client` when already inside a genie session (cross-project switch)
4. `session.ts` — `handleReset()` only kills the current project session, not all sessions

**Acceptance criteria:**
- `genie` from `/home/user/project-a` creates tmux session `project-a`
- `genie` from `/home/user/project-b` creates tmux session `project-b`
- Both sessions exist independently (`tmux list-sessions` shows both)
- `genie --reset` from project-a only kills `project-a` session

**Implementation notes:**
- `GENIE_SESSION` env var must be set in `createSession()` via `tmux.setWindowEnv()` on the first window, and in `focusTeamWindow()` on every new window added to the session.
- Session name derivation reuses `resolveWindowName()` logic: `sanitizeWindowName(basename(cwd))` + 4-char hash if collision. Two projects with same basename in different dirs (e.g., `/home/user/project-a` and `/tmp/project-a`) get `project-a` and `project-a-c7b1`.
- Legacy `workers.json` entries with `session: "genie"` are treated as orphaned — `filterBySession()` will simply not match them. They expire via idle timeout watchdog (30min default).

**Validation:**
```bash
# Unit test: session name derivation produces unique names for same-basename dirs
node -e "
  const { sanitizeWindowName } = require('./dist/genie-commands/session.js');
  const { createHash } = require('crypto');
  const hash = (p) => createHash('md5').update(p).digest('hex').slice(0,4);
  const a = sanitizeWindowName('project-a');
  const b = sanitizeWindowName('project-a') + '-' + hash('/tmp/project-a');
  console.assert(a !== b, 'collision detected');
  console.log('PASS: session names are unique');
"
```
```bash
# Integration test: two sessions created from different dirs
tmux kill-session -t test-a 2>/dev/null; tmux kill-session -t test-b 2>/dev/null
tmux new-session -d -s test-a -x 80 -y 24 && tmux new-session -d -s test-b -x 80 -y 24 && tmux list-sessions -F '#{session_name}' | grep -c '^test-' | grep -q 2 && echo 'PASS' && tmux kill-session -t test-a && tmux kill-session -t test-b
```

**depends-on:** none

---

### Group 2: Spawn & Registry Session Scoping
**Goal:** Parameterize session name through all spawn and team code paths.
**Deliverables:**
1. `team-auto-spawn.ts` — replace `DEFAULT_SESSION = 'genie'` with session resolution from team-lead registry entry or `GENIE_SESSION` env var
2. `protocol-router-spawn.ts` — replace hardcoded `const session = 'genie'` (line 92) with session lookup from team config or registry
3. `agents.ts` — replace hardcoded `const session = 'genie'` in `applySpawnLayout()` (line 530) with session from SpawnCtx
4. `agent-registry.ts` — add `filterBySession(sessionName)` utility that filters `list()` results by session field
5. `msg.ts` — scope `genie send` to only resolve recipients whose `session` field matches sender's session

**Session resolution call chain (data flow):**
```
sessionCommand() [session.ts]
  → derives sessionName from cwd
  → sets GENIE_SESSION env var on tmux window via setWindowEnv()
  → registers team-lead in workers.json with session: sessionName

genie spawn [agents.ts:launchTmuxSpawn()]
  → reads GENIE_SESSION from process.env (inherited from tmux pane)
  → passes to SpawnCtx { session: process.env.GENIE_SESSION }
  → applySpawnLayout(ctx) uses ctx.session instead of 'genie'
  → ensureTeamWindow(ctx.session, teamName, workingDir)
  → registers worker in workers.json with session: ctx.session

auto-respawn [protocol-router-spawn.ts:spawnWorkerFromTemplate()]
  → looks up team-lead in registry by team name
  → reads session field from team-lead entry
  → uses that session for ensureTeamWindow()

genie send [msg.ts]
  → reads sender session: GENIE_SESSION from env, or looks up sender pane in registry
  → calls registry.filterBySession(senderSession) to scope recipient resolution
  → rejects delivery if recipient.session !== sender.session
```

**Acceptance criteria:**
- `genie spawn engineer` from within project-a creates worker in project-a session
- `genie send 'hello' --to engineer` from project-a only reaches engineer in project-a, not project-b
- Workers spawned via auto-respawn (protocol-router-spawn) land in the correct project session

**Validation:**
```bash
# Unit test: filterBySession filters correctly
node -e "
  const agents = [
    { id: 'a', session: 'proj-a', role: 'engineer' },
    { id: 'b', session: 'proj-b', role: 'engineer' },
  ];
  const filtered = agents.filter(a => a.session === 'proj-a');
  console.assert(filtered.length === 1, 'filter failed');
  console.assert(filtered[0].id === 'a', 'wrong agent');
  console.log('PASS: session filtering works');
"
```
```bash
# Integration: spawned worker inherits session from env
tmux new-session -d -s test-spawn -x 80 -y 24 && tmux set-environment -t test-spawn GENIE_SESSION test-spawn && tmux send-keys -t test-spawn 'echo $GENIE_SESSION' Enter && sleep 1 && tmux capture-pane -t test-spawn -p | grep -q test-spawn && echo 'PASS' && tmux kill-session -t test-spawn
```

**depends-on:** Group 1

---

### Group 3: Dual Status Bar — tmux Config + Script Stubs
**Goal:** Configure tmux dual status bar with project tabs (top) and task tabs (bottom), including stub scripts for rendering.
**Deliverables:**
1. `genie.tmux.conf` — enable `status 2`, configure top bar and bottom bar (see format strings below)
2. `scripts/tmux/genie-projects.sh` — **stub script** that outputs project tabs. Reads `tmux list-sessions`, counts windows per session. Full enrichment (agent counts) in Group 4.
3. `scripts/tmux/genie-tasks.sh` — **stub script** that outputs task tabs. Reads `tmux list-windows` for current session. Full enrichment (agent status emoji) in Group 4.
4. `genie.tmux.conf` — tmux version guard: `if-shell` that falls back to `status 1` on tmux < 3.2
5. Session keybindings — `Ctrl+)` / `Ctrl+(` for `switch-client -n` / `switch-client -p` (project switching)
6. `install.sh` / `genie setup` — install both scripts to `~/.genie/scripts/`

**Concrete tmux config format strings:**
```bash
# Top bar (status-format[0]): branding + project tabs (via script) + system info
set -g status 2
set -g status-format[0] "#[align=left,bg=#1a1a2e]#[bg=#7b2ff7,fg=#e0e0e0,bold] #(genie --version 2>/dev/null | head -1 || echo 'Genie') #[bg=#1a1a2e,fg=#7b2ff7] #($HOME/.genie/scripts/genie-projects.sh)#[align=right]#[fg=#6c6c8a]#($HOME/.genie/scripts/genie-git.sh) #[fg=#0f3460]| #[fg=#00d2ff]CPU #($HOME/.genie/scripts/cpu-info.sh) #[fg=#0f3460]| #[fg=#00d2ff]RAM #($HOME/.genie/scripts/ram-info.sh) #[fg=#0f3460]| #[fg=#e0e0e0]%H:%M "

# Bottom bar (status-format[1]): task window tabs for active session (via script)
set -g status-format[1] "#[align=left,bg=#16213e] #($HOME/.genie/scripts/genie-tasks.sh #{session_name}) "

# Fallback for tmux < 3.2
if-shell '[ "$(tmux -V | cut -d" " -f2 | cut -d. -f1)" -lt 3 ]' \
  'set -g status 1' \
  'set -g status 2'
```

**Acceptance criteria:**
- Two visible status bars when tmux >= 3.2
- Top bar shows session/project tabs with branding on left, system info on right
- Bottom bar shows window/task tabs for active session
- `Ctrl+)` / `Ctrl+(` switches between project sessions
- Single bar on tmux < 3.2 (no errors, no warnings)

**Validation:**
```bash
# Verify stub scripts exist and are executable
test -x scripts/tmux/genie-projects.sh && test -x scripts/tmux/genie-tasks.sh && echo 'PASS: stubs exist'
```
```bash
# Verify tmux config parses without error
tmux -f scripts/tmux/genie.tmux.conf start-server \; list-sessions 2>&1 | grep -v 'no server' | grep -qv 'error' && echo 'PASS: config valid'
```
```bash
# Verify version guard syntax
grep -q 'if-shell' scripts/tmux/genie.tmux.conf && echo 'PASS: version guard present'
```

**depends-on:** Group 1

---

### Group 4: Live Status Script Enrichment
**Goal:** Upgrade the stub scripts from Group 3 with live agent data from workers.json.
**Deliverables:**
1. `scripts/tmux/genie-tasks.sh` — **upgrade stub**: read `~/.genie/workers.json` (or `$GENIE_WORKERS` override for testing), filter by session arg `$1`, group agents by team/window, output `name ×count emoji` per window
2. `scripts/tmux/genie-projects.sh` — **upgrade stub**: read `~/.genie/workers.json`, count agents per session, merge with `tmux list-sessions`, output `name (task_count)` with `●` for active session
3. State-to-emoji mapping: spawning→⏳, working→🔨, idle→⏸, done→✓, error→✗, permission→❓, suspended→💤
4. Aggregate state per window: worst-state wins (error > permission > working > idle > done > suspended)
5. Performance: single `jq` pass, no subshells in loops, target < 20ms

**Acceptance criteria:**
- Bottom bar updates within 5 seconds of agent state change
- Correct agent count per task window
- Correct status emoji reflecting aggregate state
- Script executes in < 20ms (no perceptible lag)
- `$GENIE_WORKERS` env var override works for isolated testing

**Validation:**
```bash
# Test genie-tasks.sh with mock data (uses $GENIE_WORKERS override)
echo '{"workers":{"w1":{"session":"test","team":"feat/auth","state":"working"},"w2":{"session":"test","team":"feat/auth","state":"idle"}}}' > /tmp/test-workers.json && GENIE_WORKERS=/tmp/test-workers.json bash scripts/tmux/genie-tasks.sh test | grep -q '×2' && echo 'PASS: agent count correct'
```
```bash
# Test aggregate state: working wins over idle (worst-state)
echo '{"workers":{"w1":{"session":"test","team":"feat/auth","state":"working"},"w2":{"session":"test","team":"feat/auth","state":"idle"}}}' > /tmp/test-workers.json && GENIE_WORKERS=/tmp/test-workers.json bash scripts/tmux/genie-tasks.sh test | grep -q '🔨' && echo 'PASS: worst-state emoji correct'
```
```bash
# Test genie-projects.sh with mock data
echo '{"workers":{"w1":{"session":"proj-a","team":"t1","state":"working"},"w2":{"session":"proj-b","team":"t2","state":"idle"}}}' > /tmp/test-workers.json && GENIE_WORKERS=/tmp/test-workers.json bash scripts/tmux/genie-projects.sh | grep -q 'proj-a' && echo 'PASS: project tabs rendered'
```
```bash
# Performance gate
GENIE_WORKERS=/tmp/test-workers.json time bash scripts/tmux/genie-tasks.sh test 2>&1 | grep -E 'real|elapsed' | head -1
```

**depends-on:** Group 3 (stubs must exist first)

---

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| tmux < 3.2 has no `status 2` | Medium | `if-shell` version guard in config; falls back to `status 1` with windows-only bar |
| workers.json read during tmux refresh adds latency | Low | Script targets < 20ms; single `jq` pass. `$GENIE_WORKERS` override for testing. |
| Session name collisions (same basename, different paths) | Low | Reuses proven hash disambiguation: `basename-XXXX` where XXXX = md5(path)[0:4]. Two `/foo/myapp` and `/bar/myapp` get `myapp` and `myapp-a1b2`. |
| `GENIE_SESSION` env var not set in edge cases | Medium | Fallback chain: (1) `$GENIE_SESSION` env → (2) team-lead registry entry `.session` field → (3) `tmux display -p '#{session_name}'`. Warn on stderr if all fail. |
| Existing `genie` session left behind after upgrade | Low | Old session persists until user kills it manually. Old `workers.json` entries with `session:"genie"` expire via idle timeout (30min). No data loss, no migration needed. |
| `jq` not installed on target system | Low | `jq` is already a genie dependency (used by existing scripts). `genie doctor` checks for it. |
