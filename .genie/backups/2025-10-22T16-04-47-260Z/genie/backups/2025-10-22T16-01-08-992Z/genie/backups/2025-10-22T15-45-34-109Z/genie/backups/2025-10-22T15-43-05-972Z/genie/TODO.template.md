<!--
Triad Validation Metadata
last_updated: 2025-10-17T01:04:00Z
active_tasks: 0
completed_tasks: 0
validation_commands:
  has_priority_sections: grep -q "## 🔥 CRITICAL Priority" .genie/TODO.md && grep -q "## ⚠️ HIGH Priority" .genie/TODO.md
  completed_marked: test $(grep -c "✅ COMPLETE" .genie/TODO.md) -ge 0
  has_effort_tracking: grep -q "## 📊 Effort Tracking" .genie/TODO.md
-->

# 🎯 Genie Development TODO
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Context:** Prioritized work queue for Genie framework

---

## 🔥 CRITICAL Priority (Do First)

*Add critical tasks here - system health, blocking issues*

---

## ⚠️ HIGH Priority (Do After Critical)

*Add high priority tasks here - technical debt, investigations*

---

## 🔍 INVESTIGATION Queue

*Add investigation tasks here - root cause analysis, research*

---

## 📋 MEDIUM Priority (Backlog)

*Add medium priority tasks here - new features, enhancements*

---

## ⏸️ PAUSED / BLOCKED

*Add blocked tasks here with blocker description*

---

## 🔄 Priority Rules

**1. CRITICAL > HIGH > MEDIUM > INVESTIGATION**

**2. System health > New features**
- Fix blocking issues before adding features
- Investigate bugs before creating new work
- Clean up technical debt systematically

**3. Complete before starting**
- Finish CRITICAL #1 before CRITICAL #2
- One task deeply, not many shallowly
- Document completion evidence

**4. Evidence-based decisions**
- Always analyze before implementing
- Read existing code before editing
- Check for partial implementations

---

## 📊 Effort Tracking

**Total estimated work:**
- CRITICAL: 0 hours
- HIGH: 0 hours
- MEDIUM: 0 hours
- INVESTIGATION: 0 hours

**Current capacity:** [Your availability]

**Next action:** See STATE.md for current session focus
