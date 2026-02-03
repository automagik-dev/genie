# ENVIRONMENT.md

Purpose: machine/VM-specific facts that should *not* live in personality/role.

## Canonical paths
- Workspace root: `/home/genie/workspace`
- Khal repo root: `/home/genie/workspace/khal`

## Collaboration / tmux conventions
- Shared tmux session: `genie`
- Khal work should use a window named: `khal`

## Legacy / migration notes
- Legacy snapshot: `/home/genie/.genie/chief-of-khal/` (contains a `workspace -> /home/genie/workspace` symlink)
- `context/` under workspace is archival.

## Known local gotchas
- ripgrep (`rg`) is not installed (use `grep -RIn` instead).
