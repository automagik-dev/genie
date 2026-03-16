# Wish: Genie Skill Refresh — Full Orchestration Alignment

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `skill-refresh` |
| **Date** | 2026-03-14 |
| **Design** | [DRAFT.md](../../brainstorms/skill-refactor-portability/DRAFT.md) |

## Summary

Refresh all 13 genie skills and rewrite the orchestration rules to reflect the current CLI commands, the three-layer architecture (dispatch commands → skills → orchestration rules), and the full delivery lifecycle (planning → execution → PR → QA loop). Kill `/onboarding`. Inline all reference file dependencies. Add auto-invocation triggers between skills.

## Scope

### IN

- Rewrite `genie-orchestration.md` content (in `smart-install.js` + `install.sh`) with current commands, skill flow, team management, and full lifecycle
- Kill `/onboarding` — delete `skills/onboarding/` directory
- Update `/brainstorm` — remove dead command, auto-`/review` at crystallize, `/council` suggestion
- Update `/wish` — auto-`/review`, fuzzy detection → auto `/brainstorm`, fix step 7, gate check design review
- Update `/work` — clarify as implementor skill, local `/review` per group, `genie done` signaling
- Update `/review` — SHIP next-step per context, auto-`/fix` on FIX-FIRST
- Update `/council` — auto-invocation triggers, `genie team hire council` docs, timeout for full spawn
- Update `/trace` — `genie send` for reporting back, auto-invocation by `/review`
- Update `/report` — `agent-browser` as dependency, wish criteria linking in QA
- Update `/docs` — doc types, CLAUDE.md as first-class surface, post-work suggestion
- Rewrite `/learn` — diagnose any behavioral surface, connect to Claude native memory, remove BOOTSTRAP.md ref
- Update `/refine` — inline `prompt-optimizer.md` content into SKILL.md
- Update `/brain` — auto-install notesmd-cli offer, brain vs memory distinction
- Update `/dream` — full lifecycle (execute via `genie work` dispatch → PR → merge to dev → QA loop), remove stale refs
- Inline all `references/` content into SKILL.md files (brainstorm, wish, refine)

### OUT

- Changes to genie CLI commands or source code (skills only)
- Changes to `smart-install.js` or `install.sh` beyond the orchestration prompt string
- New skills
- Changes to built-in agent definitions (`plugins/genie/agents/`)
- `agent-browser` installation/integration (just document as dependency)
- `notesmd-cli` code changes (just add install guidance)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Kill onboarding | `smart-install.js` handles setup. The wizard adds friction. |
| Inline reference files | npm installs can't find `references/` — skills must be self-contained |
| Three-layer architecture | Clear separation: CLI dispatch (verbs) → Skills (agent prompts) → Orchestration rules (leader playbook) |
| `/learn` rewrite | Must diagnose ANY behavioral surface, not just CLAUDE.md. Connected to Claude native memory. |
| Brain ≠ Memory | Brain = context graph (entities, relationships, domain). Memory = behavioral learnings (feedback, decisions). Different tools, different purposes. |
| Auto-invocation over manual handoff | Skills should trigger next steps automatically where possible, suggest when human decision needed |

## Success Criteria

- [ ] `genie-orchestration.md` content has current CLI commands (no `genie agent spawn`, no `genie team ensure`)
- [ ] `genie-orchestration.md` documents the full lifecycle (planning → execution → PR → QA loop)
- [ ] `genie-orchestration.md` documents skill auto-invocation chain
- [ ] `skills/onboarding/` directory deleted
- [ ] No skill references `genie agent spawn`, `genie worker`, `genie brainstorm crystallize`, `Status: SHIPPED`, or `BOOTSTRAP.md`
- [ ] No skill references external `references/` files — all content inlined
- [ ] `/brainstorm` auto-invokes `/review` at WRS=100
- [ ] `/wish` auto-detects fuzzy requests and triggers `/brainstorm`
- [ ] `/work` documents `genie done` signaling and local `/review` per group
- [ ] `/learn` lists all behavioral surfaces (CLAUDE.md, AGENTS.md, rules/, memory, hooks, etc.)
- [ ] `/brain` includes notesmd-cli auto-install offer with repo link
- [ ] `/brain` clarifies brain (context graph) vs memory (behavioral learnings) distinction
- [ ] `/dream` follows full lifecycle: `genie work` dispatch → PR → merge to dev → QA loop
- [ ] `smart-install.js` line 243 updated with new orchestration prompt
- [ ] `install.sh` orchestration prompt updated to match
- [ ] All existing tests pass (`bun run check`)

