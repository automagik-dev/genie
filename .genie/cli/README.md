# GENIE CLI Architecture

This directory hosts the runtime wrapper that powers `./genie` commands. The CLI is responsible for
routing user requests, launching Codex (via `npx -y @namastexlabs/codex@0.43.0-alpha.5` or other executors), tracking background runs, and exposing
tooling for inspection.

## Module Map

```
.genie/cli/
├── dist/                 # Compiled JavaScript emitted by `pnpm run build:genie`
├── src/                  # TypeScript sources
│   ├── genie.ts          # Thin orchestrator entry point (143 lines)
│   ├── commands/         # Command implementations
│   │   ├── run.ts        # `genie run` - start new agent session
│   │   ├── resume.ts     # `genie resume` - continue existing session
│   │   ├── list.ts       # `genie list` - show agents/sessions
│   │   ├── view.ts       # `genie view` - display session transcript
│   │   ├── stop.ts       # `genie stop` - terminate background session
│   │   └── help.ts       # `genie help` - show usage information
│   ├── lib/              # Shared utilities and configuration
│   │   ├── types.ts      # TypeScript interfaces (CLIOptions, ParsedCommand, etc.)
│   │   ├── cli-parser.ts # Argument parsing logic
│   │   ├── config.ts     # Configuration loading and merging
│   │   ├── utils.ts      # Formatters, sanitizers, time utilities
│   │   ├── agent-resolver.ts # Agent discovery and spec loading
│   │   └── session-helpers.ts # Session status and metadata helpers
│   ├── executors/        # Pluggable executor implementations
│   │   ├── types.ts      # Executor interface definition
│   │   ├── codex.ts      # Codex executor adapter
│   │   └── codex-log-viewer.ts # Codex JSONL parser
│   ├── views/            # View rendering (output formatting)
│   ├── background-manager.ts # Process spawning and lifecycle
│   └── session-store.ts  # Session persistence layer
├── tsconfig.json         # TypeScript compiler configuration
├── config.yaml           # Default configuration merged into runtime config
└── README.md             # This document
```

### Architecture Overview

The CLI follows a clean layered architecture after modularization (2,105 → 143 lines in `genie.ts`):

1. **Orchestration Layer** (`genie.ts`) - Thin entry point that routes commands
2. **Command Layer** (`commands/`) - Isolated command implementations
3. **Library Layer** (`lib/`) - Shared utilities, config, and helpers
4. **Executor Layer** (`executors/`) - Pluggable backend adapters
5. **View Layer** (`views/`) - Output rendering and formatting
6. **Infrastructure** (`background-manager.ts`, `session-store.ts`) - Process and state management

### `genie.ts` (Orchestration Layer)

The entry point has been streamlined to 143 lines (93% reduction from 2,105 lines) and now serves purely as a thin orchestrator:

* Parses CLI arguments via `parseArguments()` from `lib/cli-parser`
* Loads configuration using `loadConfig()` and applies defaults
* Routes commands to dedicated command handlers in `commands/`
* Handles help flags and error states
* Emits startup and runtime warnings

**Key principle:** No business logic - all implementation details moved to specialized modules.

### `commands/` (Command Layer)

Each command is isolated in its own module with clear responsibilities:

* **`run.ts`** - Starts new agent sessions, resolves agent specs, builds executor commands, launches foreground or background processes
* **`resume.ts`** - Continues existing sessions by loading session metadata and invoking executor resume commands
* **`list.ts`** - Lists available agents or active/past sessions with status information
* **`view.ts`** - Displays session transcripts using executor-specific log viewers with formatting options (full, live, filtered)
* **`stop.ts`** - Terminates background sessions gracefully with process lifecycle management
* **`help.ts`** - Generates usage information and command documentation

### `lib/` (Library Layer)

Shared utilities extracted from the original monolith:

* **`types.ts`** - TypeScript interfaces: `CLIOptions`, `ParsedCommand`, `ConfigPaths`, `GenieConfig`, `AgentSpec`, `ExecuteRunArgs`
* **`cli-parser.ts`** - Argument parsing logic converting argv into `ParsedCommand` structure
* **`config.ts`** - Configuration loading, merging, path resolution, directory preparation, and default application
* **`utils.ts`** - Common utilities: `formatRelativeTime`, `formatPathRelative`, `truncateText`, `sanitizeLogFilename`, `safeIsoString`, `deriveStartTime`, `deriveLogFile`
* **`agent-resolver.ts`** - Agent discovery: `listAgents`, `resolveAgentIdentifier`, `agentExists`, `loadAgentSpec`, `extractFrontMatter`
* **`session-helpers.ts`** - Session utilities: `findSessionEntry`, `resolveDisplayStatus`, runtime warning management

### `background-manager.ts`
* Thin wrapper around `child_process.spawn` that launches `node genie.js ...` in a detached mode.
* Annotates children with metadata (launch time, log file, arguments) and exposes simple controls:
  * `launch()` – spawn background process and emit lifecycle events.
  * `stop()` / `isAlive()` – manage or query background workers.
  * `list()` – enumerate tracked child processes.

