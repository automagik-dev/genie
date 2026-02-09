#!/usr/bin/env node
/**
 * Validate a wish document structure before writing.
 * Used by PreToolUse hook to catch missing sections.
 *
 * Pure Node.js - no Bun dependency.
 *
 * Usage: node validate-wish.cjs --file <path-to-wish.md>
 *        node validate-wish.cjs --help
 *
 * Hook integration: Receives JSON on stdin from Claude Code PreToolUse event.
 * Falls back to --file flag for manual testing.
 */

import { readFileSync, existsSync } from "fs";
import { parseArgs as _parseArgs } from "util";

// Parse CLI args - util.parseArgs requires Node 18.3+, fallback for older versions
let values: Record<string, unknown> = {};
try {
  const result = _parseArgs({
    args: process.argv.slice(2),
    options: {
      file: { type: "string", short: "f" },
      help: { type: "boolean", short: "h" },
    },
    strict: false, // allow unknown flags from hook runner
  });
  values = result.values;
} catch {
  // Fallback: manual arg parsing for Node < 18.3
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--file" || args[i] === "-f") && args[i + 1]) {
      values.file = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      values.help = true;
    }
  }
}

if (values.help) {
  console.log(`
validate-wish - Validate wish document structure

Usage:
  node validate-wish.cjs --file <path-to-wish.md>
  node validate-wish.cjs --help

As a PreToolUse hook, receives JSON on stdin with tool_input.file_path.

Options:
  -f, --file   Path to wish document to validate
  -h, --help   Show this help message

Exit codes:
  0  Validation passed (or not a wish file)
  1  Validation failed (missing required sections)
  2  Invalid arguments or file not found
`);
  process.exit(0);
}

/**
 * Try to get the file path from stdin (hook mode) or CLI args
 */
function getFilePath(): string | null {
  // First try CLI arg
  if (values.file) {
    return values.file as string;
  }

  // Try reading stdin (blocking call - waits for stream to close) for hook JSON input
  try {
    const stdinData = readFileSync(0, "utf-8").trim();
    if (stdinData) {
      const hookInput = JSON.parse(stdinData);
      // Claude Code PreToolUse sends tool_input with file_path for Write tool
      const filePath = hookInput?.tool_input?.file_path || hookInput?.file_path;
      if (filePath) return filePath;
    }
  } catch {
    // stdin not available or not JSON, that's fine
  }

  return null;
}

const filePath = getFilePath();

if (!filePath) {
  // No file specified - might be a non-Write tool use, silently pass
  process.exit(0);
}

// Only validate wish files
if (!filePath.includes(".genie/wishes/") || !filePath.endsWith(".md")) {
  process.exit(0);
}

if (!existsSync(filePath)) {
  // File doesn't exist yet (being created), skip validation
  console.error("File not found, skipping validation (new file)");
  process.exit(0);
}

const content = readFileSync(filePath, "utf-8");

interface ValidationResult {
  passed: boolean;
  issues: string[];
}

function validateWish(content: string): ValidationResult {
  const issues: string[] = [];

  // Required sections
  const requiredSections = [
    { pattern: /^##\s+Summary/m, name: "## Summary" },
    { pattern: /^##\s+Scope/m, name: "## Scope" },
    { pattern: /^###\s+IN/m, name: "### IN (under Scope)" },
    { pattern: /^###\s+OUT/m, name: "### OUT (under Scope)" },
    { pattern: /^##\s+Success Criteria/m, name: "## Success Criteria" },
    { pattern: /^##\s+Execution Groups/m, name: "## Execution Groups" },
  ];

  for (const { pattern, name } of requiredSections) {
    if (!pattern.test(content)) {
      issues.push(`Missing required section: ${name}`);
    }
  }

  // Check for at least one execution group
  const groupPattern = /^###\s+Group\s+[A-Z]:/m;
  if (!groupPattern.test(content)) {
    issues.push(
      "Missing execution group (need at least one ### Group X: section)"
    );
  }

  // Check for acceptance criteria in groups
  const groups = content.match(/^###\s+Group\s+[A-Z]:.*/gm) || [];
  if (groups.length > 0) {
    const execGroupsIndex = content.indexOf("## Execution Groups");
    const afterExecGroups = content.slice(execGroupsIndex);

    if (!afterExecGroups.includes("**Acceptance Criteria:**")) {
      issues.push(
        "Execution groups should have **Acceptance Criteria:** sections"
      );
    }

    if (!afterExecGroups.includes("**Validation:**")) {
      issues.push(
        "Execution groups should have **Validation:** command sections"
      );
    }
  }

  // Check that OUT scope is not empty
  const outMatch = content.match(
    /^###\s+OUT\s*\n([\s\S]*?)(?=^##|^###|\n---)/m
  );
  if (outMatch) {
    const outContent = outMatch[1].trim();
    if (!outContent || outContent === "-" || /^-\s*$/.test(outContent)) {
      issues.push("OUT scope should not be empty - add explicit exclusions");
    }
  }

  // Check for success criteria checkboxes
  const successSection = content.match(
    /^##\s+Success Criteria\s*\n([\s\S]*?)(?=^##|\n---)/m
  );
  if (successSection) {
    const checkboxes = successSection[1].match(/^-\s+\[\s*\]/gm) || [];
    if (checkboxes.length === 0) {
      issues.push("Success Criteria should have checkbox items (- [ ])");
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

const result = validateWish(content);

if (result.passed) {
  // Output to stderr so Claude sees it
  console.error("\u2713 Wish document validation passed");
  process.exit(0);
} else {
  console.error("\u26A0 Wish document validation issues:");
  for (const issue of result.issues) {
    console.error(`  - ${issue}`);
  }
  // Exit 1 to warn (on_failure: "warn" means Claude sees the warning but continues)
  process.exit(1);
}
