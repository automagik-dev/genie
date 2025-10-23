# Skill Generation
**Last Updated:** 2025-10-23 06:45:58 UTC
**Domain:** Meta-Creation
**Purpose:** Generate new skills on-demand when users need specific capabilities

## Core Principle
Create comes with foundational skills. When users need domain-specific expertise, Create **generates** the skill, learns it, and adds it to the knowledge base.

## When to Generate a Skill

### Signals
- User asks "How do I [specific technique]?"
- Repeated task type (3+ times)
- Complexity requires documented approach
- User says "I'll need this again"

## Skill Generation Process

### 1. Identify Skill Need
```
User: "Help me write a competitive analysis"
Create: "I don't have a pre-built competitive-analysis skill.
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

### 3. Generate Skill File
**Location:** `.genie/create/skills/<domain>/<skill-name>.md`

**Template:**
```markdown
# [Skill Name]
**Last Updated:** 2025-10-23 06:45:58 UTC
**Domain:** [Domain]
**Generated:** [Date] for [User/Project]

## Purpose
[What this skill enables]

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

## Related Skills
[Cross-references]
```

### 4. Test & Refine
- Apply skill to current task
- Capture what worked / didn't work
- Update skill based on learnings
- Add to Create's skill library

## Skill Lifecycle

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
Action: Promote to core skill library
```

### Phase 3: Core (10+ Uses)
```
Status: Foundation
Quality: 95% (battle-tested, canonical)
Action: Reference as standard approach
```

## Skill Domains (Examples)

When user needs emerge, Create generates skills in:

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

### Skill File
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
- ❌ Generate duplicate skills (search existing first)
- ❌ Create skills without user validation
- ❌ Generate overly generic skills (be specific)
- ❌ Skip documentation (capture the knowledge)

## Integration
- **Uses:** `@.genie/skills/prompt.md` for skill prompt generation
- **Uses:** Web search / research for best practices
- **Updates:** Skill registry in `.genie/create/skills/README.md`
- **Logs:** Skill creation in meta-learn system

## Example: Real-Time Skill Generation

```
User: "I need to write an RFP response by Friday"

Create: "I don't have an RFP-response skill yet. Let me generate one.

[Researches RFP best practices]
[Creates .genie/create/skills/business-writing/rfp-response.md]

Done! I've created a comprehensive RFP response framework:
- Executive summary
- Technical approach
- Team qualifications
- Pricing structure
- Compliance checklist

Want me to apply it to your RFP now?"

User: "Yes"

Create: [Applies newly-generated skill to task]

[After completion]
Create: "This skill is now part of my library. Next time
you need RFP help, I'll use this proven approach."
```

## Meta-Learning Loop
Every generated skill improves Create:
1. User need → Generate skill
2. Apply skill → Gather results
3. Refine skill → Update documentation
4. Skill matures → Becomes canonical
5. Share knowledge → Other users benefit

**This is how Create grows expert knowledge organically.**