### `session-store.ts`
* Abstracts reading/writing the session ledger (`sessions.json`).
* Handles minor migration work (ensuring every entry has an executor name).
* Designed to stay storage-format agnostic so executors/CLI can evolve independently.

### `executors/codex.ts`
* Defines the contract for invoking Codex. Key responsibilities:
  * Provide defaults (`binary`, package spec, session directory, CLI flags) consumed by `genie.js`.
  * `buildRunCommand` and `buildResumeCommand` – convert tool config into shell arguments (e.g. `npx -y @namastexlabs/codex@0.43.0-alpha.5 exec`).
  * `resolvePaths` – executor-specific paths (session transcripts).
  * `extractSessionId` / `getSessionExtractionDelay` – hook used by the CLI to capture session IDs from Codex artifacts.
  * `logViewer` – attach Codex-specific interpretation logic (imported from `codex-log-viewer.js`).

### `executors/codex-log-viewer.ts`
* Encapsulates everything required to understand Codex experimental JSON logs:
  * Session ID extraction from streamed JSON lines.
  * Rendering logic used by `genie view` (reasoning summaries, assistant output, MCP/tool statistics, token usage, stream errors).
* By pushing this code into the executor boundary, `genie.js` stays executor-agnostic.

## Execution Flow (Happy Path)

Modern modular flow with clear layer separation:

1. **User invokes**: `./genie run hello-coder "Prompt..."`

2. **Orchestration** (`genie.ts`):
   - Parses arguments via `lib/cli-parser`
   - Loads config via `lib/config`
   - Prepares directories
   - Routes to `commands/run.ts`

3. **Command handler** (`commands/run.ts`):
   - Resolves agent spec via `lib/agent-resolver`
   - Loads executor (e.g., `executors/codex.ts`)
   - Builds command via executor's `buildRunCommand()`
   - Launches process (foreground or background via `background-manager.ts`)
   - Streams logs to `.genie/state/agents/logs/`

4. **Session tracking** (`session-store.ts`):
   - Persists session metadata to `sessions.json`
   - Enables `genie list sessions` and `genie resume`

5. **View/resume** (`commands/view.ts`, `commands/resume.ts`):
   - Loads session via `lib/session-helpers`
   - Uses executor's `logViewer` to parse/format logs
   - Or invokes executor's `buildResumeCommand()` to continue

**Key advantage**: Each layer can be tested/modified independently without touching others.

## Build & Test Workflow

```
pnpm run build:genie   # compile TypeScript sources to .genie/cli/dist
pnpm run test:genie    # build + run lightweight CLI unit tests
```

The `./genie` shell script executes `node .genie/cli/dist/genie.js`, so the CLI works immediately
after a successful build (compiled artifacts are committed alongside the sources).

## Background Runs

* Background runs reuse the same entrypoint (`genie.js`) but are spawned in a separate Node process.
* Launch metadata is stored both in-memory (`BackgroundManager`) and on disk (`sessions.json`).
* `genie list sessions` surfaces the status by combining session information with `BackgroundManager.isAlive()` checks.

## Adding a New Executor

The modular architecture makes adding new executors straightforward:

1. **Create executor implementation** at `src/executors/<name>.ts`:
   ```ts
   import { Executor } from './types';

   const myExecutor: Executor = {
     defaults,                    // Default config (binary, model, flags)
     buildRunCommand,             // Convert config → shell command for new sessions
     buildResumeCommand,          // Convert config → shell command for resume
     resolvePaths,                // Executor-specific paths (session storage)
     extractSessionId,            // Parse session ID from logs
     getSessionExtractionDelay,   // Delay before ID extraction (ms)
     logViewer                    // Optional: custom log viewer
   };

   export default myExecutor;
   ```

2. **(Optional) Create log viewer** at `src/executors/<name>-log-viewer.ts` if your executor emits structured logs:
   ```ts
   import { LogViewer } from './types';

   export const myLogViewer: LogViewer = {
     extractSessionIdFromContent,  // Parse session ID from log content
     renderView                    // Format logs for `genie view`
   };
   ```

3. **Build and test**:
   ```bash
   cd .genie/cli
   pnpm run build:genie

   # Executor is auto-discovered from dist/executors/
   ./genie list agents
   ```

**No changes to `genie.ts` required** - executors are loaded dynamically from the `executors/` directory.

## Known Redundancies / Dead Code

* The CLI still contains Codex-biased help text and prompts; consider moving these into executor metadata for easier reuse.

## Codex Parameters

The CLI supports all standard Codex execution parameters. These are configured via agent frontmatter (sandbox, approvalPolicy, reasoningEffort) or defaults in `config.yaml`:

### Core Parameters
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| **prompt** | string | - | The initial user prompt to start the conversation (required) |
| **model** | string | `gpt-5-codex` | Model to use (e.g., `o3`, `o4-mini`) |
| **sandbox** | string | `workspace-write` | Sandbox mode: `read-only`, `workspace-write`, `danger-full-access` |
| **profile** | string | null | Configuration profile from config.toml |
| **cd** | string | null | Working directory for the agent to use as root (via `-C, --cd`) |

