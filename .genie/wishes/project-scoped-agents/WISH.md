# Wish: Project-Scoped Agent Directory

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `project-scoped-agents` |
| **Date** | 2026-03-16 |

## Summary

The agent directory is global (`~/.genie/agent-directory.json`) — registering `engineer` for one project blocks it for all others. Fix: make the directory project-scoped so each project has its own agents. Resolution chain: project-scoped → global → built-in.

## Scope

### IN

- Project-scoped agent directory at `<repo>/.genie/agents.json`
- `genie dir add` defaults to project-scoped (writes to current repo's `.genie/agents.json`)
- `genie dir add --global` writes to global `~/.genie/agent-directory.json`
- Resolution chain: project `.genie/agents.json` → global `~/.genie/agent-directory.json` → built-in `plugins/genie/agents/`
- `genie dir ls` shows project + global + built-in (labeled by scope)
- Project detection via `git rev-parse --show-toplevel` (or CWD if not in a git repo)
- Close #578

### OUT

- Migration of existing global entries to project-scoped (users re-register manually)
- Changes to built-in agent resolution
- Changes to agent folder structure
- Per-team agent scoping (project scope is enough)

## Decisions

| Decision | Rationale |
|----------|-----------|
| `.genie/agents.json` in repo root | Same place as wishes, brainstorms, state. Natural project scope. Gitignored with `.genie/`. |
| Default to project-scoped | Most registrations are project-specific. `--global` flag for rare cross-project agents. |
| Project detection via git | `git rev-parse --show-toplevel` is reliable and handles worktrees (shared `.genie/`). |
| Three-tier resolution | Project > global > built-in. Most specific wins. Same pattern as Claude's CLAUDE.md scoping. |

## Success Criteria

- [ ] `genie dir add engineer --dir /path` writes to `<repo>/.genie/agents.json` (not global)
- [ ] Same name can be registered in different projects without conflict
- [ ] `genie dir ls` shows scope label (project/global/built-in) for each agent
- [ ] `genie spawn engineer` in project A gets project A's engineer
- [ ] `genie spawn engineer` in project B gets project B's engineer
- [ ] `genie spawn fix` (no project or global registration) falls through to built-in
- [ ] `genie dir add --global engineer --dir /path` writes to `~/.genie/agent-directory.json`
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Project-Scoped Directory

**Goal:** Agent directory reads/writes per project, not globally.

**Deliverables:**
1. In `src/lib/agent-directory.ts`:
   - Add `getProjectDirectoryPath()`: detect project root via `git rev-parse --show-toplevel`, return `<root>/.genie/agents.json`. Fallback to `<cwd>/.genie/agents.json` if not in a git repo.
   - Add `getGlobalDirectoryPath()`: returns `~/.genie/agent-directory.json` (current behavior)
   - Modify `loadDirectory()` to accept a scope parameter or load both
   - Modify `add()`: default writes to project directory. Accept `global: boolean` option to write to global.
   - Modify `rm()` and `edit()`: same scope logic — operate on project by default, `--global` for global
2. In `src/lib/agent-directory.ts`, modify `resolve()`:
   - Step 1: check project `.genie/agents.json`
   - Step 2: check global `~/.genie/agent-directory.json`
   - Step 3: check built-in roles
   - Step 4: check built-in council
3. In `src/lib/agent-directory.ts`, modify `ls()`:
   - Return entries from all three scopes with a `scope: 'project' | 'global' | 'built-in'` field
4. In `src/term-commands/dir.ts`:
   - Add `--global` flag to `genie dir add`, `genie dir rm`, `genie dir edit`
   - Update `genie dir ls` display to show scope column

**Acceptance criteria:**
- `genie dir add engineer --dir /path` in repo A writes to `A/.genie/agents.json`
- `genie dir add engineer --dir /path` in repo B writes to `B/.genie/agents.json` (no conflict)
- `resolve('engineer')` in repo A returns A's engineer
- `resolve('engineer')` in repo B returns B's engineer
- `genie dir ls` shows scope for each entry

**Validation:**
```bash
bun run typecheck
bun test src/lib/agent-directory.test.ts
```

**depends-on:** none

---

### Group 2: Validation

**Goal:** Quality gates pass.

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1

---

## Dependency Graph

```
Group 1 (Project-Scoped Directory)
         │
Group 2 (Validation)
```

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Not in a git repo | Low | Fallback to CWD-based `.genie/agents.json` |
| Existing global registrations break | Low | Global still works. Users re-register per project when needed. |
| `.genie/agents.json` committed to git | Medium | `.genie/` should be in `.gitignore`. If not, agents.json has paths that are machine-specific. Document this. |
