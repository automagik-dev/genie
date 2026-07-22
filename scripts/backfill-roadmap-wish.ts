/**
 * One-time, idempotent backfill: set `tasks.wish` (the lifecycle slug a roadmap
 * card tracks) on the seeded `roadmap` board cards that still lack it.
 *
 * Placement truth lives on the board; the `jar: index-lane drift` doctor check
 * joins INDEX.md entries to these cards WHERE `tasks.wish = slug`, so every macro
 * card needs its slug. This fills ONLY rows whose `wish IS NULL` — it never
 * overwrites an existing slug, so re-running is a no-op.
 *
 * Usage (run against the live shared DB from any worktree):
 *   bun run scripts/backfill-roadmap-wish.ts
 */
import { Database } from 'bun:sqlite';
import { resolveDbPath } from '../src/lib/v5/genie-db.js';

/** Title-prefix → lifecycle slug. First matching prefix wins (longest-first below). */
const TITLE_PREFIX_TO_SLUG: Array<[prefix: string, slug: string]> = [
  ['Codex plugin update handoff', 'codex-plugin-update-handoff'],
  ['Stable release security gate', 'stable-release-security-gate'],
  ['PR-2545', 'pr-2545-ultra-release-gate'],
  ['Close routing wishes', 'routing-delivery-fix'],
  ['Boards first-class', 'boards-first-class'],
  ['RE-BRAINSTORM: genie spend', 'genie-spend'],
  ['RE-BRAINSTORM: dream replatform', 'dream-replatform'],
  ['RE-BRAINSTORM: intent-to-wish compiler', 'intent-to-wish-compiler'],
  ['RE-BRAINSTORM: brainstorm domain-map', 'brainstorm-domain-map'],
  ['RE-BRAINSTORM: control-plane contract', 'control-plane-contract'],
  ['RE-BRAINSTORM: skill absorbs residue', 'skill-absorbs'],
  ['RE-BRAINSTORM: always-on genie residue', 'always-on-genie'],
  ['RE-BRAINSTORM: cross-agent delegate residue', 'cross-agent-delegate'],
];

function slugForTitle(title: string): string | null {
  for (const [prefix, slug] of TITLE_PREFIX_TO_SLUG) {
    if (title.startsWith(prefix)) return slug;
  }
  return null;
}

function main(): void {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath);
  try {
    const board = db.query("SELECT id FROM boards WHERE name = 'roadmap'").get() as { id: string } | null;
    if (board === null) {
      process.stdout.write(`no 'roadmap' board found at ${dbPath}; nothing to backfill\n`);
      return;
    }
    const rows = db
      .query('SELECT id, title, wish FROM tasks WHERE board_id = ? ORDER BY created_at')
      .all(board.id) as Array<{ id: string; title: string; wish: string | null }>;
    const update = db.query('UPDATE tasks SET wish = ?, updated_at = ? WHERE id = ? AND wish IS NULL');
    let filled = 0;
    let skipped = 0;
    let unmatched = 0;
    for (const row of rows) {
      if (row.wish !== null) {
        skipped += 1;
        continue;
      }
      const slug = slugForTitle(row.title);
      if (slug === null) {
        unmatched += 1;
        process.stdout.write(`  UNMATCHED (no prefix mapping): ${row.title}\n`);
        continue;
      }
      update.run(slug, Date.now(), row.id);
      filled += 1;
      process.stdout.write(`  filled ${row.id} wish=${slug}  (${row.title.slice(0, 40)})\n`);
    }
    process.stdout.write(
      `backfill complete on ${dbPath}: ${filled} filled, ${skipped} already-set (skipped), ${unmatched} unmatched, ${rows.length} total roadmap cards\n`,
    );
  } finally {
    db.close();
  }
}

main();
