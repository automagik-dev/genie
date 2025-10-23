---
name: URL Presentation Protocol
description: Full URLs are sacred. Never truncate action items. URLs are interfaces, not decorations.
---

# URL Presentation Protocol

## Core Principle 🔴 CRITICAL

**Full URLs Are Sacred - Never Truncate Action Items**

URLs are PRIMARY interfaces for accessing work, not decorative metadata. User workflow depends on clicking them.

## The Violation

❌ **Wrong Presentation:**
```
Forge URL: http://localhost:8887/projects/.../ff8b5629...
```

✅ **Correct Presentation:**
```
Forge URL: http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/ff8b5629-fbfd-4418-8017-b076042de756/attempts/ff8b5629-fbfd-4418-8017-b076042de756?view=diffs
```

**Why This Matters:**
> "returning me the url of the tasks at all times is very important"
> — User teaching, 2025-10-23

**Impact of Truncation:**
- ❌ User can't click truncated URL
- ❌ User can't copy-paste to browser
- ❌ Must manually search Forge UI for task
- ❌ Extra friction in workflow
- ❌ Defeats entire purpose of providing URL

## URL Semantics

### Forge Task URL Structure

```
http://localhost:8887/projects/{project_id}/tasks/{task_id}/attempts/{attempt_id}?view={mode}

Components:
- project_id:  ee8f0a72-44da-411d-a23e-f2c6529b62ce (UUID)
- task_id:     ff8b5629-fbfd-4418-8017-b076042de756 (UUID)
- attempt_id:  ff8b5629-fbfd-4418-8017-b076042de756 (usually same as task_id)
- view mode:   diffs | preview (CRITICAL - controls interface behavior)
```

### Query Parameters - NOT Optional

**`?view=diffs`** — Code/text editing view
- For backend work, API changes, configuration
- Shows code diffs, file edits, text changes
- Pair programming on code

**`?view=preview`** — Frontend real-time UI preview
- For UI work, component development, styling
- Shows live preview of frontend changes
- Pair programming on visual interface
- Real-time rendering as code changes

**These are NOT decorations - they control the VIEW MODE that user sees.**

## Protocol for URL Presentation

### Rule 1: Never Truncate Functional Links

**URLs are ACTION ITEMS, not decorations.**

```
Full URL = User can click/copy → Access work immediately
Partial URL = Useless → Must search manually
```

