# Genie-CLI Development Context

When working on genie-cli code, always:

1. **Read before editing** - Use `Read` to understand existing patterns in `tools/genie-cli/src/`
2. **Use active pane/window** - Never hardcode `[0]` for windows/panes, always find active
3. **Test with term commands** - After changes, rebuild and test with `term <command>`

## Quick Reference

- **Entry points:** `src/genie.ts`, `src/term.ts`
- **Tmux library:** `src/lib/tmux.ts` - all tmux operations go here
- **Command pattern:** `src/term-commands/<name>.ts` exports handler function

## Common Gotchas

- The `active` property on TmuxWindow/TmuxPane indicates current focus
- Pane IDs use `%` prefix (e.g., `%0`), window IDs use `@` prefix (e.g., `@0`)
- Working directories should be escaped with `escapeShellPath()` for tmux
