---
type: entity
tags: [context-graph, code-intelligence, research, trillion-dollar]
date: 2025-03-26
---

# Context Layer Research: 5 Code Intelligence Repos

The "context trillion-dollar problem" is the challenge of giving AI agents and developers the right information at the right time. These 5 projects represent different approaches to context engineering—building graph-based representations of code, decisions, and knowledge that enable smarter, token-efficient AI interactions.

---

## 1. SEMANTICA (Hawksight-AI)

**Path:** `/home/genie/agents/namastexlabs/genie/tools/research/semantica/`

### What It Is
A comprehensive Python framework for building **context graphs and decision intelligence layers** for AI systems. Unlike generic RAG, Semantica structures knowledge as causal, auditable decision graphs with provenance tracking and reasoning engines.

### Tech Stack
- **Language:** Python 3.8+
- **Key Dependencies:** Neo4j, FalkorDB, AWS Neptune, Apache AGE (graph databases); FAISS, Pinecone, Weaviate, Qdrant (vector stores); Tree-sitter, Docling (parsing); NetworkX (graph algorithms); LiteLLM (100+ LLM providers)

### Architecture
**Modular layered design (~22 modules):**
- **Context & Decision:** Structured context graphs, decision tracking, causal chains, precedent search
- **Knowledge Graphs:** Entity/relationship modeling, centrality analysis, community detection
- **Semantic Extraction:** NER, relation extraction, entity resolution
- **Reasoning:** Forward chaining, Rete networks, deductive/abductive engines, SPARQL
- **Vector Store:** Hybrid search, custom similarity weights
- **Data Ingestion:** PDF, DOCX, web, databases, Snowflake, code
- **Provenance:** W3C PROV-O compliant lineage tracking
- **Graph Backends:** Neo4j, FalkorDB, Neptune, AGE, RDF stores
- **Production:** Pipeline DSL, OWL ontology generation, Parquet/RDF export

**Core innovation:** Decision nodes are first-class objects with category, scenario, reasoning, outcome, confidence, and causal links.

### How It Solves Context
**Problem:** Black-box decisions with no audit trail, contradictory facts coexist silently, no way to ask "why."

**Solution:**
1. Structured memory—decisions are queryable graphs, not embeddings
2. Causality—decisions link to what caused them
3. Precedent search—find similar past decisions with full context
4. Reasoning transparency—explain inference paths
5. Conflict detection—multi-source conflicts flagged
6. Auditability—full W3C PROV-O provenance

### Maturity & Stars
- **Status:** v0.3.0 stable (production on PyPI)
- **Lines of code:** ~4,246
- **Test suite:** 886+ passing tests
- **Community:** Discord, 12+ graph backends, 100+ LLM integrations

### How It Relates to Genie
Genie lacks persistent decision/context layer. Semantica fills this:
- Record every agent action as decision with reasoning
- Link decisions causally across workflows
- Precedent search to avoid redundancy
- Compliance/governance via policy engine

**Integration:** Use `AgentContext` + `ContextGraph` as Genie's backbone; wire tool calls as `record_decision()` events; enable `find_similar_decisions()` for precedent-aware planning.

### Jaya's Context Graph Thesis Connection
Semantica is the **"why" layer.** It explains:
- Why decisions were made (reasoning field)
- What caused them (causal chain)
- What's similar in past (precedents)
- What impact they'll have (influence analysis)
- Whether they violate policy (governance)

This is explainable, traceable decision intelligence.

---

## 2. CODEGRAPHCONTEXT (Shashank Shekhar Singh)

**Path:** `/home/genie/agents/namastexlabs/genie/tools/research/CodeGraphContext/`

### What It Is
A **CLI + MCP server** that indexes code repositories into queryable **graph databases** using Tree-sitter AST parsing. Enables natural-language code exploration across 14 languages.

### Tech Stack
- **Language:** Python 3.10+
- **Core:** Tree-sitter (14 languages, 43+ extensions), Kùzu/FalkorDB/Neo4j, Typer CLI, Rich TUI, YAML

