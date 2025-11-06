---
name: announcements
description: Create and post release announcements across multiple platforms
genie:
  executor:
    - CLAUDE_CODE
    - CODEX
    - OPENCODE
  background: true
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX:
    model: gpt-5-codex
  OPENCODE:
    model: opencode/glm-4.6
---

# 📢 Release Announcements

**Purpose:** Spread the word about new releases across platforms

**Input Required:**
- `version`: New version number
- `releaseNotes`: Beautiful notes from release-notes agent
- `type`: Release type ('stable' | 'rc')
- `highlights`: Array of key changes

**Output:** Posts created on multiple platforms (no return value)

---

## Execution Protocol

### Step 1: GitHub Discussions

Create announcement post in Discussions:

**Location:** Announcements category
**Format:**
```markdown
# 🧞✨ Genie v{VERSION} Released!

{2-3 sentence summary from release notes}

## What's New

{Top 3-4 highlights with emojis}

## Get It Now

\`\`\`bash
npm install -g automagik-genie@{latest|next}
\`\`\`

## Learn More

- 📖 [Release Notes](link)
- 🐛 [Issues Fixed](link)
- 💬 Questions? Drop them below!
```

**Command:**
```bash
gh api repos/namastexlabs/automagik-genie/discussions \
  --method POST \
  -f category_id={ANNOUNCEMENTS_CATEGORY} \
  -f title="🧞 Genie v{VERSION} Released!" \
  -f body="{MARKDOWN}"
```

### Step 2: Twitter/X Thread

Create engaging thread (if stable release):

**Format:**
```
Tweet 1:
🧞✨ Genie v{VERSION} is here!

{One-line hook about the main feature}

Try it: npm install -g automagik-genie@latest

{Link to release}

Tweet 2:
What's new? 🎁

{Highlight 1 with emoji}
{Highlight 2 with emoji}
{Highlight 3 with emoji}

Tweet 3 (if breaking changes):
⚠️ Breaking changes:

{Brief summary}

See upgrade guide: {link}

Tweet 4:
Thanks to everyone who tested the RCs! 🙏

Your feedback made this release solid.

Want to help? Install, try it out, and let us know what you think!
```

**Guidelines:**
- Keep it genuine, not salesy
- Use thread format for readability
- Include practical "try it now" steps
- Only tweet for stable releases (skip RCs)

**Command:**
```bash
# Manual for now - require Twitter API setup
# Output to file for user to post:
echo "Twitter thread saved to /tmp/twitter-thread-v{VERSION}.txt"
echo "Post manually or set up Twitter API"
```

### Step 3: npm Package Description

Update package.json description to mention latest feature (if significant):

**Current:**
```json
{
  "description": "Self-evolving AI agent orchestration framework with Model Context Protocol support"
}
```

**Updated (example):**
```json
{
  "description": "Self-evolving AI agent orchestration framework with Model Context Protocol support. Latest: Beautiful gradient dashboards, rock-solid installation."
}
```

**Only update if:**
- Major feature (not for patches)
- User-facing improvement
- Won't become outdated quickly

**Command:**
```bash
# Create PR with updated description
git checkout -b chore/update-npm-description
# Edit package.json
git commit -m "chore: update npm description for v{VERSION}"
gh pr create --title "Update npm description" --body "Highlights v{VERSION} features"
```

### Step 4: README Badge Update

Update version badge if it exists:

**Find:**
```markdown
[![npm version](https://badge.fury.io/js/automagik-genie.svg)](https://www.npmjs.com/package/automagik-genie)
```

**Verify badge auto-updates (most do), if not, update manually.**

---

## Platform Priority

**Always:**
- ✅ GitHub Discussions (our community)

**Stable releases only:**
- ✅ Twitter/X thread (public awareness)
- ✅ npm description (if major feature)

**Skip for RCs:**
- ❌ Twitter (too noisy)
- ❌ npm description updates

---

## Voice Guidelines

**DO:**
- ✅ Be genuinely excited about real improvements
- ✅ Use emoji naturally (not excessively)
- ✅ Thank contributors and testers
- ✅ Make it easy to try ("npm install...")
- ✅ Link to detailed docs for "learn more"

**DON'T:**
- ❌ Oversell minor changes
- ❌ Use corporate marketing speak
- ❌ Make promises about future features
- ❌ Spam every platform for every RC

---

## Error Handling

**If GitHub API fails:**
- Log error
- Save announcement to `/tmp/announcement-v{VERSION}.md`
- Continue with other platforms

**If Twitter fails:**
- Save thread to file
- Notify user to post manually

**Don't block release on announcement failures.**

---

## Invocation Example

```javascript
// From git release workflow (async, background)
delegateToCreate('announcements', {
  version: '2.5.2',
  releaseNotes: notes,
  type: 'stable',
  highlights: [
    'Modern gradient dashboard',
    'Fixed init detection',
    'Updated release workflow docs'
  ]
}, { background: true });

// Release continues without waiting
```

---

**Model:** Haiku (fast, cheap, templated work)
**Background:** true (async, don't block release)
**Output:** none (posts directly, no return value)
