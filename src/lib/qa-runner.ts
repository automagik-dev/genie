/**
 * QA Runner — Orchestrator that creates a REAL genie team for each QA spec.
 *
 * Flow:
 *   1. Parse the spec .md into a QaSpec
 *   2. Create a team `qa-{random}` via teamManager.createTeam()
 *   3. Hire and spawn a team-lead with the spec as context prompt
 *   4. Wait for the team-lead's PASS/FAIL report in the PG event log
 *   5. Parse the result, disband the team, return SpecReport
 *
 * The team-lead is a real Claude Code agent that:
 *   - Spawns agents listed in the spec's Setup section
 *   - Subscribes to PG runtime events via `genie log --follow`
 *   - Executes Actions (send messages, wait, run commands)
 *   - Validates Expectations against collected events
 *   - Reports PASS/FAIL as structured JSON via `genie qa-report`
 */

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { $ } from 'bun';
import { type QaSpec, parseQaSpec } from './qa-parser.js';
import { type SpecEntry, listAllSpecs, saveResult, specKeyFromPath } from './qa-state.js';
import { followRuntimeEvents, publishSubjectEvent, waitForRuntimeEvent } from './runtime-events.js';
import * as teamManager from './team-manager.js';

// ============================================================================
// Types
// ============================================================================

export type ExpectResult = 'pass' | 'fail';

export interface ExpectReport {
  description: string;
  result: ExpectResult;
  evidence?: string;
  reason?: string;
}

export interface SpecReport {
  name: string;
  file: string;
  result: 'pass' | 'fail' | 'error';
  expectations: ExpectReport[];
  collectedEvents: CollectedEvent[];
  durationMs: number;
  error?: string;
}

/** Minimal event shape for report compatibility. */
export interface CollectedEvent {
  timestamp: string;
  kind: string;
  agent: string;
  text: string;
}

export interface QaRunnerOptions {
  timeout?: number;
  verbose?: boolean;
  repoPath?: string;
  /** Max specs to run in parallel (default: 5) */
  parallel?: number;
  /** Emit incremental NDJSON events on stdout */
  ndjson?: boolean;
  /** Spec key override for single-spec mode (e.g. "messaging/mailbox-delivery") */
  specKey?: string;
}

// ============================================================================
// QA Event Emitter (NDJSON + PG Event Log)
// ============================================================================

interface QaEventPayload {
  type: string;
  specKey: string;
  domain: string;
  team: string;
  [key: string]: unknown;
}

/** Emit an NDJSON event line to stdout (only when ndjson mode is active). */
function emitNdjson(event: QaEventPayload): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Publish a QA event to the PG event log as a LogEvent-compatible payload. */
async function publishQaEvent(repoPath: string, qaType: string, payload: QaEventPayload): Promise<void> {
  const { specKey, domain, team, ...rest } = payload;
  await publishSubjectEvent(repoPath, `genie.qa.${qaType}`, {
    kind: 'qa',
    agent: 'qa',
    team,
    text: `${qaType}: ${specKey}`,
    data: { qaType, specKey, domain, ...rest },
    source: 'hook',
  });
}

/** Emit a QA event to both NDJSON stdout and the PG event log. */
async function emitQaEvent(repoPath: string, qaType: string, payload: QaEventPayload, ndjson: boolean): Promise<void> {
  await publishQaEvent(repoPath, qaType, payload);
  if (ndjson) emitNdjson(payload);
}

// ============================================================================
// Dirty Working Tree Overlay
// ============================================================================

type DirtyOverlayOp =
  | { kind: 'copy'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'rename'; from: string; to: string };

function parseNameStatusZ(output: string): DirtyOverlayOp[] {
  if (!output) return [];

  const parts = output.split('\0').filter(Boolean);
  const ops: DirtyOverlayOp[] = [];

  for (let i = 0; i < parts.length; ) {
    const status = parts[i++] ?? '';
    if (!status) break;

    if (status.startsWith('R')) {
      const from = parts[i++] ?? '';
      const to = parts[i++] ?? '';
      if (from && to) ops.push({ kind: 'rename', from, to });
      continue;
    }

    const path = parts[i++] ?? '';
    if (!path) continue;

    if (status.startsWith('D')) ops.push({ kind: 'delete', path });
    else ops.push({ kind: 'copy', path });
  }

  return ops;
}

