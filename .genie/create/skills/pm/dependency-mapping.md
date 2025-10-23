# Dependency Mapping
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Domain:** Project Management

## Purpose
Identify, visualize, and manage dependencies between tasks, teams, and systems to prevent blockers and delays.

## When to Use
- Project planning (multi-team coordination)
- Sprint planning (identify blockers early)
- Architecture decisions (system dependencies)
- Risk management (critical path analysis)

## Core Framework

### Dependency Types
1. **Finish-to-Start (FS):** Task B starts after Task A finishes (most common)
2. **Start-to-Start (SS):** Task B starts when Task A starts (parallel)
3. **Finish-to-Finish (FF):** Task B finishes when Task A finishes
4. **Start-to-Finish (SF):** Task B finishes when Task A starts (rare)

### Dependency Categories
- **Internal:** Within same team/project
- **External:** Cross-team or vendor dependencies
- **Hard:** Cannot proceed without (technical constraint)
- **Soft:** Can proceed but not ideal (preference)

### Mapping Techniques
**Critical Path Method (CPM):**
```
Identify longest chain of dependent tasks
Critical path = minimum project duration

Example:
A (5d) → B (3d) → D (2d) = 10 days (critical path)
A (5d) → C (1d) → D (2d) = 8 days (not critical)
```

## Outputs

### Dependency Matrix
**Store in:** `.genie/wishes/<project>/dependencies.md`

```markdown
| Task | Depends On | Blocks | Type | Risk | Owner | Status |
|------|------------|--------|------|------|-------|--------|
| Auth API | - | User Service, Web App | Hard | Low | @alice | ✅ Done |
| User Service | Auth API | Profile Feature | Hard | Medium | @bob | 🟡 In Progress |
| Profile Feature | User Service | - | Hard | High | @charlie | ⏸️ Blocked |
```

### Visual Dependency Graph
```
┌─────────────┐
│  Auth API   │ (Done)
└──────┬──────┘
       │
       ↓
┌─────────────┐     ┌─────────────┐
│ User Service│────→│   Web App   │
└──────┬──────┘     └─────────────┘
       │
       ↓
┌─────────────┐
│Profile Feat │ (Blocked)
└─────────────┘
```

## Never Do
- ❌ Hide dependencies (surface them early)
- ❌ Create circular dependencies (deadlock)
- ❌ Ignore external dependencies (they delay projects)
- ❌ Skip dependency review in sprint planning

## Related Skills
- `@.genie/create/skills/pm/sprint-planning.md`
- `@.genie/create/skills/pm/risk-management.md`
- `@.genie/create/skills/pm/roadmap-creation.md`
