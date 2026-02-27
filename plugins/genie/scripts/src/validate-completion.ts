#!/usr/bin/env node
/**
 * Check for incomplete work when a session ends.
 * Used by Stop hook to warn about unfinished wishes.
 *
 * Pure Node.js - no Bun dependency.
 *
 * Usage: node validate-completion.cjs
 *        node validate-completion.cjs --help
 *
 * This script is advisory-only (always exits 0) but logs warnings if:
 * - Active wish exists with incomplete tasks
 * - Tasks are marked BLOCKED
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseArgs as _parseArgs } from "util";

// Parse CLI args - util.parseArgs requires Node 18.3+, fallback for older versions
let values: Record<string, unknown> = {};
try {
  const result = _parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });
  values = result.values;
} catch {
  // Fallback: manual arg parsing for Node < 18.3
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      values.help = true;
    }
  }
}

if (values.help) {
  console.log(`
validate-completion - Check forge completion status

Usage:
  node validate-completion.cjs
  node validate-completion.cjs --help

Options:
  -h, --help   Show this help message

This script checks for incomplete work and logs warnings to stderr.
It always exits 0 (advisory only).
`);
  process.exit(0);
}

interface WishStatus {
  slug: string;
  status: string;
  incompleteTasks: number;
  blockedTasks: number;
  totalGroups: number;
}

function findWishes(baseDir: string): WishStatus[] {
  const wishesDir = join(baseDir, ".genie", "wishes");
  const results: WishStatus[] = [];

  if (!existsSync(wishesDir)) {
    return results;
  }

  try {
    const slugs = readdirSync(wishesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const slug of slugs) {
      const wishFile = join(wishesDir, slug, "wish.md");
      if (!existsSync(wishFile)) continue;

      const content = readFileSync(wishFile, "utf-8");

      // Extract status
      const statusMatch = content.match(/^\*\*Status:\*\*\s*(\w+)/m);
      const status = statusMatch ? statusMatch[1] : "UNKNOWN";

      // Skip completed wishes
      if (status === "DONE") continue;

      // Count execution group tasks
      const groupMatches = content.match(/^###\s+Group\s+[A-Z]:/gm) || [];
      const totalGroups = groupMatches.length;

      // Count unchecked acceptance criteria (rough proxy for incomplete tasks)
      const uncheckedCriteria = (content.match(/^-\s+\[\s+\]/gm) || []).length;

      // Check for BLOCKED mentions
      const blockedMentions = (content.match(/BLOCKED/gi) || []).length;

      results.push({
        slug,
        status,
        incompleteTasks:
          uncheckedCriteria > 0 ? Math.ceil(uncheckedCriteria / 3) : 0,
        blockedTasks: blockedMentions > 0 ? 1 : 0,
        totalGroups,
      });
    }
  } catch (error) {
    console.error(`[validate-completion] Error finding wishes: ${error instanceof Error ? error.message : String(error)}`);
  }

  return results;
}

// Find wishes from current directory
const cwd = process.cwd();
const wishes = findWishes(cwd);

// Filter to active wishes (IN_PROGRESS)
const activeWishes = wishes.filter((w) => w.status === "IN_PROGRESS");

if (activeWishes.length === 0) {
  process.exit(0);
}

// Log warnings for incomplete work (to stderr so Claude sees them)
let hasWarnings = false;

for (const wish of activeWishes) {
  if (wish.incompleteTasks > 0 || wish.blockedTasks > 0) {
    hasWarnings = true;
    console.error(`\n\u26A0 Active wish "${wish.slug}" has incomplete work:`);

    if (wish.incompleteTasks > 0) {
      console.error(
        `  - ~${wish.incompleteTasks} tasks with unchecked criteria`
      );
    }

    if (wish.blockedTasks > 0) {
      console.error(`  - ${wish.blockedTasks} BLOCKED task(s) need attention`);
    }

    console.error(`  Run /forge to continue or /review to validate.`);
  }
}

if (hasWarnings) {
  console.error("");
}

// Always exit 0 (advisory only)
process.exit(0);
