# Wish: Remove OpenClaw Integration Entirely

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `remove-openclaw` |
| **Date** | 2026-03-31 |
| **Design** | N/A — straightforward removal |

## Summary

Remove all OpenClaw/ClawdBot integration code, documentation, assets, and references from the genie repository. OpenClaw is not a functional dependency — all references are documentation, UI plugin catalog entries in the Supermemory tool, and competitive intelligence in the brain directory. This is a clean deletion with no cascading code effects.

## Scope

### IN
- Remove Supermemory OpenClaw plugin documentation (`openclaw.mdx`)
- Remove OpenClaw/ClawdBot entries from Supermemory UI components (plugin catalog, auth connect page, integrations view)
- Remove OpenClaw navigation entries and redirects from Supermemory docs config (`docs.json`)
- Remove OpenClaw references from Supermemory `README.md`
- Remove OpenClaw static assets (logo, icon, video)
- Remove OpenClaw competitive intelligence documents from `brain/`
- Clean up any remaining incidental mentions in brainstorm/wish docs

### OUT
- Removing other Supermemory plugins (Claude Code, OpenCode) — only OpenClaw is targeted
- Refactoring Supermemory plugin system architecture — just remove the entries
- Removing OpenClaw mentions from git history — only current files
- Modifying Omni provider system — no OpenClaw provider exists there

## Decisions

| Decision | Rationale |
|----------|-----------|
| Delete brain intelligence docs entirely | These are competitive research about OpenClaw — not needed, and keeping them contradicts "remove entirely" |
| Clean incidental mentions in brainstorms/wishes | References like "competitive landscape (CrewAI, OpenClaw)" should be edited out for completeness |
| Keep Supermemory plugin infrastructure intact | Only remove OpenClaw entries, don't restructure the plugin catalog |

## Success Criteria

- [ ] `grep -ri "openclaw\|clawdbot\|open.claw" . --include='*.md' --include='*.mdx' --include='*.tsx' --include='*.ts' --include='*.json'` returns zero matches (excluding git objects)
- [ ] No OpenClaw static assets remain (logo, icon, video)
- [ ] Supermemory web app builds without errors after removal
- [ ] Supermemory docs build without broken navigation links

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Remove OpenClaw from Supermemory (docs, UI, config, assets) |
| 2 | engineer | Remove OpenClaw from brain intelligence and brainstorm docs |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Verify zero remaining references, builds pass |

## Execution Groups

### Group 1: Supermemory OpenClaw Removal
**Goal:** Remove all OpenClaw/ClawdBot integration from the Supermemory tool.

**Deliverables:**
1. Delete `tools/research/supermemory/apps/docs/integrations/openclaw.mdx`
2. Remove `clawdbot` plugin object from `tools/research/supermemory/apps/web/components/integrations/plugins-detail.tsx`
3. Remove ClawdBot image reference from `tools/research/supermemory/apps/web/components/integrations-view.tsx`
4. Remove `clawdbot` plugin info from `tools/research/supermemory/apps/web/app/auth/connect/page.tsx`
5. Remove OpenClaw navigation entry and redirect from `tools/research/supermemory/apps/docs/docs.json`
6. Remove OpenClaw references from `tools/research/supermemory/README.md`
7. Remove OpenClaw changelog mentions from `tools/research/supermemory/apps/docs/changelog/*.mdx`
8. Delete static assets: `apps/docs/images/openclaw-logo.jpg`, `apps/web/public/images/plugins/clawdbot.svg`

**Acceptance Criteria:**
- [ ] Zero matches for `openclaw|clawdbot` in `tools/research/supermemory/`
- [ ] No broken imports or missing references in TSX files
- [ ] `docs.json` navigation has no dangling entries

**Validation:**
```bash
cd tools/research/supermemory && grep -ri "openclaw\|clawdbot" --include='*.ts' --include='*.tsx' --include='*.mdx' --include='*.json' --include='*.md' . | wc -l | grep -q '^0$'
```

**depends-on:** none

---

### Group 2: Brain & Brainstorm Cleanup
**Goal:** Remove OpenClaw competitive intelligence and incidental references from brain and brainstorm documents.

