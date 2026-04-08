import { describe, expect, test } from 'bun:test';
import { buildOmniSpawnParams, sanitizeWindowName } from './claude-code.js';

describe('sanitizeWindowName', () => {
  test('WhatsApp DM: number@s.whatsapp.net → whatsapp/number', () => {
    expect(sanitizeWindowName('5512982298888@s.whatsapp.net')).toBe('whatsapp/5512982298888');
  });

  test('WhatsApp group: id@g.us → group/id', () => {
    expect(sanitizeWindowName('120363422699972298@g.us')).toBe('group/120363422699972298');
  });

  test('LID format: id@lid → lid/id', () => {
    expect(sanitizeWindowName('54958418317348@lid')).toBe('lid/54958418317348');
  });

  test('different DM numbers produce different names', () => {
    const a = sanitizeWindowName('5511999999999@s.whatsapp.net');
    const b = sanitizeWindowName('5511888888888@s.whatsapp.net');
    expect(a).not.toBe(b);
    expect(a).toBe('whatsapp/5511999999999');
    expect(b).toBe('whatsapp/5511888888888');
  });

  test('identical inputs produce identical output', () => {
    const id = '5511999999999@s.whatsapp.net';
    expect(sanitizeWindowName(id)).toBe(sanitizeWindowName(id));
  });

  test('fallback: unknown format uses chat/ prefix', () => {
    expect(sanitizeWindowName('user@domain.com/resource')).toBe('chat/userdomain.comresource');
  });

  test('empty string returns chat/unknown', () => {
    expect(sanitizeWindowName('')).toBe('chat/unknown');
  });

  test('similar JIDs with different numbers do not collide', () => {
    const names = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const jid = `55119${String(i).padStart(8, '0')}@s.whatsapp.net`;
      names.add(sanitizeWindowName(jid));
    }
    expect(names.size).toBe(100);
  });

  test('no special characters break tmux window naming', () => {
    const names = [
      sanitizeWindowName('5512982298888@s.whatsapp.net'),
      sanitizeWindowName('120363422699972298@g.us'),
      sanitizeWindowName('54958418317348@lid'),
      sanitizeWindowName('some-weird-id'),
    ];
    for (const name of names) {
      // tmux window names must not contain dots or colons
      expect(name).not.toMatch(/[.:]/);
    }
  });
});

describe('buildOmniSpawnParams', () => {
  const fakeEntry = {
    name: 'simone',
    dir: '/home/genie/agents/simone',
    promptMode: 'append' as const,
    model: 'opus',
    color: 'pink',
    registeredAt: '2026-01-01T00:00:00Z',
  };

  test('returns provider claude by default', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {});
    expect(params.provider).toBe('claude');
  });

  test('sets team and role to agentName', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {});
    expect(params.team).toBe('simone');
    expect(params.role).toBe('simone');
  });

  test('includes systemPromptFile pointing to AGENTS.md', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {});
    expect(params.systemPromptFile).toBe('/home/genie/agents/simone/AGENTS.md');
  });

  test('injects turn-based prompt as systemPrompt', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {
      OMNI_INSTANCE: 'inst-1',
      OMNI_SENDER_NAME: 'Stefani',
    });
    expect(params.systemPrompt).toContain('WhatsApp Turn-Based Conversation');
    expect(params.systemPrompt).toContain('Stefani');
    expect(params.systemPrompt).toContain('inst-1');
    expect(params.systemPrompt).toContain('chat123');
  });

  test('enables nativeTeam with agent name and color', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {});
    expect(params.nativeTeam?.enabled).toBe(true);
    expect(params.nativeTeam?.agentName).toBe('simone');
    expect(params.nativeTeam?.color).toBe('pink');
  });

  test('passes model from directory entry', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {});
    expect(params.model).toBe('opus');
  });

  test('passes initialMessage as initialPrompt', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {}, 'Hello!');
    expect(params.initialPrompt).toBe('Hello!');
  });

  test('generates a sessionId', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {});
    expect(params.sessionId).toBeDefined();
    expect(params.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('uses entry.provider when set', () => {
    const entryWithProvider = { ...fakeEntry, provider: 'codex' };
    const params = buildOmniSpawnParams('simone', 'chat123', entryWithProvider, {});
    expect(params.provider).toBe('codex');
  });
});
