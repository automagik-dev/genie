---
name: brain
description: "Obsidian-style knowledge vault — store, search, and retrieve agent knowledge across sessions via notesmd-cli. Use when the user says 'remember this', 'save for later', 'look up', 'find note', 'what do we know about', 'recall', 'search notes', 'store this', 'brain search', 'check the vault', or needs to persist context, intel, or session history between conversations."
---

# /brain — Agent Knowledge Vault

Persistent long-term memory for agents. Knowledge is stored in `brain/`, searched before answering, and written back every session.

## Brain vs Memory

These are **different tools for different purposes**:

| | **Brain** (this skill) | **Memory** (Claude native) |
|---|---|---|
| **What** | Context graph — entities, relationships, domain knowledge | Behavioral learnings — feedback, decisions, user preferences |
| **Tool** | `notesmd-cli` (Obsidian-style vault) | `.claude/memory/` files with YAML frontmatter |
| **When** | Domain intel, playbooks, company/person context, session logs | Corrections, conventions, project rules, user profile |
| **Updated by** | `/brain` (this skill) | `/learn` skill, auto memory system |
| **Format** | Markdown notes in `brain/` directory | Typed memory files (user, feedback, project, reference) |

**Rule of thumb:** If it's *knowledge about the world* → brain. If it's *how the agent should behave* → memory.

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

## Installation (Auto-Detect)

On first use, check if `notesmd-cli` is available:

```bash
command -v notesmd-cli >/dev/null 2>&1 && echo "installed" || echo "missing"
```

**If missing**, offer to install from https://github.com/Yakitrak/notesmd-cli:

```bash
# macOS (Homebrew)
brew install yakitrak/yakitrak/notesmd-cli

# Linux / manual
# Download the latest release binary from:
# https://github.com/Yakitrak/notesmd-cli/releases
# Place in /usr/local/bin/notesmd-cli and chmod +x

# Or use the bundled install script (if available)
bash skills/brain/scripts/install-notesmd.sh --vault ./brain
```

After install, configure the vault:

```bash
notesmd-cli set-default --vault ./brain/
```

If the user declines installation, skip brain operations gracefully and note that `/brain` requires `notesmd-cli`.

## Provisioning a New Agent Brain

```bash
mkdir -p brain/{_Templates,Company,Daily,Domains,Intelligence,Playbooks}
notesmd-cli set-default --vault ./brain/
cp skills/brain/templates/*.md brain/_Templates/
notesmd-cli list
```

Then add the protocol snippets below to the agent's config files.

### CLAUDE.md Template Block

Copy the contents of [`claude-md-template.md`](./claude-md-template.md) into the agent's `CLAUDE.md`.

### AGENTS.md Protocol Snippet

Copy the contents of [`agents-md-template.md`](./agents-md-template.md) into the agent's `AGENTS.md`.

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
