# genie-ui — the fleet floor (Group 1: shell substrate)

A browser-served UI that renders **THE agent**: one real PTY pane per fleet member
(the `syv-ai/dash` pattern, zero rendering abstraction). Group 1 is the shell
substrate — the bare-`ws` PTY server + the vanilla-TS xterm client. The genie lane
(G2), the group chat + ACP backend (G3), and the contract docs (G4) layer on top.

## Run it

**bun builds, node runs** (see "Runtime split" below — this is not cosmetic: under bun
the served UI renders nothing from real agents):

```bash
bun run packages/genie-ui/build.ts            # bun bundles client + server -> dist/
node packages/genie-ui/dist/index.js          # node serves client + ws on http://localhost:8787
# then open http://localhost:8787 (works from mac + phone on the LAN)
```

Or from the package dir: `bun run build && bun run serve` (or the combined `bun run start`).

Edit `fleet.json` to point panes at the real agent CLIs (`fable`, `hermes -p <profile>
--tui`, `codex`, `rlmx`/`pi` TUI) — no other module changes.

## Module map (provenance)

| Module | Origin | Role |
|--------|--------|------|
| `server/fleet-config.ts` | fresh `server/fleet-config.mjs` | `loadFleet() → PaneSpec[]`; grows genie keys `wishId`, `role` |
| `server/pty-session.ts` | fresh `server/pty-session.mjs` | PTY boundary — **the single `node-pty` importer**; `startAll/spawn/kill/restart/write/resize/replay/list/killAll`; events `data`/`exit`/`status` (`idle`/`running`/`exited`) |
| `server/reused/TerminalMirror.ts` | dash `src/main/services/TerminalMirror.ts` (MIT, salvaged verbatim) | headless-xterm + `SerializeAddon` snapshot engine — the **replay path**, replacing fresh's 256 KB raw-byte ring; imported only by `pty-session` |
| `server/transport.ts` | fresh `server/transport.mjs` + `client/transport.ts` | the `ws` protocol codec: `FLEET/DATA/EXIT/STATUS/REPLAY/INPUT/RESIZE/SPAWN/KILL/RESTART/LIST` |
| `server/index.ts` | fresh `server/index.mjs` | thin composition root + the no-Vite serve path |
| `client/pane.ts` | fresh `client/pane.ts` | one xterm pane per session; FitAddon + ClipboardAddon (salvaged `Utf8Base64`) + salvaged `FitScheduler` |
| `client/layout.ts` | Lane A grid concept (vanilla reimpl) | tabs + horizontal splits + maximize |
| `client/main.ts` / `client/transport.ts` | fresh `client/*` | roster-driven UI; talks to the server exclusively over `transport` |
| `client/reused/{Utf8Base64,FitScheduler}.ts` | dash `src/renderer/terminal/*` (MIT, salvaged verbatim) | UTF-8 OSC-52 clipboard codec + debounced fit |

## Pinned G1 decisions

**Runtime split — bun builds, node runs (amends the original "bun-native serve"
decision; corrected at review-time).** The original G1 pin ran the whole thing under bun
(`bun run server/index.ts`). That decision was **wrong at runtime**: under **bun 1.3.14**,
`node-pty`'s `onData` **never fires** — an identical `pty.spawn('btop')` streams under node
but delivers **zero bytes** under bun (isolated on the real box: `node → 40454 bytes, clean
exit`; `bun → 0 bytes, exit 0 signal 1`; the orchestrator saw 38283 vs 0). Consequently the
served UI would render **nothing** from real agents. The earlier "sandbox SIGHUPs
interactive PTYs" note in `qa.md` was **this same bug misdiagnosed** (the `signal 1` is
node-pty's own teardown under bun, not a sandbox). The G1 unit tests stayed green because
they only assert lifecycle status/exit **events** and scripted exits — never real `onData`
byte delivery — and the original `qa.md` render evidence used direct `TerminalMirror`
writes, not a real PTY. `server/pty-realstream.test.ts` now closes that gap and pins the
runtime.

**The fix:** the PTY-host process (`server/index.ts`) runs under **node** (Node 22 on the
box, where `onData` streams). **bun stays the builder**: `build.ts` bundles the client
(`client/main.ts` → `dist/main.js`, `@xterm` inlined) **and** the server
(`server/index.ts` → `dist/index.js`, `node-pty`/`ws`/`@xterm` kept external so node loads
the native addon + CJS packages from `node_modules`). No `Bun.*` remains at server runtime
(`Bun.file` → node `fs`; the on-the-fly `Bun.build` moved to `build.ts`). This is the
simplest split that keeps every gate green — no experimental `.ts` import-extension flags,
one build path (bun), one runtime (node).

**Serve path — no Vite (deliverable 4).** ONE `http` server both serves the client
assets (`index.html`, `styles.css`, the salvaged `xterm.css`, and the prebuilt client
bundle `dist/main.js`) **and** upgrades to the bare-`ws` PTY protocol on the **same port**.
No second port, no import-map juggling. The prototype's `vite` / `concurrently` dev-server
is gone; `! grep -q '"vite"'` passes.

**TerminalMirror under bun — verified, no fallback (design R4).** The salvaged engine
loads `@xterm/headless` + `@xterm/addon-serialize` via `createRequire` (their CJS entries
ship no ESM `exports` map). Verified under **bun 1.3.x**: `SerializeAddon.serialize()`
round-trips buffer + SGR styling correctly (see `reused/TerminalMirror.test.ts`). No
loader adaptation beyond the `createRequire` the salvage already carried, and the bounded
ring fallback was **not** needed. `pty-session` is the only importer, so any future
adaptation stays contained to one module. **Post-runtime-split:** it now loads under the
**node** server runtime too — the QA below reattaches a fresh client and `SerializeAddon`
reconstructs a live `btop` screen (15408 bytes, SGR preserved), so `createRequire` +
serialize round-trip work identically under node.

