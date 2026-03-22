/**
 * QA Runner — Orchestrator that creates a REAL genie team for each QA spec.
 *
 * Flow:
 *   1. Parse the spec .md into a QaSpec
 *   2. Create a team `qa-{random}` via teamManager.createTeam()
 *   3. Hire and spawn a team-lead with the spec as context prompt
 *   4. Poll team chat for the team-lead's PASS/FAIL report
 *   5. Parse the result, disband the team, return SpecReport
 *
 * The team-lead is a real Claude Code agent that:
 *   - Spawns agents listed in the spec's Setup section
 *   - Subscribes to NATS events via `genie log --follow`
 *   - Executes Actions (send messages, wait, run commands)
 *   - Validates Expectations against collected events
 *   - Reports PASS/FAIL as a structured JSON in team chat
 */

import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as nats from './nats-client.js';
import { type QaSpec, parseQaSpec } from './qa-parser.js';
import { type SpecEntry, listAllSpecs, saveResult, specKeyFromPath } from './qa-state.js';
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
 * Run spec entries with semaphore-based concurrency + real-time NATS timeline.
 * Phase 1: Pre-create all teams serially (git worktree can't run in parallel)
 * Phase 2: Run specs through semaphore queue (next spec starts as soon as one finishes)
 * Phase 3: Disband all teams
 */
async function runSpecEntries(entries: SpecEntry[], specDir: string, options?: QaRunnerOptions): Promise<SpecReport[]> {
  const repoPath = resolve(options?.repoPath ?? process.cwd());
  const maxConcurrency = options?.parallel ?? 5;
  const timeoutMs = (options?.timeout ?? 60) * 1000;
  const DIM = '\x1b[90m';
  const RESET = '\x1b[0m';
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';

  // Phase 1: Pre-create all teams serially
  type PreparedSpec = { entry: SpecEntry; spec: QaSpec; teamName: string; worktreePath: string; promptFile: string };
  const prepared: PreparedSpec[] = [];
  console.error(`\n  [qa] Creating ${entries.length} teams...`);
  for (const entry of entries) {
    const teamName = `qa-${Date.now().toString(36)}-${entry.name.slice(0, 8)}`;
    try {
      const spec = await parseQaSpec(entry.filePath);
      const config = await teamManager.createTeam(teamName, repoPath);
      await teamManager.hireAgent(teamName, 'qa-runner');

      const prompt = buildTeamLeadPrompt(spec, teamName, repoPath);
      const promptFile = join(tmpdir(), `genie-qa-${teamName}.md`);
      await writeFile(promptFile, prompt);

      prepared.push({ entry, spec, teamName, worktreePath: config.worktreePath, promptFile });
      console.error(`    ✓ ${entry.name}`);
    } catch (err) {
      console.error(`    ✗ ${entry.name}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (prepared.length === 0) return [];

  // Subscribe to all NATS events for real-time timeline
  const timelineSub = await nats.subscribe('genie.>', (_subj, data) => {
    const event = data as { timestamp?: string; kind?: string; agent?: string; text?: string; team?: string };
    if (!event?.timestamp || !event?.kind) return;
    // Only show events from QA teams
    const team = event.team ?? '';
    if (!team.startsWith('qa-')) return;
    const specName = prepared.find((p) => p.teamName === team)?.entry.name ?? team;
    const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const text = (event.text ?? '').slice(0, 100);
    console.error(`  ${DIM}${time}${RESET} ${DIM}[${event.kind}]${RESET} ${specName} ${DIM}${text}${RESET}`);
  });

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

        runPreparedSpec(p.spec, p.teamName, p.worktreePath, p.promptFile, timeoutMs)
          .then(async (report) => {
            const key = specKeyFromPath(specDir, p.entry.filePath);
            await saveResult(repoPath, key, report);
            const icon = report.result === 'pass' ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            console.error(`  ${icon} ${p.entry.name} (${(report.durationMs / 1000).toFixed(0)}s) [${elapsed}s total]`);
            reports.push(report);
          })
          .catch((err) => {
            const errorReport = makeErrorReport(p.spec, Date.now(), String(err));
            reports.push(errorReport);
            console.error(`  ${RED}✗${RESET} ${p.entry.name}: ${err}`);
          })
          .finally(() => {
            running--;
            if (reports.length === prepared.length) {
              resolveAll();
            } else {
              tryStartNext();
            }
          });
      }
    };
    tryStartNext();
  });

  // Unsubscribe timeline
  timelineSub.unsubscribe();

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
  const timeoutMs = (options?.timeout ?? 60) * 1000;
  const teamName = `qa-${Date.now().toString(36)}-${spec.name.slice(0, 8).replace(/\s+/g, '-')}`;
  const start = Date.now();

  try {
    const config = await teamManager.createTeam(teamName, repoPath);
    await teamManager.hireAgent(teamName, 'qa-runner');

    const prompt = buildTeamLeadPrompt(spec, teamName, repoPath);
    const promptFile = join(tmpdir(), `genie-qa-${teamName}.md`);
    await writeFile(promptFile, prompt);

    const report = await runPreparedSpec(spec, teamName, config.worktreePath, promptFile, timeoutMs);

    await teamManager.disbandTeam(teamName);
    return report;
  } catch (err) {
    try {
      await teamManager.disbandTeam(teamName);
    } catch {
      // Best effort
    }
    return makeErrorReport(spec, start, String(err));
  }
}

/** Run a single spec with a pre-created team (no git operations — safe for parallel). */
async function runPreparedSpec(
  spec: QaSpec,
  teamName: string,
  worktreePath: string,
  promptFile: string,
  timeoutMs: number,
): Promise<SpecReport> {
  const start = Date.now();

  try {
    const { handleWorkerSpawn } = await import('../term-commands/agents.js');
    await handleWorkerSpawn('qa-runner', {
      provider: 'claude',
      team: teamName,
      cwd: worktreePath,
      role: 'team-lead',
      extraArgs: ['--append-system-prompt-file', promptFile],
      initialPrompt: `Execute the QA spec "${spec.name}". Your full instructions are in the system prompt. Start now.`,
    });
    console.error(`  [qa] Spawned qa-runner for "${spec.name}" in ${teamName}`);

    const report = await waitForResult(spec, teamName, timeoutMs, start);
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
function buildTeamLeadPrompt(spec: QaSpec, teamName: string, repoPath: string): string {
  const specSummary = formatSpecForPrompt(spec);
  const setupInstructions = formatSetupInstructions(spec, teamName);
  const actionInstructions = formatActionInstructions(spec);
  const expectInstructions = spec.expect
    .map((e) => `- ${e.description} (source: ${e.source}, matchers: ${JSON.stringify(e.matchers)})`)
    .join('\n');

  return `You are a QA team-lead for team "${teamName}". Your job is to execute the following QA spec and report PASS or FAIL.

## QA Spec: ${spec.name}
Source file: ${spec.file}

${specSummary}

## Instructions

Execute the spec step by step:

### 1. Setup
${setupInstructions}

### 2. Actions
${actionInstructions}

### 3. Validate Expectations
After executing all actions and collecting events, validate each expectation:
${expectInstructions}

### 4. Report Result
When done, publish the result via NATS using \`genie qa-report\`:

\`\`\`bash
genie qa-report '{"result": "pass", "expectations": [{"description": "...", "result": "pass", "evidence": "matched event..."}], "collectedEvents": [{"timestamp": "...", "kind": "...", "agent": "...", "text": "..."}]}'
\`\`\`

- Set "result" to "pass" only if ALL expectations pass, otherwise "fail"
- For each expectation, include evidence (if pass) or reason (if fail)
- Include collected events in the collectedEvents array
- IMPORTANT: This publishes instantly via NATS — the QA runner receives it immediately

### 5. Cleanup
After reporting, run:
\`\`\`
genie team done ${teamName}
\`\`\`

## Repo context
Working directory: ${repoPath}
Team: ${teamName}
`;
}

function formatSetupInstructions(spec: QaSpec, teamName: string): string {
  return spec.setup
    .map((s) => {
      if (s.kind === 'spawn') {
        const provider = s.options.provider || 'claude';
        return `- Spawn agent: \`genie spawn ${s.target} --provider ${provider} --team ${teamName}\``;
      }
      if (s.kind === 'follow') {
        return `- Start collecting NATS events: run \`genie log --follow --team ${teamName} --ndjson\` in background`;
      }
      return `- Unknown setup step: ${s.kind}`;
    })
    .join('\n');
}

function formatActionInstructions(spec: QaSpec): string {
  return spec.actions
    .map((a, i) => {
      if (a.kind === 'send') return `${i + 1}. Send message: \`genie send '${a.message}' --to ${a.to}\``;
      if (a.kind === 'wait') return `${i + 1}. Wait ${a.seconds ?? 1} seconds`;
      if (a.kind === 'run') return `${i + 1}. Run command: \`${a.command}\``;
      return `${i + 1}. Unknown action: ${a.kind}`;
    })
    .join('\n');
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
// NATS Result Listener
// ============================================================================

/** Subscribe to `genie.qa.{team}.result` and wait for the team-lead's report. */
async function waitForResult(spec: QaSpec, teamName: string, timeoutMs: number, start: number): Promise<SpecReport> {
  const subject = `genie.qa.${teamName}.result`;
  let resolved = false;
  let resolveFn: (report: SpecReport) => void;
  const promise = new Promise<SpecReport>((r) => {
    resolveFn = r;
  });

  const sub = await nats.subscribe(subject, (_subj, data) => {
    if (resolved) return;
    resolved = true;
    const report = parseTeamLeadReport(spec, data as Record<string, unknown>, start);
    sub.unsubscribe();
    resolveFn(report);
  });

  // Timeout fallback
  const timer = setTimeout(
    () => {
      if (resolved) return;
      resolved = true;
      sub.unsubscribe();
      resolveFn(makeErrorReport(spec, start, `Timeout after ${timeoutMs}ms waiting for team-lead report via NATS`));
    },
    timeoutMs - (Date.now() - start),
  );

  // Cleanup timer when resolved
  promise.then(() => clearTimeout(timer));

  return promise;
}

/** Parse the team-lead's QA result from NATS payload. */
function parseTeamLeadReport(spec: QaSpec, payload: Record<string, unknown>, start: number): SpecReport {
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

/** Resolve the default QA specs directory. */
export function defaultSpecDir(): string {
  return resolve(__dirname, '..', '..', 'tests', 'qa');
}
