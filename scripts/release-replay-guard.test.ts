// The release replay guard is a pure-bash `run:` body (every GitHub expression
// is confined to the step's `env:`), so it can be lifted out of the workflow
// and executed directly. release-docs.test.ts asserts the step's text; this
// file asserts what it DOES: which gh responses admit the run and which refuse
// it. See automagik-dev/genie#2674.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const WORKFLOW = join(ROOT, '.github/workflows/release-publish.yml');
const STEP = 'Refuse re-dispatch of an already published release';

/** Pull a step's `run: |` body out of a workflow and dedent it. */
function stepScript(workflow: string, stepName: string): string {
  const afterName = workflow.split(`- name: ${stepName}\n`)[1] ?? '';
  const afterRun = afterName.split(/^\s*run: \|\s*\n/m)[1] ?? '';
  const lines = afterRun.split('\n');
  const indent = (lines[0].match(/^ */) ?? [''])[0].length;
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if ((line.match(/^ */) ?? [''])[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n').trimEnd();
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface GhStub {
  stdout?: string;
  stderr?: string;
  exit: number;
}

/**
 * Run the extracted guard with `gh` stubbed on PATH. A single stub answers
 * every call; an array answers call N with entry N (the last entry repeats),
 * so transient-then-definitive sequences can be scripted.
 */
function runGuard(stub: GhStub | GhStub[], version = '5.260728.4') {
  const root = mkdtempSync(join(tmpdir(), 'genie-replay-guard-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const sequence = Array.isArray(stub) ? stub : [stub];
  const countFile = join(root, 'gh-calls');
  writeFileSync(countFile, '0');
  const arms = sequence
    .map((response, index) => {
      const arm = index === sequence.length - 1 ? '*' : String(index + 1);
      const body = `${response.stdout ? `printf '%s' '${response.stdout}'\n` : ''}${
        response.stderr ? `printf '%s\\n' '${response.stderr}' >&2\n` : ''
      }exit ${response.exit}`;
      return `  ${arm}) ${body} ;;`;
    })
    .join('\n');
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nn=$(cat '${countFile}')\nn=$((n + 1))\nprintf '%s' "$n" > '${countFile}'\ncase "$n" in\n${arms}\nesac\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);

  const scriptPath = join(root, 'guard.sh');
  writeFileSync(scriptPath, stepScript(readFileSync(WORKFLOW, 'utf8'), STEP));

  const result = Bun.spawnSync(['bash', scriptPath], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GH_TOKEN: 'stub-token',
      RELEASE_REPOSITORY: 'automagik-dev/genie',
      INPUT_VERSION: version,
      RETRY_SLEEP_SCALE: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return Object.assign(result, { ghCalls: Number(readFileSync(countFile, 'utf8')) });
}

describe('release-publish replay guard behavior', () => {
  test('the guard body is self-contained bash with no un-evaluated GitHub expressions', () => {
    const script = stepScript(readFileSync(WORKFLOW, 'utf8'), STEP);
    expect(script.startsWith('set -euo pipefail')).toBe(true);
    expect(script).toContain('RELEASE_JSON="$(mktemp)"');
    expect(script.includes('${{')).toBe(false);
  });

  test('a published release is refused', () => {
    const run = runGuard({ stdout: '{"draft":false}', exit: 0 });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString() + run.stderr.toString()).toContain('release-replay.published');
  });

  test('a draft release is admitted so an interrupted publish can finish', () => {
    const run = runGuard({ stdout: '{"draft":true}', exit: 0 });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('draft release; admitting');
  });

  test('a missing release (HTTP 404) is admitted', () => {
    const run = runGuard({ stderr: 'gh: Not Found (HTTP 404)', exit: 1 });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('has no GitHub Release yet');
  });

  test('an ambiguous API failure fails closed after exhausting the bounded retry loop', () => {
    const run = runGuard({ stderr: 'gh: Server Error (HTTP 500)', exit: 1 });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString() + run.stderr.toString()).toContain('release-replay.unknown');
    expect(run.ghCalls).toBe(4);
  });

  test('transient failures before a definitive 404 still admit the run', () => {
    const run = runGuard([
      { stderr: 'gh: Server Error (HTTP 500)', exit: 1 },
      { stderr: 'gh: Bad Gateway (HTTP 502)', exit: 1 },
      { stderr: 'gh: Not Found (HTTP 404)', exit: 1 },
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('has no GitHub Release yet');
    expect(run.ghCalls).toBe(3);
  });

  test('permission failures fail closed without retrying', () => {
    const run = runGuard({ stderr: 'gh: HTTP 403 Forbidden', exit: 1 });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString() + run.stderr.toString()).toContain('release-replay.unknown');
    expect(run.ghCalls).toBe(1);
  });
});
