# Wish: Genie Onboarding Flow

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `genie-onboarding-flow` |
| **Date** | 2026-04-06 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |
| **Parent** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ (sub-wish 2 of 3) |
| **Depends-on** | `genie-model-resolution` (must ship first — provides `BUILTIN_DEFAULTS`, `resolveField`, `computeEffectiveDefaults`, sectioned `workspace.json`) |
| **Blocks** | `genie-layout-migration` |
| **Repo** | `@automagik/genie` at `/home/genie/workspace/repos/genie` |

## Summary

Make genie self-bootstrapping: every `genie` command detects missing workspaces and offers init, `genie init` discovers all agents on disk and imports them, new agents at runtime trigger interactive prompts, incomplete frontmatter triggers a mini-wizard, the default `genie` agent is a specialist that guides users AND analyzes existing setups, and bare `genie` launches the TUI attached to the right agent based on your cwd. Covers ideas A+B+D+E+F+H from the onboarding-overhaul decomposition.

## Scope

### IN
- **Interactivity layer**: `isInteractive()` helper (tty + `CI` env + `--no-interactive` flag). All prompts gate on this.
- **Universal workspace check**: middleware on every `genie <verb>`; tty → prompt init → replay command; non-tty → exit 2.
- **`.genieignore`**: new file created at `genie init` with comprehensive defaults (`node_modules`, `.git`, `.genie/worktrees`, `dist`, `build`, `vendor`, `.next`, `.nuxt`, `__pycache__`, `.venv`, `target`, `coverage`, `.cache`). Scanner reads it.
- **Tree-wide `AGENTS.md` discovery**: recursive scan at `genie init` respecting `.genieignore`; per-file Y/n import with name derived from directory + confirmation; import = physical move to `<root>/agents/<name>/`; `.genie/agents/<sub>/` imported as sub-agents.
- **Pending-agents queue**: watcher queues detections to `.genie/pending-agents.json`; next interactive CLI command prompts Y/n; unregistered until accepted; persistent warnings; queue refreshed on re-scan.
- **Mini-wizard**: new `src/lib/mini-wizard.ts`; triggers on incomplete frontmatter after import; covers all `BUILTIN_DEFAULTS` fields + `description`; shows what's set, asks what's missing, presents effective defaults as suggestions.
- **Genie-specialist scaffold**: new AGENTS.md/SOUL.md/HEARTBEAT.md templates; hybrid concierge (new workspace) → orchestrator (mature workspace); in existing workspaces with agents from other systems, analyzes against genie templates and proposes improvements.
- **Bare `genie` = TUI + agent**: routes by cwd — agent dir → attach/start that agent; workspace root → default specialist; subfolder → walk up to nearest agent; no workspace → init → specialist.
- **Scripting safety**: `--no-interactive` flag + `CI=true`/non-tty → exit 2 everywhere.

### OUT
- Physical folder migration tooling (deferred to `genie-layout-migration`)
- Model resolution / cascading defaults (shipped in `genie-model-resolution`)
- TUI redesign (reuse existing TUI, add routing logic only)
- tmux+sdk transport coexistence (sibling brainstorm)
- PG schema changes
- Full `/wizard` overhaul (mini-wizard is new, separate)
- Non-interactive headless onboarding for CI (exit 2 + message only)
- Agent auto-registration in non-interactive mode (backwards-incompatible behavior removed by D8)

## Decisions

All 14 decisions from _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ — see D1–D14 there.

| # | Decision | Summary |
|---|----------|---------|
| D1 | Universal workspace check | tty → prompt init; non-tty → exit 2 |
| D2 | Command replay after init | Original command continues transparently |
| D3 | `--no-interactive` + CI auto-detect | Belt-and-suspenders scripting safety |
| D4 | `.genieignore` file | User-editable, scanner reads it |
| D5 | Import = move to canonical location | With confirmation; sub-agents follow schema |
| D6 | Name from directory + confirmation | Auto-derive, human verify |
| D7 | Pending-agents queue | Watcher queues, CLI prompts |
| D8 | Unregistered until explicit init | Persistent warning |
| D9 | Mini-wizard (not full /wizard) | 30-second tool for frontmatter completion |
| D10 | Specialist hybrid | Concierge → orchestrator |
| D11 | Analyze existing agents | Compare against templates, propose improvements |
| D12 | Bare `genie` = TUI + agent by cwd | `genie` IS the agent experience |
| D13 | `.genieignore` comprehensive defaults | Covers node/python/rust/go/build artifacts |
| D14 | Mini-wizard covers all fields | BUILTIN_DEFAULTS + description |

