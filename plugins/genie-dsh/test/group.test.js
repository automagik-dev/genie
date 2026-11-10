// grant_wish asked in a group: the group goes to startTask as `roomId` only when, as read at
// that moment, that does not make the wish run wider than it does today. Real git,
// temporary folders. The team here is a stand-in: what the Bot team does with a `roomId`
// afterwards (its own apply, later level changes) is not exercised.
//
// src/host/level.js is a copy of how the Bot team ranks levels, and these tests pin that
// copy, not the team. The originals are in automagik-dev/automagik, apps/bots-dsh:
//   src/host/permission-rank.js    rankOf: sandbox * 2 + approval, unrankable is undefined
//   src/shared/permission-levels.js  AUTO ('auto') and AUTO_FALLBACK ('workspace-write')
//   src/host/permissions.js        taskLevel (room.permission ?? bot.permission ?? default
//                                  with a roomId), narrowedByCaller (levelRoomId), applyLevel
//                                  (Auto falls back when it cannot be set)
//   src/host/agents.js             startTask: a roomId means no levelRoomId
// A change to any of those is a reason to read level.js and these cases again. Nothing
// here fails when they change: this header is a note, not a guard.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { groupNotWider } from '../src/host/level.js';
import { compose, fakeTeam as makeTeam } from './team.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-dsh-'));
  process.env.GENIE_WISHES_DIR = join(dir, 'wishes');
});
afterEach(() => {
  Reflect.deleteProperty(process.env, 'GENIE_WISHES_DIR');
  rmSync(dir, { recursive: true, force: true });
});

// DSH's stock presets, and Auto as its layer serves it: the full sandbox, every step asked.
const SPECS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'workspace-never': { sandbox: 'workspace-write', approval: 'never' },
  'full-access': { sandbox: 'danger-full-access', approval: 'never' },
  auto: { sandbox: 'danger-full-access', approval: 'ask' },
  odd: { sandbox: 'somewhere', approval: 'ask' },
};
/** A permissionPresets service: `offered` are the catalog's levels, the rest resolve as unknown. */
function presetsOf({ offered = Object.keys(SPECS), defaultPreset = 'workspace-write' } = {}) {
  return {
    catalog: () => ({ options: offered.map((value) => ({ value })), defaultPreset }),
    resolve: (name) => {
      if (!offered.includes(name) || SPECS[name] === undefined) throw new Error(`unknown preset "${name}"`);
      return SPECS[name];
    },
  };
}

const WISH = { title: 'Add a README', wish: 'Write a README that says hello.' };
const GROUP_SESSION = 'group-session-1';

/**
 * A Genie with `own` as its level, asked for a wish from `from` (its own chat by default).
 * `room` is the group's record, `presets` the service; resolves the argument startTask got.
 */
async function startedWith({ own, room, presets = presetsOf(), from = GROUP_SESSION, groups, rooms } = {}) {
  const team = makeTeam(dir, {
    groups: groups === null ? undefined : (groups ?? { [GROUP_SESSION]: { botId: 'bot-1', roomId: 'room-1' } }),
    rooms: rooms === null ? undefined : (rooms ?? { 'room-1': room }),
  });
  const { rt, tools } = compose(team, { presets: presets ?? undefined });
  await rt.genieReady;
  const genie = Object.values(team.state.bots)[0];
  assert.equal(genie.id, 'bot-1');
  if (own !== undefined) genie.permission = own;
  const answer = await tools.get('grant_wish').execute(WISH, { agent: { id: from ?? genie.id } });
  assert.match(answer, /granted as a thread on branch wish\/add-a-readme/);
  assert.equal(team.record.tasks.length, 1);
  assert.equal(team.record.tasks[0].from, genie.id);
  return team.record.tasks[0];
}

test('asked in a group whose level is narrower than Genie’s, the wish is given that group', async () => {
  const task = await startedWith({ own: 'full-access', room: { id: 'room-1', permission: 'read-only' } });
  assert.equal(task.roomId, 'room-1');
});

test('asked in a group at the same level as Genie, the wish is given that group', async () => {
  const task = await startedWith({ own: 'workspace-write', room: { id: 'room-1', permission: 'workspace-write' } });
  assert.equal(task.roomId, 'room-1');
});

test('asked in a group with no level of its own, the wish is given that group and keeps Genie’s level', async () => {
  // Nothing has to be ranked: no presets service is needed.
  const task = await startedWith({ own: 'read-only', room: { id: 'room-1' }, presets: null });
  assert.equal(task.roomId, 'room-1');
});

test('a group whose level is null has none: the wish is given that group', async () => {
  const task = await startedWith({ own: 'read-only', room: { id: 'room-1', permission: null }, presets: null });
  assert.equal(task.roomId, 'room-1');
});

test('asked in a group whose level is wider than Genie’s, the wish is given no group, as today', async () => {
  const task = await startedWith({ own: 'read-only', room: { id: 'room-1', permission: 'full-access' } });
  assert.equal(Object.hasOwn(task, 'roomId'), false);
});

test('from Genie’s own chat the start is asked exactly as before: no group', async () => {
  const task = await startedWith({ own: 'full-access', room: { id: 'room-1', permission: 'read-only' }, from: null });
  assert.deepEqual(Object.keys(task), ['title', 'text', 'from', 'cwd', 'agentPreset']);
});

test('a Genie with no level of its own is compared by the catalog default', async () => {
  const room = { id: 'room-1', permission: 'workspace-write' };
  const narrow = await startedWith({ room, presets: presetsOf({ defaultPreset: 'read-only' }) });
  assert.equal(Object.hasOwn(narrow, 'roomId'), false, 'the default is narrower than the group');
});

