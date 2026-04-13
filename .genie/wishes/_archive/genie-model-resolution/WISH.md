# Wish: Genie Model Resolution — Cascading Defaults & Frontmatter Minimalism

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — verified in production `@automagik/genie` binary (2026-04-08) |
| **Slug** | `genie-model-resolution` |
| **Date** | 2026-04-06 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |
| **Parent** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ (sub-wish 1 of 3) |
| **Depends-on** | none |
| **Blocks** | `genie-onboarding-flow`, `genie-layout-migration` |
| **Repo target** | `@automagik/genie` (global install at `/home/genie/.bun/install/global/node_modules/@automagik/genie` for reference; actual source repo per orchestrator) |

## Summary

Fix the invalid `model: inherit` literal hardcoded into every scaffolded `AGENTS.md`, introduce cascading defaults via a sectioned `.genie/workspace.json` (`agents.defaults` + `tmux` + `sdk`), rewrite the scaffold template to zero mandatory fields with `.env.example`-style YAML-commented defaults, add a generic `resolveField<K>` resolver used at every spawn site, and auto-heal existing broken files by line deletion. Unblocks the rest of the onboarding-overhaul decomposition.

## Scope

### IN

- Strip `model: inherit`, `color: blue`, `promptMode: system` from `AGENTS_TEMPLATE` in `src/templates/index.ts` and the source `src/templates/AGENTS.md`.
- New scaffold shape: every field is a YAML `#` comment (two categories — freeform placeholders vs inherited-default fields with effective values computed at scaffold time).
- `.genie/workspace.json` restructured into sectioned config with three new sections: `agents.defaults`, `tmux`, `sdk`.
- Migration of existing flat-shape `workspace.json` (`name` + `tmuxSocket`) to the sectioned shape with no data loss.
- New file `src/lib/defaults.ts` with: `BUILTIN_DEFAULTS` constant, `normalizeValue()` helper (treats `undefined`/`null`/empty-string/`"inherit"` as absent), generic `resolveField<K>(agent, field, ctx)` resolver walking the 4-step chain, `computeEffectiveDefaults(workspace)` helper shared by scaffold and resolver.
- `WorkspaceConfig` type in `src/lib/workspace.ts` updated with sectioned shape + Zod validation of `agents.defaults`.
- Every site that reads `fm.model` / `entry.model` swapped to `resolveField(agent, 'model', ctx)`. Concretely: `src/lib/agent-sync.ts` (~line 244 `buildMetadata()`), spawn helpers under `src/term-commands/`, `src/lib/agent-directory.ts` resolve path.
- `syncAgentDirectory()` computes resolved values and stores them as `metadata.declared.*` and `metadata.resolved.*` in PG alongside declared values.
- Spawn path re-resolves live from disk so workspace edits take effect on next spawn without manual sync.
- Auto-heal loop in `syncAgentDirectory()` + `genie dir sync`: scans frontmatter for `model: inherit`, deletes the line (atomic write-rename), logs each action. v1 heals only this one literal; scanner is list-driven so future additions are trivial.
- `genie dir ls` output: exactly four columns (`agent`, `declared`, `resolved`, `source`) with `source` taxonomy `explicit` / `parent:<name>` / `workspace` / `built-in`. Column machinery driven by a `RESOLVED_FIELDS` constant so future fields add more triplets without code rework. v1 surfaces `model` only.
- `genie dir export <name>`: nested JSON structure — each resolved field has a sub-object `{declared, resolved, source}` using the same taxonomy.
- Unit tests for `defaults.ts`: each level of the chain, explicit-wins, forgiving mode, `computeEffectiveDefaults`.
- Integration tests: auto-heal on 5-agent `model: inherit` fixture, flat→sectioned workspace migration with no data loss, workspace.json edit → next spawn uses new default.
- Quality gates: `tsc --noEmit` clean, `biome check` clean, all existing tests still pass.

### OUT

- Any `inherit` keyword as a valid enum value (reframed away — absence means inherit).
- Onboarding UX, universal `genie` command, recursive `AGENTS.md` discovery, wizard fallback, new genie-specialist agent identity — deferred to `genie-onboarding-flow`.
- Physical folder migration of agent directories to canonical layout — deferred to `genie-layout-migration`.
- Designing how tmux and sdk transports coexist on the same agent identity — sibling brainstorm `tmux-sdk-coexistence`, flagged as next brainstorming topic. This wish only sets the `workspace.json` structure so coexistence is possible without rework.
- PG schema changes (metadata JSONB stays).
- Rewriting the spawn pipeline itself.
- Per-team or per-user defaults (workspace-level only for v1).
- Healing invalid literals other than `model: inherit` (v1 scope; architecture supports adding more).
- Surfacing fields other than `model` in `dir ls` at v1 (column machinery is generic, so future fields are additive).

