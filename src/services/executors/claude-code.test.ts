import { describe, expect, test } from 'bun:test';
import { buildOmniSpawnParams, resolveBridgeTmuxSession, sanitizeWindowName } from './claude-code.js';

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

  test('propagates entry.permissions.allow/deny for turn-sandbox enforcement', () => {
    const entryWithPermissions = {
      ...fakeEntry,
      permissions: {
        allow: ['Bash(omni say *)', 'Bash(omni done)'],
        deny: ['Bash(omni chats *)', 'Bash(rm *)'],
      },
    };
    const params = buildOmniSpawnParams('simone', 'chat123', entryWithPermissions, {});
    expect(params.permissions?.allow).toEqual(['Bash(omni say *)', 'Bash(omni done)']);
    expect(params.permissions?.deny).toEqual(['Bash(omni chats *)', 'Bash(rm *)']);
  });

  test('propagates entry.disallowedTools', () => {
    const entryWithTools = {
      ...fakeEntry,
      disallowedTools: ['Edit', 'Write', 'Agent'],
    };
    const params = buildOmniSpawnParams('simone', 'chat123', entryWithTools, {});
    expect(params.disallowedTools).toEqual(['Edit', 'Write', 'Agent']);
  });

  test('omits permissions when entry has none (no false sense of security)', () => {
    const params = buildOmniSpawnParams('simone', 'chat123', fakeEntry, {});
    expect(params.permissions).toBeUndefined();
    expect(params.disallowedTools).toBeUndefined();
  });

  test('omits permissions when allow/deny are empty arrays', () => {
    const entryWithEmpty = {
      ...fakeEntry,
      permissions: { allow: [], deny: [] },
    };
    const params = buildOmniSpawnParams('simone', 'chat123', entryWithEmpty, {});
    expect(params.permissions).toBeUndefined();
  });

  test('ignores SDK-only preset/bashAllowPatterns (CLI path uses allow/deny only)', () => {
    const entryWithSdkFields = {
      ...fakeEntry,
      permissions: {
        preset: 'turn-sandbox',
        allow: ['Bash(omni say *)'],
        bashAllowPatterns: ['^omni say .*$'],
      },
    };
    const params = buildOmniSpawnParams('simone', 'chat123', entryWithSdkFields, {});
    // SpawnParams.permissions only carries allow/deny — preset and bashAllowPatterns
    // are SDK-specific and handled in claude-sdk-permissions.ts, not here.
    expect(params.permissions?.allow).toEqual(['Bash(omni say *)']);
    expect(params.permissions?.deny).toBeUndefined();
  });
});

describe('resolveBridgeTmuxSession', () => {
  test('env override wins over yaml and agent name', () => {
    expect(resolveBridgeTmuxSession('felipe/scout', 'felipe', 'whatsapp-scout-12')).toBe('whatsapp-scout-12');
  });

  test('yaml default wins when env is absent', () => {
    expect(resolveBridgeTmuxSession('felipe/scout', 'felipe', undefined)).toBe('felipe');
  });

  test('falls back to agentName when neither env nor yaml set', () => {
    expect(resolveBridgeTmuxSession('felipe', undefined, undefined)).toBe('felipe');
  });

  test('sanitizes `/` to `-` in the final resolved value (agentName fallback)', () => {
    expect(resolveBridgeTmuxSession('felipe/scout', undefined, undefined)).toBe('felipe-scout');
  });

  test('sanitizes `/` to `-` when the yaml value carries a slash', () => {
    expect(resolveBridgeTmuxSession('agent', 'group/sub', undefined)).toBe('group-sub');
  });

  test('sanitizes `/` to `-` when the env override carries a slash', () => {
    expect(resolveBridgeTmuxSession('agent', 'yaml', 'env/scout')).toBe('env-scout');
  });

  test('empty-string env override is treated as absent (falls through to yaml)', () => {
    expect(resolveBridgeTmuxSession('agent', 'yaml-default', '')).toBe('yaml-default');
  });

  test('empty-string env override falls through to agentName when yaml also empty', () => {
    expect(resolveBridgeTmuxSession('fallback', undefined, '')).toBe('fallback');
  });

  test('preserves non-slash special chars (tmux already rejects them downstream)', () => {
    // We only sanitize `/` because tmux treats it as a target separator.
    // Other characters are the caller's responsibility.
    expect(resolveBridgeTmuxSession('agent', 'with_underscore-and.dot', undefined)).toBe('with_underscore-and.dot');
  });
});