## Success Criteria

### Universal workspace check
- [ ] `genie serve` in a dir with no workspace prompts "Initialize? [Y/n]" in interactive mode
- [ ] Yes → init → `genie serve` continues (command replay)
- [ ] `CI=true` → exit 2, no prompt
- [ ] `--no-interactive` → exit 2, no prompt
- [ ] Non-tty (pipe) → exit 2, no prompt
- [ ] Every `genie <verb>` requiring workspace goes through the same check

### `.genieignore` + tree-wide discovery
- [ ] `genie init` creates `.genieignore` with comprehensive defaults
- [ ] `genie init` recursively scans for `AGENTS.md`, respecting `.genieignore`
- [ ] Each agent shown: "Found 'my-bot' at src/bots/my-bot/ → agents/my-bot/ — import? [Y/n]"
- [ ] Accept → physical move to `agents/<name>/` + register
- [ ] `.genie/agents/<sub>/` inside a parent → imported as sub-agent
- [ ] Decline → skip, re-offered next `genie init`
- [ ] Scanner skips `.genieignore`-excluded dirs
- [ ] Large monorepo (10k+ files) with `.genieignore` scans in under 5 seconds

### Pending-agents queue
- [ ] New dir with `AGENTS.md` in `agents/` while serve running → queues pending detection
- [ ] Next interactive `genie` command → "Detected '<name>'. Initialize? [Y/n]"
- [ ] Decline → unregistered, invisible to `dir ls` and spawn
- [ ] Prompt re-appears on next interactive invocation
- [ ] Non-interactive mode → queue but don't register (backwards compatible)

### Mini-wizard
- [ ] Incomplete frontmatter after import → mini-wizard triggers automatically
- [ ] Shows what's set, asks only what's missing
- [ ] Each missing field presents effective default as suggestion
- [ ] Enter = accept default; custom value = override
- [ ] After completion, AGENTS.md rewritten + agent registers
- [ ] Mini-wizard is a new module, NOT the full /wizard

### Genie-specialist scaffold
- [ ] Fresh `genie init` scaffolds specialist AGENTS.md/SOUL.md/HEARTBEAT.md
- [ ] SOUL.md includes pipeline knowledge + all genie commands
- [ ] In workspace with agents from other systems → analyzes against templates → proposes improvements
- [ ] Proposals shown for confirmation, no auto-modification
- [ ] Concierge mode (empty workspace) → orchestrator mode (mature) based on state

### Bare `genie` = TUI + agent
- [ ] `genie` in `agents/my-bot/` → attach/start `my-bot` session
- [ ] `genie` at workspace root → start specialist
- [ ] `genie` in non-agent subfolder → walk up to nearest agent or workspace default
- [ ] `genie` outside workspace → init flow → specialist
- [ ] TUI starts in all cases

### Quality gates
- [ ] `tsc --noEmit` clean
- [ ] `biome check` clean
- [ ] All existing tests pass
- [ ] New tests for: interactivity layer, universal check, `.genieignore` parsing, recursive scanner, pending queue, mini-wizard, cwd routing

## Execution Strategy

Four waves. Wave 1 builds the foundation layers that everything else depends on. Wave 2 fans out across the three main interactive features. Wave 3 builds the higher-level experiences. Wave 4 reviews.

### Wave 1 (parallel — foundations)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Interactivity layer: `isInteractive()` helper + `--no-interactive` flag parsing + universal workspace check middleware + command replay |
| 2 | engineer | `.genieignore` file + recursive `AGENTS.md` scanner |

### Wave 2 (parallel — interactive features, depends on Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Tree-wide discovery + import flow at `genie init` (move-to-canonical, sub-agent import, confirmation prompts) |
| 4 | engineer | Pending-agents queue (JSON queue file, watcher integration, CLI check-before-execute, persistent warnings) |
| 5 | engineer | Mini-wizard (`src/lib/mini-wizard.ts` — frontmatter diff, interactive prompts, effective defaults from resolver, AGENTS.md rewrite) |

