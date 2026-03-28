# Wish: Voice & Personality Pass

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `voice-personality-pass` |
| **Date** | 2026-03-24 |

## Summary

Polish tone throughout docs: add personality, humor, Genie opinions, Discord links, and voice-forward copy. Make Genie feel opinionated and human. Final varnish on all doc pages.

## Scope

### IN
- Review all Mintlify pages for tone consistency
- Add Discord links to key pages (index, hacks, concepts)
- Add Easter eggs / personality touches to doc headers
- Rewrite any remaining corporate/generic copy
- Ensure "Genie has opinions" positioning throughout
- Voice: exhausted but helpful, opinionated, future-forward

### OUT
- Major rewrites of technical docs (architecture, CLI reference)
- Video content or GIFs

## Success Criteria

- [ ] Tone is consistent across all pages (voice-forward, opinionated)
- [ ] Discord link present in 5+ key pages
- [ ] At least 3 Easter eggs / personality touches
- [ ] No generic corporate language remaining
- [ ] "Genie has opinions" evident in key pages

## Execution Strategy

### Wave 1
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | writer | Voice pass: key pages (index, quickstart, concepts, hacks) |
| 2 | writer | Discord links + Easter eggs |

### Wave 2
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | reviewer | Tone consistency, personality check |

## Execution Groups

### Group 1: Voice Pass (Key Pages)

**Goal:** Inject personality and voice into key pages.

**Deliverables:**
1. Review and tone-enhance:
   - `genie/index.mdx` — check tone is opinionated, exhaustion-driven
   - `genie/quickstart.mdx` — make instructions feel friendly, human
   - `genie/concepts/wishes.mdx` — add personality to concept explanations
   - `genie/hacks.mdx` — ensure community-first tone

2. Look for and replace:
   - Generic: "Genie is a CLI..." → Opinionated: "Genie doesn't care..."
   - Corporate: "optimize your workflow" → Human: "stop re-explaining"
   - Passive: "can be used" → Active: "use it to..."

**Acceptance Criteria:**
- [ ] All key pages reviewed
- [ ] Generic language replaced with voice-forward copy
- [ ] Personality evident (opinions, humor, exhaustion-driven narrative)
- [ ] Technical accuracy unchanged

**Validation:**
```bash
# Check for personality markers
grep -l "opinion\|we\|you\|don't\|we're" /tmp/automagik-docs/genie/*.mdx | wc -l
```

**depends-on:** none

---

### Group 2: Discord Links + Easter Eggs

**Goal:** Add community links and personality touches.

**Deliverables:**
1. Add Discord links to:
   - `genie/index.mdx` — "Join us on Discord"
   - `genie/hacks.mdx` — "Share your hack on Discord"
   - `genie/concepts/byoa.mdx` — "Questions? Discord"
   - `genie/quickstart.mdx` — "Stuck? Ask on Discord"
   - `genie/contributing.mdx` — "Contribute on Discord + GitHub"

2. Add 3+ Easter eggs:
   - Doc header jokes (e.g., "Genie is exhausted for you")
   - Personality asides (e.g., "We don't care which AI you use")
   - Gentle warnings (e.g., "Don't re-explain to every agent")

**Acceptance Criteria:**
- [ ] Discord link in 5+ pages
- [ ] 3+ Easter eggs added (personality touches)
- [ ] Links are valid (no 404s)
- [ ] Easter eggs are appropriate (not offensive, aligned with brand)

**Validation:**
```bash
grep -c "discord\|Discord" /tmp/automagik-docs/genie/*.mdx
grep -c "Genie\|we\|opinion" /tmp/automagik-docs/genie/index.mdx
```

**depends-on:** 1

---

### Group 3: Review (Tone Consistency)

**Goal:** Validate tone is consistent, personality is evident, no broken links.

**Deliverables:**
1. Checklist:
   - Tone is consistent across all pages (voice-forward, opinionated)
   - No remaining generic/corporate language
   - Discord links all work
   - Easter eggs feel authentic (not forced)
   - Technical content accuracy unchanged

**Acceptance Criteria:**
- [ ] Tone consistent throughout
- [ ] No broken links
- [ ] Personality evident

**depends-on:** 1, 2

## Files to Modify

```
/tmp/automagik-docs/genie/index.mdx              (tone + Discord)
/tmp/automagik-docs/genie/quickstart.mdx         (tone + Discord)
/tmp/automagik-docs/genie/concepts/*.mdx         (tone pass)
/tmp/automagik-docs/genie/hacks.mdx              (tone + Discord)
/tmp/automagik-docs/genie/contributing.mdx       (Discord link)
```

