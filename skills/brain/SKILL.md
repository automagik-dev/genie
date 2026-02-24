---
name: brain
description: "Obsidian-style knowledge vault — store, search, and retrieve agent knowledge across sessions via notesmd-cli."
---

# /brain — Agent Knowledge Vault

Persistent long-term memory for agents. Knowledge is stored in `brain/`, searched before answering, and written back every session.

## When to Use
- Agent needs to recall prior session context, decisions, or intel
- New intel (person, company, deal) is discovered mid-session
- A playbook pattern is confirmed or updated
- Provisioning a new agent with a knowledge vault

## Flow

### Session Start (mandatory)

1. Read the conversation opener. Derive 2-3 search terms from the topic.
2. `notesmd-cli search-content "<term>"` for each term.
3. `notesmd-cli print "<note-name>"` for relevant hits.
4. Only then begin forming a response.
5. Fall back to external research (web search, browser) only if brain is insufficient.

On topic shift mid-conversation: re-run `notesmd-cli search-content "<new-topic>"` before answering.

### Write-Back (3 mandatory triggers)

### Trigger 1: Session End (always)

```bash
notesmd-cli daily
# Write: discussion summary, decisions, intel discovered, actions taken
```

### Trigger 2: New Intel Discovered (immediately)

```bash
notesmd-cli create "Intelligence/<person-or-company-name>"
# Write now — do not wait until session end
```

### Trigger 3: Playbook Pattern Updated (immediately)

```bash
notesmd-cli print "Playbooks/<playbook-name>"
# Edit: add confirmed pattern, new rule, exception, or example
```

## Commands

| Command | Purpose |
|---------|---------|
| `notesmd-cli search-content "<keyword>"` | Search vault content (use BEFORE answering domain questions) |
| `notesmd-cli print "<note-name>"` | Read a specific note |
| `notesmd-cli daily` | Open/create today's session log in `Daily/` |
| `notesmd-cli create "<name>"` | Create a note (use folder prefix: `"Intelligence/Name"`) |
| `notesmd-cli list` | Browse full vault structure |
| `notesmd-cli set-default --vault <path>` | Configure vault path (one-time setup) |

## Installation

```bash
# Automated (recommended)
bash skills/brain/scripts/install-notesmd.sh --vault ./brain

# Manual
brew install yakitrak/yakitrak/notesmd-cli
notesmd-cli set-default --vault ./brain/
```

If Homebrew is unavailable: download from https://github.com/Yakitrak/notesmd-cli/releases and place in `/usr/local/bin/notesmd-cli`.

## Provisioning a New Agent Brain

```bash
mkdir -p brain/{_Templates,Company,Daily,Domains,Intelligence,Playbooks}
notesmd-cli set-default --vault ./brain/
cp skills/brain/templates/*.md brain/_Templates/
notesmd-cli list
```

Then add the protocol snippets below to the agent's config files.

### CLAUDE.md Template Block

```markdown
## FIRST THING YOU DO (every session)

1. Read the conversation opener to understand the topic
2. Derive 2-3 search terms
3. Run: `notesmd-cli search-content "<term>"` for each
4. If results found: `notesmd-cli print "<note-name>"`
5. Only THEN begin forming your response
6. If brain is insufficient: use web search as fallback

## WHEN TOPIC SHIFTS

Re-run `notesmd-cli search-content "<new-topic>"` before answering.

## AT SESSION END (mandatory)

Run `notesmd-cli daily`. Log: discussion, decisions, intel, actions.

## WRITE IMMEDIATELY WHEN

- New intel discovered -> `notesmd-cli create "Intelligence/<name>"`
- Playbook updated -> edit relevant `Playbooks/` note
- Domain insight validated -> update relevant `Domains/` note
```

### AGENTS.md Protocol Snippet

```markdown
## Brain Protocol

### Session Start
- Derive 2-3 keywords from topic
- `notesmd-cli search-content "<keyword>"` for each
- `notesmd-cli print "<note-name>"` for relevant results
- External research only when brain is insufficient

### Mid-Conversation
- Re-scan on topic shift: `notesmd-cli search-content "<new-topic>"`

### Session End (mandatory)
- `notesmd-cli daily` — log: discussion, decisions, intel, actions

### Write Immediately When
- New intel -> `notesmd-cli create "Intelligence/<name>"`
- Playbook updated -> edit `Playbooks/` note now
```

## Auto-Sync (optional)

Push brain changes to GitHub via inotifywait + cron:

```bash
# Watcher (scripts/brain-sync.sh)
while inotifywait -r -e modify,create,delete ./brain/ 2>/dev/null; do
  cd brain && git add -A && \
  git commit -m "brain: auto-sync $(date +%Y-%m-%d_%H:%M)" && \
  git push && cd ..
done

# Cron fallback (every 30 min)
# */30 * * * * cd /path/to/workspace && bash scripts/brain-sync.sh >> logs/brain-sync.log 2>&1
```

## Rules

- Local knowledge first. External research is fallback, never default.
- Run startup search every session, no exceptions.
- Write back on all 3 triggers. The brain goes stale if agents only read.
- Never skip the daily log at session end.
- Write intel immediately when discovered — do not batch until session end.
- Templates live in `skills/brain/templates/`. Copy to `brain/_Templates/` during provisioning.
