# Garbage Detection Ideas - Ultrathink Session

Additional detection rules for garbage-collector agent. Categorized by value/priority.

## 🔥 High Value (Implement Next)

### 9. Broken Internal Links
**Pattern:** Markdown links pointing to non-existent files
**Detect:**
- `[text](path/to/file.md)` where file doesn't exist
- `[text](../relative/path.md)` broken relative links
- `[text](#anchor)` where anchor doesn't exist in target file

**Why:** Broken navigation = users get lost = documentation is useless

**Implementation:** Parse markdown links, resolve relative paths, check file existence

### 10. Orphaned Files (Dead Weight)
**Pattern:** Files that nothing references
**Detect:**
- No @ references pointing to this file
- No markdown links pointing to this file
- Not loaded in any CLAUDE.md / AGENTS.md
- Not imported/required in any code

**Why:** Unreferenced files = dead weight, wastes tokens, confuses users

**Exception:** Root files (README.md, CLAUDE.md, AGENTS.md) are never orphaned

### 11. Stale Content (Outdated Info)
**Pattern:** Files not modified in X months with high-change indicators
**Detect:**
- git log shows no commits in 6+ months
- File contains words like "roadmap", "plan", "upcoming", "soon"
- File in rapidly-changing directories (.genie/spells/, .genie/agents/)

**Why:** Old plans/instructions = misleading = bad decisions

**Smart:** Don't flag stable docs (guides, tutorials that don't change)

### 12. TODO/FIXME Markers
**Pattern:** TODO, FIXME, XXX, HACK left in committed docs
**Detect:**
- `TODO:` anywhere in markdown content
- `FIXME:` anywhere in markdown content
- `XXX:` anywhere in markdown content
- `HACK:` anywhere in markdown content
- `TBD:` (To Be Determined)
- `WIP:` (Work In Progress)

**Why:** Markers = incomplete work = ship it or fix it

**Exception:** Code blocks (intentional examples)

