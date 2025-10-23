# Agent vs Workflow Pattern - Architecture Explained
**Date:** 2025-10-23
**Question:** Why do we have both `agents/wish.md` AND `code/workflows/wish.md`?

---

## 🎯 THE ANSWER: **Intentional Architecture** ✅

The pattern is **delegation routing**:
- **Agent** = Thin router that delegates to collective-specific workflows
- **Workflow** = Full execution procedure for that collective

---

## 📖 CONCRETE EXAMPLE: Wish

### **agents/wish.md** (25 lines) - **Router**
```markdown
Purpose: Start wish authoring from any context. Delegate to the right domain wish agent.

Delegation:
- Research/content: create/wish (planning, blueprinting)
- Software delivery: code/workflows/wish.md

Pattern:
mcp__genie__run agent="create/wish" prompt="Author wish for <intent>..."
```

**Role:** Thin router - decides which collective to delegate to

---

### **code/workflows/wish.md** (218 lines) - **Full Execution**
```markdown
Identity: The Wish Dance Orchestrator

Steps:
1. Discovery - Resonate with the idea
2. Alignment - Validate against roadmap
3. Requirements - Clarify scope
4. Blueprint - Create wish document

Operating Principles:
- Progressive trust building
- Context Ledger growth
- Delegation protocol
```

**Role:** Full wish workflow FOR CODE COLLECTIVE

---

### **create/workflows/wish.md** (58 lines) - **Different Execution**
**Role:** Full wish workflow FOR CREATE COLLECTIVE (content creation focus)

---

## 🧩 THE PATTERN EVERYWHERE

### **Forge:**
- **`agents/forge.md`** (thin router) → delegates to:
  - `code/workflows/forge.md` (software execution)
  - `create/workflows/forge.md` (content execution)

### **Review:**
- **`agents/review.md`** (thin router) → delegates to:
  - `code/agents/review.md` (code review process)
  - `code/workflows/review.md` (review workflow)

### **Install:**
- **`code/agents/install.md`** (full agent - no router needed, Code-specific)
- **`code/workflows/install.md`** (install workflow for Code)
- **`create/agents/install.md`** (full agent for Create)
- **`create/workflows/install.md`** (install workflow for Create)

---

## 🏗️ WHY THIS ARCHITECTURE?

### **1. Collective Separation**
Code and Create collectives have different:
- Identity (technical vs creative)
- Workflows (PR-based vs content-based)
- Success criteria (tests pass vs clarity achieved)
- Tools (Git, CI/CD vs style guides, publishing)

### **2. Universal Entry Points**
User says "I want to make a wish" → doesn't need to know if it's code or create
- Router agent figures it out
- Delegates to correct collective workflow

### **3. Delegation Hierarchy**
```
Base Genie
  ↓
Global Agent (router)
  ↓
Collective Workflow (execution)
```

---

## 🎯 AGENT vs WORKFLOW DISTINCTION

| Type | Purpose | Size | Example |
|------|---------|------|---------|
| **Agent (Router)** | Thin delegation logic | 25-50 lines | `agents/wish.md` |
| **Workflow** | Full execution procedure | 200-500 lines | `code/workflows/wish.md` |
| **Agent (Specialist)** | Full execution (no routing needed) | 200+ lines | `code/agents/implementor.md` |

---

## ✅ CONCLUSION: **NOT DUPLICATION**

This is **intentional separation of concerns**:
- Agents at root = routers (decide which collective)
- Workflows in collectives = execution (how to do it)
- Some agents are specialists (no routing, just execute)

**Recommendation:** KEEP AS-IS - This is good architecture ✅

---

## 🤔 ONE POTENTIAL CLEANUP

**Install agents** might be duplicated:
- `code/agents/install.md` + `code/workflows/install.md`
- `create/agents/install.md` + `create/workflows/install.md`

**Question:** Should install be an agent OR a workflow in each collective, not both?

**Action:** Needs Felipe's clarification - are install agents doing different things than install workflows?
