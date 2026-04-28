import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import type * as registryTypes from '../lib/agent-registry.js';
import type { NativeInboxMessage, NativeTeamConfig } from '../lib/claude-native-teams.js';
import * as nativeTeams from '../lib/claude-native-teams.js';
import * as mailbox from '../lib/mailbox.js';
import type { RuntimeEvent } from '../lib/runtime-events.js';
import * as runtimeEvents from '../lib/runtime-events.js';
import * as taskService from '../lib/task-service.js';
import * as teamManager from '../lib/team-manager.js';
import { handleBroadcast, registerSendInboxCommands } from './msg.js';

type BroadcastDeps = NonNullable<Parameters<typeof handleBroadcast>[2]>;
type AgentIdentity = Awaited<ReturnType<typeof registryTypes.listAgents>>[number];

interface NativeWrite {
  team: string;
  agent: string;
  message: NativeInboxMessage;
}

interface CapturedBroadcastEvent {
  repoPath: string;
  subject: string;
  event: Parameters<NonNullable<BroadcastDeps['publishSubjectEvent']>>[2];
}

function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
}

function agent(name: string, stateId = name): AgentIdentity {
  return {
    id: stateId,
    startedAt: '2026-04-28T00:00:00.000Z',
    customName: name,
    team: 'fix-team',
    currentExecutorId: `exec-${stateId}`,
  };
}

function nativeConfig(
  team: string,
  members: Array<{ name: string; isActive?: boolean; color?: string }>,
): NativeTeamConfig {
  return {
    name: sanitizeTeamName(team),
    createdAt: 1,
    leadAgentId: `team-lead@${sanitizeTeamName(team)}`,
    leadSessionId: 'session-1',
    members: members.map((member) => ({
      agentId: `${sanitizeTeamName(member.name)}@${sanitizeTeamName(team)}`,
      name: sanitizeTeamName(member.name),
      agentType: 'worker',
      joinedAt: 1,
      backendType: 'tmux' as const,
      color: member.color ?? 'blue',
      planModeRequired: false,
      isActive: member.isActive ?? true,
    })),
  };
}

function conversationRow(id = 'conv-1'): Awaited<ReturnType<typeof taskService.findOrCreateConversation>> {
  return {
    id,
    parentMessageId: null,
    name: 'Team: fix-team',
    type: 'group',
    linkedEntity: 'team',
    linkedEntityId: 'fix-team',
    createdByType: 'local',
    createdById: 'team-lead',
    metadata: {},
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
  };
}

function messageRow(id = 101): Awaited<ReturnType<typeof taskService.sendMessage>> {
  return {
    id,
    conversationId: 'conv-1',
    replyToId: null,
    senderType: 'local',
    senderId: 'team-lead',
    body: 'wake up',
    metadata: {},
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
  };
}

function conversationMemberRow(
  conversationId = 'conv-1',
  actorId = 'team-lead',
): Awaited<ReturnType<typeof taskService.addMember>> {
  return {
    conversationId,
    actorType: 'local',
    actorId,
    role: 'member',
    joinedAt: '2026-04-28T00:00:00.000Z',
  };
}

function runtimeEvent(
  repoPath: string,
  subject: string,
  event: Parameters<NonNullable<BroadcastDeps['publishSubjectEvent']>>[2],
): RuntimeEvent {
  return {
    id: 1,
    repoPath,
    timestamp: '2026-04-28T00:00:00.000Z',
    kind: event.kind,
    agent: event.agent,
    team: event.team,
    direction: event.direction,
    peer: event.peer,
    text: event.text,
    data: event.data,
    source: event.source,
    subject,
  };
}

function makeBroadcastHarness(opts: {
  agents: AgentIdentity[];
  states?: Record<string, Awaited<ReturnType<typeof registryTypes.getAgentEffectiveState>>>;
  config?: NativeTeamConfig | null;
}): {
  deps: BroadcastDeps;
  writes: NativeWrite[];
  events: CapturedBroadcastEvent[];
} {
  const writes: NativeWrite[] = [];
  const events: CapturedBroadcastEvent[] = [];
  const deps: BroadcastDeps = {
    repoPath: '/tmp/repo',
    now: () => new Date('2026-04-28T12:00:00.000Z'),
    taskService: {
      findOrCreateConversation: async () => conversationRow(),
      addMember: async (_conversationId, actor) => conversationMemberRow('conv-1', actor.actorId),
      sendMessage: async () => messageRow(),
    },
    registry: {
      listAgents: async (filters) => opts.agents.filter((a) => a.team === filters?.team),
      getAgentEffectiveState: async (agentId) => opts.states?.[agentId] ?? 'idle',
    },
    nativeTeams: {
      loadConfig: async () => opts.config ?? null,
      sanitizeTeamName,
      writeNativeInbox: async (team, agentName, message) => {
        writes.push({ team, agent: agentName, message });
      },
    },
    publishSubjectEvent: async (repoPath, subject, event) => {
      events.push({ repoPath, subject, event });
      return runtimeEvent(repoPath, subject, event);
    },
  };
  return { deps, writes, events };
}

function captureConsoleLogs(): string[] {
  const lines: string[] = [];
  spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  });
  return lines;
}

