---
name: brain
description: "Agent knowledge vault — Obsidian-style brain managed via notesmd-cli. Use when an agent needs to store, search, or retrieve knowledge across sessions."
---

# Brain Skill — Agent Knowledge Vault

Every agent that loads this skill maintains an Obsidian-style vault called `brain/` in their workspace. Knowledge is stored there first, searched there first, and written back constantly. The brain is the agent's long-term memory that compounds across sessions.

## Vault Structure

```
brain/
├── _Templates/     # daily, domain, playbook, intel seed templates
├── Company/        # org/user context (who you work for, key people, configs)
├── Daily/          # session logs (created via notesmd-cli daily)
├── Domains/        # domain knowledge files (one per topic area)
├── Intelligence/   # source profiles, scoring, deal/person/company intel
├── Playbooks/      # agent playbooks (one per workflow or recurring pattern)
└── [agent-specific folders as needed]
```

## Installation

```bash
# Install notesmd-cli via Homebrew (idempotent — safe to re-run)
brew install yakitrak/yakitrak/notesmd-cli

# Set default vault (run once per agent, from agent workspace root)
notesmd-cli set-default --vault ./brain/

# Verify
notesmd-cli print-default
notesmd-cli list
```

**If Homebrew is not available:** download the binary from https://github.com/Yakitrak/notesmd-cli/releases and place it in `/usr/local/bin/notesmd-cli`.

Use the install script at `scripts/install-notesmd.sh` for automated setup.

## Key Commands

```bash
notesmd-cli search-content "<keyword>"   # brain-first scan — use BEFORE answering domain questions
notesmd-cli print "<note-name>"          # read a specific note by name
notesmd-cli daily                        # open/create today's session log in Daily/
notesmd-cli create "<name>"              # create a new note (use folder prefix: "Intelligence/Name")
notesmd-cli list                         # browse full vault structure
notesmd-cli set-default --vault <path>   # configure vault path (one-time setup)
```

## Startup Protocol (run every session, no exceptions)

1. Read the conversation opener — understand the topic/request
2. Derive 2-3 search terms from the topic
3. `notesmd-cli search-content "<term>"` — run for each term
4. `notesmd-cli print "<note-name>"` — read relevant results
5. Only THEN begin forming your response
6. External research (web search, browser) ONLY if brain is insufficient

**When topic shifts mid-conversation:** re-run `notesmd-cli search-content "<new-topic>"` before answering.

**Principle:** local knowledge first. External research is fallback, not default.

## Write-Back Protocol (3 mandatory triggers)

The brain goes stale if agents only read it. Write-back is non-negotiable.

### Trigger 1 — Session End (always, without exception)
```bash
notesmd-cli daily
# Write: what was discussed, decisions made, intel discovered, actions taken
```

### Trigger 2 — New Intel Discovered (immediately, mid-session)
```bash
notesmd-cli create "Intelligence/<person-or-company-name>"
# Do not wait until session end — write it now before it's lost
```

### Trigger 3 — Playbook Pattern Updated (immediately, mid-session)
```bash
# Open and update the relevant playbook note
notesmd-cli print "Playbooks/<playbook-name>"
# Then edit: add confirmed pattern, new rule, exception, or example
```

## CLAUDE.md Template Block

Copy-paste this into any agent's `CLAUDE.md` to enforce brain-first behavior in Claude Code. Place at the top of the file (before or after any `@` includes).

```markdown
@AGENTS.md

---

## FIRST THING YOU DO (every session, no exceptions)

1. Read the conversation opener to understand the topic/request
2. Derive 2-3 search terms from the topic
3. Run: `notesmd-cli search-content "<term1>"` for each term
4. If results found: read relevant notes with `notesmd-cli print "<note-name>"`
5. Only THEN begin forming your response
6. If brain is insufficient for the topic: use web search / browser as fallback

## WHEN TOPIC SHIFTS MID-CONVERSATION

Re-run `notesmd-cli search-content "<new-topic>"` before answering the new topic.

## AT SESSION END (mandatory, always)

Run: `notesmd-cli daily`
Add a brief summary of: what was discussed, decisions made, intel discovered, actions taken.

## WRITE IMMEDIATELY WHEN

- New intel about a deal, company, or person is discovered → `notesmd-cli create "Intelligence/<name>"`
- A playbook is updated or a new pattern confirmed → update relevant Playbooks/ note
- A new domain insight is validated → update relevant Domains/ note
```

## AGENTS.md Protocol Snippet

Add this to any agent's `AGENTS.md` startup section (replace or augment the knowledge-scan step):

```markdown
## Brain Protocol

### Every Session Start
- Read conversation topic → derive 2-3 keywords
- `notesmd-cli search-content "<keyword>"` for each term
- `notesmd-cli print "<note-name>"` for relevant results
- External research only when brain is insufficient

### Mid-Conversation
- Re-scan with `notesmd-cli search-content "<new-topic>"` when topic shifts

### Session End (mandatory)
- `notesmd-cli daily` — log: discussion, decisions, intel, actions

### Write Immediately When
- New intel found → `notesmd-cli create "Intelligence/<name>"`
- Playbook updated → edit the Playbooks/ note now, not later
```

## Brain → GitHub Auto-Sync (inotifywait + cron pattern)

To auto-push brain changes to GitHub, set up a watcher + cron fallback:

```bash
# 1. Init git in brain/ (if not already a repo)
cd brain/ && git init && git remote add origin <your-brain-repo-url>

# 2. Install inotifywait
apt-get install inotify-tools     # Linux/Debian
# brew install fswatch             # macOS fallback

# 3. Watcher script (scripts/brain-sync.sh):
#!/bin/bash
while inotifywait -r -e modify,create,delete ./brain/ 2>/dev/null; do
  cd brain && git add -A && \
  git commit -m "brain: auto-sync $(date +%Y-%m-%d_%H:%M)" && \
  git push && cd ..
done

# 4. Cron fallback (every 30 min, belt-and-suspenders):
# */30 * * * * cd /path/to/agent-workspace && bash scripts/brain-sync.sh >> logs/brain-sync.log 2>&1
```

Reference implementation: `namastexlabs/genie-sky` — `scripts/` and scheduler cron config.

## Provisioning a New Agent Brain

When birthing a new agent, run this in the new agent's workspace:

```bash
# 1. Create vault structure
mkdir -p brain/{_Templates,Company,Daily,Domains,Intelligence,Playbooks}

# 2. Set default vault
notesmd-cli set-default --vault ./brain/

# 3. Copy seed templates
cp ~/.npm-global/lib/node_modules/openclaw/skills/brain/templates/*.md brain/_Templates/

# 4. Verify
notesmd-cli list
notesmd-cli print-default
```

Then:
- Copy the **CLAUDE.md Template Block** (above) into the agent's `CLAUDE.md`
- Copy the **AGENTS.md Protocol Snippet** (above) into the agent's `AGENTS.md` startup section
- Set up brain → GitHub sync if the agent has a repo
