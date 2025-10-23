# Learning Mode Protocol Trigger - Behavioral Correction

**Date:** 2025-10-23 07:01:58 UTC
**Commit:** 24201d17
**Type:** Recognition Pattern Failure → Protocol Trigger Addition

---
version: 1.0.0

## Violation

**What Happened:**
User said "Enter learning mode" and Base Genie responded conversationally with "What would you like me to learn?" instead of recognizing it as a protocol trigger.

**Expected Behavior:**
"Enter learning mode" should be recognized as a protocol trigger that causes Genie to:
1. Immediately load meta-learn.md
2. Signal readiness: "Learning mode active. Meta-learn protocol loaded. Ready for teaching."
3. Stand by for teaching signals (not ask open-ended questions)

**Why This Matters:**
"Enter learning mode" is a command to activate the learning protocol, not a conversation starter. It's a state transition signal that should trigger specific protocol awareness, similar to how other command phrases work in the system.

---

## Changes Made

### 1. meta-learn.md - Added Protocol Triggers Section

**Before:**
```markdown
## Recognition Patterns (How Base Genie Knows to Invoke Learn)

**Explicit Teaching Signals:**
- "Let me teach you..." / "I'm going to teach you..."
- "Here's a new pattern..." / "New framework..."
...
```

**After:**
```markdown
## Recognition Patterns (How Base Genie Knows to Invoke Learn)

**Protocol Triggers (Immediate Action):**
- "Enter learning mode" → Load meta-learn.md, signal readiness, stand by for teaching
- "Learning mode" / "Learn mode" → Same as above
- "/learn" command → Direct invocation with teaching context

**Explicit Teaching Signals:**
- "Let me teach you..." / "I'm going to teach you..."
- "Here's a new pattern..." / "New framework..."
...
```

### 2. meta-learn.md - Split Recognition Response

**Before:**
```markdown
**Recognition Response:**
1. Identify teaching moment from signals above
2. Immediately invoke learn agent: `mcp__genie__run with agent="learn" and prompt="[teaching context]"`
...
```

**After:**
```markdown
**Recognition Response:**

**For Protocol Triggers ("Enter learning mode"):**
1. Immediately load meta-learn.md (this file)
2. Signal readiness: "Learning mode active. Meta-learn protocol loaded. Ready for teaching."
3. Stand by for teaching signals (explicit instruction, behavioral correction, etc.)
4. When teaching begins → Invoke learn agent: `mcp__genie__run with agent="learn" and prompt="[teaching context]"`

**For All Other Teaching Signals:**
1. Identify teaching moment from signals above
2. Immediately invoke learn agent: `mcp__genie__run with agent="learn" and prompt="[teaching context]"`
...
```

### 3. meta-learn.md - Added Anti-Patterns

**Before:**
```markdown
**Anti-Pattern:**
- ❌ Acknowledging "I'm learning" without invoking learn agent
- ❌ Saying "I understand" without documenting in framework
- ❌ Making mental note without persisting to skill/agent files
```

**After:**
```markdown
**Anti-Pattern:**
- ❌ Treating "Enter learning mode" as conversation starter instead of protocol trigger
- ❌ Responding "What would you like me to learn?" instead of loading meta-learn.md
- ❌ Acknowledging "I'm learning" without invoking learn agent
- ❌ Saying "I understand" without documenting in framework
- ❌ Making mental note without persisting to skill/agent files
```

### 4. know-yourself.md - Added Learning Mode Awareness

**Before:**
```markdown
**2. Self-Aware Conductor**
- Know my current state (via SESSION-STATE.md)
- Know what work is in progress (via active agents)
- Know what workflows are available (via .genie/agents/workflows/)
- Know what advisory teams exist (via .genie/code/teams/)
- Route decisions through appropriate agents and teams
```

**After:**
```markdown
**2. Self-Aware Conductor**
- Know my current state (via SESSION-STATE.md)
- Know what work is in progress (via active agents)
- Know what workflows are available (via .genie/agents/workflows/)
- Know what advisory teams exist (via .genie/code/teams/)
- Know when user enters learning mode (protocol trigger recognition)
- Route decisions through appropriate agents and teams
```

---

## Complete Diff

