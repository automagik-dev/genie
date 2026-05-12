#!/usr/bin/env bun
/**
 * Group 2 manual smoke: connect to an existing `-L genie` tmux session
 * via control mode, stream `%output` for 10 s, dump a transcript, then
 * detach cleanly.
 *
 * Usage:
 *   bun run scripts/tui-spike/tmux-control-attach.ts <session-name> [seconds]
 *
 * The transcript lands in /tmp/tmux-control-smoke.log. The script reports
 * total bytes received and exits non-zero if the control connection failed
 * to come up.
 *
 * Wish reference: .genie/wishes/tui-opentui-host/WISH.md (Group 2,
 * "Manual smoke" acceptance criterion).
 */

import { writeFileSync } from 'node:fs';
import { ControlSession } from '../../src/tui/tmux-control/control.js';

const TRANSCRIPT_PATH = '/tmp/tmux-control-smoke.log';

function fail(msg: string, code = 1): never {
  console.error(`[tmux-control-smoke] ${msg}`);
  process.exit(code);
}

const sessionName = process.argv[2];
const durationSec = process.argv[3] ? Number.parseInt(process.argv[3], 10) : 10;
if (!sessionName) {
  fail('usage: bun run scripts/tui-spike/tmux-control-attach.ts <session-name> [seconds]');
}
if (!Number.isFinite(durationSec) || durationSec <= 0) {
  fail(`invalid duration: ${process.argv[3]}`);
}

const transcriptChunks: Array<{ paneId: string; bytes: number; preview: string }> = [];
let totalBytes = 0;
let sawAnyOutput = false;
let exited = false;

const session = new ControlSession(sessionName, { autoReconnect: false });

session.on('output', (paneId: string, data: Buffer) => {
  sawAnyOutput = true;
  totalBytes += data.length;
  const ESC = String.fromCharCode(0x1b);
  const preview = data.toString('utf-8').split(ESC).join('\\e').slice(0, 120);
  transcriptChunks.push({ paneId, bytes: data.length, preview });
});

session.on('exit', (status: string) => {
  exited = true;
  console.log(`[tmux-control-smoke] %exit ${status}`);
});

session.on('error', (err: Error) => {
  console.error(`[tmux-control-smoke] error: ${err.message}`);
});

session.on('close', (code: number | null) => {
  exited = true;
  console.log(`[tmux-control-smoke] child closed (code=${code})`);
});

console.log(`[tmux-control-smoke] attached to '${sessionName}', streaming ${durationSec}s …`);
const deadline = Date.now() + durationSec * 1000;
const tick = setInterval(() => {
  if (Date.now() >= deadline || exited) {
    clearInterval(tick);
    finish();
  }
}, 250);

function finish(): void {
  session.detach();
  const lines = [
    '# tmux-control smoke transcript',
    `session: ${sessionName}`,
    `duration_sec: ${durationSec}`,
    `total_bytes: ${totalBytes}`,
    `frames: ${transcriptChunks.length}`,
    `saw_output: ${sawAnyOutput}`,
    '',
    ...transcriptChunks.map((c) => `[${c.paneId}] ${c.bytes}B :: ${c.preview}`),
  ];
  const transcript = `${lines.join('\n')}\n`;
  writeFileSync(TRANSCRIPT_PATH, transcript);
  console.log(
    `[tmux-control-smoke] wrote ${transcriptChunks.length} frames / ${totalBytes} bytes → ${TRANSCRIPT_PATH}`,
  );
  process.exit(sawAnyOutput || transcriptChunks.length === 0 ? 0 : 1);
}