### Wave 3 (parallel — higher-level experiences, depends on Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | Genie-specialist scaffold identity: new AGENTS.md/SOUL.md/HEARTBEAT.md templates, hybrid concierge→orchestrator, analyzer for existing agents |
| 7 | engineer | Bare `genie` TUI + agent routing: cwd resolution, session attach/start, workspace-root default, init-flow fallback |

### Wave 4 (review)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Execution review of Groups 1-7. All criteria verified. Quality gates run. |

## Execution Groups

### Group 1: Interactivity layer + universal workspace check

**Goal:** Every `genie <verb>` detects missing workspaces and handles it based on interactivity context.

**Deliverables:**
1. `src/lib/interactivity.ts` (NEW): `isInteractive()` — returns false if `process.stdout.isTTY` is false, `process.env.CI` is truthy, or `--no-interactive` flag is set. Exported for all prompt sites.
2. `--no-interactive` global flag registered in the CLI parser (`src/genie.ts` or wherever flags are registered).
3. `ensureWorkspace()` middleware: calls `findWorkspace()`; if missing and interactive → prompt "No workspace found. Initialize? [Y/n]"; if Yes → run init inline → replay the original parsed command (re-invoke the handler with same args); if No or non-interactive → exit with code 2 + message "No workspace. Run `genie init` to set up."
4. `ensureWorkspace()` injected before every command handler that requires a workspace (serve, spawn, dir, status, run, chat, etc.). Commands that don't need workspace (init, --help, --version) skip it.
5. Unit tests: `isInteractive()` with various env combos, `ensureWorkspace()` mock prompts, exit code 2 for non-interactive.

**Acceptance Criteria:**
- [ ] `genie serve` in empty dir, tty → prompts, accepts → serve starts
- [ ] `genie serve` with `CI=true` → exit 2, no prompt
- [ ] `genie serve --no-interactive` → exit 2
- [ ] `genie init` and `genie --help` skip the workspace check

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/interactivity.test.ts
```

**depends-on:** none

---

### Group 2: `.genieignore` + recursive scanner

**Goal:** Build the scanner that discovers all `AGENTS.md` files in a tree, respecting an ignore file.

**Deliverables:**
1. `.genieignore` template created during `genie init` at `<root>/.genieignore` with contents:
   ```
   node_modules
   .git
   .genie/worktrees
   dist
   build
   vendor
   .next
   .nuxt
   __pycache__
   .venv
   target
   coverage
   .cache
   ```
2. `src/lib/tree-scanner.ts` (NEW): `scanForAgents(root, ignoreFilePath)` — async generator yielding `{path, dirName, hasSubAgents}` for each `AGENTS.md` found. Uses a gitignore-compatible parser (e.g., `ignore` npm package) to read `.genieignore`. Walks depth-first, prunes ignored subtrees before descending.
3. Performance: tested against a synthetic 10k-file fixture, completes in under 5 seconds.
4. Unit tests: scanner finds agents in nested dirs, skips ignored dirs, handles missing `.genieignore` gracefully (scan everything), detects `.genie/agents/<sub>/AGENTS.md` as sub-agents.

**Acceptance Criteria:**
- [ ] `genie init` creates `.genieignore` at workspace root
- [ ] Scanner finds `AGENTS.md` in nested dirs, skips `node_modules` etc.
- [ ] Scanner identifies sub-agent directories (`.genie/agents/<sub>/AGENTS.md`)
- [ ] 10k-file fixture scan completes in under 5 seconds

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/tree-scanner.test.ts
```

**depends-on:** none

---

### Group 3: Tree-wide discovery + import flow

**Goal:** Wire the scanner into `genie init` and implement the move-to-canonical import with confirmation.

