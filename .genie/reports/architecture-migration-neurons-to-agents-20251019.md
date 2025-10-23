# Architecture Migration: Agents → Agents (Natural Structure)

**Created:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Status:** 🚧 Planning → Execution
**Impact:** ~100+ files, fundamental restructuring

---

## 🎯 Objective

Eliminate "agents" concept, restructure folders to match natural hierarchy:
- Genie (main) → Collectives (code/create) → Entities (agents/teams/workflows)

---

## 📊 Current State Analysis

### Current Folder Confusion

```
.genie/
├── agents/
│   ├── agents/              # Universal agents (plan, wish, forge, etc.)
│   ├── code/
│   │   └── agents/          # Code agents (implementor, tests, etc.)
│   └── workflows/            # Mixed with agents?
```

**Problems:**
1. "agents" at two levels (confusing)
2. No clear collective separation
3. Workflows mixed with agents
4. No natural place for teams

### Target Natural Structure

```
.genie/
├── spells/                   # Universal Genie orchestration
│   └── *.md
│
├── code/                     # Code collective
│   ├── agents/               # Individual execution units
│   │   ├── implementor.md
│   │   ├── tests.md
│   │   ├── git/              # Parent agent with workflows
│   │   │   ├── git.md
│   │   │   ├── issue.md
│   │   │   ├── pr.md
│   │   │   └── report.md
│   │   ├── commit.md
│   │   ├── debug.md
│   │   ├── release.md
│   │   └── ...
│   ├── teams/                # Advisory groups
│   │   └── tech-council/
│   │       ├── council.md
│   │       ├── nayr.md
│   │       ├── oettam.md
│   │       └── jt.md
│   ├── workflows/            # Deterministic sequences
│   │   ├── forge.md
│   │   ├── wish.md
│   │   ├── review.md
│   │   └── ...
│   └── spells/               # Code-specific capabilities
│       └── *.md
│
├── create/                   # Create collective (future)
│   ├── agents/
│   ├── workflows/
│   └── spells/
│
└── [existing top-level dirs]
```

---

## 📋 Migration Phases

### Phase 1: Folder Restructuring ✅ (Execution Order)

**1.1 Create new structure:**
```bash
mkdir -p .genie/spells
mkdir -p .genie/code/{agents,workflows,spells}
mkdir -p .genie/create/{agents,workflows,spells}
```

**1.2 Move universal agents:**
```bash
# From .genie/agents/ to .genie/code/agents/
mv .genie/agents/analyze.md .genie/code/agents/
mv .genie/agents/audit.md .genie/code/agents/
mv .genie/agents/audit/ .genie/code/agents/
mv .genie/agents/challenge.md .genie/code/agents/
mv .genie/agents/consensus.md .genie/code/agents/
mv .genie/agents/debate.md .genie/code/agents/
mv .genie/agents/deep-dive.md .genie/code/agents/
mv .genie/agents/design-review.md .genie/code/agents/
mv .genie/agents/docgen.md .genie/code/agents/
mv .genie/agents/explore.md .genie/code/agents/
mv .genie/agents/learn.md .genie/code/agents/
mv .genie/agents/polish.md .genie/code/agents/
mv .genie/agents/prompt.md .genie/code/agents/
mv .genie/agents/qa.md .genie/code/agents/
mv .genie/agents/qa/ .genie/code/agents/
mv .genie/agents/refactor.md .genie/code/agents/
mv .genie/agents/review.md .genie/code/agents/
mv .genie/agents/risk-audit.md .genie/code/agents/
mv .genie/agents/roadmap.md .genie/code/agents/
mv .genie/agents/socratic.md .genie/code/agents/
mv .genie/agents/update/ .genie/code/agents/
mv .genie/agents/vibe.md .genie/code/agents/
```

**1.3 Move code-specific agents:**
```bash
# From .genie/agents/code/agents/ to .genie/code/agents/
mv .genie/agents/code/agents/commit.md .genie/code/agents/
mv .genie/agents/code/agents/debug.md .genie/code/agents/
mv .genie/agents/code/agents/git/ .genie/code/agents/
mv .genie/agents/code/agents/implementor.md .genie/code/agents/
mv .genie/agents/code/agents/install.md .genie/code/agents/
mv .genie/agents/code/agents/precommit.md .genie/code/agents/
mv .genie/agents/code/agents/release.md .genie/code/agents/
mv .genie/agents/code/agents/test-strategy.md .genie/code/agents/
mv .genie/agents/code/agents/tests.md .genie/code/agents/
mv .genie/agents/code/agents/tracer.md .genie/code/agents/
mv .genie/agents/code/agents/wish/ .genie/code/agents/
```