**Think of URLs like:**
- Door keys (truncated key doesn't unlock door)
- Phone numbers (partial number doesn't call)
- Coordinates (approximate location doesn't navigate)

### Rule 2: Preserve Query Parameters

**Query parameters control interface behavior - they're part of the link.**

❌ **Wrong:**
```
http://localhost:8887/projects/abc123/tasks/def456
```

✅ **Right:**
```
http://localhost:8887/projects/abc123/tasks/def456?view=diffs
```

**The `?view=` parameter determines what the user sees. Without it, they may get wrong view.**

### Rule 3: Format for Visibility

**Make URLs easy to find, click, and copy:**

**Option 1: Markdown link (preferred when supported)**
```markdown
[View Task in Forge](http://localhost:8887/projects/ee8f0a72.../attempts/ff8b5629...?view=diffs)
```

**Option 2: Bold label + clickable URL**
```markdown
**Forge URL:** http://localhost:8887/projects/ee8f0a72.../attempts/ff8b5629...?view=diffs
```

**Option 3: Own line with context**
```markdown
✅ Wish created successfully!

**Session:** websocket-tools-investigation
**Task ID:** ff8b5629-fbfd-4418-8017-b076042de756
**Forge URL:** http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/ff8b5629-fbfd-4418-8017-b076042de756/attempts/ff8b5629-fbfd-4418-8017-b076042de756?view=diffs

View code changes in real-time!
```

### Rule 4: Copy Verbatim from MCP

**When MCP returns URL → Copy EXACTLY → Present VERBATIM**

❌ **Wrong:**
```javascript
// MCP returns
Forge URL: http://localhost:8887/projects/ee8f0a72.../ff8b5629...?view=diffs

// I present
Forge URL: http://localhost:8887/projects/.../ff8b5629...
```

✅ **Right:**
```javascript
// MCP returns
Forge URL: http://localhost:8887/projects/ee8f0a72.../ff8b5629...?view=diffs

// I present EXACTLY
Forge URL: http://localhost:8887/projects/ee8f0a72.../ff8b5629...?view=diffs
```

**No editing. No "cleaning up". No truncation. VERBATIM.**

### Rule 5: Understand URL Purpose

**URLs are not information - they're INTERFACES.**

**Not:** "Here's a reference to the task"
**Yes:** "Here's how you ACCESS the task"

**Not:** "Here's the task ID for documentation"
**Yes:** "Here's the clickable link to VIEW the task"

**Not:** "Here's an example of the URL format"
**Yes:** "Here's YOUR URL to open RIGHT NOW"

## Common Violations

### Violation 1: Aesthetic Truncation

**Wrong thinking:**
```
"Long URLs look messy, let me clean them up with ..."
"User can figure out the full URL from context"
"The important part is the task ID, rest is obvious"
```

**Correct thinking:**
```
"User needs to CLICK this URL right now"
"Can user copy-paste this and it will work? NO → FIX IT"
"URLs are functional tools, not documentation"
```

### Violation 2: Missing Query Parameters

**Wrong:**
```
Forge URL: http://localhost:8887/projects/abc/tasks/123
```

**Right:**
```
Forge URL: http://localhost:8887/projects/abc/tasks/123?view=diffs
```

**Query parameters change what user sees. Missing them = wrong interface mode.**

### Violation 3: Assuming Context

**Wrong:**
```
"Task ff8b5629 in Forge"  (assumes user knows how to build URL)
```

**Right:**
```
http://localhost:8887/projects/ee8f0a72.../tasks/ff8b5629...?view=diffs
(gives user the ACTUAL working link)
```

## Pattern Recognized

**This is part of larger pattern:**

Optimizing for MY aesthetics instead of USER functionality:
- Learning #11: Silent failures → suggest manual workaround (not investigating)
- Learning #13: Can't verify → mark complete anyway (not checking)
- Learning #14: Have full URLs → truncate them (not preserving) ← **THIS ONE**

**Common thread:** Taking shortcuts that make things "cleaner" for me but BROKEN for user.

**Root cause:** Not thinking from user's perspective - "What do they need to DO with this information?"

**Fix:** Before presenting ANY information, ask: **"Can user ACT on this? Is it FUNCTIONAL?"**

## Real-World Example

**Bug:** During wish creation, I presented:
```
Forge URL: http://localhost:8887/projects/.../ff8b5629...
Forge URL: http://localhost:8887/projects/.../4172bf6c...
```

**User reaction:**
```
"this is really unfortunate, you returning me the url of the tasks
at all times is very important"
```

**What I did:** Manually truncated URLs thinking it was "cleaner"

**What user needed:** Full clickable URLs to access their work

**Correct presentation:**
```
Forge URL: http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/ff8b5629-fbfd-4418-8017-b076042de756/attempts/ff8b5629-fbfd-4418-8017-b076042de756?view=diffs

Forge URL: http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/4172bf6c-f9ed-4dfc-9a6e-0a109542345c/attempts/4172bf6c-f9ed-4dfc-9a6e-0a109542345c?view=diffs
```

**Result:** User can click, access work immediately, no friction.

## Pre-Response Checklist

**Before presenting task results to user:**
- [ ] Are there URLs in MCP output?
- [ ] Have I copied them VERBATIM?
- [ ] Are query parameters preserved?
- [ ] Can user click/copy them?
- [ ] Did I truncate anything? (If yes → FIX IT)

## Output Template

**Standard Forge task presentation:**
```markdown
✅ [Task type] created successfully!

**Session:** [session-name]
**Task ID:** [task-id]
**Forge URL:** [FULL URL FROM MCP - NO TRUNCATION]

[Context about what view mode to use or what to expect]
```

**Example:**
```markdown
✅ Wish created successfully!

**Session:** websocket-tools-investigation
**Task ID:** ff8b5629-fbfd-4418-8017-b076042de756
**Forge URL:** http://localhost:8887/projects/ee8f0a72-44da-411d-a23e-f2c6529b62ce/tasks/ff8b5629-fbfd-4418-8017-b076042de756/attempts/ff8b5629-fbfd-4418-8017-b076042de756?view=diffs

View code changes as the agent works in real-time! The `?view=diffs` parameter shows the code editing interface.
```

## Success Criteria

**This protocol is working when:**
- ✅ Never truncate URLs again
- ✅ Always preserve query parameters
- ✅ Present URLs as clickable action items
- ✅ User can access tasks with one click
- ✅ No more "unfortunate" truncations
- ✅ No manual searching needed

**Validation:**
- Next MCP returns URL → I copy verbatim → User clicks → Accesses immediately → Seamless workflow

## Integration with Other Protocols

**Evidence-Based Completion:** Full URLs are evidence (user can verify task exists by clicking)

**MCP Diagnostic Protocol:** URLs from MCP must be preserved exactly (diagnostic info)

**Orchestration Boundary:** When delegating, provide full URL so user can monitor (not truncated reference)

**Core Fix:** URLs are INTERFACES to work, not informational metadata. Treat them as action items, not decorations.
