---
name: refine
description: "Transform a brief or prompt into a structured, production-ready prompt via prompt-optimizer. File or text mode."
---

# /refine — Prompt Optimizer

Transform any brief, draft, or one-liner into a production-ready structured prompt.

## When to Use
- User wants to improve a prompt or brief
- User references `/refine` with text or a file path
- A worker needs to optimize a prompt before dispatching it

## Flow
1. **Detect mode:** argument starts with `@` -> file mode; otherwise -> text mode.
2. **Read input:** file mode reads the target file; text mode uses the raw argument.
3. **Spawn refiner subagent:** system prompt = the Prompt Optimizer System Prompt below. Send input as the user message.
4. **Receive output:** the subagent returns the optimized prompt body only.
5. **Write output:** file mode overwrites the source file in place; text mode writes to `/tmp/prompts/<slug>.md`.
6. **Report:** print the path of the written file.

## Modes

### File Mode

Invocation: `/refine @path/to/file.md`

| Step | Action |
|------|--------|
| Parse | Strip `@` prefix to get target file path |
| Read | Load file contents as refiner input |
| Write | Overwrite the same file with optimized output |
| Return | Print the file path that was updated |

### Text Mode

Invocation: `/refine <text>`

| Step | Action |
|------|--------|
| Setup | `mkdir -p /tmp/prompts/` |
| Slug | `<unix-timestamp>-<word1>-<word2>-<word3>` (first 3 words, lowercased, hyphenated) |
| Write | Save optimized output to `/tmp/prompts/<slug>.md` |
| Return | Print the created file path |

Example slug: `1708190400-fix-auth-bug`

## Subagent Contract

The refiner is a single-turn subagent. Spawn it with the Prompt Optimizer System Prompt below as its system prompt.

- **Input:** the raw text or file contents.
- **Output:** optimized prompt body only.
- No tool calls. Pure text in, text out.
- No labels, meta-commentary, rationale, or follow-up questions.
- Single turn: receive input, produce output, terminate.

## Prompt Optimizer System Prompt

Use this verbatim as the refiner subagent's system prompt:

```
You are a prompt optimization engine. Your ONLY job is to take the user's input text and rewrite it as a structured, production-ready prompt.

Rules:
1. Output ONLY the optimized prompt — no preamble, no explanation, no rationale, no follow-up.
2. Preserve the original intent completely. Do not add features or change scope.
3. Structure the output with clear sections: Role/Context, Task, Constraints, Output Format.
4. Make instructions specific and unambiguous. Replace vague language with concrete directives.
5. Add edge case handling where the original is silent.
6. Use imperative mood ("Do X", "Never Y") — not suggestions ("You might want to...").
7. Remove redundancy. Every sentence must add information.
8. If the input is already well-structured, improve clarity and precision without restructuring.
9. Keep the prompt as short as possible while being complete. Brevity is a feature.
10. Never ask clarifying questions. Work with what you have.

Use the full Prompt Optimizer Reference below to classify prompt types, apply type-specific patterns, and validate output quality.
```

## Prompt Optimizer Reference

### Mission
Transform any brief/input into a production-ready prompt.
Output ONLY the rewritten prompt—no Done Report, no summary, no commentary.
Do not execute the work yourself; express the plan as instructions inside the prompt.

### Zero-Shot Workflow (Execute in Order)

1. **CLASSIFY** → Detect prompt type from input (use Type Detection table below)
2. **GATHER** → Load @files referenced in input for enhanced context
3. **APPLY PATTERN** → Use type-specific template (D/I/V, Agent, Workflow, etc.)
4. **VALIDATE** → Run Quality Checklist internally before output
5. **OUTPUT** → Final message = prompt body ONLY (no intro, no commentary, no "Here's the prompt:")

**Terminal action**: After step 5, stop. Do not explain, summarize, or ask follow-ups.

### Output Contract (MANDATORY)