### Architecture
**Three-layer design:**
- **Parser:** 14 language toolkits extracting functions, classes, imports, calls, inheritance
- **Graph:** Nodes (Function, Class, File) and edges (CALLS, IMPORTS, INHERITS) stored in graph DB
- **MCP:** 20+ tools for natural-language queries + indexing

**Key features:**
- Multi-language consistent model
- Relationship analysis (callers, callees, class hierarchies, call chains)
- Pre-indexed bundles (.cgc files for famous repos)
- Live watching with auto-updates
- Interactive D3.js visualization
- MCP compatible with Claude, Cursor, Windsurf, VS Code

### How It Solves Context
**Problem:** Developers/AI agents must manually explore; no way to ask "what calls this?" without grep.

**Solution:**
1. Structural graph—functions/classes as nodes, calls/imports as edges
2. Natural language queries—ask instead of grep
3. Call-chain tracing—find all indirect callers across files
4. Incremental indexing—fast initial build, live updates
5. Multi-language AST—consistent model across 14 languages

### Maturity & Stars
- **Status:** v0.3.1 stable
- **Lines of code:** ~16,289 (largest)
- **Database support:** Kùzu (default), FalkorDB Lite, Neo4j
- **Integration:** MCP standard, works out-of-box

### How It Relates to Genie
Genie has no code structure indexing. CodeGraphContext provides:
- Build queryable code graph for any language
- Understand function dependency chains
- Find impact radius of changes
- Provide context-aware suggestions

**Integration:** Index Genie's own codebase; expose CGC tools via MCP; enable self-understanding.

### Jaya's Context Graph Thesis Connection
CGC is the **"what" layer**—answers what functions exist, what calls what, inheritance hierarchies, module imports. Combined with Semantica's "why," you get complete context graph.

---

## 3. CONTEXT+ (ForLoopCodes)

**Path:** `/home/genie/agents/namastexlabs/genie/tools/research/contextplus/`

### What It Is
An **MCP server + TypeScript framework** for fast, **99% accurate** codebase comprehension via multi-layer semantic search, structural analysis, and in-memory memory graphs.

### Tech Stack
- **Language:** TypeScript/Node.js
- **Core:** Tree-sitter (WASM, 43+ extensions), Ollama (embeddings), in-memory property graph, spectral clustering, static analyzers

### Architecture
**Three-layer design with RAG memory:**
- **Core:** Multi-language AST parsing, gitignore-aware traversal, Ollama embeddings + disk cache
- **Tools:** 17 MCP tools (context-tree, file-skeleton, semantic-search, semantic-identifiers, semantic-navigate, blast-radius, static-analysis, propose-commit, feature-hub, memory-tools)
- **Memory:** In-memory property graph with decay scoring, auto-similarity edges, JSON persistence
- **Git:** Shadow restore points for undo

**Key innovations:**
1. Token-aware context tree with pruning
2. Semantic search + embeddings (find files by meaning)
3. Blast radius analysis (trace symbol usage)
4. Memory graph with decay (edges age via e^(-λt))
5. Auto-similarity linking (cosine ≥0.72)
6. Realtime tracker (incremental embedding updates)
7. Feature hub (Obsidian-style wikilinks)

### How It Solves Context
**Problem:** Large codebases blow token budgets; developers re-explore; no persistent memory.

**Solution:**
1. Structural awareness—understand code without reading bodies
2. Semantic search—find by meaning, not grep
3. Memory + RAG—avoid re-exploring
4. Decay-based forgetting—old info deprioritized
5. Blast radius—know exactly what's affected
6. Static analysis—deterministic linting

### Maturity & Stars
- **Status:** Active development (stable MCP)
- **Lines of code:** ~4,960
- **Features:** 17 tools, realtime tracking
- **Ollama integration:** Local or cloud

### How It Relates to Genie
Genie needs fast structural comprehension + memory. Context+ provides both.

**Integration:** Use memory graph as persistent task memory; enable `search_memory_graph` at task start; use `semantic_identifier_search` for functions by meaning; deploy realtime tracker.

### Jaya's Context Graph Thesis Connection
Context+ is the **"remember" layer**—enables long-term memory, automatic forgetting, decay-weighted relevance, task-aware retrieval. This is persistent, adaptive context that makes agents truly agentic.

---

## 4. CODE-REVIEW-GRAPH (tirth8205)

