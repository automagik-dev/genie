#!/usr/bin/env bun
/**
 * Validate forge completion before session ends.
 * Used by Stop hook to check if all tasks are complete.
 *
 * Usage: bun validate-completion.ts --session <session-id>
 *        bun validate-completion.ts --help
 *
 * This script is advisory-only (exits 0) but logs warnings if:
 * - Active wish exists with incomplete tasks
 * - Tasks are marked BLOCKED
 */

import { parseArgs } from "util";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    session: { type: "string", short: "s" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log(`
validate-completion.ts - Check forge completion status

Usage:
  bun validate-completion.ts --session <session-id>
  bun validate-completion.ts --help

Options:
  -s, --session   Session ID (currently unused, for future integration)
  -h, --help      Show this help message

This script checks for incomplete work and logs warnings.
It always exits 0 (advisory only).
`);
  process.exit(0);
}

interface WishStatus {
  slug: string;
  status: string;
  incompleteTasks: number;
  blockedTasks: number;
  totalTasks: number;
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
      const totalTasks = groupMatches.length;

      // Count unchecked acceptance criteria (rough proxy for incomplete tasks)
      const uncheckedCriteria = (content.match(/^-\s+\[\s+\]/gm) || []).length;
      const checkedCriteria = (content.match(/^-\s+\[x\]/gim) || []).length;

      // Check for BLOCKED mentions
      const blockedMentions = (content.match(/BLOCKED/gi) || []).length;

      results.push({
        slug,
        status,
        incompleteTasks: uncheckedCriteria > 0 ? Math.ceil(uncheckedCriteria / 3) : 0, // Rough estimate
        blockedTasks: blockedMentions > 0 ? 1 : 0,
        totalTasks,
      });
    }
  } catch (error) {
    // Silent failure - don't block session end
  }

  return results;
}

// Find wishes from current directory
const cwd = process.cwd();
const wishes = findWishes(cwd);

// Filter to active wishes (IN_PROGRESS)
const activeWishes = wishes.filter((w) => w.status === "IN_PROGRESS");

if (activeWishes.length === 0) {
  // No active wishes, nothing to report
  process.exit(0);
}

// Log warnings for incomplete work
let hasWarnings = false;

for (const wish of activeWishes) {
  if (wish.incompleteTasks > 0 || wish.blockedTasks > 0) {
    hasWarnings = true;
    console.log(`\n⚠ Active wish "${wish.slug}" has incomplete work:`);

    if (wish.incompleteTasks > 0) {
      console.log(`  - ~${wish.incompleteTasks} tasks with unchecked criteria`);
    }

    if (wish.blockedTasks > 0) {
      console.log(`  - ${wish.blockedTasks} BLOCKED task(s) need attention`);
    }

    console.log(`  Run /forge to continue or /review to validate.`);
  }
}

if (hasWarnings) {
  console.log("");
}

// Always exit 0 (advisory only)
process.exit(0);
