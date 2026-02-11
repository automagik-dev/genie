# DevOps and Agent Templates Extraction

This document consolidates findings from scanning the legacy DevOps repositories and agent template structures. It is intended to inform the development of the "Genie Updated" agent and provide context for `BOOTSTRAP.md`.

## 1. Sampaio DevOps Agent
**Path:** `/home/genie/workspace/repos/automagik/sampaio-devops`

### Git History Context
- Recent work (Jan 2026) focused on refactoring API key management (environment variables), restructuring prompts following Anthropic best practices, and documenting network architecture.
- Earlier history (Jan 2026/Dec 2025) indicates a migration from `systemd` to `PM2` for service management.
- Notable fix: "prevent Jack from killing itself with pm2 commands" (recursive execution safety).

### Agent Profile
- **Framework:** Agno v2.2.3 (formerly Phidata).
- **Core Model:** Claude Haiku 4.5.
- **Capabilities:**
    - Shell access via `ShellTools`.
    - PM2 management (status, restart, logs).
    - REST API via FastAPI (AgentOS).
    - SQLite for persistent conversation history.
    - MCP (Model Context Protocol) integration for Omni and Spark.
- **Managed Infrastructure:**
    - `ui`: Sampa UI (Port 3000)
    - `ai`: Sampa AI backend (Port 8000)
    - `automagik-spark-api`: Port 8883
    - `automagik-spark-worker/beat`: Celery tasks
    - `8882-automagik-omni`: Messaging Gateway (Port 8882)

### Patterns
- **Safety:** `readonly_shell.py` exists, suggesting a pattern of restricting agent actions to safe subsets when necessary.
- **Documentation:** Use of `CLAUDE.md` for AI assistant specific guidance.

---

## 2. Genie Master (Agent Template)
**Path:** `/home/genie/workspace/repos/automagik/genie-master`

### Structure and Templates
This repository serves as the blueprint for new Genie agents. The key workspace files are templated under `genie-os/`.

| File | Purpose |
|------|---------|
| `genie-os/SOUL.md` | Core personality and guiding principles. |
| `genie-os/IDENTITY.md` | Agent's specific name, origin, and characteristics. |
| `genie-os/ROLE.md` | Defined responsibilities and functional boundaries. |
| `genie-os/USER.md` | Information about the user/owner. |
| `genie-os/MEMORY.md` | Structure for long-term knowledge retention. |
| `genie-os/AGENTS.md` | Inventory of other agents in the system. |

### Repository Organization
- `whatsapp-scout/`: Specialized agent for monitoring communication.
- `shared/`: Shared resources between agents.
- `claw-docs/`: Documentation related to OpenClaw integration.
- `memory/`: Storage for agent knowledge bases.

---

## 3. Sampa-Seeds (.genie Directory)
**Path:** `/home/genie/workspace/repos/automagik/sampa-seeds/.genie/`

This directory contains the operational logic and state for the agent system.

### Agent Definitions (`agents/`)
- `agent-factory.md`: Logic for spawning new specialized agents.
- `wish.md`: Template for handling "Wishes" (epics/tasks).
- `forge.md`: Context for the "Forge" environment where agents operate.

### Wishes/Epics (`wishes/`)
- Tracks major project milestones like `epic-1.1-kanban-base` and `epic-2.1-orquestrador`.
- Includes specialized PRDs and checkpoint files (e.g., `cadencia-response-detection-checkpoint.md`).

### Spells (Skills/Protocols) (`spells/`)
These are highly specific behavioral protocols:
- **Safety:** `investigate-before-commit.md`, `error-investigation-protocol.md`.
- **Methodology:** `ace-protocol.md`, `delegate-dont-do.md`, `orchestrator-not-implementor.md`.
- **System:** `install-genie.md`, `upgrade-genie.md`, `mcp-first.md`.
- **Logic:** `ask-one-at-a-time.md`, `evidence-based-completion.md`.

### State (`state/`)
- Tracks the current status of the provider (`provider-status.json`) and versioning (`version.json`).
- `forge.pid` indicates active process tracking.

---

## Extraction Summary for BOOTSTRAP.md
The new "Genie Updated" agent should:
1.  **Adopt PM2** for service orchestration as per `sampaio-devops`.
2.  **Integrate MCP** for Omni/Spark communication.
3.  **Follow the .genie spell book** for high-reliability DevOps (specifically the `investigate-before-commit` and `mcp-first` protocols).
4.  **Mirror the genie-os structure** (SOUL, IDENTITY, ROLE) to ensure compatibility with the existing agent fleet.