## Execution Groups

### Group 1: Orchestration Rules Rewrite

**Goal:** Rewrite the `genie-orchestration.md` content with current commands, skill flow, team lifecycle, and full delivery lifecycle.

**Deliverables:**
1. Write the new orchestration prompt content covering:
   - Section 1: CLI commands reference (spawn, kill, stop, ls, team, send, broadcast, chat, done, status, reset, dir, update)
   - Section 2: Skill flow and auto-invocation chain (brainstorm → review → wish → review → work → review/fix → PR → QA)
   - Section 3: Team management lifecycle (create → hire → execute → PR → merge → QA → disband)
   - Section 4: Rules (no native tools, role separation, critical PR review, CI green, dev merge allowed)
2. Update `ORCHESTRATION_PROMPT` string constant in `plugins/genie/scripts/smart-install.js` (line 243)
3. Update the matching content in `install.sh` (line 655)
4. Verify: re-run smart-install or manually write to `~/.claude/rules/genie-orchestration.md` and confirm content

**Acceptance criteria:**
- No references to `genie agent spawn`, `genie team ensure`, `genie agent dashboard`, or any removed command
- Full lifecycle documented (planning through QA loop)
- Skill auto-invocation chain documented
- Both `smart-install.js` and `install.sh` have identical content

**Validation:**
```bash
grep -c 'genie agent spawn\|genie team ensure\|genie agent dashboard' plugins/genie/scripts/smart-install.js && echo "FAIL" || echo "PASS"
grep -c 'genie agent spawn\|genie team ensure\|genie agent dashboard' install.sh && echo "FAIL" || echo "PASS"
```

**depends-on:** none

---

### Group 2: Kill Onboarding + Inline References

**Goal:** Remove onboarding skill and inline all external reference file content into SKILL.md files.

**Deliverables:**
1. Delete `skills/onboarding/` directory entirely
2. Read `references/prompt-optimizer.md` and inline its content into `skills/refine/SKILL.md`
3. Read `references/design-template.md` and inline its content into `skills/brainstorm/SKILL.md`
4. Read `references/wish-template.md` and inline its content into `skills/wish/SKILL.md`
5. Remove references to external files in all three SKILL.md files

**Acceptance criteria:**
- `skills/onboarding/` does not exist
- No SKILL.md contains `references/` file paths
- `/refine`, `/brainstorm`, `/wish` SKILL.md files contain the inlined content
- All template/reference content preserved (not lost)

**Validation:**
```bash
test -d skills/onboarding && echo "FAIL: onboarding exists" || echo "PASS"
grep -rn 'references/' skills/*/SKILL.md && echo "FAIL: external refs" || echo "PASS"
```

**depends-on:** none

---

### Group 3: Core Chain Skills (brainstorm, wish, work, review)

**Goal:** Update the four core chain skills with auto-invocation, state tracking, and correct flow.

**Deliverables:**
1. Update `skills/brainstorm/SKILL.md`:
   - Remove `genie brainstorm crystallize` reference
   - At WRS=100: "Auto-invoke `/review` (plan review) on the DESIGN.md"
   - Add: "If Decisions dimension stays ░ after 2+ exchanges, suggest `/council`"
   - Trivial ideas: still add one-liner to jar
