#!/usr/bin/env bun
/**
 * Representative synthetic workload generator for the disposable pgserve baseline.
 *
 * Mirrors the SQL shapes observed in the live 30 s sample:
 *   - audit_events: ~36 inserts/s, indexed reads (idx_scan dominated)
 *   - agents: ~73 polls/s seq_scan (small table, 43 rows in live)
 *   - executors: ~73 polls/s seq_scan (small table, 9 rows in live)
 *   - teams: idx_scan only
 *   - assignments: idx_scan only
 * Total commits/s in live ≈ 412.
 *
 * This script runs for `--duration` seconds against the disposable instance.
 */

import postgres from 'postgres';

const port = Number(process.env.LOADGEN_PORT ?? 19742);
const durationSeconds = Number(process.argv[2] ?? 30);

const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'genie',
  username: 'postgres',
  password: 'postgres',
  max: 8,
  idle_timeout: 5,
});

const end = Date.now() + durationSeconds * 1000;
let inserts = 0;
let selects = 0;
let updates = 0;

async function worker(id: number) {
  while (Date.now() < end) {
    const op = Math.random();
    try {
      if (op < 0.25) {
        // ~25% inserts → mirrors hot audit_events insert path
        const eventTypes = ['command_start', 'spawn', 'state_change', 'command_end'];
        const et = eventTypes[Math.floor(Math.random() * eventTypes.length)];
        await sql`
          INSERT INTO audit_events (entity_type, entity_id, event_type, actor, details)
          VALUES ('agent', ${'agent-' + ((id * 7919 + inserts) % 50)}, ${et}, ${'engineer-' + (id % 4)}, ${sql.json({ tick: inserts })})
        `;
        inserts++;
      } else if (op < 0.5) {
        // ~25% indexed audit_events SELECT (recent events for an entity)
        const entityId = 'agent-' + Math.floor(Math.random() * 50);
        await sql`
          SELECT id, event_type, created_at
          FROM audit_events
          WHERE entity_type = 'agent' AND entity_id = ${entityId}
          ORDER BY created_at DESC
          LIMIT 20
        `;
        selects++;
      } else if (op < 0.7) {
        // ~20% small-table SELECT mirrors agents/executors seq_scan polls
        await sql`SELECT id, state, team FROM agents WHERE state = 'working'`;
        selects++;
      } else if (op < 0.85) {
        // ~15% executors poll
        await sql`SELECT id, agent_id, state FROM executors WHERE state = 'idle'`;
        selects++;
      } else if (op < 0.95) {
        // ~10% teams idx scan
        const tid = 'team-' + (1 + Math.floor(Math.random() * 5));
        await sql`SELECT id, name, state FROM teams WHERE id = ${tid}`;
        selects++;
      } else {
        // ~5% UPDATE (state change)
        const aid = 'agent-' + Math.floor(Math.random() * 50);
        const newState = Math.random() < 0.5 ? 'working' : 'idle';
        await sql`UPDATE agents SET state = ${newState} WHERE id = ${aid}`;
        updates++;
      }
    } catch (err) {
      // Best-effort load generator
      console.error(`worker ${id} err:`, (err as Error).message);
    }
  }
}

async function main() {
  console.log(`[loadgen] starting ${durationSeconds}s load on port ${port}`);
  // Spawn 8 concurrent workers — matches a daemon-style fanout.
  const workers = Array.from({ length: 8 }, (_, i) => worker(i));
  await Promise.all(workers);
  await sql.end();
  console.log(`[loadgen] done — inserts=${inserts} selects=${selects} updates=${updates} (total=${inserts + selects + updates})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
