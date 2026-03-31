---
type: entity
created: 2026-03-26
updated: 2026-03-26
tags: [context-routing, ideas, low-hanging-fruit, roadmap-pool, brain, knowledge-system]
---

# Context Routing — Ideas Pool for Genie's Context Graph Path

## Where We Are Today
Genie uses file-based knowledge: CLAUDE.md, SOUL.md, AGENTS.md, brain/ directories, .genie/ state. Skills inject context via markdown. The /brain skill stores and retrieves knowledge. It works, but:

- **Prune-prone:** Context injection is manual (skill authors decide what to inject). Miss something = agent works blind.
- **Inflexible:** Users can't easily customize what context flows where. It's hardcoded in skill prompts.
- **No semantic routing:** Context is path-based (file lookup), not meaning-based (what's relevant to THIS task).
- **No decay:** Old context has same weight as fresh context. Brain files from 3 months ago treated same as today's.
- **No blast radius:** When a file changes, no automatic understanding of what else is affected.

## The Vision (from research)
Context routing should be AUTOMATIC, SEMANTIC, and USER-CONTROLLABLE:
- Agent gets the RIGHT context for its task without anyone hand-picking files
- User can override/customize routing rules without touching code
- Context decays naturally (recent > old, unless pinned)
- Changes propagate (update a design doc → agents working on related wishes get notified)

## Low-Hanging Fruit Ideas (ordered by effort, low→high)

### 1. Context Freshness Scoring (trivial)
Add `updated` timestamp to all brain files (already in frontmatter). When injecting context, sort by freshness. Show agents which context is stale.
- **Effort:** 1 day
- **Impact:** Agents stop using outdated info
- **Learned from:** Context+ decay scoring (e^(-λt))

### 2. Tag-Based Context Routing (easy)
Brain files already have `tags: []` in frontmatter. When a wish/task has tags, automatically surface brain files with matching tags.
- Example: wish tagged `[devrel, video]` → auto-inject `brain/DevRel/genie-value-props.md`, `brain/DevRel/viral-video-angles.md`
- **Effort:** 2-3 days
- **Impact:** Agents get relevant context without manual injection
- **Learned from:** Semantica's entity-tag relationships

### 3. Brain Index Auto-Generation (easy)
Generate a machine-readable index of all brain/ files: path, title, tags, updated date, one-line description. Inject this index (not full files) into agent context. Agent decides what to read deeper.
- Like a table of contents vs. dumping the whole book
- **Effort:** 1-2 days
- **Impact:** Massive token savings. Agent sees 50 lines of index instead of 50 files of content.
- **Learned from:** code-review-graph's blast radius approach (index first, details on demand)

### 4. Wish-Scoped Context (easy)
Each wish already has a scope (IN/OUT). Auto-surface brain files and code files relevant to the wish scope keywords. Store in `.genie/wishes/<slug>/context.md`.
- **Effort:** 2-3 days
- **Impact:** Engineers spawned for a wish get targeted context, not everything
- **Learned from:** CodeGraphContext's scoped queries

### 5. User Context Preferences File (easy)
Let users create `brain/_config.md` or `.genie/context-rules.yaml` that says:
```yaml
always-inject:
  - brain/DevRel/genie-value-props.md  # always available
never-inject:
  - brain/Intelligence/competitor-*     # sensitive, don't share with agents
inject-when:
  - tags: [devrel] → brain/DevRel/*
  - tags: [engineering] → repos/genie/CLAUDE.md
```
- **Effort:** 3-4 days
- **Impact:** User controls what agents see. Flexible. No code changes for new rules.
- **Learned from:** MCP Roots protocol (user-controlled access boundaries)

### 6. Context Diff on Wish Start (medium)
When /work starts, diff brain/ files against last wish execution. Show agent: "these 5 brain files changed since your last run, here's what's new."
- **Effort:** 3-5 days
- **Impact:** Agents don't re-read everything. Only absorb what changed.
- **Learned from:** code-review-graph's change impact analysis

### 7. Semantic Search in Brain (medium)
Add lightweight embedding search to /brain skill. `genie brain search "viral content patterns"` returns ranked results by semantic similarity, not just filename grep.
- Could use Ollama local embeddings (no API cost) or Gemini embeddings
- **Effort:** 1-2 weeks
- **Impact:** Agents find relevant context even when file names don't match
- **Learned from:** Context+'s auto-similarity linking (cosine ≥0.72), Supermemory's embedding search

### 8. Cross-Reference Links (medium)
Track which brain files reference each other. When one updates, flag related files as "possibly stale." Like Obsidian's backlinks but for agent context.
- **Effort:** 1 week
- **Impact:** Prevents agents from using context that contradicts newer context
- **Learned from:** Semantica's causal links between decisions

### 9. Agent Context Receipt (medium)
After every agent session, emit a "context receipt" — what files were read, what was useful, what was ignored. Feed this back into routing to improve future sessions.
- **Effort:** 1 week
- **Impact:** Context routing gets smarter over time. Self-improving.
- **Learned from:** Supermemory's feedback loop (#1 on memory benchmarks because it learns what's useful)

### 10. Decision Trace Capture (medium-large)
Every wish execution already produces artifacts (WISH.md, review verdicts, PR). Structure these as decision nodes: what was decided, why, what alternatives were considered, who approved.
- Not a new system — just a structured view of what Genie already captures
- **Effort:** 2 weeks
- **Impact:** Queryable decision history. "Why did we build feature X this way?" has an answer.
- **Learned from:** Semantica's decision-as-first-class-object pattern, Jaya's trillion-dollar thesis

## What NOT to Build (Yet)

- **Graph database** — overkill for current scale. File-based + PG is fine.
- **Vector embeddings for all code** — CodeGraphContext does this well. Integrate later, don't rebuild.
- **Full semantic layer** — we're a CLI tool, not a data platform. Keep it light.
- **Real-time graph visualization** — cool but not useful until desktop app exists.

## The Path

```
Today:     File-based context (CLAUDE.md, brain/, .genie/)
           Manual injection via skills

Near-term: Tag-based routing + freshness scoring + brain index
           User context rules + wish-scoped context
           = Smart file-based context (still files, but routed intelligently)

Mid-term:  Semantic search + cross-references + context receipts
           Decision trace capture
           = Lightweight context graph (files + relationships + search)

Long-term: Full context graph with MCP integration
           Consume CodeGraphContext, Supermemory, etc. as MCP servers
           = Genie as the orchestration layer OVER context tools
```

The key insight from the research: **you don't need to build a graph database to have a context graph.** You need smart routing over existing files. The graph emerges from relationships (tags, references, timestamps, usage patterns), not from infrastructure.

## Connection to Jaya's Thesis
Jaya says: "decision traces are the trillion-dollar asset." Genie already PRODUCES decision traces (wishes, reviews, events). The gap is: they're not QUERYABLE as a graph yet. The low-hanging fruit (items 1-6) make them queryable without rebuilding anything. Items 7-10 add the semantic layer that makes it feel like a real context graph.

The positioning upgrade: "Genie doesn't just orchestrate agents. It builds a context graph of every decision your team makes."