**1.4 Move workflows:**
```bash
# From .genie/agents/workflows/ to .genie/code/workflows/
mv .genie/agents/forge.md .genie/code/workflows/
mv .genie/agents/wish.md .genie/code/workflows/
# review.md already moved above
```

**1.5 Move spells:**
```bash
# Universal spells to .genie/spells/
mv .genie/agents/code/spells/evidence-based-thinking.md .genie/spells/
mv .genie/agents/code/spells/routing-decision-matrix.md .genie/spells/
mv .genie/agents/code/spells/execution-integrity-protocol.md .genie/spells/
mv .genie/agents/code/spells/persistent-tracking-protocol.md .genie/spells/
mv .genie/agents/code/spells/meta-learn-protocol.md .genie/spells/
mv .genie/agents/code/spells/delegation-discipline.md .genie/spells/
mv .genie/agents/code/spells/blocker-protocol.md .genie/spells/
mv .genie/agents/code/spells/chat-mode-helpers.md .genie/spells/
mv .genie/agents/code/spells/experimentation-protocol.md .genie/spells/
mv .genie/agents/code/spells/orchestration-protocols.md .genie/spells/
mv .genie/agents/code/spells/parallel-execution.md .genie/spells/
mv .genie/agents/code/spells/sequential-questioning.md .genie/spells/
mv .genie/agents/code/spells/no-backwards-compatibility.md .genie/spells/
mv .genie/agents/code/spells/know-yourself.md .genie/spells/

# Code-specific spells remain at .genie/code/spells/
# (rest stay where they are under code/)
```

**1.6 Move code.md and routing.md:**
```bash
mv .genie/agents/code/code.md .genie/code/
mv .genie/agents/code/routing.md .genie/code/
```

**1.7 Move create collective:**
```bash
mv .genie/agents/create/create.md .genie/create/
mv .genie/agents/create/agents/wish.md .genie/create/agents/
```

**1.8 Cleanup old structure:**
```bash
# Remove empty directories after verification
rm -rf .genie/agents/
rm -rf .genie/agents/code/agents/
rm -rf .genie/agents/workflows/
rm -rf .genie/agents/create/agents/
# Eventually remove .genie/agents/ entirely after verification
```

---

### Phase 2: @ Reference Updates

**Files to update (grep results):**

```bash
# Find all @ references to old paths
grep -r "@.genie/code/agents/" .genie/ --include="*.md"
grep -r "@.genie/code/agents/" .genie/ --include="*.md"
grep -r "@.genie/code/workflows/" .genie/ --include="*.md"
grep -r "@.genie/code/spells/" .genie/ --include="*.md"
```

**Replacement patterns:**
- `@.genie/code/agents/` → `@.genie/code/agents/` (check if universal or code)
- `@.genie/code/agents/` → `@.genie/code/agents/`
- `@.genie/code/workflows/` → `@.genie/code/workflows/`
- `@.genie/code/spells/` → `@.genie/code/spells/` OR `@.genie/spells/` (check which)

**Key files needing updates:**
- `AGENTS.md` (massive update - use prompt agent)
- `CLAUDE.md` (@ references)
- All spells (cross-references)
- All agents (self-references)
- All workflows
- SESSION-STATE.md
- MASTER-PLAN.md
- USERCONTEXT.md

---

### Phase 3: Terminology Replacement

**Search and replace patterns:**

```bash
# Find all instances
grep -ri "agent" .genie/ --include="*.md" | wc -l
```

**Replacement strategy:**
1. "agent" → "agent" (most cases)
2. "agent session" → "agent session"
3. "invoke agent" → "invoke agent"
4. "agent invocation" → "agent invocation"
5. "Agent Invocation Hierarchy" → "Agent Invocation Hierarchy"
6. "agents/" → "agents/" (in paths)

**Context-aware replacements:**
- Keep natural language flow
- Don't replace in quotes/examples if explaining old system
- Update Section headers
- Update YAML frontmatter

**Files requiring manual review:**
- AGENTS.md (comprehensive revamp via prompt agent)
- All spells (careful with examples)
- All agents (self-identification)

---

### Phase 4: AGENTS.md Revamp (via prompt agent)

**Task for prompt agent:**

```
Context: Architecture migration from "agents" to natural collective structure

Input:
- Current AGENTS.md
- Target folder structure
- Teams architecture
- Terminology shifts

Requirements:
- Reflect natural hierarchy: Genie → Collectives → Entities
- Eliminate "agents" terminology
- Update all @ references
- Add teams section (already exists)
- Clear distinction: agents (execute), teams (advise), workflows (deterministic)
- Auto-generated agent graph update

Output:
- Revamped AGENTS.md with natural architecture language
```