**Deliverables:**
1. `src/term-commands/init.ts` changes: after workspace scaffold, call `scanForAgents()`. For each result, display "Found agent '<name>' at <rel/path> → agents/<name>/ — import? [Y/n]". Gates on `isInteractive()`.
2. `src/lib/agent-import.ts` (NEW): `importAgent(sourcePath, destPath, opts)` — physically moves the directory (using `fs.rename` or copy+delete for cross-device), then calls `syncSingleAgent()` to register. For sub-agents inside a parent's `.genie/agents/`, imports into the canonical sub-agent slot.
3. Declined imports are not registered. They are re-offered on next `genie init` (scanner always re-scans).
4. Integration test: fixture with 3 agents scattered in nested dirs + 1 sub-agent. Run init, accept 2, decline 1. Assert: 2 moved to `agents/`, 1 still in original location. The sub-agent is correctly placed.

**Acceptance Criteria:**
- [ ] `genie init` shows each discovered agent with source→dest
- [ ] Accepted agents physically moved to `agents/<name>/` and registered
- [ ] Sub-agents moved to `agents/<parent>/.genie/agents/<sub>/`
- [ ] Declined agents skipped, re-offered next init
- [ ] Non-interactive mode skips import prompts entirely

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/agent-import.test.ts
```

**depends-on:** Groups 1 and 2

---

### Group 4: Pending-agents queue

**Goal:** When agents appear at runtime, queue them for interactive prompting instead of silently registering.

**Deliverables:**
1. `src/lib/pending-agents.ts` (NEW): `PendingAgentsQueue` class. Reads/writes `<root>/.genie/pending-agents.json`. Methods: `add(agentPath, dirName)`, `list()`, `remove(dirName)`, `refresh(existingPaths)` (removes stale entries for dirs that no longer exist).
2. `src/lib/agent-sync.ts` changes: `watchAgentDirectory()` callback → instead of auto-registering, calls `queue.add()`. Watcher still detects new dirs, but the action is queue-not-register.
3. `src/lib/pending-check.ts` (NEW): `checkPendingAgents()` — reads queue, for each pending agent prompts "Detected '<name>'. Initialize? [Y/n]". If Yes → register (+ trigger mini-wizard if incomplete). If No → leave in queue (persistent). Gates on `isInteractive()`.
4. `checkPendingAgents()` injected at the start of every interactive command handler (after `ensureWorkspace()`), before the command executes.
5. Unit tests: add to queue, list, remove, refresh (stale removal), prompt flow with mock stdin.

**Acceptance Criteria:**
- [ ] New agent dir during serve → queued, not auto-registered
- [ ] Next interactive command → prompts Y/n for each pending agent
- [ ] Declined → stays in queue, re-prompted next time
- [ ] Queue refreshed on scan (stale entries removed)
- [ ] Non-interactive → no prompt, queue untouched

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/pending-agents.test.ts
```

**depends-on:** Group 1

---

### Group 5: Mini-wizard

**Goal:** Complete incomplete frontmatter interactively with effective defaults as suggestions.

**Deliverables:**
1. `src/lib/mini-wizard.ts` (NEW): `runMiniWizard(agentsmdPath, workspaceConfig)` — reads AGENTS.md, parses frontmatter, loads `BUILTIN_DEFAULTS` + `computeEffectiveDefaults(workspace)` from `genie-model-resolution`. For each field in BUILTIN_DEFAULTS + `description`: if present → show as "already set", skip. If missing → prompt with effective default as suggestion (user presses Enter to accept or types override). Writes completed frontmatter back to AGENTS.md. Returns the parsed frontmatter.
2. Mini-wizard triggered from two sites: (a) Group 3 import flow — after move, if frontmatter is incomplete. (b) Group 4 pending-agents accept — after Y, if frontmatter is incomplete.
3. Interactive prompts gate on `isInteractive()`. Non-interactive → register with defaults silently (no wizard).
4. Unit tests: AGENTS.md with partial frontmatter (name + description only) → mini-wizard prompts for model, color, promptMode, effort, thinking, permissionMode → writes complete frontmatter. AGENTS.md with full frontmatter → mini-wizard is a no-op.