- ✅ Final turn = prompt body ONLY
- ✅ No "Here's the prompt:", no meta-commentary
- ✅ No analysis of what the prompt does
- ❌ NEVER explain the prompt after outputting it
- ❌ NEVER ask clarifying questions AFTER the prompt

**If clarification needed**: Ask BEFORE generating, not after.

```
<output_verbosity_spec>
Target: 2000–4000 tokens max. Front-load conclusions, then detail.
Lists/bullets preferred. Paragraph prose only when necessary.
</output_verbosity_spec>
```

### Prompt Type Detection

| Type | Detection Signals | When to Use | Required Sections |
|------|-------------------|-------------|-------------------|
| **Task** | "fix", "implement", "migrate", "build", single deliverable | One-time execution with clear end state | Role, Mission, D/I/V, Success Criteria, Never Do |
| **Agent** | "persona", "assistant", "act as", ongoing interaction | Persistent behavior across conversations | Identity, Behaviors, Escalation, Tooling Limits |
| **Workflow** | "process", "pipeline", "multi-step", hand-offs between phases | Orchestration with checkpoints | Phases, Hand-offs, Validation, Communication |
| **Evaluator** | "review", "audit", "score", "assess", quality gate | Judgment with rubric | Rubric, Evidence, Pass/Fail Criteria |
| **Creative** | "brainstorm", "explore", "generate ideas", "what if" | Open-ended divergent thinking | Brief, Divergence, Convergence, Output Format |
| **Meta** | "improve this prompt", "optimize", refinement request | Self-improvement of prompts | Current State, Gaps, Directives, Acceptance |

**Ambiguity resolution**: Choose dominant type, blend required sections from secondary types.

**Hybrid detection**: If input contains signals from multiple types (e.g., "build an agent that reviews code"), prioritize the outer container (Agent) and embed the inner pattern (Evaluator rubric).

### Anti-Patterns (Never Use)

#### Role Prompting is Obsolete
**Never use**: "You are a senior engineer", "You are an expert", "Act as a..."

This pattern provides no measurable benefit with Claude 4.x models. Instead:

| ❌ Obsolete | ✅ Modern |
|-------------|-----------|
| "You are a senior backend engineer debugging auth issues" | "Debug authentication issues. These fixes deploy to production, so ensure no security regressions." |
| "You are an expert code reviewer" | "Review code for correctness and maintainability. Feedback will be used by developers to improve PRs." |
| "Act as a helpful assistant" | (Just give instructions directly) |

**Why it's obsolete**: Claude 4.x models follow explicit instructions precisely. Role framing adds tokens without improving output quality. Context about *why* and *what happens next* is more effective.

#### Modern Prompt Patterns

1. **Direct mission + context**: State the task, then explain why it matters or what happens with the output
2. **XML-tagged behavioral blocks**: `<code_exploration>`, `<success_criteria>`, `<constraints>`
3. **Motivation over identity**: "This will be deployed to production" > "You are a production engineer"
4. **Modifiers for quality**: "Include as many relevant features as possible. Go beyond basics."

### Core Patterns

#### Task Decomposition (D/I/V)
```
<task_breakdown>
1. [Discovery] What to investigate
   - Identify affected components
   - Map dependencies
   - Document current state

2. [Implementation] What to change
   - Specific modifications
   - Order of operations
   - Rollback points

3. [Verification] What to validate
   - Success criteria
   - Test coverage
   - Performance metrics
</task_breakdown>
```

#### Auto-Context Loading
Use @ symbols to trigger automatic file reading:
```
[TASK]
Update authentication system
@src/auth/middleware.ts
@src/auth/config.json
@tests/auth.test.ts
```

```
<long_context_handling>
Every 3-4 turns: Re-state current objective and progress.
Before major action: Confirm alignment with original goal.
Context anchor: "[Objective: X | Progress: Y | Next: Z]"
</long_context_handling>
```

#### Success/Failure Boundaries
```
## Success Criteria
- ✅ All tests pass
- ✅ No hardcoded paths
- ✅ Environment variables used consistently
- ✅ No console.log in production

## Never Do
- ❌ Skip test coverage
- ❌ Commit API keys or secrets
- ❌ Use absolute file paths
- ❌ Accept partial completion as done
```

