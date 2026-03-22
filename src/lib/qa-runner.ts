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

/** Run a list of spec entries, saving results after each. */
async function runSpecEntries(entries: SpecEntry[], specDir: string, options?: QaRunnerOptions): Promise<SpecReport[]> {
  const repoPath = resolve(options?.repoPath ?? process.cwd());
  const reports: SpecReport[] = [];
  for (const entry of entries) {
    const spec = await parseQaSpec(entry.filePath);
    const report = await runSpec(spec, options);
    const key = specKeyFromPath(specDir, entry.filePath);
    await saveResult(repoPath, key, report);
    reports.push(report);
  }
  return reports;
}

/** Run a single QA spec by creating a real team with a team-lead agent. */
export async function runSpec(spec: QaSpec, options?: QaRunnerOptions): Promise<SpecReport> {
  const teamName = `qa-${Date.now().toString(36)}`;
  const repoPath = resolve(options?.repoPath ?? process.cwd());
  const timeoutMs = (options?.timeout ?? 60) * 1000;
  const start = Date.now();

  try {
    // 1. Create the QA team
    const config = await teamManager.createTeam(teamName, repoPath);
    console.error(`  [qa] Created team ${teamName} at ${config.worktreePath}`);

    // 2. Write the QA spec prompt to a temp file for --append-system-prompt-file
    const prompt = buildTeamLeadPrompt(spec, teamName, repoPath);
    const promptFile = join(tmpdir(), `genie-qa-${teamName}.md`);
    await writeFile(promptFile, prompt);

    // 3. Hire and spawn qa-runner agent (dedicated QA executor, not generic team-lead)
    await teamManager.hireAgent(teamName, 'qa-runner');

    const { handleWorkerSpawn } = await import('../term-commands/agents.js');
    await handleWorkerSpawn('qa-runner', {
      provider: 'claude',
      team: teamName,
      cwd: config.worktreePath,
      role: 'team-lead',
      extraArgs: ['--append-system-prompt-file', promptFile],
      initialPrompt: `Execute the QA spec "${spec.name}". Your full instructions are in the system prompt. Start now.`,
    });
    console.error(`  [qa] Spawned qa-runner in team ${teamName}`);

    // 5. Wait for result via NATS (team-lead runs `genie qa report` which publishes to genie.qa.{team}.result)
    const report = await waitForResult(spec, teamName, timeoutMs, start);

    // 6. Disband the team
    await teamManager.disbandTeam(teamName);
    console.error(`  [qa] Disbanded team ${teamName}`);

    return report;
  } catch (err) {
    // Best-effort cleanup
    try {
      await teamManager.disbandTeam(teamName);
    } catch {
      // Ignore cleanup errors
    }
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

  console.error(`  [qa] Listening on ${subject} for result...`);

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

  // Progress indicator
  const progress = setInterval(() => {
    if (resolved) {
      clearInterval(progress);
      clearTimeout(timer);
      return;
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.error(`  [qa] Waiting for result... (${elapsed}s elapsed)`);
  }, 5000);

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