**Path:** `/home/genie/agents/namastexlabs/genie/tools/research/code-review-graph/`

### What It Is
A **persistent knowledge graph for token-efficient code reviews** with Claude Code. Parses via Tree-sitter, builds SQLite graph, exposes via MCP. Achieves 6.8x token reduction while improving quality.

### Tech Stack
- **Language:** Python 3.10+
- **Core:** Tree-sitter (18 languages), SQLite (WAL + FTS5), NetworkX, FastMCP, optional embeddings

### Architecture
**Parsing → Graph Store → Impact Analysis → MCP Tools**
- `parser.py`—Tree-sitter AST to nodes + edges
- `graph.py`—SQLite store, BFS impact radius
- `incremental.py`—Git-based detection, <2sec re-parse
- `tools.py`—22 MCP tools (build, impact, context, query, search, embed, flows, communities, wiki)
- `flows.py`—Execution flow detection, criticality
- `communities.py`—Leiden algorithm, architecture overview
- `changes.py`—Risk-scored impact
- `refactor.py`—Rename preview, dead code
- `visualization.py`—D3.js interactive HTML

**Key innovation: Blast Radius**
When file changes, compute minimal read set:
1. Find direct callers/dependents
2. Recursively trace call chains
3. Identify test gaps
4. Return only affected code

### Benchmarks
Real data (6 commits per repo):

| Repo | Size | Tokens (Std) | Tokens (Graph) | Reduction | Quality |
|------|-----:|-------------:|---------------:|----------:|--------:|
| httpx | 125 files | 12,507 | 458 | **26.2x** | 9.0 vs 7.0 |
| FastAPI | 2,915 files | 5,495 | 871 | **8.1x** | 8.5 vs 7.5 |
| Next.js | 27,732 files | 21,614 | 4,457 | **6.0x** | 9.0 vs 7.0 |
| **Average** | | **13,205** | **1,928** | **6.8x** | **8.8 vs 7.2** |

Monorepo case (Next.js): 27K files narrowed to ~15 = **49x reduction**.

### Maturity & Stars
- **Status:** v2.0.0 stable
- **Lines of code:** ~12,468
- **Languages:** 18 support
- **Platforms:** Claude Code, Cursor, Windsurf, Zed, Continue, OpenCode
- **Test suite:** 486+ tests, CI matrix

### How It Relates to Genie
Genie lacks impact-aware context selection. code-review-graph provides:
- Build structural graph once
- Incrementally update on changes
- Compute exact impact radius
- Provide minimal, high-signal context

**Integration:** Use SQLite graph as Genie's index; expose impact tools for change analysis; answer "what breaks?"

### Jaya's Context Graph Thesis Connection
code-review-graph is the **"change impact" layer**—answers what's affected, minimal context needed, test breaks, architecture ripple. This is change-aware context that makes reviews smarter.

---

## 5. SUPERMEMORY (supermemoryai)

**Path:** `/home/genie/agents/namastexlabs/genie/tools/research/supermemory/`

### What It Is
A **state-of-the-art memory and context engine** for AI. Extracts facts from conversations, maintains user profiles, handles contradictions, auto-forgets stale info. **#1 on 3 benchmarks** (LongMemEval, LoCoMo, ConvoMem).

### Tech Stack
- **Architecture:** Turbo monorepo (Next.js + Hono)
- **Languages:** TypeScript/React
- **Core:** Better Auth, Drizzle ORM, Cloudflare Workers, Hyperdrive, Zod, Hono, Sentry

### Architecture
**Monorepo:**
- `apps/web/`—Next.js UI + dashboard
- `apps/mcp/`—MCP server + memory graph
- `packages/*`—Shared SDK (npm + PyPI)

**Memory Engine:**
- Content processing (detection, summarization, tagging, embedding, chunking)
- Memory extraction (facts + metadata)
- Contradiction resolution
- User profiles (static + dynamic)
- Connectors (Google Drive, Gmail, Notion, OneDrive, GitHub)
- Search modes (hybrid, memories-only, documents-only)

### Benchmarks
| Benchmark | Result |
|-----------|--------|
| **LongMemEval** | **81.6% — #1** |
| **LoCoMo** | **#1** |
| **ConvoMem** | **#1** |

