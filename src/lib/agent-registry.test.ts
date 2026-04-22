import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type Agent,
  addSubPane,
  filterBySession,
  findByPane,
  findByTask,
  findByWindow,
  findOrCreateAgent,
  get,
  getAgent,
  getAgentByName,
  getAgentEffectiveState,
  getElapsedTime,
  getPane,
  getTeamLeadEntry,
  list,
  listAgents,
  listTemplates,
  reconcileStaleSpawns,
  register,
  removeSubPane,
  saveTemplate,
  setCurrentExecutor,
  unregister,
  update,
} from './agent-registry.js';
import {
  completeAssignment,
  createAssignment,
  getActiveAssignment,
  getAssignment,
  getExecutorAssignments,
  getTaskHistory,
} from './assignment-registry.js';
import { getConnection } from './db.js';
import {
  createExecutor,
  findExecutorByPane,
  findExecutorBySession,
  getCurrentExecutor,
  getExecutor,
  listExecutors,
  terminateActiveExecutor,
  terminateExecutor,
  updateExecutorState,
} from './executor-registry.js';
import { DB_AVAILABLE, setupTestSchema } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    cleanup = await setupTestSchema();
  });
  afterAll(async () => {
    await cleanup();
  });
  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM assignments`;
    await sql`DELETE FROM executors`;
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

    // Regression: cross-team id collision must not silently adopt the stale
    // row. Pre-fix behaviour was `ON CONFLICT (id) DO UPDATE` leaving `team`
    // untouched, so a new spawn in team B re-using an id that still lived in
    // team A silently inherited team=A. Effect in prod: engineer anchors from
    // a dead team resumed into a new team's worktree while their PG `team`
    // field stayed stale, team-lead messaging went to the wrong leader, and
    // wish_groups never transitioned from ready→in_progress.
    test('register rejects cross-team id collision', async () => {
      // Seed: id=engineer-2 lives in team docs-drift-omni-v2.
      await register(
        makeAgent({
          id: 'engineer-2',
          paneId: '%67',
          team: 'docs-drift-omni-v2',
          role: 'engineer-2',
          customName: 'engineer-2',
        }),
      );

      // A different team (genie-serve-obs) must NOT be able to re-register
      // the same id without a team override — that would silently inherit
      // team=docs-drift-omni-v2 via the ON CONFLICT clause.
      let threw = false;
      try {
        await register(
          makeAgent({
            id: 'engineer-2',
            paneId: '%99',
            team: 'genie-serve-obs',
            role: 'engineer-2',
            customName: 'engineer-2',
          }),
        );
      } catch (err) {
        threw = true;
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toMatch(/team|cross-team|collision/i);
      }
      expect(threw).toBe(true);

      // And crucially the stale row's team stays intact — the aborted
      // re-register must not have partially mutated the row.
      const existing = (await get('engineer-2'))!;
      expect(existing.team).toBe('docs-drift-omni-v2');
    });

    test('register allows same-team re-register (pane/session refresh)', async () => {
      // Same team, same id: this is the legitimate "resume in place" pattern
      // (e.g. engineer-2 crashed, pane %99 is dead, new pane %100 reclaims
      // the same id under the same team). Must still work post-fix.
      await register(
        makeAgent({
          id: 'engineer-2',
          paneId: '%99',
          team: 'genie-serve-obs',
          role: 'engineer-2',
        }),
      );
      await register(
        makeAgent({
          id: 'engineer-2',
          paneId: '%100',
          team: 'genie-serve-obs',
          role: 'engineer-2',
          state: 'idle',
        }),
      );
      const row = (await get('engineer-2'))!;
      expect(row.team).toBe('genie-serve-obs');
      expect(row.paneId).toBe('%100');
      expect(row.state).toBe('idle');
    });

    test('register allows team=null → set team (legacy upgrade path)', async () => {
      // Pre-team-aware rows exist with team=null. First register that sets
      // a team must succeed, not be rejected as "cross-team" (null is not a
      // team).
      await register(makeAgent({ id: 'legacy-1', team: undefined }));
      await register(
        makeAgent({
          id: 'legacy-1',
          paneId: '%17',
          team: 'alpha',
          role: 'engineer',
        }),
      );
      const row = (await get('legacy-1'))!;
      expect(row.team).toBe('alpha');
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

  describe('reconcileStaleSpawns', () => {
    test('resets stuck spawning agents with no pane', async () => {
      // Agent stuck: spawning, no pane, started >2s ago
      const oldStart = new Date(Date.now() - 5_000).toISOString();
      await register(makeAgent({ id: 'stuck-1', paneId: '', state: 'spawning', startedAt: oldStart }));
      await register(makeAgent({ id: 'stuck-2', paneId: '', state: 'spawning', startedAt: oldStart }));

      // Use 2s threshold for test speed (production uses 60s)
      const reset = await reconcileStaleSpawns(2);
      expect(reset.sort()).toEqual(['stuck-1', 'stuck-2']);

      const a1 = await get('stuck-1');
      expect(a1!.state).toBe('error');
      const a2 = await get('stuck-2');
      expect(a2!.state).toBe('error');
    });

    test('resets spawning agents with a dead pane', async () => {
      // This test requires a reachable tmux server so isPaneAlive() can return
      // "false" for a non-existent pane (%42). When tmux is unreachable
      // (e.g. CI without a server), isPaneAlive() throws TmuxUnreachableError
      // and reconcileStaleSpawns deliberately skips the agent — a production
      // safety feature that prevents false-positive resets during tmux blips.
      // Skip the assertion in that environment rather than failing on a
      // condition the reconciler is intentionally defensive about.
      const { isPaneAlive } = await import('./tmux.js');
      try {
        await isPaneAlive('%1');
      } catch {
        return; // tmux server unreachable — nothing to assert
      }

      const oldStart = new Date(Date.now() - 5_000).toISOString();
      // pane %42 does not exist in test env, so isPaneAlive returns false
      await register(makeAgent({ id: 'has-pane', paneId: '%42', state: 'spawning', startedAt: oldStart }));

      const reset = await reconcileStaleSpawns(2);
      expect(reset).toEqual(['has-pane']);

      const a = await get('has-pane');
      expect(a!.state).toBe('error');
    });

    test('does not touch recently spawning agents', async () => {
      // Just now — should not be reset even with 2s threshold
      await register(makeAgent({ id: 'recent', paneId: '', state: 'spawning' }));

      const reset = await reconcileStaleSpawns(2);
      expect(reset).toEqual([]);

      const a = await get('recent');
      expect(a!.state).toBe('spawning');
    });

    test('does not touch non-spawning agents', async () => {
      const oldStart = new Date(Date.now() - 5_000).toISOString();
      await register(makeAgent({ id: 'working-agent', paneId: '', state: 'working', startedAt: oldStart }));

      const reset = await reconcileStaleSpawns(2);
      expect(reset).toEqual([]);

      const a = await get('working-agent');
      expect(a!.state).toBe('working');
    });

    test('returns empty array when nothing to reconcile', async () => {
      const reset = await reconcileStaleSpawns(2);
      expect(reset).toEqual([]);
    });

    test('does not touch identity records with current_executor_id', async () => {
      // Identity record created by findOrCreateAgent — has executor linked
      const agent = await findOrCreateAgent('id-eng', 'id-team', 'engineer');
      const exec = await createExecutor(agent.id, 'claude', 'tmux', { repoPath: '/tmp' });
      await setCurrentExecutor(agent.id, exec.id);

      // Backdate started_at so it would match the threshold
      const sql = await getConnection();
      await sql`UPDATE agents SET started_at = now() - interval '10 seconds' WHERE id = ${agent.id}`;

      const reset = await reconcileStaleSpawns(2);
      expect(reset).not.toContain(agent.id);
    });

    test('does not touch directory identity rows (dir:%)', async () => {
      // Directory rows (id prefix `dir:`) are identity records inserted by
      // directory.add(). Pre-fix, the INSERT omitted `state` so PG applied
      // the column DEFAULT 'spawning' and the reconciler flipped every row
      // to 'error' ~60s after every `genie serve` boot (first-pass match:
      // spawning + no pane + no executor + old). The reconciler now skips
      // `dir:%` ids unconditionally so legacy rows (and any forgetful
      // future caller) are safe. This test guards that invariant.
      const sql = await getConnection();
      const oldStart = new Date(Date.now() - 10_000).toISOString();
      await sql`
        INSERT INTO agents (id, role, custom_name, started_at, state, pane_id, current_executor_id)
        VALUES ('dir:legacy-poisoned', 'legacy-poisoned', 'legacy-poisoned', ${oldStart}, 'spawning', '', ${null})
      `;

      const reset = await reconcileStaleSpawns(2);
      expect(reset).not.toContain('dir:legacy-poisoned');

      // Row still exists, still `spawning` — reconciler ignored it.
      const [row] = await sql<{ state: string | null }[]>`
        SELECT state FROM agents WHERE id = 'dir:legacy-poisoned'
      `;
      expect(row?.state).toBe('spawning');
    });

    test('flips idle+dead-pane rows to error (auto-resume-zombie-cap fix)', async () => {
      // This is Change #3 of the auto-resume-zombie-cap fix: idle/working
      // rows whose tmux pane is dead must be flipped to 'error' so they
      // stop inflating the scheduler concurrency cap.
      const { isPaneAlive } = await import('./tmux.js');
      try {
        await isPaneAlive('%1');
      } catch {
        return; // tmux server unreachable — nothing to assert
      }

      const oldChange = new Date(Date.now() - 5_000).toISOString();
      // pane %42 does not exist → isPaneAlive returns false
      await register(
        makeAgent({
          id: 'zombie-idle',
          paneId: '%42',
          state: 'idle',
          startedAt: oldChange,
          lastStateChange: oldChange,
        }),
      );
      await register(
        makeAgent({
          id: 'zombie-working',
          paneId: '%43',
          state: 'working',
          startedAt: oldChange,
          lastStateChange: oldChange,
        }),
      );

      const reset = await reconcileStaleSpawns(2);
      expect(reset).toContain('zombie-idle');
      expect(reset).toContain('zombie-working');

      const a1 = await get('zombie-idle');
      expect(a1!.state).toBe('error');
      const a2 = await get('zombie-working');
      expect(a2!.state).toBe('error');
    });

    test('does not touch idle rows whose pane is still alive', async () => {
      // Only dead-pane rows should be GC'd. Live-pane idle rows are
      // genuinely idle (e.g. between tasks) and must not be touched.
      // Since we can't easily mock a live pane in this DB test, we use
      // a recent last_state_change (under the threshold) as a proxy —
      // the reconciler must also respect the time threshold.
      const recent = new Date().toISOString();
      await register(
        makeAgent({
          id: 'fresh-idle',
          paneId: '%99',
          state: 'idle',
          startedAt: recent,
          lastStateChange: recent,
        }),
      );

      const reset = await reconcileStaleSpawns(2);
      expect(reset).not.toContain('fresh-idle');

      const a = await get('fresh-idle');
      expect(a!.state).toBe('idle');
    });

    test('skips non-tmux (synthetic) paneIds in dead-pane pass', async () => {
      // SDK/inline transports have paneIds like 'sdk', 'inline', '' — the
      // regex `^%[0-9]+$` must NOT match those, so they are skipped here
      // (their liveness is tracked by executor state, not tmux).
      const oldChange = new Date(Date.now() - 5_000).toISOString();
      await register(
        makeAgent({
          id: 'sdk-worker',
          paneId: 'sdk',
          state: 'working',
          startedAt: oldChange,
          lastStateChange: oldChange,
        }),
      );

      const reset = await reconcileStaleSpawns(2);
      expect(reset).not.toContain('sdk-worker');

      const a = await get('sdk-worker');
      expect(a!.state).toBe('working');
    });

    test('flips workers registered on a dead socket to error (Bug 4)', async () => {
      // Bug 4 repro: workers recorded on a tmux socket that no longer exists
      // were stuck in 'idle'/'working' forever because reconcileStaleSpawns
      // catches the TmuxUnreachableError from isPaneAlive and skips the worker.
      // After the fix, a dead socket is detected once up-front and every
      // worker on it is transitioned to 'error' with pane_id cleared.
      //
      // We pick a socket name that we can guarantee does NOT exist under
      // /tmp/tmux-<uid>/ — any random UUID works.
      const deadSocketName = `genie-dead-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      process.env.GENIE_TMUX_SOCKET = deadSocketName;
      try {
        const oldChange = new Date(Date.now() - 5_000).toISOString();
        await register(
          makeAgent({
            id: 'dead-socket-worker-1',
            paneId: '%9999',
            state: 'idle',
            startedAt: oldChange,
            lastStateChange: oldChange,
          }),
        );
        await register(
          makeAgent({
            id: 'dead-socket-worker-2',
            paneId: '%9998',
            state: 'working',
            startedAt: oldChange,
            lastStateChange: oldChange,
          }),
        );

        const reset = await reconcileStaleSpawns(2);
        expect(reset).toContain('dead-socket-worker-1');
        expect(reset).toContain('dead-socket-worker-2');

        const a1 = await get('dead-socket-worker-1');
        expect(a1!.state).toBe('error');
        expect(a1!.paneId).toBe('');
        const a2 = await get('dead-socket-worker-2');
        expect(a2!.state).toBe('error');
        expect(a2!.paneId).toBe('');
      } finally {
        // biome-ignore lint/performance/noDelete: assigning undefined would set the string "undefined"
        delete process.env.GENIE_TMUX_SOCKET;
      }
    });

    test('dead socket reconciliation preserves existing behavior on live sockets', async () => {
      // Sanity check: when the tmux socket DOES exist AND the server is
      // actually accepting commands, the dead-socket fast path must not
      // fire — workers must go through the normal per-pane isPaneAlive
      // check (which remains transient-blip-safe).
      //
      // The reconciler's reachability probe (`isTmuxServerReachable`, added
      // 2026-04-21) actually talks to the server (`tmux -L <sock>
      // list-sessions`) instead of just `existsSync` on the socket file, so
      // a zero-byte placeholder no longer counts as "live". We spin up a
      // real tmux server on a throwaway socket to exercise the live branch.
      const { execSync, spawnSync } = await import('node:child_process');
      const stubSocketName = `genie-live-real-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      try {
        spawnSync('tmux', ['-L', stubSocketName, 'new-session', '-d', '-s', 'probe'], {
          stdio: 'ignore',
          timeout: 3000,
        });
      } catch {
        // tmux missing → skip gracefully (CI sandbox without tmux).
        return;
      }
      process.env.GENIE_TMUX_SOCKET = stubSocketName;
      try {
        // A fresh (recent) idle row: must NOT be reset because the socket
        // is alive AND lastStateChange is inside the threshold. This
        // exercises the preserved transient-retry path.
        await register(
          makeAgent({
            id: 'live-socket-fresh-idle',
            paneId: '%8888',
            state: 'idle',
            lastStateChange: new Date().toISOString(),
          }),
        );
        const reset = await reconcileStaleSpawns(2);
        expect(reset).not.toContain('live-socket-fresh-idle');
        const a = await get('live-socket-fresh-idle');
        expect(a!.state).toBe('idle');
      } finally {
        // biome-ignore lint/performance/noDelete: assigning undefined would set the string "undefined"
        delete process.env.GENIE_TMUX_SOCKET;
        try {
          execSync(`tmux -L ${stubSocketName} kill-server`, { stdio: 'ignore' });
        } catch {
          /* best-effort cleanup */
        }
      }
    });

    test('flips workers on a zombie socket (file exists, server dead) to error (2026-04-21 regression)', async () => {
      // Repro for the "genie agent spawn crashes with no server running" bug
      // we shipped on dev on 2026-04-21: when tmux dies ungracefully it leaves
      // its socket file on disk. `isTmuxSocketAlive` (pure existsSync) reports
      // the socket as live, the reconciler tries to probe panes, every probe
      // throws `TmuxUnreachableError`, nothing is ever reset. After the fix
      // the reconciler uses `isTmuxServerReachable` which actually talks to
      // the server, so the dead-socket fast path fires.
      const { writeFileSync, unlinkSync } = await import('node:fs');
      const { execSync, spawnSync } = await import('node:child_process');
      const uid = process.getuid?.() ?? 501;
      const zombieSocketName = `genie-zombie-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
      const zombiePath = `/tmp/tmux-${uid}/${zombieSocketName}`;
      // Start + immediately kill a real tmux server to produce a socket file
      // that a live server is NOT listening on. Plain `writeFileSync` would
      // also work but using real tmux proves the scenario end-to-end.
      try {
        spawnSync('tmux', ['-L', zombieSocketName, 'new-session', '-d', '-s', 'z'], {
          stdio: 'ignore',
          timeout: 3000,
        });
        execSync(`tmux -L ${zombieSocketName} kill-server`, { stdio: 'ignore' });
      } catch {
        return; // tmux missing → skip
      }
      // Recreate the socket file if tmux removed it on kill-server (it does).
      try {
        writeFileSync(zombiePath, '');
      } catch {
        /* may fail if path doesn't exist; the test just won't trigger the bug */
      }
      process.env.GENIE_TMUX_SOCKET = zombieSocketName;
      try {
        const oldChange = new Date(Date.now() - 5_000).toISOString();
        await register(
          makeAgent({
            id: 'zombie-socket-worker',
            paneId: '%7777',
            state: 'working',
            startedAt: oldChange,
            lastStateChange: oldChange,
          }),
        );
        const reset = await reconcileStaleSpawns(2);
        expect(reset).toContain('zombie-socket-worker');
        const a = await get('zombie-socket-worker');
        expect(a!.state).toBe('error');
        expect(a!.paneId).toBe('');
      } finally {
        // biome-ignore lint/performance/noDelete: assigning undefined would set the string "undefined"
        delete process.env.GENIE_TMUX_SOCKET;
        try {
          unlinkSync(zombiePath);
        } catch {
          /* best-effort */
        }
      }
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

  // ==========================================================================
  // Identity-Focused API (Executor Model v4)
  // ==========================================================================

  describe('findOrCreateAgent', () => {
    test('creates new agent', async () => {
      const agent = await findOrCreateAgent('engineer', 'alpha', 'engineer');
      expect(agent.customName).toBe('engineer');
      expect(agent.team).toBe('alpha');
      expect(agent.role).toBe('engineer');
      expect(agent.id).toBeTruthy();
      expect(agent.currentExecutorId).toBeNull();
    });
    test('returns existing agent on duplicate name+team', async () => {
      const a1 = await findOrCreateAgent('engineer', 'alpha', 'engineer');
      const a2 = await findOrCreateAgent('engineer', 'alpha', 'engineer');
      expect(a1.id).toBe(a2.id);
    });
    test('different teams create different agents', async () => {
      const a1 = await findOrCreateAgent('engineer', 'alpha');
      const a2 = await findOrCreateAgent('engineer', 'beta');
      expect(a1.id).not.toBe(a2.id);
    });
  });

  describe('getAgent / getAgentByName', () => {
    test('getAgent by ID', async () => {
      const created = await findOrCreateAgent('reviewer', 'alpha');
      const fetched = await getAgent(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.customName).toBe('reviewer');
    });
    test('getAgent returns null for missing', async () => {
      expect(await getAgent('nonexistent')).toBeNull();
    });
    test('getAgentByName', async () => {
      await findOrCreateAgent('qa', 'beta', 'qa');
      const fetched = await getAgentByName('qa', 'beta');
      expect(fetched).not.toBeNull();
      expect(fetched!.role).toBe('qa');
    });
    test('getAgentByName returns null for missing', async () => {
      expect(await getAgentByName('ghost', 'nowhere')).toBeNull();
    });
  });

  describe('setCurrentExecutor', () => {
    test('sets and clears FK', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux', { repoPath: '/tmp' });

      await setCurrentExecutor(agent.id, exec.id);
      expect((await getAgent(agent.id))!.currentExecutorId).toBe(exec.id);

      await setCurrentExecutor(agent.id, null);
      expect((await getAgent(agent.id))!.currentExecutorId).toBeNull();
    });
  });

  describe('getAgentEffectiveState', () => {
    test('returns executor state', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux', { state: 'working' });
      await setCurrentExecutor(agent.id, exec.id);

      expect(await getAgentEffectiveState(agent.id)).toBe('working');
    });
    test('returns offline when no executor', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      expect(await getAgentEffectiveState(agent.id)).toBe('offline');
    });
  });

  describe('listAgents', () => {
    test('lists all', async () => {
      await findOrCreateAgent('a', 'team1', 'engineer');
      await findOrCreateAgent('b', 'team1', 'reviewer');
      await findOrCreateAgent('c', 'team2', 'engineer');
      expect((await listAgents()).length).toBe(3);
    });
    test('filters by team', async () => {
      await findOrCreateAgent('a', 'team1', 'engineer');
      await findOrCreateAgent('b', 'team2', 'engineer');
      expect((await listAgents({ team: 'team1' })).length).toBe(1);
    });
    test('filters by role', async () => {
      await findOrCreateAgent('a', 'team1', 'engineer');
      await findOrCreateAgent('b', 'team1', 'reviewer');
      expect((await listAgents({ role: 'reviewer' })).length).toBe(1);
    });
    test('filters by team+role', async () => {
      await findOrCreateAgent('a', 'team1', 'engineer');
      await findOrCreateAgent('b', 'team1', 'reviewer');
      await findOrCreateAgent('c', 'team2', 'engineer');
      expect((await listAgents({ team: 'team1', role: 'engineer' })).length).toBe(1);
    });

    test('excludes archived rows by default (issue #1215)', async () => {
      const archived = await findOrCreateAgent('stale', 'disbanded-team', 'engineer');
      const live = await findOrCreateAgent('fresh', 'active-team', 'engineer');

      // Flip the disbanded row to archived (mirrors archiveTeam/disbandTeam path)
      const sql = await getConnection();
      await sql`UPDATE agents SET state = 'archived' WHERE id = ${archived.id}`;

      const names = (await listAgents()).map((a) => a.id);
      expect(names).toContain(live.id);
      expect(names).not.toContain(archived.id);

      // Filter variants must also exclude archived by default
      expect((await listAgents({ team: 'disbanded-team' })).length).toBe(0);
      expect((await listAgents({ role: 'engineer' })).map((a) => a.id)).not.toContain(archived.id);
      expect((await listAgents({ team: 'disbanded-team', role: 'engineer' })).length).toBe(0);
    });

    test('includeArchived=true surfaces archived rows for audit', async () => {
      const archived = await findOrCreateAgent('stale', 'disbanded-team', 'engineer');
      const live = await findOrCreateAgent('fresh', 'active-team', 'engineer');

      const sql = await getConnection();
      await sql`UPDATE agents SET state = 'archived' WHERE id = ${archived.id}`;

      const ids = (await listAgents({ includeArchived: true })).map((a) => a.id);
      expect(ids).toContain(live.id);
      expect(ids).toContain(archived.id);

      // Team scope + includeArchived returns the orphan
      expect((await listAgents({ team: 'disbanded-team', includeArchived: true })).length).toBe(1);
    });
  });

  // ==========================================================================
  // Executor Registry
  // ==========================================================================

  describe('executor-registry', () => {
    test('createExecutor and getExecutor', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux', {
        pid: 12345,
        tmuxSession: 'genie',
        tmuxPaneId: '%10',
        repoPath: '/tmp/repo',
        metadata: { model: 'opus' },
      });

      expect(exec.agentId).toBe(agent.id);
      expect(exec.provider).toBe('claude');
      expect(exec.transport).toBe('tmux');
      expect(exec.pid).toBe(12345);
      expect(exec.tmuxPaneId).toBe('%10');
      expect(exec.state).toBe('spawning');
      expect(exec.metadata).toEqual({ model: 'opus' });

      const fetched = await getExecutor(exec.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(exec.id);
    });

    test('getExecutor returns null for missing', async () => {
      expect(await getExecutor('nonexistent')).toBeNull();
    });

    test('getCurrentExecutor', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux');
      await setCurrentExecutor(agent.id, exec.id);

      const current = await getCurrentExecutor(agent.id);
      expect(current).not.toBeNull();
      expect(current!.id).toBe(exec.id);
    });

    test('getCurrentExecutor returns null when no current', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      expect(await getCurrentExecutor(agent.id)).toBeNull();
    });

    test('updateExecutorState', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux');

      await updateExecutorState(exec.id, 'working');
      expect((await getExecutor(exec.id))!.state).toBe('working');

      await updateExecutorState(exec.id, 'done');
      const done = (await getExecutor(exec.id))!;
      expect(done.state).toBe('done');
      expect(done.endedAt).not.toBeNull();
    });

    test('terminateExecutor', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux', { state: 'working' });

      await terminateExecutor(exec.id);
      const terminated = (await getExecutor(exec.id))!;
      expect(terminated.state).toBe('terminated');
      expect(terminated.endedAt).not.toBeNull();
    });

    test('terminateExecutor is idempotent', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux', { state: 'terminated' });
      await terminateExecutor(exec.id); // should not throw
    });

    test('terminateActiveExecutor', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux', { state: 'working' });
      await setCurrentExecutor(agent.id, exec.id);

      await terminateActiveExecutor(agent.id);

      expect((await getExecutor(exec.id))!.state).toBe('terminated');
      expect((await getAgent(agent.id))!.currentExecutorId).toBeNull();
    });

    test('terminateActiveExecutor no-op when no current', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      await terminateActiveExecutor(agent.id); // should not throw
    });

    test('listExecutors', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      await createExecutor(agent.id, 'claude', 'tmux');
      await createExecutor(agent.id, 'claude', 'tmux');

      const all = await listExecutors();
      expect(all.length).toBe(2);

      const byAgent = await listExecutors(agent.id);
      expect(byAgent.length).toBe(2);
    });

    test('findExecutorByPane', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      await createExecutor(agent.id, 'claude', 'tmux', { tmuxPaneId: '%42' });

      expect((await findExecutorByPane('%42'))!.tmuxPaneId).toBe('%42');
      expect((await findExecutorByPane('42'))!.tmuxPaneId).toBe('%42');
      expect(await findExecutorByPane('%999')).toBeNull();
    });

    test('findExecutorBySession', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      await createExecutor(agent.id, 'claude', 'tmux', { claudeSessionId: 'sess-abc' });

      expect((await findExecutorBySession('sess-abc'))!.claudeSessionId).toBe('sess-abc');
      expect(await findExecutorBySession('sess-nonexistent')).toBeNull();
    });
  });

  // ==========================================================================
  // Assignment Registry
  // ==========================================================================

  describe('assignment-registry', () => {
    test('createAssignment and getAssignment', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux');
      const assignment = await createAssignment(exec.id, 'task-1', 'my-wish', 3);

      expect(assignment.executorId).toBe(exec.id);
      expect(assignment.taskId).toBe('task-1');
      expect(assignment.wishSlug).toBe('my-wish');
      expect(assignment.groupNumber).toBe(3);
      expect(assignment.endedAt).toBeNull();
      expect(assignment.outcome).toBeNull();

      const fetched = await getAssignment(assignment.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(assignment.id);
    });

    test('completeAssignment', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux');
      const assignment = await createAssignment(exec.id, 'task-1');

      await completeAssignment(assignment.id, 'completed');
      const completed = (await getAssignment(assignment.id))!;
      expect(completed.outcome).toBe('completed');
      expect(completed.endedAt).not.toBeNull();
    });

    test('getActiveAssignment', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux');

      // No assignment yet
      expect(await getActiveAssignment(exec.id)).toBeNull();

      const a1 = await createAssignment(exec.id, 'task-1');
      expect((await getActiveAssignment(exec.id))!.id).toBe(a1.id);

      // Complete it — no active anymore
      await completeAssignment(a1.id, 'completed');
      expect(await getActiveAssignment(exec.id)).toBeNull();
    });

    test('getTaskHistory', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec1 = await createExecutor(agent.id, 'claude', 'tmux');
      const exec2 = await createExecutor(agent.id, 'claude', 'tmux');

      await createAssignment(exec1.id, 'task-1');
      await createAssignment(exec2.id, 'task-1');

      const history = await getTaskHistory('task-1');
      expect(history.length).toBe(2);
    });

    test('getExecutorAssignments', async () => {
      const agent = await findOrCreateAgent('eng', 'team1');
      const exec = await createExecutor(agent.id, 'claude', 'tmux');

      await createAssignment(exec.id, 'task-1');
      await createAssignment(exec.id, 'task-2');

      const assignments = await getExecutorAssignments(exec.id);
      expect(assignments.length).toBe(2);
    });
  });
});
