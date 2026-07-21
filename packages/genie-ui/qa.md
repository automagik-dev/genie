# genie-ui — Group 1 (shell substrate) manual QA record

Date: 2026-07-21 · Branch: `wish/genie-ui` · Runtime: bun 1.3.14 · Box: `ryzen-hx-470`

AC2-substrate manual QA (WISH G1): a local pane and an `ssh -t` pane each render their real
TUI; 2 panes split horizontally; reattach replays the screen from TerminalMirror.

## Environment note (read first)

This QA was executed inside a **nested agent sandbox** whose PTY layer sends `SIGHUP`
(`onExit … signal=1`) to freshly-spawned interactive TUIs within a few hundred ms — `btop`
and `nano` exit immediately here, and `ssh -t` panes are torn down before their remote
frame arrives. This is an environment limitation, **not** a substrate defect: simple and
short-lived PTY output is captured and rendered correctly (below), and the substrate is a
faithful TypeScript port of the A/B "fresh" prototype, whose README already records the
full 7-item acceptance **including a live `btop` local pane and an `ssh -t` pane**. The
items that require a live long-running TUI or a browser are marked **operator-confirm** and
should be re-checked once on the real box (outside the sandbox), where node-pty is stable.

## Verified in this session (programmatic, through the real modules)

### 1. Local pane renders PTY output faithfully (render → TerminalMirror → replay)

Spawned a real PTY through `PtySessionManager` emitting a full-screen ANSI frame (clear
screen `ESC[2J`, SGR color `ESC[1;36m`, absolute cursor positioning `ESC[3;3H` …), waited,
then serialized the `TerminalMirror`:

```
SNAP_BYTES=167  REATTACH_IDENTICAL=true  STATUS=exited
RENDERED (ANSI stripped):
== GENIE-UI FLEET PANE (fable/author) ==
CPU  42%   MEM  3.1G
rendered via node-pty -> TerminalMirror
+--- box-drawing OK ---+
```

The headless xterm interpreted the escape sequences into a positioned screen and
`SerializeAddon` reproduced it — i.e. the pane is PTY-faithful. **PASS.**

### 2. Reattach replays the screen from TerminalMirror

In the same capture, calling `manager.replay(id)` a second time (simulating a client
re-attaching) returned **byte-identical** output (`REATTACH_IDENTICAL=true`). Replay is the
mirror snapshot, not fresh's raw-byte ring. Reinforced by the deterministic round-trip in
`server/reused/TerminalMirror.test.ts` (write → serialize → contains, incl. SGR styling).
**PASS.**

### 3. `ssh -t` key auth to localhost works

```
$ ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new localhost 'echo SSH_OK; uname -n'
SSH_OK
ryzen-hx-470
```

Key auth (no password) is available, so the `rlmx (ssh)` fleet pane (`ssh -t localhost btop`)
can spawn its remote PTY. The **live remote frame** could not be captured here because the
sandbox SIGHUP-tears-down the `ssh -t` PTY before the first remote render — **operator-confirm
on the real box** (this is exactly the pane the A/B "fresh" prototype passed). Auth path: **PASS.**

### 4. Bun-native serve path (no Vite) + ws transport

Booted `bun run packages/genie-ui/server/index.ts` (PORT=8899):

```
GET /                 -> 200 text/html
GET /client/main.js   -> 200 text/javascript   (Bun.build of the single client entry; @xterm inlined, 0.43 MB)
GET /xterm.css        -> 200 text/css
GET /client/styles.css-> 200 text/css
GET /nope             -> 404
index.html references /client/main.js + /xterm.css
ws handshake -> FLEET panes: fable:author, hermes-reviewer:reviewer, codex:coder, rlmx:remote  (all 4, with genie role seam)
```

One node `http` server serves the assets and upgrades to the bare-`ws` PTY protocol on the
same port. No Vite anywhere (`grep` clean). **PASS.**

### 5. Lifecycle: spawn / kill / restart + idle/running/exited events

Covered deterministically by `server/pty-session.test.ts` (13 tests, 0/40 flakes):
idle→running synchronous transition + `running` event; kill → `exited` status + event; manager
`startAll` / `spawn` (re-start an exited session) / `restart` (ordered `exited`→`running`
sequence) / `replay` empty for unknown id. **PASS.**

## Operator-confirm on the real box (outside the sandbox)

- [ ] Local pane runs a live long-running TUI (`btop` / `hermes … --tui` / `codex` / `claude`)
      and renders continuously. (Frame-render mechanism proven above; sandbox blocks live btop.)
- [ ] `ssh -t localhost btop` pane renders the remote TUI. (Key auth proven; sandbox blocks the live frame.)
- [ ] In the browser: 2 panes split horizontally (per-pane `split` button → `LayoutManager`
      side-by-side cells), maximize toggles a single cell, tabs swap the agent, and reattaching
      a browser replays each pane's screen. (Server delivers all 4 panes simultaneously — proven
      in §4; the split/maximize is client-side `client/layout.ts`, panes stay mounted.)

These three were passed by the A/B "fresh" prototype this substrate ports; re-confirm once on
the physical host where node-pty is not sandbox-hung.
