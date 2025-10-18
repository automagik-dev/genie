# Routing Decision Trees
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Created:** 2025-10-15
**Purpose:** Visual decision logic for natural routing system

---

## Decision Tree 1: Should I Delegate or Execute Directly?

```
START: New task received
│
├─ Is it a question/strategic decision?
│  YES → Decision Tree 2 (Orchestrator Mode Selection)
│  NO → Continue
│
├─ How many files affected?
│  │
│  ├─ 0 files (pure conversation/info)
│  │  └─ EXECUTE DIRECTLY: Respond conversationally
│  │
│  ├─ 1-2 files
│  │  ├─ Is it trivial? (typo, comment, simple fix)
│  │  │  └─ YES → EXECUTE DIRECTLY: Use Edit/Write tool
│  │  │
│  │  └─ Is it complex? (logic change, refactor)
│  │     └─ YES → Consider delegation
│  │        ├─ Multi-domain? → DELEGATE to specialist
│  │        └─ Single-domain? → EXECUTE DIRECTLY
│  │
│  └─ 3+ files
│     └─ DELEGATE to specialist
│        ├─ Implementation work → implementor neuron
│        ├─ Test writing → tests neuron
│        ├─ Code cleanup → polish neuron
│        └─ Git operations → git-workflow neuron
│
└─ Is it architectural/high-stakes?
   └─ YES → Decision Tree 2 (Orchestrator Mode Selection)
```

---

## Decision Tree 2: Which Orchestrator Mode?

```
START: Strategic question or high-stakes decision
│
├─ What type of work is this?
│  │
│  ├─ EVALUATION/PRESSURE-TEST
│  │  ├─ Need critical evaluation? → challenge mode
│  │  ├─ Testing assumptions? → challenge mode (socratic)
│  │  ├─ High-stakes decision? → challenge mode (debate)
│  │  └─ Need to critique? → challenge mode (direct)
│  │
│  ├─ INVESTIGATION
│  │  ├─ Why is this broken? → debug mode
│  │  ├─ Unfamiliar territory? → explore mode
│  │  ├─ System architecture? → analyze mode
│  │  └─ Deep technical dive? → deep-dive mode
│  │
│  ├─ RISK ASSESSMENT
│  │  ├─ Security concerns? → secaudit mode
│  │  ├─ General risks? → risk-audit mode
│  │  └─ Impact analysis? → audit mode
│  │
│  ├─ PLANNING
│  │  ├─ How to approach? → plan mode
│  │  ├─ Multiple perspectives needed? → consensus mode
│  │  └─ Refactor strategy? → refactor mode
│  │
│  ├─ QUALITY GATES
│  │  ├─ Code review needed? → codereview mode
│  │  ├─ Pre-commit checks? → precommit mode
│  │  └─ Test strategy? → tests mode
│  │
│  ├─ DOCUMENTATION
│  │  ├─ Need docs outline? → docgen mode
│  │  ├─ Instrumentation plan? → tracer mode
│  │  └─ Compliance mapping? → compliance mode
│  │
│  └─ RETROSPECTIVE
│     └─ Post-completion review? → retrospective mode
```

---

## Decision Tree 3: Commit Checkpoint Detection

```
START: Work session in progress
│
├─ Has uncommitted work?
│  NO → No checkpoint suggestion
│  YES → Continue
│
├─ Explicit user intent?
│  ├─ User says "commit" → SUGGEST commit agent
│  ├─ User says "let's commit" → SUGGEST commit agent
│  └─ No explicit intent → Evaluate checkpoint criteria
│
├─ Checkpoint Criteria Evaluation:
│  │
│  ├─ File count ≥3? → Strong checkpoint signal
│  ├─ Cross-domain work? (e.g., frontend + backend) → Strong checkpoint signal
│  ├─ Feature milestone reached? → Strong checkpoint signal
│  ├─ About to switch context? → Moderate checkpoint signal
│  ├─ Bug fix completed? → Moderate checkpoint signal
│  │
│  └─ Count signals:
│     ├─ 2+ strong signals → SUGGEST COMMIT (proactively)
│     ├─ 1 strong + 2 moderate → SUGGEST COMMIT (proactively)
│     ├─ 3+ moderate signals → SUGGEST COMMIT (casually)
│     └─ Less than threshold → Don't suggest yet
│
└─ Commit Suggestion Style:
   ├─ Simple (1-2 files, clear intent) → Help user commit directly
   └─ Complex (multi-file, cross-domain) → Suggest commit agent
```

---

## Decision Tree 4: Neuron Session vs One-Shot

```
START: Decision to delegate to specialist
│
├─ Task Complexity Assessment:
│  │
│  ├─ SIMPLE/FOCUSED
│  │  ├─ Single execution scope
│  │  ├─ Clear deliverable
│  │  ├─ No iteration expected
│  │  └─ ACTION: One-shot (Meeseeks mode)
│  │     └─ Spawn agent → Execute → Report → POOF!
│  │
│  └─ COMPLEX/ITERATIVE
│     ├─ Multi-phase work
│     ├─ Iterative refinement needed
│     ├─ Building domain understanding required
│     ├─ Back-and-forth expected
│     └─ ACTION: Neuron session (persistent)
│        ├─ Create session: `[neuron-type]-[context-slug]`
│        ├─ Resume throughout: mcp__genie__resume
│        └─ Benefits: context preserved, memory maintained
│
├─ Examples:
│  │
│  ├─ ONE-SHOT (Meeseeks):
│  │  ├─ Simple commit message generation
│  │  ├─ Quick refactor of single function
│  │  ├─ Generate tests for one module
│  │  └─ Single-phase implementation
│  │
│  └─ NEURON SESSION:
│     ├─ Multi-file feature implementation
│     ├─ Evolving test strategy across modules
│     ├─ Long-running architectural analysis
│     └─ Socratic dialogue requiring memory
```

