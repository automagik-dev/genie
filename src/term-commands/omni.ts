/**
 * Omni Commands — genie omni start/stop/status
 *
 * Manages the NATS bridge service that connects Omni (WhatsApp)
 * to Genie agent sessions.
 */

import type { Command } from 'commander';
import type { BridgeStatus } from '../services/omni-bridge.js';

function printStatus(s: BridgeStatus): void {
  const pgTag = s.pgAvailable ? '✓ connected' : '✗ degraded';
  const connTag = s.connected ? '✓ connected' : '✗ disconnected';
  const activeSource = s.pgAvailable ? ' (PG-backed)' : ' (in-memory)';

  console.log('\nOmni Bridge Status');
  console.log('─'.repeat(50));
  console.log(`  Bridge:         ${connTag}`);
  console.log(`  NATS URL:       ${s.natsUrl}`);
  console.log(`  PG:             ${pgTag}`);
  console.log(`  Executor type:  ${s.executorType}`);
  console.log(`  Active:         ${s.activeSessions} / ${s.maxConcurrent}${activeSource}`);
  console.log(`  Queue depth:    ${s.queueDepth}`);
  console.log(`  Idle timeout:   ${Math.round(s.idleTimeoutMs / 1000)}s`);

  if (s.executorIds.length > 0) {
    console.log('\n  Executors (PG):');
    for (const id of s.executorIds) {
      console.log(`    ${id}`);
    }
  }

  if (s.sessions.length > 0) {
    console.log('\n  Sessions:');
    for (const sess of s.sessions) {
      const idleSec = Math.round(sess.idleMs / 1000);
      const status = sess.spawning ? 'spawning' : `idle ${idleSec}s`;
      const tag = sess.executorType === 'tmux' ? 'tmux' : 'sdk';
      console.log(`    ${sess.agentName}:${sess.chatId} — executor=${tag} (${status})`);
    }
  }
  console.log('');
}

export function registerOmniCommands(program: Command): void {
  const omni = program.command('omni').description('Manage the Omni ↔ Genie NATS bridge');

  omni
    .command('start')
    .description('Start the NATS bridge (subscribe to omni.message.>)')
    .option('--nats-url <url>', 'NATS server URL', process.env.GENIE_NATS_URL ?? 'localhost:4222')
    .option('--max-concurrent <n>', 'Max concurrent agent sessions', process.env.GENIE_MAX_CONCURRENT ?? '20')
    .option('--idle-timeout <ms>', 'Idle timeout in ms', process.env.GENIE_IDLE_TIMEOUT_MS ?? '900000')
    .option('--executor <type>', 'Executor type: tmux (default) or sdk')
    .action(async (options) => {
      const { OmniBridge } = await import('../services/omni-bridge.js');

      const bridge = new OmniBridge({
        natsUrl: options.natsUrl,
        maxConcurrent: Number(options.maxConcurrent),
        idleTimeoutMs: Number(options.idleTimeout),
        executorType: options.executor,
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

  omni
    .command('status')
    .description('Show bridge status: active sessions, queue depth, idle timers')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { getBridge } = await import('../services/omni-bridge.js');
      const bridge = getBridge();

      if (!bridge) {
        console.log('Bridge is not running in this process.');
        return;
      }

      const s = await bridge.status();

      if (options.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }

      printStatus(s);
    });
}
