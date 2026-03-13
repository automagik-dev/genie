#!/usr/bin/env node
/**
 * Load session context on start - show active wish progress.
 * Used by SessionStart hook to orient Claude to current work.
 *
 * Pure Node.js - no Bun dependency.
 *
 * Usage: node session-context.cjs
 *        node session-context.cjs --help
 *
 * Outputs context to stderr (shown to Claude Code on session start).
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
session-context - Load active wish context on session start

Usage:
  node session-context.cjs
  node session-context.cjs --help

Options:
  -h, --help   Show this help message

Scans .genie/wishes/ for active (IN_PROGRESS) wishes and outputs
a summary to stderr so Claude Code can resume work context.
`);
  process.exit(0);
}

interface WishContext {
  slug: string;
  title: string;
  status: string;
  totalGroups: number;
  completedCriteria: number;
  totalCriteria: number;
  currentGroup: string | null;
  hasBlocked: boolean;
}

function extractTitle(content: string): string {
  const titleMatch = content.match(/^#\s+(?:Wish:\s*)?(.+)/m);
  return titleMatch ? titleMatch[1].trim() : "Untitled";
}

function findCurrentGroup(content: string): string | null {
  // Find the first group with unchecked criteria
  const lines = content.split("\n");
  let inGroup = false;
  let currentGroupName: string | null = null;
  let groupHasUnchecked = false;

  for (const line of lines) {
    const groupMatch = line.match(/^###\s+(Group\s+[A-Z]:\s*.+)/);
    if (groupMatch) {
      // If previous group had unchecked items, that's our current group
      if (inGroup && groupHasUnchecked && currentGroupName) {
        return currentGroupName;
      }
      currentGroupName = groupMatch[1];
      inGroup = true;
      groupHasUnchecked = false;
      continue;
    }

    if (inGroup) {
      if (/^-\s+\[\s+\]/.test(line)) {
        groupHasUnchecked = true;
      }
      // New top-level section ends the group
      if (/^##\s+[^#]/.test(line) || /^---/.test(line)) {
        if (groupHasUnchecked && currentGroupName) {
          return currentGroupName;
        }
        inGroup = false;
      }
    }
  }

  // Check last group
  if (inGroup && groupHasUnchecked && currentGroupName) {
    return currentGroupName;
  }

  return null;
}

function scanWishes(baseDir: string): WishContext[] {
  const wishesDir = join(baseDir, ".genie", "wishes");
  const results: WishContext[] = [];

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

      const statusMatch = content.match(/^\*\*Status:\*\*\s*(\w+)/m);
      const status = statusMatch ? statusMatch[1] : "UNKNOWN";

      // Only show active wishes
      if (status !== "IN_PROGRESS" && status !== "DRAFT") continue;

      const totalGroups = (
        content.match(/^###\s+Group\s+[A-Z]:/gm) || []
      ).length;
      const totalCriteria = (
        content.match(/^-\s+\[[\sx]\]/gim) || []
      ).length;
      const completedCriteria = (
        content.match(/^-\s+\[x\]/gim) || []
      ).length;
      const hasBlocked = /BLOCKED/i.test(content);

      results.push({
        slug,
        title: extractTitle(content),
        status,
        totalGroups,
        completedCriteria,
        totalCriteria,
        currentGroup: findCurrentGroup(content),
        hasBlocked,
      });
    }
  } catch (error) {
    console.error(`[session-context] Error scanning wishes: ${error instanceof Error ? error.message : String(error)}`);
  }

  return results;
}

const cwd = process.cwd();
const wishes = scanWishes(cwd);

if (wishes.length === 0) {
  // No active wishes, nothing to output
  process.exit(0);
}

// Output context to stderr (Claude Code shows stderr from hooks)
console.error("");
console.error("\u2728 Genie Session Context");
console.error("=".repeat(40));

for (const wish of wishes) {
  const progress =
    wish.totalCriteria > 0
      ? `${wish.completedCriteria}/${wish.totalCriteria} criteria met`
      : "no criteria tracked";

  console.error("");
  console.error(`\u{1F4DC} Wish: ${wish.title}`);
  console.error(`   Status: ${wish.status} | ${progress}`);
  console.error(`   Groups: ${wish.totalGroups}`);

  if (wish.currentGroup) {
    console.error(`   Current: ${wish.currentGroup}`);
  }

  if (wish.hasBlocked) {
    console.error(`   \u26A0 Has BLOCKED items`);
  }

  console.error(`   File: .genie/wishes/${wish.slug}/wish.md`);
}

console.error("");
console.error("=".repeat(40));
process.exit(0);
