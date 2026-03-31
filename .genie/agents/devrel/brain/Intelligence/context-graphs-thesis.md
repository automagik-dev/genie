---
type: entity
created: 2026-03-26
updated: 2026-03-26
tags: [context-graphs, decision-traces, enterprise-ai, agents, x-research, jaya-gupta]
---

# "AI's Trillion-Dollar Opportunity: Context Graphs" — Jaya Gupta

**Source:** https://x.com/JayaGup10/status/2003525933534179480
**Date:** Dec 23, 2025 | **Views:** 4.82M | **Likes:** 6,899 | **Bookmarks:** 17,342
**Authors:** Jaya Gupta & Ashu Garg (Foundation Capital)

## The Core Thesis

The last generation of enterprise software created trillion-dollar businesses by becoming **systems of record** (Salesforce for customers, Workday for employees, SAP for operations). The next trillion-dollar platforms won't be built by adding AI to existing data — they'll be built by capturing **decision traces** that make data actionable.

### Systems of Record vs. Context Graphs

**Systems of record** capture WHAT happened (current state of objects — deals, tickets, employees).

**Context graphs** capture WHY it happened — the decision traces: exceptions, overrides, precedents, approvals, and cross-system context that currently live in Slack threads, deal desk conversations, escalation calls, and people's heads.

### The Missing Layer

What enterprises DON'T capture today:
1. **Exception logic in people's heads** — "We always give healthcare companies an extra 10% because their procurement cycles are brutal" (tribal knowledge, not in CRM)
2. **Precedent from past decisions** — "We structured a similar deal for Company X last quarter" (no system links those deals)
3. **Cross-system synthesis** — support lead checks ARR in Salesforce + escalations in Zendesk + Slack churn risk thread → decides to escalate. That synthesis happens in their head.
4. **Approval chains outside systems** — VP approves discount on Zoom call. CRM shows final price, not who approved or why.

### Why Agent Orchestration Startups Win

> "Systems of agents startups have a structural advantage: they're in the orchestration path."

When an agent orchestrates a workflow, it sees the FULL picture: what inputs were gathered, what policies applied, what exceptions were granted, and why. Because it's EXECUTING the workflow, it can capture context AT DECISION TIME — not after the fact via ETL.

**This is the context graph.** And it becomes "the single most valuable asset for companies in the era of AI."

### Why Incumbents Can't Build This

- **Salesforce/ServiceNow/Workday:** Built on current state storage. Can't replay state at decision time. Can't see cross-system context.
- **Snowflake/Databricks:** In the read path, not the write path. Receive data via ETL AFTER decisions are made. By the time data lands, decision context is gone.
- **Orchestration startups:** In the execution path at commit time. See everything. Can persist the "why."

### Three Startup Paths

1. **Replace existing SoR** — AI-native CRM/ERP with event-sourced state (e.g., Regie for sales)
2. **Replace modules** — Target specific sub-workflows where exceptions concentrate (e.g., Maximor for finance)
3. **Create entirely new SoR** — Start as orchestration, persist decision traces, become authoritative (e.g., PlayerZero for production engineering)

## Why This Matters for Genie

### Genie IS a Context Graph for Code

Every wish execution produces decision traces:
- **What was planned** (WISH.md with scope, criteria, execution groups)
- **What was decided** (10-critic council votes, review verdicts)
- **What exceptions were made** (FIX-FIRST loops, human overrides)
- **Who approved what** (review SHIP verdicts, human PR merges)
- **Why it was done this way** (brainstorm rationale, design decisions)

Genie's PostgreSQL-backed state, audit events, and session replay are EXACTLY the "queryable record of how decisions were made" that this article describes.

### The Event System IS Decision Lineage

Genie already emits:
- Session events (tool calls, permissions, state changes)
- Audit log (immutable, per-actor, timestamped)
- Wish state transitions (DRAFT → APPROVED → IN_PROGRESS → REVIEW → DONE)
- Task stage logs (who moved what through which stage, when, why)
- Cost tracking per entity

This IS decision trace infrastructure. It's just not positioned as such yet.

### The "Glue Function" Signal

The article says: look for "glue functions" — roles that exist because no single system owns the cross-functional workflow. **DevOps, RevOps, Security Ops.**

Genie sits at the intersection of: coding agents, git, GitHub, CI/CD, code review, project management. The "glue" between 7 AI tabs that don't talk to each other. That's the context collapse problem — and Genie's context graph (wishes, reviews, messages, events) captures what would otherwise live in a developer's head.

### Marketing Angle

> "The next trillion-dollar platforms will be built by capturing decision traces. Genie already does this for code. Every wish, every review, every agent message — it's all queryable. The question isn't whether AI can code. It's whether you can answer: why was this PR created, who approved the exceptions, and what precedent was it based on?"

### Connection to Karpathy's Bespoke Software

Karpathy's vision (bespoke software via agents) + Jaya's thesis (context graphs as the enduring layer) = Genie's architecture. Agents build bespoke software (wishes → PRs). The context graph (wish state, reviews, events) explains WHY.

## Key Quotes

> "Decision traces capture what happened in this specific case — we used X definition, under policy v3.2, with a VP exception, based on precedent Z"

> "Agents don't just need rules. They need access to the decision traces that show how rules were applied in the past"

> "A system that only sees reads, after the fact, can't be the system of record for decision lineage. It can tell you what happened, but it can't tell you why."

> "Capturing decision traces requires being in the execution path at commit time, not bolting on governance after the fact."

## Stats
- 4.82M views, 17,342 bookmarks — extremely high bookmark-to-like ratio (2.5x) indicates this is REFERENCE material people save and share with teams
- Published Dec 2025, still circulating March 2026 — evergreen thesis