## Decisions

All 11 decisions locked in the _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ — replayed here for quick reference.

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Cascading defaults, not `inherit` keyword | Cleaner mental model (`.env.example`), no invalid enum values, near-zero retrofit as new fields arrive. |
| D2 | Resolver is generic over all SDK fields | Per-field resolvers duplicate chain-walk logic; generic `resolveField<K>` handles every field with one impl. |
| D3 | Workspace-level defaults file is user-editable | Discoverability is the goal. |
| D4 | Scaffold writes only mandatory fields (and D8 makes that zero) | "We don't need to declare anything that isn't mandatory to start." |
| D5 | Defaults live in `.genie/workspace.json` as sectioned config | Single file, sections per concern. Avoids proliferating config files. |
| D6 | Structure must accommodate tmux+sdk coexistence (sibling brainstorm) | Same agent identity serves terminal (tmux), UI (sdk), Omni bridge (sdk direct). |
| D7 | Shared `agents.defaults` + mode-specific `tmux` / `sdk` sections | Single source of truth for agent identity; transport-specific operational concerns in their own sections. |
| D8 | Scaffold writes every default-having field as YAML `#` comment; zero mandatory; name derives from directory | Every knob visible, zero active. |
| D9 | Commented defaults reflect the EFFECTIVE default at scaffold time | Prevents misleading comments. Uses `computeEffectiveDefaults(workspace)` helper shared with resolver. |
| D10 | Resolution timing: sync-time cache + spawn-time refresh | `dir ls` fast; edits to workspace.json take effect on next spawn without manual sync. |
| D11 | Migration: auto-heal during sync by DELETING invalid lines | Not commenting. Each heal logged. Resolver stays forgiving for unhealed files. |

## Success Criteria

### Scaffold output
- [ ] `AGENTS_TEMPLATE` in `src/templates/index.ts` and `src/templates/AGENTS.md` contain ZERO active default values — all fields present only as YAML `#` comments inside the frontmatter block.
- [ ] The template has two clearly-separated comment categories: freeform placeholders (only `description` in v1, no `BUILTIN_DEFAULTS` entry) and inherited-default fields rendered with their effective default at scaffold time.
- [ ] `description` is NOT in `BUILTIN_DEFAULTS`, is NOT inherited, is NOT resolved, and is NOT healed.
- [ ] The scaffold computes effective-default values for inherited fields via `computeEffectiveDefaults(workspace)`, which uses the same merge rule as the last two steps of `resolveField`.
- [ ] A newly scaffolded agent has a valid frontmatter that passes Zod validation with every field absent — zero mandatory fields.
- [ ] Agent name derives from directory name during discovery; a new agent without a frontmatter `name:` field is still discoverable and registerable.

### workspace.json structure
- [ ] `.genie/workspace.json` on a fresh `genie init` contains three new sections: `agents.defaults`, `tmux`, `sdk`.
- [ ] `agents.defaults` holds cross-transport fields: `model`, `promptMode`, `color`, `effort`, `thinking`, `permissionMode`.
- [ ] `tmux` section holds: `socket`, `defaultWindow`, `execTimeout`, `readLines`.
- [ ] `sdk` section holds: `maxTurns`, `persistSession`, `includePartialMessages`, `includeHookEvents`.
- [ ] Existing flat-shape workspaces are migrated on first run: `tmuxSocket` moves into `tmux.socket`, new sections added with built-in defaults, no data loss.
- [ ] `WorkspaceConfig` type in `src/lib/workspace.ts` is updated with the new sectioned shape and passes `tsc --noEmit`.
- [ ] `agents.defaults` is validated on load against the same Zod schema as agent frontmatter. Invalid values cause loud startup error.