**Deliverables:**
1. Delete `brain/Intelligence/openclaw-study.md`
2. Delete `brain/Intelligence/x-research/media/openclaw-release-963k.mp4`
3. Remove OpenClaw references from `brain/Intelligence/research-queue.md`
4. Remove OpenClaw references from `brain/Intelligence/strategic-positioning.md`
5. Remove OpenClaw references from `brain/DevRel/content-backlog.md`
6. Clean incidental OpenClaw mentions from remaining brain files (x-profiles, playbooks, context research, keynote notes)
7. Clean OpenClaw references from `.genie/brainstorms/agentic-shift-documentary/` scripts
8. Clean OpenClaw references from `.genie/wishes/brain-obsidian/WISH.md`

**Acceptance Criteria:**
- [ ] Zero matches for `openclaw|clawdbot` in `brain/` directory
- [ ] Zero matches for `openclaw|clawdbot` in `.genie/brainstorms/` and `.genie/wishes/` (excluding this wish)
- [ ] No broken markdown links or orphaned references

**Validation:**
```bash
grep -ri "openclaw\|clawdbot" brain/ .genie/brainstorms/ .genie/wishes/ --include='*.md' --include='*.mdx' | grep -v "remove-openclaw/WISH.md" | wc -l | grep -q '^0$'
```

**depends-on:** none

---

## QA Criteria

- [ ] `grep -ri "openclaw\|clawdbot" . --include='*.md' --include='*.mdx' --include='*.tsx' --include='*.ts' --include='*.json' | grep -v remove-openclaw` returns zero results
- [ ] No orphaned image references in TSX/MDX files
- [ ] Supermemory docs.json is valid JSON with no dangling navigation entries
- [ ] No TypeScript compilation errors in Supermemory web app

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| TSX components may have array index assumptions after removing plugin entry | Low | Review array/list rendering — likely map-based, no index issues |
| Removing brain docs may lose useful competitive framing | Low | User explicitly requested "entirely" — if needed later, git history preserves it |
| Changelog entries may read oddly with OpenClaw mentions removed | Low | Edit surrounding text for coherence rather than deleting entire changelog entries |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# DELETE
tools/research/supermemory/apps/docs/integrations/openclaw.mdx
tools/research/supermemory/apps/docs/images/openclaw-logo.jpg
tools/research/supermemory/apps/web/public/images/plugins/clawdbot.svg
brain/Intelligence/openclaw-study.md
brain/Intelligence/x-research/media/openclaw-release-963k.mp4

# MODIFY (remove openclaw/clawdbot references)
tools/research/supermemory/apps/web/components/integrations/plugins-detail.tsx
tools/research/supermemory/apps/web/components/integrations-view.tsx
tools/research/supermemory/apps/web/app/auth/connect/page.tsx
tools/research/supermemory/apps/docs/docs.json
tools/research/supermemory/apps/docs/changelog/overview.mdx
tools/research/supermemory/apps/docs/changelog/developer-platform.mdx
tools/research/supermemory/README.md
brain/Intelligence/research-queue.md
brain/Intelligence/strategic-positioning.md
brain/Intelligence/x-landscape-study.md
brain/Intelligence/context-layer-research.md
brain/Intelligence/huang-lex-fridman-podcast.md
brain/Intelligence/huang-gtc-2026-keynote.md
brain/Intelligence/karpathy-bespoke-software.md
brain/Intelligence/x-profiles/swyx.md
brain/Intelligence/x-profiles/danshipper.md
brain/Intelligence/x-profiles/heyshrutimishra.md
brain/Intelligence/x-profiles/huang_chao4969.md
brain/Intelligence/x-research/media/huang-video1.en.srt
brain/Intelligence/x-research/media/huang-video2.en.srt
brain/DevRel/content-backlog.md
brain/DevRel/x-bookmarks.md
brain/Playbooks/viral-video-patterns.md
brain/Playbooks/shared-brain-architecture.md
brain/Playbooks/knowledge-migration-plan.md
.genie/brainstorms/agentic-shift-documentary/SCRIPT.md
.genie/brainstorms/agentic-shift-documentary/SCRIPT-v2.md
.genie/brainstorms/agentic-shift-documentary/DRAFT.md
.genie/wishes/brain-obsidian/WISH.md
```
