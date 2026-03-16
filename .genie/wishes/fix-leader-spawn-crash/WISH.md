# Wish: Fix Leader Spawn Crash — Kill Inline System Prompts

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-leader-spawn-crash` |
| **Date** | 2026-03-15 |

## Summary

The task leader pane dies on startup because its system prompt is passed inline via `--append-system-prompt` through shell escaping + tmux send-keys, which corrupts multi-line prompts with code blocks. Fix: eliminate inline `--append-system-prompt` / `--system-prompt` entirely. ALL prompts go through `--append-system-prompt-file` / `--system-prompt-file`. Built-in agent prompts get written to temp files automatically.

## Scope

### IN

- Remove inline `--append-system-prompt` and `--system-prompt` code path from `buildClaudeCommand()`
- When `systemPrompt` is set (built-in agents), auto-write to a temp file and use `--append-system-prompt-file` instead
- Merge built-in prompt + any extra prompt files (like leader's wish context) into a single file
- Remove any legacy `$(cat)` or inline prompt patterns if they still exist
- Close #568

### OUT

- Changes to built-in prompt content
- Changes to user agents with AGENTS.md (already use file path)
- Changes to wish/team create flow
- Shipping prompt files in the npm package (not needed — temp files at spawn time)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Kill inline prompt flags entirely | Shell escaping of multi-line prompts with code blocks is inherently fragile. Files bypass escaping. |
| Temp file per spawn at `/tmp/genie-prompts/` | Simple, OS cleans up, no package path resolution needed |
| Merge all prompt sources into one file | Avoids relying on multiple `--append-system-prompt-file` flags (undocumented, may not stack) |
| One code path: always `--*-system-prompt-file` | Eliminates an entire class of escaping bugs |

## Success Criteria

- [ ] `buildClaudeCommand()` never emits `--append-system-prompt` or `--system-prompt` (inline flags gone)
- [ ] Built-in agents (leader, implementor, tester, etc.) spawn correctly via temp file prompt
- [ ] `genie team create --wish <slug>` spawns leader that stays alive and begins working
- [ ] `genie spawn implementor --team <name>` still works
- [ ] No `--append-system-prompt` or `--system-prompt` (without `-file`) in the codebase
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: File-Only System Prompts

**Goal:** All system prompts go through files. No inline escaping.

**Deliverables:**
1. In `src/lib/provider-adapters.ts`, modify `buildClaudeCommand()`:
   - Remove the `else if (params.systemPrompt)` branch (lines 238-241) that emits inline `--append-system-prompt` / `--system-prompt`
   - Add: when `params.systemPrompt` is set, write it to a temp file at `/tmp/genie-prompts/<role>-<timestamp>.md` (use `mkdirSync` + `writeFileSync` since this is during command building)
   - Set the file path and use `--append-system-prompt-file` or `--system-prompt-file` based on `promptMode`
   - If `params.systemPromptFile` is ALSO set (user agent override), merge: read the existing file, prepend the built-in prompt, write combined to temp file
   - If `params.extraArgs` contains `--append-system-prompt-file` (like leader's wish context), merge that file's content too — all into one temp file
2. Clean up: search codebase for any remaining `--append-system-prompt` or `--system-prompt` (without `-file`) references and remove
3. Update `src/lib/provider-adapters.test.ts` — tests that check for inline prompt flags should now check for file-based flags

**Acceptance criteria:**
- `grep -rn "\-\-append-system-prompt \\|--system-prompt " src/ --include='*.ts' | grep -v file | grep -v test` returns nothing
- Built-in agent spawn produces `--append-system-prompt-file /tmp/genie-prompts/<role>-<ts>.md`
- Leader spawn merges built-in prompt + wish context into one file
- Implementor/tester/reviewer spawn works with temp file prompt

**Validation:**
```bash
bun run typecheck
bun test src/lib/provider-adapters.test.ts
grep -rn "\-\-append-system-prompt '\|--system-prompt '" src/ --include='*.ts' | grep -v file | grep -v test && echo "FAIL: inline prompts remain" || echo "PASS"
```

**depends-on:** none

---

### Group 2: Validation + E2E

**Goal:** Quality gates pass and leader spawn works end-to-end.

**Deliverables:**
1. `bun run check` passes
2. `bun run build` succeeds
3. E2E test: `genie team create --wish <slug>` → leader pane stays alive

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1
