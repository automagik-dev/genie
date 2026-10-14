import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttemptIdentity, hostClock } from './contracts';
import {
  type JournalEntry,
  acquireSupervisor,
  appendTransition,
  campaignStatus,
  planRecovery,
  readJournal,
  registerCampaign,
} from './ledger';

const EXPERIMENT = 'exp-1';

function identity(attemptId: string, overrides: Partial<AttemptIdentity> = {}): AttemptIdentity {
  return {
    experimentId: EXPERIMENT,
    pairId: 'pair-0',
    manifestId: 'manifest-1',
    taskKey: 'deepswe/lint/task-a',
    configId: 'config-a',
    arm: 'genie',
    repeat: 0,
    attemptId,
    scheduledIndex: Number(attemptId.replace(/\D/g, '')) || 0,
    kind: 'scored',
    ...overrides,
  };
}

const SCHEDULE = (): AttemptIdentity[] => [identity('att-0'), identity('att-1', { arm: 'zero-genie' })];

function data(extra: Partial<Omit<JournalEntry, 'seq' | 'state'>> = {}): Omit<JournalEntry, 'seq' | 'state'> {
  return { at: hostClock.wall(), monotonicNs: hostClock.nowNs().toString(), evidence: [], ...extra };
}

let savedGenieHome: string | undefined;
let genieHome: string;
let root: string;

const journalFile = (attemptId: string): string => join(root, 'attempts', attemptId, 'journal.jsonl');
const scheduleFile = (): string => join(root, 'campaigns', EXPERIMENT, 'schedule.jsonl');
const mode = (path: string): number => statSync(path).mode & 0o777;

beforeAll(() => {
  savedGenieHome = process.env.GENIE_HOME;
  genieHome = mkdtempSync(join(tmpdir(), 'ledger-genie-home-'));
  process.env.GENIE_HOME = genieHome;
});

afterAll(() => {
  if (savedGenieHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
  else process.env.GENIE_HOME = savedGenieHome;
  rmSync(genieHome, { recursive: true, force: true });
});

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'ledger-root-')), 'root');
});

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('register before launch', () => {
  test('running for an unregistered attemptId is refused and creates no journal', () => {
    const result = appendTransition(root, 'att-0', 'running', data());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('not registered');
    expect(existsSync(journalFile('att-0'))).toBe(false);
  });

  test('registration persists every identity on disk before any running entry', () => {
    const registered = registerCampaign(root, SCHEDULE());
    expect(registered).toEqual({ ok: true, value: { registered: 2 } });

    const scheduleLines = readFileSync(scheduleFile(), 'utf8').trimEnd().split('\n');
    expect(scheduleLines.map((l) => JSON.parse(l).attemptId)).toEqual(['att-0', 'att-1']);
    for (const id of ['att-0', 'att-1']) {
      const read = readJournal(root, id);
      expect(read.ok).toBe(true);
      if (!read.ok) continue;
      expect(read.value.identity.attemptId).toBe(id);
      expect(read.value.state).toBe('registered');
      expect(read.value.entries).toEqual([]);
    }

    const running = appendTransition(root, 'att-0', 'running', data());
    expect(running.ok).toBe(true);
    if (running.ok) expect(running.value.seq).toBe(1);
    const lines = readFileSync(journalFile('att-0'), 'utf8').split('\n');
    expect(JSON.parse(lines[0]).identity.attemptId).toBe('att-0');
    expect(JSON.parse(lines[1]).state).toBe('running');
    expect(lines[2]).toBe('');
  });

  test('directories are 0700, files are 0600, and an identical re-register is a no-op', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    for (const dir of [root, join(root, 'campaigns'), join(root, 'campaigns', EXPERIMENT), join(root, 'attempts')]) {
      expect(mode(dir)).toBe(0o700);
    }
    expect(mode(join(root, 'attempts', 'att-0'))).toBe(0o700);
    expect(mode(scheduleFile())).toBe(0o600);
    expect(mode(journalFile('att-0'))).toBe(0o600);

    expect(appendTransition(root, 'att-0', 'running', data()).ok).toBe(true);
    const scheduleBefore = readFileSync(scheduleFile());
    const journalBefore = readFileSync(journalFile('att-0'));
    expect(registerCampaign(root, SCHEDULE())).toEqual({ ok: true, value: { registered: 2 } });
    expect(readFileSync(scheduleFile()).equals(scheduleBefore)).toBe(true);
    expect(readFileSync(journalFile('att-0')).equals(journalBefore)).toBe(true);
  });
});