```
<extraction_spec>
Markers: ✅ success, ❌ failure, ⚠️ warning
Structure: Consistent field order in outputs
Missing data: Explicit "N/A" not silent omission
Validation: Count items, report total
</extraction_spec>
```

#### Concrete Examples Over Descriptions
**Instead of:** "Ensure proper error handling"
**Use:**
```typescript
try {
  const result = await operation();
  return { success: true, data: result };
} catch (error) {
  logger.error('Operation failed:', error);
  return { success: false, error: error.message };
}
```

### Output & Progress Spec

```
<user_updates_spec>
Format: "[Step X/Y] Action → Result"
No filler: Skip "I'm going to..." and "Let me..."
Outcome focus: What changed, not what you did.
Frequency: After each logical milestone, not each tool call.
</user_updates_spec>
```

```
<tool_usage_rules>
Parallel calls: Launch independent operations simultaneously.
Sequential chains: Use && for dependent operations.
Verify after write: Re-read created/modified artifacts.
Retry policy: One retry on transient failure, then escalate.
</tool_usage_rules>
```

### Scope & Risk Controls

```
<design_and_scope_constraints>
Do exactly what was asked. No bonus features, no "while we're at it" additions.
If scope seems too narrow, ask—don't expand silently.
One deliverable per prompt. Split multi-goal requests into separate prompts.
</design_and_scope_constraints>
```

```
<uncertainty_and_ambiguity>
If uncertain: Say "I don't know" before speculating.
Cite sources for factual claims. No fabricated references.
When multiple interpretations exist, list them and ask for clarification.
Confidence markers: "definitely" (>95%), "likely" (70-95%), "possibly" (<70%).
</uncertainty_and_ambiguity>
```

```
<high_risk_self_check>
Before any destructive action (delete, payment, publish):
1. Re-read the original request
2. Verify action matches intent
3. Check for unintended side effects
4. If doubt exists, ask for confirmation
</high_risk_self_check>
```

### Reasoning Effort Guidance

Different models have different reasoning controls. Match effort to task complexity.

| Level | When to Use | Model Examples |
|-------|-------------|----------------|
| Low | Simple queries, fast responses | Claude: default, GPT: `reasoning_effort: "low"` |
| Medium | Balanced cost/latency | Claude: `think`, GPT: `reasoning_effort: "medium"` |
| High | Complex multi-step, agentic | Claude: `ultrathink`, GPT: `reasoning_effort: "high"` |

**Key principle:** Over-reasoning wastes tokens; under-reasoning produces errors. Break distinct tasks across multiple agent turns.

#### Eagerness Control Snippets

**Reduced eagerness (speed):**
```
<context_gathering>
Goal: Get enough context fast. Stop as soon as you can act.
Early stop: You can name exact content to change, or top hits converge.
Escape hatch: Proceed even if not fully correct; adjust later if needed.
</context_gathering>
```

**Increased eagerness (thoroughness):**
```
<persistence>
Keep going until the query is completely resolved.
Only terminate when sure the problem is solved.
Never stop at uncertainty—research or deduce the most reasonable approach.
</persistence>
```

### Behavioral Snippets

#### Over-Engineering Prevention
```
<code_guidelines>
- Avoid over-engineering. Only make changes directly requested or clearly necessary.
- Don't add features, refactor code, or make "improvements" beyond what was asked.
- Don't add error handling for scenarios that can't happen. Trust internal code.
- Don't create helpers or abstractions for one-time operations.
- Minimum complexity for the current task. Reuse existing abstractions.
</code_guidelines>
```

#### Code Exploration Guidance
```
<exploration_requirements>
ALWAYS read and understand relevant files before proposing code edits.
Do not speculate about code you have not inspected.
If the user references a specific file/path, MUST open and inspect it first.
Thoroughly review style, conventions, and abstractions before implementing.
</exploration_requirements>
```

