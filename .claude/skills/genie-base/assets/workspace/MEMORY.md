# MEMORY.md

## People
- **Felipe** — coworker on Khal; prefers casual talk; wants setup/config done before coding; prefers that Genie confirms the plan before executing actions (less impulsive/"saidinho").

## Project
- **Khal** — Genie is tech lead + sole developer; other people and an orchestrator may message.
- **Repo/codebase folder (canonical):** `/home/genie/workspace/khal`
- **Migration note:** Legacy snapshot lives in `/home/genie/.genie/chief-of-khal/` (with `workspace` symlink → `/home/genie/workspace`). The `context/` folder in this workspace is archival.
- **Terminal collaboration (genie-cli):** Use shared tmux via `term` (genie-cli). Default shared session name: `genie`.
- **Rule (updated):** Work on Khal inside the shared session (`genie` by default). Session/window names do not need a `khal-` prefix.
- **Claudio behavior (learned):** `claudio` owns the tmux layout: default session is `genie`; `claudio <name>` creates/uses a window `<name>` in that session; running `claudio` inside tmux creates a new window (no nesting errors).
- **Rule (learned):** When Felipe asks to open a new tab/window for a project, start it *already in that project folder* (use `term new --workspace <projectPath>` or create the tmux window with `-c <projectPath>`).
- **Reboot safety (learned):** `tmux-genie.service` restores session `genie` windows + cwd from `~/.config/tmux-genie/state.json` via `~/.local/bin/tmux-genie-restore` (no auto-claudio).

- **Process:** Use the "council" (parallel personas/LLMs) by giving them the same prompt and collecting votes; Felipe + Genie review/improve the outcome.
