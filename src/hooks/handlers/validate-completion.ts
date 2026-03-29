/**
 * Completion Validation Handler — Stop
 *
 * Checks for incomplete work when a session ends.
 * Advisory only — warns about unfinished wishes but never blocks.
 *
 * Priority: 30 (alongside runtime-emit, non-critical)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HandlerResult, HookPayload } from '../types.js';

interface WishStatus {
  slug: string;
  status: string;
  incompleteTasks: number;
  blockedTasks: number;
}

function findActiveWishes(cwd: string): WishStatus[] {
  const wishesDir = join(cwd, '.genie', 'wishes');
  if (!existsSync(wishesDir)) return [];

  const results: WishStatus[] = [];
  try {
    const slugs = readdirSync(wishesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const slug of slugs) {
      const wishFile = join(wishesDir, slug, 'wish.md');
      if (!existsSync(wishFile)) continue;

      const content = readFileSync(wishFile, 'utf-8');
      const statusMatch = content.match(/^\*\*Status:\*\*\s*(\w+)/m);
      const status = statusMatch ? statusMatch[1] : 'UNKNOWN';

      if (status !== 'IN_PROGRESS') continue;

      const unchecked = (content.match(/^-\s+\[\s+\]/gm) || []).length;
      const blocked = (content.match(/BLOCKED/gi) || []).length;

      results.push({
        slug,
        status,
        incompleteTasks: unchecked > 0 ? Math.ceil(unchecked / 3) : 0,
        blockedTasks: blocked > 0 ? 1 : 0,
      });
    }
  } catch {
    // Non-fatal
  }

  return results;
}

export async function validateCompletion(payload: HookPayload): Promise<HandlerResult> {
  const cwd = payload.cwd ?? process.cwd();
  const active = findActiveWishes(cwd);

  for (const wish of active) {
    if (wish.incompleteTasks > 0 || wish.blockedTasks > 0) {
      console.error(`⚠ Active wish "${wish.slug}" has incomplete work:`);
      if (wish.incompleteTasks > 0) console.error(`  - ~${wish.incompleteTasks} tasks with unchecked criteria`);
      if (wish.blockedTasks > 0) console.error(`  - ${wish.blockedTasks} BLOCKED task(s) need attention`);
    }
  }

  // Advisory only — never block
  return undefined;
}
