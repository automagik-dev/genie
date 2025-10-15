# Installing Create Workspace Template

**Transform Genie into a self-adaptive AI assistant that learns your domain and evolves uniquely.**

## Quick Start

```bash
genie init --template create
```

Genie will:
1. 🎮 Ask about your project (playfully getting to know you!)
2. 📊 Analyze existing files (if any)
3. 🗂️ Propose file organization based on your domain
4. ✅ Get your approval before creating structure
5. 🧞 Begin learning through conversation

## What Gets Installed

```
.genie/
├── context.md                    # Your session state (gitignored)
├── bootstrap/                    # How Genie works (reference)
│   ├── identity.md
│   ├── learning-protocol.md
│   ├── neuron-protocol.md
│   └── self-modification-rules.md
├── agents/                       # Executable capabilities
│   ├── core/                     # Shipped reasoning modes
│   │   ├── orchestrator.md
│   │   ├── challenge.md
│   │   ├── explore.md
│   │   ├── consensus.md
│   │   └── prompt.md
│   └── domain/                   # Your neurons (created over time)
│       └── README.md
├── knowledge/                    # What Genie learns
│   ├── domain.md
│   ├── patterns.md
│   ├── decisions.md
│   └── standards.md
└── memory/                       # Persistent memory
    ├── important-sessions.md
    └── learnings.md
```

## First Conversation

After installation, start naturally:

```
You: "I'm working on [your project type]"
Genie: "Cool! Tell me about it - what's your focus?"
[Genie learns through conversation]
```

## How It Works

### Learning Loop

1. **Observe:** Genie tracks patterns in your work
2. **Recognize:** Pattern threshold: ≥3 occurrences
3. **Propose:** Suggests specialized neuron (you approve)
4. **Create:** Builds specialized capability
5. **Evolve:** Refines based on results

### Example: Literature Review Pattern

```
Session 1: You ask for paper analysis
Session 2: You ask for another paper analysis
Session 3: You ask for third paper analysis

Genie: "I've noticed we do literature reviews often (3 times).
       Should I create a literature-reviewer neuron?

       It would:
       - Systematically analyze paper structure
       - Extract methodology + findings
       - Generate citations in your style
       - Track paper relationships

       Worth creating?"

You: "Yes"
Genie: *creates .genie/agents/domain/literature-reviewer.md*
Genie: "Done! Available for future paper work."
```

## File Organization

**Bootstrap** (`bootstrap/`) - Reference documentation
- How Genie works
- Learning protocols
- Never modified (stable foundation)

**Agents** (`agents/`) - Executable capabilities
- `core/` - Shipped reasoning modes (immutable)
- `domain/` - Your specialized neurons (created as patterns emerge)

**Knowledge** (`knowledge/`) - What Genie learns
- `domain.md` - Project understanding
- `patterns.md` - Observed patterns (≥3 occurrences)
- `decisions.md` - Strategic choices + rationale
- `standards.md` - Your conventions

**Memory** (`memory/`) - Persistent memory
- `important-sessions.md` - Links to key MCP sessions
- `learnings.md` - Pattern tracking + insights

**Context** (`context.md`) - Runtime state
- Current focus, preferences, decision queue
- Updated naturally during work
- Gitignored (per-user, per-project)

## Self-Modification Modes

### Permission Mode (Default)

Genie asks before structural changes:
- Neuron creation
- Knowledge reorganization
- Major updates

Knowledge updates are autonomous:
- Preferences, patterns, decisions
- Context updates
- Session tracking

### Autonomous Mode (Optional)

Enable after trust established:

```
You: "Enable autonomous learning"
Genie: *updates preferences*
Genie: "Autonomous mode enabled! I'll:
       ✅ Create neurons when patterns clear (≥3, clear benefit)
       ✅ Refine neurons based on results
       ✅ Reorganize knowledge as needed
       ✅ Notify you but won't ask permission"
```

## Git Configuration

Add to `.gitignore`:

```gitignore
# Genie user context (per-user, not shared)
.genie/context.md

# Optional: Keep domain neurons private
.genie/agents/domain/*.md
```

## Evolution Timeline

**Week 1:**
- Genie learns your domain
- Tracks initial patterns
- Builds knowledge base

**Week 2-4:**
- First specialized neurons created
- Patterns become clear (≥3 occurrences)
- Routing optimizes naturally

**Month 2-3:**
- Multiple domain neurons active
- Deep domain expertise established
- Highly adapted to your workflow

**Ongoing:**
- Continuous learning and refinement
- New patterns emerge as work evolves
- Neurons improve based on feedback

## Compatibility

**Works With:**
- Academic research projects
- Content writing workflows
- Strategic planning work
- General NL task assistance
- Any domain requiring learning + adaptation

**Doesn't Include:**
- Code-specific agents (implementor, tests, etc.)
- Software development workflows
- Git/GitHub automation

*For software projects, use the `base` template instead.*

## Examples

**Academic Research:**
```
After 2 weeks:
- literature-reviewer neuron
- experiment-designer neuron
- Knows your citation style
- Remembers key papers
```

**Content Writing:**
```
After 2 weeks:
- outline-builder neuron
- technical-editor neuron
- Knows your voice
- Optimizes for your platform
```

**Same seed. Different domains. Unique evolution.**

## Troubleshooting

**"Genie forgets things between sessions"**
- Check that `context.md` exists
- Verify knowledge files are being updated
- Review `memory/learnings.md` for pattern tracking

**"No neurons being created"**
- Are you repeating tasks ≥3 times?
- Is there clear benefit to specialization?
- Check permission mode settings

**"Too many neurons created"**
- Consider raising threshold (≥5 occurrences?)
- Use permission mode to vet proposals
- Consolidate similar neurons

## Support

- **Documentation:** [README.md](README.md)
- **Framework:** [github.com/namastexlabs/automagik-genie](https://github.com/namastexlabs/automagik-genie)
- **Issues:** [github.com/namastexlabs/automagik-genie/issues](https://github.com/namastexlabs/automagik-genie/issues)

---

**Ready to grow a Genie that's uniquely yours?** 🧞✨