### Resolver behavior
- [ ] `src/lib/defaults.ts` exists with: `BUILTIN_DEFAULTS` constant, `normalizeValue()`, `resolveField<K>(agent, field, ctx)`, `computeEffectiveDefaults(workspace)`.
- [ ] `resolveField` walks: agent frontmatter → parent agent (sub-agents only) → `workspace.json → agents.defaults` → built-in defaults constant.
- [ ] `normalizeValue` treats `undefined`, `null`, empty string, and the literal `"inherit"` as absent.
- [ ] Sub-agent's parent is the top-level agent whose `.genie/agents/` directory the sub-agent lives in (matches current discovery).
- [ ] Explicit values always win: an agent with `model: sonnet` declared never gets overridden by any default.
- [ ] A top-level agent with no `model` declared resolves to `agents.defaults.model`.
- [ ] A top-level agent with no `model` AND no workspace default resolves to `BUILTIN_DEFAULTS.model` (= `"opus"`).
- [ ] A sub-agent with no `model` resolves to its parent's declared `model`; parent also absent → workspace → built-in.
- [ ] Resolver is used for `model` at every enumerated spawn site; raw `fm.model` / `entry.model` reads replaced. Concrete sites: `agent-sync.ts:244 buildMetadata()`, spawn helpers under `src/term-commands/`, `agent-directory.ts` resolve path.
- [ ] Adding inheritance for new fields (`effort`, `thinking`, etc.) requires zero new resolver code — just swapping the field argument at read sites.

### Sync cache + spawn refresh
- [ ] `syncAgentDirectory()` computes resolved values and writes them to PG metadata as `metadata.declared.*` and `metadata.resolved.*`.
- [ ] `genie dir ls` reads resolved values from PG for speed.
- [ ] Spawn re-resolves live from disk so edits to `workspace.json → agents.defaults` take effect on next spawn without `genie dir sync`.
- [ ] Regression test: editing `workspace.json → agents.defaults.model` from `opus` to `sonnet` and immediately spawning an agent (no manual sync) yields a session using `sonnet`.
- [ ] Regression test: double-spawning the same agent without edits reads cached metadata both times; no write amplification to PG.
- [ ] Regression test: running `syncAgentDirectory()` twice in a row without disk changes produces identical PG metadata (idempotent).

### `dir ls` / `dir export` surface
- [ ] `genie dir ls` output has exactly four columns per field: `agent`, `declared`, `resolved`, `source`. When multiple resolved fields are shown, the `declared`/`resolved`/`source` triplet repeats per field.
- [ ] `source` column emits one of: `explicit`, `parent:<name>`, `workspace`, `built-in`.
- [ ] Em-dash (`-`) in a `declared` column means the frontmatter did not declare the field.
- [ ] Column-generation is driven by a `RESOLVED_FIELDS` constant; v1 ships with only `model` in the constant.
- [ ] `genie dir export <name>` emits JSON where each resolved field has `{declared, resolved, source}` sub-object using the same taxonomy.

### Migration / healing
- [ ] `genie dir sync` detects `model: inherit` in any `AGENTS.md` and removes the line entirely (NOT comment conversion).
- [ ] Heal writes are atomic (write-temp + rename).
- [ ] Each heal action logs `[sync] healed <agent>/AGENTS.md: removed invalid 'model: inherit' line` (or equivalent).
- [ ] Healed files still parse cleanly and their agents register correctly against the resolver.
- [ ] Running `genie dir sync` twice on an already-healed workspace is a no-op (idempotent — no writes, no logs).
- [ ] Regression test: fixture workspace with 5 existing agents all carrying `model: inherit` is healed to 5 clean files on one `genie dir sync`, with PG state correctly reflecting the new resolved values.
- [ ] Resolver is forgiving at the read layer so any unhealed file never breaks spawn.

### Quality gates
- [ ] `tsc --noEmit` clean across the entire package.
- [ ] `biome check` clean.
- [ ] Unit tests cover: each level of the resolver chain, explicit-wins, forgiving mode for `"inherit"` literal, `computeEffectiveDefaults`.
- [ ] Integration tests cover: sync-time heal, spawn-time refresh after workspace.json edit, workspace migration.
- [ ] No regressions in existing tests for `agent-directory`, `agent-sync`, `frontmatter`, `workspace`.
- [ ] `genie init` on a fresh directory produces a valid sectioned `workspace.json` matching the documented shape.

## Execution Strategy

Three waves. Wave 1 establishes the pure-function foundation and data schema in parallel. Wave 2 fans out across three independent integration surfaces. Wave 3 wires the CLI surface then reviews.

