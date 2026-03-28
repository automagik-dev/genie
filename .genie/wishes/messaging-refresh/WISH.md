# Wish: Messaging Refresh (2050 Framing + BYOA Positioning)

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `messaging-refresh` |
| **Date** | 2026-03-24 |

## Summary

Rewrite core Mintlify docs (index, quickstart, Why Genie) with 2050 framing, context collapse narrative, BYOA positioning, personality, and Research Preview callouts. Shift from "tool" language to "orchestration layer" and "conductor" metaphors. Add desktop roadmap mentions.

## Scope

### IN
- Rewrite `genie/index.mdx` — What is Genie (2050 framing, context collapse, BYOA)
- Rewrite `genie/quickstart.mdx` — Add "pick your agent" step, BYOA examples
- Rewrite "Why Genie?" section — Exhaustion-driven problem narrative, personality, voice
- Add Research Preview callouts to index and quickstart
- Add desktop roadmap mention (Q2 2026)
- Inject provider examples (Claude, Codex, BYOA)
- Link to /genie/hacks page (community patterns)

### OUT
- Video content (no GIFs, no videos)
- Modify architecture or skills pages (messaging-only, not structural)
- Desktop product itself (only mention roadmap)
- Vendor criticism or FUD (position neutrally as agnostic)

## Decisions

| Decision | Rationale |
|----------|-----------|
| 2050 framing (AI is normal) | Context collapse is the real problem, not "AI doing work" |
| "Orchestration layer" over "tool" | Positions Genie as protocol/system, not client |
| Exhaustion-driven narrative | Users feel context collapse daily; relatable entry point |
| BYOA over vendor lock-in | Future-proofs positioning; no bet on one vendor |
| Research Preview badge | Honest about experimental status; invites participation |

## Success Criteria

- [ ] `genie/index.mdx` rewritten with 2050 framing + context collapse problem statement
- [ ] Mentions "conductor not orchestra" metaphor or similar
- [ ] BYOA clearly explained (Claude, Codex, BYOA/custom)
- [ ] Research Preview callout present
- [ ] Desktop roadmap mentioned (Q2 2026)
- [ ] `genie/quickstart.mdx` has "pick your agent" step
- [ ] "Why Genie?" section rewritten with personality + exhaustion narrative
- [ ] Links to /genie/hacks page (if it exists)
- [ ] No broken links in modified pages
- [ ] Tone: opinionated, future-forward, helpful, not salesy

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Rewrite index.mdx with 2050 framing + messaging |
| 2 | engineer | Rewrite quickstart.mdx with agent choice step |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Rewrite "Why Genie?" with personality + voice |
| 4 | reviewer | Validate tone, no broken links, messaging consistency |

## Execution Groups

### Group 1: Index Rewrite (2050 Framing)

**Goal:** Rewrite `genie/index.mdx` to position Genie as orchestration layer, not tool. Use 2050 context, context collapse problem, BYOA positioning.

**Deliverables:**
1. Index page with new structure:
   - Headline: "Genie is the orchestration layer for multi-agent development"
   - 2050 framing: "AI agents are table stakes. The problem isn't whether they can code—it's whether they can code together"
   - Context collapse narrative: 5 agents diverging, re-explaining, hallucinating
   - Solution: "Genie is the conductor"
   - BYOA section: Claude, Codex, BYOA/custom examples
   - 8 Core Capabilities table (from feature list)
   - Research Preview callout
   - Desktop roadmap mention (Q2 2026)
   - Links: to quickstart, Discord, docs

**Acceptance Criteria:**
- [ ] File at `/tmp/automagik-docs/genie/index.mdx`
- [ ] Contains "context collapse" narrative (explicit problem statement)
- [ ] Contains "conductor" or "orchestration layer" metaphor
- [ ] BYOA section with 3+ provider examples
- [ ] Research Preview callout present
- [ ] Desktop roadmap mentioned
- [ ] 8-core-capabilities matrix included
- [ ] No broken markdown links

**Validation:**
```bash
grep -q "context collapse\|orchestration layer" /tmp/automagik-docs/genie/index.mdx
grep -q "Research Preview\|experimental" /tmp/automagik-docs/genie/index.mdx
grep -q "Q2 2026\|desktop" /tmp/automagik-docs/genie/index.mdx
```