describe('transitions', () => {
  test('an edge ATTEMPT_TRANSITIONS does not allow is refused and leaves the journal byte-identical', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    const before = readFileSync(journalFile('att-0'));
    const skipped = appendTransition(root, 'att-0', 'verified', data());
    expect(skipped.ok).toBe(false);
    if (!skipped.ok) expect(skipped.issues.join('\n')).toContain('illegal transition registered -> verified');
    expect(readFileSync(journalFile('att-0')).equals(before)).toBe(true);

    expect(appendTransition(root, 'att-0', 'running', data()).ok).toBe(true);
    const afterRunning = readFileSync(journalFile('att-0'));
    expect(appendTransition(root, 'att-0', 'running', data()).ok).toBe(false);
    expect(readFileSync(journalFile('att-0')).equals(afterRunning)).toBe(true);
  });

  test('accepted transitions append one line each with an increasing seq', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    const seqs: number[] = [];
    for (const to of ['running', 'execution-stopped', 'verified'] as const) {
      const r = appendTransition(root, 'att-0', to, data());
      expect(r.ok).toBe(true);
      if (r.ok) seqs.push(r.value.seq);
    }
    expect(seqs).toEqual([1, 2, 3]);
    expect(readFileSync(journalFile('att-0'), 'utf8').split('\n')).toHaveLength(5);
  });
});

describe('corrupt and torn lines fail closed', () => {
  test('a torn last line is reported with its raw text; identity stays readable; the file is byte-identical', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    expect(appendTransition(root, 'att-0', 'running', data()).ok).toBe(true);
    const torn = '{"seq":2,"at":"2026-10-14T00:00:00.000Z","monoto';
    appendFileSync(journalFile('att-0'), torn);
    const before = readFileSync(journalFile('att-0'));

    const read = readJournal(root, 'att-0');
    expect(readFileSync(journalFile('att-0')).equals(before)).toBe(true);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.identity).toEqual(identity('att-0'));
    expect(read.value.state).toBe('running');
    expect(read.value.entries.map((e) => e.seq)).toEqual([1]);
    expect(read.value.corrupt).toHaveLength(1);
    expect(read.value.corrupt[0].line).toBe(3);
    expect(read.value.corrupt[0].raw).toBe(torn);
    expect(read.value.corrupt[0].reason).toContain('torn');
  });

  test('a corrupt middle line is reported with its raw text; later good entries still count; bytes unchanged', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    expect(appendTransition(root, 'att-0', 'running', data()).ok).toBe(true);
    appendFileSync(journalFile('att-0'), 'garbage \u0000 not json\n');
    expect(appendTransition(root, 'att-0', 'execution-stopped', data()).ok).toBe(true);
    const before = readFileSync(journalFile('att-0'));

    const read = readJournal(root, 'att-0');
    expect(readFileSync(journalFile('att-0')).equals(before)).toBe(true);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.identity).toEqual(identity('att-0'));
    expect(read.value.entries.map((e) => e.state)).toEqual(['running', 'execution-stopped']);
    expect(read.value.state).toBe('execution-stopped');
    expect(read.value.corrupt).toEqual([{ line: 3, reason: 'not valid JSON', raw: 'garbage \u0000 not json' }]);
  });
});

describe('single supervisor', () => {
  test('a second acquireSupervisor is refused naming the holder pid, and the lock is not touched', () => {
    const first = acquireSupervisor(root);
    expect(first.ok).toBe(true);
    const lockBefore = readFileSync(join(root, 'supervisor.lock'));
    expect(mode(join(root, 'supervisor.lock'))).toBe(0o600);

    const second = acquireSupervisor(root);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      const text = second.issues.join('\n');
      expect(text).toContain('refused');
      expect(text).toContain(`pid ${process.pid}`);
      expect(text).toContain('live');
    }
    expect(readFileSync(join(root, 'supervisor.lock')).equals(lockBefore)).toBe(true);

    if (first.ok) first.value.release();
    expect(existsSync(join(root, 'supervisor.lock'))).toBe(false);
    const third = acquireSupervisor(root);
    expect(third.ok).toBe(true);
    if (third.ok) third.value.release();
  });
});

