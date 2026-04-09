import { describe, expect, test } from 'bun:test';
import { buildOmniSpawnParams, sanitizeWindowName } from './claude-code.js';

describe('sanitizeWindowName', () => {
  // --- Without chatName (fallback to JID) ---
  test('WhatsApp DM: always uses phone number', () => {
    expect(sanitizeWindowName('5512982298888@s.whatsapp.net')).toBe('wa-5512982298888');
  });

  test('WhatsApp DM: ignores chatName, always phone', () => {
    expect(sanitizeWindowName('5512982298888@s.whatsapp.net', 'Felipe Rosa')).toBe('wa-5512982298888');
  });

  test('WhatsApp group without name: uses group ID', () => {
    expect(sanitizeWindowName('120363422699972298@g.us')).toBe('grp-120363422699972298');
  });

  test('WhatsApp group with name: uses chat name', () => {
    expect(sanitizeWindowName('120363422699972298@g.us', 'NMSTX leadership')).toBe('grp-NMSTXleadership');
  });

  test('LID without name: uses lid-id', () => {
    expect(sanitizeWindowName('54958418317348@lid')).toBe('lid-54958418317348');
  });

  test('LID with name: uses wa- prefix + contact name', () => {
    expect(sanitizeWindowName('54958418317348@lid', 'Felipe Rosa')).toBe('wa-FelipeRosa');
  });

  // --- Determinism ---
  test('same chatId always produces same name (no sender dependency)', () => {
    const id = '120363422699972298@g.us';
    // Without chatName, always deterministic from JID
    expect(sanitizeWindowName(id)).toBe(sanitizeWindowName(id));
  });

  test('different DM numbers produce different names', () => {
    const a = sanitizeWindowName('5511999999999@s.whatsapp.net');
    const b = sanitizeWindowName('5511888888888@s.whatsapp.net');
    expect(a).not.toBe(b);
  });

  // --- Edge cases ---
  test('fallback: unknown format uses chat- prefix', () => {
    expect(sanitizeWindowName('user@domain.com/resource')).toBe('chat-userdomain.comresource');
  });

  test('empty string returns chat-unknown', () => {
    expect(sanitizeWindowName('')).toBe('chat-unknown');
  });

  test('similar JIDs with different numbers do not collide', () => {
    const names = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const jid = `55119${String(i).padStart(8, '0')}@s.whatsapp.net`;
      names.add(sanitizeWindowName(jid));
    }
    expect(names.size).toBe(100);
  });

  test('output is path-safe — no slashes, dots, or colons', () => {
    const names = [
      sanitizeWindowName('5512982298888@s.whatsapp.net'),
      sanitizeWindowName('120363422699972298@g.us', 'Test Group'),
      sanitizeWindowName('54958418317348@lid', 'Felipe'),
      sanitizeWindowName('some-weird-id'),
    ];
    for (const name of names) {
      expect(name).not.toMatch(/[\/.:]/);
    }
  });

  test('long chat name is truncated to 30 chars', () => {
    const longName = 'A'.repeat(50);
    const result = sanitizeWindowName('120363422699972298@g.us', longName);
    // "grp-" prefix + 30 chars max
    expect(result.length).toBeLessThanOrEqual(34);
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

  test('injects turn-based prompt into initialPrompt (not systemPrompt)', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {
      OMNI_INSTANCE: 'inst-1',
      OMNI_SENDER_NAME: 'Stefani',
    });
    // Turn context goes in initialPrompt, not systemPrompt
    expect(params.systemPrompt).toBeUndefined();
    expect(params.initialPrompt).toContain('WhatsApp Turn');
    expect(params.initialPrompt).toContain('Stefani');
    expect(params.initialPrompt).toContain('inst-1');
    expect(params.initialPrompt).toContain('chat123');
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

  test('passes initialMessage appended to turn context in initialPrompt', () => {
    const params = buildOmniSpawnParams(
      'simone',
      'chat123',
      fakeEntry,
      {
        OMNI_INSTANCE: 'inst-1',
        OMNI_SENDER_NAME: 'Stefani',
      },
      'Hello!',
    );
    expect(params.initialPrompt).toContain('WhatsApp Turn');
    expect(params.initialPrompt).toContain('Hello!');
    // User message comes after separator
    expect(params.initialPrompt).toContain('---\n\nHello!');
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