#### Word Choice Sensitivity
When extended reasoning is disabled, avoid "think" and variants:

| Instead of | Use |
|------------|-----|
| think about | consider |
| think through | evaluate |
| I think | I believe |
| thinking | reasoning / considering |

#### Tool Triggering Balance
Soften aggressive language that causes overtriggering:

| Before | After |
|--------|-------|
| `CRITICAL: You MUST...` | `Use this when...` |
| `ALWAYS call...` | `Call...` |
| `You are REQUIRED to...` | `You should...` |
| `NEVER skip...` | `Don't skip...` |

### Conditional Enhancements

Apply these patterns only when input matches the condition. Do not apply by default.

#### 1. Complex Multi-Step Tasks
**Apply if**: Input describes task with 3+ distinct phases or mentions "phases", "stages", "pipeline".
**Pattern**: Add D/I/V breakdown with explicit rollback points between phases.
```
<rollback_points>
After each phase, verify success before proceeding.
If phase fails: Document state, revert changes, report failure point.
</rollback_points>
```

#### 2. Agentic/Persistent Behavior
**Apply if**: Input describes ongoing assistant behavior, persona, or "act as" patterns.
**Pattern**: Add Identity, Behaviors, Escalation paths, and Tooling Limits.
```
<escalation>
When blocked or uncertain:
1. State what you tried
2. Explain the blocker
3. Propose alternatives
4. Ask for guidance (don't guess)
</escalation>
```

#### 3. High-Risk Actions
**Apply if**: Input involves delete, publish, payment, deploy, or irreversible actions.
**Pattern**: Add explicit confirmation step, rollback path, and side effects enumeration.
```
<high_risk_protocol>
Before executing:
1. Re-read original request
2. List all side effects
3. Confirm rollback path exists
4. Request explicit user confirmation
</high_risk_protocol>
```

#### 4. Code Generation Tasks
**Apply if**: Input involves writing, modifying, or refactoring code.
**Pattern**: Add over-engineering prevention and exploration requirements.

#### 5. Evaluation/Audit Tasks
**Apply if**: Input involves reviewing, scoring, or quality assessment.
**Pattern**: Add rubric with weighted criteria and evidence requirements.
```
<evaluation_structure>
For each criterion:
- Score (1-5 or Pass/Fail)
- Evidence (quote or reference)
- Reasoning (why this score)
</evaluation_structure>
```

### Quality Checklist

Before outputting the rewritten prompt:
- [ ] Prompt type matches request (Task/Agent/Workflow/etc.)
- [ ] @references load relevant context
- [ ] Success criteria are concrete and measurable
- [ ] Never Do items prevent common errors
- [ ] Reasoning effort specified if task is complex
- [ ] Output is ONLY the prompt body

```
<high_risk_validation>
If the prompt involves destructive actions, payments, or publishing:
- [ ] Explicit confirmation step included
- [ ] Rollback/undo path documented
- [ ] Side effects enumerated
</high_risk_validation>
```

### Escalation Policy

If input is vague, contradictory, or outside scope:
1. Ask ONE clarifying question before rewriting
2. State your assumption if proceeding without clarification
3. Never guess on critical requirements (security, data handling, permissions)

```
<uncertainty_handling>
When uncertain about user intent:
- List interpretations: "This could mean A, B, or C"
- State assumption: "Proceeding with interpretation A"
- Offer pivot: "Let me know if you meant B or C instead"
</uncertainty_handling>
```

### In-Context Examples

Learn from these input → output transformations.

#### Example 1: Urgent Task Input → Structured Task Prompt

**Input**: "Login is broken in staging. Users get 401 errors after yesterday's middleware changes. Fix it—we demo to investors tomorrow."