/**
 * QA teams are created via `git clone --shared`, so by default they only see the
 * last committed tree. Overlay local dirty/untracked paths so QA validates the
 * code that is actually running in the current workspace.
 */
export async function overlayDirtyWorkingTree(repoPath: string, worktreePath: string): Promise<void> {
  const tracked = (
    await $`git -C ${repoPath} diff --name-status --find-renames -z HEAD --`.quiet().nothrow().text()
  ).trim();
  const untracked = (
    await $`git -C ${repoPath} ls-files --others --exclude-standard -z`.quiet().nothrow().text()
  ).trim();

  const ops = parseNameStatusZ(tracked);
  for (const path of untracked.split('\0').filter(Boolean)) {
    ops.push({ kind: 'copy', path });
  }

  for (const op of ops) {
    if (op.kind === 'delete') {
      await rm(join(worktreePath, op.path), { recursive: true, force: true });
      continue;
    }

    if (op.kind === 'rename') {
      await rm(join(worktreePath, op.from), { recursive: true, force: true });
      const src = join(repoPath, op.to);
      const dest = join(worktreePath, op.to);
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest, { recursive: true, force: true });
      continue;
    }

    const src = join(repoPath, op.path);
    const dest = join(worktreePath, op.path);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, { recursive: true, force: true });
  }
}

// ============================================================================
// Runner
// ============================================================================

/** Discover and run all QA specs recursively from a directory (supports domain subdirectories). */
export async function runAllSpecs(specDir: string, options?: QaRunnerOptions): Promise<SpecReport[]> {
  const entries = await listAllSpecs(specDir);
  return runSpecEntries(entries, specDir, options);
}

/** Run specs from a specific domain subdirectory. */
export async function runDomainSpecs(
  specDir: string,
  domain: string,
  options?: QaRunnerOptions,
): Promise<SpecReport[]> {
  const entries = await listAllSpecs(specDir);
  const filtered = entries.filter((e) => e.domain === domain);
  return runSpecEntries(filtered, specDir, options);
}

/**
 * Run spec entries with semaphore-based concurrency + real-time PG timeline.
 * Phase 1: Pre-create all teams serially (git worktree can't run in parallel)
 * Phase 2: Run specs through semaphore queue (next spec starts as soon as one finishes)
 * Phase 3: Disband all teams
 */
type PreparedSpec = { entry: SpecEntry; spec: QaSpec; teamName: string; worktreePath: string; promptFile: string };