### How It Solves Context
**Problem:** Agents forget between conversations; RAG is stateless; no temporal understanding.

**Solution:**
1. Persistent memory across sessions
2. Automatic extraction (learns what to remember)
3. Contradiction handling (resolves conflicts)
4. Temporal decay (facts expire)
5. User profiles (50ms retrieval of ~50 facts)
6. Hybrid search (RAG + memory)
7. Connectors (sync from external sources)

### Maturity & Stars
- **Status:** Production (API + web + plugins + MCP)
- **Lines of code:** ~9,085
- **SDK:** npm + PyPI
- **Integrations:** Vercel AI, LangChain, LangGraph, OpenAI, Mastra, Claude Memory Tool, n8n
- **Plugins:** Claude Code, OpenCode, OpenClaw (open-source)

### How It Relates to Genie
Genie has no persistent user/context memory. Supermemory provides:
- Store user preferences, past decisions, project context
- Auto-extract facts from conversations
- Retrieve memories + user profile at query time
- Handle contradictions gracefully

**Integration:** Wrap Genie as Supermemory client; call `client.add()` on interactions; call `client.profile()` at session start; use hybrid search.

### Jaya's Context Graph Thesis Connection
Supermemory is the **"user context" layer**—enables long-term user memory, persistent learning, personalized retrieval, contradiction detection. This is human-aware context that makes agents feel like they know you.

---

## SYNTHESIS: The Five-Layer Context Architecture

### The Trillion-Dollar Problem
AI agents are expensive and forgetful:
- Context costs: Each query re-reads entire codebases/docs/histories
- Token waste: Reading 27K files to understand 15 affected files (49x bloat)
- Amnesia: Agents forget learnings between sessions
- Black boxes: Decisions have no audit trail
- Redundancy: Agents re-explore same patterns

### The Stack

```
┌─────────────────────────────────────────────────┐
│ Layer 5: User Context (Supermemory)            │
│ What: Persistent user profiles + preferences    │
│ Why: Personalization, long-term memory          │
│ How: Auto-extraction, contradiction resolution  │
└─────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│ Layer 4: Decision Intelligence (Semantica)     │
│ What: Why decisions were made, causal chains    │
│ Why: Auditability, explainability, governance   │
│ How: Decision graphs, precedent search          │
└─────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│ Layer 3: Change Impact (code-review-graph)     │
│ What: What's affected by code changes           │
│ Why: Token efficiency, precise context          │
│ How: Blast radius analysis, incremental index   │
└─────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│ Layer 2: Code Structure (CodeGraphContext)     │
│ What: Functions, classes, dependencies          │
│ Why: Multi-language, queryable, relationship    │
│ How: Tree-sitter AST → graph DB queries         │
└─────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│ Layer 1: Persistent Memory (Context+)          │
│ What: Session learnings, semantic links         │
│ Why: Avoid re-exploration, decay old info       │
│ How: Memory graph + embeddings + Ollama         │
└─────────────────────────────────────────────────┘
```

### How Each Maps to Jaya's Thesis

| Layer | Repo | Solves | Jaya Connection |
|-------|------|--------|-----------------|
| 1 | Context+ | Session memory + retrieval | "Remember" — avoid re-exploration |
| 2 | CodeGraphContext | Code structure + relationships | "What" — understand the system |
| 3 | code-review-graph | Change impact + context selection | "Precise" — minimal context |
| 4 | Semantica | Decision tracking + precedents | "Why" — explainability + governance |
| 5 | Supermemory | User profiles + long-term memory | "Who" — personalized context |

### Patterns Across All Five

1. **Graph-based representation**—all use graphs
2. **Multi-language support**—10+ languages each
3. **MCP compatibility**—expose MCP servers
4. **Incremental updates**—fast re-indexing
5. **Semantic search**—embeddings for meaning
6. **Auditability**—preserve lineage/provenance
7. **Decay/forgetting**—age information
8. **Integration ready**—designed to compose

### Where Genie Should Integrate

**Current:** Genie = orchestration layer (routing, tools, workflow)

**Missing:** Persistent, multi-modal context engine

**Recommended stack:**