### Feature Flags
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| **include-plan-tool** | boolean | false | Whether to include the plan tool |
| **skip-git-repo-check** | boolean | false | Skip git repository verification |
| **json** | boolean | false | Output in JSON format |
| **experimental-json** | boolean | true | Use experimental JSON streaming |
| **full-auto** | boolean | true | Run without user interaction (sets workspace-write + bypass approvals) |

### Advanced Options
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| **output-schema** | string | null | Schema for structured output |
| **output-last-message** | string | null | Path to save last message |
| **reasoning-effort** | string | `low` | Reasoning effort: `low`, `medium`, `high` |
| **color** | string | `auto` | Color output mode |
| **images** | array | [] | Image paths to include |
| **additional-args** | array | [] | Extra arguments to pass through |

### Configuration Priority
1. Command-line arguments (highest priority)
2. Preset configuration (from `config.yaml`)
3. Default values in `codex.ts` (lowest priority)

## Approval Modes & Sandbox Settings

### Approval Control
Codex does not expose granular approval policy flags in the CLI. Instead, it provides two modes:

| Mode | Flag | Description |
|------|------|-------------|
| **Sandboxed auto** | `--full-auto` | Automatic execution with workspace-write sandbox (recommended) |
| **Bypass all** | `--dangerously-bypass-approvals-and-sandbox` | Skip all prompts and sandbox (DANGEROUS, for externally sandboxed environments only) |

Approval behavior is controlled by the `--full-auto` flag combined with sandbox mode. Fine-grained approval policies can be configured via `~/.codex/config.toml` (see Codex documentation).

### Sandbox Modes
| Mode | Flag | Description |
|------|------|-------------|
| **read-only** | `--sandbox read-only` | Can only read files, no edits or commands |
| **workspace-write** | `--sandbox workspace-write` | Can edit files and run commands in workspace |
| **danger-full-access** | `--sandbox danger-full-access` | Full system access (use with caution) |

### Common Combinations
| Intent | Flags | Effect |
|--------|-------|--------|
| **Safe browsing** | `--sandbox read-only` | Read files only, no edits/commands |
| **Auto mode (recommended)** | `--full-auto` | Sandboxed workspace-write with automatic execution |
| **Edit repo manually** | `--sandbox workspace-write` | Edit workspace with interactive approvals |
| **YOLO (DANGEROUS)** | `--dangerously-bypass-approvals-and-sandbox` | No sandbox, no prompts - for externally sandboxed environments only |

### Default Behavior
- **Version-controlled folders**: Auto mode (`--full-auto` = workspace-write sandbox with automatic execution)
- **Non-version-controlled folders**: Read-only mode recommended (`--sandbox read-only`)
- **Network access**: Controlled by Codex sandbox policy (see Codex config.toml documentation)
- **Workspace scope**: Current directory + temporary directories (/tmp)

### Fine-tuning in config.toml
Network access can be enabled for workspace-write mode:
```toml
[sandbox_workspace_write]
network_access = true
```

## Recent Improvements (2025-09-30)

### Completed: CLI Modularization

The CLI underwent a comprehensive modularization refactor, reducing the main entry point from **2,105 lines to 143 lines** (93% reduction):

✅ **Modularised CLI Concerns** - Separated into dedicated layers:
  - `commands/` - Isolated command implementations (run, resume, list, view, stop, help)
  - `lib/` - Shared utilities (types, cli-parser, config, utils, agent-resolver, session-helpers)
  - Clean dependency flow: `genie.ts` → `commands/` → `lib/` → `executors/`

✅ **Types Extraction** - All TypeScript interfaces centralized in `lib/types.ts` to prevent circular dependencies

✅ **Transcript Parsing Consolidation** - Unified duplicate transcript parsing logic into `executors/transcript-utils.ts`

### Benefits Realized

- **Maintainability**: Clear separation of concerns, easy to locate and modify specific functionality
- **Testability**: Isolated modules can be unit tested independently
- **Readability**: 121-line orchestrator is trivial to understand at a glance
- **Extensibility**: Adding new commands requires only creating a new file in `commands/`
- **Zero Regressions**: Behavior-preserving refactor validated via comprehensive snapshot testing

### Future Enhancement Ideas

1. **Executor Registry** – Load executors dynamically (filesystem or config-driven) instead of hardcoding `EXECUTORS` to enable pluggable backends.
2. **Shared Log Viewer Contract** – Formalize the viewer interface (TypeScript typings or JSDoc) so each executor implements `extractSessionIdFromContent`, `renderJsonlView`, etc.
3. **Session Store Schema Versioning** – Introduce explicit migrations when we add fields (e.g., tokens, last command) to avoid ad hoc checks.
4. **Upgrade Background Manager** – Enrich `genie stop <sessionId>` (timeouts, SIGKILL fallback, richer logging).
5. **Improve Error Surfacing** – Bubble executor startup failures (like MCP timeouts) back to the main CLI rather than only appearing in `genie view`.
6. **Testing Harness** – Add unit tests for session-store + log viewer using captured JSON fixtures to prevent regressions when Codex schema shifts.
7. **Runtime Diagnostics** – Add structured logging (JSONL) around executor launches to aid debugging without inspecting raw log files.
