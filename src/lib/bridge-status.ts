/**
 * Bridge status IPC helper.
 *
 * Reads the omni-bridge pidfile written by `genie serve` and issues an
 * `omni.bridge.ping` NATS request to prove the bridge is actually responsive.
 *
 * Used by both `genie doctor` and any other out-of-process caller that needs
 * an authoritative bridge health answer. Replaces the old module-scoped
 * `getBridge()` singleton which only worked inside the serve process itself.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringCodec, connect } from 'nats';

const DEFAULT_NATS_URL = 'localhost:4222';
const PING_TIMEOUT_MS = 2_000;
const PING_SUBJECT = 'omni.bridge.ping';

export interface BridgePidfile {
  pid: number;
  startedAt: number;
  subjects: string[];
  natsUrl: string;
}

export interface BridgePong {
  ok: true;
  pid: number;
  uptimeMs: number;
  subjects: string[];
}

export type BridgeState = 'running' | 'stopped' | 'stale';

export interface BridgeStatusResult {
  state: BridgeState;
  detail: string;
  pidfile?: BridgePidfile;
  pong?: BridgePong;
  latencyMs?: number;
}

export function getBridgePidfilePath(): string {
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(home, 'state', 'omni-bridge.json');
}

export function readBridgePidfile(path: string = getBridgePidfilePath()): BridgePidfile | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.pid === 'number' &&
      typeof parsed?.startedAt === 'number' &&
      Array.isArray(parsed?.subjects) &&
      typeof parsed?.natsUrl === 'string'
    ) {
      return parsed as BridgePidfile;
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort check that `pid` is alive. Returns false if kill(0) throws ESRCH. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means the process exists but we lack permission — still alive.
    return e.code === 'EPERM';
  }
}

/** Remove a stale pidfile (best-effort). */
export function removeBridgePidfile(path: string = getBridgePidfilePath()): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone — fine.
  }
}

export interface PingOptions {
  timeoutMs?: number;
  /** Test/DI hook — override the real NATS connect. */
  natsConnectFn?: typeof connect;
}

/**
 * Pure helper — reads pidfile, issues NATS ping with a 2s timeout, classifies
 * the result into `running` / `stopped` / `stale`.
 *
 *   - no pidfile                               → stopped
 *   - pidfile + pid not alive                  → stale
 *   - pidfile + pid alive + no pong in 2s      → stale
 *   - pidfile + pid alive + pong               → running
 */
export async function getBridgeStatus(
  pidfilePath: string = getBridgePidfilePath(),
  options: PingOptions = {},
): Promise<BridgeStatusResult> {
  const pidfile = readBridgePidfile(pidfilePath);
  if (!pidfile) {
    return { state: 'stopped', detail: 'no pidfile' };
  }

  if (!isPidAlive(pidfile.pid)) {
    return {
      state: 'stale',
      detail: `pid ${pidfile.pid} not running`,
      pidfile,
    };
  }

  const timeoutMs = options.timeoutMs ?? PING_TIMEOUT_MS;
  const connectFn = options.natsConnectFn ?? connect;
  const sc = StringCodec();
  const t0 = Date.now();

  let nc: Awaited<ReturnType<typeof connect>> | null = null;
  try {
    nc = await connectFn({
      servers: pidfile.natsUrl || DEFAULT_NATS_URL,
      name: 'genie-bridge-status',
      reconnect: false,
      timeout: timeoutMs,
    });
    const msg = await nc.request(PING_SUBJECT, sc.encode('{}'), { timeout: timeoutMs });
    const pong = JSON.parse(sc.decode(msg.data)) as BridgePong;
    return {
      state: 'running',
      detail: `pong from pid ${pong.pid}`,
      pidfile,
      pong,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      state: 'stale',
      detail: `ping failed: ${detail}`,
      pidfile,
    };
  } finally {
    if (nc) {
      try {
        await nc.close();
      } catch {
        // ignore
      }
    }
  }
}

export const BRIDGE_PING_SUBJECT = PING_SUBJECT;
