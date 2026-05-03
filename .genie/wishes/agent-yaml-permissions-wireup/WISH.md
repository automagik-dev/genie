# Wish: agent-yaml permissions wireup + default-agent cleanup

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `agent-yaml-permissions-wireup` |
| **Date** | 2026-05-03 |
| **Author** | Felipe (via felipe agent — micropr scope) |
| **Appetite** | small (~1 engineer-day) |
| **Branch** | `wish/agent-yaml-permissions-wireup` |
| **Repos touched** | `automagik-dev/genie` |
| **PR target** | `dev` |

## Summary

The migration "AGENTS.md frontmatter → agent.yaml" was started but never wired through to the executor. As a result, `permissions.preset: full` and `sdk.allowedTools` declared in `agent.yaml` are silently ignored — workspace agents (felipe, brain, etc.) launch under `--permission-mode auto` defaults that exclude `Edit`/`Write`. Felipe (the operator) cannot edit files on his own VPS through the felipe agent persona despite `permissions.preset: full` being declared. Plus a regression in `wish/retire-session-names-id-only` makes `genie spawn <role> --team <team>` fail with `agents_id_shape_check` violation, blocking direct subagent spawn outside `genie work` flows. This wish fixes both blockers and absorbs the related cleanup Felipe called out: reviewer haiku→opus (haiku doesn't support `--permission-mode auto`), and an audit/purge of unused default agents under `plugins/genie/agents/`.

## Scope

### IN

**P0 — Permission wireup (the blocker)**
- Add `permissionMode` and `allowedTools` to `SpawnParams.permissions` in `src/lib/provider-adapters.ts` (currently only `allow`/`deny` Bash patterns).
- Add `allowedTools` and `permissionMode` to `permissions` schema in `src/lib/agent-yaml.ts` `AgentConfigSchema` (Zod).
- Add same fields to `DirectoryEntry.permissions` in `src/lib/agent-directory.ts`.
- Update `src/services/executors/claude-code.ts` `buildOmniSpawnParams` (and any sibling spawn paths) to:
  - Resolve `entry.permissions.preset` → canonical tool list. Map: `full` → all standard tools (Read, Write, Edit, Bash, Glob, Grep, ToolSearch, Skill, ScheduleWakeup, NotebookEdit, WebSearch, WebFetch, AskUserQuestion, Monitor, EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree, TaskCreate/Get/List/Output/Stop/Update, SendMessage, PushNotification, CronCreate/Delete/List, RemoteTrigger). `read-only` → Read, Glob, Grep, Bash, ToolSearch. `chat-only` → Bash, Read, ToolSearch only.
  - Forward `permissionMode` to claude when set.
  - Forward `allowedTools` (when present) to claude as `--allowedTools <list>`.
  - Forward `disallowedTools` as `--disallowedTools <list>` (already present but verify wire path).
- Update `src/lib/provider-adapters.ts` `buildLaunchCommand` (or claude-specific builder) to emit `--allowedTools` and `--permission-mode` flags when present in `SpawnParams`.

**P0 — Spawn UUID regression**
- Fix `lookupTemplateTeam(<role>)` failure in `src/lib/agent-directory.ts` (or its caller). Symptom: `genie spawn engineer --team genie` fails with `[agent-directory] lookupTemplateTeam(engineer) failed: invalid input syntax for type uuid: "engineer"` followed by `agents_id_shape_check` violation. Root cause likely in the retire-session-names id refactor — built-in role names being passed where UUID is expected.

**P0 — felipe agent end-to-end test**
- Update `/home/genie/workspace/agents/felipe/agent.yaml` `permissions` block:
  ```yaml
  permissions:
    preset: full
    permissionMode: acceptEdits
  disallowedTools:
    - Agent
  ```
- Verify after spawn: felipe agent in a fresh tmux session has Edit/Write/Glob/Grep available (validated by spawning felipe and listing tools). Document the validation in `docs/agent-yaml-tool-wireup.md`.

**P1 — Reviewer model: haiku → opus**
- Edit `plugins/genie/agents/reviewer/AGENTS.md` frontmatter line 4: `model: haiku` → `model: opus`.
- Reason: per Felipe, `--permission-mode auto` not supported by haiku/sonnet; reviewer is run frequently and must use opus for proper tool gating.

**P1 — Default-agents audit + cleanup**
- Inventory all subdirectories under `plugins/genie/agents/`. Currently: council, council--architect, council--benchmarker, council--deployer, council--ergonomist, council--measurer, council--operator, council--questioner, council--sentinel, council--simplifier, council--tracer, docs, engineer, fix, pm, qa, refactor, reviewer, team-lead, trace.
- For each: determine if it's referenced in genie source code (grep for the role name in `src/`, `plugins/`, `skills/`).
- For roles with zero references: delete the directory.
- For roles still referenced: confirm `model: inherit` (or explicit non-haiku/non-sonnet).
- Document survivors + deletions in PR description.

**P1 — Frontmatter → agent.yaml on remaining built-in roles**
- For each surviving role under `plugins/genie/agents/<role>/`: run the migration logic equivalent to `src/lib/agent-migrate.ts:migrateAgentToYaml` (which currently targets workspace agents).
- Result per role: `<role>/AGENTS.md` (body only, no frontmatter) + `<role>/agent.yaml` (model, color, promptMode, tools — converted from frontmatter).
- Update `src/lib/builtin-agents.ts:scanAgents` to read from agent.yaml instead of frontmatter (or both with agent.yaml winning), so the migration is non-breaking.

**Validation**
- `bun test` passes (unit + integration).
- `bun run typecheck` clean.
- Manual smoke: `genie spawn engineer --team genie` from a fresh shell does NOT throw `agents_id_shape_check`.
- Manual smoke: spawn felipe agent in a fresh tmux session, verify Edit/Write tools are available.
- Manual smoke: `genie spawn reviewer --team genie` uses opus (verify via `genie ls --json`).

### OUT

- Migrating ALL workspace agents (`workspace/agents/*`) frontmatter → agent.yaml. Out of scope; only felipe needs the agent.yaml path validated. Other workspace agents migrate later, separate wish.
- Adding new permission presets beyond `full`/`read-only`/`chat-only`. Felipe wants the existing 3 working, not a new design.
- Modifying claude code (upstream) — only the genie-side wire-through.
- Council member auto-spawn changes — council deliberation flow stays as-is.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Single PR, multi-concern (4 P0 + 3 P1) | Felipe direct: "micropr against genie dev". Cohesive scope: all about the agent.yaml migration finishing. |
| D2 | `preset: full` maps to canonical full tool list (~25 tools) | Concrete spec; predictable; matches what the operator persona expects |
| D3 | Migration of built-in role frontmatter is non-breaking via fallback | `scanAgents` reads agent.yaml first, falls back to frontmatter if absent. Old plugin installs keep working during rollout |
| D4 | Reviewer → opus, no model inherit chain | Direct fix; reviewer runs hot, deserves the explicit declaration |
| D5 | Felipe agent.yaml updated + tested as part of this PR | "we cant work without this" — felipe must be functionally unblocked when the PR ships |
| D6 | Default agents audit happens INSIDE this wish, not as separate sweep | Avoid context-switch; the survey must inform the migration (no point migrating dead agents) |

## Success Criteria

- [ ] **S1** — `genie spawn engineer --team genie` from a fresh shell exits 0 (no UUID error)
- [ ] **S2** — `genie spawn fix --team genie` from a fresh shell exits 0
- [ ] **S3** — Spawning felipe agent in a fresh session gives the agent access to Edit/Write/Glob/Grep tools (verified via tool inventory check)
- [ ] **S4** — `plugins/genie/agents/reviewer/AGENTS.md` has `model: opus` (or migrated to `agent.yaml` with `model: opus`)
- [ ] **S5** — Zero `model: haiku` or `model: sonnet` declarations across `plugins/genie/agents/**` (audit grep returns 0 hits)
- [ ] **S6** — Default-agents audit table in PR description: column for each role with usage status (used / dead) + action (kept / deleted / migrated)
- [ ] **S7** — Each surviving built-in role under `plugins/genie/agents/` has an `agent.yaml` (frontmatter empty in AGENTS.md or removed entirely)
- [ ] **S8** — `bun test` + `bun run typecheck` clean on the wish branch
- [ ] **S9** — PR open against `dev` with the audit table in the body

## Execution Strategy

Single wave, mostly sequential per file ownership. One engineer; pair-with-fix loop on validation gaps.

| Group | Description | Depends-on |
|-------|-------------|------------|
| 1 | Schema additions: `agent-yaml.ts` + `agent-directory.ts` + `provider-adapters.ts` `SpawnParams.permissions` extended (allowedTools, permissionMode) | none |
| 2 | Executor wire-through: `claude-code.ts` resolves preset → tool list, forwards allowedTools + permissionMode; `provider-adapters.ts` emits `--allowedTools` and `--permission-mode` flags | Group 1 |
| 3 | Spawn UUID regression: trace `lookupTemplateTeam` failure, fix the id-shape mismatch | none (parallel to G1+G2) |
| 4 | Default-agents audit + delete dead | none (parallel) |
| 5 | Reviewer haiku → opus + audit any other haiku/sonnet | parallel to G4 |
| 6 | Built-in roles frontmatter → agent.yaml migration; `scanAgents` reads agent.yaml-first with frontmatter fallback | Groups 2 + 4 + 5 |
| 7 | Felipe agent.yaml updated + smoke-tested end-to-end | Groups 2 + 3 |
| 8 | Tests + PR open with audit table | All groups |

---

## Execution Groups

### Group 1: Schema additions

**Goal:** Extend the agent.yaml schema and SpawnParams to carry `allowedTools` and `permissionMode`.

**Deliverables:**
1. `src/lib/agent-yaml.ts`: `AgentConfigSchema.permissions` extended with `allowedTools: z.array(z.string()).optional()` and `permissionMode: SdkPermissionModeSchema.optional()`.
2. `src/lib/agent-directory.ts`: `DirectoryEntry.permissions` interface extended with same fields.
3. `src/lib/provider-adapters.ts`: `spawnParamsSchema.permissions` extended with same fields. `SpawnParams` TypeScript interface mirrored.
4. Tests in `src/lib/agent-yaml.test.ts` covering parse/round-trip of new fields.

**Acceptance Criteria:**
- [ ] Parsing an `agent.yaml` with `permissions.allowedTools: [Read, Write]` succeeds (no Zod error).
- [ ] Parsing with `permissions.permissionMode: 'acceptEdits'` succeeds.
- [ ] Unknown values for permissionMode rejected with field-named Zod error.
- [ ] Round-trip (parse + write) preserves new fields byte-stable.

**Validation:**
```bash
bun test src/lib/agent-yaml.test.ts
bun run typecheck
```

**depends-on:** none

---

### Group 2: Executor wire-through (the unblocker)

**Goal:** Make `permissions.preset: full` (and the new fields) actually expose tools to the spawned claude process.

**Deliverables:**
1. `src/services/executors/claude-code.ts:184-207` — replace the `allow.length || deny.length` gate with full permission resolution:
   - Resolve `entry.permissions.preset` → canonical tool list using a `PRESET_TOOLS` map. Define presets: `full` (all ~25 tools), `read-only` (Read, Glob, Grep, Bash, ToolSearch), `chat-only` (Bash, Read, ToolSearch).
   - Merge resolved preset list with explicit `entry.permissions.allowedTools` (union).
   - Forward to SpawnParams as `permissions.allowedTools`.
   - Forward `entry.permissions.permissionMode` (default `auto`).
2. `src/lib/provider-adapters.ts` claude command builder: emit `--allowedTools <list>` (comma-separated) and `--permission-mode <mode>` flags when present.
3. Document the canonical preset → tool list mapping in `docs/permission-presets.md`.

**Acceptance Criteria:**
- [ ] Spawn command for an agent with `preset: full` includes `--allowedTools Read,Write,Edit,Bash,Glob,Grep,...`.
- [ ] Spawn command for an agent without permissions still works (no flag emitted).
- [ ] Spawn command for `preset: read-only` does NOT include Write/Edit in `--allowedTools`.
- [ ] Empty preset name passes through with warning, no crash.
- [ ] Tests in `src/services/executors/claude-code.test.ts` cover the 3 presets + missing preset + custom allowedTools merge.

**Validation:**
```bash
bun test src/services/executors/claude-code.test.ts
bun run typecheck
```

**depends-on:** Group 1

---

### Group 3: Fix `lookupTemplateTeam` UUID regression

**Goal:** Restore `genie spawn <role> --team <team>` for built-in role names.

**Deliverables:**
1. Trace the call path: `agents.ts` (term-commands) → `agent-directory.ts` `lookupTemplateTeam` → PG query.
2. Identify where a built-in role name (e.g., `engineer`) is being passed through a code path that expects a UUID. Likely in `wish/retire-session-names-id-only` work — check recent commits to `agent-registry.ts` and `agent-directory.ts`.
3. Fix: either accept role names alongside UUIDs in the lookup (add a name-resolver branch), or guard the call site so role names take a different path (template lookup).
4. Test: reproduce + assert spawn works for `engineer`, `reviewer`, `qa`, `fix`.

**Acceptance Criteria:**
- [ ] `genie spawn engineer --team genie` from a fresh shell exits 0 with `Agent ready`.
- [ ] `genie spawn fix --team genie` exits 0.
- [ ] No `agents_id_shape_check` violations on spawn.
- [ ] Test added that exercises the fix.

**Validation:**
```bash
bun test src/lib/agent-directory.test.ts
genie spawn engineer --team genie  # exits 0
genie agent rm <spawned-id>         # cleanup
```

**depends-on:** none

---

### Group 4: Default-agents audit + delete dead

**Goal:** Inventory `plugins/genie/agents/`, identify unused roles, delete them.

**Deliverables:**
1. Audit table (markdown file `audit-default-agents.md` in PR root, deleted post-merge):
   - Column: role name, references in src/, references in skills/, references in plugin definitions, decision (keep / delete).
2. For each role with zero references: `git rm -r plugins/genie/agents/<role>/`.
3. PR description embeds the audit table.

**Acceptance Criteria:**
- [ ] Audit covers all 20 current subdirectories.
- [ ] Delete decisions justified in audit table.
- [ ] No deletion of agents still referenced in code.
- [ ] PR description includes the audit table.

**Validation:**
```bash
# After deletions, verify no broken references:
grep -rn "plugins/genie/agents/<deleted-role>" src/ skills/ plugins/  # 0 hits
bun test
```

**depends-on:** none

---

### Group 5: Reviewer haiku → opus + haiku/sonnet purge

**Goal:** Eliminate haiku/sonnet defaults across `plugins/genie/agents/`.

**Deliverables:**
1. `plugins/genie/agents/reviewer/AGENTS.md:4` — `model: haiku` → `model: opus`.
2. Audit `plugins/genie/agents/**/AGENTS.md` for any other `model: haiku` or `model: sonnet`. Replace with `model: opus` or `model: inherit` per role context.

**Acceptance Criteria:**
- [ ] Reviewer's model is `opus` (or `inherit` if team default is opus).
- [ ] `grep -rn 'model:.*haiku\|model:.*sonnet' plugins/genie/agents/` returns 0 hits.

**Validation:**
```bash
grep -rn 'model:.*\(haiku\|sonnet\)' plugins/genie/agents/  # 0 hits
genie spawn reviewer --team genie  # uses opus per genie ls --json
```

**depends-on:** Group 3 (need spawn fix to validate)

---

### Group 6: Built-in roles frontmatter → agent.yaml migration

**Goal:** Move metadata out of frontmatter into agent.yaml for each surviving built-in role.

**Deliverables:**
1. For each role in `plugins/genie/agents/<role>/` (post Group 4 deletions): create `<role>/agent.yaml` with model, color, promptMode, tools, description from existing frontmatter. Keep `name` derived from directory.
2. Strip frontmatter from `<role>/AGENTS.md` (body only).
3. `src/lib/builtin-agents.ts:scanAgents` updated: read `<role>/agent.yaml` first; if absent, fallback to AGENTS.md frontmatter (legacy compat for older plugin installs).
4. Migration script `scripts/migrate-builtin-agents-to-yaml.ts` that does the conversion (rerunnable).

**Acceptance Criteria:**
- [ ] Each surviving role has `agent.yaml` with the converted fields.
- [ ] `scanAgents` returns the same `BuiltinAgent` objects post-migration (snapshot test).
- [ ] Removing `<role>/agent.yaml` and keeping only frontmatter still works (fallback path).
- [ ] Removing frontmatter and keeping only `agent.yaml` works (target state).

**Validation:**
```bash
bun test src/lib/builtin-agents.test.ts
bun run scripts/migrate-builtin-agents-to-yaml.ts --dry-run  # idempotent
```

**depends-on:** Group 4, Group 5

---

### Group 7: Felipe agent end-to-end smoke test

**Goal:** Validate the full wire-through using felipe agent as the canary.

**Deliverables:**
1. Update `/home/genie/workspace/agents/felipe/agent.yaml`:
   ```yaml
   permissions:
     preset: full
     permissionMode: acceptEdits
   disallowedTools:
     - Agent
   ```
2. Spawn felipe agent in a fresh tmux session.
3. Verify the spawned felipe has Edit/Write/Glob/Grep tools available (smoke check via `claude --list-tools` or similar).
4. Document in `docs/agent-yaml-tool-wireup.md` the full canary path.

**Acceptance Criteria:**
- [ ] Felipe agent spawn shows `--allowedTools` flag with Read,Write,Edit,Bash,Glob,Grep,... in the launch command.
- [ ] Felipe agent CAN write to a brain file via Edit tool (no permission denial).
- [ ] Felipe agent CANNOT spawn Agent tool (disallowedTools: Agent honored).

**Validation:**
```bash
genie spawn felipe --team felipe-test  # or directly tmux new-session with claude
# Inside spawned felipe:
# verify tool inventory shows Edit/Write
```

**depends-on:** Group 2, Group 3

---

### Group 8: Tests + PR open

**Goal:** Final validation gate + open PR against dev with audit table.

**Deliverables:**
1. Full `bun test` clean.
2. Full `bun run typecheck` clean.
3. PR opened against `dev` with title: `fix(agent-yaml): wire permissions through executor + audit default agents`.
4. PR body includes:
   - Summary of the wire-through fix
   - Audit table (Group 4 output)
   - Migration table (Group 6 output)
   - Felipe canary test results (Group 7 evidence)
   - Reviewer model change note (Group 5)

**Acceptance Criteria:**
- [ ] CI green on the PR.
- [ ] PR description has all 4 tables/sections.
- [ ] Reviewer reports SHIP verdict.

**Validation:**
```bash
bun test && bun run typecheck && gh pr view <pr-num>
```

**depends-on:** Group 1, Group 2, Group 3, Group 4, Group 5, Group 6, Group 7

---

## QA Criteria

- [ ] `genie spawn engineer --team genie` works from clean shell (no UUID error)
- [ ] `genie spawn fix --team genie` works
- [ ] Felipe agent spawned in fresh session has Edit/Write tools
- [ ] Reviewer agent uses opus model
- [ ] Zero haiku/sonnet defaults in `plugins/genie/agents/`
- [ ] All built-in roles have agent.yaml (frontmatter migrated or stripped)
- [ ] PR has audit table for default-agents cleanup

## Files to Create/Modify

```
# Schema
src/lib/agent-yaml.ts                              modify
src/lib/agent-directory.ts                         modify
src/lib/provider-adapters.ts                       modify

# Executor wire-through
src/services/executors/claude-code.ts              modify

# Spawn UUID fix
src/lib/agent-directory.ts                         modify (Group 3)
src/lib/agent-registry.ts                          modify (probable)

# Built-in agents migration
src/lib/builtin-agents.ts                          modify
plugins/genie/agents/<role>/AGENTS.md              modify (strip frontmatter)
plugins/genie/agents/<role>/agent.yaml             create (each surviving)
plugins/genie/agents/<dead-role>/                  delete
plugins/genie/agents/reviewer/AGENTS.md            modify (model: opus)
scripts/migrate-builtin-agents-to-yaml.ts          create

# Felipe agent (validation canary)
/home/genie/workspace/agents/felipe/agent.yaml     modify (real path, outside repo)

# Documentation
docs/permission-presets.md                         create
docs/agent-yaml-tool-wireup.md                     create

# Tests
src/lib/agent-yaml.test.ts                         modify
src/lib/builtin-agents.test.ts                     modify
src/services/executors/claude-code.test.ts         modify
src/lib/agent-directory.test.ts                    modify
```
