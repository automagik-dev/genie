# genie-ui — the fleet floor (Group 1: shell substrate)

A browser-served UI that renders **THE agent**: one real PTY pane per fleet member
(the `syv-ai/dash` pattern, zero rendering abstraction). Group 1 is the shell
substrate — the bare-`ws` PTY server + the vanilla-TS xterm client. The genie lane
(G2), the group chat + ACP backend (G3), and the contract docs (G4) layer on top.

## Run it

```bash
bun run packages/genie-ui/server/index.ts     # serves client + ws on http://localhost:8787
# then open http://localhost:8787 (works from mac + phone on the LAN)
```

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

**Serve path — no Vite (deliverable 4).** ONE node `http` server both serves the client
assets (`index.html`, `styles.css`, the salvaged `xterm.css`, and the client TS bundled
on the fly by **`Bun.build`** — a single entry, `@xterm` resolved from `node_modules`)
**and** upgrades to the bare-`ws` PTY protocol on the **same port**. No second port, no
import-map juggling, no build artifact in the tree. The prototype's `vite` /
`concurrently` dev-server is gone; `! grep -q '"vite"'` passes.

**TerminalMirror under bun — verified, no fallback (design R4).** The salvaged engine
loads `@xterm/headless` + `@xterm/addon-serialize` via `createRequire` (their CJS entries
ship no ESM `exports` map). Verified under **bun 1.3.x**: `SerializeAddon.serialize()`
round-trips buffer + SGR styling correctly (see `reused/TerminalMirror.test.ts`). No
loader adaptation beyond the `createRequire` the salvage already carried, and the bounded
ring fallback was **not** needed. `pty-session` is the only importer, so any future
adaptation stays contained to one module.

**Dependencies / no workspaces.** `package.json` at the repo root has **no `workspaces`
field**, so the runtime deps (`node-pty`, `ws`, `@xterm/xterm`, `@xterm/addon-fit`,
`@xterm/addon-clipboard`, `@xterm/headless`, `@xterm/addon-serialize`) live in the **root**
`package.json` (one lockfile, one `node_modules`, one gate surface — the repo's existing
precedent). `knip.json` was extended (`entry` + `project`) so `dead-code` resolves the new
imports instead of flagging them unused. `node-pty` is in root `trustedDependencies` so a
fresh `bun install` builds its native binary (needs a working `node-gyp`/toolchain — no
prebuild ships for linux-x64 on this node-pty version).

## Gate wiring (done first, deliverable 5)

- `tsconfig.json` `include` gained `packages/**/*`; `lib` gained `DOM`/`DOM.Iterable` (the client).
- `biome.json` gained a `packages/**` override (`noExcessiveCognitiveComplexity: warn @ 25`, matching `src/**`).
- `scripts/complexity-budget.ts` suppression scope extended from `src` to `src packages`.
- `knip.json` `entry`/`project` extended to the package.

CLAUDE.md's claim that the complexity budget covers `src/** AND packages/**` is now true.
