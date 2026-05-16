# `tmux-control` port notes

Reference source: `automagik-dev/khal-os` →
`packages/genie-app/views/genie/service/tmux-control.ts`
(commits `102a501` `feat(genie-app): add control mode pane I/O to TmuxControl`
and `6c50d1d` `fix: handle EPIPE crash in tmux control mode stdin`,
shipped 2026-03-18). The genie port lives in
`src/tui/tmux-control/{control,input,resize}.ts`.

## Verbatim semantics

These behaviours are byte-for-byte identical to khal-os:

- **Octal-escape decoder** (`decodeOctalEscapes`)
  — `\\` → `0x5c`, three-octal-digit run → byte, otherwise UTF-8 codepoint
  passthrough. Unit-tested against `\033` (ESC), `\012` (LF), `\346\227\245`
  (`日`), `\360\237\232\200` (`🚀`).
- **Spawn invocation** — `tmux -L <socket> -CC attach-session -t <session>`
  with `LC_ALL=C.UTF-8` / `LANG=C.UTF-8`, `stdio = ['pipe','pipe','pipe']`.
  Double `-C` disables command echo, matching khal-os.
- **Line dispatch** — `readline` over `stdout`, only act on `%`-prefixed
  lines. `%output ` → `(paneId, decoded data)` event. `%exit` → emit `exit`
  with the trailing status string.
- **EPIPE swallow** — `proc.stdin.on('error', () => {})` after spawn so the
  parent process survives tmux crashing mid-write (khal-os `6c50d1d`).
- **Auto-reconnect** — 1 s `setTimeout` after `close` unless `detach()` was
  called. `connected` flag flips false during the gap.
- **Hex keystroke encoding** — each input byte → two-digit hex, joined by
  spaces, sent as `send-keys -H -t '<pane>' <hex>`.

## Deviations (with justification)

| khal-os | genie port | Why |
|---------|------------|-----|
| `tmux -CC attach-session …` (double `-C`, "iTerm2 integration mode") | `tmux -C attach-session …` (single `-C`, plain control mode) | On Linux tmux 3.5a, `-CC` silently emits zero protocol bytes when stdin/stdout are pipes — that mode expects the parent terminal to speak the iTerm2 tmux-integration wrapper. Single `-C` emits the `%output`/`%exit`/`%error` notifications we actually consume. Verified empirically with `od -c` against the live `-L genie` server. Trade-off: we also see `%begin`/`%end` command-response framing, but the line dispatcher already ignores those. |
| `ControlSession` class hard-codes `spawn` from `node:child_process` | Genie's `ControlSession` accepts `spawnFn` via options | Lets tests inject a `FakeChild` without spinning a real `tmux` binary. Default is still `node:child_process.spawn`. |
| One god-class `TmuxControl` carries listing/capturing/control mode | Genie splits into three single-purpose modules (`control.ts`, `input.ts`, `resize.ts`) | The wish's scope is the data link, not session inventory — genie already has its own `src/tui/tmux.ts` for `list-sessions`/`capture-pane`. Keeping the modules focused matches the existing repo layout and lets `TerminalPane` (Group 3) compose them directly. |
| `sendKeys` is a method on the class | `sendInput()` is a free function over `InputWriterDeps { stdin }` | Same wire format, but the new shape lets `TerminalPane` decide buffering policy independently of who owns the control connection. |
| `resizeClient(cols, rows)` writes synchronously, no debounce | `createResizeForwarder()` debounces 50 ms with final-value-wins | The wish (deliverable 3) explicitly calls for the 50 ms debounce to avoid `refresh-client -C` storms during window-resize drags. Khal-os ships from a different surface (websocket-driven xterm.js) and does not need it. |
| `refresh-client -C <cols>,<rows>` (comma form) | `refresh-client -C <cols>x<rows>` (cross form) | Comma form collides with the inline `; <cmd>` separator on tmux 3.0 builds still floating around the smoke matrix. `WxH` is unambiguous across tmux 2.6 → 3.6a. |
| `send-keys` path only — `;` payloads silently break | `paste-buffer -p` fallback for `;`-bearing or `≥1024 B` payloads | Wish deliverable 2 names the fallback explicitly. The cutoff (1024 B) is sized below tmux's 4 KiB command-line buffer (`-H` payloads cost 3 chars per input byte). |
| Default socket name is the system default | Default socket name is `genie` (the `-L genie` agent server) | Wish decision #2: the data link targets the agent socket only. The display socket (`-L genie-tui`) is the one being deleted. Override is exposed for tests. |
| No `%error` handler | Emit an `error` event when `%error <msg>` arrives | The wish acceptance criterion lists `%error` handling as part of the parser semantics; the khal-os version comments "Ignore … `%error`" because the genie-app proxy ignores the channel. The TUI host needs to surface it. |

## Files NOT ported

- The `TmuxControl` god-class's `listSessions` / `listWindows` / `listPanes`
  / `capturePane` / `startEventStream` methods. These either exist already
  in `src/tui/tmux.ts` (the genie display-socket helper) or are out of
  scope for the data link. Group 6 will collapse duplication after the
  embed flip.
- `system.ts` (Linux/macOS detection) — genie has its own platform
  detection in `src/lib/ensure-tmux.ts`.

## Verification commands

```bash
# Unit suite (≥90 % line coverage on the three modules)
bun test src/tui/tmux-control/

# Manual smoke against the live agent server (requires `tmux -L genie` running)
bun run scripts/tui-spike/tmux-control-attach.ts <agent-session-name>
```

## No node-pty

The port intentionally does NOT introduce `node-pty`. tmux multiplexes the
PTYs already; we communicate with it over control-mode stdio. Acceptance
criterion #4 of Group 2 enforces this.
