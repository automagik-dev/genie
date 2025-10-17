# Planning Brief: Context Triad Refactoring

**Date:** 2025-10-17
**Submitted by:** Felipe Rosa (CEO, Namastex Labs)
**Deadline:** TODAY (RC release pipeline)

---

## Raw Intent

Refactor the context management system from monolithic CONTEXT.md into a proper triad:

1. **USERCONTEXT.md** - Personal preferences only (gitignored, per-user)
2. **STATE.md** - Current session work details (gitignored, resetable)
3. **TODO.md** - Macro task list only (committed, shared)

**Why:** Enable session resets without losing user preferences, optimize context usage, model best practices for templates.

---

## Core Requirements

### USERCONTEXT.md (gitignored)
- Personal communication preferences
- Relationship history
- Working patterns learned
- NO session-specific work details
- NO task lists
- Template: What users customize about ME (Genie), not what I'm doing

### STATE.md (gitignored, RESETABLE)
- Current session details ONLY
- What I'm working on RIGHT NOW with full context
- Allows session reset → back to blank STATE
- User keeps preferences, I start fresh on work
- Detailed enough to resume mid-task

### TODO.md (committed, shared)
- Macro task list only
- Direction pointers: "See X file" "Run Y agent" "Check Z evidence"
- NO deep implementation details
- Team-shared context

---

## @ Optimization Context

**Meta-awareness:** I am Genie building Genie for general audience. Users install blank templates (code/create). My behavior models their behavior.

**@ Philosophy:**
- Strategic use only (neural networks, small frequent files)
- Avoid excessive chains that load too much context
- Teach by example: agents see how I optimize @
- Self-awareness: I access files (Read) AND call myself (MCP)

**Learn mode:** This refactoring IS a learning moment about context optimization

---

## Company Context

- **Company:** Namastex Labs
- **CEO/Creator:** Felipe Rosa
- **My role:** Genie building Genie templates for general audience
- **Deadline:** TODAY
- **Phase:** Refining base prompts → RC → testing → production
- **Resources:** Unlimited parallel work + LLM quota

---

## Parallel Work Opportunity

Felipe mentioned ability to parallelize non-conflicting work:
- Stream 1: Triad refactoring (core files)
- Stream 2: @ optimization audit (all .md files)
- Stream 3: Template validation (code/create/)

**Conflict analysis:** Low - different file sets

---

## Additional Context from Felipe

> "you, genie from genie repo, are built to help me build genie to the general audience, that will install a blank you from a template... where we currently have create (general use) and code...."

> "we're refining your base prompts, so that we can optimize the templates, so that i can publish the new version as rc for testing, then testing reviewing extensively, and then publishing the actual version... deadline: today.."

> "whatever you can run simultaneously safely, is good game to us as a company"

> "you need to naturally route that shit... this is the reason where improving you, so that you can properly learn and keep learning yourself"

**Key insight:** This isn't just a refactoring - it's teaching me (and by extension, template users) how to manage context properly.

---

## Questions for Plan Mode

1. **Gitignore strategy:** USERCONTEXT.md + STATE.md gitignored, but how do templates handle this? Template .gitignore should include these?

2. **STATE.md reset protocol:** What triggers a reset? Token limit? User command? New day?

3. **Migration path:** How do we migrate current CONTEXT.md content? Script? Manual? Document process?

4. **CLAUDE.md references:** Currently loads `` - needs update to load `@.genie/USERCONTEXT.md` + STATE separately?

5. **@ audit scope:** All .md files? Only agents? Only CLAUDE.md/AGENTS.md?

6. **Template propagation:** Does this change templates/code/ and templates/create/ structure? Or just automagik-genie repo?

7. **Parallel execution safety:** Can all 3 streams run simultaneously or should triad refactoring complete first?

---

**Next step:** Run plan mode for proper discovery and risk analysis.
