# Wish: Genie Skill Graph — Orchestrated Intelligence Routing

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-skill-graph` |
| **Date** | 2026-03-29 |
| **Repo** | `automagik-dev/genie` |

## Summary

Redesign the genie skill ecosystem as a coherent routing graph. The `/genie` skill becomes a context-aware router that detects where an agent is in the lifecycle and routes to the correct skill. Hooks act as guardrails — short notices that intercept anti-patterns and point back to the router. Every skill declares its edges (incoming/outgoing) and enforces handoffs. No islands, no dead ends, no unforced transitions.

## Scope

### IN

**1. `/genie` router redesign:**
- Context-aware routing: detects current state (has wish? has review? has team? what stage?) and routes to the correct skill
- State detection via filesystem + PG: checks `.genie/wishes/`, git branch, executor state, task stages
- Replaces static decision table with dynamic graph traversal
- Every response ends with a concrete next action pointing to a specific skill
- Fallback: if no state detected, guides user through onboarding (`/wizard`) or exploration (`/brainstorm`)

**2. Hook → Router integration:**
- Orchestration-guard hook redirects to `/genie` for guidance (not just blocks)
- Hook messages include: what was wrong, what to do instead, "load `/genie` for full guidance"
- New hooks beyond orchestration: detect when agent is lost (no wish, no team, random edits) → redirect to `/genie`
- Hooks as the immune system, `/genie` as the brain

**3. Skill edge declarations:**
- Each SKILL.md declares `edges:` in frontmatter: `{ incoming: [...], outgoing: [...] }`
- Outgoing edges include condition and enforcement level (`auto` = auto-invoke, `suggest` = message only, `gate` = must pass before proceeding)
- Graph is verifiable: a script checks all declared edges are bidirectional and no skill is an island

**4. Enforced transitions (close the gaps):**
- `brainstorm` → auto-invoke `/wish` after review SHIP (currently suggested, not enforced)
- `wish` → auto-invoke `/review` (already done)
- `review SHIP` → auto-suggest `/work` with concrete command (currently vague)
- `review FIX-FIRST` → auto-invoke `/fix` (already done)
- `fix` → auto-invoke `/review` (already done)
- `trace` → auto-handoff to `/fix` with root cause report
- `learn` → re-route to current lifecycle position via `/genie` router
- `refine` → output auto-consumed by `/work` when dispatching (not orphaned in /tmp)

**5. Island elimination:**
- `brain` + `brain-init` → integrated into session startup context (brain loaded automatically, not manual)
- `report` → chains to `/trace` → `/fix` → `/review` (full resolution path)
- `dream` → accessible from `/genie` router when wish queue > 1 and time permits
- `genie-hacks` → discoverable from `/genie` when user asks about patterns
- `council` → results feed back into calling skill's decision (not advisory-only)

**6. Graph validation script:**
- `scripts/validate-skill-graph.ts` — reads all SKILL.md files, parses edge declarations, verifies:
  - No island skills (every skill reachable from `/genie`)
  - All outgoing edges have matching incoming declarations
  - All `auto` edges have implementation (not just documentation)
  - Happy path is complete: brainstorm → wish → review → work → review → ship

### OUT
- Changing skill behavior/logic (each skill's internal implementation stays the same)
- New skills (this is about connecting existing skills, not adding new ones)
- UI changes (this is backend/skill-level routing only)
- Removing any existing skills
- Changes to the genie CLI commands themselves

## Decisions

| Decision | Rationale |
|----------|-----------|
| `/genie` is the only entry point skill | Single point of routing prevents agents from starting at the wrong skill. All other skills are reached through `/genie` or through enforced handoffs from another skill. |
| Hooks redirect to `/genie`, not to specific skills | Hooks are guardrails, not routers. They say "you're off track, consult the router." The router has context to make the right decision. |
| Edge enforcement levels: auto/suggest/gate | Not all transitions need to be forced. `auto` = skill invokes next skill. `suggest` = skill prints next step. `gate` = must pass before proceeding (like review). |
| Graph validation as a test | The skill graph is a contract. If someone adds a skill without declaring edges, the test fails. Prevents future islands. |
| Frontmatter edge declarations | Keeps routing metadata colocated with the skill. No separate routing config file to drift. |

## Success Criteria

- [ ] `/genie` detects lifecycle state (has wish? reviewed? team exists?) and routes correctly
- [ ] Hook messages include redirect to `/genie` for guidance
- [ ] Every SKILL.md has `edges:` frontmatter declaring incoming/outgoing
- [ ] No island skills — `validate-skill-graph.ts` passes
- [ ] `brainstorm` auto-proceeds to `/wish` after design review SHIP (not just suggests)
- [ ] `refine` output is auto-consumed by `/work` dispatch (not orphaned)
- [ ] `learn` re-routes via `/genie` after applying behavioral fix
- [ ] `trace` → `/fix` handoff includes structured root cause report
- [ ] Happy path works end-to-end: `/genie` → brainstorm → wish → review → work → review → PR
- [ ] `bun run check` passes

## Execution Strategy

### Wave 1: Router + Edge Declarations
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Redesign `/genie` SKILL.md as context-aware router with state detection |
| 2 | engineer | Add `edges:` frontmatter to all 18 SKILL.md files with incoming/outgoing/enforcement |

### Wave 2: Hook Integration + Enforced Transitions
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Update orchestration-guard hook to redirect to `/genie` skill, add "lost agent" detection hook |
| 4 | engineer | Enforce auto-transitions: brainstorm→wish, trace→fix, learn→genie, refine→work |

### Wave 3: Island Elimination + Validation
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Connect islands: brain auto-load, report→trace chain, dream accessibility, council feedback loop |
| 6 | engineer | Graph validation script: `scripts/validate-skill-graph.ts` with tests |

### Wave 4: Review
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Full review: route every scenario through `/genie`, verify graph integrity |

## Execution Groups

### Group 1: `/genie` Router Redesign

**Goal:** Transform `/genie` from a static decision table into a context-aware router.

**Deliverables:**
1. Rewrite `skills/genie/SKILL.md` with dynamic state detection logic:
   - Check `.genie/wishes/` for existing wishes and their status
   - Check git branch for active work context
   - Check PG executor state for running agents
   - Check task stages for lifecycle position
2. Decision tree that routes based on detected state:
   - No wishes → `/brainstorm`
   - Wish DRAFT, no review → `/review`
   - Wish SHIP, no team → `genie team create` or `/work`
   - Team working → `genie status` + monitoring guidance
   - Review FIX-FIRST → `/fix`
   - User corrects behavior → `/learn`
   - User asks about patterns → `/genie-hacks`
   - Multiple wishes queued → `/dream`
3. Every response ends with concrete next action

**Acceptance Criteria:**
- [ ] `/genie` detects at least 5 distinct lifecycle states and routes correctly
- [ ] Static decision table replaced with context-aware logic
- [ ] Every response includes a concrete next action

**Validation:**
```bash
grep -c "genie status\|genie team\|/brainstorm\|/wish\|/review\|/work\|/fix" skills/genie/SKILL.md
```

**depends-on:** none

---

### Group 2: Edge Declarations

**Goal:** Add `edges:` frontmatter to every SKILL.md.

**Deliverables:**
1. Define edge schema in frontmatter:
   ```yaml
   edges:
     incoming:
       - from: genie
         condition: "idea is fuzzy"
       - from: wish
         condition: "gate check fails, idea needs exploration"
     outgoing:
       - to: review
         condition: "WRS reaches 100"
         enforcement: auto
       - to: wish
         condition: "design review returns SHIP"
         enforcement: suggest
   ```
2. Add edges to all 18 SKILL.md files based on current graph analysis
3. Document the edge schema in a comment at top of `/genie` SKILL.md

**Acceptance Criteria:**
- [ ] All 18 SKILL.md files have `edges:` in frontmatter
- [ ] Edges match the actual routing behavior already documented in each skill
- [ ] Schema is consistent across all files

**Validation:**
```bash
for f in skills/*/SKILL.md; do grep -l "edges:" "$f" || echo "MISSING: $f"; done
```

**depends-on:** none

---

### Group 3: Hook → Router Integration

**Goal:** Hooks redirect to `/genie` for guidance, plus new "lost agent" detection.

**Deliverables:**
1. Update `orchestration-guard.cjs` block messages to include: "Load `/genie` for full orchestration guidance"
2. New hook: `agent-drift-guard.cjs` — detects when agent is making random edits without a wish context:
   - Checks if `.genie/wishes/` has an active wish for this branch
   - If no wish context, warns: "No active wish detected. Load `/genie` to get oriented."
   - Triggers on: Edit, Write (not Bash, not Read — those are exploratory)
3. Register new hook in `hooks.json`

**Acceptance Criteria:**
- [ ] Orchestration-guard messages reference `/genie` skill
- [ ] Agent-drift-guard detects missing wish context on file edits
- [ ] Both hooks registered in hooks.json

**Validation:**
```bash
echo '{"tool_name":"Bash","tool_input":{"command":"tmux capture-pane"}}' | node plugins/genie/scripts/orchestration-guard.cjs | grep "/genie"
```

**depends-on:** 1

---

### Group 4: Enforced Auto-Transitions

**Goal:** Close the unforced transition gaps in the skill graph.

**Deliverables:**
1. `brainstorm/SKILL.md` — after review returns SHIP on design, auto-invoke `/wish` (not just suggest)
2. `trace/SKILL.md` — structured handoff to `/fix` with root cause report format
3. `learn/SKILL.md` — after applying fix, re-route via `/genie` to resume lifecycle
4. `refine/SKILL.md` — output path configurable: `/tmp/prompts/` OR inline into work dispatch context
5. `review/SKILL.md` — after SHIP verdict, include exact `genie team create` command (not vague "proceed to /work")

**Acceptance Criteria:**
- [ ] brainstorm auto-invokes /wish after SHIP
- [ ] trace outputs structured root cause report consumed by /fix
- [ ] learn re-routes via /genie after fix applied
- [ ] refine output consumable by /work without manual copy

**Validation:**
```bash
grep -l "auto-invoke\|auto-trigger" skills/brainstorm/SKILL.md skills/trace/SKILL.md skills/learn/SKILL.md
```

**depends-on:** 1, 2

---

### Group 5: Island Elimination

**Goal:** Connect the 7 island skills to the main graph.

**Deliverables:**
1. `brain/SKILL.md` — add edge from `/genie` router (when agent needs domain knowledge)
2. `brain-init/SKILL.md` — triggered from `/wizard` onboarding flow
3. `report/SKILL.md` — enforced chain: report → trace → fix → review (full resolution)
4. `dream/SKILL.md` — accessible from `/genie` when multiple wishes are SHIP-ready
5. `genie-hacks/SKILL.md` — discoverable from `/genie` when user asks about patterns/recipes
6. `council/SKILL.md` — results feed back as structured input to calling skill's decision

**Acceptance Criteria:**
- [ ] Every skill reachable from `/genie` (directly or via chain)
- [ ] No skill is an island (every skill has at least one incoming edge)
- [ ] report → trace → fix chain is documented and enforced

**Validation:**
```bash
# Check every skill has at least one incoming edge
for f in skills/*/SKILL.md; do grep -q "incoming:" "$f" && echo "OK: $f" || echo "ISLAND: $f"; done
```

**depends-on:** 2

---

### Group 6: Graph Validation Script

**Goal:** Automated test that verifies the skill graph is complete and consistent.

**Deliverables:**
1. `scripts/validate-skill-graph.ts`:
   - Reads all `skills/*/SKILL.md` files
   - Parses `edges:` frontmatter from each
   - Builds adjacency list
   - Validates:
     - Every skill reachable from `/genie` (BFS/DFS)
     - All outgoing edges have matching incoming declarations (bidirectional)
     - All `enforcement: auto` edges reference existing implementation
     - Happy path complete: genie → brainstorm → wish → review → work → review
   - Exits 0 if valid, 1 with specific failures
2. Add to `bun run check` pipeline (or as standalone `bun run validate-graph`)

**Acceptance Criteria:**
- [ ] Script parses all 18 SKILL.md files
- [ ] Detects islands (skills with no incoming edges except entry points)
- [ ] Detects orphan edges (outgoing with no matching incoming)
- [ ] Happy path validation passes
- [ ] Exits non-zero on graph violations

**Validation:**
```bash
bun run scripts/validate-skill-graph.ts
```

**depends-on:** 2, 5

---

## QA Criteria

- [ ] `/genie` routes correctly in 5+ lifecycle scenarios (no wish, draft wish, SHIP wish, working team, FIX-FIRST)
- [ ] Hook violations show redirect to `/genie` (not just block messages)
- [ ] All 18 skills have edge declarations
- [ ] Graph validation passes with no islands or orphan edges
- [ ] Happy path works: `/genie` → brainstorm → wish → review → work → review → PR
- [ ] `bun run check` passes

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Edge declarations in frontmatter may not be parsed by all YAML parsers | Low | Use standard YAML; test with bun yaml parser |
| Auto-transitions may be too aggressive for exploratory users | Medium | Keep `suggest` as default enforcement; `auto` only for gates |
| Graph validation may be slow with 18+ files | Low | Static analysis only, no runtime checks |
| Changing SKILL.md files may break existing behavior | Medium | Changes are additive (frontmatter + routing text); no logic removal |

## Review Results

_Populated by `/review` after execution completes._

## Files to Create/Modify

```
# Modified skills (all 18)
skills/genie/SKILL.md           — Full rewrite: context-aware router
skills/brainstorm/SKILL.md      — Add edges, auto-invoke /wish after SHIP
skills/wish/SKILL.md            — Add edges
skills/work/SKILL.md            — Add edges, consume /refine output
skills/review/SKILL.md          — Add edges, concrete next-step commands
skills/fix/SKILL.md             — Add edges
skills/trace/SKILL.md           — Add edges, structured handoff to /fix
skills/learn/SKILL.md           — Add edges, re-route via /genie
skills/refine/SKILL.md          — Add edges, configurable output path
skills/docs/SKILL.md            — Add edges
skills/council/SKILL.md         — Add edges, feedback loop
skills/pm/SKILL.md              — Add edges
skills/dream/SKILL.md           — Add edges, accessible from /genie
skills/brain/SKILL.md           — Add edges, connected to /genie
skills/brain-init/SKILL.md      — Add edges
skills/report/SKILL.md          — Add edges, enforced resolution chain
skills/genie-hacks/SKILL.md     — Add edges
skills/wizard/SKILL.md          — Add edges

# Modified hooks
plugins/genie/scripts/orchestration-guard.cjs  — Add /genie redirect
plugins/genie/hooks/hooks.json                  — Register drift guard

# New files
plugins/genie/scripts/agent-drift-guard.cjs    — Lost agent detection
scripts/validate-skill-graph.ts                 — Graph integrity test
```
