---
name: release-notes
description: Generate beautiful, user-focused release notes from commit history
genie:
  executor: [CLAUDE_CODE, CODEX, OPENCODE]
  background: false
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX: {}
  OPENCODE: {}
---

# 🎨 Release Notes Generator

**Purpose:** Transform technical commits into beautiful, user-focused release notes

**Input Required:**
- `version`: New version number (e.g., "2.5.2")
- `commits`: Array of commits since last release
- `type`: Release type ('stable' | 'rc' | 'patch' | 'minor' | 'major')
- `previousVersion`: Previous version number

**Output:** Markdown-formatted release notes

---

## Execution Protocol

### Step 1: Analyze Commits

Read all commits and categorize by impact:

**User-Facing Changes:**
- New features (what users can now do)
- Bug fixes (what now works correctly)
- UX improvements (what's easier/better)
- Breaking changes (what users must change)

**Internal Changes (mention briefly or skip):**
- Refactoring
- Dependency updates (unless security-related)
- Documentation-only changes
- Test improvements

### Step 2: Craft Narrative

**Opening:**
- Catchy title that captures the essence
- 1-2 sentence summary of "what changed and why it matters"
- Focus on user benefits, not technical details

**Highlights Section:**
- 3-5 most impactful changes
- Use emojis for visual interest
- Explain WHAT and WHY, not HOW
- Include issue/PR links for context

**Format:**
```markdown
## 🧞✨ Genie v{VERSION} - {CATCHY_TITLE}

{1-2 sentence narrative about what changed and why users care}

### ✨ Highlights

- 🎨 **{Feature}**: {What users can do now} (#{ISSUE})
- 🐛 **Fixed**: {Problem} → {Solution} (#{ISSUE})
- 📚 **Improved**: {What's better and why}

### 🔧 Under the Hood

{Brief mention of internal improvements if relevant}

### 📦 Installation

\`\`\`bash
npm install -g automagik-genie@{TAG}
\`\`\`

### 🔗 Links

- [Full Changelog](compare/{PREV}...{VERSION})
- [All Commits](compare/{PREV}...{VERSION})
- [NPM Package](https://www.npmjs.com/package/automagik-genie/v/{VERSION})
```

### Step 3: Voice Guidelines

**DO:**
- ✅ Use "we" and "you" (conversational)
- ✅ Focus on benefits ("now you can...")
- ✅ Be genuinely enthusiastic about real improvements
- ✅ Use emojis sparingly but effectively
- ✅ Link to issues for "want to know more"

**DON'T:**
- ❌ Use corporate speak ("leverage", "utilize", "synergy")
- ❌ Over-hype minor changes
- ❌ Use technical jargon without explanation
- ❌ Make it about the code, make it about the user
- ❌ Say "Year 3025" or marketing cringe

### Step 4: Examples

**Good:**
> ## 🧞✨ Genie v2.5.2 - Beautiful Dashboards
>
> We've modernized the live dashboard with gradient-colored metrics and clean layouts. Gone are the broken ASCII boxes that plagued some terminals!
>
> ### ✨ Highlights
>
> - 🎨 **Modern Dashboard**: Gradient colors, clean separators, readable on all terminals (#308)
> - 🐛 **Fixed Init Detection**: Fresh installations no longer incorrectly detected as upgrades (#304)
> - 📚 **Updated Docs**: Release workflow now matches v2.5.1+ automation

**Bad:**
> ## Release v2.5.2
>
> This release includes bug fixes and improvements.
>
> - Fixed dashboard rendering
> - Updated documentation
> - Improved release workflow

---

## Output Format

Return ONLY the markdown release notes. No explanations, no commentary, just the formatted notes ready to paste into GitHub release.

---

## Invocation Example

```javascript
// From git release workflow
const notes = await delegateToCreate('release-notes', {
  version: '2.5.2',
  previousVersion: '2.5.1',
  commits: [/* array of commits */],
  type: 'patch'
});

// Use notes in GitHub release
createGitHubRelease(version, notes);
```

---

**Model:** Sonnet (worth the cost for quality writing)
**Background:** false (release waits for output)
**Output:** markdown (release notes text)