### Wave 1 (parallel — pure-function foundation + schema)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | `src/lib/defaults.ts` — `BUILTIN_DEFAULTS` constant, `normalizeValue`, generic `resolveField<K>`, `computeEffectiveDefaults`, unit tests. Zero runtime dependencies on filesystem/PG/tmux — pure functions only. |
| 2 | engineer | `src/lib/workspace.ts` sectioned shape — `WorkspaceConfig` type + Zod validation + flat→sectioned migration helper + migration unit tests. |

### Wave 2 (parallel — depends on Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Scaffold rewrite — `src/templates/index.ts` + `src/templates/AGENTS.md` with two comment categories (freeform `description` + inherited defaults). `src/term-commands/init.ts` scaffold path calls `computeEffectiveDefaults(workspace)` to compute commented values at scaffold time. |
| 4 | engineer | Sync + cache + heal — `src/lib/agent-sync.ts` changes: `syncAgentDirectory()` computes resolved values and stores them in PG metadata; auto-heal loop for `model: inherit` with atomic write-rename; heal logging. `src/term-commands/dir.ts` `handleDirSync` picks up the heal loop. Heal integration test on 5-agent fixture. |
| 5 | engineer | Spawn site refactor — swap every `fm.model`/`entry.model` read for `resolveField(agent, 'model', ctx)`. Concrete sites: `src/lib/agent-sync.ts` (~line 244 `buildMetadata()`), all spawn helpers under `src/term-commands/` that read model, `src/lib/agent-directory.ts` resolve path. Regression test: workspace.json edit + immediate spawn uses new default. |

### Wave 3 (sequential — depends on Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| 6 | engineer | `dir ls` / `dir export` surface — `src/term-commands/dir.ts` printEntry: 4-column format with `source` taxonomy; `RESOLVED_FIELDS` constant seeded with `['model']`; `dir export` nested JSON. Display integration tests. |
| review | reviewer | Execution review of Groups 1-6. All success criteria verified with evidence. Quality gates run. |

## Execution Groups

### Group 1: `defaults.ts` foundation

**Goal:** Create the pure-function resolver and constants that every other group depends on.

**Deliverables:**
1. `src/lib/defaults.ts` exporting:
   - `BUILTIN_DEFAULTS` constant (readonly object with `model`, `promptMode`, `color`, `effort`, `thinking`, `permissionMode`).
   - `AgentDefaults` type = `typeof BUILTIN_DEFAULTS`.
   - `normalizeValue(v)` — returns `undefined` if input is `undefined`, `null`, empty string, or the literal `"inherit"`; otherwise returns the input.
   - `resolveField<K extends keyof AgentDefaults>(agent, field, ctx)` — 4-step chain walk per DESIGN §3.
   - `computeEffectiveDefaults(workspace)` — merges `workspace.agents?.defaults` over `BUILTIN_DEFAULTS`, returns effective default object. Shared with scaffold.
2. `src/__tests__/defaults.test.ts` covering:
   - Each level of the chain individually (agent / parent / workspace / built-in).
   - Explicit-wins: `model: sonnet` declared beats workspace default `opus`.
   - Forgiving mode: `"inherit"`, `null`, `undefined`, empty string at any level normalized to absent.
   - `computeEffectiveDefaults` with and without workspace overrides.
   - Sub-agent chain with parent hit, parent miss → workspace, parent miss → built-in.
   - Non-sub-agent (top-level only) 3-step chain.

