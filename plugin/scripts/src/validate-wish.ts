#!/usr/bin/env bun
/**
 * Validate a wish document structure before writing.
 * Used by PreToolUse hook to catch missing sections.
 *
 * Usage: bun validate-wish.ts --file <path-to-wish.md>
 *        bun validate-wish.ts --help
 */

import { parseArgs } from "util";
import { readFileSync, existsSync } from "fs";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    file: { type: "string", short: "f" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log(`
validate-wish.ts - Validate wish document structure

Usage:
  bun validate-wish.ts --file <path-to-wish.md>
  bun validate-wish.ts --help

Options:
  -f, --file   Path to wish document to validate
  -h, --help   Show this help message

Exit codes:
  0  Validation passed
  1  Validation failed (missing required sections)
  2  Invalid arguments or file not found
`);
  process.exit(0);
}

if (!values.file) {
  console.error("Error: --file is required");
  process.exit(2);
}

if (!existsSync(values.file)) {
  // File doesn't exist yet (being created), skip validation
  console.log("File not found, skipping validation (new file)");
  process.exit(0);
}

const content = readFileSync(values.file, "utf-8");

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
    issues.push("Missing execution group (need at least one ### Group X: section)");
  }

  // Check for acceptance criteria in groups
  const groups = content.match(/^###\s+Group\s+[A-Z]:.*/gm) || [];
  if (groups.length > 0) {
    // Check if Acceptance Criteria exists somewhere after Execution Groups
    const execGroupsIndex = content.indexOf("## Execution Groups");
    const afterExecGroups = content.slice(execGroupsIndex);

    if (!afterExecGroups.includes("**Acceptance Criteria:**")) {
      issues.push("Execution groups should have **Acceptance Criteria:** sections");
    }

    if (!afterExecGroups.includes("**Validation:**")) {
      issues.push("Execution groups should have **Validation:** command sections");
    }
  }

  // Check that OUT scope is not empty
  const outMatch = content.match(/^###\s+OUT\s*\n([\s\S]*?)(?=^##|^###|\n---|\Z)/m);
  if (outMatch) {
    const outContent = outMatch[1].trim();
    // Check if it only has placeholder text or is empty
    if (!outContent || outContent === "-" || outContent.match(/^-\s*$/)) {
      issues.push("OUT scope should not be empty - add explicit exclusions");
    }
  }

  // Check for success criteria checkboxes
  const successSection = content.match(/^##\s+Success Criteria\s*\n([\s\S]*?)(?=^##|\n---|\Z)/m);
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
  console.log("✓ Wish document validation passed");
  process.exit(0);
} else {
  console.log("⚠ Wish document validation issues:");
  for (const issue of result.issues) {
    console.log(`  - ${issue}`);
  }
  process.exit(1);
}
