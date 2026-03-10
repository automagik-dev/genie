<p align="center">
  <picture>
    <img src=".github/assets/genie-header.png" alt="Genie" width="800" />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@automagik/genie"><img alt="npm version" src="https://img.shields.io/npm/v/@automagik/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://github.com/automagik-dev/genie"><img alt="GitHub" src="https://img.shields.io/github/stars/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/automagik-dev/genie?style=flat-square&color=00D9FF" /></a>
  <a href="https://discord.gg/xcW8c7fF3R"><img alt="Discord" src="https://img.shields.io/discord/1095114867012292758?style=flat-square&color=00D9FF&label=discord" /></a>
</p>

<h2 align="center">Wishes in, PRs out.</h2>

<p align="center">Describe the problem. Genie interviews you, plans the work, dispatches agents, and reviews the code.<br/>You approve and ship.</p>

<p align="center">
  <a href="#install">Install</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R">Discord</a>
</p>

---

## What is Genie?

Genie is a CLI that turns vague ideas into shipped PRs through a structured pipeline. Describe what you want — Genie interviews you to capture the full context, builds a plan with acceptance criteria, dispatches specialized agents to execute in parallel, and runs automated review before anything reaches your eyes. You make decisions. Genie does everything else.

## Genie is right for you if

- You've re-explained your codebase architecture to Claude Code for the third time this week
- You have 5+ AI coding tabs open and can't remember which one is doing what
- You've watched an AI agent spiral for 20 minutes because it lost the original context
- You want AI to ask *you* the right questions before writing code, not the other way around
- You want to go to lunch and come back to reviewed PRs, not a stuck terminal
- You want a repeatable process that works the same whether you're focused or half-asleep

---

## Install

```bash
npm install -g @automagik/genie
```

Or via install script: `curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash`

