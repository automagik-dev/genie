---
name: brain
description: "Knowledge graph engine — search, analyze, and manage AI agent brains with confidence scoring, autoschema, and multimodal support."
---

# /brain — Knowledge Graph Engine

Search, analyze, and manage knowledge brains powered by genie-brain. Brains are Postgres-backed, Obsidian-compatible knowledge vaults with BM25 + vector search, confidence scoring, and agentic autoschema.

## When to Use
- Search for knowledge before answering a question
- Check what the brain knows (and doesn't know) about a topic
- Analyze content with deep reasoning
- Ingest new content into the brain
- Check brain health and coverage gaps

## Prerequisites

Brain must be installed: `genie brain install`
If not installed, guide the user to run the install command.

## Commands

### Search — find knowledge with confidence
```bash
genie brain search "<query>" --brain <id>
```
Returns ranked results with confidence level (FULL/HIGH/PARTIAL/LOW/NONE).
- FULL/HIGH → brain knows this well, use the results
- PARTIAL → brain has some info, may need to supplement
- LOW/NONE → gap detected, go external or research

**Always search before answering domain questions.** If confidence is LOW/NONE, say so — don't hallucinate.

### Health — check brain quality
```bash
genie brain health --path <brain-path> [--fix]
```
7-dimension score: Schema, Freshness, Coverage, Connections, Content, Conflicts, Acceptance.
`--fix` auto-repairs: adds missing dates, converts tags, generates MOCs.

### Status — brain dashboard
```bash
genie brain status
```
Lists all registered brains with file counts, health, and query stats.

### Init — create a new brain
```bash
genie brain init --name <name> --path <path> [--type gtm|pm|engineering|research|personal]
```
Creates an Obsidian-compatible vault with autoschema. Brain types provide base scaffolding.

### Process — ingest new content
```bash
genie brain process --brain <id> --path <path>
```
Processes files in `to_process/`:
- Markdown → classified and moved to decided folder
- Images → described via Gemini Vision → .desc.md
- Audio → transcribed → .transcript.md
- PDF → extracted → .extracted.md
- Code → symbols extracted → .symbols.md

### Analyze — deep reasoning via rlmx
```bash
genie brain analyze "<query>" --brain <id> --path <path>
```
Uses rlmx reasoning engine for deep analysis with file references.

### Link — discover connections
```bash
genie brain link --brain <id>
```
Generates wikilinks from tag overlap and wikilink references.

## How Agents Should Use This

### Before answering domain questions:
1. Search the brain: `genie brain search "<topic>" --brain <my-brain-id>`
2. Check confidence level
3. If FULL/HIGH → cite the results
4. If PARTIAL → use results + note limitations
5. If NONE → say "brain doesn't cover this" and research externally

### After learning something new:
1. Write a .md file with frontmatter to `brain/to_process/`
2. Run `genie brain process` to classify and index it
3. The brain grows over time

### Session hygiene:
- Start: check `genie brain status` for brain health
- During: search brain before making claims
- End: write session learnings to brain

## Brain Types

| Type | Use Case | Base Folders |
|------|----------|-------------|
| `gtm` | Marketing, competitive intel | Intelligence/, DevRel/, Company/ |
| `pm` | Product management | Backlog/, Roadmap/, Specs/ |
| `engineering` | Architecture, code | Architecture/, Decisions/, Runbooks/ |
| `research` | R&D, papers | Papers/, Notes/, Experiments/ |
| `personal` | Personal knowledge (PARA) | Projects/, Areas/, Resources/ |
| `generic` | Auto-decided by content | (autoschema decides) |

## Confidence Levels

| Level | Meaning | Agent Action |
|-------|---------|-------------|
| **FULL** | Brain knows this well (3+ strong results) | Use directly, cite sources |
| **HIGH** | Good coverage (2+ results) | Use with confidence |
| **PARTIAL** | Some info available | Use + supplement if needed |
| **LOW** | Weak match | Go external, mention brain gap |
| **NONE** | Brain doesn't know this | Research externally, don't guess |

## Available Brains on This Server

Run `genie brain status` to see all. Current brains include:
- **genie-gtm** — Marketing intelligence, competitors, DevRel
- **vegapunk** — R&D, architecture, code analysis
- **totvs** — Client project management
- **sofia** — Personal assistant knowledge
- **namastex-global** — Company-wide shared knowledge

## Rules
- **Search before claiming.** If the brain has an answer, use it.
- **Respect confidence.** NONE means NONE — don't fabricate.
- **Write back.** If you learn something the brain should know, add it.
- **Use frontmatter.** All brain files need YAML frontmatter (type, tags, dates).
- **Keep it Obsidian-compatible.** Wikilinks, not regular links.