**Acceptance Criteria:**
- [ ] Partial AGENTS.md → mini-wizard prompts for missing fields only
- [ ] Each prompt shows effective default as suggestion
- [ ] Enter → accept default, custom text → override
- [ ] Complete AGENTS.md → mini-wizard skips (no prompts)
- [ ] Non-interactive → register with defaults, no wizard

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/mini-wizard.test.ts
```

**depends-on:** Group 1 (needs `isInteractive()`) + `genie-model-resolution` must have shipped (needs `BUILTIN_DEFAULTS`, `computeEffectiveDefaults`)

---

### Group 6: Genie-specialist scaffold identity

**Goal:** Replace the generic `genie` agent scaffold with a specialist that guides users and analyzes existing setups.

**Deliverables:**
1. New template files in `src/templates/`:
   - `GENIE_AGENTS_TEMPLATE` — specialist AGENTS.md with frontmatter describing the hybrid concierge/orchestrator role
   - `GENIE_SOUL_TEMPLATE` — SOUL.md with: pipeline knowledge (brainstorm → wish → work → review → ship), all genie commands, the concierge→orchestrator transition logic, agent analysis capability
   - `GENIE_HEARTBEAT_TEMPLATE` — HEARTBEAT.md with: workspace state check, pending agents check, wish status check, suggestion generation
2. `src/templates/index.ts` changes: `scaffoldAgentFiles()` uses the specialist templates when scaffolding the default `genie` agent. Other agents continue using the generic template (with commented defaults from `genie-model-resolution`).
3. Agent analyzer logic in the specialist's SOUL: when invoked in a workspace with existing agents from non-genie systems, reads each agent's directory structure, compares against genie template conventions (has SOUL.md? has HEARTBEAT.md? has frontmatter?), generates proposals.
4. No existing workspace modification — template change only affects new `genie init`. Existing `genie` agents unchanged.

**Acceptance Criteria:**
- [ ] Fresh `genie init` scaffolds specialist identity (not generic boilerplate)
- [ ] Specialist SOUL.md contains pipeline knowledge and command reference
- [ ] Specialist can analyze agents from other systems and propose improvements
- [ ] Existing workspaces are NOT modified — only new inits get the specialist

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && grep -q "brainstorm.*wish.*work.*review.*ship" src/templates/genie-soul.md
```

**depends-on:** Groups 3, 5 (specialist triggers mini-wizard, uses import flow concepts)

---

### Group 7: Bare `genie` TUI + agent routing

**Goal:** Make bare `genie` the single entry point that launches the TUI attached to the right agent based on cwd.

**Deliverables:**
1. `src/genie.ts` (or `src/term-commands/bare.ts`) changes: when `genie` is invoked with no verb:
   - Call `resolveAgentFromCwd(cwd)` which returns `{agent, source}`:
     - cwd IS an agent dir (`agents/<name>/` with AGENTS.md) → that agent, source = "exact"
     - cwd is inside an agent dir → walk up → that agent, source = "parent"
     - cwd is workspace root or non-agent subfolder → default `genie` agent, source = "default"
     - no workspace → run init flow (D1), then resolve again
   - Start TUI + launch/attach agent session:
     - If agent has a running session → attach
     - If agent session is stopped → start new session
     - If no session exists → create one
2. `src/lib/resolve-agent-cwd.ts` (NEW): `resolveAgentFromCwd(cwd, workspaceRoot)` — walks cwd up toward workspace root, checking for AGENTS.md at each level. Returns the resolved agent or falls back to default.
3. Integration tests: bare `genie` from agent dir, from workspace root, from random subfolder, from outside workspace.

**Acceptance Criteria:**
- [ ] `genie` in `agents/my-bot/` → TUI + my-bot session
- [ ] `genie` at workspace root → TUI + default specialist
- [ ] `genie` in random subfolder → TUI + nearest agent or default
- [ ] `genie` outside workspace → init → TUI + specialist
- [ ] Session attach if running, start if stopped, create if new

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/resolve-agent-cwd.test.ts
```

**depends-on:** Groups 1, 6 (needs interactivity layer + specialist identity exists)

---

### Review (after Wave 3)

**Goal:** Execution review — verify all criteria met, quality gates pass.

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun run biome check && bun test
```