**Acceptance Criteria:**
- [ ] `src/lib/defaults.ts` compiles clean under `tsc --noEmit`.
- [ ] `defaults.test.ts` passes with at least 10 test cases covering the scenarios above.
- [ ] Zero imports from `pg`, `fs`, `tmux`, or any other runtime-dependent module. Pure-function module.
- [ ] `BUILTIN_DEFAULTS.model === "opus"`.
- [ ] `normalizeValue("inherit") === undefined`.
- [ ] `resolveField` returns generic type matching the field key (`resolveField(agent, 'model', ctx)` returns a string, not `unknown`).

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/defaults.test.ts
```

**depends-on:** none

---

### Group 2: `workspace.ts` sectioned shape + migration

**Goal:** Restructure `WorkspaceConfig` and add flat→sectioned migration so every other group can read the new shape.

**Deliverables:**
1. `src/lib/workspace.ts` changes:
   - `WorkspaceConfig` type updated with optional `agents?: { defaults?: Partial<AgentDefaults> }`, `tmux?: TmuxConfig`, `sdk?: SdkConfig` sections alongside existing `name`, `pgUrl?`, `daemonPid?`.
   - `TmuxConfig` type: `socket?`, `defaultWindow?`, `execTimeout?`, `readLines?`.
   - `SdkConfig` type: `maxTurns?`, `persistSession?`, `includePartialMessages?`, `includeHookEvents?`.
   - Zod schemas for each section. `agents.defaults` validates against the same frontmatter schema constraints as an agent would.
   - `migrateWorkspaceConfig(raw)` helper — detects flat shape (has `tmuxSocket` at top level, no `tmux` section), moves `tmuxSocket` into `tmux.socket`, adds missing sections. Idempotent on already-sectioned input.
   - `readWorkspaceConfig()` calls `migrateWorkspaceConfig` before returning.
2. `src/__tests__/workspace-migration.test.ts`:
   - Flat shape (`{name, tmuxSocket}`) → sectioned output with `tmuxSocket` nested under `tmux.socket`.
   - Already-sectioned input is a no-op (idempotent).
   - Missing sections get added with empty objects (not built-in values — resolver handles fallback).
   - No data loss: every original field is present in the migrated output.
   - Zod rejection: `workspace.json` with `agents.defaults.model: 42` (wrong type) loads with loud error.

**Acceptance Criteria:**
- [ ] `tsc --noEmit` clean.
- [ ] `workspace-migration.test.ts` passes with at least 5 test cases.
- [ ] Calling `readWorkspaceConfig()` on a flat-shape fixture returns sectioned output.
- [ ] `WorkspaceConfig` consumers (type references in other files) compile clean after the shape change.

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/workspace-migration.test.ts
```

**depends-on:** none

---

### Group 3: Scaffold rewrite

**Goal:** Replace the broken `AGENTS_TEMPLATE` with the two-category commented-defaults shape, computing effective defaults at scaffold time.

**Deliverables:**
1. `src/templates/index.ts` `AGENTS_TEMPLATE` rewritten per DESIGN §4:
   - Frontmatter delimiters `---` with zero active fields.
   - Freeform placeholder comment block for `description`.
   - Inherited-default comment block with `model`, `promptMode`, `color`, `effort`, `thinking`, `permissionMode` — each rendered as `# <field>: <effective-default-value>`.
2. `src/templates/AGENTS.md` synced with the new template shape.
3. `scaffoldAgentFiles()` / `scaffoldAgentInWorkspace()` in `src/templates/index.ts` and `src/term-commands/init.ts`:
   - Take the current `workspace.json` as input.
   - Call `computeEffectiveDefaults(workspace)` from Group 1.
   - Substitute the effective values into the template before writing to disk.
   - String substitution via a small template function (no heavy templating engine).
4. `src/__tests__/scaffold.test.ts`:
   - Scaffold with a workspace that has `agents.defaults.model: "sonnet"` produces a template with `# model: sonnet`, not `# model: opus`.
   - Scaffold with an empty workspace (no `agents.defaults`) produces a template with `# model: opus` (built-in).
   - The scaffold's frontmatter parses to an empty object via `parseFrontmatter()` — zero active fields.
   - The scaffold contains exactly one `# description:` line in the freeform placeholder block.
   - The scaffold contains exactly one comment line per `BUILTIN_DEFAULTS` key in the inherited block.

