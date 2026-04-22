import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import {
  buildTeamLeadPrompt,
  computeEffectiveTimeoutMs,
  defaultSpecDir,
  overlayDirtyWorkingTree,
  parseTeamLeadReport,
  waitForResult,
} from './qa-runner.js';
import { publishRuntimeEvent } from './runtime-events.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!DB_AVAILABLE) return;
  cleanup = await setupTestDatabase();
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe.skipIf(!DB_AVAILABLE)('qa-runner', () => {
  describe('defaultSpecDir', () => {
    test('returns {cwd}/.genie/qa/ when no argument given', () => {
      const result = defaultSpecDir();
      expect(result).toBe(join(resolve(process.cwd()), '.genie', 'qa'));
    });

    test('returns {repoPath}/.genie/qa/ for explicit path', () => {
      const result = defaultSpecDir('/abc/def');
      expect(result).toBe(join(resolve('/abc/def'), '.genie', 'qa'));
    });

    test('different CWDs produce different spec dirs', () => {
      const dirA = defaultSpecDir('/tmp/repo-a');
      const dirB = defaultSpecDir('/tmp/repo-b');
      expect(dirA).toBe('/tmp/repo-a/.genie/qa');
      expect(dirB).toBe('/tmp/repo-b/.genie/qa');
      expect(dirA).not.toBe(dirB);
    });
  });

  describe('parseTeamLeadReport', () => {
    test('maps a PG event payload into a spec report', () => {
      const report = parseTeamLeadReport(
        { name: 'mailbox', file: '/tmp/spec.md', setup: [], actions: [], expect: [] },
        {
          result: 'pass',
          expectations: [{ description: 'saw event', result: 'pass', evidence: 'ok' }],
          collectedEvents: [{ timestamp: '2026-03-27T12:00:00.000Z', kind: 'qa', agent: 'qa', text: 'done' }],
        },
        Date.now() - 5,
      );

      expect(report.result).toBe('pass');
      expect(report.expectations).toHaveLength(1);
      expect(report.collectedEvents).toHaveLength(1);
    });
  });

  describe('buildTeamLeadPrompt', () => {
    test('uses detached follow collection instead of Claude background tasks', () => {
      const prompt = buildTeamLeadPrompt(
        {
          name: 'follow-events',
          file: '/tmp/spec.md',
          setup: [{ kind: 'follow', target: 'team', options: {} }],
          actions: [{ kind: 'wait', seconds: 30 }],
          expect: [],
        },
        'qa-follow-team',
        '/tmp/genie-repo',
      );

      expect(prompt).toContain(
        'nohup bun run "/tmp/genie-repo/src/genie.ts" log --follow --team qa-follow-team --ndjson',
      );
      expect(prompt).toContain('Never use Claude Bash `run_in_background` for long-lived commands in this spec');
      expect(prompt).toContain('follow.pid');
      expect(prompt).toContain('follow.since');
      expect(prompt).toContain(
        'sleep 30 && bun run "/tmp/genie-repo/src/genie.ts" qa check "/tmp/spec.md" --team qa-follow-team',
      );
    });

    test('anchors send actions to explicit team context', () => {
      const prompt = buildTeamLeadPrompt(
        {
          name: 'send-msg',
          file: '/tmp/spec.md',
          setup: [],
          actions: [{ kind: 'send', to: 'engineer', message: 'reply with ok' }],
          expect: [],
        },
        'qa-send-team',
        '/tmp/genie-repo',
      );

      expect(prompt).toContain(
        `bun run "/tmp/genie-repo/src/genie.ts" send 'reply with ok' --to engineer --team qa-send-team`,
      );
    });
  });

  describe('waitForResult', () => {
    test('receives QA result from PG event log', async () => {
      const spec = { name: 'mailbox', file: '/tmp/spec.md', setup: [], actions: [], expect: [] };
      const waitPromise = waitForResult(spec, '/tmp/qa-repo', 'qa-team', 1000, Date.now());

      await publishRuntimeEvent({
        repoPath: '/tmp/qa-repo',
        subject: 'genie.qa.qa-team.result',
        kind: 'qa',
        agent: 'qa',
        team: 'qa-team',
        text: 'qa-result',
        source: 'hook',
        data: {
          result: 'pass',
          expectations: [{ description: 'ok', result: 'pass', evidence: 'matched' }],
          collectedEvents: [{ timestamp: '2026-03-27T12:00:00.000Z', kind: 'qa', agent: 'qa', text: 'done' }],
        },
      });

      const report = await waitPromise;
      expect(report.result).toBe('pass');
      expect(report.expectations).toHaveLength(1);
    });

    test('ignores QA results from other repos', async () => {
      const spec = { name: 'mailbox', file: '/tmp/spec.md', setup: [], actions: [], expect: [] };
      const waitPromise = waitForResult(spec, '/tmp/qa-repo-a', 'qa-team', 1000, Date.now());

      await publishRuntimeEvent({
        repoPath: '/tmp/qa-repo-b',
        subject: 'genie.qa.qa-team.result',
        kind: 'qa',
        agent: 'qa',
        team: 'qa-team',
        text: 'wrong-repo',
        source: 'hook',
        data: { result: 'fail', expectations: [], collectedEvents: [] },
      });
      await publishRuntimeEvent({
        repoPath: '/tmp/qa-repo-a',
        subject: 'genie.qa.qa-team.result',
        kind: 'qa',
        agent: 'qa',
        team: 'qa-team',
        text: 'right-repo',
        source: 'hook',
        data: {
          result: 'pass',
          expectations: [{ description: 'ok', result: 'pass', evidence: 'matched' }],
          collectedEvents: [],
        },
      });

      const report = await waitPromise;
      expect(report.result).toBe('pass');
      expect(report.expectations).toHaveLength(1);
    });
  });

  describe('computeEffectiveTimeoutMs', () => {
    test('adds minimum orchestration slack for simple specs', () => {
      const timeoutMs = computeEffectiveTimeoutMs(
        { name: 'simple', file: '/tmp/spec.md', setup: [], actions: [], expect: [] },
        90_000,
      );

      expect(timeoutMs).toBe(120_000);
    });

    test('adds extra slack for wait steps and multi-agent setup', () => {
      const timeoutMs = computeEffectiveTimeoutMs(
        {
          name: 'multi-agent',
          file: '/tmp/spec.md',
          setup: [
            { kind: 'follow', target: 'team', options: {} },
            { kind: 'spawn', target: 'engineer', options: {} },
            { kind: 'spawn', target: 'reviewer', options: {} },
          ],
          actions: [
            { kind: 'send', to: 'engineer', message: 'hi' },
            { kind: 'wait', seconds: 30 },
          ],
          expect: [],
        },
        90_000,
      );

      expect(timeoutMs).toBe(150_000);
    });
  });

  describe('overlayDirtyWorkingTree', () => {
    test('copies dirty and untracked files into QA worktree and removes deleted paths', async () => {
      const baseDir = await mkdtemp(join(tmpdir(), 'qa-overlay-'));
      const repoPath = join(baseDir, 'repo');
      const worktreePath = join(baseDir, 'worktree');

      try {
        await $`mkdir -p ${repoPath}`.quiet();
        await $`git -C ${repoPath} init -b dev`.quiet();
        await $`git -C ${repoPath} config user.email test@example.com`.quiet();
        await $`git -C ${repoPath} config user.name "QA Test"`.quiet();

        await writeFile(join(repoPath, 'tracked.txt'), 'old\n');
        await writeFile(join(repoPath, 'removed.txt'), 'remove me\n');
        await $`git -C ${repoPath} add tracked.txt removed.txt`.quiet();
        await $`git -C ${repoPath} commit -m "initial"`.quiet();

        await $`git clone --shared --branch dev ${repoPath} ${worktreePath}`.quiet();

        await writeFile(join(repoPath, 'tracked.txt'), 'new\n');
        await rm(join(repoPath, 'removed.txt'));
        await writeFile(join(repoPath, 'new-dir', 'fresh.txt'), 'fresh\n').catch(async () => {
          await $`mkdir -p ${join(repoPath, 'new-dir')}`.quiet();
          await writeFile(join(repoPath, 'new-dir', 'fresh.txt'), 'fresh\n');
        });

        await overlayDirtyWorkingTree(repoPath, worktreePath);

        expect(await readFile(join(worktreePath, 'tracked.txt'), 'utf-8')).toBe('new\n');
        expect(await readFile(join(worktreePath, 'new-dir', 'fresh.txt'), 'utf-8')).toBe('fresh\n');
        await expect(readFile(join(worktreePath, 'removed.txt'), 'utf-8')).rejects.toThrow();
      } finally {
        await rm(baseDir, { recursive: true, force: true });
      }
    });
  });
});
