#!/usr/bin/env node
"use strict";

/**
 * First-run detection for genie plugin.
 *
 * Runs on SessionStart. If no AGENTS.md exists in the working directory,
 * outputs a message to stderr prompting /onboarding.
 *
 * This is non-blocking (always exits 0) — it only suggests, never forces.
 */

const fs = require("node:fs");
const path = require("node:path");

// Workers don't need onboarding prompts — skip to reduce spawn latency (#712)
if (process.env.GENIE_WORKER === '1') {
  process.exit(0);
}

// Use CLAUDE_CWD if available (set by Claude Code), otherwise process.cwd()
const cwd = process.env.CLAUDE_CWD || process.cwd();
const agentsMd = path.join(cwd, "AGENTS.md");
const claudeMd = path.join(cwd, "CLAUDE.md");

// Only suggest onboarding if neither AGENTS.md nor CLAUDE.md exists.
// Having either means the workspace is already configured.
if (!fs.existsSync(agentsMd) && !fs.existsSync(claudeMd)) {
  console.error("");
  console.error("=".repeat(50));
  console.error("  \u{1F9DE} Genie — First Run Detected");
  console.error("  No AGENTS.md found in this workspace.");
  console.error("");
  console.error("  Run /onboarding to set up your environment.");
  console.error("=".repeat(50));
  console.error("");
}

process.exit(0);
