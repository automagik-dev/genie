# warp-integration — QA (Group 4 close-out)

Machine: macOS (darwin), Warp installed at `/Applications/Warp.app` (Warp-Stable, process running PID 1282 at smoke time). Real-Warp smoke performed on this host.

## Real-Warp smoke record

Scratch repo: `/tmp/genie-warp-smoke-<pid>` (git-init'd, `genie init`, then 3 tasks across 3 groups `a`/`b`/`c`, all `ready`). Worktrees base pointed at a scratch `GENIE_WORKTREES_DIR`. Cleaned up after (repo, worktrees, branches, scratch dir, and the scratch `~/.warp/launch_configurations/genie-warp-smoke.yaml`).

### 1. `launch <slug> --no-open` (emit only, inspect YAML)

Exit 0. Emitted `~/.warp/launch_configurations/genie-warp-smoke.yaml`. Printed the config path + `warp://launch/...` URI and did NOT open Warp.

Emitted YAML (flow-style, single line, produced by `Bun.YAML.stringify`):

```yaml
{name: warp-smoke,windows: [{active_tab_index: 0,tabs: [{title: warp-smoke,color: Red,layout: {split_direction: vertical,panes: [{split_direction: horizontal,panes: [{cwd: /tmp/genie-warp-smoke-worktrees-<pid>/genie-warp-smoke-<pid>-warp-smoke-a,title: a,commands: [{exec: "claude \"$(cat .../a.prompt)\""}],is_focused: true},{cwd: .../warp-smoke-b,title: b,commands: [{exec: "claude \"$(cat .../b.prompt)\""}]}]},{cwd: .../warp-smoke-c,title: c,commands: [{exec: "claude \"$(cat .../c.prompt)\""}]}]}}]}]}
```

Structure confirmed from the YAML:
- 1 window, 1 tab (`title: warp-smoke`, `color: Red`), 3 leaf panes (3 ≤ 4, so one tab, no overflow).
- Layout: vertical split with a horizontal split holding panes `a`+`b`, and pane `c` alongside (the documented 3-pane 2x2-style grid).
- **Each leaf carries `title: a|b|c`** and `commands: [{exec: claude "$(cat <worktree>/.genie/launch/<group>.prompt)"}]`. First pane has `is_focused: true`.
- Every `cwd` is an absolute worktree path.

Generated kickoff prompt (`<worktree>/.genie/launch/a.prompt`):

```
Wish: warp-smoke
Group: a

You own group "a" of wish "warp-smoke". It has 1 ready task(s).
Claim each task before you work it, then mark it done when complete:

- t_...  Group A: engine
    claim:  genie task checkout t_... --worker a
    finish: genie task done t_...

Full context for this group lives in: .genie/wishes/warp-smoke/WISH.md
```

### 2. `launch <slug>` (real open — Warp launched)

Ran after cleaning the `--no-open` worktrees/config so materialization was exercised fresh. Output:

```
Launching wish "warp-smoke" — 3 group(s):
  a  →  .../warp-smoke-a  [created]
  b  →  .../warp-smoke-b  [created]
  c  →  .../warp-smoke-c  [created]
Wrote launch config: /Users/.../.warp/launch_configurations/genie-warp-smoke.yaml
Opening Warp: warp://launch//Users/.../.warp/launch_configurations/genie-warp-smoke.yaml
```

- **Process exit code: 0** (confirmed on a clean re-run capturing `$?`).
- **`open warp://launch/...` succeeded (exit 0).** In `launch.ts`, the `Opening Warp:` line is printed *only* when the opener returns success (`materialize()` → `openImpl(uri, platform)` truthy); a failed opener would instead fall through to the `Open it manually:` block. So the URI was accepted by the OS handler.
- 3 worktrees materialized on disk under the scratch base; the launch config written to the real Warp dir; `.genie/launch/<group>.prompt` written inside each worktree.

## CRITICAL — pane-title-on-leaf / what needs Felipe's eyes

I cannot see the Warp UI from here. The following are **confirmed observable from outside the UI**:
- The `open` handler accepted the URI (exit 0) and Warp was running.
- The YAML is schema-valid: 3 leaf panes, each with a `title`, a `cwd`, and a `claude "$(cat ...)"` command; first pane focused.
- Pane titles ARE emitted on the leaves (`title: a|b|c`) — the open question was whether the leaf-level `title` is what Warp renders on each pane tab.

**Needs Felipe's eyes (UI-only, not observable here):**
1. Did a Warp window actually open (no silent failure / no error dialog)?
2. Did exactly **3 panes** appear in the single tab, laid out as the grid?
3. Is each pane's **cwd** the correct per-group worktree?
4. Does each pane show the group **title** (`a` / `b` / `c`) on its leaf — the pane-title-on-leaf question?
5. Is each pane running `claude` seeded with that group's kickoff prompt (i.e. `$(cat <worktree>/.genie/launch/<group>.prompt)` expanded to the prompt text, not an error)?

No error dialogs or launch failures were observable from `open`'s exit code or Warp's on-disk logs (`~/Library/Application Support/dev.warp.Warp-Stable/` holds only `warp_network.log`, which was not touched by the launch — it is a network log, not a launch-config log, so it is not a reliable positive/negative signal either way). There is no machine-readable launch-config-parse log to inspect; items 1–5 above genuinely require a human looking at the window.

**Reproduce live (to observe with your own eyes):**
```bash
S=/tmp/genie-warp-eyes && rm -rf "$S" && mkdir -p "$S" && git -C "$S" init -q \
  && git -C "$S" config user.email x@y.z && git -C "$S" config user.name x \
  && ( cd "$S" && bun /path/to/genie/dist/genie.js init >/dev/null ) \
  && git -C "$S" add -A && git -C "$S" commit -qm init \
  && ( cd "$S" && bun /path/to/genie/dist/genie.js task create --title A --wish eyes --group a >/dev/null \
       && bun /path/to/genie/dist/genie.js task create --title B --wish eyes --group b >/dev/null \
       && bun /path/to/genie/dist/genie.js task create --title C --wish eyes --group c >/dev/null \
       && GENIE_WORKTREES_DIR="$S/wt" bun /path/to/genie/dist/genie.js launch eyes )
# then look at the Warp window. Cleanup: rm the scratch config + worktrees afterward.
```

## Assertion coverage: e2e vs manual-only

| Concern | Covered by | Notes |
|---|---|---|
| `genie init` scaffolds `.gitignore` (3 genie.db rules) + `.genie/INDEX.md`, exit 0 | e2e (`tests/e2e/v5-lifecycle.sh`, "fixture repo setup (genie init)") | init now drives the fixture scaffold; asserts exit 0, INDEX.md present, 3 ignore rules |
| `launch --dry-run` plans one pane per ready group (3) with absolute cwds | e2e ("launch --dry-run (plan-only…)") | asserts `3 group(s)`, 3 absolute `worktree:` lines under the fixture base, 3 absolute `cwd: /` YAML entries |
| `launch --dry-run` materializes nothing (no worktrees, no config anywhere) | e2e | fixture-scoped `GENIE_WORKTREES_DIR` asserted empty; `HOME` redirected into the fixture and asserted to hold no `genie-<slug>.yaml` |
| `launch --dry-run` exits 0 | e2e | explicit rc capture |
| `launch` (real emit) writes a schema-valid YAML with per-pane title/cwd/command | manual smoke | plus `launch.test.ts` unit coverage of the emitter |
| `launch` real open: `open warp://…` returns 0 | manual smoke | confirmed via the `Opening Warp:` branch + clean-run exit 0 |
| 3 panes actually render in Warp with right cwds/titles/claude | **manual-only, needs Felipe's eyes** | open questions 1–5 above; not scriptable from outside the UI |

## Open question status

- **Pane-title-on-leaf:** emitter-side RESOLVED (titles are emitted on each leaf; verified in the YAML). Warp-render side OPEN — needs Felipe to confirm the leaf `title` shows on each pane tab (eyes item 4).
- **3-panes-open / correct cwds / claude-seeded:** OPEN — UI-only, eyes items 1–3, 5.