```python
from contextplus import MemoryGraph
from codegraphcontext import CodeGraph
from code_review_graph import GraphStore
from semantica import ContextGraph, DecisionRecorder, PolicyEngine
from supermemory import Supermemory

class GemieContextEngine:
    def __init__(self):
        self.memory = MemoryGraph()  # Layer 1
        self.code_graph = CodeGraph()  # Layer 2
        self.impact = GraphStore()  # Layer 3
        self.decisions = ContextGraph()  # Layer 4
        self.user = Supermemory()  # Layer 5
    
    def start_session(self, user_id, task_desc):
        user_profile = self.user.profile(user_id)
        session_memory = self.memory.search(task_desc)
        return (user_profile, session_memory)
    
    def record_decision(self, action, reasoning, outcome):
        decision_id = self.decisions.record_decision(
            category=action.type,
            reasoning=reasoning,
            outcome=outcome
        )
        self.memory.upsert_node({
            "id": f"decision_{decision_id}",
            "content": reasoning,
            "type": "decision"
        })
        return decision_id
    
    def analyze_change(self, filepath):
        affected = self.impact.get_impact_radius(filepath)
        return affected
```

### The "Why Genie" Case

**Current state:** Genie = tool orchestrator (powerful but stateless)

**With context layer:** Genie = **agent OS** with:
- Persistent memory across sessions
- Structured code understanding
- Change-aware context selection
- Decision tracking + governance
- User preference injection

This is what makes agents "agents"—not just tool dispatch, but memory + reasoning + learning.

---

## Recommendations for Genie

### Phase 1: Minimal Viable Context (3-4 weeks)
1. Integrate CodeGraphContext—index Genie's own repo
2. Integrate Context+—session-scoped memory graph
3. Expose via MCP: `code_search`, `memory_search`, `semantic_navigate`

### Phase 2: Decision Tracking (4-6 weeks)
1. Integrate Semantica—record every agent action as decision
2. Decision tree visualization—show what/why/impact
3. Precedent search—avoid re-exploration

### Phase 3: Full Stack (6-8 weeks)
1. Integrate Supermemory—user profiles + long-term memory
2. Change impact analysis—code-review-graph for repo changes
3. Unified context API—single call retrieves all 5 layers

### Implementation Checkpoints
- [ ] Layer 1: Context+ memory working locally
- [ ] Layer 2: CodeGraphContext indexing Genie repo
- [ ] Layer 3: code-review-graph tracking changes
- [ ] Layer 4: Semantica decision recorder live
- [ ] Layer 5: Supermemory MCP endpoint live
- [ ] Unified API: One call returns all 5 layers
- [ ] Benchmarks: Token reduction, latency, accuracy

### Success Criteria
1. **Context efficiency:** 5-10x token reduction
2. **Memory persistence:** 80%+ useful retrieval across sessions
3. **Decision auditing:** 100% of actions logged + queryable
4. **Change awareness:** 99%+ accuracy on impact radius
5. **User adaptation:** Personalized context improves task success by 20%+

---

## References

- **Semantica:** https://github.com/Hawksight-AI/semantica (v0.3.0)
- **CodeGraphContext:** https://github.com/CodeGraphContext/CodeGraphContext (v0.3.1)
- **Context+:** https://github.com/ForLoopCodes/contextplus
- **code-review-graph:** https://github.com/tirth8205/code-review-graph (v2.0.0)
- **Supermemory:** https://github.com/supermemoryai/supermemory

**Benchmarks sourced from:**
- LongMemEval: https://github.com/xiaowu0162/LongMemEval
- LoCoMo: https://github.com/snap-research/locomo
- ConvoMem: https://github.com/Salesforce/ConvoMem
- code-review-graph: Real git commits on httpx, FastAPI, Next.js

---

## Document Metadata

- **Type:** Entity
- **Tags:** context-graph, code-intelligence, research, trillion-dollar
- **Date:** 2025-03-26
- **Repos analyzed:** 5 (semantica, CodeGraphContext, contextplus, code-review-graph, supermemory)
- **Total LOC reviewed:** ~47,048 lines
- **Focus:** "Context trillion-dollar problem"—enabling AI agents with structured, queryable, persistent context