describe('genie broadcast native inbox fan-out', () => {
  afterEach(() => {
    mock.restore();
  });

  test('delivers to N-1 live members, unions native config fallback, and emits recipients audit', async () => {
    const logs = captureConsoleLogs();
    const { deps, writes, events } = makeBroadcastHarness({
      agents: [agent('team-lead'), agent('engineer')],
      config: nativeConfig('fix-team', [{ name: 'team-lead' }, { name: 'engineer' }, { name: 'reviewer' }]),
    });

    const result = await handleBroadcast('wake up', { from: 'team-lead', team: 'fix-team' }, deps);

    expect(writes.map((w) => w.agent)).toEqual(['engineer', 'reviewer']);
    expect(result.recipients).toEqual([
      { agent: 'engineer', delivered: true },
      { agent: 'reviewer', delivered: true },
    ]);
    expect(events.length).toBe(1);
    expect(events[0].subject).toBe('genie.msg.broadcast');
    expect(events[0].event.team).toBe('fix-team');
    expect(events[0].event.data?.recipients).toEqual(result.recipients);
    expect(logs[0]).toBe('Broadcast sent to team "fix-team" (delivered to 2 of 2 members).');
  });

  test('self-broadcast exits cleanly with no recipients', async () => {
    const logs = captureConsoleLogs();
    const { deps, writes, events } = makeBroadcastHarness({
      agents: [agent('team-lead')],
      config: nativeConfig('fix-team', [{ name: 'team-lead' }]),
    });

    const result = await handleBroadcast('note to self', { from: 'team-lead', team: 'fix-team' }, deps);

    expect(writes).toEqual([]);
    expect(result.recipients).toEqual([]);
    expect(events[0].event.data?.recipients).toEqual([]);
    expect(logs[0]).toBe('Broadcast sent to team "fix-team" (delivered to 0 of 0 members).');
  });

  test('skips terminated and offline members with audit reasons', async () => {
    captureConsoleLogs();
    const { deps, writes, events } = makeBroadcastHarness({
      agents: [agent('team-lead'), agent('live'), agent('term'), agent('off')],
      states: { live: 'idle', term: 'terminated', off: 'offline' },
      config: nativeConfig('fix-team', [{ name: 'team-lead' }, { name: 'live' }, { name: 'term' }, { name: 'off' }]),
    });

    const result = await handleBroadcast('wake up', { from: 'team-lead', team: 'fix-team' }, deps);

    expect(writes.map((w) => w.agent)).toEqual(['live']);
    expect(result.recipients).toEqual([
      { agent: 'live', delivered: true },
      { agent: 'term', delivered: false, reason: 'terminated' },
      { agent: 'off', delivered: false, reason: 'offline' },
    ]);
    expect(events[0].event.data?.recipients).toEqual(result.recipients);
  });

  test('audits native inbox write failures without aborting other recipients', async () => {
    captureConsoleLogs();
    const writes: NativeWrite[] = [];
    const { deps } = makeBroadcastHarness({
      agents: [agent('team-lead'), agent('engineer'), agent('reviewer')],
      config: nativeConfig('fix-team', [{ name: 'team-lead' }, { name: 'engineer' }, { name: 'reviewer' }]),
    });
    deps.nativeTeams!.writeNativeInbox = async (team, agentName, message) => {
      if (agentName === 'engineer') throw new Error('disk full');
      writes.push({ team, agent: agentName, message });
    };

    const result = await handleBroadcast('wake up', { from: 'team-lead', team: 'fix-team' }, deps);

    expect(writes.map((w) => w.agent)).toEqual(['reviewer']);
    expect(result.recipients).toEqual([
      { agent: 'engineer', delivered: false, reason: 'disk full' },
      { agent: 'reviewer', delivered: true },
    ]);
  });
});

describe('genie send native inbox bridge regression', () => {
  afterEach(() => {
    mock.restore();
  });

  test('direct message still writes only the addressed local native surface', async () => {
    const writes: NativeWrite[] = [];
    spyOn(teamManager, 'listTeams').mockResolvedValue([]);
    spyOn(taskService, 'findOrCreateConversation').mockResolvedValue(conversationRow('dm-1'));
    spyOn(taskService, 'addMember').mockImplementation(async (conversationId, actor) =>
      conversationMemberRow(conversationId, actor.actorId),
    );
    spyOn(taskService, 'sendMessage').mockResolvedValue({
      ...messageRow(202),
      conversationId: 'dm-1',
      senderId: 'alice',
    });
    spyOn(mailbox, 'send').mockResolvedValue({
      id: 'mail-1',
      from: 'alice',
      to: 'bob',
      body: 'hello',
      createdAt: '2026-04-28T00:00:00.000Z',
      read: false,
      deliveredAt: null,
      source: 'agent',
      meta: {},
    });
    spyOn(mailbox, 'markDelivered').mockResolvedValue(true);
    spyOn(runtimeEvents, 'publishSubjectEvent').mockResolvedValue(
      runtimeEvent('/tmp/repo', 'genie.msg.bob', {
        kind: 'message',
        agent: 'alice',
        direction: 'out',
        peer: 'bob',
        text: 'hello',
        data: {},
        source: 'mailbox',
      }),
    );
    spyOn(nativeTeams, 'resolveNativeMemberName').mockResolvedValue('bob');
    spyOn(nativeTeams, 'writeNativeInbox').mockImplementation(async (team, agentName, message) => {
      writes.push({ team, agent: agentName, message });
    });

    captureConsoleLogs();
    const program = new Command();
    registerSendInboxCommands(program);

    await program.parseAsync(['send', 'hello', '--to', 'bob', '--from', 'alice', '--team', 'fix-team'], {
      from: 'user',
    });

    expect(writes.map((w) => w.agent)).toEqual(['bob']);
    expect(writes[0].team).toBe('fix-team');
  });
});
