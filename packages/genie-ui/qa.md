# genie-ui — Group 1 (shell substrate) manual QA record

Date: 2026-07-21 · Branch: `wish/genie-ui` · Build: bun 1.3.14 · **Runtime: node v22.23.1** · Box: `ryzen-hx-470`

AC2-substrate manual QA (WISH G1): a local pane and an `ssh -t` pane each render their real
TUI; reattach replays the screen from TerminalMirror.

## Runtime correction (read first)

The original QA ran the server under **bun** and reported that a "nested agent sandbox
SIGHUPs interactive PTYs" (btop/nano exit immediately, `ssh -t` torn down before the remote
frame). That diagnosis was **wrong**. The real cause: under **bun 1.3.14**, `node-pty`'s
`onData` **never fires** — an identical `pty.spawn('btop')` streams under node but delivers
**zero bytes** under bun (`node → 40454 bytes, exit code 0 signal 0`; `bun → 0 bytes, exit
code 0 signal 1`). The `signal 1` is node-pty's own teardown under bun, not a sandbox. So
the items previously marked "operator-confirm — sandbox blocks the live frame" were actually
blocked by running the PTY host under bun.

**Fix (see README "Runtime split"):** bun builds, **node runs** the server. Everything below
was captured for real under `node packages/genie-ui/dist/index.js` on this box — live `btop`
now streams and reattach reconstructs its screen.

## Verified for real under the node runtime

Harness: boot the built server (`node dist/index.js`, `PORT=8911`, loopback), connect a
`ws` client, stream the live fleet for 5 s (bytes measured per pane, SGR = presence of an
`ESC[…m` colour sequence), then connect a **second** client to capture the reattach REPLAY
that the server serializes from each pane's `TerminalMirror`.

### 1. Local pane renders a live long-running TUI (`btop`)

Pane `hermes-reviewer` = `btop` (local), 5 s live stream:

```
btop (local)   bytes=29040   SGR=true
```

29040 bytes (>> 10000) of real btop frames with SGR colour — the pane renders a live TUI
continuously, not a scripted exit. **PASS.**

### 2. `ssh -t localhost btop` pane renders the remote TUI

Pane `rlmx` = `ssh -t localhost btop`, same 5 s stream:

```
ssh -t localhost btop   bytes=57955   SGR=true
```

Key auth (no password) resolves and the **remote** btop frames stream through the PTY
(57955 bytes, SGR). The remote TUI renders. **PASS.**

```
$ ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new localhost 'echo SSH_OK; uname -n'
SSH_OK
ryzen-hx-470
```

### 3. Reattach replays the screen from TerminalMirror

A second client connecting after the panes had painted receives a `REPLAY` per pane —
the `SerializeAddon` snapshot of the headless-xterm mirror:

```
REPLAY on reattach:
  hermes-reviewer (btop local)   replayBytes=15408   SGR=true
  rlmx           (btop ssh -t)   replayBytes=15215   SGR=true
  fable          (bash)          replayBytes=55      (prompt only)
  codex          (bash)          replayBytes=55      (prompt only)
```

The reattaching client reconstructs the full btop screen (15408 / 15215 bytes, SGR
preserved) from the mirror — not the live byte stream, the serialized snapshot. Replay is
PTY-faithful across a reconnect. **PASS.** Reinforced by the deterministic round-trip in
`server/reused/TerminalMirror.test.ts` (write → serialize → contains, incl. SGR).

### 4. Serve path (no Vite) + ws transport, under node

Booted `node dist/index.js` (PORT=8911); the same node `http` server serves the assets and
upgrades to the bare-`ws` PTY protocol on the same port:

```
[genie-ui] fleet loaded from …/fleet.json
  - fable            bash --login -i
  - hermes-reviewer  btop
  - codex            bash --login -i
  - rlmx             ssh -t localhost btop
[genie-ui] serving client + ws on http://localhost:8911 — loopback only
ws handshake -> FLEET panes: fable, hermes-reviewer, codex, rlmx  (all 4, with genie role seam)
```

Client bundle is prebuilt by `bun run build.ts` (`dist/main.js`), served by node from disk;
no Vite anywhere (`grep` clean). **PASS.**

### 5. Real-PTY regression guard

`server/pty-realstream.test.ts` (runs in `bun test`, shells out to **node** for the pty leg)
streams `printf START; sleep; printf END` through the real `PtySession` and asserts `onData`
bytes arrive **and** the `TerminalMirror` replay contains the streamed sentinels. This is the
test the original suite lacked — it fails under bun (0 bytes) and passes under node, pinning
the runtime decision at the gate. **PASS** (3/3).

### 6. Lifecycle: spawn / kill / restart + idle/running/exited events

Covered deterministically by `server/pty-session.test.ts` (idle→running transition + event;
kill → exited; manager `startAll`/`spawn`/`restart` ordered `exited`→`running`; `replay`
empty for unknown id). **PASS.**

## Operator-confirm (no browser available on this box)

- [ ] In the browser: 2 panes split horizontally (per-pane `split` → `LayoutManager`
      side-by-side cells), maximize toggles a single cell, tabs swap the agent, and
      reattaching a browser replays each pane's screen. The server delivers all 4 panes
      simultaneously and the reattach REPLAY is proven above (§3); the split/maximize is
      client-side `client/layout.ts` and panes stay mounted. Only the browser-side layout
      interaction is unverified here — no browser on the host.