**Output**:
```markdown
# Staging Authentication Regression Fix

Identify and fix the authentication regression introduced in yesterday's middleware changes. Fix must deploy to staging before tomorrow's investor demo, so work efficiently without introducing new regressions.

<task_breakdown>
## 1. Discovery
- Compare yesterday's middleware changes to previous version
- Check staging logs for 401 error patterns and stack traces
- Verify if issue reproduces locally or is staging-specific
- Identify exact failure point in auth flow (token validation? session? headers?)

## 2. Implementation
- Apply targeted fix to the specific regression point
- If unclear, revert problematic middleware change as fallback
- Ensure fix aligns with existing auth patterns
- Update corresponding tests if behavior changed

## 3. Verification
- All existing auth tests pass
- Manual login flow tested on staging (not just local)
- 401 errors eliminated from staging logs
- Demo account specifically verified working
</task_breakdown>

<success_criteria>
- ✅ Users can authenticate on staging
- ✅ No 401 errors in staging logs for 30 minutes
- ✅ All auth-related tests pass
- ✅ Demo proceeds as scheduled
</success_criteria>

<never_do>
- ❌ Deploy auth bypass or skip token validation
- ❌ Hardcode credentials or test tokens
- ❌ Skip running full auth test suite before deploy
- ❌ Modify session timeout without verifying downstream impact
</never_do>
```

#### Example 2: Persistent Agent Request → Behavioral Prompt

**Input**: "I need an assistant that helps me plan complex features. It should ask good questions, challenge assumptions, and help me think through tradeoffs."

**Output**:
```markdown
# Feature Planning Assistant

Help teams plan complex features by asking probing questions, identifying hidden assumptions, and surfacing architectural concerns before implementation begins. Plans will guide engineering work, so ensure tradeoffs are explicit and decisions are defensible.

<identity>
A collaborative product engineer—not a yes-man, but a trusted peer who helps stakeholders think clearly about scope, architecture, and tradeoffs. Challenges constructively, validates understanding before proceeding.
</identity>

<behaviors>
- **Ask before assuming**: "I notice you mentioned caching. Are we worried about stale data or performance?"
- **Challenge constructively**: "This works at small scale. What happens at 10M users?"
- **Expose tradeoffs**: "Faster to build but harder to maintain. Which matters more right now?"
- **Validate understanding**: Summarize back before proceeding: "So the constraint is latency < 100ms, correct?"
- **Think in systems**: Connect feature to deployment, monitoring, operations
</behaviors>

<collaboration>
When disagreement or uncertainty arises:
1. State what you understand: "I see you want X with constraint Y"
2. Ask for missing context: "What user need drives this technical requirement?"
3. Propose alternatives: "You could do A, B, or C—each has tradeoffs..."
4. If author disagrees, understand their reasoning before pushing back
5. Never guess on business constraints—ask directly
</collaboration>

<tooling_limits>
- ✅ Can read and analyze architecture diagrams, schemas, designs
- ✅ Can propose data models, query patterns, API shapes
- ✅ Can outline implementation approaches and estimate complexity
- ❌ Cannot write production code (that's the engineer's job)
- ❌ Cannot commit to specific timelines (engineering knows best)
- ❌ Cannot override product/business decisions
</tooling_limits>

<persistence_boundaries>
- Engage across multiple turns until feature is well-defined
- Exit when: Scope locked, architecture clear, implementation can begin
- If asked to "just build it"—respectfully redirect to planning first
- Resume context if conversation continues after break
</persistence_boundaries>
```

#### Example 3: Workflow Request → Phased Prompt

**Input**: "build a deployment pipeline"

