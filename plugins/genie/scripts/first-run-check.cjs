#!/usr/bin/env node
"use strict";

/**
 * First-run detection for genie plugin.
 *
 * Runs on SessionStart. If no AGENTS.md exists in the working directory,
 * auto-scaffolds a minimal one so the workspace is immediately usable.
 *
 * This is non-blocking (always exits 0) and deterministic — same result every run.
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

// Only scaffold if neither AGENTS.md nor CLAUDE.md exists.
// Having either means the workspace is already configured.
if (!fs.existsSync(agentsMd) && !fs.existsSync(claudeMd)) {
  const projectName = path.basename(cwd);
  const content = `# ${projectName}\n\n## Agents\n\nThis project is managed by Genie CLI.\n\n## Conventions\n\n- Follow existing code style and patterns\n- Write tests for new functionality\n- Use conventional commits\n`;

  try {
    fs.writeFileSync(agentsMd, content, "utf-8");
    console.error("");
    console.error("\u{1F9DE} Created AGENTS.md \u2014 you're ready to go!");
    console.error("");
  } catch (err) {
    // Non-fatal: if we can't write (read-only fs, permissions), just warn
    console.error("");
    console.error("\u{1F9DE} Genie \u2014 First Run Detected");
    console.error(`  Could not create AGENTS.md: ${err.message}`);
    console.error("  Create one manually to configure your workspace.");
    console.error("");
  }
}

process.exit(0);