2. Update `skills/wish/SKILL.md`:
   - Step 1 gate check: if request is fuzzy (no design, unclear scope), auto-trigger `/brainstorm` first
   - Step 7: change "link tasks" to "declare `depends-on` between execution groups"
   - Handoff: auto-invoke `/review` (plan review) instead of suggesting `/work`
   - Remove `references/wish-template.md` ref (inlined in Group 2)
3. Update `skills/work/SKILL.md`:
   - Clarify: this is the implementor's skill, invoked via `genie work` dispatch
   - Add: run local `/review` against wish spec per group before signaling done
   - Add: signal completion to leader via `genie send` when group work is done
   - Clarify: leader uses `genie done` to mark groups complete, not the worker
   - Remove "no state management" confusion — worker signals, leader manages state
4. Update `skills/review/SKILL.md`:
   - Add SHIP next-step per context: plan review SHIP → proceed to `/wish` or `/work`, execution SHIP → PR, PR SHIP → merge
   - Add: auto-invoke `/fix` on FIX-FIRST verdict
   - Add: invoke `/trace` when failure found with unclear root cause

**Acceptance criteria:**
- `/brainstorm` mentions auto-`/review` at crystallize and `/council` suggestion
- `/wish` detects fuzzy requests and suggests `/brainstorm`
- `/work` documents local `/review` and `genie send` signaling
- `/review` documents SHIP next-steps and auto-`/fix`
- No stale command references in any of the four skills

**Validation:**
```bash
grep -c 'genie brainstorm crystallize' skills/brainstorm/SKILL.md && echo "FAIL" || echo "PASS"
grep -c '/review' skills/brainstorm/SKILL.md | xargs test 0 -lt && echo "PASS: review mentioned" || echo "FAIL"
grep -c '/brainstorm' skills/wish/SKILL.md | xargs test 0 -lt && echo "PASS: brainstorm mentioned" || echo "FAIL"
grep -c 'genie send\|genie done' skills/work/SKILL.md | xargs test 0 -lt && echo "PASS: state cmds" || echo "FAIL"
```

**depends-on:** Group 2 (for inlined references in wish)

---

### Group 4: Support Skills (council, trace, report, docs, refine)

**Goal:** Update five support skills with auto-invocation triggers, dependency docs, and fixes.

**Deliverables:**
1. Update `skills/council/SKILL.md`:
   - Add auto-invocation triggers: during `/review` for architecture decisions, during `/brainstorm` when Decisions stuck
   - Document `genie team hire council` as setup for full spawn mode
   - Add timeout guidance for full spawn: if member hasn't responded, proceed with "no response"
   - Clarify: lightweight = one agent simulates all perspectives, full spawn = real agents deliberate via `genie chat` reaching consensus
2. Update `skills/trace/SKILL.md`:
   - Add: tracer signals findings to leader via `genie send`
   - Clarify: spawned agent IS the tracer (read-only inline investigation)
   - Add: `/review` can invoke `/trace` when root cause unclear
3. Update `skills/report/SKILL.md`:
   - Document `agent-browser` as a genie dependency for browser-based QA/validation
   - Add: when invoked during QA loop, link findings to wish acceptance criteria
   - Add: QA failures with unclear root cause → `/report` → `/trace` → `/fix`
4. Update `skills/docs/SKILL.md`:
   - Add doc types to audit: README, CLAUDE.md, API docs, architecture, inline JSDoc
   - CLAUDE.md is a first-class documentation surface
   - Add: after `/work` completes, suggest `/docs` to document changes
   - Flag CLAUDE.md when codebase changes significantly
5. Update `skills/refine/SKILL.md`:
   - Content already inlined from Group 2
   - Remove all `references/prompt-optimizer.md` path references
   - Verify the inlined content works as the subagent contract

**Acceptance criteria:**
- `/council` documents both modes clearly and auto-invocation triggers
- `/trace` mentions `genie send` for reporting back
- `/report` lists `agent-browser` as dependency
- `/docs` mentions CLAUDE.md as auditable surface
- `/refine` has no external reference file paths