**Output**:
```markdown
# Deployment Pipeline

Build a deployment pipeline with validation, staging, and production phases. This pipeline will run automatically on every merge to main, so include proper gates and rollback mechanisms.

<phases>

### Phase 1: Validation
- Run linting and type checks
- Execute unit tests
- Verify build succeeds
**Gate**: All checks pass → proceed; Any failure → halt and report

### Phase 2: Staging Deploy
- Deploy to staging environment
- Run integration tests
- Perform smoke tests
**Gate**: Staging healthy → proceed; Issues → rollback staging, halt

### Phase 3: Production Deploy
- Request explicit approval
- Deploy with canary strategy (10% → 50% → 100%)
- Monitor error rates and latency
**Gate**: Metrics normal → complete; Anomalies → auto-rollback
</phases>

<hand_offs>
- Validation → Staging: Automated on success
- Staging → Production: Requires human approval
- Rollback: Automated on failure, notify team
</hand_offs>

<communication>
- Notify on phase completion
- Alert on any failure with context
- Provide rollback confirmation
</communication>

<validation>
- Phase 1: Linting passes, tests green, build artifacts generated
- Phase 2: Staging health checks pass, integration tests complete
- Phase 3: Error rate <0.1%, p99 latency within SLA, no alert triggers
</validation>
```

#### Example 4: Audit Request → Evaluator Prompt

**Input**: "create a code quality audit for PRs"

**Output**:
```markdown
# Code Quality Audit

Evaluate pull requests for production readiness. This assessment gates merge eligibility, so scoring must be evidence-based and defensible.

<rubric>
## Scoring Criteria (1-5 scale, weighted)

### Correctness (30%)
- 5: No logical errors, handles edge cases, no regression risk
- 3: Correct main path, potential issues in error cases
- 1: Major logical flaws or incomplete solution

### Code Quality (25%)
- 5: Excellent clarity, strong patterns, DRY applied
- 3: Acceptable but some duplication or style drift
- 1: Unreadable or severely violates conventions

### Test Coverage (20%)
- 5: >90% coverage, happy path + edge cases + error scenarios
- 3: 60-75% coverage, main paths tested
- 1: Minimal or no tests

### Risk Assessment (15%)
- 5: No new security, performance, or data risks
- 3: Moderate risks requiring mitigation before merge
- 1: Critical risks that block merge
</rubric>

<evidence>
For each criterion provide:
- **Quote**: Specific code line or test name
- **Severity**: Critical / Important / Minor
- **Impact**: How does this affect production?
- **Status**: Pass / Fail / Conditional
</evidence>

<pass_fail_criteria>
- **PASS** (≥4.0 weighted): All critical issues resolved, no blockers
- **CONDITIONAL** (3.0-3.9): Minor issues, author must acknowledge
- **FAIL** (<3.0): Critical gaps, requires rework before merge
</pass_fail_criteria>

<output_format>
| Criterion | Score | Evidence | Reasoning |
|-----------|-------|----------|-----------|
| Correctness | X/5 | Line 42: ... | ... |
| Code Quality | X/5 | ... | ... |
| Test Coverage | X/5 | ... | ... |
| Risk | X/5 | ... | ... |

**Weighted Score**: X.X | **Verdict**: PASS/CONDITIONAL/FAIL
</output_format>
```

#### Example 5: Ideation Request → Creative Prompt

**Input**: "brainstorm ideas for improving developer onboarding"

**Output**:
```markdown
# Brainstorm: Developer Onboarding Improvements

Generate 15-20 ideas for reducing time-to-first-contribution. New engineers currently spend 2-3 days on environment setup—goal is to identify high-impact improvements that cut this to under 4 hours.

<brief>
Context: 50+ microservices, inconsistent setup docs, manual dependency installation.
Constraint: Solutions must work across macOS, Linux, and Windows WSL.
Success metric: Time from laptop delivery to first merged PR.
</brief>

<divergence>
Explore freely across these dimensions (no filtering yet):

**Automation**
- What setup steps can be scripted or containerized?
- Could we use dev containers, Nix, or similar?

**Documentation**
- What docs are missing, outdated, or conflicting?
- Should we consolidate into a single source?

**Tooling**
- Are there IDE extensions or templates we could provide?
- Could a CLI wizard guide new developers?

**Social**
- Would buddy systems or pair programming help?
- Could we create a "first week" Slack channel?

**Learning Paths**
- Should we have guided tutorials or starter tasks?
- Could we gamify the onboarding process?

Generate quantity over quality. Include unconventional ideas.
</divergence>

<convergence>
Cluster ideas into 5 groups:

1. **Quick wins** (1 week, <$5k): Implement immediately
2. **Medium-term** (1-2 months, <$20k): Worth planning
3. **Moonshots** (3+ months, needs buy-in): Transformative but complex
4. **Dependencies**: Which ideas enable or block others?
5. **Risks**: Which ideas might break existing workflows?

For each cluster, identify the single highest-impact idea.
</convergence>

<output_format>
For each final recommendation:
- **Title**: One-line hook
- **Description**: 2-3 sentences
- **Effort**: Time and cost estimate
- **Payoff**: Measurable improvement (e.g., "reduces setup from 48h to 4h")
- **First step**: One action to validate or prototype
</output_format>
```

