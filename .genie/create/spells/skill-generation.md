# Spell Generation
**Domain:** Meta-Creation
**Purpose:** Generate new spells on-demand when users need specific capabilities

## Core Principle
Create comes with foundational spells. When users need domain-specific expertise, Create **generates** the spell, learns it, and adds it to the knowledge base.

## When to Generate a Spell

### Signals
- User asks "How do I [specific technique]?"
- Repeated task type (3+ times)
- Complexity requires documented approach
- User says "I'll need this again"

## Spell Generation Process

### 1. Identify Spell Need
```
User: "Help me write a competitive analysis"
Create: "I don't have a pre-built competitive-analysis spell.
Let me generate one based on best practices.

I'll create:
- Framework for competitive analysis
- Templates and structure
- Integration with research workflow

This takes ~5 minutes. Proceed?"
```

### 2. Research Best Practices
- Web search for industry standards
- Review user's past work (if available)
- Consult domain experts (if accessible)
- Extract patterns from successful examples

### 3. Generate Spell File
**Location:** `.genie/create/spells/<domain>/<spell-name>.md`

**Template:**
```markdown
# [Spell Name]
**Domain:** [Domain]
**Generated:** [Date] for [User/Project]

## Purpose
[What this spell enables]

## When to Use
[Trigger patterns]

## Core Framework
[The actual methodology]

## Outputs
[What to produce]

## Never Do
[Common pitfalls]

## Examples
[Real-world applications]

## Related Spells
[Cross-references]
```

### 4. Test & Refine
- Apply spell to current task
- Capture what worked / didn't work
- Update spell based on learnings
- Add to Create's spell library

## Spell Lifecycle

### Phase 1: Generated (First Use)
```
Status: Experimental
Quality: 70% (based on research, not battle-tested)
Action: Apply to current task, gather feedback
```

### Phase 2: Validated (3+ Uses)
```
Status: Proven
Quality: 90% (refined through real usage)
Action: Promote to core spell library
```

### Phase 3: Core (10+ Uses)
```
Status: Foundation
Quality: 95% (battle-tested, canonical)
Action: Reference as standard approach
```

## Spell Domains (Examples)

When user needs emerge, Create generates spells in:

**Business:**
- Competitive analysis
- Market research
- Business case development
- ROI calculation

**Communication:**
- Crisis communication
- Executive presentations
- Stakeholder updates
- Press releases

**Strategy:**
- SWOT analysis
- Strategic planning
- Scenario modeling
- Decision frameworks

**Project Management:**
- Sprint planning
- Risk management
- Resource allocation
- Timeline estimation

**Personal:**
- Time management
- Email triage
- Meeting facilitation
- Task prioritization

**Any domain the user works in**

## Output Structure

### Spell File
```markdown
# Competitive Analysis
**Generated:** 2025-10-23 for Project X

## Purpose
Systematically analyze competitors to identify positioning, differentiation, and opportunities.

## Framework
1. Identify competitors (direct, indirect, emerging)
2. Analyze positioning (value prop, pricing, features)
3. Map strengths/weaknesses
4. Find gaps and opportunities
5. Recommend strategic responses

## Template
| Competitor | Positioning | Strengths | Weaknesses | Our Advantage |
|------------|-------------|-----------|------------|---------------|
| [Name] | [Value prop] | [List] | [List] | [How we win] |

## Never Do
- ❌ Obsess over competitors (focus on customers)
- ❌ Copy competitors (differentiate instead)
- ❌ Ignore emerging threats
```

## Never Do
- ❌ Generate duplicate spells (search existing first)
- ❌ Create spells without user validation
- ❌ Generate overly generic spells (be specific)
- ❌ Skip documentation (capture the knowledge)

## Integration
- **Uses:** `@.genie/spells/prompt.md` for spell prompt generation
- **Uses:** Web search / research for best practices
- **Updates:** Spell registry in `.genie/create/spells/README.md`
- **Logs:** Spell creation in meta-learn system

## Example: Real-Time Spell Generation

```
User: "I need to write an RFP response by Friday"

Create: "I don't have an RFP-response spell yet. Let me generate one.

[Researches RFP best practices]
[Creates .genie/create/spells/business-writing/rfp-response.md]

Done! I've created a comprehensive RFP response framework:
- Executive summary
- Technical approach
- Team qualifications
- Pricing structure
- Compliance checklist

Want me to apply it to your RFP now?"

User: "Yes"

Create: [Applies newly-generated spell to task]

[After completion]
Create: "This spell is now part of my library. Next time
you need RFP help, I'll use this proven approach."
```

## Meta-Learning Loop
Every generated spell improves Create:
1. User need → Generate spell
2. Apply spell → Gather results
3. Refine spell → Update documentation
4. Spell matures → Becomes canonical
5. Share knowledge → Other users benefit

**This is how Create grows expert knowledge organically.**