**Validation:**
```bash
grep -c 'genie team hire council' skills/council/SKILL.md | xargs test 0 -lt && echo "PASS" || echo "FAIL"
grep -c 'genie send' skills/trace/SKILL.md | xargs test 0 -lt && echo "PASS" || echo "FAIL"
grep -c 'agent-browser' skills/report/SKILL.md | xargs test 0 -lt && echo "PASS" || echo "FAIL"
grep -c 'CLAUDE.md' skills/docs/SKILL.md | xargs test 0 -lt && echo "PASS" || echo "FAIL"
grep -c 'references/' skills/refine/SKILL.md && echo "FAIL" || echo "PASS"
```

**depends-on:** Group 2 (for inlined refine content)

---

### Group 5: Learn + Brain Rewrite

**Goal:** Rewrite `/learn` to diagnose any behavioral surface. Update `/brain` with auto-install and distinction from memory.

**Deliverables:**
1. Rewrite `skills/learn/SKILL.md`:
   - Primary trigger: user corrects a mistake → `/learn` diagnoses what behavioral surface to fix
   - Writable surfaces (the skill diagnoses which one):
     - `CLAUDE.md` — project conventions, commands, gotchas
     - `AGENTS.md` — agent identity, role, preferences
     - `SOUL.md` / `IDENTITY.md` — agent personality
     - `~/.claude/rules/` — global rules
     - `.claude/memory/` — Claude native memory (feedback, user, project memories)
     - `.claude/settings.json` — hooks, permissions
     - `memory/` — project-scoped memory files
     - Any config file shaping behavior
   - Remove `BOOTSTRAP.md` reference entirely
   - Connect to Claude native memory: save learnings as feedback memories
   - Flow: analyze mistake → determine root cause → propose minimal change to correct surface → apply with approval
2. Update `skills/brain/SKILL.md`:
   - Add brain vs memory distinction at top:
     - Brain = context graph (entities, relationships, domain knowledge via notesmd-cli)
     - Memory = behavioral learnings (feedback, decisions via Claude native memory)
   - Add auto-install: detect if `notesmd-cli` on PATH, if not offer to install from https://github.com/Yakitrak/notesmd-cli (read repo README for install method)
   - Remove provisioning template overlap with `/learn`

**Acceptance criteria:**
- `/learn` lists all behavioral surfaces (not just CLAUDE.md)
- `/learn` mentions Claude native memory connection
- `/learn` does not reference BOOTSTRAP.md
- `/brain` has brain vs memory distinction
- `/brain` has notesmd-cli auto-install with repo link

**Validation:**
```bash
grep -c 'BOOTSTRAP' skills/learn/SKILL.md && echo "FAIL: bootstrap ref" || echo "PASS"
grep -c 'AGENTS.md\|rules/\|memory' skills/learn/SKILL.md | xargs test 2 -lt && echo "PASS: surfaces listed" || echo "FAIL"
grep -c 'notesmd-cli.*install\|Yakitrak' skills/brain/SKILL.md | xargs test 0 -lt && echo "PASS: auto-install" || echo "FAIL"
grep -c 'context graph\|memory.*behavioral\|brain.*memory' skills/brain/SKILL.md | xargs test 0 -lt && echo "PASS: distinction" || echo "FAIL"
```

**depends-on:** none

---

### Group 6: Dream Lifecycle Update

**Goal:** Align `/dream` with the full delivery lifecycle: dispatch via `genie work`, PR management, merge to dev, QA loop.