**Acceptance Criteria:**
- [ ] `tsc --noEmit` clean.
- [ ] `scaffold.test.ts` passes with at least 5 test cases.
- [ ] `AGENTS_TEMPLATE` literal does not contain the strings `model: inherit`, `color: blue`, or `promptMode: system` as active values (only inside comments).
- [ ] Running `genie init agent test-scaffold` in a test workspace produces a file whose frontmatter parses to `{}`.

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/scaffold.test.ts && grep -c "^model: inherit" src/templates/AGENTS.md | grep -q '^0$'
```

**depends-on:** Group 1 (uses `computeEffectiveDefaults`)

---

### Group 4: Sync + cache + heal

**Goal:** Teach `syncAgentDirectory()` to compute and cache resolved values, and to auto-heal `model: inherit` lines atomically.

**Deliverables:**
1. `src/lib/agent-sync.ts` changes:
   - At the start of `syncAgentDirectory()`, for each discovered agent: read `AGENTS.md`, scan the frontmatter block for `model: inherit`, if found delete the line, write back atomically (temp-file + rename), log `[sync] healed <agent>/AGENTS.md: removed invalid 'model: inherit' line`. Idempotent — no write if no match.
   - Heal scanner is driven by a list `const INVALID_LITERALS = [{ field: 'model', value: 'inherit' }]` so future additions don't require code changes to the scanner.
   - After heal, re-parse frontmatter (now clean).
   - For each agent, compute resolved values via `resolveField` for every field in `BUILTIN_DEFAULTS`.
   - Extend `buildMetadata()` to emit `{declared: {...}, resolved: {...}}` sub-objects. Existing metadata shape stays compatible (declared = old shape).
2. `src/__tests__/heal.test.ts`:
   - Fixture: 5 agents, each with `model: inherit` in their AGENTS.md frontmatter. Run heal. Assert: all 5 files no longer contain `model: inherit`, all 5 parse cleanly, all 5 have resolved `model: "opus"` (or the workspace default).
   - Idempotency: run heal twice on an already-clean workspace, assert zero writes and zero log lines.
   - Atomic write: simulate a crash mid-heal (kill after temp file created but before rename) → original file unchanged (use a write-rename wrapper that can be intercepted in tests).
   - Heal inside `syncAgentDirectory()` completes before the resolve/metadata-build step, so metadata reflects the healed file.
3. PG metadata shape documented in a comment at the top of `buildMetadata()`.

**Acceptance Criteria:**
- [ ] `tsc --noEmit` clean.
- [ ] `heal.test.ts` passes.
- [ ] `syncAgentDirectory()` on a fixture workspace with `model: inherit` agents heals them, with log output verifiable.
- [ ] PG metadata for each synced agent contains both `metadata.declared.model` and `metadata.resolved.model` keys.
- [ ] Running `genie dir sync` twice in a row is a no-op on the second run (no writes, no logs).

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/heal.test.ts && bun test src/__tests__/agent-sync.test.ts
```

**depends-on:** Groups 1 and 2

---

### Group 5: Spawn site refactor

**Goal:** Swap every raw `fm.model` / `entry.model` read for `resolveField` so spawns get live values from the cascading chain.

**Deliverables:**
1. Enumerate every site that reads `model` from agent frontmatter or directory entry. Starting points (engineer may find more):
   - `src/lib/agent-sync.ts` ~line 244 `buildMetadata()` — switch to `resolveField(agent, 'model', ctx)`.
   - `src/lib/agent-directory.ts` — any `entry.model` reads in the resolve/spawn path.
   - All files under `src/term-commands/` that spawn (check `spawn`, `run`, `exec`, `chat` commands, tmux helpers).
2. Each site is converted to `resolveField(agent, 'model', { workspace, parent })`. The `parent` field is populated only for sub-agents by looking up the top-level agent whose `.genie/agents/` directory contains the sub-agent (matches existing discovery).
3. Spawn path reads `workspace.json` fresh from disk at spawn time, does not trust cached PG metadata for the resolved value. PG cache is used only by `dir ls`.
4. `src/__tests__/spawn-refresh.test.ts`:
   - Scenario: workspace starts with `agents.defaults.model: "opus"`. Spawn agent X (no declared model) → session uses `opus`. Edit workspace.json to `agents.defaults.model: "sonnet"`. Spawn agent X again with no manual sync → session uses `sonnet`.
   - Scenario: double-spawn of the same agent without any edits; PG metadata is untouched on the second spawn (no write amplification). Assert PG metadata row's `updated_at` or equivalent has not changed.
   - Scenario: sub-agent inherits from parent (parent declares `model: sonnet`, sub-agent declares nothing) → sub-agent spawn uses `sonnet`.

