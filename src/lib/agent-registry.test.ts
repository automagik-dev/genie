import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Agent,
  addSubPane,
  filterBySession,
  findByPane,
  findByTask,
  findByWindow,
  get,
  getElapsedTime,
  getPane,
  getTeamLeadEntry,
  list,
  listTemplates,
  register,
  removeSubPane,
  saveTemplate,
  unregister,
  update,
} from './agent-registry.js';
import { getConnection } from './db.js';
import { setupTestSchema } from './test-db.js';

let cleanup: () => Promise<void>;
beforeAll(async () => {
  cleanup = await setupTestSchema();
});
afterAll(async () => {
  await cleanup();
});
beforeEach(async () => {
  const sql = await getConnection();
  await sql`DELETE FROM agents`;
  await sql`DELETE FROM agent_templates`;
});

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'bd-42',
    paneId: '%17',
    session: 'genie',
    worktree: null,
    taskId: 'bd-42',
    startedAt: new Date().toISOString(),
    state: 'working',
    lastStateChange: new Date().toISOString(),
    repoPath: '/tmp/test',
    ...overrides,
  };
}

describe('register and get', () => {
  test('register creates agent, get retrieves it', async () => {
    await register(makeAgent());
    const f = await get('bd-42');
    expect(f).not.toBeNull();
    expect(f!.id).toBe('bd-42');
    expect(f!.paneId).toBe('%17');
    expect(f!.state).toBe('working');
  });
  test('get returns null for non-existent', async () => {
    expect(await get('nope')).toBeNull();
  });
  test('paneColor stored', async () => {
    await register(makeAgent({ paneColor: '#ff0000' }));
    expect((await get('bd-42'))!.paneColor).toBe('#ff0000');
  });
});

describe('list', () => {
  test('list returns all', async () => {
    await register(makeAgent({ id: 'a1', paneId: '%1' }));
    await register(makeAgent({ id: 'a2', paneId: '%2' }));
    const a = await list();
    expect(a.length).toBe(2);
    expect(a.map((x) => x.id).sort()).toEqual(['a1', 'a2']);
  });
  test('list returns empty', async () => {
    expect(await list()).toEqual([]);
  });
});

describe('unregister', () => {
  test('removes agent', async () => {
    await register(makeAgent());
    await unregister('bd-42');
    expect(await get('bd-42')).toBeNull();
  });
  test('no-op for ghost', async () => {
    await unregister('ghost');
  });
});

describe('update', () => {
  test('changes fields', async () => {
    await register(makeAgent());
    await update('bd-42', { state: 'idle', role: 'reviewer' });
    const f = await get('bd-42');
    expect(f!.state).toBe('idle');
    expect(f!.role).toBe('reviewer');
  });
  test('state sets lastStateChange', async () => {
    await register(makeAgent());
    const before = new Date().toISOString();
    await update('bd-42', { state: 'done' });
    const f = await get('bd-42');
    expect(f!.state).toBe('done');
    expect(f!.lastStateChange >= before).toBe(true);
  });
  test('empty is no-op', async () => {
    await register(makeAgent());
    await update('bd-42', {});
    expect((await get('bd-42'))!.state).toBe('working');
  });
});

describe('filterBySession', () => {
  test('filters', async () => {
    await register(makeAgent({ id: 'a1', paneId: '%1', session: 'sa' }));
    await register(makeAgent({ id: 'a2', paneId: '%2', session: 'sb' }));
    await register(makeAgent({ id: 'a3', paneId: '%3', session: 'sa' }));
    expect((await filterBySession('sa')).length).toBe(2);
  });
});

describe('find functions', () => {
  test('findByPane', async () => {
    await register(makeAgent({ paneId: '%42' }));
    expect((await findByPane('%42'))!.paneId).toBe('%42');
  });
  test('findByPane normalizes', async () => {
    await register(makeAgent({ paneId: '%42' }));
    expect(await findByPane('42')).not.toBeNull();
  });
  test('findByPane null', async () => {
    expect(await findByPane('%999')).toBeNull();
  });
  test('findByWindow', async () => {
    await register(makeAgent({ windowId: '@4' }));
    expect((await findByWindow('@4'))!.windowId).toBe('@4');
  });
  test('findByWindow null', async () => {
    expect(await findByWindow('@999')).toBeNull();
  });
  test('findByTask', async () => {
    await register(makeAgent({ taskId: 'task-77' }));
    expect((await findByTask('task-77'))!.taskId).toBe('task-77');
  });
  test('findByTask null', async () => {
    expect(await findByTask('task-unknown')).toBeNull();
  });
});