**Deliverables:**
1. Rewrite `skills/dream/SKILL.md`:
   - Phase 1 (Execute): use `genie work <agent> <slug>#<group>` dispatch per group per wish — gets state tracking for free. Leader monitors via `genie status`, marks done via `genie done`. Parallel groups dispatched simultaneously.
   - Phase 2 (Review + PR): leader creates PR to dev after all groups done. Read bot comments critically (don't blindly accept). `/fix` for valid issues. CI must be green.
   - Phase 3 (Merge + QA): merge to dev. Spawn tester on dev branch. QA loop: test against wish criteria → `/fix` → test until all criteria proven. Each fix = new PR to dev.
   - Phase 4 (Report): DREAM-REPORT.md with per-wish status (completed/merged/QA-verified/blocked)
   - Remove stale `Status: SHIPPED` reference
   - Remove `sleep 5` in CI retry — poll CI status instead
   - Add `genie reset` for overnight stuck group recovery
   - Team lifecycle: create dream team → execute → review → merge → QA → disband

**Acceptance criteria:**
- Dream uses `genie work` dispatch (not raw spawn for group execution)
- Dream includes QA loop on dev after merge
- No `Status: SHIPPED` or `sleep 5` references
- DREAM-REPORT.md includes QA verification status per wish
- `genie done`, `genie status`, `genie reset` mentioned

**Validation:**
```bash
grep -c 'Status.*SHIPPED\|sleep 5' skills/dream/SKILL.md && echo "FAIL: stale refs" || echo "PASS"
grep -c 'genie work\|genie done\|genie status' skills/dream/SKILL.md | xargs test 2 -lt && echo "PASS: state cmds" || echo "FAIL"
grep -c 'QA\|qa\|tester' skills/dream/SKILL.md | xargs test 0 -lt && echo "PASS: QA loop" || echo "FAIL"
```

**depends-on:** Group 1 (orchestration rules define the lifecycle dream follows)

---

### Group 7: Validation

**Goal:** All skills updated, orchestration rules current, no stale references, quality gates pass.

**Deliverables:**
1. Run full stale reference scan across all skills
2. Verify orchestration rules in `smart-install.js` and `install.sh` match
3. `bun run check` passes
4. `bun run build` succeeds

**Acceptance criteria:**
- Zero stale refs across all skills: no `genie agent spawn`, `genie worker`, `genie brainstorm crystallize`, `Status: SHIPPED`, `BOOTSTRAP.md`, `references/` paths
- `smart-install.js` and `install.sh` orchestration prompts identical
- `skills/onboarding/` does not exist
- `bun run check` exits 0
- `bun run build` succeeds

**Validation:**
```bash
grep -rn 'genie agent spawn\|genie worker\|genie brainstorm crystallize\|Status.*SHIPPED\|BOOTSTRAP\|references/' skills/ --include='*.md' && echo "FAIL" || echo "PASS"
test -d skills/onboarding && echo "FAIL" || echo "PASS"
bun run check
bun run build
```

**depends-on:** Group 1, Group 2, Group 3, Group 4, Group 5, Group 6

---

## Dependency Graph

```
Group 1 (Orchestration Rules)    Group 2 (Kill Onboarding + Inline Refs)    Group 5 (Learn + Brain)
         │                              │                                        │
         │                    ┌─────────┤                                        │
         │                    │         │                                        │
         │              Group 3 (Core Chain)    Group 4 (Support Skills)         │
         │                    │                      │                           │
         ├──── Group 6 (Dream)│                      │                           │
         │                    │                      │                           │
         └────────────────────┴──────────────────────┴───────────────────────────┘
                                              │
                                     Group 7 (Validation)
```

Parallelizable: Groups 1, 2, and 5 can all start simultaneously.
Groups 3 + 4 start once Group 2 is done (inlined references).
Group 6 starts once Group 1 is done (lifecycle rules).
Group 7 starts once all others are done.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Inlined reference files make SKILL.md very long | Low | Templates are short (< 50 lines each). Acceptable. |
| Orchestration rules too long for Claude context | Medium | Keep concise. Current stale version is 70 lines. Target ~120 lines max. |
| Auto-invocation creates unexpected loops | Low | Each auto-invocation is documented with clear trigger conditions. `/fix` already has max 2 loop guard. |
| `install.sh` and `smart-install.js` drift | Medium | Validation step checks they match. Could extract to shared file in future. |
| Killing onboarding breaks first-run experience | Low | `smart-install.js` SessionStart hook handles dir creation, hook injection, tmux validation. |