test('a Genie with no level and a default as wide as the group gets the group', async () => {
  const room = { id: 'room-1', permission: 'workspace-write' };
  const same = await startedWith({ room, presets: presetsOf({ defaultPreset: 'workspace-write' }) });
  assert.equal(same.roomId, 'room-1');
});

test('an empty saved Genie level gives no group despite a full-access default', async () => {
  const task = await startedWith({
    own: '',
    room: { id: 'room-1', permission: 'workspace-write' },
    presets: presetsOf({ defaultPreset: 'full-access' }),
  });
  assert.equal(Object.hasOwn(task, 'roomId'), false);
});

test('an absent Genie level uses the full-access default and gets the group', async () => {
  const task = await startedWith({
    room: { id: 'room-1', permission: 'workspace-write' },
    presets: presetsOf({ defaultPreset: 'full-access' }),
  });
  assert.equal(task.roomId, 'room-1');
});

test('nothing proven, no group: no presets service, a level that cannot be ranked, a group the team does not know', async (t) => {
  const cases = {
    'no presets service': { own: 'full-access', room: { id: 'room-1', permission: 'read-only' }, presets: null },
    'a group level that left the catalog': { own: 'full-access', room: { id: 'room-1', permission: 'gone' } },
    'a group level with an unknown sandbox': { own: 'full-access', room: { id: 'room-1', permission: 'odd' } },
    'a Genie level that left the catalog': { own: 'gone', room: { id: 'room-1', permission: 'read-only' } },
    // Loaded state is not normalized: the team would take '' in place of Genie's level and set nothing.
    'a group whose saved level is the empty string': { own: 'read-only', room: { id: 'room-1', permission: '' } },
    'a group whose saved level is not a string': { own: 'read-only', room: { id: 'room-1', permission: 0 } },
    'a group with no record': { own: 'full-access', rooms: {} },
    'a team without roomOf': { own: 'full-access', rooms: null },
    'a team without groupOwners (an older Bot team)': { own: 'full-access', groups: null, from: null },
  };
  for (const [name, options] of Object.entries(cases)) {
    await t.test(name, async () => {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'genie-dsh-'));
      process.env.GENIE_WISHES_DIR = join(dir, 'wishes');
      const task = await startedWith(options);
      assert.equal(Object.hasOwn(task, 'roomId'), false);
    });
  }
});

// ---- level.js on its own: every pair, ranked as the Bot team ranks them ----

test('a group is not wider only when it ranks at or below the Bot: sandbox first, then approval', () => {
  const service = presetsOf();
  const order = ['read-only', 'workspace-write', 'workspace-never', 'full-access'];
  for (const [b, bot] of order.entries()) {
    for (const [g, group] of order.entries()) {
      assert.equal(groupNotWider(service, bot, group), g <= b, `Bot ${bot}, group ${group}`);
    }
  }
});

test('Auto counts as everything it may run as: the Bot’s by its fallback, the group’s by Auto itself', () => {
  const service = presetsOf();
  // A Bot in Auto may run as workspace-write (Auto could not be set): only a group at or
  // below that is proven. workspace-write/never ranks below Auto but above the fallback.
  assert.equal(groupNotWider(service, 'auto', 'read-only'), true);
  assert.equal(groupNotWider(service, 'auto', 'workspace-write'), true);
  assert.equal(groupNotWider(service, 'auto', 'workspace-never'), false);
  assert.equal(groupNotWider(service, 'auto', 'auto'), false);
  assert.equal(groupNotWider(service, 'auto', 'full-access'), false);
  // A group in Auto may run as Auto: only a Bot at or above Auto is proven.
  assert.equal(groupNotWider(service, 'full-access', 'auto'), true);
  assert.equal(groupNotWider(service, 'workspace-never', 'auto'), false);
  assert.equal(groupNotWider(service, 'workspace-write', 'auto'), false);
});

test('an Auto DSH does not offer is ranked as its fallback on both sides', () => {
  const service = presetsOf({ offered: ['read-only', 'workspace-write', 'workspace-never', 'full-access'] });
  assert.equal(groupNotWider(service, 'workspace-write', 'auto'), true);
  assert.equal(groupNotWider(service, 'read-only', 'auto'), false);
  assert.equal(groupNotWider(service, 'auto', 'workspace-write'), true);
  assert.equal(groupNotWider(service, 'auto', 'workspace-never'), false);
  // Without the fallback preset itself, Auto cannot be ranked at all.
  const bare = presetsOf({ offered: ['read-only', 'full-access'], defaultPreset: 'read-only' });
  assert.equal(groupNotWider(bare, 'auto', 'read-only'), false);
  assert.equal(groupNotWider(bare, 'full-access', 'auto'), false);
});

test('what cannot be read or ranked is never proof', () => {
  const service = presetsOf();
  assert.equal(groupNotWider(service, 'full-access', 'odd'), false);
  assert.equal(groupNotWider(service, 'odd', 'read-only'), false);
  assert.equal(groupNotWider(service, 'full-access', 'gone'), false);
  assert.equal(groupNotWider(service, 'full-access', undefined), false);
  assert.equal(groupNotWider(presetsOf({ defaultPreset: null }), undefined, 'read-only'), false);
  assert.equal(groupNotWider(presetsOf({ defaultPreset: 'full-access' }), undefined, 'workspace-never'), true);
  const broken = {
    catalog: () => {
      throw new Error('no catalog');
    },
    resolve: () => SPECS['read-only'],
  };
  assert.equal(groupNotWider(broken, 'full-access', 'read-only'), false);
  assert.equal(groupNotWider({}, 'full-access', 'read-only'), false);
});
