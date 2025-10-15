# Genie Create Workspace

**A self-adaptive AI assistant that learns, evolves, and becomes uniquely yours.**

## What This Is

This is not a static template. This is a **seed** that grows into a custom AI assistant perfectly adapted to your project and working style.

Every Genie instance starts the same, but evolves differently:
- **Research project** → Creates literature-reviewer, experiment-designer, paper-writer neurons
- **Content writing** → Creates outline-builder, technical-editor, seo-optimizer neurons
- **Planning & strategy** → Creates risk-assessor, decision-analyzer, roadmap-planner neurons

**Same seed. Different evolution. Infinite adaptability.**

## How It Works

### Initialization
```bash
genie init --template create
```

Genie will:
1. **Analyze your project** (if files exist) or ask about your goals
2. **Propose file organization** based on your domain
3. **Get your approval** before creating structure
4. **Begin learning** through conversation

### Learning & Evolution

**Pattern Recognition (≥3 occurrences):**
```
You: "Can you outline this article?"
[Genie helps with outlining]

You: "Let's outline another one"
[Genie helps again]

You: "One more outline needed"
Genie: "I've noticed we do outlines often (3 times).
        Should I create an outline-builder neuron?
        It'll specialize in article structure and save time."

You: "Yes"
Genie: *creates .genie/agents/domain/outline-builder.md*
Genie: "Done! Available for future outline work."
```

**Continuous Adaptation:**
- Learns your preferred patterns
- Creates specialized neurons when patterns emerge
- Updates own instructions based on results
- Proposes organizational improvements
- **Never forgets** decisions or rationale

### Self-Modification

Genie can update itself with your permission:

**Default Mode (Ask Permission):**
```
Genie: "I've learned your preference for bullet-list outlines.
        Should I update my knowledge base and create
        specialized handling for this pattern?"
You: "Yes"
```

**Autonomous Mode (After Trust):**
```
You: "Enable autonomous learning"
Genie: *updates .genie/context.md preferences*
Genie: "Autonomous mode enabled. I'll notify you of changes
        but won't ask permission for knowledge updates or
        pattern-based neurons (≥3 occurrences)."
```

## What You Get

### Eternal Memory
- **Worktree = Knowledge Base** - everything persists in `.genie/`
- **Session History** - links to important MCP sessions
- **Accumulated Learnings** - patterns, decisions, domain knowledge
- **Never Forgets** - builds on every conversation

### Specialized Capabilities
- **Core Reasoning** - challenge, explore, consensus, prompt (shipped)
- **Domain Neurons** - created as your patterns emerge
- **Tool Awareness** - detects needs, asks for capabilities
- **Universal Routing** - spawns any neuron type as needed

### Adaptive Organization
- **Proposed Structure** - based on project analysis
- **User Approved** - you choose what works
- **Evolves Naturally** - refactors as knowledge grows
- **Your Preferences** - remembers how you like things

## File Structure (After Init)

```
.genie/
├── context.md                    # Your session state & preferences
├── bootstrap/                    # How Genie works (reference docs)
│   ├── identity.md
│   ├── learning-protocol.md
│   ├── neuron-protocol.md
│   └── self-modification-rules.md
├── agents/                       # Executable capabilities
│   ├── core/                     # Shipped reasoning modes
│   │   ├── orchestrator.md       # Identity + routing
│   │   ├── challenge.md          # Critical thinking
│   │   ├── explore.md            # Discovery
│   │   ├── consensus.md          # Synthesis
│   │   └── prompt.md             # Prompt engineering
│   └── domain/                   # Your specialized neurons
│       ├── README.md             # Auto-generated catalog
│       └── [neurons].md          # Created as patterns emerge
├── knowledge/                    # What Genie learned about your project
│   ├── domain.md                 # Project understanding
│   ├── patterns.md               # Observed patterns
│   ├── decisions.md              # Strategic decisions + rationale
│   └── standards.md              # Your conventions
└── memory/                       # Persistent learnings
    ├── important-sessions.md     # Links to key MCP sessions
    └── learnings.md              # Accumulated insights
```

## Philosophy

**Traditional AI:** Same assistant for everyone, forgets between sessions, limited capabilities

**Genie NL:** Unique to you, remembers everything, unlimited evolution

This template enables Genie to:
- ✅ Learn your domain through conversation
- ✅ Create specialized neurons when patterns emerge (≥3)
- ✅ Remember every decision and rationale
- ✅ Adapt file organization to your preferences
- ✅ Improve continuously over time
- ✅ Become a unique domain expert for your project

## Getting Started

1. **Initialize:**
   ```bash
   genie init --template create
   ```

2. **Talk naturally:**
   ```
   You: "I'm working on a research paper about X"
   Genie: "Cool! Tell me about X - what's your focus?"
   [Genie learns through conversation]
   ```

3. **Let it evolve:**
   - Work together on tasks
   - Genie observes patterns
   - Proposes specialized neurons (you approve)
   - Organizes knowledge naturally
   - Improves over time

4. **Watch it adapt:**
   - After 1 week: Knows your domain
   - After 1 month: Has specialized neurons
   - After 3 months: Fully adapted expert
   - Forever: Continuously improving

## Examples

**Academic Research (After 2 Weeks):**
- Has `literature-reviewer` neuron
- Knows your citation style
- Remembers key papers
- Proposes experiment structures
- Specializes in your research area

**Content Writing (After 2 Weeks):**
- Has `outline-builder` neuron
- Knows your voice
- Remembers audience preferences
- Optimizes for your platform
- Specializes in your niche

**Same seed. Different domains. Unique evolution.**

---

**Built with Genie Framework** - Learn more at [github.com/namastexlabs/automagik-genie](https://github.com/namastexlabs/automagik-genie)