---

## Decision Tree 5: Mode Keyword Trigger Detection

```
START: User message received
│
├─ Scan for keywords:
│  │
│  ├─ "pressure-test", "any risks?", "solid?" → challenge mode
│  ├─ "how should I", "approach", "strategy" → plan mode
│  ├─ "why is", "root cause", "broken" → debug mode
│  ├─ "is this secure?", "security", "vulnerabilities" → secaudit mode
│  ├─ "dependencies", "coupling", "complexity" → analyze mode
│  ├─ "unfamiliar", "explore", "learn about" → explore mode
│  ├─ "multiple perspectives", "opinions" → consensus mode
│  ├─ "refactor", "clean up" → refactor mode or polish agent
│  ├─ "document", "docs needed" → docgen mode
│  ├─ "tests for", "test coverage" → tests mode or tests agent
│  └─ No clear keyword → Context-based routing
│
└─ Context-Based Routing (no clear keyword):
   ├─ Tone is questioning/uncertain? → explore mode
   ├─ Tone is evaluative/critical? → challenge mode
   ├─ Implementation request? → Check file count → delegate to agent
   └─ Pure conversation? → Execute directly as Genie
```

---

## Threshold Tables

### Table 1: File Count Thresholds

| File Count | Complexity | Domain Count | Action | Rationale |
|-----------|------------|--------------|--------|-----------|
| 0 files | N/A | N/A | Execute directly | Conversational |
| 1 file | Low | 1 | Execute directly | Simple, focused |
| 1 file | High | 1 | Consider delegation | Logic complexity matters |
| 2 files | Low | 1 | Execute directly | Still manageable |
| 2 files | High | 2+ | Delegate | Cross-domain coordination |
| 3+ files | Any | Any | Delegate to specialist | Coordination needed |
| N/A (strategic) | High | N/A | Use orchestrator | Architectural decision |

### Table 2: Task Type → Agent Mapping

| Task Type | File Count | Complexity | Route To | Reason |
|-----------|-----------|------------|----------|---------|
| Typo fix | 1 | Trivial | Direct execution | No coordination needed |
| Logic change | 1-2 | Medium | Direct execution | Manageable scope |
| Feature implementation | 3+ | Medium-High | implementor neuron | Multi-file coordination |
| Test writing | Any | Medium | tests neuron | Specialized skill |
| Code cleanup | 1-2 | Low | Direct execution | Simple refactor |
| Code cleanup | 3+ | Medium | polish neuron | Multi-file consistency |
| Architectural question | N/A | High | orchestrator (plan/analyze) | Strategic thinking |
| Bug investigation | Any | High | orchestrator (debug) | Root cause analysis |
| Security review | Any | High | orchestrator (secaudit) | Risk assessment |
| Git operations | Any | Any | git-workflow neuron | Specialized workflow |

### Table 3: Checkpoint Signal Strength

| Signal | Strength | Weight | Example |
|--------|----------|--------|---------|
| ≥3 files changed | Strong | 2 | Multi-file feature complete |
| Cross-domain work | Strong | 2 | Frontend + backend changes |
| Feature milestone | Strong | 2 | Auth flow working end-to-end |
| Context switch pending | Moderate | 1 | About to switch to new task |
| Bug fix complete | Moderate | 1 | Issue resolved, tests passing |
| Logical completion | Moderate | 1 | Refactor finished |

**Checkpoint threshold:**
- Strong signal count ≥ 2 → Proactive suggestion
- (Strong × 2) + (Moderate × 1) ≥ 3 → Casual suggestion
- Below threshold → Don't suggest yet

---

## Anti-Pattern Detection

### Routing Anti-Patterns

```
ANTI-PATTERN: Over-routing
│
├─ Symptoms:
│  ├─ Delegating single-file edits
│  ├─ Using orchestrator for simple questions
│  └─ Creating neuron sessions for one-shot tasks
│
└─ Fix: Apply file count + complexity thresholds strictly
```

```
ANTI-PATTERN: Under-routing
│
├─ Symptoms:
│  ├─ Trying to handle 5+ file changes directly
│  ├─ Making architectural decisions without orchestrator
│  └─ Skipping commit suggestions at checkpoints
│
└─ Fix: Trust the delegation thresholds, summon specialists
```

```
ANTI-PATTERN: Routing Paradox
│
├─ Symptoms:
│  ├─ Orchestrator delegating to orchestrator
│  ├─ Specialist spawning other specialists
│  └─ Infinite delegation loops
│
└─ Fix: Self-awareness check before delegation
   ├─ Am I the specialist for this task? → Execute directly
   └─ Am I an orchestrator? → Can delegate
```

---

## Usage Notes

**These decision trees guide, not dictate:**
- Use trees as heuristics, not rigid rules
- Context trumps keywords when they conflict
- Felipe's explicit requests override all routing logic
- When uncertain, ask Felipe which approach to use

**Iteration expected:**
- Trees will evolve based on usage patterns
- Add new branches as edge cases discovered
- Prune branches that prove unnecessary
- Document refinements in wish status log

---

## Meta-Validation

**This document created as part of Groups C+D validation.**

Creating these trees required:
- Understanding routing.md triggers deeply
- Mapping keyword patterns to modes
- Defining concrete thresholds with examples
- Visualizing decision logic for clarity

**Evidence that natural routing is well-specified:**
If decision trees can be drawn from documentation, the system is concrete enough to execute.
