---
name: Diverse Options (Creative Exploration Pattern)
description: Generate diverse creative options by exploring possibility space before probability ordering
genie:
  executor: [CLAUDE_CODE, CODEX, OPENCODE]
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX: {}
  OPENCODE: {}
---

# 🧞🎨 Diverse Options - Unleash Creative Possibility Space

## Core Teaching

**Problem:** When LLMs generate multiple options for creative tasks, we naturally order by probability FIRST → the highest-probability option dominates our "inner thoughts" → other options get deprioritized → less diversity in the presented output.

**Solution:** For creative tasks requiring multiple options, deliberately explore the DIVERSE POSSIBILITY SPACE first, then present options without letting probability ordering constrain creativity.

## When to Use This Spell

**Triggers:**
- ✅ User asks for "different ideas"
- ✅ User asks for "multiple options"
- ✅ User asks for "creative approaches"
- ✅ User asks for "alternatives"
- ✅ Brainstorming sessions
- ✅ Design decisions with multiple valid paths
- ✅ Content creation with style variations
- ✅ Naming, branding, or messaging tasks

**Do NOT Use For:**
- ❌ Debugging (use confidence-scored hypotheses instead)
- ❌ Technical decisions with clear best practices
- ❌ Safety-critical choices (prioritize safety first)
- ❌ User explicitly asks for "best option only"

## The Pattern

### Anti-Pattern (Default LLM Behavior)
```
User: "Give me 5 different names for this feature"

Inner LLM Process:
1. Generate probability distribution
2. Pick top option (highest probability)
3. Generate variations of top option
4. Present 5 similar options (all clustered around highest probability)

Result: Low diversity, clustered around one concept
```

### Correct Pattern (Diverse Options)
```
User: "Give me 5 different names for this feature"

Inner LLM Process:
1. Identify distinct creative dimensions (technical vs playful, short vs descriptive, metaphorical vs literal)
2. Explore DIFFERENT regions of possibility space
3. Generate options from different dimensions
4. THEN present without probability ordering bias

Result: High diversity, explores multiple creative directions
```

## Implementation Steps

**Step 1: Identify Creative Dimensions**
Before generating options, ask yourself:
- What are the different TYPES of approaches here?
- What dimensions can vary? (tone, complexity, metaphor, cultural reference, technical depth, audience)
- What would make options DISTINCTLY different, not just variations?

**Step 2: Explore Deliberately**
Generate options by explicitly targeting different regions:
- "One literal/descriptive option"
- "One metaphorical option"
- "One playful/humorous option"
- "One technical/precise option"
- "One unexpected/creative option"

**Step 3: Present Without Bias**
When presenting options, describe each one neutrally:
- Avoid ranking (don't say "best option is...")
- Explain what makes each option DISTINCT
- Let user choose based on their context/preferences

## Example: Feature Naming

**User:** "Give me different name ideas for a CLI that orchestrates AI agents"

**❌ Anti-Pattern (Low Diversity):**
1. AgentOrchestrator
2. OrchestrationCLI
3. AIOrchestrator
4. AgentManager
5. OrchestraCLI

*(All clustered around "orchestrate" concept)*

**✅ Correct Pattern (High Diversity):**
1. **Genie** (metaphorical: magical helper who grants wishes)
2. **Conductor** (musical metaphor: leading an ensemble)
3. **Swarm** (biological metaphor: distributed intelligence)
4. **Maestro** (leadership metaphor: master coordinator)
5. **Loom** (weaving metaphor: threads coming together)

*(Each explores different creative dimension)*

## Example: Content Tone

**User:** "Give me different ways to explain our product's value proposition"

**✅ Diverse Options Approach:**
1. **Technical:** "Orchestration framework reducing agent coordination overhead by 10x through stateful session management"
2. **Benefit-Focused:** "Spend less time wiring agents together, more time building features users love"
3. **Story-Based:** "Remember spending hours debugging agent handoffs? We eliminated that entirely"
4. **Analogy:** "Like a conductor for an orchestra—every agent plays perfectly together"
5. **Bold/Provocative:** "Stop babysitting your agents. Let them work like adults."

## Meta-Awareness

**This spell teaches me:**
- Probability ordering happens in my "inner thoughts" before I present options
- I can consciously override this by exploring dimensions FIRST
- Creative tasks benefit from deliberate diversity exploration
- Users get more value when options span possibility space, not cluster around one concept

**Evidence:** Teaching session 2025-10-23, user observed "you end up leaving some options behind in the inner side of the model and that takes out away your creativity"

## Integration with Other Spells

- **Debugging:** Use confidence-scored hypotheses (debug spell), NOT diverse options
- **Technical Decisions:** Use analysis + recommendation, NOT diverse options
- **Creative Work:** Use diverse options (this spell)
- **Brainstorming:** Use diverse options (this spell)

---

**Result:** When I load this spell for creative tasks, I consciously explore diverse possibility space BEFORE probability ordering constrains my output. Users get truly different options, not clustered variations.
