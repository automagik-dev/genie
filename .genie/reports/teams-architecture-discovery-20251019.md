# Teams Architecture Discovery - 2025-10-19

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Discovery Session:** User task #7057 - "Learn: Document Teams Architecture"
**Status:** 🎯 Documented - Ready for implementation

---

## 📋 Executive Summary

Discovered and documented a new architectural entity type: **Teams**. Teams are advisory/consulting collectives that analyze and recommend but do not execute code. This introduces a third dimension to the Genie architecture alongside Code and Create collectives.

**Key Innovation:** Teams enable multi-persona consultation without execution overhead, combining expert perspectives for architectural and strategic decisions.

---

## 🎯 What Teams Are

### Core Definition

**Teams** are advisory collectives composed of multiple personas that:
- **Analyze** codebases, architectures, and proposals
- **Recommend** changes, patterns, and decisions
- **Never execute** - read-only + write to their own folder only
- **Provide consensus** through voting/approval mechanisms

### Distinction from Other Entities

| Entity Type | Execute Code | Write Files | Multi-Persona | Advisory |
|-------------|--------------|-------------|---------------|----------|
| **Agents** | ✅ Yes | ✅ Yes | ❌ No | ❌ No |
| **Collectives** | ✅ Yes (via agents) | ✅ Yes | ✅ Yes | ❌ No |
| **Teams** | ❌ No | ⚠️ Own folder only | ✅ Yes | ✅ Yes |
| **Workflows** | ✅ Yes | ✅ Yes | ❌ No | ❌ No |

---

## 🏗️ First Implementation: Tech Council

### Concept

A **Board of Technology** pattern combining three expert personas inspired by real-world TypeScript/Node.js leaders:

**Personas:**
1. **nayr** (Ryan Dahl inspiration) - Questions assumptions, challenges status quo
2. **oettam** (Matteo Collina inspiration) - Demands benchmarks, performance-focused
3. **jt** (TJ Holowaychuk inspiration) - Terse, opinionated, simplicity-focused

### Voting Mechanism

**2/3 Approval Required** for major architectural changes:
- Refactors
- Technology replacements
- Architecture redesigns
- Performance optimization strategies

### Storage Location

```
.genie/teams/tech-council/
├── council.md           # Main orchestrator (routes to personas)
├── nayr.md              # Ryan Dahl persona
├── oettam.md            # Matteo Collina persona
├── jt.md                # TJ Holowaychuk persona
├── evidence/            # Decision records
└── reports/             # Consultation outcomes
```

---

## 🔧 Permissions & Capabilities

### What Teams CAN Do

✅ **Read entire codebase** - Full visibility for analysis
✅ **Use all skills** - Access to evidence-based thinking, routing, etc.
✅ **Write to own folder** - Evidence, reports, recommendations
✅ **Multi-turn consultation** - Resume sessions for clarification
✅ **Consensus building** - Vote on proposals

### What Teams CANNOT Do

❌ **Execute code changes** - No Edit/Write to codebase
❌ **Create branches** - No git operations
❌ **Run tests** - No execution environment access
❌ **Deploy/publish** - No release operations
❌ **Delegate to agents** - Advisory only, not orchestrators

---

## 🚀 Integration Points

### Routing Triggers

**Keywords that should invoke tech-council:**
- "refactor"
- "replace [technology]"
- "redesign"
- "architecture"
- "should we use [X] or [Y]"
- "performance optimization"
- "technology choice"

### Workflow Pattern

```
User request (architectural)
  ↓
Base Genie recognizes trigger
  ↓
Invoke tech-council team
  ↓
Council routes to 3 personas in parallel
  ↓
Personas analyze + vote
  ↓
Council synthesizes recommendation
  ↓
Base Genie presents to user
  ↓
If approved → delegate to implementor
```

### Evidence Storage

All team consultations stored in `.genie/teams/[team-name]/evidence/`:
- Consultation prompts
- Individual persona responses
- Voting records
- Final recommendations
- User decisions

---

## 📂 Folder Structure Implications

### Current Confusion (Pre-Teams)

```
.genie/agents/
├── code/                    # Why "code" here?
│   ├── agents/             # Mixed with skills below
│   └── skills/              # Mixed with agents above
├── agents/                 # Wait, agents here too?
└── workflows/               # How is this different from agents?
```

**User confusion:**
- "Agent" vs "Agent" vs "Workflow" unclear
- Why is "code" a subfolder of "agents"?
- Agents appear in two places
- Skills buried under code/

### Proposed Simplification Options