/** Phase 1: Pre-create all teams serially (git worktree can't run in parallel). */
async function prepareTeams(entries: SpecEntry[], repoPath: string, ndjson: boolean): Promise<PreparedSpec[]> {
  const prepared: PreparedSpec[] = [];
  console.error(`\n  [qa] Creating ${entries.length} teams...`);
  for (const entry of entries) {
    const teamName = `qa-${Date.now().toString(36)}-${entry.name.slice(0, 8)}`;
    try {
      const spec = await parseQaSpec(entry.filePath);
      const config = await teamManager.createTeam(teamName, repoPath);
      await overlayDirtyWorkingTree(repoPath, config.worktreePath);
      await teamManager.hireAgent(teamName, 'qa');

      const prompt = buildTeamLeadPrompt(spec, teamName, repoPath);
      const promptFile = join(tmpdir(), `genie-qa-${teamName}.md`);
      await writeFile(promptFile, prompt);

      prepared.push({ entry, spec, teamName, worktreePath: config.worktreePath, promptFile });
      console.error(`    ✓ ${entry.name}`);
      await emitQaEvent(
        repoPath,
        'team-created',
        { type: 'qa:team-created', specKey: entry.key, domain: entry.domain, team: teamName },
        ndjson,
      );
    } catch (err) {
      console.error(`    ✗ ${entry.name}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return prepared;
}

/** Emit a spec-done event to PG + optionally NDJSON. */
async function emitSpecDone(
  repoPath: string,
  specKey: string,
  domain: string,
  team: string,
  report: SpecReport,
  ndjson: boolean,
): Promise<void> {
  await emitQaEvent(
    repoPath,
    'spec-done',
    {
      type: 'qa:spec-done',
      specKey,
      domain,
      team,
      result: report.result,
      durationMs: report.durationMs,
      expectations: report.expectations,
      error: report.error,
    },
    ndjson,
  );
}

async function runSpecEntries(entries: SpecEntry[], specDir: string, options?: QaRunnerOptions): Promise<SpecReport[]> {
  const repoPath = resolve(options?.repoPath ?? process.cwd());
  const maxConcurrency = options?.parallel ?? 5;
  const timeoutMs = (options?.timeout ?? 3600) * 1000;
  const ndjson = options?.ndjson ?? false;
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const RESET = '\x1b[0m';
  const DIM = '\x1b[90m';

  const prepared = await prepareTeams(entries, repoPath, ndjson);
  if (prepared.length === 0) return [];

  // Subscribe to the PG runtime event log for real-time timeline
  const timelineSub = await followRuntimeEvents(
    { repoPath, teamPrefix: 'qa-' },
    (event) => {
      if (!event?.timestamp || !event?.kind) return;
      const team = event.team ?? '';
      if (!team.startsWith('qa-')) return;
      const match = prepared.find((p) => p.teamName === team);
      const specKey = match?.entry.key ?? team;
      const specName = match?.entry.name ?? team;
      const domain = match?.entry.domain ?? '';
      const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const text = (event.text ?? '').slice(0, 100);
      console.error(`  ${DIM}${time}${RESET} ${DIM}[${event.kind}]${RESET} ${specName} ${DIM}${text}${RESET}`);
      if (ndjson) {
        emitNdjson({
          type: 'qa:event',
          specKey,
          domain,
          team,
          event: { timestamp: event.timestamp, kind: event.kind, agent: event.agent ?? '', text: event.text ?? '' },
        });
      }
    },
    { pollIntervalMs: 250 },
  );

  // Phase 2: Semaphore-based concurrency
  console.error(`\n  [qa] Running ${prepared.length} specs (max ${maxConcurrency} parallel)\n`);
  const reports: SpecReport[] = [];
  let running = 0;
  let nextIdx = 0;
  const startTime = Date.now();

  await new Promise<void>((resolveAll) => {
    const tryStartNext = () => {
      while (running < maxConcurrency && nextIdx < prepared.length) {
        const p = prepared[nextIdx++];
        running++;
        void emitQaEvent(
          repoPath,
          'spec-started',
          { type: 'qa:spec-started', specKey: p.entry.key, domain: p.entry.domain, team: p.teamName },
          ndjson,
        );

        runPreparedSpec(repoPath, p.spec, p.teamName, p.worktreePath, p.promptFile, timeoutMs)
          .then(async (report) => {
            const key = specKeyFromPath(specDir, p.entry.filePath);
            await saveResult(repoPath, key, report);
            const icon = report.result === 'pass' ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            console.error(`  ${icon} ${p.entry.name} (${(report.durationMs / 1000).toFixed(0)}s) [${elapsed}s total]`);
            await emitSpecDone(repoPath, p.entry.key, p.entry.domain, p.teamName, report, ndjson);
            reports.push(report);
          })
          .catch((err) => {
            const errorReport = makeErrorReport(p.spec, Date.now(), String(err));
            reports.push(errorReport);
            console.error(`  ${RED}✗${RESET} ${p.entry.name}: ${err}`);
            void emitSpecDone(repoPath, p.entry.key, p.entry.domain, p.teamName, errorReport, ndjson);
          })
          .finally(() => {
            running--;
            if (reports.length === prepared.length) resolveAll();
            else tryStartNext();
          });
      }
    };
    tryStartNext();
  });

  await timelineSub.stop();

  // Phase 3: Disband all teams
  console.error(`\n  [qa] Cleaning up ${prepared.length} teams...`);
  for (const p of prepared) {
    try {
      await teamManager.disbandTeam(p.teamName);
    } catch {
      // Best effort
    }
  }

  return reports;
}

/** Run a single QA spec (creates team, runs, disbands). For individual spec execution. */
export async function runSpec(spec: QaSpec, options?: QaRunnerOptions): Promise<SpecReport> {
  const repoPath = resolve(options?.repoPath ?? process.cwd());
  const timeoutMs = (options?.timeout ?? 3600) * 1000;
  const ndjson = options?.ndjson ?? false;
  const specKey = options?.specKey ?? spec.name;
  const domain = specKey.includes('/') ? specKey.split('/').slice(0, -1).join('/') : '(root)';
  const teamName = `qa-${Date.now().toString(36)}-${spec.name.slice(0, 8).replace(/\s+/g, '-')}`;
  const start = Date.now();

  try {
    const config = await teamManager.createTeam(teamName, repoPath);
    await overlayDirtyWorkingTree(repoPath, config.worktreePath);
    await teamManager.hireAgent(teamName, 'qa');
    await emitQaEvent(repoPath, 'team-created', { type: 'qa:team-created', specKey, domain, team: teamName }, ndjson);

    const prompt = buildTeamLeadPrompt(spec, teamName, repoPath);
    const promptFile = join(tmpdir(), `genie-qa-${teamName}.md`);
    await writeFile(promptFile, prompt);

    await emitQaEvent(repoPath, 'spec-started', { type: 'qa:spec-started', specKey, domain, team: teamName }, ndjson);
    const report = await runPreparedSpec(repoPath, spec, teamName, config.worktreePath, promptFile, timeoutMs);
    await emitSpecDone(repoPath, specKey, domain, teamName, report, ndjson);

    await teamManager.disbandTeam(teamName);
    return report;
  } catch (err) {
    try {
      await teamManager.disbandTeam(teamName);
    } catch {
      // Best effort
    }
    const errorReport = makeErrorReport(spec, start, String(err));
    await emitSpecDone(repoPath, specKey, domain, teamName, errorReport, ndjson);
    return errorReport;
  }
}

/** Run a single spec with a pre-created team (no git operations — safe for parallel). */
async function runPreparedSpec(
  repoPath: string,
  spec: QaSpec,
  teamName: string,
  worktreePath: string,
  promptFile: string,
  timeoutMs: number,
): Promise<SpecReport> {
  const start = Date.now();
  const effectiveTimeoutMs = computeEffectiveTimeoutMs(spec, timeoutMs);

  try {
    const { handleWorkerSpawn } = await import('../term-commands/agents.js');
    const paneId = await handleWorkerSpawn('qa', {
      provider: 'claude',
      team: teamName,
      session: teamName,
      cwd: worktreePath,
      role: 'team-lead',
      extraArgs: ['--append-system-prompt-file', promptFile],
      initialPrompt: `Execute the QA spec "${spec.name}" end-to-end right now. Do not stop after partial progress or a wait step. Continue until you validate the expectations, publish qa-report, and run team done. Your full instructions are in the system prompt.`,
    });
    console.error(`  [qa] Spawned qa for "${spec.name}" in ${teamName}`);

    const report = await waitForResult(spec, repoPath, teamName, effectiveTimeoutMs, start);
    return report;
  } catch (err) {
    return makeErrorReport(spec, start, String(err));
  }
}

// ============================================================================
// Team-Lead Prompt Builder
// ============================================================================

/**
 * Build the full prompt that the team-lead receives as context.
 * This tells the agent exactly what to do: spawn agents, execute actions,
 * validate expectations, and report the result.
 */
function buildQaPromptArtifacts(teamName: string): {
  followFile: string;
  followPidFile: string;
  followSinceFile: string;
  snapshotFile: string;
} {
  const base = `genie-qa-${teamName}`;
  return {
    followFile: join(tmpdir(), `${base}-follow.ndjson`),
    followPidFile: join(tmpdir(), `${base}-follow.pid`),
    followSinceFile: join(tmpdir(), `${base}-follow.since`),
    snapshotFile: join(tmpdir(), `${base}-snapshot.ndjson`),
  };
}

export function buildTeamLeadPrompt(spec: QaSpec, teamName: string, repoPath: string): string {
  const genieEntry = join(repoPath, 'src/genie.ts');
  const genieCmd = `bun run "${genieEntry}"`;
  const { followFile, followPidFile, followSinceFile, snapshotFile } = buildQaPromptArtifacts(teamName);
  const qaCheckCmd = buildQaCheckCommand(genieCmd, spec.file, teamName, followSinceFile);
  const specSummary = formatSpecForPrompt(spec);
  const setupInstructions = formatSetupInstructions(
    spec,
    teamName,
    genieCmd,
    followFile,
    followPidFile,
    followSinceFile,
  );
  const actionInstructions = formatActionInstructions(spec, teamName, genieCmd, qaCheckCmd);
  const expectInstructions = spec.expect
    .map((e) => `- ${e.description} (source: ${e.source}, matchers: ${JSON.stringify(e.matchers)})`)
    .join('\n');

  return `You are a QA team-lead for team "${teamName}". Your job is to execute the following QA spec and report PASS or FAIL.

## QA Spec: ${spec.name}
Source file: ${spec.file}

${specSummary}

## Instructions

Execute the spec step by step:

## Working Files
- Detached follow output: \`${followFile}\`
- Detached follow PID: \`${followPidFile}\`
- Follow start timestamp: \`${followSinceFile}\`
- Fallback snapshot file: \`${snapshotFile}\`

### 1. Setup
${setupInstructions}

### 2. Actions
${actionInstructions}

After the final action finishes, immediately continue to validation and reporting.
A wait step is never the end of the task.

### 3. Validate Expectations
After executing all actions and collecting events, validate each expectation:
${expectInstructions}

Preferred path: let Genie evaluate and publish the report for you with this exact command:
\`\`\`bash
${qaCheckCmd}
\`\`\`

This command reads the current team log/transcript snapshot, evaluates the spec, and publishes \`qa-report\` automatically.
Only fall back to manual \`qa-report\` if \`qa check\` itself errors.

### 4. Report Result
When done, publish the result via \`${genieCmd} qa-report\`:

\`\`\`bash
${genieCmd} qa-report '{"result": "pass", "expectations": [{"description": "...", "result": "pass", "evidence": "matched event..."}], "collectedEvents": [{"timestamp": "...", "kind": "...", "agent": "...", "text": "..."}]}'
\`\`\`

- Set "result" to "pass" only if ALL expectations pass, otherwise "fail"
- For each expectation, include evidence (if pass) or reason (if fail)
- Include collected events in the collectedEvents array
- IMPORTANT: This publishes instantly to the PG event log — the QA runner receives it immediately

### 5. Cleanup
After reporting, run:
\`\`\`bash
if [ -f "${followPidFile}" ]; then
  kill "$(cat "${followPidFile}")" 2>/dev/null || true
fi
${genieCmd} team done ${teamName}
\`\`\`

## Repo context
Genie repo root: ${repoPath}
Genie entrypoint: ${genieEntry}
Team: ${teamName}

## Command discipline
- Always run Genie via \`${genieCmd}\`
- Never run bare \`genie ...\` from PATH
- Never run a worktree-local \`src/genie.ts\`
- Never use Claude Bash \`run_in_background\` for long-lived commands in this spec
- Preserve the spec's target cwd. Example: \`cd /tmp/qa-test-repo && ${genieCmd} qa status\`
`;
}

function formatSetupInstructions(
  spec: QaSpec,
  teamName: string,
  genieCmd: string,
  followFile: string,
  followPidFile: string,
  followSinceFile: string,
): string {
  return spec.setup
    .map((s) => {
      if (s.kind === 'spawn') {
        const provider = s.options.provider || 'claude';
        return `- Spawn agent: \`${genieCmd} spawn ${s.target} --provider ${provider} --team ${teamName}\``;
      }
      if (s.kind === 'follow') {
        return `- Start detached runtime follow with this exact command (do not use Claude background tasks): \`date -u +"%Y-%m-%dT%H:%M:%SZ" > "${followSinceFile}" && nohup ${genieCmd} log --follow --team ${teamName} --ndjson > "${followFile}" 2>&1 < /dev/null & echo $! > "${followPidFile}" && sleep 2\``;
      }
      return `- Unknown setup step: ${s.kind}`;
    })
    .join('\n');
}

function buildQaCheckCommand(genieCmd: string, specFile: string, teamName: string, followSinceFile: string): string {
  return `${genieCmd} qa check "${specFile}" --team ${teamName} --since-file "${followSinceFile}"`;
}

function formatActionInstructions(spec: QaSpec, teamName: string, genieCmd: string, qaCheckCmd: string): string {
  return spec.actions
    .map((a, i) => {
      const isFinalAction = i === spec.actions.length - 1;
      if (a.kind === 'send') {
        return `${i + 1}. Send message: \`${genieCmd} send '${a.message}' --to ${a.to} --team ${teamName}\``;
      }
      if (a.kind === 'wait') {
        if (isFinalAction) {
          return `${i + 1}. Finalize in one command: \`sleep ${a.seconds ?? 1} && ${qaCheckCmd}\``;
        }
        return `${i + 1}. Wait ${a.seconds ?? 1} seconds`;
      }
      if (a.kind === 'run') return `${i + 1}. Run command: \`${rewriteRunCommand(a.command ?? '', genieCmd)}\``;
      return `${i + 1}. Unknown action: ${a.kind}`;
    })
    .join('\n');
}

function rewriteRunCommand(command: string, genieCmd: string): string {
  if (!command) return command;
  return command.replace(/(^|[;&|()\s])genie(?=\s|$)/g, `$1${genieCmd}`);
}

/** Format the parsed spec back into a readable summary. */
function formatSpecForPrompt(spec: QaSpec): string {
  return [
    '### Setup',
    ...spec.setup.map(formatSetupStep),
    '### Actions',
    ...spec.actions.map(formatActionStep),
    '### Expectations',
    ...spec.expect.map((e) => `- [ ] ${e.description}`),
  ].join('\n');
}

function formatSetupStep(s: QaSpec['setup'][number]): string {
  if (s.kind === 'spawn') {
    const opts = Object.entries(s.options)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    return `- spawn ${s.target}${opts ? ` (${opts})` : ''}`;
  }
  return `- follow ${s.target}`;
}

function formatActionStep(a: QaSpec['actions'][number]): string {
  if (a.kind === 'send') return `- send "${a.message}" to ${a.to}`;
  if (a.kind === 'wait') return `- wait ${a.seconds ?? 1}s`;
  if (a.kind === 'run') return `- run ${a.command}`;
  return `- ${a.kind}`;
}

// ============================================================================
// QA Result Listener
// ============================================================================

/** Wait for `genie.qa.{team}.result` on the PG event log. */
export async function waitForResult(
  spec: QaSpec,
  repoPath: string,
  teamName: string,
  timeoutMs: number,
  start: number,
): Promise<SpecReport> {
  const subject = `genie.qa.${teamName}.result`;
  const remainingMs = Math.max(timeoutMs - (Date.now() - start), 1);
  const event = await waitForRuntimeEvent({ repoPath, subject, team: teamName }, remainingMs);
  if (!event) {
    return makeErrorReport(spec, start, `Timeout after ${timeoutMs}ms waiting for team-lead report in PG event log`);
  }
  return parseTeamLeadReport(spec, event.data ?? {}, start);
}

/** Parse the team-lead's QA result payload. */
export function parseTeamLeadReport(spec: QaSpec, payload: Record<string, unknown>, start: number): SpecReport {
  try {
    const data = payload as {
      result?: string;
      expectations?: ExpectReport[];
      collectedEvents?: CollectedEvent[];
    };

    return {
      name: spec.name,
      file: spec.file,
      result: (data.result === 'pass' ? 'pass' : 'fail') as 'pass' | 'fail',
      expectations: data.expectations ?? [],
      collectedEvents: data.collectedEvents ?? [],
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return makeErrorReport(spec, start, `Failed to parse team-lead report: ${err}`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function makeErrorReport(spec: QaSpec, start: number, error: string): SpecReport {
  return {
    name: spec.name,
    file: spec.file,
    result: 'error',
    expectations: [],
    collectedEvents: [],
    durationMs: Date.now() - start,
    error,
  };
}

export function computeEffectiveTimeoutMs(spec: QaSpec, requestedTimeoutMs: number): number {
  const totalWaitMs = spec.actions.reduce(
    (sum, action) => sum + (action.kind === 'wait' ? (action.seconds ?? 0) * 1000 : 0),
    0,
  );
  const setupSpawnCount = spec.setup.filter((step) => step.kind === 'spawn').length;
  const orchestrationSlackMs = Math.max(
    30000,
    Math.min(90000, 15000 + Math.floor(totalWaitMs / 2) + setupSpawnCount * 15000),
  );
  return requestedTimeoutMs + orchestrationSlackMs;
}

/** Resolve the QA specs directory for the current repo. */
export function defaultSpecDir(repoPath?: string): string {
  return join(resolve(repoPath ?? process.cwd()), '.genie', 'qa');
}