**depends-on:** Groups 1-7

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] Fresh `genie init` in empty dir creates workspace + `.genieignore` + specialist `genie` agent
- [ ] Fresh `genie init` in repo with scattered AGENTS.md files discovers each and offers Y/n import
- [ ] Accepting import moves files to `agents/<name>/` and registers the agent
- [ ] Agent with incomplete frontmatter → mini-wizard triggers automatically after import
- [ ] `genie serve` outside workspace in interactive mode → prompts for init
- [ ] `genie serve` with `CI=true` → exits 2 cleanly
- [ ] New agent dir appears during serve → next interactive command prompts to initialize
- [ ] Declining a pending agent → re-prompted on next command
- [ ] Bare `genie` from agent dir → attaches to correct agent
- [ ] Bare `genie` from workspace root → starts specialist
- [ ] No regression: existing workspaces with already-registered agents continue to work

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Tree scan stalls on large repos | HIGH | `.genieignore` with comprehensive defaults. Scanner prunes before descending. |
| Universal prompt breaks CI | HIGH | Triple: tty + CI env + --no-interactive. Exit 2. |
| Move-on-import destroys state | HIGH | Confirmation prompt. Complex cases → `genie-layout-migration`. |
| Specialist bad suggestions | MEDIUM | Propose only, user confirms. Template comparison, not code analysis. |
| Pending queue stale | MEDIUM | Refreshed on re-scan. Stale entries removed. |
| Mini-wizard too many questions | MEDIUM | Shows what's set, skips. Defaults = Enter to accept. |
| Wrong agent resolved from cwd | MEDIUM | Clear precedence: exact > parent walk > workspace default. |

---

## Review Results

### Plan Review — 2026-04-06

**Verdict: SHIP**

All 12 checklist items verified:
- ✅ Problem statement testable (multi-part, each verifiable)
- ✅ Scope IN concrete (8 features, 20 new files)
- ✅ Scope OUT explicit (deferred to sibling wishes, PG schema excluded)
- ✅ Acceptance criteria testable (30+ checkboxes, no vague claims)
- ✅ Tasks bite-sized (400–600 LOC per group, 7 groups)
- ✅ Dependencies tagged (per-group + top-level, no cycles)
- ✅ Validation commands exist (8 commands, all concrete)
- ✅ D1–D14 design decisions all reflected in WISH
- ✅ Wave ordering correct (foundation → features → review)
- ✅ No scope creep detected
- ✅ Files inventory complete (20 new, 5 modify)
- ✅ Integration points defined (middleware injection, trigger sites)

**Critical dependency note:** G5 (mini-wizard) requires `genie-model-resolution` to have shipped and exported `BUILTIN_DEFAULTS` + `computeEffectiveDefaults`. Verify API contract before G5 execution.

**Recommendation:** Dispatch Wave 1 (G1 + G2) immediately. Wave 2 begins when Wave 1 validates. Block G5 on `genie-model-resolution` completion.

---

## Files to Create/Modify

```
NEW:
  src/lib/interactivity.ts              — isInteractive() helper
  src/lib/tree-scanner.ts               — recursive AGENTS.md scanner with .genieignore
  src/lib/agent-import.ts               — move-to-canonical + register
  src/lib/pending-agents.ts             — PendingAgentsQueue (JSON file)
  src/lib/pending-check.ts              — check+prompt pending agents before commands
  src/lib/mini-wizard.ts                — frontmatter completion with effective defaults
  src/lib/resolve-agent-cwd.ts          — resolve agent from cwd
  src/templates/genie-agents.md         — specialist AGENTS.md template
  src/templates/genie-soul.md           — specialist SOUL.md template
  src/templates/genie-heartbeat.md      — specialist HEARTBEAT.md template
  .genieignore (template)               — default ignore patterns
  src/__tests__/interactivity.test.ts
  src/__tests__/tree-scanner.test.ts
  src/__tests__/agent-import.test.ts
  src/__tests__/pending-agents.test.ts
  src/__tests__/mini-wizard.test.ts
  src/__tests__/resolve-agent-cwd.test.ts

MODIFY:
  src/genie.ts                          — bare command routing + --no-interactive flag
  src/term-commands/init.ts             — .genieignore creation + tree-wide discovery + import flow
  src/lib/agent-sync.ts                 — watcher → queue instead of auto-register
  src/templates/index.ts                — specialist templates for default genie agent
  src/term-commands/*.ts                — ensureWorkspace() + checkPendingAgents() injection
```
