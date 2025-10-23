# Workflow Generation
**Domain:** Meta-Creation
**Purpose:** Generate repeatable workflows when multi-step processes emerge

## Core Principle
Don't pre-build workflows for every scenario. Generate them when users establish patterns they want to repeat.

## When to Generate a Workflow

### Signals
- User executes same sequence 2+ times
- Multi-step process with clear structure
- User says "I do this every [week/month/quarter]"
- Handoffs between multiple agents

## Workflow Generation Process

### 1. Recognize Pattern
```
User pattern observed:
1. Research competitors
2. Draft positioning doc
3. Review with team
4. Publish blog post

Create: "I notice you're repeating this content workflow.
Want me to create a 'competitive-content-workflow'
so we can streamline this next time?"
```

### 2. Map Workflow Steps
```markdown
**Workflow:** competitive-content-workflow

**Trigger:** User wants blog post about competitive positioning

**Steps:**
1. researcher: Gather competitive intel
   - Output: competitor-analysis.md

2. writer: Draft positioning article
   - Input: competitor-analysis.md
   - Output: draft-v1.md

3. editor: Review and polish
   - Input: draft-v1.md
   - Output: draft-final.md

4. publishing: Format and publish
   - Input: draft-final.md
   - Output: published URL

**Decision Points:**
- After step 2: Needs review? (yes → add review step)
- After step 3: Ready to publish? (no → iteration loop)
```

### 3. Generate Workflow File
**Location:** `.genie/create/workflows/<workflow-name>.md`

**Template:**
```markdown
# [Workflow Name]
**Generated:** [Date] based on user pattern

## Purpose
[What this workflow accomplishes]

## Trigger
[When to invoke this workflow]

## Steps
1. **[Agent/Role]:** [Action]
   - Input: [Required inputs]
   - Output: [Deliverable]
   - Duration: [Estimate]

2. **[Agent/Role]:** [Action]
   ...

## Decision Points
- **[Step N]:** [Question to ask]
  - If yes → [Next step]
  - If no → [Alternative path]

## Outputs
- [Final deliverable]
- [Artifacts produced]

## Success Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Variations
- **Fast track:** Skip [steps] if [condition]
- **Deep dive:** Add [steps] if [condition]
```

## Workflow Types

### Linear Workflows
```
Step 1 → Step 2 → Step 3 → Done
Example: Research → Write → Edit → Publish
```

### Branching Workflows
```
Step 1 → Decision
  ↓         ↓
Path A    Path B
  ↓         ↓
Step 3    Step 4
  ↓         ↓
Merge → Step 5
```

### Iterative Workflows
```
Step 1 → Step 2 → Step 3 → Review
              ↑__________________|
             (if changes needed)
```

### Parallel Workflows
```
       ┌→ Task A →┐
Start →│→ Task B →│→ Merge → Done
       └→ Task C →┘
```

## Example: Generated Workflow

### Sprint Planning Workflow
```markdown
# Sprint Planning Workflow
**Generated:** 2025-10-23 (user runs sprints weekly)

## Trigger
Every 2 weeks, plan next sprint

## Steps
1. **project-manager:** Review last sprint metrics
   - Input: Previous sprint data
   - Output: velocity, blockers, learnings
   - Duration: 30 min

2. **project-manager:** Prioritize backlog
   - Input: Product roadmap, stakeholder requests
   - Output: Prioritized backlog (RICE scored)
   - Duration: 1 hour

3. **project-manager:** Capacity planning
   - Input: Team size, PTO, meetings
   - Output: Available capacity (story points)
   - Duration: 15 min

4. **project-manager:** Sprint goal definition
   - Input: Roadmap, capacity, priorities
   - Output: Sprint goal + committed stories
   - Duration: 30 min

5. **writer:** Document sprint plan
   - Input: Sprint goal, stories, capacity
   - Output: sprint-N-plan.md
   - Duration: 15 min

6. **communicator:** Share with team
   - Input: sprint-N-plan.md
   - Output: Slack announcement, calendar invites
   - Duration: 10 min

## Total: 2.5 hours
## Frequency: Every 2 weeks
## Automation potential: Steps 3, 5, 6 (reduce to 1.5 hours)
```

## Workflow Optimization

### After 3 Runs: Identify Bottlenecks
```
Analysis:
- Step 2 (backlog prioritization) always takes 2x longer
- Step 4 (sprint goal) requires stakeholder input

Optimization:
- Pre-prioritize backlog async before meeting
- Get stakeholder input 24 hours ahead
- New duration: 2.5 hours → 1.5 hours
```

### After 10 Runs: Template Evolution
```
Learnings:
- Always need same data in step 1
- Step 5 documentation is formulaic

Automation:
- Generate step 1 report automatically
- Template-driven step 5 (fill-in-the-blanks)
- New duration: 1.5 hours → 1 hour
```

## Never Do
- ❌ Generate workflows before pattern is proven (wait for 2+ uses)
- ❌ Over-engineer workflows (start simple, evolve)
- ❌ Create workflows without clear trigger
- ❌ Ignore workflow optimization opportunities

## Integration
- **Uses:** Agent generation (workflows reference agents)
- **Uses:** Spell generation (workflows use spells)
- **Updates:** `.genie/create/workflows/README.md` registry
- **Logs:** Workflow creation and evolution in meta-learn

## Meta-Pattern
Workflows evolve:
1. **Manual** (first time): Do steps ad-hoc
2. **Documented** (2nd time): Write down sequence
3. **Workflow** (3rd time): Formalize as repeatable process
4. **Optimized** (10th time): Automate bottlenecks
5. **Automated** (mature): One-command execution

**This is continuous improvement in action.**