describe('recovery after a killed supervisor', () => {
  test('an interrupted running attempt recovers to terminal-failure/interrupted with an unchanged scheduled count', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    const before = campaignStatus(root, EXPERIMENT);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.scheduled).toBe(2);

    // A real supervisor process takes the lock, appends `running`, and is SIGKILLed before its next step.
    const script = join(root, '..', 'killed-supervisor.ts');
    writeFileSync(
      script,
      [
        `import { acquireSupervisor, appendTransition } from ${JSON.stringify(join(import.meta.dir, 'ledger.ts'))};`,
        `const root = ${JSON.stringify(root)};`,
        'const lock = acquireSupervisor(root);',
        'if (!lock.ok) process.exit(3);',
        "const r = appendTransition(root, 'att-0', 'running', { at: new Date().toISOString(), monotonicNs: '1', evidence: [] });",
        'if (!r.ok) process.exit(4);',
        "process.kill(process.pid, 'SIGKILL');",
      ].join('\n'),
    );
    const child = Bun.spawnSync([process.execPath, script], { env: { ...process.env, GENIE_HOME: genieHome } });
    expect(child.signalCode).toBe('SIGKILL');

    // The dead holder's lock is reported as stale, by pid, and never stolen.
    const lockBefore = readFileSync(join(root, 'supervisor.lock'));
    const relock = acquireSupervisor(root);
    expect(relock.ok).toBe(false);
    if (!relock.ok) {
      expect(relock.issues.join('\n')).toContain(`pid ${child.pid}`);
      expect(relock.issues.join('\n')).toContain('STALE');
    }
    expect(readFileSync(join(root, 'supervisor.lock')).equals(lockBefore)).toBe(true);

    const afterKill = campaignStatus(root, EXPERIMENT);
    expect(afterKill.ok).toBe(true);
    if (!afterKill.ok) return;
    expect(afterKill.value.scheduled).toBe(2);
    expect(afterKill.value.byState.running).toBe(1);
    expect(afterKill.value.byState.registered).toBe(1);

    const read = readJournal(root, 'att-0');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(planRecovery(read.value)).toBe('record-interrupted');
    const recovered = appendTransition(root, 'att-0', 'terminal-failure', data({ disposition: 'interrupted' }));
    expect(recovered.ok).toBe(true);

    const afterRecovery = campaignStatus(root, EXPERIMENT);
    expect(afterRecovery.ok).toBe(true);
    if (!afterRecovery.ok) return;
    expect(afterRecovery.value.scheduled).toBe(2);
    expect(afterRecovery.value.byState['terminal-failure']).toBe(1);
    expect(afterRecovery.value.byState.running).toBe(0);
    expect(afterRecovery.value.byDisposition.interrupted).toBe(1);
    expect(afterRecovery.value.byDisposition.none).toBe(1);

    const reread = readJournal(root, 'att-0');
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(planRecovery(reread.value)).toBe('seal-capture');
  });

  test('planRecovery never restarts: registered and sealed states need no action', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    const read = readJournal(root, 'att-1');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(planRecovery(read.value)).toBe('none');
    expect(planRecovery({ ...read.value, state: 'execution-stopped' })).toBe('verify-collected-artifact');
    expect(planRecovery({ ...read.value, state: 'capture-sealed' })).toBe('none');
  });
});

describe('identity mismatch on reopen', () => {
  test('re-registering a campaign with different content is refused and the schedule is not overwritten', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    const before = readFileSync(scheduleFile());
    const changed = [identity('att-0', { configId: 'config-b' }), identity('att-1', { arm: 'zero-genie' })];
    const result = registerCampaign(root, changed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('different content');
    expect(readFileSync(scheduleFile()).equals(before)).toBe(true);
  });

  test('a journal holding a different identity is refused and not overwritten', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    const journalBefore = readFileSync(journalFile('att-0'));
    const other = [identity('att-0', { experimentId: 'exp-2', taskKey: 'deepswe/lint/task-b' })];
    const result = registerCampaign(root, other);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('identity mismatch');
    expect(readFileSync(journalFile('att-0')).equals(journalBefore)).toBe(true);
    expect(existsSync(join(root, 'campaigns', 'exp-2'))).toBe(false);
  });

  test('a journal whose header names another attempt is refused on read and on append', () => {
    expect(registerCampaign(root, SCHEDULE()).ok).toBe(true);
    mkdirSync(join(root, 'attempts', 'att-9'), { mode: 0o700 });
    const copied = readFileSync(journalFile('att-0'));
    writeFileSync(journalFile('att-9'), copied, { mode: 0o600 });

    const read = readJournal(root, 'att-9');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.issues.join('\n')).toContain('identity mismatch');
    expect(appendTransition(root, 'att-9', 'running', data()).ok).toBe(false);
    expect(readFileSync(journalFile('att-9')).equals(copied)).toBe(true);
  });
});