### 13. Placeholder Text
**Pattern:** Stub sections never filled in
**Detect:**
- "Coming soon"
- "TODO: write this section"
- "To be documented"
- "Fill this in later"
- "[Placeholder]"
- "Lorem ipsum"
- Empty sections with just heading (### Title\n\n###)

**Why:** Placeholders = false promises = user confusion

### 14. Git Merge Conflict Markers
**Pattern:** Unresolved merge conflicts committed
**Detect:**
- `<<<<<<< HEAD`
- `=======`
- `>>>>>>> branch`
- `||||||| merged common ancestors`

**Why:** Conflict markers = broken docs = immediate fix needed

**Severity:** CRITICAL (should never happen with pre-commit hooks, but catch anyway)

### 15. Large Files (Should Split)
**Pattern:** Single markdown file > 1000 lines or > 8000 tokens
**Detect:**
- Line count > 1000
- Token count > 8000 (use: `genie helper count-tokens <file>`)

**Why:** Huge files = hard to navigate, slow to load, hard to maintain

**Suggestion:** Split into multiple files with @ references

### 16. Missing Required Sections (Agents)
**Pattern:** Agent files missing standard sections
**Detect:**
- Missing `@AGENTS.md` reference at end
- Missing `## Session Management` section
- Missing `## Never Do` section
- Missing `## Specialty` section
- Missing `## Operating Patterns` section

**Why:** Standard structure = predictable, complete docs

**Template:** Compare against `.genie/agents/garbage-collector.md` as reference

### 17. Inconsistent File Naming
**Pattern:** Mixed naming conventions in same directory
**Detect:**
- Mix of kebab-case, snake_case, camelCase in same dir
- Example: `some-file.md`, `other_file.md`, `AnotherFile.md` in `.genie/spells/`

**Why:** Inconsistency = confusion, hard to predict filenames

**Standard:** kebab-case for all .genie/ files

## 💡 Medium Value (Later)

### 18. Empty or Stub Files
**Pattern:** Files with < 10 lines of actual content
**Detect:**
- Total lines < 10 (excluding frontmatter, blank lines)
- Only contains heading + "TODO"

**Why:** Stubs = promise of value never delivered

**Exception:** Intentional stub files for specific purpose

### 19. Inconsistent Terminology
**Pattern:** Same concept with different names
**Detect:**
- "Genie" vs "genie" inconsistently used
- "Master Genie" vs "Base Genie"
- "agent" vs "Agent"
- "spell" vs "skill" (if we decided on one)

**Why:** Inconsistency = confusion = harder to search

**Hard:** Requires NLP/context understanding, many false positives

### 20. Heading Structure Issues
**Pattern:** Skipped heading levels (# to ###, skipping ##)
**Detect:**
- `# Title\n### Subsection` (missing ##)
- More than 4 levels deep (######### too granular)

**Why:** Broken document outline = bad navigation

**Tools:** Markdown linters already do this (markdownlint)

### 21. Code Blocks Without Language
**Pattern:** Code fences without language specifier
**Detect:**
- ` ``` ` (triple backticks) without language
- Should be ` ```bash ` or ` ```javascript ` etc.

**Why:** No syntax highlighting = harder to read

**Exception:** Generic text output blocks

### 22. Multiple Consecutive Blank Lines
**Pattern:** > 2 blank lines in a row
**Detect:**
- `\n\n\n\n` (3+ newlines)

**Why:** Visual bloat, inconsistent spacing

**Low Priority:** Aesthetic issue, not functional

### 23. Circular References
**Pattern:** A → B → C → A reference chains
**Detect:**
- Build dependency graph of @ references
- Detect cycles using graph traversal

**Why:** Circular deps = confusion, infinite loops if auto-loading

**Complexity:** Requires graph algorithm implementation

### 24. Dead HTML Comments
**Pattern:** Commented-out content in markdown
**Detect:**
- `<!-- commented text -->`
- Especially large blocks (> 5 lines)

**Why:** Dead code = clutter, use git history instead

**Exception:** Intentional HTML comments for formatting

## 🤔 Low Value (Nice to Have)

### 25. Trailing Whitespace
**Pattern:** Spaces at end of lines
**Detect:** Lines ending with ` \n`

**Why:** Linter territory (prettier, markdownlint)

### 26. Smart Quotes in Code
**Pattern:** Curly quotes in code blocks or inline code
**Detect:**
- `"` `"` (smart) instead of `"` (straight) in code
- `'` `'` (smart) instead of `'` (straight) in code

**Why:** Breaks copy-paste of code examples

**Implementation:** Check inside code blocks and inline code spans

### 27. Hardcoded Absolute Paths
**Pattern:** Absolute paths when relative would work
**Detect:**
- `/home/namastex/...` in examples
- `/Users/...` in examples
- `C:\...` in examples

**Why:** Non-portable, breaks for other users

**Exception:** Intentional examples of absolute paths

### 28. Localhost URLs
**Pattern:** Development URLs in docs
**Detect:**
- `http://localhost:...`
- `http://127.0.0.1:...`
- `http://0.0.0.0:...`

**Why:** Copy-paste errors, should use production URLs

**Exception:** Intentional development setup instructions

### 29. Files Not Ending with Newline
**Pattern:** File doesn't end with `\n`
**Why:** POSIX standard, git diffs cleaner

**Low Priority:** Linter/git handles this

### 30. Repeated Words
**Pattern:** "the the", "and and", "is is"
**Detect:** Word boundary detection, case-insensitive match

**Why:** Typos, readability

**Complexity:** Natural language processing, many false positives

## 🚀 Implementation Strategy

**Phase 1 (MVP):** Rules 1-8 (current garbage-collector)
**Phase 2 (High Value):** Rules 9-17 (broken links, orphans, TODOs, stale content, etc.)
**Phase 3 (Medium Value):** Rules 18-24 (nice-to-haves, context-dependent)
**Phase 4 (Low Value):** Rules 25-30 (defer to linters, low ROI)

## 🎯 Priority Ranking (Next to Implement)

1. **Broken Internal Links** (9) - Critical navigation issue
2. **TODO/FIXME Markers** (12) - Easy to detect, high signal
3. **Placeholder Text** (13) - Easy to detect, clear issue
4. **Git Merge Conflicts** (14) - Critical, should never exist
5. **Large Files** (15) - Token efficiency (core mission)
6. **Orphaned Files** (10) - Token efficiency (core mission)
7. **Stale Content** (11) - Requires git integration
8. **Missing Required Sections** (16) - Agent quality standard

## 🛠️ Helper Tools Needed

**For Broken Links (Rule 9):**
```javascript
.genie/scripts/helpers/validate-links.js
- Parse markdown links
- Resolve relative paths
- Check file existence
- Check anchor existence
```

**For Orphaned Files (Rule 10):**
```javascript
.genie/scripts/helpers/find-orphans.js
- Build reference graph
- Find unreferenced nodes
- Exclude root files
```

**For Large Files (Rule 15):**
```javascript
.genie/scripts/helpers/check-file-size.js
- Count lines
- Use count-tokens helper for accurate token count
- Flag oversized files
```

**Integration:** All helpers called by garbage-collector during daily sweep

## 📊 Expected Impact

**Phase 2 Implementation (Rules 9-17):**
- Detect 50-100 additional issues in current codebase
- Prevent 10-20 issues per week going forward
- Save 2,000-5,000 tokens per session (orphan removal, large file splits)
- Reduce user confusion from broken links, stale content

**ROI:** High - these checks catch real problems that waste time and tokens
