/**
 * Wish Namespace - Wish document management
 *
 * Groups all wish-related commands under `term wish`.
 *
 * Commands:
 *   term wish ls               - List all wishes
 *   term wish status <slug>    - Show wish with linked tasks status
 *   term wish read <slug>      - Read wish content (full or section)
 *   term wish sections <slug>  - List sections in a wish
 */

import { Command } from 'commander';
import { readdir, readFile, access } from 'fs/promises';
import { join } from 'path';
import { getWishTasks, getWishStatus, LinkedTask } from '../../lib/wish-tasks.js';
import { readWish, findSection, listSections } from '../../lib/wish-editor.js';

// ============================================================================
// Types
// ============================================================================

interface WishSummary {
  slug: string;
  title: string;
  status: string;
  tasks: {
    total: number;
    done: number;
    inProgress: number;
    blocked: number;
    open: number;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function getWishesDir(repoPath: string): string {
  return join(repoPath, '.genie', 'wishes');
}

/**
 * Parse wish.md metadata from either frontmatter or markdown fields.
 */
async function parseWishFrontmatter(wishPath: string): Promise<{ title: string; status: string }> {
  try {
    const content = await readFile(wishPath, 'utf-8');
    const lines = content.split('\n');

    let title = '';
    let status = 'DRAFT';

    // Parse frontmatter
    if (lines[0]?.trim() === '---') {
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '---') break;

        if (line.startsWith('title:')) {
          title = line.substring(6).trim().replace(/^["']|["']$/g, '');
        }
        if (line.startsWith('status:')) {
          status = line.substring(7).trim().toUpperCase();
        }
      }
    }

    // Fallback: wish.md style field
    if (status === 'DRAFT') {
      const statusMatch = content.match(/\*\*Status:\*\*\s*(.+)/i);
      if (statusMatch) status = statusMatch[1].trim().toUpperCase();
    }

    // Fallback: look for # heading
    if (!title) {
      const heading = lines.find(l => l.startsWith('# '));
      if (heading) title = heading.substring(2).trim();
    }

    return { title: title || '(untitled)', status };
  } catch {
    return { title: '(error reading)', status: 'UNKNOWN' };
  }
}

async function listWishes(repoPath: string): Promise<WishSummary[]> {
  const wishesDir = getWishesDir(repoPath);
  const wishes: WishSummary[] = [];

  try {
    const entries = await readdir(wishesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const wishPath = join(wishesDir, entry.name, 'wish.md');
        try {
          await access(wishPath);
          const { title, status } = await parseWishFrontmatter(wishPath);
          const tasks = await getWishStatus(repoPath, entry.name);

          wishes.push({ slug: entry.name, title, status, tasks });
        } catch {
          // Skip if wish.md doesn't exist
        }
      }
    }
  } catch {
    // Wishes directory doesn't exist
  }

  return wishes;
}

function formatTaskStatus(status: LinkedTask['status']): string {
  switch (status) {
    case 'done': return '✅';
    case 'in_progress': return '🔄';
    case 'blocked': return '🔴';
    case 'open': return '⚪';
    default: return '❓';
  }
}

function formatWishStatus(status: string): string {
  switch (status.toUpperCase()) {
    case 'READY': return '🟢 READY';
    case 'APPROVED': return '🟢 APPROVED';
    case 'IN_PROGRESS': return '🔄 IN_PROGRESS';
    case 'BLOCKED': return '🔴 BLOCKED';
    case 'DONE': return '✅ DONE';
    case 'DRAFT': return '📝 DRAFT';
    default: return status;
  }
}

// ============================================================================
// Register Namespace
// ============================================================================

export function registerWishNamespace(program: Command): void {
  const wishProgram = program
    .command('wish')
    .description('Wish document management')
    .addHelpText('after', `

Browse
  wish ls                         List all wishes
  wish status <slug>              Wish status with linked tasks
  wish show <slug>                Alias for status

Read / inspect
  wish read <slug>                Read wish document (full)
  wish read <slug> --section <s>  Read specific section (partial match)
  wish sections <slug>            List headings in a wish`);

  // wish ls - List all wishes
  wishProgram
    .command('ls')
    .alias('list')
    .description('List all wishes and their task status')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const repoPath = process.cwd();
      const wishes = await listWishes(repoPath);

      if (options.json) {
        console.log(JSON.stringify(wishes, null, 2));
        return;
      }

      if (wishes.length === 0) {
        console.log('No wishes found in .genie/wishes/');
        return;
      }

      console.log('┌────────────────────────────────────────────────────────────────────┐');
      console.log('│ WISHES                                                             │');
      console.log('├──────────────────────┬───────────────┬──────────────────────────────┤');
      console.log('│ Slug                 │ Status        │ Tasks (done/total)           │');
      console.log('├──────────────────────┼───────────────┼──────────────────────────────┤');

      for (const wish of wishes) {
        const slug = wish.slug.padEnd(20).substring(0, 20);
        const status = formatWishStatus(wish.status).padEnd(13).substring(0, 13);
        const taskProgress = wish.tasks.total > 0
          ? `${wish.tasks.done}/${wish.tasks.total} (${wish.tasks.inProgress} active, ${wish.tasks.blocked} blocked)`
          : '(no tasks)';
        const tasks = taskProgress.padEnd(28).substring(0, 28);
        console.log(`│ ${slug} │ ${status} │ ${tasks} │`);
      }

      console.log('└──────────────────────┴───────────────┴──────────────────────────────┘');
    });

  // wish status <slug> - Show wish with linked tasks
  wishProgram
    .command('status <slug>')
    .description('Show wish status with linked tasks')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, options: { json?: boolean }) => {
      const repoPath = process.cwd();
      const wishPath = join(getWishesDir(repoPath), slug, 'wish.md');

      try {
        await access(wishPath);
      } catch {
        console.error(`❌ Wish "${slug}" not found in .genie/wishes/`);
        process.exit(1);
      }

      const { title, status } = await parseWishFrontmatter(wishPath);
      const tasks = await getWishTasks(repoPath, slug);
      const taskStatus = await getWishStatus(repoPath, slug);

      if (options.json) {
        console.log(JSON.stringify({ slug, title, status, tasks, summary: taskStatus }, null, 2));
        return;
      }

      console.log(`\n📋 ${title}`);
      console.log(`   Slug: ${slug}`);
      console.log(`   Status: ${formatWishStatus(status)}`);
      console.log('');

      if (tasks.length === 0) {
        console.log('   No linked tasks. Use "term task link <wish-slug> <task-id>" to link.');
      } else {
        console.log(`   Tasks: ${taskStatus.done}/${taskStatus.total} done`);
        if (taskStatus.inProgress > 0) console.log(`          ${taskStatus.inProgress} in progress`);
        if (taskStatus.blocked > 0) console.log(`          ${taskStatus.blocked} blocked`);
        if (taskStatus.open > 0) console.log(`          ${taskStatus.open} open`);
        console.log('');

        console.log('   ┌────────────┬──────────────────────────────────────┬──────────┐');
        console.log('   │ Task ID    │ Title                                │ Status   │');
        console.log('   ├────────────┼──────────────────────────────────────┼──────────┤');

        for (const task of tasks) {
          const taskId = task.id.padEnd(10).substring(0, 10);
          const taskTitle = task.title.padEnd(36).substring(0, 36);
          const taskState = `${formatTaskStatus(task.status)} ${task.status}`.padEnd(8).substring(0, 8);
          console.log(`   │ ${taskId} │ ${taskTitle} │ ${taskState} │`);
        }

        console.log('   └────────────┴──────────────────────────────────────┴──────────┘');
      }

      console.log('');
    });

  // wish show <slug> - Alias for status
  wishProgram
    .command('show <slug>')
    .description('Alias for "wish status"')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, options: { json?: boolean }) => {
      const statusCmd = wishProgram.commands.find(c => c.name() === 'status');
      if (statusCmd) {
        await statusCmd.parseAsync([slug, ...(options.json ? ['--json'] : [])], { from: 'user' });
      }
    });

  // wish read <slug>
  wishProgram
    .command('read <slug>')
    .description('Read wish document content (full or specific section)')
    .option('-s, --section <name>', 'Read only a specific section (partial match)')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, options: { section?: string; json?: boolean }) => {
      const repoPath = process.cwd();
      const doc = await readWish(repoPath, slug);

      if (!doc) {
        console.error(`❌ Wish "${slug}" not found in .genie/wishes/`);
        process.exit(1);
      }

      if (options.section) {
        const section = findSection(doc, options.section);
        if (!section) {
          console.error(`❌ Section "${options.section}" not found in wish "${slug}".`);
          console.error(`Available sections: ${doc.sections.map(s => s.heading).join(', ')}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify({ slug, section }, null, 2));
          return;
        }

        console.log(section.content);
        return;
      }

      if (options.json) {
        console.log(JSON.stringify({ slug, path: doc.path, mtime: doc.mtime, sectionCount: doc.sections.length, content: doc.raw }, null, 2));
        return;
      }

      console.log(doc.raw);
    });

  // wish sections <slug>
  wishProgram
    .command('sections <slug>')
    .description('List all sections in a wish document')
    .option('--json', 'Output as JSON')
    .action(async (slug: string, options: { json?: boolean }) => {
      const repoPath = process.cwd();
      const doc = await readWish(repoPath, slug);

      if (!doc) {
        console.error(`❌ Wish "${slug}" not found in .genie/wishes/`);
        process.exit(1);
      }

      const sections = listSections(doc);

      if (options.json) {
        console.log(JSON.stringify({ slug, sections }, null, 2));
        return;
      }

      if (sections.length === 0) {
        console.log(`No sections found in wish "${slug}".`);
        return;
      }

      console.log(`\nSections in ${slug}:\n`);
      for (const s of sections) {
        const indent = '  '.repeat(Math.max(0, s.level - 1));
        console.log(`${indent}- ${s.heading} (${s.lineCount} lines)`);
      }
      console.log('');
    });
}