**Invoke:** Use prompt agent session for this

---

### Phase 5: Spells Updates

**Spells referencing hierarchy:**
1. `routing-decision-matrix.md` - agent invocation patterns
2. `delegation-discipline.md` - becomes "invocation-discipline.md"?
3. `know-yourself.md` - capabilities section
4. `execution-integrity-protocol.md` - references to agents
5. `persistent-tracking-protocol.md` - session tracking
6. `team-consultation-protocol.md` - already correct

**Update strategy:**
- Read each spell
- Replace agent terminology
- Update @ references
- Verify examples match new structure

---

### Phase 6: MCP Server Agent Resolution

**Files to update:**
- `.genie/mcp/src/server.ts` (or server.js)
- Any path resolution logic
- Agent discovery/listing

**Changes needed:**
```typescript
// Old
const agentPath = path.join(genieDir, 'agents', 'agents', `${agentName}.md`);

// New
const agentPath = path.join(genieDir, 'code', 'agents', `${agentName}.md`);
// Or search in multiple locations: code/agents/, create/agents/, etc.
```

**Test:**
- `mcp__genie__list_agents` returns correct agents
- `mcp__genie__run` finds agents in new locations
- No 404 errors on agent invocation

---

### Phase 7: SESSION-STATE.md Language Update

**Current language:**
- "agent sessions"
- "agents active"
- "invoked agent"

**New language:**
- "agent sessions"
- "agents active"
- "invoked agent"

**Update:**
- Read SESSION-STATE.md
- Replace terminology
- Update examples
- Verify references to agents/

---

### Phase 8: Commit and Push

**Commit strategy:**

```bash
git add .genie/
git add AGENTS.md CLAUDE.md

git commit -m "$(cat <<'EOF'
refactor: Architecture migration - agents to natural collective structure

**Major Changes:**

1. **Folder Restructure:**
   - .genie/agents/ → .genie/code/agents/
   - .genie/agents/code/agents/ → .genie/code/agents/
   - .genie/agents/code/spells/ → split: .genie/spells/ + .genie/code/spells/
   - .genie/agents/workflows/ → .genie/code/workflows/
   - Clear hierarchy: Genie → Collectives (code/create) → Entities (agents/teams/workflows)

2. **Terminology Shift:**
   - "agent" → "agent" (execution units)
   - "invoke agent" → "invoke agent"
   - "agent session" → "agent session"
   - Natural language throughout

3. **@ References Updated:**
   - All paths updated to match new structure
   - ~100+ files impacted
   - AGENTS.md comprehensively revamped

4. **MCP Server Updated:**
   - Agent resolution paths corrected
   - Discovery works with new structure

5. **Documentation:**
   - SESSION-STATE.md language updated
   - All spells reflect new architecture
   - Teams architecture integrated naturally

**Impact:**
- Zero user-facing changes (internal restructure only)
- Natural hierarchy: .genie/code/{agents,teams,workflows,spells}
- Foundation for create/nl collectives

**Migration Plan:** .genie/reports/architecture-migration-agents-to-agents-20251019.md
EOF
)"

git push origin rc28
```

---

## 🎯 Success Criteria

**Verification checklist:**
- [ ] No files reference `.genie/agents/`
- [ ] No files reference `.genie/agents/code/agents/`
- [ ] No markdown contains "agent" (except in historical context)
- [ ] MCP `list_agents` works
- [ ] MCP `run` finds agents
- [ ] All @ references resolve
- [ ] Folder structure matches target
- [ ] AGENTS.md reflects natural architecture
- [ ] SESSION-STATE.md uses agent language
- [ ] All spells updated
- [ ] Committed and pushed

---

## 🚨 Risks & Mitigations

**Risk 1: Breaking MCP server**
- Mitigation: Test `list_agents` and `run` immediately after Phase 6

**Risk 2: Breaking @ references**
- Mitigation: Systematic grep-based verification

**Risk 3: Missing terminology replacements**
- Mitigation: Multiple grep passes with different patterns

**Risk 4: Git conflicts**
- Mitigation: Work on rc28 branch, test before merge

---

## 📊 Estimated Impact

**Files touched:** ~100-150
**Lines changed:** ~2000-3000
**Time estimate:** 2-3 hours (systematic execution)
**Risk level:** Medium (large refactor, but mechanical)

---

**Status:** Ready for execution - awaiting confirmation