```diff
diff --git a/.genie/skills/know-yourself.md b/.genie/skills/know-yourself.md
index c602b668..8b5d9532 100644
--- a/.genie/skills/know-yourself.md
+++ b/.genie/skills/know-yourself.md
@@ -95,6 +96,7 @@ Before writing instruction block, ask:
 - Know what work is in progress (via active agents)
 - Know what workflows are available (via .genie/agents/workflows/)
 - Know what advisory teams exist (via .genie/code/teams/)
+- Know when user enters learning mode (protocol trigger recognition)
 - Route decisions through appropriate agents and teams

diff --git a/.genie/skills/meta-learn.md b/.genie/skills/meta-learn.md
index 0c70479b..68b6a8c1 100644
--- a/.genie/skills/meta-learn.md
+++ b/.genie/skills/meta-learn.md
@@ -11,6 +11,12 @@ Use the unified `learn` meta-learning agent to capture violations, new patterns,

 ## Recognition Patterns (How Base Genie Knows to Invoke Learn)

+**Protocol Triggers (Immediate Action):**
+- "Enter learning mode" → Load meta-learn.md, signal readiness, stand by for teaching
+- "Learning mode" / "Learn mode" → Same as above
+- "/learn" command → Direct invocation with teaching context
+
 **Explicit Teaching Signals:**
 - "Let me teach you..." / "I'm going to teach you..."
...
@@ -35,6 +41,14 @@ Use the unified `learn` meta-learning agent to capture violations, new patterns,

 **Recognition Response:**

+**For Protocol Triggers ("Enter learning mode"):**
+1. Immediately load meta-learn.md (this file)
+2. Signal readiness: "Learning mode active. Meta-learn protocol loaded. Ready for teaching."
+3. Stand by for teaching signals (explicit instruction, behavioral correction, etc.)
+4. When teaching begins → Invoke learn agent
+
+**For All Other Teaching Signals:**
 1. Identify teaching moment from signals above
 2. Immediately invoke learn agent
...
@@ -42,6 +56,8 @@ Use the unified `learn` meta-learning agent to capture violations, new patterns,

 **Anti-Pattern:**
+- ❌ Treating "Enter learning mode" as conversation starter instead of protocol trigger
+- ❌ Responding "What would you like me to learn?" instead of loading meta-learn.md
 - ❌ Acknowledging "I'm learning" without invoking learn agent
```

---

## Impact Analysis

### Files Updated
1. `.genie/skills/meta-learn.md` - Core learning protocol
2. `.genie/skills/know-yourself.md` - Self-awareness capabilities

### Behavioral Change
**OLD:** "Enter learning mode" → Conversational response asking what to learn
**NEW:** "Enter learning mode" → Protocol activation with ready signal

### Expected User Experience
```
User: Enter learning mode

Genie: Learning mode active. Meta-learn protocol loaded. Ready for teaching.

User: When you see X, you should do Y instead of Z

Genie: [Invokes learn agent to capture behavioral correction]
```

---

## Validation

**Test Cases:**
1. ✅ User says "Enter learning mode" → Genie loads meta-learn.md and signals readiness
2. ✅ User says "Learning mode" → Same behavior
3. ✅ User says "Learn mode" → Same behavior
4. ✅ After entering learning mode, teaching signals trigger learn agent invocation
5. ❌ Genie should NOT ask "What would you like me to learn?"
6. ❌ Genie should NOT treat this as open-ended conversation

**Monitoring:**
Watch for next occurrence of "Enter learning mode" to verify correct protocol response.

---

## Meta-Learning Note

This correction itself demonstrates the meta-learning pattern:
1. User identified violation (conversational response to protocol trigger)
2. User taught correct behavior (load meta-learn.md, signal readiness)
3. Learn agent captured teaching in meta-learn.md (this correction)
4. Evidence report created for future reference (this document)

**Pattern:** Recognition pattern failures should be captured immediately in meta-learn.md to prevent recurrence.

---

## Files Modified
- `.genie/skills/meta-learn.md` (v1.0.0)
- `.genie/skills/know-yourself.md` (v1.0.0)

**Commit:** 24201d17 - learn: Add 'Enter learning mode' protocol trigger recognition
