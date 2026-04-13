# Wish: Omni Skill Upgrade — Three-Tier Agent DX

| Field | Value |
|-------|-------|
| **Status** | SHIPPED (verified 2026-04-08) |
| **Slug** | `omni-skill-upgrade` |
| **Date** | 2026-04-06 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |
| **Repo** | `automagik-dev/omni` |
| **PR** | automagik-dev/omni#356 |
| **Depends-on** | `omni-turn-based-dx` (PRs #353-355 for CLI verbs) |

## Summary

The omni plugin has 17 flat infrastructure-level skills that nobody uses because they teach `omni send --instance --to` when the natural way is `omni say "hello"`. Replace all 17 with 3 tier skills: `omni-agent` (verb workflow for agents), `omni-setup` (first-time install + connect), and `omni-ops` (admin mini-router). Add always-on rules for turn-based agent behavior. Follow the `@khal-os/brain` install pattern.

## Scope

### IN
- **Delete all 17 existing skills** — clean slate
- **`omni-agent` skill** — verb reference (say/speak/imagine/react/see/listen/history/done), send edge cases (media/polls/locations), message search, chat history
- **`omni-agent` rules** — always-on behavioral rules for turn-based agents in `plugins/omni/rules/omni-agent.md`
- **`omni-setup` skill** — install omni, connect instance to agent, start bridge, verify health
- **`omni-ops` skill** — mini-router to admin operations (instances, routes, providers, config, events, automations, webhooks, prompts, persons, batch)
- **Master `/omni` router rewrite** — 3-tier keyword routing (agent > setup > ops)
- **Update `plugin.json`** — bump version, update skill list

### OUT
- Changes to omni CLI commands (done in `omni-turn-based-dx`)
- Changes to genie bridge or SDK executor (done in `omni-turn-based-dx`)
- New CLI commands
- Agent definitions in `plugins/omni/agents/` (keep as-is)
- Command reference files in `plugins/omni/commands/` (keep as-is)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Delete all 17, replace with 3 | Clean slate. No backward compat needed. 17 flat skills are undiscoverable — 3 tiers cover all intents. |
| `omni-ops` is a mini-router, not a monolith | Routes keywords to inline sections, not external sub-files. Keeps everything in one readable file per tier. |
| Rules file for turn-based behavior | Rules are always-on in context. Skills are on-demand. "Call done" must be always-on. Rules are conditional: only apply when `OMNI_INSTANCE` env var is present. |
| Follow `@khal-os/brain` pattern | Skills ship inside npm package at `plugins/omni/skills/`. Proven install pattern. |
| Agent tier gets priority in router | Most users are agents wanting to talk. Setup is second. Ops is last. |

## Success Criteria

- [ ] 17 old skill directories deleted from `plugins/omni/skills/`
- [ ] `omni-agent/SKILL.md` exists with verb reference covering say, speak, imagine, react, see, listen, history, done
- [ ] `omni-agent/SKILL.md` includes send edge cases (media, polls, locations)
- [ ] `plugins/omni/rules/omni-agent.md` exists with turn-based lifecycle rules
- [ ] `omni-setup/SKILL.md` exists with install → connect → bridge → verify flow
- [ ] `omni-ops/SKILL.md` exists as mini-router covering instances, routes, providers, config, events, automations, webhooks, prompts, persons, batch
- [ ] `omni/SKILL.md` (master router) rewritten with 3-tier keyword routing
- [ ] `/omni say hello` routes to `omni-agent`
- [ ] `/omni install` routes to `omni-setup`
- [ ] `/omni instances list` routes to `omni-ops`
- [ ] `plugin.json` version bumped

## Execution Strategy

### Wave 1 (parallel — all independent skill files)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Delete 17 old skills + write `omni-agent` skill + rules |
| 2 | engineer | Write `omni-setup` skill |
| 3 | engineer | Write `omni-ops` mini-router skill |

### Wave 2 (after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 4 | engineer | Rewrite master `/omni` router + bump plugin.json |
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: `omni-agent` Skill + Rules

**Goal:** The skill an agent loads to communicate via omni — verb reference, turn-based lifecycle, and always-on rules.

**Deliverables:**
1. Delete all 17 directories under `plugins/omni/skills/` (keep the `skills/` dir itself)
2. Create `plugins/omni/skills/omni-agent/SKILL.md`:
   - Frontmatter: `name: omni-agent`, `description: ...`, `allowed-tools: Bash(omni *)`
   - **Verb Reference** section with each verb command, syntax, and example:
     - `omni say "text"` — send text reply
     - `omni speak "text" [--voice Kore] [--language pt-BR]` — voice note via TTS
     - `omni imagine "prompt"` — generate and send image
     - `omni react "emoji" --message <id>` — react to a message
     - `omni see <file> ["prompt"]` — describe image/video via Gemini Vision
     - `omni listen <file> [--language pt]` — transcribe audio
     - `omni history [--limit N] [--before <id>]` — read conversation messages
     - `omni done ["text"]` — close turn (required as last action)
   - **Send Edge Cases** section: `omni send --media`, `--poll`, `--location`, `--sticker`
   - **Message Operations** section: `omni messages search "query"`, read receipts
   - **Chat Operations** section: `omni chats list`, chat history
   - **Turn-Based Lifecycle** section: receive → `omni history` → reply via verbs → `omni done`
   - **Context** section: env vars pre-set by bridge (`OMNI_INSTANCE`, `OMNI_CHAT`, `OMNI_MESSAGE`)
3. Create `plugins/omni/rules/` directory
4. Create `plugins/omni/rules/omni-agent.md`:
   - Conditional: "If `OMNI_INSTANCE` is set in your environment, these rules apply"
   - ALWAYS call `omni done` as your last action
   - NEVER use `omni use` or `omni open` — context is pre-set
   - NEVER output bare text as a reply — use `omni say` to deliver messages
   - Use `omni history` to see message IDs before reacting
   - You can send multiple messages before calling `omni done`

**Acceptance Criteria:**
- [ ] All 17 old skill directories deleted
- [ ] `omni-agent/SKILL.md` covers all 8 verb commands with syntax + examples
- [ ] `omni-agent/SKILL.md` includes send edge cases, message ops, chat ops
- [ ] `rules/omni-agent.md` exists with conditional turn-based rules
- [ ] Rules are conditional on `OMNI_INSTANCE` env var

**Validation:**
```bash
cd /home/genie/workspace/repos/omni
# Old skills deleted
test $(ls plugins/omni/skills/ | wc -l) -le 5
# New skill exists
test -s plugins/omni/skills/omni-agent/SKILL.md
# Rules exist
test -s plugins/omni/rules/omni-agent.md
# Verb commands documented
grep -c "omni say\|omni speak\|omni imagine\|omni react\|omni history\|omni done\|omni see\|omni listen" plugins/omni/skills/omni-agent/SKILL.md
```

**depends-on:** none

---

### Group 2: `omni-setup` Skill

**Goal:** The "I just want it working" skill — install, connect, plug agent, verify.

**Deliverables:**
1. Create `plugins/omni/skills/omni-setup/SKILL.md`:
   - Frontmatter: `name: omni-setup`, `description: ...`, `allowed-tools: Bash(omni *), Bash(genie *)`
   - **Quick Start** section: 4-step flow
     1. Install: `omni install` (or check `omni auth status`)
     2. Scan QR: `omni instances list` → connect WhatsApp
     3. Connect agent: `omni connect <instance> <agent-name>`
     4. Start bridge: `genie omni start --executor sdk`
   - **Verify** section: `omni where`, `omni say "test"`, `genie ls --source omni`
   - **Troubleshooting** section: common issues (NATS not running, PG not reachable, agent not found in directory)
   - **Instance Management** basics: `omni instances list`, `omni instances get <id>`

**Acceptance Criteria:**
- [ ] `omni-setup/SKILL.md` exists with 4-step quick start
- [ ] Includes verify commands
- [ ] Includes troubleshooting for common issues

**Validation:**
```bash
test -s plugins/omni/skills/omni-setup/SKILL.md
grep -c "omni connect\|omni install\|genie omni start" plugins/omni/skills/omni-setup/SKILL.md
```

**depends-on:** none

---

### Group 3: `omni-ops` Mini-Router Skill

**Goal:** Admin/power-user entry point that covers all infrastructure operations in one skill.

**Deliverables:**
1. Create `plugins/omni/skills/omni-ops/SKILL.md`:
   - Frontmatter: `name: omni-ops`, `description: ...`, `allowed-tools: Bash(omni *), Bash(jq *)`
   - **Keyword routing table** at the top (like the master router, but for ops):
     - instances, connect, disconnect, QR, sync → Instances section
     - routes, routing, agent route → Routes section
     - providers, agent providers → Providers section
     - config, settings, API keys → Config section
     - events, analytics, timeline, replay → Events section
     - automations, triggers, workflows → Automations section
     - webhooks, custom events → Webhooks section
     - prompts, LLM prompt, gate → Prompts section
     - persons, contacts, presence → Persons section
     - batch, transcribe, extract → Batch section
   - Each section: 5-10 lines of key commands + patterns (not full documentation — just the commands an admin needs)
   - Reference the existing `commands/*.md` files for deep dives where they exist

**Acceptance Criteria:**
- [ ] `omni-ops/SKILL.md` exists with keyword routing table
- [ ] Covers all 10 operational areas (instances, routes, providers, config, events, automations, webhooks, prompts, persons, batch)
- [ ] Each area has key commands documented

**Validation:**
```bash
test -s plugins/omni/skills/omni-ops/SKILL.md
grep -c "instances\|routes\|providers\|config\|events\|automations\|webhooks\|prompts\|persons\|batch" plugins/omni/skills/omni-ops/SKILL.md
```

**depends-on:** none

---

### Group 4: Master Router Rewrite + Plugin Version

**Goal:** `/omni` routes to the right tier by keyword. Clean, prioritized, 3 entry points.

**Deliverables:**
1. Rewrite `plugins/omni/skills/omni/SKILL.md`:
   - Keep frontmatter (name, description, allowed-tools)
   - **Health check** on bare invocation: `omni auth status --json`
   - **3-tier routing** (prioritized order):
     ```
     Agent tier (highest priority):
       say, speak, imagine, react, history, done, reply, respond,
       send, message, media, voice, listen, see, chat,
       turn-based, WhatsApp → omni-agent/SKILL.md
     
     Setup tier:
       install, setup, connect, start, configure, plug,
       get started, first time, QR, scan → omni-setup/SKILL.md
     
     Ops tier:
       instances, routes, providers, config, events, automations,
       webhooks, prompts, persons, batch, debug, admin,
       status, logs, restart → omni-ops/SKILL.md
     ```
   - If no keyword match, default to `omni-agent` (most common use case)
2. Update `plugins/omni/.claude-plugin/plugin.json`: bump version to `3.0.0`

**Acceptance Criteria:**
- [ ] Master router has 3-tier keyword routing
- [ ] Agent tier is highest priority
- [ ] Default routes to `omni-agent`
- [ ] `plugin.json` version bumped

**Validation:**
```bash
grep -c "omni-agent\|omni-setup\|omni-ops" plugins/omni/skills/omni/SKILL.md
cat plugins/omni/.claude-plugin/plugin.json | grep version
```

**depends-on:** Groups 1, 2, 3

---

## Dependencies

```
Wave 1 (parallel)
  Group 1 (omni-agent + rules)  ──┐
  Group 2 (omni-setup)            ─┤
  Group 3 (omni-ops)              ─┤
                                    │
Wave 2                              │
  Group 4 (master router) ←────────┘
  Review ←── all
```

## QA Criteria

- [ ] `/omni say hello` loads `omni-agent` skill
- [ ] `/omni install` loads `omni-setup` skill
- [ ] `/omni instances list` loads `omni-ops` skill
- [ ] No references to deleted skills in any remaining files
- [ ] Rules file loads conditionally when `OMNI_INSTANCE` is set
- [ ] Plugin installs cleanly

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Content from deleted skills lost | Low | All CLI commands are self-documenting (`--help`). `omni-ops` covers admin commands. `commands/*.md` files preserved. |
| `omni-ops` too large | Low | It's a routing table + command summaries, not full docs. Each section is 5-10 lines. |
| Plugin not in marketplace | Medium | Separate step to publish after this wish ships |

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
# DELETE (17 skill directories)
plugins/omni/skills/omni-agent-setup/
plugins/omni/skills/omni-agents/
plugins/omni/skills/omni-automations/
plugins/omni/skills/omni-batch/
plugins/omni/skills/omni-chats/
plugins/omni/skills/omni-config/
plugins/omni/skills/omni-events/
plugins/omni/skills/omni-install/
plugins/omni/skills/omni-instances/
plugins/omni/skills/omni-messages/
plugins/omni/skills/omni-persons/
plugins/omni/skills/omni-prompts/
plugins/omni/skills/omni-providers/
plugins/omni/skills/omni-routes/
plugins/omni/skills/omni-send/
plugins/omni/skills/omni-webhooks/

# CREATE
plugins/omni/skills/omni-agent/SKILL.md
plugins/omni/skills/omni-setup/SKILL.md
plugins/omni/skills/omni-ops/SKILL.md
plugins/omni/rules/omni-agent.md

# MODIFY
plugins/omni/skills/omni/SKILL.md (rewrite master router)
plugins/omni/.claude-plugin/plugin.json (version bump)
```
