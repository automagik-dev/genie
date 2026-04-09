# Wish: Feature Matrix Page

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `feature-matrix-page` |
| **Date** | 2026-03-24 |

## Summary

Create a dedicated "Features" page showcasing Genie's 8 core capabilities in a matrix format with links to detailed docs. Designed for skimmable visual reference and deep-dive links.

## Scope

### IN
- New page: `genie/features.mdx` — 8-core-capabilities matrix
- Each capability has: name, what it does, link to docs
- Visual card-based layout (Mintlify CardGroup)
- Add to docs.json navigation

### OUT
- Comparison charts vs other tools (out of scope)
- Capability deep-dives (link to existing docs instead)
- Performance benchmarks (separate wish)

## Success Criteria

- [ ] Page exists with 8 capabilities clearly listed
- [ ] Each capability has: name, 1-line description, link to docs
- [ ] Card/visual layout is clean and skimmable
- [ ] All links are valid (no 404s)
- [ ] Integrated into docs navigation

## Execution Groups

### Group 1: Create Features Page

**Goal:** Write features page with 8 capabilities.

**Deliverables:**
1. `genie/features.mdx` with:
   - Intro: "8 capabilities that make Genie work"
   - CardGroup with 8 cards:
     1. Wishes (Structured Intent)
     2. Pipeline (brainstorm → ship)
     3. Team Orchestration
     4. Persistent State
     5. Real-time Coordination
     6. Context Preservation
     7. 14 Skills
     8. Provider Agnosticism (BYOA)
   - Each card: title, 1-line description, link to docs
   - Footer: "Learn more → Concepts, CLI Reference, Architecture"

**Acceptance Criteria:**
- [ ] 8 capabilities listed
- [ ] Each has link to relevant doc page
- [ ] No broken links
- [ ] Clean card layout

**Validation:**
```bash
grep -c "^##\|Card" /tmp/automagik-docs/genie/features.mdx
```

**depends-on:** none

---

### Group 2: Integrate into Navigation

**Goal:** Add features page to docs.json and homepage.

**Deliverables:**
1. Update docs.json: add features page
2. Update index.mdx: add "Features" card linking to features page

**Acceptance Criteria:**
- [ ] docs.json valid (no schema errors)
- [ ] Features page accessible from navbar
- [ ] Index page links to features page

**Validation:**
```bash
jq . /tmp/automagik-docs/docs.json | grep -q features
```

**depends-on:** 1

## Files to Create/Modify

```
/tmp/automagik-docs/genie/features.mdx          (create)
/tmp/automagik-docs/docs.json                   (update navigation)
/tmp/automagik-docs/genie/index.mdx             (add card linking to features)
```