> **Requirements:** macOS or Linux, [Bun](https://bun.sh) 1.3.10+, [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## Quick Start

| Step | Command |
|------|---------|
| **1. Launch** | `genie` |
| **2. Wish** | `/wish fix the authentication bug in the login flow` |
| **3. Ship** | Genie asks questions, builds a plan, executes it. You approve the PR. |

---

## Features

| | | |
|:---:|:---:|:---:|
| **Wish Pipeline** | **Parallel Agents** | **Context Preservation** |
| Brainstorm, plan, execute, review, ship — consistent results every time. | Agents execute in live terminal sessions. Watch them, or check in when done. | Scoped specialists instead of one bloated window. No context rot. |
| **Persistent Memory** | **Automated Review** | **Overnight Execution** |
| Knowledge vault that agents search before answering. Compounds daily. | Severity-tagged review. Nothing ships with CRITICAL or HIGH issues. | Queue wishes before bed. Wake up to reviewed PRs. |
| **10-Critic Council** | **Behavioral Learning** | **Portable Context** |
| 10 specialists critique your design before you commit to anything. | Genie adapts to your codebase conventions and preferences. | Identity, skills, memory — markdown files you own. Git-versioned. |

---

## Without Genie vs. With Genie

| Without | With |
|---|---|
| Re-explain your codebase to Claude every session | Genie interviews you once. Context flows to every agent. |
| Copy-paste requirements, hope it understood | `/wish` captures scope and acceptance criteria upfront |
| One Claude tab per task, alt-tab between 5 of them | Parallel agents in live terminal sessions |
| Eyeball generated code, miss a bug, fix at 2am | Automated `/review` with severity-tagged gaps |
| 45 min in, Claude forgets your instructions | Scoped specialists — no context window accumulates junk |
| 10 min of setup before any work starts | `genie work bd-42` — inherits context automatically |

---

## The Wish Pipeline

`/brainstorm` → `/wish` → `/work` → `/review` → **ship**

| Stage | What happens |
|-------|-------------|
| **Brainstorm** | Think out loud. Genie asks clarifying questions until the idea is concrete. |
| **Wish** | Crystallize intent into a plan with scope and acceptance criteria. |
| **Work** | Agents spawn in isolated worktrees, execute in parallel. |
| **Review** | Automated review with severity gates. Nothing merges without passing. |
| **Ship** | PR created, checks pass, you merge. |

---

<details id="cli-reference">
<summary><strong>CLI Reference</strong></summary>

**Top-level commands:**

| Command | Description |
|---------|-------------|
| `genie` | Launch a session in the current directory |
| `genie work <id>` | Work on a specific task |
| `genie council <topic>` | Run council review on a topic |
| `genie send <message>` | Send a message to an agent |
| `genie inbox` | View pending messages and approvals |
| `genie daemon` | Start background daemon |

**Agent management (`genie agent`):**

| Command | Description |
|---------|-------------|
| `genie agent spawn` | Spawn a new agent |
| `genie agent list` | List running agents |
| `genie agent dashboard` | Live agent dashboard |
| `genie agent approve <id>` | Approve agent action |
| `genie agent answer <id>` | Answer agent question |
| `genie agent history <id>` | View agent history |
| `genie agent events <id>` | Stream agent events |
| `genie agent close <id>` | Close an agent session |
| `genie agent ship <id>` | Ship agent work (create PR) |
| `genie agent kill <id>` | Force-stop an agent |
| `genie agent suspend <id>` | Suspend agent execution |

**Team management (`genie team`):**

| Command | Description |
|---------|-------------|
| `genie team create` | Create a new team |
| `genie team list` | List teams |
| `genie team delete` | Delete a team |
| `genie team blueprints` | View team blueprints |

**Task management (`genie task`):**

| Command | Description |
|---------|-------------|
| `genie task create` | Create a new task |
| `genie task update <id>` | Update task details |
| `genie task ship <id>` | Ship a task |
| `genie task close <id>` | Close a task |
| `genie task ls` | List tasks |
| `genie task link <id>` | Link task to issue |

**Setup and maintenance:**

| Command | Description |
|---------|-------------|
| `genie install` | Install Genie in a project |
| `genie setup` | Interactive setup wizard |
| `genie doctor` | Diagnose configuration issues |
| `genie update` | Update to latest version |

</details>

<details id="configuration">
<summary><strong>Configuration</strong></summary>

### Worker Profiles

Profiles configure how agents are spawned — which launcher to use and which arguments to pass.

```bash
genie profiles list                 # List all profiles (* = default)
genie profiles add <name>           # Add new profile
genie profiles show <name>          # Show details
genie profiles default <name>       # Set default
```

### Hook Presets

Hooks shape how AI interacts with your system. Combine them freely.

| Preset | What it does |
|--------|-------------|
| **Collaborative** | Commands run through live terminal sessions — watch AI work in real-time |
| **Supervised** | File changes require your approval |
| **Sandboxed** | Restrict file access to specific directories |
| **Audited** | Log all AI tool usage to a file |

```bash
genie setup              # Interactive wizard
genie setup --quick      # Recommended defaults (collaborative + audited)
```

### Config Files

| File | Purpose |
|------|---------|
| `~/.genie/config.json` | Hook presets, worker profiles, session settings |
| `~/.claude/settings.json` | Claude Code settings (hooks registered here) |

</details>

---

## Development

```bash
bun run build     # Build CLI
bun run check     # Typecheck + lint + dead-code + test
bun test          # Run tests
genie doctor      # Diagnose issues
```

Uninstall: `curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash -s -- uninstall`

---

<p align="center">
  <a href="https://github.com/automagik-dev/genie">GitHub</a> &middot;
  <a href="https://discord.gg/xcW8c7fF3R">Discord</a> &middot;
  <a href="LICENSE">MIT License</a>
</p>

<p align="center">
  <sub>You make the decisions. Genie does everything else.</sub>
</p>