describe('getElapsedTime', () => {
  test('formats', () => {
    const e = getElapsedTime(makeAgent({ startedAt: new Date(Date.now() - 3600000).toISOString() }));
    expect(e.formatted).toBe('1h 0m');
  });
  test('<1m', () => {
    expect(getElapsedTime(makeAgent()).formatted).toBe('<1m');
  });
});

describe('addSubPane', () => {
  test('appends', async () => {
    await register(makeAgent());
    await addSubPane('bd-42', '%22');
    expect((await get('bd-42'))!.subPanes).toEqual(['%22']);
  });
  test('appends to existing', async () => {
    await register(makeAgent({ subPanes: ['%22'] }));
    await addSubPane('bd-42', '%23');
    expect((await get('bd-42'))!.subPanes).toEqual(['%22', '%23']);
  });
  test('no-op ghost', async () => {
    await addSubPane('ghost', '%99');
  });
});

describe('getPane', () => {
  test('index 0', async () => {
    await register(makeAgent());
    expect(await getPane('bd-42', 0)).toBe('%17');
  });
  test('index 1', async () => {
    await register(makeAgent({ subPanes: ['%22', '%23'] }));
    expect(await getPane('bd-42', 1)).toBe('%22');
  });
  test('out-of-range', async () => {
    await register(makeAgent({ subPanes: ['%22'] }));
    expect(await getPane('bd-42', 5)).toBeNull();
  });
  test('ghost', async () => {
    expect(await getPane('ghost', 0)).toBeNull();
  });
});

describe('removeSubPane', () => {
  test('removes', async () => {
    await register(makeAgent({ subPanes: ['%22', '%23', '%24'] }));
    await removeSubPane('bd-42', '%23');
    expect((await get('bd-42'))!.subPanes).toEqual(['%22', '%24']);
  });
  test('ghost', async () => {
    await removeSubPane('ghost', '%99');
  });
});

describe('getTeamLeadEntry', () => {
  test('legacy ID', async () => {
    await register(makeAgent({ id: 'team-lead:my-team', role: 'team-lead', team: 'my-team' }));
    const f = await getTeamLeadEntry('my-team');
    expect(f).not.toBeNull();
    expect(f!.id).toBe('team-lead:my-team');
  });
  test('role+team', async () => {
    await register(makeAgent({ id: 'some-id', role: 'team-lead', team: 'alpha' }));
    expect((await getTeamLeadEntry('alpha'))!.team).toBe('alpha');
  });
  test('by session', async () => {
    await register(makeAgent({ id: 'tl-1', role: 'team-lead', team: 'beta', session: 'sess-1' }));
    expect(await getTeamLeadEntry('beta', 'sess-1')).not.toBeNull();
  });
  test('null', async () => {
    expect(await getTeamLeadEntry('no-such-team')).toBeNull();
  });
});

describe('templates', () => {
  test('save and list', async () => {
    await saveTemplate({
      id: 'tpl-1',
      provider: 'claude',
      team: 'alpha',
      role: 'engineer',
      cwd: '/tmp/repo',
      lastSpawnedAt: new Date().toISOString(),
    });
    const t = await listTemplates();
    expect(t.length).toBe(1);
    expect(t[0].id).toBe('tpl-1');
  });
  test('upserts', async () => {
    await saveTemplate({
      id: 'tpl-1',
      provider: 'claude',
      team: 'alpha',
      cwd: '/tmp/repo',
      lastSpawnedAt: new Date().toISOString(),
    });
    await saveTemplate({
      id: 'tpl-1',
      provider: 'codex',
      team: 'beta',
      cwd: '/tmp/repo2',
      lastSpawnedAt: new Date().toISOString(),
    });
    const t = await listTemplates();
    expect(t.length).toBe(1);
    expect(t[0].provider).toBe('codex');
  });
});

describe('paneColor', () => {
  test('persists', async () => {
    await register(makeAgent({ paneColor: '#abcdef' }));
    expect((await get('bd-42'))!.paneColor).toBe('#abcdef');
  });
  test('updates', async () => {
    await register(makeAgent());
    await update('bd-42', { paneColor: '#123456' });
    expect((await get('bd-42'))!.paneColor).toBe('#123456');
  });
});