**Dependencies / no workspaces.** `package.json` at the repo root has **no `workspaces`
field**, so the runtime deps (`node-pty`, `ws`, `@xterm/xterm`, `@xterm/addon-fit`,
`@xterm/addon-clipboard`, `@xterm/headless`, `@xterm/addon-serialize`) live in the **root**
`package.json` (one lockfile, one `node_modules`, one gate surface — the repo's existing
precedent). `knip.json` was extended (`entry` + `project`) so `dead-code` resolves the new
imports instead of flagging them unused. `node-pty` is in root `trustedDependencies` so a
fresh `bun install` builds its native binary (needs a working `node-gyp`/toolchain — no
prebuild ships for linux-x64 on this node-pty version).

**Trust boundary — loopback by default, Origin-checked ws.** `MSG.INPUT` feeds arbitrary
keystrokes into live login shells (`fable`, `codex`), so the ws upgrade is a remote-control
surface, not a read-only view. Two guards keep it closed by default:

- **Bind loopback unless opted in.** `server.listen(PORT, HOST)` with `HOST` defaulting to
  `127.0.0.1`, so a fresh run is reachable only from the box itself. The multi-device goal
  (mac + phone on the LAN) is **opt-in** via `HOST=0.0.0.0` (or a specific interface). This
  is the seam G2 (genie state) and G3 (ACP control faces) build on, so the boundary is
  explicit here rather than retrofitted later.
- **Origin allowlist on the ws upgrade.** `verifyClient` accepts a browser connection only
  when its `Origin` is same-origin with the page's own host (works for any LAN hostname with
  no config) or is listed in `GENIE_UI_ALLOWED_ORIGINS` (comma-separated, for a reverse
  proxy). Browsers always send `Origin`, so this defeats a cross-origin drive-by — an open
  website cannot `new WebSocket('ws://localhost:PORT')` into the shells. Non-browser clients
  (CLI, tests) send no `Origin` and are gated by the loopback bind instead.

## Gate wiring (done first, deliverable 5)

- `tsconfig.json` `include` gained `packages/**/*`; `lib` gained `DOM`/`DOM.Iterable` (the client).
- `biome.json` gained a `packages/**` override (`noExcessiveCognitiveComplexity: warn @ 25`, matching `src/**`).
- `scripts/complexity-budget.ts` suppression scope extended from `src` to `src packages`.
- `knip.json` `entry`/`project` extended to the package.

CLAUDE.md's claim that the complexity budget covers `src/** AND packages/**` is now true.

## The genie lane (Group 2)

`server/genie-lane.ts` adds the left menu of genie WISHES + a hire roster + worktree binding
that composes with `genie launch`. `listWishes()` reads git-tracked `.genie/wishes/<slug>/WISH.md`
markdown; `wishContext(slug)` opens that wish's board/task state; `hire(wishSlug, member)` is a
roster entry ONLY (no process, no db write); `worktreeFor(entry)` resolves the per-group worktree
`genie launch` already mints — or `null` before launch.

**The read-only DB path — runtime-adaptive (the one real G2 design call).** genie board/task
state lives in `.genie/genie.db` (bun:sqlite). The problem: this module RUNS in the **node**
server process (see "Runtime split") where `bun:sqlite` does not exist, but its colocated tests
RUN under **bun** where `node:sqlite` does not exist (`require('node:sqlite')` → "No such built-in
module"). Neither engine is importable in the other runtime, so a single static `import` cannot
serve both — proven on the box: `node → node:sqlite ✓ / bun:sqlite ✗`, `bun → bun:sqlite ✓ /
node:sqlite ✗`. Reusing `task-state.ts` directly is also out: its functions call `db.query()`
(a bun:sqlite-only method; `node:sqlite` exposes only `.prepare()`), so passing it a node handle
needs an unsafe cast + drags the whole write-capable module into the node bundle.

**Chosen:** a tiny read replica that picks the sqlite engine at CALL time — `node:sqlite`
(`{ readOnly: true }`) under the node server, `bun:sqlite` (`{ readonly: true }`) under `bun test` —
using only the `.prepare(sql).get()/.all()` surface **both engines expose identically**. It is
SELECT-only (never a second write path — the `genie mcp` precedent), degrades to empty when
`.genie/genie.db` is absent, and resolves the worktree-shared DB via
`git rev-parse --git-common-dir` (mirrors `genie-db.resolveRepoRoot`). The dynamic `require` is
kept runtime-resolved by `createRequire` (the same escape `TerminalMirror` uses for `@xterm`), so
it survives `Bun.build` and neither engine string is statically bundled. Proven end-to-end: the
bundled node server reads the real `.genie/genie.db` read-only over `ws` (`taskCount: 4`).

**The worktree wall — reuse, never mint.** `worktreeFor` REPLICATES `genie launch`'s deterministic
formula verbatim (`src/term-commands/launch.ts buildLaunchPlan`):
`<GENIE_WORKTREES_DIR ?? $GENIE_HOME/worktrees>/<repo>-<slug>-<group>`, branch
`wish/<slug>-<group>`. It only ever REPORTS the path once that group's worktree exists on disk
(probe: the dir + the `.git` file every `git worktree add` writes) — it never runs `git`, never
`mkdir`s, and returns `null` for an unlaunched group. `launch.ts` is not imported (it pulls in
`bun:sqlite` via `openDb` and `Bun.which`, both dead under node); the formula is the contract,
replicated with a pointer back to its source.
