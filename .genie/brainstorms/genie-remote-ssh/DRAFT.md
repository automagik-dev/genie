# DRAFT — genie-remote-ssh

**Date:** 2026-07-23
**Status:** Simmering (third in the Felipe-confirmed order Theme → Identity → SSH)
**Target repo:** khal-os/genie-desktop (`~/prod/genie-ui-ab/dash-fork`)
**Shared research:** [khal-native-desktop umbrella](../khal-native-desktop/DRAFT.md)

## Problem

Genie desktop only operates on the local machine. Felipe wants **full remote parity**: pick "local or remote SSH host" on the first screen, then everything — terminals, repos + worktrees, agents, genie state — works against that host. Inspiration: the old `khal/desktop` app (a thin shell that connects to a kernel over WS with a workspace picker up front, and the K dot-matrix connecting screen).

## Felipe's locked decisions

- Scope = ALL of: remote terminals, remote repos+worktrees, remote agents+genie state, full parity.
- UX framing (his words): "it's simple — decide if you'll code locally or point to remote ssh on the first screen."
- K dot-matrix loader for the connecting state (ported in khal-native-theme).

## The seam inventory (explorer evidence — everything that assumes local host)

- **Process spawn:** node-pty ×3 (`ptyManager.ts:502,617,886` — agent/shell/service), agent binary resolution via local `which` (`agents/support.ts:86`), `GenieStateService` spawning `genie ui-bridge` stdio child with `cwd=project`, ServiceRunner/port allocator.
- **Filesystem:** ~59 fs-importing files in `src/main`; Electron `openDirectory` dialog (`appIpc.ts:213`); `GitService`/`WorktreeService` `execFile git {cwd}` (~89 call sites); native `fs.watch` watchers (FileWatcher/SessionWatcher/PortsConfigWatcher); `GenieStateService` reading `.genie/wishes/*.md` directly; SkillsService, editorIpc (diff reads), blame/preCommit parsers.
- **Loopback network:** `HookServer` on `127.0.0.1:<ephemeral>`, injected as `DASH_HOOK_PORT` and curl'd from INSIDE agent shells — breaks first when the shell is remote.
- **State:** better-sqlite3 at local `userData/app.db` (projects/tasks/… — the app's own DB, distinct from genie.db).

## Candidate architectures (to deliberate at brainstorm time)

1. **Remote backend daemon (VS Code Server model).** A headless "dash host" process runs on the remote box (shipped via SSH), owning PTYs, git, fs, watchers, genie bridge, HookServer, and its own app.db slice; the Electron renderer+main talk to it over an SSH-tunneled channel (JSON-RPC/WS). Local mode = same daemon in-process. Cleanest parity; largest build.
2. **Syscall-layer remoting.** Abstract spawn/fs/git behind an interface with local + SSH implementations (ssh2 exec/sftp). No remote install, but ~59 fs files + watchers + HookServer loopback + sqlite make true parity doubtful.
3. **KhalOS kernel route.** Lean on the platform's existing remote `pty.*`/`fs.*` NATS subjects (old-desktop model) — remote host runs a khal kernel/agent instead of a bespoke daemon. Couples SSH support to khal infra; elegant if identity (khal-app-kit-identity) lands first and the remote box runs khal software anyway.

Preliminary read: (1) or (3); (2) is a tarpit for full parity. The "first screen" picker is the same UX in all three; connection profile storage + K-loader connecting state are common.

## Open decisions

- Architecture pick (above) — the big one; deserves council/lens deliberation at refinement time.
- Where the genie CLI lives remotely (daemon bundles it? requires preinstall?), and remote `.genie/genie.db` access stays behind ui-bridge (read-only wall holds regardless of transport).
- HookServer redesign: remote agent shells need a reachable hook endpoint (reverse tunnel? daemon-local hook server relaying over the channel?).
- app.db split: which tables become per-host (projects/tasks are host-relative paths).
- Auth for the SSH channel itself (ssh config/agent reuse) vs khal identity (separate concerns or fused via option 3).

## Risks

- Deepest architectural change of the three sub-projects; touches every `src/main` service.
- Schema/bridge-protocol changes are STOP-AND-PLAN fenced (standing rule).
- Full parity includes watchers + HMR-adjacent features (SessionWatcher on remote JSONL) — chatty over SSH; needs a streaming design, not naive polling.
- Windows remote hosts presumably OUT (worth an explicit exclusion).

## Acceptance criteria (sketch)

- [ ] First screen offers Local / Remote (saved SSH profiles); K-dots connecting state.
- [ ] Against a remote Linux host: open repo, see kanban (bridge over the channel), hire agent → terminal in remote worktree, unhire; hooks fire (activity/notifications work).
- [ ] Local mode regression-free.

## WRS

```
WRS: ██████░░░░ 60/100
 Problem ✅ | Scope ✅ | Decisions ░ | Risks ✅ | Criteria ░(sketch)
```
Blocked on: architecture pick (needs its own deliberation session when its turn comes, after theme + identity).