**depends-on:** none

---

### Group 2: Quickstart Rewrite (Agent Choice)

**Goal:** Add "pick your agent" step to quickstart. Show Claude Code, Codex, BYOA options.

**Deliverables:**
1. New step in quickstart:
   - Title: "Choose Your Agent"
   - Brief explanation: Genie works with any agent
   - List 4 options: Claude Code, Codex, Open Claw, Custom
   - Recommend Claude Code (but empowered to choose)
   - Joke/personality touch ("we don't care which one you marry")

**Acceptance Criteria:**
- [ ] Step added to quickstart flow (positioned between Install and main steps)
- [ ] Lists: Claude Code, Codex, Open Claw, Custom
- [ ] Includes tone/voice ("agent-agnostic")
- [ ] No broken links

**Validation:**
```bash
grep -q "Choose Your Agent\|provider\|agent" /tmp/automagik-docs/genie/quickstart.mdx
```

**depends-on:** none

---

### Group 3: Why Genie Rewrite (Personality + Voice)

**Goal:** Rewrite "Why Genie?" section with personality, exhaustion-driven narrative, and opinionated tone.

**Deliverables:**
1. Rewrite "Why Genie?" with:
   - **Context Collapse Problem** (narrative: 7 tabs, each forgot context, you re-explained 3 times)
   - **How Genie Fixes It** (capture once, broadcast to agents, coordinated execution)
   - **What This Gives You** (bullets: no re-explaining, parallel, reproducible, overnight mode, BYOA, portable)
   - **Personality**: "We're testing if orchestration is the missing piece" (Research Preview)
   - Discord link at end
   - Tone: exhausted but hopeful, opinionated, not salesy

**Acceptance Criteria:**
- [ ] Narrative about context collapse (7 tabs scenario)
- [ ] Problem → Solution → Benefits structure
- [ ] Research Preview mentioned
- [ ] Discord link present
- [ ] Tone is voice-forward (personality, opinions)
- [ ] No sales language

**Validation:**
```bash
grep -q "context collapse\|7.*tabs\|exhausted" /tmp/automagik-docs/genie/index.mdx
grep -q "discord\|Discord" /tmp/automagik-docs/genie/index.mdx
```

**depends-on:** 1

---

### Group 4: Review (Tone + Consistency)

**Goal:** Validate messaging consistency, tone, no broken links.

**Deliverables:**
1. Review checklist:
   - All pages use consistent "2050 framing" language
   - No vendor criticism (neutral BYOA positioning)
   - Tone is consistent (exhaustion-driven, opinionated, helpful)
   - All links are valid (no 404s)
   - Research Preview mentioned in intro + quickstart
   - Desktop roadmap in multiple places (index, quickstart)
   - BYOA explained clearly (3+ examples)

**Acceptance Criteria:**
- [ ] Tone consistent across index, quickstart, Why pages
- [ ] No broken links (validate markdown syntax)
- [ ] Research Preview present in 2+ places
- [ ] Desktop roadmap in 2+ places
- [ ] BYOA explained with examples

**Validation:**
```bash
# Check tone consistency
grep -c "orchestration\|conductor\|2050" /tmp/automagik-docs/genie/index.mdx
grep -c "Research Preview" /tmp/automagik-docs/genie/index.mdx

# No broken links
grep -E "\[.*\]\(.*\)" /tmp/automagik-docs/genie/index.mdx | wc -l
```

**depends-on:** 1, 2, 3

## Success Criteria

- [ ] All 3 pages (index, quickstart, Why) rewritten
- [ ] 2050 framing consistent throughout
- [ ] BYOA explained with examples
- [ ] Research Preview callout in 2+ places
- [ ] Desktop roadmap mentioned
- [ ] Tone: exhaustion-driven, opinionated, personality-forward
- [ ] No broken links
- [ ] Mintlify docs site renders without errors

## Files to Create/Modify

```
/tmp/automagik-docs/genie/index.mdx          (rewrite)
/tmp/automagik-docs/genie/quickstart.mdx     (add agent choice step)
/tmp/automagik-docs/genie/index.mdx          (rewrite Why section)
```

