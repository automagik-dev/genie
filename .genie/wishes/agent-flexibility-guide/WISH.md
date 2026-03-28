# Wish: Agent Flexibility Guide (Provider Switching + BYOA)

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `agent-flexibility-guide` |
| **Date** | 2026-03-24 |

## Summary

Document how to use Genie with different AI agents. Create a new page showing provider switching patterns, /spawn --provider flag usage, auto-respawn templates, and real multi-provider team examples. Position Genie as provider-agnostic.

## Scope

### IN
- New page: `genie/concepts/byoa.mdx` — BYOA positioning, examples, agent neutrality
- Document `/spawn --provider` flag with examples
- Show provider switching patterns (Claude ↔ Codex ↔ BYOA)
- Document auto-respawn template system
- Real examples: multi-provider teams, cost optimization, failover patterns
- Update `docs.json` to include BYOA concept page

### OUT
- Automatic failover logic (manual only, documented as patterns)
- Custom agent implementation guide (separate wish)
- Testing harness for agent compatibility (out of scope)

## Decisions

| Decision | Rationale |
|----------|-----------|
| New concept page | BYOA deserves first-class documentation, not buried in skills |
| `/spawn --provider` examples | Users need to know how to actually use it |
| Real patterns over theory | Show actual multi-provider teams, cost models |

## Success Criteria

- [ ] `genie/concepts/byoa.mdx` created with BYOA positioning
- [ ] `/spawn --provider` flag documented with 5+ examples
- [ ] Auto-respawn template system explained
- [ ] 3 real multi-provider team patterns shown (cost optimization, specialization, failover)
- [ ] BYOA concept in docs.json navigation
- [ ] No broken links
- [ ] Tone: vendor-neutral, empowering

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | writer | Create BYOA concept page + /spawn --provider docs |
| 2 | writer | Multi-provider patterns + examples |

### Wave 2
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | reviewer | Validate accuracy, no broken links, tone consistent |

## Execution Groups

### Group 1: BYOA Concept Page

**Goal:** Create new page explaining Genie's provider agnosticism.

**Deliverables:**
1. `genie/concepts/byoa.mdx` with:
   - Definition: BYOA = Bring Your Own Agent
   - Genie doesn't care which agent backs workers
   - List providers: Claude Code, Codex, Open Claw, Gemini CLI, custom
   - `/spawn --provider <provider>` flag usage
   - Auto-respawn template system (if agent goes offline, respawned from saved config)
   - Why it matters: future-proofs, no vendor lock-in

**Acceptance Criteria:**
- [ ] File exists at `/tmp/automagik-docs/genie/concepts/byoa.mdx`
- [ ] Explains /spawn --provider flag
- [ ] Lists 5+ provider options
- [ ] Auto-respawn system documented
- [ ] No broken links

**Validation:**
```bash
grep -q "BYOA\|--provider\|provider" /tmp/automagik-docs/genie/concepts/byoa.mdx
grep -q "auto-respawn\|template" /tmp/automagik-docs/genie/concepts/byoa.mdx
```

**depends-on:** none

---

### Group 2: Multi-Provider Patterns

**Goal:** Show 3 real patterns for using different agents together.

**Deliverables:**
1. Three patterns in BYOA page:
   - **Pattern 1: Specialization** — Claude for reasoning, Codex for parsing, BYOA for domain logic
   - **Pattern 2: Cost Optimization** — Use Codex for fast iteration, Claude for final review
   - **Pattern 3: Manual Fallback** — If one provider is down, spawn with another (not automatic)

2. Each pattern includes:
   - Problem statement
   - Solution (how to do it)
   - Code example (`genie spawn --provider <provider>`)
   - Benefit + trade-offs
   - When to use

**Acceptance Criteria:**
- [ ] 3 patterns documented
- [ ] Each has: problem, solution, code, benefit, when-to-use
- [ ] Examples are realistic, not aspirational
- [ ] Code examples show actual --provider flags

**Validation:**
```bash
grep -c "Pattern\|Example" /tmp/automagik-docs/genie/concepts/byoa.mdx
grep "genie spawn.*--provider" /tmp/automagik-docs/genie/concepts/byoa.mdx
```

**depends-on:** 1

---

### Group 3: Review

**Goal:** Validate accuracy and consistency.

**Deliverables:**
1. Checklist:
   - `/spawn --provider` syntax is accurate (not invented)
   - Patterns are realistic (not aspirational)
   - Links to other doc pages work
   - Tone is neutral (no vendor criticism)
   - Examples use actual provider names

**Acceptance Criteria:**
- [ ] No broken links
- [ ] Patterns match actual Genie capabilities
- [ ] Tone is neutral and empowering

**Validation:**
```bash
# Check for invented features
! grep -q "automatic failover\|auto-failover" /tmp/automagik-docs/genie/concepts/byoa.mdx
```

**depends-on:** 1, 2

## Files to Create/Modify

```
/tmp/automagik-docs/genie/concepts/byoa.mdx         (create)
/tmp/automagik-docs/docs.json                       (add BYOA page to navigation)
```