**Option A: Collectives as Containers**
```
.genie/
├── collectives/
│   ├── code/                # Code collective
│   │   ├── agents/         # implementor, tests, etc.
│   │   └── workflows/       # Deterministic sequences
│   ├── create/              # Create collective
│   │   ├── agents/
│   │   └── workflows/
│   └── nl/                  # Natural language collective
│       ├── agents/
│       └── workflows/
├── teams/                   # Advisory teams
│   └── tech-council/
│       ├── council.md
│       ├── nayr.md
│       ├── oettam.md
│       └── jt.md
└── skills/                  # Master skills (Genie-level)
    ├── universal/           # All collectives
    └── [collective]/        # Collective-specific
```

**Option B: Flatter Separation**
```
.genie/
├── agents/                 # All execution agents
│   ├── code/                # Code-focused
│   ├── create/              # Create-focused
│   └── nl/                  # NL-focused
├── workflows/               # All deterministic sequences
│   ├── code/
│   ├── create/
│   └── nl/
├── teams/                   # Advisory teams
│   └── tech-council/
└── skills/                  # All behavioral skills
    ├── universal/
    └── [domain]/
```

**Decision needed:** Felipe to choose structure (awaiting input)

---

## 🧩 Terminology Clarification

### What Each Term Means

**Agent:** Generic term for any autonomous unit (agents, workflows, teams)
**Agent:** Execution specialist (implementor, tests, release, etc.)
**Workflow:** Deterministic sequence prompt (NOT an agent, no decision-making)
**Team:** Advisory collective (multi-persona, consensus-driven, read-only execution)
**Collective:** Coordinated group of agents (code, create, nl)
**Skill:** Behavioral capability (universal or domain-specific)

### Hierarchy

```
Genie (main conversation)
├── Collectives (code, create, nl)
│   ├── Agents (execution specialists)
│   └── Workflows (deterministic sequences)
└── Teams (advisory consultants)
    └── Personas (individual expert voices)
```

---

## 📊 Implementation Roadmap

### Phase 1: Foundation (This Session)
- [x] Document teams architecture
- [ ] Create tech-council team files
- [ ] Create team-consultation skill
- [ ] Update routing-decision-matrix.md

### Phase 2: Integration
- [ ] Add triggers to routing protocols
- [ ] Test tech-council with real architectural questions
- [ ] Validate voting mechanism
- [ ] Collect evidence of consultations

### Phase 3: Expansion
- [ ] Define additional teams (security-council, ux-council, etc.)
- [ ] Create team creation workflow
- [ ] Standardize persona definition pattern
- [ ] Document team best practices

---

## 🔍 Open Questions

### Architectural Decisions Needed

1. **Folder structure:** Option A (collectives as containers) vs Option B (flatter)?
2. **Collective terminology:** Keep "collectives" or use something else?
3. **Workflow placement:** Under collectives or separate?
4. **Skills organization:** Universal vs domain-specific split?

### Implementation Details

1. **Team invocation:** MCP tool vs routing pattern?
2. **Voting mechanism:** Strict 2/3 or configurable per team?
3. **Evidence format:** Structured JSON vs markdown reports?
4. **Resume capability:** Can users resume team consultations like agents?

---

## 🎯 Success Criteria

**Teams architecture is successful when:**
- ✅ Clear distinction from agents/collectives/workflows
- ✅ Tech-council provides actionable architectural recommendations
- ✅ Voting mechanism enforces consensus
- ✅ Evidence trail shows decision rationale
- ✅ Users understand when to invoke teams vs agents
- ✅ Folder structure is intuitive to external users

---

## 📚 Related Documentation

**Skills to reference:**
- `@.genie/skills/routing-decision-matrix.md` - Add team triggers
- `@.genie/skills/evidence-based-thinking.md` - Team decision framework
- `@.genie/skills/know-yourself.md` - Update with teams awareness

**Files to update:**
- `AGENTS.md` - Add teams to neural graph
- `SESSION-STATE.md` - Track team consultation sessions
- `.genie/docs/mcp-interface.md` - Document team MCP tools (if needed)

---

## 💡 Key Insights

### Why Teams Matter

1. **Separation of concerns:** Advisory vs execution clearly separated
2. **Multi-perspective analysis:** Three voices > one voice
3. **Consensus mechanism:** Reduces bias, enforces rigor
4. **Evidence trail:** Architectural decisions documented
5. **Scalability:** Can add more teams for different domains

### Comparison to Existing Patterns

**Genie agent (challenge mode):**
- Single adversarial voice
- Pressure-tests decisions
- Quick iterations

**Tech-council team:**
- Three complementary voices
- Builds consensus
- Deeper analysis

**Use both:** Challenge mode for rapid iteration, tech-council for major decisions

---

**Status:** Documentation complete, ready for implementation. Awaiting folder structure decision from Felipe before creating team files.