**Acceptance Criteria:**
- [ ] `tsc --noEmit` clean.
- [ ] `spawn-refresh.test.ts` passes with all three scenarios.
- [ ] `grep -rn "fm\.model\|entry\.model" src/` returns zero results outside of `defaults.ts` and test files (all read sites converted).
- [ ] No regressions in existing spawn tests.

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/spawn-refresh.test.ts && bun test
```

**depends-on:** Group 1

---

### Group 6: `dir ls` / `dir export` surface

**Goal:** Render the declared-vs-resolved chain visibly in the CLI surface so users can debug resolution.

**Deliverables:**
1. `src/term-commands/dir.ts` `printEntry` (or equivalent listing function) rewritten to emit the 4-column format per DESIGN §7:
   ```
   agent           declared      resolved      source
   -----           --------      --------      ------
   genie           -             opus          built-in
   engineer        sonnet        sonnet        explicit
   sub/qa          -             sonnet        parent:engineer
   onboarding      -             haiku         workspace
   ```
2. A `RESOLVED_FIELDS` constant (exported from `src/lib/defaults.ts` or a new `src/term-commands/dir-fields.ts`) with value `['model'] as const` for v1. Column generation loops over this constant and emits a triplet per field.
3. `source` column emits one of `explicit`, `parent:<name>`, `workspace`, `built-in`. The resolver needs a `resolveFieldWithSource<K>` variant (or extend `resolveField` to return `{value, source}`) so the CLI can annotate.
4. `genie dir export <name>` emits JSON where each key in `RESOLVED_FIELDS` has a sub-object `{declared, resolved, source}`:
   ```json
   { "name": "engineer", "model": { "declared": "sonnet", "resolved": "sonnet", "source": "explicit" } }
   ```
5. `src/__tests__/dir-ls.test.ts`:
   - Agent with explicit model → source is `explicit`.
   - Sub-agent inheriting from parent → source is `parent:<name>`.
   - Agent falling through to workspace default → source is `workspace`.
   - Agent falling through to built-in → source is `built-in`.
   - `dir export` JSON shape matches the contract for each scenario.

**Acceptance Criteria:**
- [ ] `tsc --noEmit` clean.
- [ ] `dir-ls.test.ts` passes.
- [ ] Running `genie dir ls` in a test workspace with the 4 scenarios above produces correct output for each row.
- [ ] Running `genie dir export engineer` produces the expected nested JSON structure.
- [ ] `RESOLVED_FIELDS` is a single source of truth — adding `effort` to the constant makes `dir ls` render an `effort` triplet without any other code changes.

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun test src/__tests__/dir-ls.test.ts
```

**depends-on:** Groups 4 and 5 (needs resolved metadata in PG and resolver-with-source)

---

### Review (after Group 6)

**Goal:** Execution review — verify all success criteria are met with evidence and quality gates pass.

**Reviewer responsibilities:**
- Run all validation commands from Groups 1-6.
- Run full test suite: `bun test`.
- Run `tsc --noEmit` and `biome check` across the entire package.
- Verify the `grep` criterion in Group 5 (zero raw `fm.model`/`entry.model` reads).
- Verify `AGENTS_TEMPLATE` literal per Group 3 criterion.
- Sample a few existing agent files after `genie dir sync` to confirm heal worked without corruption.
- Check `workspace.json` after `genie init` on a fresh fixture matches the documented sectioned shape.
- Return SHIP, FIX-FIRST, or BLOCKED per the /review skill.

**Validation:**
```bash
cd <repo> && bun run tsc --noEmit && bun run biome check && bun test
```

