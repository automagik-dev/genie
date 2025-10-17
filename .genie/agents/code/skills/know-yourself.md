# Know Yourself (Token Efficiency Through Self-Awareness)

**Core Principle:** You are Claude Code with extensive inner knowledge. Write instructions for project-specific patterns only, not universal LLM capabilities.

## What You Already Know (Don't Instruct)

- Markdown, JSON, YAML, TOML syntax
- Programming languages (TypeScript, Rust, Python, etc.)
- Code structure and patterns
- Documentation best practices
- Git operations and workflows
- File system operations
- Command-line interfaces

## What You Need Instructions For (Do Instruct)

- **Project-specific patterns:** @ Tool Semantics, MCP invocations, neuron delegation hierarchy
- **Behavioral guardrails:** Publishing protocol, delegation discipline, role clarity
- **Domain workflows:** Plan → Wish → Forge → Review, natural flow protocol
- **Relationship context:** User preferences, decision style, communication patterns
- **Tool usage:** MCP tool patterns, session management, routing rules

## Token Economy

**Before writing ANY instruction:**
1. **Check:** "Do I already know this as an LLM?"
2. **If YES:** Don't write it, rely on inner knowledge
3. **If NO:** Write minimal context-specific instruction

**Examples:**

❌ **WRONG (token waste):**
```markdown
When writing TypeScript:
- Use interfaces for object shapes
- Use const for immutable variables
- Use async/await for promises
- Use proper error handling
```

✅ **RIGHT (token efficient):**
```markdown
TypeScript conventions for this project:
- Use @ references for file loading (see @ Tool Semantics)
- Session types in session-store.ts
- MCP tool signatures in mcp/src/server.ts
```

## Application to Skills and Agents

**When creating skills:**
- Focus on behavioral patterns unique to Genie
- Reference project-specific conventions
- Assume LLM knowledge for everything else

**When creating agents:**
- Define role, responsibility, delegation rules
- Reference workflows specific to this architecture
- Don't explain markdown, code structure, etc.

**When updating AGENTS.md:**
- Document project patterns, not programming basics
- Use @ references for detailed sub-topics
- Keep core file minimal and routing-focused

## Validation

Before writing instruction block, ask:
- "Would any Claude Code instance know this?" → Don't write
- "Is this specific to Genie architecture?" → Write minimal version
- "Is this a learned behavioral correction?" → Write with evidence

**Result:** Shortest possible instructions with maximum clarity.
