/**
 * Omni Commands — genie omni start/stop/status/sessions/logs/config
 *
 * Manages the NATS bridge service that connects Omni (WhatsApp)
 * to Genie agent sessions.
 */

import type { Command } from 'commander';
import { formatRelativeTimestamp, padRight, truncate } from '../lib/term-format.js';

export function registerOmniCommands(program: Command): void {
  const omni = program.command('omni').description('Manage the Omni ↔ Genie NATS bridge');

  // ──────────────────────────────────────────────────────────────────────────
  // omni start
  // ──────────────────────────────────────────────────────────────────────────

  omni
    .command('start')
    .description('Start the NATS bridge (subscribe to omni.message.>)')
    .option('--nats-url <url>', 'NATS server URL', process.env.GENIE_NATS_URL ?? 'localhost:4222')
    .option('--max-concurrent <n>', 'Max concurrent agent sessions', process.env.GENIE_MAX_CONCURRENT ?? '20')
    .option('--idle-timeout <ms>', 'Idle timeout in ms', process.env.GENIE_IDLE_TIMEOUT_MS ?? '900000')
    .option('--executor <type>', 'Executor type: tmux (default) or sdk', process.env.GENIE_EXECUTOR_TYPE ?? 'tmux')
    .action(async (options) => {
      const { OmniBridge } = await import('../services/omni-bridge.js');

      const bridge = new OmniBridge({
        natsUrl: options.natsUrl,
        maxConcurrent: Number(options.maxConcurrent),
        idleTimeoutMs: Number(options.idleTimeout),
        executorType: options.executor as 'tmux' | 'sdk',
      });

      await bridge.start();

      // Keep the process alive
      console.log('[genie omni] Bridge running. Press Ctrl+C to stop.');

      const shutdown = async () => {
        await bridge.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Block forever
      await new Promise(() => {});
    });

  // ──────────────────────────────────────────────────────────────────────────
  // omni stop
  // ──────────────────────────────────────────────────────────────────────────

  omni
    .command('stop')
    .description('Stop the running NATS bridge')
    .action(async () => {
      const { getBridge } = await import('../services/omni-bridge.js');
      const bridge = getBridge();
      if (!bridge) {
        console.log('No running bridge found in this process.');
        console.log('If the bridge is running in another terminal, use Ctrl+C to stop it.');
        return;
      }
      await bridge.stop();
    });

  // ──────────────────────────────────────────────────────────────────────────
  // omni status (enhanced — reads PG sessions)
  // ──────────────────────────────────────────────────────────────────────────

  omni
    .command('status')
    .description('Show bridge status: active sessions, queue depth, idle timers')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      // Try in-process bridge first
      const { getBridge } = await import('../services/omni-bridge.js');
      const bridge = getBridge();

      // Always try to read PG sessions
      let pgCount = 0;
      let pgSessions: Awaited<ReturnType<typeof import('../services/omni-sessions.js').listSessions>> = [];
      try {
        const { listSessions, countSessions } = await import('../services/omni-sessions.js');
        pgCount = await countSessions();
        pgSessions = await listSessions();
      } catch {
        /* DB not available */
      }

      if (bridge) {
        const s = bridge.status();

        if (options.json) {
          console.log(JSON.stringify({ ...s, pgSessions: pgCount }, null, 2));
          return;
        }

        console.log('\nOmni Bridge Status');
        console.log('─'.repeat(50));
        console.log(`  Connected:      ${s.connected ? '✓ yes' : '✗ no'}`);
        console.log(`  NATS URL:       ${s.natsUrl}`);
        console.log(`  Active:         ${s.activeSessions} / ${s.maxConcurrent}`);
        console.log(`  Queue depth:    ${s.queueDepth}`);
        console.log(`  Idle timeout:   ${Math.round(s.idleTimeoutMs / 1000)}s`);
        console.log(`  PG sessions:    ${pgCount}`);

        if (s.sessions.length > 0) {
          console.log('\n  Sessions:');
          for (const sess of s.sessions) {
            const idleSec = Math.round(sess.idleMs / 1000);
            const status = sess.spawning ? 'spawning' : `idle ${idleSec}s`;
            console.log(`    ${sess.agentName}:${sess.chatId} — pane=${sess.paneId} (${status})`);
          }
        }
        console.log('');
        return;
      }

      // Bridge not running — show PG-only status
      if (options.json) {
        console.log(JSON.stringify({ connected: false, pgSessions: pgCount, sessions: pgSessions }, null, 2));
        return;
      }

      console.log('\nOmni Bridge Status');
      console.log('─'.repeat(50));
      console.log('  Connected:      ✗ no (bridge not running)');
      console.log(`  PG sessions:    ${pgCount}`);

      if (pgSessions.length > 0) {
        console.log('\n  Sessions (from PG):');
        for (const sess of pgSessions) {
          const idle = formatRelativeTimestamp(sess.lastActivityAt);
          const sid = sess.claudeSessionId ? truncate(sess.claudeSessionId, 12) : '-';
          console.log(`    ${sess.agentName}:${sess.chatId} — instance=${sess.instanceId} (${idle}) session=${sid}`);
        }
      }
      console.log('');
    });

  // ──────────────────────────────────────────────────────────────────────────
  // omni sessions
  // ──────────────────────────────────────────────────────────────────────────

  const sessions = omni.command('sessions').description('Query omni sessions from PG');

  sessions
    .command('list', { isDefault: true })
    .description('List all omni sessions')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const { isAvailable } = await import('../lib/db.js');
      if (!(await isAvailable())) {
        console.error('Database not available.');
        process.exit(1);
      }

      const { listSessions } = await import('../services/omni-sessions.js');
      const rows = await listSessions();

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log('No omni sessions found.');
        return;
      }

      const headers = ['AGENT', 'CHAT', 'INSTANCE', 'IDLE', 'SESSION'];
      const tableRows = rows.map((r) => [
        r.agentName,
        r.chatId,
        r.instanceId,
        formatRelativeTimestamp(r.lastActivityAt),
        r.claudeSessionId ? truncate(r.claudeSessionId, 16) : '-',
      ]);

      printTable(headers, tableRows);
    });

  sessions
    .command('kill <chatId>')
    .description('Delete session by chat ID')
    .action(async (chatId: string) => {
      const { isAvailable } = await import('../lib/db.js');
      if (!(await isAvailable())) {
        console.error('Database not available.');
        process.exit(1);
      }

      const { deleteByChatId } = await import('../services/omni-sessions.js');
      const count = await deleteByChatId(chatId);
      if (count > 0) {
        console.log(`Deleted ${count} session(s) for chat ${chatId}.`);
      } else {
        console.log(`No sessions found for chat ${chatId}.`);
      }
    });

  sessions
    .command('reset <agentName>')
    .description('Delete all sessions for an agent')
    .action(async (agentName: string) => {
      const { isAvailable } = await import('../lib/db.js');
      if (!(await isAvailable())) {
        console.error('Database not available.');
        process.exit(1);
      }

      const { deleteAllByAgent } = await import('../services/omni-sessions.js');
      const count = await deleteAllByAgent(agentName);
      console.log(`Deleted ${count} session(s) for agent ${agentName}.`);
    });

  // ──────────────────────────────────────────────────────────────────────────
  // omni logs
  // ──────────────────────────────────────────────────────────────────────────

  omni
    .command('logs')
    .description('Show PM2 logs for genie-omni-bridge')
    .option('--follow', 'Follow log output (streaming)')
    .option('--lines <n>', 'Number of lines to show', '50')
    .action(async (opts) => {
      const { execFileSync, spawn } = await import('node:child_process');

      if (opts.follow) {
        const child = spawn('pm2', ['logs', 'genie-omni-bridge'], { stdio: 'inherit' });
        child.on('error', (err) => {
          console.error(`Failed to run pm2 logs: ${err.message}`);
          process.exit(1);
        });
        // Block until user kills with Ctrl+C
        await new Promise<void>((resolve) => {
          child.on('close', () => resolve());
        });
        return;
      }

      try {
        const output = execFileSync('pm2', ['logs', 'genie-omni-bridge', '--lines', opts.lines, '--nostream'], {
          encoding: 'utf-8',
          timeout: 10_000,
        });
        console.log(output);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to read PM2 logs: ${msg}`);
        process.exit(1);
      }
    });

  // ──────────────────────────────────────────────────────────────────────────
  // omni config
  // ──────────────────────────────────────────────────────────────────────────

  omni
    .command('config')
    .description('Show current bridge configuration from env vars')
    .action(() => {
      console.log('\nOmni Bridge Config');
      console.log('─'.repeat(40));
      console.log(`  Executor:       ${process.env.GENIE_EXECUTOR_TYPE || 'tmux'}`);
      console.log(`  NATS URL:       ${process.env.GENIE_NATS_URL || 'localhost:4222'}`);
      console.log(`  Max concurrent: ${process.env.GENIE_MAX_CONCURRENT || '20'}`);
      console.log(`  Idle timeout:   ${process.env.GENIE_IDLE_TIMEOUT_MS || '900000'}ms`);
      console.log('');
    });
}

// ============================================================================
// Helpers
// ============================================================================

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => {
    const colValues = rows.map((r) => (r[i] ?? '').length);
    return Math.max(h.length, ...colValues);
  });

  const headerLine = headers.map((h, i) => padRight(h, widths[i])).join('  ');
  console.log(headerLine);
  console.log(widths.map((w) => '─'.repeat(w)).join('──'));

  for (const row of rows) {
    const line = row.map((val, i) => padRight(val ?? '', widths[i])).join('  ');
    console.log(line);
  }

  console.log(`(${rows.length} row${rows.length === 1 ? '' : 's'})`);
}