**depends-on:** Groups 1-6

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Fresh `genie init` in an empty directory produces a valid sectioned `.genie/workspace.json` with `agents.defaults`, `tmux`, and `sdk` sections.
- [ ] Fresh `genie init agent my-test` scaffolds an `AGENTS.md` whose frontmatter is entirely comments — `parseFrontmatter` returns `{}`.
- [ ] Running `genie init` in an existing workspace with the old flat `workspace.json` shape migrates it in place without data loss; `tmuxSocket` moves into `tmux.socket`.
- [ ] `genie dir sync` on a workspace containing any `model: inherit` agents heals them by removing the line and logs each heal action.
- [ ] `genie dir ls` shows the 4-column format with `declared`, `resolved`, and `source` for each agent's model.
- [ ] Editing `workspace.json → agents.defaults.model` and immediately spawning an agent without running `genie dir sync` starts the session with the new model.
- [ ] Sub-agents without declared model inherit their parent's declared model.
- [ ] A sub-agent whose parent also has no declared model falls through to the workspace default, then to the built-in `opus`.
- [ ] No regression: existing workspaces with already-declared `model:` values in agent frontmatter (valid models like `sonnet`, `opus`, `haiku`) continue to work unchanged.
- [ ] No regression: spawning agents via `genie spawn`, `genie run`, team-created agents, and directly-invoked sub-agents all resolve model correctly.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Existing agents with `model: inherit` break when resolver rejects invalid strings | HIGH | Forgiving resolver at read layer normalizes `"inherit"` to absent so nothing breaks mid-heal. Auto-heal strips the line on next sync. |
| Workspace defaults file diverges from built-in defaults as code evolves | MEDIUM | Resolver always falls through to built-in if workspace doesn't declare a field. Missing fields are additive, not breaking. |
| Users edit `workspace.json → agents.defaults` with invalid values | MEDIUM | Validate `agents.defaults` on load against the same Zod schema as frontmatter. Refuse to start with loud error. |
| `tsc --noEmit` fails because `WorkspaceConfig` type changes ripple | MEDIUM | Part of quality gates. Groups 3, 4, 5, 6 all re-run tsc as part of their validation. |
| Concurrent `genie dir sync` (heal) + `genie serve` watcher auto-sync create a race | LOW | Heal writes are atomic (write-rename). Spawn always re-resolves from disk, so the cache is advisory only. Watcher re-syncs on next file event. |
| A spawn happens DURING heal — spawn reads an already-healed file but PG cache is stale | LOW | Spawn path does not trust PG cache for resolution — it re-parses `AGENTS.md` + re-reads `workspace.json` at spawn time. Cache is only for `dir ls` speed. |
| Cascading lookup adds latency per spawn | LOW | Chain is 4 steps max, all in-memory. Sub-millisecond. |
| Mandatory set is wrong | LOW | Mandatory = zero. The only requirement is "file exists and parses." |
| Sub-agent parent semantics unclear | LOW | Rule frozen: sub-agent's parent is the top-level agent whose `.genie/agents/` directory it lives in. |
| Heal destroys a user's intentional `model: inherit` line | ZERO | `"inherit"` is not a valid model and was never intentional — always a scaffold bug. |
| Scaffold's effective-default computation reads a workspace.json that doesn't exist yet | LOW | Falls through to built-in defaults if `workspace.json` is absent/empty. |

---

## Review Results

### Plan Review — 2026-04-06 (pre-work)
**Verdict:** SHIP (first pass, zero fix loops)

All 11 Plan Review checklist items PASSED:
- Problem statement: 1 sentence, testable
- Scope IN/OUT concrete + explicit
- 6 execution groups + review, all with testable criteria
- Dependency graph coherent across 3 waves
- Validation commands self-contained and executable
- Zero scope creep vs DESIGN (all 11 locked decisions D1–D11 reflected)
- No vague tasks, no orphaned criteria

**Engineer discretion notes** (non-blocking):
- G4 atomic-write test: "simulate crash mid-heal" may be infeasible in bun test runner. Engineer may soften to structural assertion (write-then-rename pattern verifiable via code inspection + basic integration test on real file).
- G5 grep criterion: test files are explicitly exempted; spirit is "no production code reads raw `fm.model`."

Ready for engineer dispatch. Pre-execution review populated after `/work` completes.

### Execution Review

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
NEW:
  src/lib/defaults.ts                        — BUILTIN_DEFAULTS, normalizeValue, resolveField<K>, computeEffectiveDefaults
  src/__tests__/defaults.test.ts             — resolver chain, forgiving mode, explicit-wins
  src/__tests__/workspace-migration.test.ts  — flat → sectioned migration + Zod validation
  src/__tests__/scaffold.test.ts             — two-category template + effective default computation
  src/__tests__/heal.test.ts                 — 5-agent fixture heal + idempotency + atomic write
  src/__tests__/spawn-refresh.test.ts        — workspace.json edit → next spawn + double-spawn + sub-agent
  src/__tests__/dir-ls.test.ts               — 4-column format + source taxonomy + dir export JSON

MODIFY:
  src/lib/workspace.ts                       — WorkspaceConfig sectioned shape, migrate helper, Zod
  src/lib/agent-sync.ts                      — auto-heal loop, buildMetadata with declared+resolved
  src/lib/agent-directory.ts                 — resolver usage in resolve/spawn paths; declared vs resolved
  src/lib/frontmatter.ts                     — (parser unchanged; forgiving logic lives in defaults.ts)
  src/templates/index.ts                     — AGENTS_TEMPLATE rewrite with two comment categories
  src/templates/AGENTS.md                    — sync with template
  src/term-commands/init.ts                  — scaffold path calls computeEffectiveDefaults + writes sectioned workspace.json
  src/term-commands/dir.ts                   — handleDirSync picks up heal; printEntry 4-column format; export nested JSON
  src/term-commands/<spawn-helpers>          — swap fm.model / entry.model for resolveField (files discovered during Group 5)
```
