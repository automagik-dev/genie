/**
 * genie idea — one-verb idea capture. Creates a card in the `Idea` lane of the
 * `roadmap` board (creating that board with the default lifecycle lanes if it
 * does not yet exist). One command, zero prompts.
 *
 *   idea <text...>
 */

import type { Command } from 'commander';
import { openDb } from '../lib/v5/genie-db.js';
import {
  DEFAULT_LIFECYCLE_LANES,
  ROADMAP_BOARD,
  createBoard,
  createTask,
  getBoardByName,
} from '../lib/v5/task-state.js';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

/** First lane of the lifecycle contract — where fresh ideas land. */
const IDEA_LANE = DEFAULT_LIFECYCLE_LANES[0].name;

function handleIdea(words: string[]): void {
  const title = words.join(' ').trim();
  if (!title) fail('idea text is required and must not be empty.');
  try {
    const db = openDb();
    try {
      const board = getBoardByName(db, ROADMAP_BOARD) ?? createBoard(db, ROADMAP_BOARD, DEFAULT_LIFECYCLE_LANES);
      const task = createTask(db, { title, boardId: board.id, lane: IDEA_LANE });
      out(`Captured idea ${task.id} "${task.title}" in ${ROADMAP_BOARD}/${IDEA_LANE}.`);
    } finally {
      db.close();
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function registerIdeaCommand(program: Command): void {
  program
    .command('idea <text...>')
    .description('Capture an idea into the roadmap board Idea lane (creates the board if absent)')
    .action((text: string[]) => handleIdea(text));
}