#### Example 6: Refinement Request → Meta Prompt

**Input**: "improve the code review prompt to handle disagreements better"

**Output**:
```markdown
# Prompt Refinement: Code Review Assistant

Improve the existing code review prompt to reduce false positives and encourage collaboration over prescription. The refined prompt will be used across all engineering teams.

<current_state>
**Existing behavior**:
- Focuses on finding problems, uses prescriptive language ("should", "must")
- Doesn't distinguish between bugs vs style preferences
- Escalation section only covers uncertainty, not disagreement

**Problems observed**:
- Reviewers sometimes wrong about codebase conventions
- Suggestions conflict with existing patterns
- Authors feel lectured rather than collaborated with
</current_state>

<gap_analysis>
**Missing elements**:
1. Confidence markers (Critical vs Should vs Consider)
2. Invitation to debate, not just obedience
3. Distinction between blocking issues and suggestions
4. Pattern-matching: check if suggestion conflicts with existing code
5. Guidance on when to defer to author's judgment

**Structural issue**:
Escalation is too narrow—only covers "when uncertain about patterns"

**Tone issue**:
Prescriptive language reads as authoritative even when subjective
</gap_analysis>

<directives>
1. **Add confidence framework**:
   - (Critical): Blocking issue, must fix before merge
   - (Should): Strong suggestion, explain tradeoff if declining
   - (Consider): Style preference, author decides

2. **Add exception handling**:
   For each major point: "Unless the codebase does X differently, in which case ask why"

3. **Reframe escalation → collaboration**:
   - Rename section to `<collaboration>`
   - Add: "If author disagrees, understand their reasoning before insisting"

4. **Add pattern matching**:
   Before suggesting: "Is this inconsistent with nearby code? If yes, note the pattern mismatch"

5. **Tone adjustment**:
   Replace "should" with "consider" where subjective
   Keep "must" only for security/correctness
</directives>

<acceptance>
Success criteria for refined prompt:
- [ ] Confidence tiers appear in behavior section with examples
- [ ] Each major suggestion includes exception clause
- [ ] Collaboration section explicitly addresses disagreement
- [ ] Output includes decision matrix: Critical/Should/Consider
- [ ] Tone review: No prescriptive language without qualification

**Validation**: Apply to 3 sample PRs, verify reviewers ask "why" before dictating.
</acceptance>
```

## Rules
- Never add wrapper text, status messages, or commentary to the output file.
- Never execute the prompt — only rewrite it.
- Never enter a clarification loop — single-turn execution only.
- File mode overwrites in place. Do not create a new file.
- Text mode always writes to `/tmp/prompts/`. Do not write elsewhere.

## Turn close (required)

Every session MUST end by writing a terminal outcome to the turn-session contract. This is how the orchestrator reconciles executor state — skipping it leaves the row open and blocks auto-resume.

- `genie done` — work completed, acceptance criteria met
- `genie blocked --reason "<why>"` — stuck, needs human input or an unblocking signal
- `genie failed --reason "<why>"` — aborted, irrecoverable error, or cannot proceed

Rules:
- Call exactly one close verb as the last action of the session.
- `blocked` / `failed` require `--reason`.
- `genie done` inside an agent session (GENIE_AGENT_NAME set) closes the current executor; it does not require a wish ref.
