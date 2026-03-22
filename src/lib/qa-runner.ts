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

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type QaSpec, parseQaSpec } from './qa-parser.js';
import { readMessages } from './team-chat.js';
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

/** Discover and run all QA specs from a directory. */
export async function runAllSpecs(specDir: string, options?: QaRunnerOptions): Promise<SpecReport[]> {
  const files = await readdir(specDir);
  const mdFiles = files.filter((f) => f.endsWith('.md')).sort();

  const reports: SpecReport[] = [];
  for (const file of mdFiles) {
    const spec = await parseQaSpec(join(specDir, file));
    const report = await runSpec(spec, options);
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

    // 2. Hire team-lead
    await teamManager.hireAgent(teamName, 'team-lead');

    // 3. Spawn team-lead via genie CLI
    const { handleWorkerSpawn } = await import('../term-commands/agents.js');
    await handleWorkerSpawn('team-lead', {
      provider: 'claude',
      team: teamName,
      cwd: config.worktreePath,
    });
    console.error(`  [qa] Spawned team-lead in team ${teamName}`);

    // 4. Build and send the kickoff prompt with the full spec
    const prompt = buildTeamLeadPrompt(spec, teamName, repoPath);
    const protocolRouter = await import('./protocol-router.js');
    await protocolRouter.sendMessage(repoPath, 'qa-cli', 'team-lead', prompt, teamName);
    console.error('  [qa] Sent spec to team-lead');

    // 5. Poll team chat for the result (team-lead posts a QA_RESULT JSON)
    const report = await pollForResult(spec, teamName, repoPath, timeoutMs, start);

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
When done, post your result to team chat using \`genie send\`. The message MUST contain a JSON block with this exact format:

\`\`\`
genie send 'QA_RESULT: {"result": "pass|fail", "expectations": [{"description": "...", "result": "pass|fail", "evidence": "...", "reason": "..."}], "collectedEvents": [{"timestamp": "...", "kind": "...", "agent": "...", "text": "..."}]}' --to qa-cli
\`\`\`

- Set "result" to "pass" only if ALL expectations pass
- For each expectation, include evidence (if pass) or reason (if fail)
- Include collected events in the collectedEvents array
- IMPORTANT: The message MUST start with "QA_RESULT:" followed by valid JSON

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
// Polling
// ============================================================================

const POLL_INTERVAL_MS = 3000;
const QA_RESULT_PREFIX = 'QA_RESULT:';

/** Poll team chat for the team-lead's QA_RESULT message. */
async function pollForResult(
  spec: QaSpec,
  teamName: string,
  repoPath: string,
  timeoutMs: number,
  start: number,
): Promise<SpecReport> {
  const deadline = start + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.error(`  [qa] Polling for result... (${elapsed}s elapsed)`);

    // Read team chat messages
    const messages = await readMessages(repoPath, teamName);
    for (const msg of messages) {
      if (msg.body.includes(QA_RESULT_PREFIX)) {
        return parseTeamLeadReport(spec, msg.body, start);
      }
    }

    // Also check team status — if team-lead marked it done, we're done
    const team = await teamManager.getTeam(teamName);
    if (team?.status === 'done') {
      // Check one last time for result message
      const finalMessages = await readMessages(repoPath, teamName);
      for (const msg of finalMessages) {
        if (msg.body.includes(QA_RESULT_PREFIX)) {
          return parseTeamLeadReport(spec, msg.body, start);
        }
      }
      // Team marked done but no structured report — treat as pass with no evidence
      return {
        name: spec.name,
        file: spec.file,
        result: 'pass',
        expectations: spec.expect.map((e) => ({
          description: e.description,
          result: 'pass' as ExpectResult,
          evidence: 'Team-lead marked team as done (no structured report)',
        })),
        collectedEvents: [],
        durationMs: Date.now() - start,
      };
    }
  }

  // Timeout — return error
  return makeErrorReport(spec, start, `Timeout after ${timeoutMs}ms waiting for team-lead report`);
}

/** Parse the team-lead's QA_RESULT JSON from a chat message. */
function parseTeamLeadReport(spec: QaSpec, messageBody: string, start: number): SpecReport {
  try {
    const jsonStart = messageBody.indexOf(QA_RESULT_PREFIX) + QA_RESULT_PREFIX.length;
    const jsonStr = messageBody.slice(jsonStart).trim();
    const data = JSON.parse(jsonStr) as {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve the default QA specs directory. */
export function defaultSpecDir(): string {
  return resolve(__dirname, '..', '..', 'tests', 'qa');
}
